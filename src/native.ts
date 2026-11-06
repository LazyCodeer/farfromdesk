import { execFile } from 'node:child_process';
import { scopedBridgeCommand } from './reply-args.js';
import { ensureFfd } from './ffd.js';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync,unlinkSync,renameSync,openSync,readSync,closeSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { homedir } from 'node:os';
import { cursorOwnerHome } from './cursor-paths.js';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stateDir,baseUrl,codexBin,claudeBin,coordinatorHome } from './config.js';
import { portableAgents } from './platform.js';
import type { Store,Binding,Provider } from './store.js';
import type { Approvals } from './approvals.js';
import { turnEnvelope,roleConfig } from './roles.js';
import { Attachments } from './attachments.js';
import { sameProject, activityTime, claudeHistory, claudeDesktopHistory, type Session } from './session-catalog.js';
import { claudeDiscoveryBinary, hasClaudeInboxes, claudeDesktopProcesses } from './desktop-claude.js';
import { SessionActivation,DesktopReadinessError,openCodexDesktop } from './session-activation.js';
import { Connections, usableCLIConnection } from './connections.js';
import { DispatchNotSubmittedError } from './brief-dispatch-guard.js';
import { requireCodexHistory, CodexSession, observeCodexRequest } from './codex-session.js';
import {assertProviderSetup,withProviderSetup} from './provider-setup-barrier.js';
import {codexProfileEnvironment,codexProfileHome} from './codex-profile.js';
import {museDataHome} from './muse-paths.js';
import {sessionSpecialty} from './session-specialty.js';
import {dshSessionsDir} from './dsh-paths.js';
import {cursorSessions} from './cursor-desktop.js';
import {bridgeCurl,ownerAppsPhrase,writeAuthHeader,WINDOWS_PIPE_NOTE} from './direct-mac.js';

const exec=promisify(execFile);
// Always the app's own copy (backend/native beside dist), never a personal helper in ~/.local/bin.
const helper=()=>process.env.WSB_DESKTOP_SYNC_BIN??fileURLToPath(new URL('../native/desktop-sync',import.meta.url));
const cli=fileURLToPath(new URL('./cli.js',import.meta.url));
const quote=(s:string)=>`'${s.replaceAll("'","'\\''")}'`;
export function deliveryId(jobId:string) {
  const h=createHash('sha256').update(`whatsapp-session-bridge:${jobId}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
const SESSION_HEADER_BYTES=64*1024;
/**
 * The first record of a zstd session log. DSH writes each record as its own frame, so the header
 * decodes from a bounded read; a frame that did not fit falls back to reading the whole file rather
 * than dropping the session.
 */
export function decodeSessionHeader(file:string):string|undefined {
  const handle=openSync(file,'r');
  let head:Buffer;
  try {const buffer=Buffer.alloc(SESSION_HEADER_BYTES);head=buffer.subarray(0,readSync(handle,buffer,0,buffer.length,0));}
  finally {closeSync(handle);}
  try {return zstdDecompressSync(head).toString('utf8').split('\n')[0]?.trim();}
  catch {return zstdDecompressSync(readFileSync(file)).toString('utf8').split('\n')[0]?.trim();}
}
/** Keep runtime identities separate even when Desktop and CLI share a history UUID. */
export function mergeClaudeSessions(history:Session[],desktopHistory:Session[],live:any[],desktopPids:Set<number>,inboxes:Set<number>) {
  const all=new Map<string,Session>([...history,...desktopHistory].map(s=>[`${s.executionMode??'cli'}:${s.id}`,s]));
  for(const s of live) {
    const mode=desktopPids.has(s.pid)?'desktop':'cli',key=`${mode}:${s.sessionId}`,saved=all.get(key),reachable=inboxes.has(s.pid);
    all.set(key,{live:true,...(mode==='desktop'?{desktopId:saved?.desktopId,detached:saved?.detached,accountScope:saved?.accountScope}:{}),id:s.sessionId,
      name:saved?.name||s.name||s.sessionId,cwd:s.cwd,provider:'claude',executionMode:mode,
      status:reachable?(s.status||'running'):'Inbox unavailable; check Peer address in Claude /status',available:reachable,
      updatedAt:activityTime(s.updatedAt??s.lastActivityAt)??saved?.updatedAt});
    const otherKey=`${mode==='desktop'?'cli':'desktop'}:${s.sessionId}`,other=all.get(otherKey);
    if(other&&!other.live)all.set(otherKey,{...other,activation:undefined,available:false,status:`This session is running in ${mode==='desktop'?'Desktop':'CLI'}. Use that runtime or close it there before switching.`});
  }
  return all;
}
/**
 * Claude Desktop runs under the owner's own home and Claude config. The Local backend's private
 * HOME and CLAUDE_CONFIG_DIR made `claude agents` list none of the owner's open sessions, so every
 * Desktop session looked like it had no inbox and a new coordinator never connected (live, 4 Nov).
 * The app's own Claude CLI runs keep their private config; only Desktop listing and delivery use this.
 */
export function claudeOwnerEnvironment(env:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv {
  if(env.FFD_ISOLATED_LOCAL!=='1')return env;
  const {CLAUDE_CONFIG_DIR:_private,...rest}=env;
  return {...rest,HOME:cursorOwnerHome(env)};
}
function waitingForDesktopInbox(s:Session) {
  return s.activation==='desktop-open'||(s.provider==='claude'&&s.executionMode==='desktop'&&s.live===true&&s.available===false&&!!s.desktopId&&!!s.accountScope);
}
export class NativeAgents {
  wakeCodex=(id:string)=>openCodexDesktop(id,true);
  connections:Connections;
  activation:SessionActivation;
  managedActive?:(b:Binding)=>boolean;
  private catalogTasks=new Map<string,Promise<any>>();
  private deniedCatalogs=new Set<string>();
  retryDiscovery(){this.deniedCatalogs.clear();}
  discoveryBlocked(provider:string){return this.deniedCatalogs.has(provider);}
  private catalogCache=new Map<string,{expires:number;page:{sessions:Session[];cursor:string|null}}>();
  beforeRun?:(b:Binding)=>void;
  beforeDispatch?:(b:Binding,jobId:string)=>boolean;
  /** Synchronous fence immediately before managed provider submission. */
  beforeManagedSubmission?:(b:Binding,jobId:string)=>void;
  connectionChanged?:(b:Binding)=>void;
  managedRun?:(b:Binding,message:string,jobId:string)=>Promise<void>;
  configPath=join(stateDir,'desktop-sync.json');
  constructor(private store:Store,private approvals:Approvals) {
    this.connections=new Connections(store);
    this.activation=new SessionActivation(store,async()=>(await this.catalog('claude',undefined,{fresh:true})).sessions);
    mkdirSync(stateDir,{recursive:true,mode:0o700});
    this.writeTransportConfig();
  }
  private writeTransportConfig(claudeBinary?:string) {
    const temp=`${this.configPath}.${process.pid}.tmp`;
    writeFileSync(temp,JSON.stringify({claudeBinary,codexBinary:codexBin,coordinationDirectory:join(stateDir,'native-delivery')}),{mode:0o600});renameSync(temp,this.configPath);
  }
  async requestStatus(job:{id:string;binding_id:string}) {
    const b=this.store.binding(job.binding_id);if(!b?.enabled||b.provider!=='codex')return undefined;
    const runtime=new CodexSession(codexBin,b.cwd,async()=>{throw new Error('Read-only observation cannot approve native actions');});
    const timer=setTimeout(()=>runtime.close(),8000);
    try{await runtime.initialize();return await observeCodexRequest(runtime,b,job.id);}finally{clearTimeout(timer);runtime.close();}
  }
  private async desktopConfig() {this.writeTransportConfig(await claudeDiscoveryBinary(claudeBin));}
  async catalog(provider:Provider,cursor?:string,options:{fresh?:boolean}={}):Promise<{sessions:Session[];cursor:string|null}> {
    if(this.deniedCatalogs.has(provider))throw new Error('File access was denied. Review FarFromDesk in System Settings → Privacy & Security → Files and Folders, then click Detect apps.');
    const key=provider+':'+(cursor??''),now=Date.now();
    for(const [key,value] of this.catalogCache)if(value.expires<=now)this.catalogCache.delete(key);
    const cached=this.catalogCache.get(key);
    if(cached&&!options.fresh)return structuredClone(cached.page);
    let task=this.catalogTasks.get(key);
    if(!task) {
      if(this.catalogTasks.size>=64)throw new Error('Session discovery is busy. Try again shortly.');
      // A timeout bounds the caller, while the underlying load stays coalesced
      // until it settles. Retrying cannot accumulate duplicate process scans.
      let timer:ReturnType<typeof setTimeout>;
      const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Session discovery timed out. Your saved connections are unchanged; try Refresh.')),12000);});
      const load=this.readCatalog(provider,cursor,options.fresh===true).then(page=>{
        this.catalogCache.delete(key);
        this.catalogCache.set(key,{expires:Date.now()+15000,page:structuredClone(page)});
        while(this.catalogCache.size>64)this.catalogCache.delete(this.catalogCache.keys().next().value!);
        return page;
      }).catch(error=>{
        if(error?.code==='EPERM'||error?.code==='EACCES')this.deniedCatalogs.add(provider);
        throw error;
      });
      task=Promise.race([load,deadline]);
      this.catalogTasks.set(key,task);
      void load.finally(()=>{clearTimeout(timer);this.catalogTasks.delete(key);}).catch(()=>{});
    }
    return structuredClone(await task);
  }
  /**
   * Muse publishes every session it retained in a local index, the way Claude publishes
   * ~/.claude/projects. Read it read-only: the CLI owns the file, its schema and its locks.
   */
  private async museCatalog():Promise<Session[]> {
    const file=join(museDataHome(),'session-index.db');
    if(!existsSync(file))return [];
    let db:DatabaseSync;
    try{db=new DatabaseSync(file,{readOnly:true});}catch{return [];}
    try {
      const rows=db.prepare(`SELECT session_id,workspace_root,model_id,COALESCE(session_name,title,first_user_prompt) AS name,updated_at_us,prompt_count
        FROM sessions WHERE workspace_root IS NOT NULL AND COALESCE(msp_kind,'')!='subagent' ORDER BY updated_at_us DESC LIMIT 50`).all() as any[];
      return rows.map((row:any)=>{
        const name=String(row.name??'').replace(/\s+/g,' ').trim().slice(0,120)||String(row.session_id);
        const model=typeof row.model_id==='string'&&row.model_id?row.model_id:'Muse';
        return {id:String(row.session_id),provider:'muse' as const,cwd:String(row.workspace_root),name,
          status:`Muse session · ${model}${row.prompt_count?` · ${row.prompt_count} turns`:''}`,model,executionMode:'cli' as const,available:true,
          updatedAt:row.updated_at_us?Math.floor(Number(row.updated_at_us)/1000):undefined};
      });
    } finally {db.close();}
  }
  /**
   * DeepSeek Harness keeps one transcript per session under a folder named for its working
   * directory. The zstd file is multi-frame, and Node can read exactly the first frame, which is
   * the session header and all a catalog needs. A subagent or forked transcript is not a session
   * the owner can adopt, for the same reason the CLI refuses to adopt one.
   */
  private deepseekCatalog():Session[] {
    const root=dshSessionsDir();
    if(!existsSync(root))return [];
    let projects;try{projects=readdirSync(root,{withFileTypes:true});}catch{return [];}
    const sessions:Session[]=[];
    for(const project of projects){
      if(!project.isDirectory()||!project.name.startsWith('--')||!project.name.endsWith('--'))continue;
      let entries;try{entries=readdirSync(join(root,project.name),{withFileTypes:true});}catch{continue;}
      for(const entry of entries){
        if(!entry.isDirectory())continue;
        const directory=join(root,project.name,entry.name);
        let files;try{files=readdirSync(directory);}catch{continue;}
        const newest=files.filter(file=>/^session\.v\d+\.jsonl\.zstd$/.test(file))
          .sort((a,b)=>Number(b.replace(/\D/g,''))-Number(a.replace(/\D/g,'')))[0];
        if(!newest)continue;
        let header:any;
        try {
          // The header is the whole first frame, so a bounded read decodes it. A busy install keeps
          // multi-megabyte transcripts, and reading every one of them in full would stall discovery
          // for work the catalog never uses. If the first frame did not fit, read the file properly
          // rather than dropping a session.
          const line=decodeSessionHeader(join(directory,newest));
          if(!line?.startsWith('{'))continue;
          header=JSON.parse(line);
        } catch{continue;}
        if(header?.type!=='session'||typeof header.id!=='string'||!header.id||typeof header.cwd!=='string'||!header.cwd)continue;
        if(header.origin==='subagent'||header.parentSession)continue;
        sessions.push({id:header.id,provider:'deepseek',cwd:header.cwd,name:header.id,
          status:'DeepSeek Harness session · CLI',executionMode:'cli',available:true,updatedAt:activityTime(header.createdAt)});
      }
    }
    return sessions.sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0)).slice(0,50);
  }
  protected async readCatalog(provider:Provider,cursor?:string,fresh=false):Promise<{sessions:Session[];cursor:string|null}> {
    if(provider==='muse')return {sessions:await this.museCatalog(),cursor:null};
    if(provider==='deepseek')return {sessions:this.deepseekCatalog(),cursor:null};
    if(provider==='cursor')return {sessions:cursorSessions(),cursor:null};
    if(provider==='claude') {
      const [history,desktopHistory,desktopPids,,cliConnection]=await Promise.all([
        claudeHistory(join(process.env.CLAUDE_CONFIG_DIR??join(homedir(),'.claude'),'projects')),
        // Claude Desktop keeps its sessions in the owner's real Library. The Local backend runs with a
        // private HOME, which hid every Desktop session and left new coordinators "not confirmed" (live).
        claudeDesktopHistory(join(cursorOwnerHome(),'Library/Application Support/Claude/claude-code-sessions')),
        claudeDesktopProcesses().catch(()=>new Set<number>()),
        this.desktopConfig(),
        this.connections.read('claude','cli',fresh)
      ]);
      let live:any[]=[],liveComplete=false;
      try{const {stdout}=await exec(helper(),['--config',this.configPath,'list-claude'],{timeout:6000,maxBuffer:4*1024*1024,env:claudeOwnerEnvironment()});live=JSON.parse(stdout);if(!Array.isArray(live))throw new Error('Invalid live catalog');liveComplete=true;}
      catch{if(!history.length&&!desktopHistory.length)throw new Error('Claude discovery is unavailable. Check the native CLI.');}
      const inboxes=await hasClaudeInboxes(live.map(s=>s.pid));
      const all=mergeClaudeSessions(history,desktopHistory,live,desktopPids,inboxes);
      for(const b of this.store.bindings())if(b.provider==='claude'&&this.store.get(`execution-mode:${b.id}`)!=='desktop'&&b.enabled&&(this.store.get(`managed-worker:${b.id}`)==='true'||this.store.get(`managed-claude:${b.id}`)==='true')) {
        const key=`cli:${b.native_id}`,existing=all.get(key);if(existing?.live||all.get(`desktop:${b.native_id}`)?.live)continue;
        all.set(key,{...existing,id:b.native_id,name:this.store.get(`name:${b.id}`)??b.alias,cwd:b.cwd,provider,executionMode:'cli',status:'bridge-managed session',available:true});
      }
      for(const [id,row] of all)if(row.activation)all.set(id,{...row,
        available:liveComplete&&(row.activation==='desktop-open'||usableCLIConnection(cliConnection)),
        activation:liveComplete?row.activation:undefined,
        status:!liveComplete?'Live session discovery failed · automatic resume held':row.activation==='desktop-open'?'Saved Desktop chat · reopening must be verified':usableCLIConnection(cliConnection)?'Saved CLI chat · resumes automatically when requested':cliConnection.label});
      for(const [id,row] of all)all.set(id,{...row,liveDiscoveryComplete:liveComplete});
      return {sessions:[...all.values()].sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0)),cursor:null};
    }
    const db=new DatabaseSync(join(codexProfileHome(),'state_5.sqlite'),{readOnly:true});
    try {
      const offset=Number(cursor??0);if(!Number.isInteger(offset)||offset<0)throw new Error('Invalid cursor');
      const rows=db.prepare('SELECT id,COALESCE(NULLIF(name,\'\'),title) AS name,cwd,updated_at,rollout_path FROM threads WHERE archived=0 AND agent_path IS NULL AND source NOT LIKE \'%subagent%\' ORDER BY updated_at DESC,id LIMIT 51 OFFSET ?').all(offset);
      return {sessions:await Promise.all(rows.slice(0,50).map(async(s:any)=>{
        const binding=this.store.bindings().find(b=>b.provider===provider&&b.native_id===s.id);
        let historyError='';
        try{await requireCodexHistory(s.rollout_path);}catch(error:any){
          if(error?.code==='EPERM'||error?.code==='EACCES')throw error;
          historyError='Codex conversation history is unavailable. Open this exact chat in Codex or create a replacement.';
        }
        if(binding)this.store.set(`native-history-error:${binding.id}`,historyError);
        const preferred=JSON.parse(this.store.get('platform-preference:codex')??'null');
        const mode=binding?this.store.get(`execution-mode:${binding.id}`):(portableAgents?'cli':preferred?.executionMode);
        return {id:s.id,cwd:s.cwd,name:(s.name||s.id).slice(0,160),provider,executionMode:mode==='cli'?'cli' as const:'desktop' as const,status:historyError||(mode==='cli'?'CLI session · exact history resumes on request':'Existing chat · desktop queue'),available:!historyError,updatedAt:activityTime(s.updated_at)};
      })),cursor:rows.length>50?String(offset+50):null};
    } finally {db.close();}
  }
  async validate(provider:Provider,id:string,cwd:string) {
    await this.validateSessions([{provider,id,cwd}]);
  }
  async validateSessions(sessions:{provider:Provider;id:string;cwd:string;executionMode?:'desktop'|'cli'}[]) {
    const claude=sessions.filter(s=>s.provider==='claude');
    if(claude.length){const c=await this.catalog('claude',undefined,{fresh:true});for(const s of claude)if(!c.sessions.some((row:any)=>row.id===s.id&&sameProject(row.cwd,s.cwd)&&(!s.executionMode||row.executionMode===s.executionMode)))throw new Error('This exact Claude session could not be found in that project.');}
    const codex=sessions.filter(s=>s.provider==='codex');if(!codex.length)return;
    const db=new DatabaseSync(join(codexProfileHome(),'state_5.sqlite'),{readOnly:true});
    try {for(const s of codex){
      const row=db.prepare('SELECT rollout_path FROM threads WHERE id=? AND cwd=? AND archived=0 AND agent_path IS NULL AND source NOT LIKE \'%subagent%\'').get(s.id,s.cwd);
      if(!row)throw new Error('No matching existing Codex chat in this project.');
      await requireCodexHistory(row.rollout_path);
    }}finally{db.close();}
  }
  /** Owner-target selection may warm this exact Desktop chat. Never submits a task,
   * never falls back to CLI, and consumes its own rejection. Dispatch still validates anew. */
  warmDesktop(b:Binding):void {
    void (async()=>{
      if(b.provider!=='claude'||!this.store.binding(b.id)?.enabled)return;
      this.beforeRun?.(b);await this.connections.assert(b);
      const route=this.connections.route(b);
      if(route?.transport!=='native-session'||route.executionMode!=='desktop')return;
      const s=(await this.catalog('claude',undefined,{fresh:true})).sessions.find(s=>s.id===b.native_id&&sameProject(s.cwd,b.cwd)&&s.executionMode==='desktop');
      if(!s||route.accountScope&&s.accountScope!==route.accountScope||!waitingForDesktopInbox(s))return;
      this.beforeRun?.(b);
      if(!this.store.binding(b.id)?.enabled||JSON.stringify(this.connections.route(b))!==JSON.stringify(route))return;
      await this.activation.ready({...s,activation:'desktop-open'});
    })().catch(()=>{});
  }
  async run(b:Binding,text:string,jobId:string) {
    const guarded=this.beforeDispatch?.(b,jobId)??false;
    let handedOff=false;
    try{
    const verify=async<T>(pending:Promise<T>):Promise<T>=>{try{const value=await pending;this.beforeDispatch?.(b,jobId);return value;}catch(e){if(e instanceof DispatchNotSubmittedError)throw e;this.beforeDispatch?.(b,jobId);throw e;}};
    this.beforeRun?.(b);
    await verify(this.connections.assert(b));
    let route=this.connections.route(b);
    // Muse has no app queue and no native chat hand-off: the bridge runs its CLI or nothing.
    if(b.provider==='muse'&&route?.transport!=='managed-cli')throw new Error('Muse Code runs only on its managed CLI connection. Review it in Coding platforms before sending.');
    if(b.provider==='deepseek'&&route?.transport!=='managed-cli')throw new Error('DeepSeek Harness runs only on its managed CLI connection. Review it in Coding platforms before sending.');
    if(b.provider==='cursor'&&route?.transport!=='managed-cli')throw new Error('Cursor runs only on its managed channel connection. Review it in Coding platforms before sending.');
    const managedFlags=this.store.get(`managed-codex:${b.id}`)==='true'||this.store.get(`managed-claude:${b.id}`)==='true'||this.store.get(`managed-worker:${b.id}`)==='true';
    if(!route) {
      if(guarded)throw new DispatchNotSubmittedError('The request was not sent because this session has no verified connection. Select its exact connection in the app first.');
      // Preserve legacy native destinations. A historical managed account cannot be inferred safely.
      if(this.store.get(`execution-mode:${b.id}`)!=='desktop'&&managedFlags)throw new Error('Review this existing CLI connection in Home and select it again to confirm its account. Pending work is preserved.');
      const catalog=await this.catalog(b.provider,undefined,{fresh:true});
      let s=catalog.sessions.find(s=>s.id===b.native_id&&sameProject(s.cwd,b.cwd)&&(!this.store.get(`execution-mode:${b.id}`)||s.executionMode===this.store.get(`execution-mode:${b.id}`)));
      if(b.provider==='codex'&&!s){await this.validate(b.provider,b.native_id,b.cwd);s={id:b.native_id,provider:b.provider,cwd:b.cwd,name:b.alias,status:'existing chat',executionMode:'desktop'};}
      if(!s)throw new Error('The exact native session is unavailable. No other platform was selected.');
      route=await this.connections.choose(b,s.executionMode??'cli',false,s.accountScope);
    }
    if(b.provider==='claude'&&route.transport==='native-session') {
      let s=(await verify(this.catalog('claude',undefined,{fresh:true}))).sessions.find(s=>s.id===b.native_id&&sameProject(s.cwd,b.cwd)&&s.executionMode===route!.executionMode);
      if(!s||(s.available!==true&&!waitingForDesktopInbox(s))||s.executionMode!==route.executionMode||(route.accountScope&&s.accountScope!==route.accountScope))throw new Error('Selected Claude session is unavailable or its platform/account changed. No CLI/Desktop fallback was used.');
      if(waitingForDesktopInbox(s)) {
        const job=this.store.job(jobId);
        // This notice precedes readiness polling; a queued receipt is not submission.
        // The exact original destination and durable source prevent retargeting or repeats.
        const notice=`native-opening:${jobId}`;
        if(job&&/^(wa|tg):/.test(jobId)&&job.destination&&!this.store.db.prepare('SELECT 1 FROM reply_receipts WHERE source=?').get(notice)) {
          const name=this.store.get(`name:${b.id}`)??b.alias;
          this.store.output(undefined,`Opening ${name} in Claude Desktop. Your message will be sent when it is ready.`,notice,job.destination,{requestId:jobId,kind:'system',origin:'system'});
        }
        try {s=await verify(this.activation.ready({...s,activation:'desktop-open'}));}catch(error) {
          if(error instanceof DispatchNotSubmittedError)throw error;
          throw error instanceof DesktopReadinessError?error:new DesktopReadinessError(error instanceof Error?error.message:'Claude Desktop could not be opened. No task was sent.');
        }
        // Readiness is not permission to revive a request closed while the app opened.
        const current=job?this.store.job(jobId):undefined;
        if(JSON.stringify(this.connections.route(b))!==JSON.stringify(route))throw new DesktopReadinessError('The selected connection changed while Claude Desktop opened. No task was sent.');
        if(job&&(!current||current.binding_id!==b.id||current.body!==job.body||current.status!=='dispatched'))throw new DesktopReadinessError('This request changed while Claude Desktop opened. No task was sent.');
      }
      if(s.activation==='cli-resume') {
        if(guarded)throw new DispatchNotSubmittedError('The request was not sent because this legacy CLI connection needs review in the app first.');
        const preference=JSON.parse(this.store.get('platform-preference:claude')??'null');
        const next=await this.connections.prepare(b,'cli',true);
        if(preference?.executionMode!=='cli'||preference.route?.accountKey!==next.accountKey||preference.route?.profileId!==next.profileId)throw new Error('Review Claude CLI in Coding platforms before resuming this legacy connection with a managed account.');
        this.connections.save(b,next);this.store.set(`managed-claude:${b.id}`,'true');route=next;
      }
      this.beforeRun?.(b);await verify(this.connections.assert(b));
      if(!this.store.binding(b.id)?.enabled)throw new Error('Session was paused before delivery.');
    }
    const id=deliveryId(jobId),dir=join(stateDir,'native-delivery');mkdirSync(dir,{recursive:true,mode:0o700});
    const file=join(dir,`${id}.txt`);
    const bridge=scopedBridgeCommand(process.execPath,cli,stateDir,new URL(baseUrl).port);
    const managed=route.transport==='managed-cli';
    const channel=this.store.job(jobId)?.destination?.startsWith('tg:')?'Telegram':'WhatsApp';
    const sender=jobId.startsWith('master:')?'FarFromDesk coordinator':jobId.startsWith('report:')?'FarFromDesk worker report':`FarFromDesk · ${channel}`;
    const attachments=this.store.job(jobId)?new Attachments(this.store).references(b,jobId,true):[];
    // CLI-reply sessions get the farfromdesk skill and its ffd launcher; a coordinator in its own folder also auto-loads the skill.
    const support=this.store.get(`master-support:${b.id}`),ownFolder=support?.startsWith(coordinatorHome+'/');
    // A headless coordinator (Muse, DeepSeek) has no bridge tools, but it runs shell commands, and
    // the bridge CLI authenticates from this binding's own credential file. Measured live on
    // 4 November 2026: told only "coordination tools are not available", Muse searched the source,
    // tried raw AppleScript and answered "your recent notes are out of reach".
    // Muse's sandbox (network mode proxy-only) lets curl through its proxy but blocks node's fetch,
    // which ignores proxy variables on this runtime, so the bridge CLI answered "fetch failed".
    // curl reads the token from this binding's own credential file when it runs: the token is
    // never in the prompt or the transcript.
    const credential=join(stateDir,'bindings',`${b.alias}.json`).replaceAll("'","'\\''");
    // Windows has no plutil and no shell substitution every CLI agrees on (the token arrived empty
    // and every call got a 401), so curl there reads the Authorization header from a file written
    // next to this binding's credential, refreshed on every turn (see bridgeCurl in direct-mac.ts).
    const windows=process.platform==='win32';
    const headerFile=join(stateDir,'bindings',`${b.alias}.auth-header`);
    const headless=b.provider==='muse'||b.provider==='deepseek'||b.provider==='cursor';
    if(windows&&headless&&managed){try{const token=JSON.parse(readFileSync(join(stateDir,'bindings',`${b.alias}.json`),'utf8'))?.token;if(typeof token==='string'&&token)writeAuthHeader(headerFile,token);}catch{}}
    const curl=(path:string,secs=70)=>windows
      ?bridgeCurl('win32',`http://127.0.0.1:${new URL(baseUrl).port}${path}`,['Content-Type: application/json',`X-Binding-Id: ${b.id}`],{headerFile},secs)
      :`curl -s --max-time ${secs} -X POST 'http://127.0.0.1:${new URL(baseUrl).port}${path}' -H 'Content-Type: application/json' -H "X-Binding-Id: ${b.id}" -H "Authorization: Bearer $(/usr/bin/plutil -extract token raw -o - '${credential}')" --data-binary @-`;
    const post=curl('/api/master/desktop-control');
    // The same gap for Social: FFD social-save and friends do not exist in a headless session, so it
    // reported that drafts could not be saved and no image preview followed (live, 5 Nov 2026).
    const headlessSocial=(b.provider==='muse'||b.provider==='deepseek'||b.provider==='cursor')&&sessionSpecialty(this.store,jobId)?.kind==='social'
      ?{socialTools:`FFD is not installed here. In place of FFD social-creative, social-save, social-render and social-image, pipe JSON to these commands. Skill and schema: echo '{"requestId":"${jobId}"}' | ${curl('/api/session/social-creative')} . Save drafts: {"requestId":"${jobId}","eventId":"<new id of 8+ letters or digits>","drafts":[...]} | ${curl('/api/session/social-drafts')} . Render: {"requestId":"${jobId}","draftId":"<id>","revision":<n>,"plan":{...}} | ${curl('/api/session/social-render',180)} . Meta image: {"requestId":"${jobId}","draftId":"<id>"} | ${curl('/api/session/social-image',180)} .`}:{};
    const headlessApps=(b.provider==='muse'||b.provider==='deepseek')&&roleConfig(this.store,b).kind==='master'
      ?{macApps:windows?`For the content of ${ownerAppsPhrase('win32')}, never read windows or write scripts. Run: echo '{"requestId":"${jobId}","action":"app_tools","text":"<the owner words>"}' | ${post} , then pipe {"requestId":"${jobId}","action":"app_tool","tool":"<name from that list>","args":{...string values}} to the same curl. A tool that writes also needs "actionId":"<a new UUID>". Answer from what the tool returned; if it refused, give its reason.${WINDOWS_PIPE_NOTE}`:`For the content of Notes, Calendar, Reminders, Mail, Finder, Safari, Music or Messages, never read windows or write AppleScript. Run: echo '{"requestId":"${jobId}","action":"app_tools","text":"<the owner words>"}' | ${post} , then pipe {"requestId":"${jobId}","action":"app_tool","tool":"<name from that list>","args":{...string values}} to the same curl. A tool that writes also needs "actionId":"<a new UUID>". Answer from what the tool returned; if it refused, give its reason.`}:{};
    const reply=managed?(b.provider==='muse'||b.provider==='deepseek'||b.provider==='cursor'?{tool:'final answer',...headlessApps,...headlessSocial}:{tool:'whatsapp_reply'}):ensureFfd(coordinatorHome,stateDir,b.alias,bridge,ownFolder?[join(support!,'.agents/skills/farfromdesk'),join(support!,'.claude/skills/farfromdesk')]:[],roleConfig(this.store,b).kind==='master');
    const envelope=turnEnvelope(this.store,b,text,jobId,reply,attachments,stateDir,managed);
    const message=envelope.body;
    if(Buffer.byteLength(message)>63000)throw new Error('Message exceeds native transport size limit');
    if(managed) {
      if(b.provider==='claude'&&!this.managedActive?.(b)) {
        const matches=(await verify(this.catalog('claude',undefined,{fresh:true}))).sessions.filter(s=>s.id===b.native_id);
        if(matches.some(s=>s.live))throw new Error('This Claude session is already running outside the managed connection. No duplicate process or fork was started.');
        const current=matches.find(s=>s.executionMode==='cli');
        if(!current||current.liveDiscoveryComplete===false||current.executionMode!=='cli')throw new Error('The exact Claude CLI runtime could not be checked. Resume held; no replacement process was started.');
        if(current.live)throw new Error('This Claude session is already running outside the managed connection. No duplicate process or fork was started.');
      }
      if(!this.managedRun)throw new Error('Managed native runtime is unavailable.');
      if(guarded)this.beforeRun?.(b);
      this.beforeDispatch?.(b,jobId);
      this.beforeManagedSubmission?.(b,jobId);
      handedOff=true;
      await this.managedRun(b,message,jobId);envelope.acknowledge();return;
    }
    if(b.provider==='codex')await verify(this.validate(b.provider,b.native_id,b.cwd));
    this.beforeDispatch?.(b,jobId);
    writeFileSync(file,message,{mode:0o600});
    const args=['--config',this.configPath,'--coord-dir',dir,...(b.provider==='codex'?['send-codex','--target',b.native_id,'--id',id]:['send-claude','--session',b.native_id]),'--sender',sender,'--file',file];
    try {
      if(b.provider==='claude')await verify(this.desktopConfig());
      this.beforeDispatch?.(b,jobId);
      // Longer than the helper's own 30-second wait on codex queue, so the helper records the outcome itself.
      handedOff=true;
      const {stdout}=await exec(helper(),args,{timeout:45000,maxBuffer:1024*1024,...(b.provider==='codex'?{env:codexProfileEnvironment()}:{env:claudeOwnerEnvironment()})});
      const r=JSON.parse(stdout);
      if(r.status!=='submitted'&&r.status!=='received')throw new Error(`Native delivery is ${r.status??'unconfirmed'}. Reference ${id}`);
      envelope.acknowledge();
      this.store.audit('native-submitted',b.id,id);
      // "Accepted by the queue" is the only thing this hand-off proves. Record it, and keep the
      // best-known app liveness beside it, so Activity can tell queued from running later.
      this.store.event(jobId,'delivery_accepted',{transport:b.provider==='codex'?'codex-queue':'claude-socket',appRunning:this.store.get(`app-running:${b.provider}`)!=='false'});
      if(b.provider==='codex') {
        try{await this.wakeCodex(b.native_id);}
        catch(e){
          // Say which part failed. "Could not be opened" hid the case where Codex
          // launched but never really started, which is indistinguishable from a
          // silent success for the owner.
          throw new Error(`Message is saved in the Codex queue, so do not resend it. Desktop did not open the chat: ${e instanceof Error?e.message:'unknown error'}`);
        }
      }
    } catch(e:any) {
      if(e instanceof DispatchNotSubmittedError)throw e;
      let receipt;try{receipt=JSON.parse(e.stdout);}catch{}
      throw new Error(receipt?`Native delivery ${receipt.status}; reference ${id}. Do not resubmit until checked.`:e.message);
    } finally {try{unlinkSync(file);}catch{}}
    }catch(e){
      if(guarded&&!handedOff&&!(e instanceof DispatchNotSubmittedError)){
        this.beforeDispatch?.(b,jobId);
        throw new DispatchNotSubmittedError('The request was not sent because the session could not be prepared. Check its connection in the app before trying again.');
      }
      throw e;
    }
  }
  async sendDesktopCreation(sessionId:string,file:string) {
    return withProviderSetup(this.store,'desktop-submit',()=>this.sendDesktopCreationScoped(sessionId,file));
  }
  private async sendDesktopCreationScoped(sessionId:string,file:string) {
    await this.desktopConfig();
    assertProviderSetup(this.store);
    const {stdout}=await exec(helper(),['--config',this.configPath,'send-claude','--session',sessionId,'--sender','FarFromDesk owner-requested session setup','--file',file],{env:claudeOwnerEnvironment(),timeout:30000,maxBuffer:1024*1024});
    const receipt=JSON.parse(stdout);
    if(receipt.status!=='submitted'&&receipt.status!=='received')throw new Error('Desktop creation submission could not be confirmed. Do not resubmit.');
  }
  stop(b:Binding){this.approvals.cancel(b.id);}
  close(){this.approvals.cancel();}
}
