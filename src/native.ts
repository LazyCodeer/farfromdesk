import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,writeFileSync,unlinkSync,renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stateDir,codexBin,claudeBin } from './config.js';
import { portableAgents } from './platform.js';
import type { Store,Binding } from './store.js';
import type { Approvals } from './approvals.js';
import { turnEnvelope } from './roles.js';
import { Attachments } from './attachments.js';
import { activityTime, claudeHistory, claudeDesktopHistory, type Session } from './session-catalog.js';
import { claudeDiscoveryBinary, hasClaudeInboxes, claudeDesktopProcesses } from './desktop-claude.js';
import { SessionActivation } from './session-activation.js';
import { Connections } from './connections.js';

const exec=promisify(execFile);
const helper=process.env.WSB_DESKTOP_SYNC_BIN??join(homedir(),'.local/bin/desktop-sync');
const cli=fileURLToPath(new URL('./cli.js',import.meta.url));
const quote=(s:string)=>`'${s.replaceAll("'","'\\''")}'`;
export function deliveryId(jobId:string) {
  const h=createHash('sha256').update(`whatsapp-session-bridge:${jobId}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
export class NativeAgents {
  connections:Connections;
  activation:SessionActivation;
  managedActive?:(b:Binding)=>boolean;
  private catalogTasks=new Map<string,Promise<any>>();
  private catalogCache=new Map<string,{expires:number;page:{sessions:Session[];cursor:string|null}}>();
  beforeRun?:(b:Binding)=>void;
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
  private async desktopConfig() {this.writeTransportConfig(await claudeDiscoveryBinary(claudeBin));}
  async catalog(provider:'codex'|'claude',cursor?:string,options:{fresh?:boolean}={}):Promise<{sessions:Session[];cursor:string|null}> {
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
      const load=this.readCatalog(provider,cursor).then(page=>{
        this.catalogCache.delete(key);
        this.catalogCache.set(key,{expires:Date.now()+15000,page:structuredClone(page)});
        while(this.catalogCache.size>64)this.catalogCache.delete(this.catalogCache.keys().next().value!);
        return page;
      });
      task=Promise.race([load,deadline]);
      this.catalogTasks.set(key,task);
      void load.finally(()=>{clearTimeout(timer);this.catalogTasks.delete(key);}).catch(()=>{});
    }
    return structuredClone(await task);
  }
  protected async readCatalog(provider:'codex'|'claude',cursor?:string):Promise<{sessions:Session[];cursor:string|null}> {
    if(provider==='claude') {
      const [history,desktopHistory,desktopPids,,cliConnection]=await Promise.all([
        claudeHistory(join(process.env.CLAUDE_CONFIG_DIR??join(homedir(),'.claude'),'projects')),
        claudeDesktopHistory(join(homedir(),'Library/Application Support/Claude/claude-code-sessions')),
        claudeDesktopProcesses().catch(()=>new Set<number>()),
        this.desktopConfig(),
        this.connections.read('claude','cli')
      ]);
      const all=new Map<string,Session>([...history,...desktopHistory].map(s=>[s.id,s]));
      let live:any[]=[],liveComplete=false;
      try{const {stdout}=await exec(helper,['--config',this.configPath,'list-claude'],{timeout:6000,maxBuffer:4*1024*1024});live=JSON.parse(stdout);if(!Array.isArray(live))throw new Error('Invalid live catalog');liveComplete=true;}
      catch{if(!history.length&&!desktopHistory.length)throw new Error('Claude discovery is unavailable. Check the native CLI.');}
      const inboxes=await hasClaudeInboxes(live.map(s=>s.pid));
      const readiness=live.map(s=>({s,reachable:inboxes.has(s.pid)}));
      for(const {s,reachable} of readiness)all.set(s.sessionId,{live:true,desktopId:all.get(s.sessionId)?.desktopId,accountScope:all.get(s.sessionId)?.accountScope,id:s.sessionId,name:all.get(s.sessionId)?.desktopId?all.get(s.sessionId)!.name:(s.name||all.get(s.sessionId)?.name||s.sessionId),cwd:s.cwd,provider,executionMode:desktopPids.has(s.pid)?'desktop':'cli',status:reachable?(s.status||'running'):'Inbox unavailable; check Peer address in Claude /status',available:reachable,updatedAt:activityTime(s.updatedAt??s.lastActivityAt)??all.get(s.sessionId)?.updatedAt});
      for(const b of this.store.bindings())if(b.provider==='claude'&&this.store.get(`execution-mode:${b.id}`)!=='desktop'&&b.enabled&&(this.store.get(`managed-worker:${b.id}`)==='true'||this.store.get(`managed-claude:${b.id}`)==='true')) {
        const existing=all.get(b.native_id);if(existing?.live)continue;
        all.set(b.native_id,{...existing,id:b.native_id,name:this.store.get(`name:${b.id}`)??b.alias,cwd:b.cwd,provider,executionMode:'cli',status:'bridge-managed session',available:true});
      }
      for(const [id,row] of all)if(row.activation)all.set(id,{...row,
        available:liveComplete&&(row.activation==='desktop-open'||cliConnection.state==='verified'),
        activation:liveComplete?row.activation:undefined,
        status:!liveComplete?'Live session discovery failed · automatic resume held':row.activation==='desktop-open'?'Saved Desktop chat · opens automatically when requested':cliConnection.state==='verified'?'Saved CLI chat · resumes automatically when requested':cliConnection.label});
      for(const [id,row] of all)all.set(id,{...row,liveDiscoveryComplete:liveComplete});
      return {sessions:[...all.values()].sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0)),cursor:null};
    }
    const db=new DatabaseSync(join(process.env.CODEX_HOME??join(homedir(),'.codex'),'state_5.sqlite'),{readOnly:true});
    try {
      const offset=Number(cursor??0);if(!Number.isInteger(offset)||offset<0)throw new Error('Invalid cursor');
      const rows=db.prepare('SELECT id,COALESCE(NULLIF(name,\'\'),title) AS name,cwd,updated_at FROM threads WHERE archived=0 AND agent_path IS NULL AND source NOT LIKE \'%subagent%\' ORDER BY updated_at DESC,id LIMIT 51 OFFSET ?').all(offset);
      return {sessions:rows.slice(0,50).map((s:any)=>{
        const binding=this.store.bindings().find(b=>b.provider===provider&&b.native_id===s.id);
        const preferred=JSON.parse(this.store.get('platform-preference:codex')??'null');
        const mode=binding?this.store.get(`execution-mode:${binding.id}`):(portableAgents?'cli':preferred?.executionMode);
        return {id:s.id,cwd:s.cwd,name:(s.name||s.id).slice(0,160),provider,executionMode:mode==='cli'?'cli' as const:'desktop' as const,status:mode==='cli'?'CLI session · exact history resumes on request':'Existing chat · desktop queue',available:true,updatedAt:activityTime(s.updated_at)};
      }),cursor:rows.length>50?String(offset+50):null};
    } finally {db.close();}
  }
  async validate(provider:'codex'|'claude',id:string,cwd:string) {
    await this.validateSessions([{provider,id,cwd}]);
  }
  async validateSessions(sessions:{provider:'codex'|'claude';id:string;cwd:string}[]) {
    const claude=sessions.filter(s=>s.provider==='claude');
    if(claude.length){const c=await this.catalog('claude',undefined,{fresh:true});for(const s of claude)if(!c.sessions.some((row:any)=>row.id===s.id&&row.cwd===s.cwd))throw new Error('This exact Claude session could not be found in that project.');}
    const codex=sessions.filter(s=>s.provider==='codex');if(!codex.length)return;
    const db=new DatabaseSync(join(process.env.CODEX_HOME??join(homedir(),'.codex'),'state_5.sqlite'),{readOnly:true});
    try {for(const s of codex)if(!db.prepare('SELECT 1 FROM threads WHERE id=? AND cwd=? AND archived=0 AND agent_path IS NULL AND source NOT LIKE \'%subagent%\'').get(s.id,s.cwd))throw new Error('No matching existing Codex chat in this project.');}finally{db.close();}
  }
  async run(b:Binding,text:string,jobId:string) {
    this.beforeRun?.(b);
    await this.connections.assert(b);
    let route=this.connections.route(b);
    const managedFlags=this.store.get(`managed-codex:${b.id}`)==='true'||this.store.get(`managed-claude:${b.id}`)==='true'||this.store.get(`managed-worker:${b.id}`)==='true';
    if(!route) {
      // Preserve legacy native destinations. A historical managed account cannot be inferred safely.
      if(this.store.get(`execution-mode:${b.id}`)!=='desktop'&&managedFlags)throw new Error('Review this existing CLI connection in Home and select it again to confirm its account. Pending work is preserved.');
      const catalog=await this.catalog(b.provider,undefined,{fresh:true});
      let s=catalog.sessions.find(s=>s.id===b.native_id&&s.cwd===b.cwd);
      if(b.provider==='codex'&&!s){await this.validate(b.provider,b.native_id,b.cwd);s={id:b.native_id,provider:b.provider,cwd:b.cwd,name:b.alias,status:'existing chat',executionMode:'desktop'};}
      if(!s)throw new Error('The exact native session is unavailable. No other platform was selected.');
      route=await this.connections.choose(b,s.executionMode??'cli',false,s.accountScope);
    }
    if(b.provider==='claude'&&route.transport==='native-session') {
      let s=(await this.catalog('claude',undefined,{fresh:true})).sessions.find(s=>s.id===b.native_id&&s.cwd===b.cwd);
      if(!s||s.available!==true||s.executionMode!==route.executionMode||(route.accountScope&&s.accountScope!==route.accountScope))throw new Error('Selected Claude session is unavailable or its platform/account changed. No CLI/Desktop fallback was used.');
      if(s.activation==='desktop-open')s=await this.activation.ready(s);
      if(s.activation==='cli-resume') {
        const preference=JSON.parse(this.store.get('platform-preference:claude')??'null');
        const next=await this.connections.prepare(b,'cli',true);
        if(preference?.executionMode!=='cli'||preference.route?.accountKey!==next.accountKey||preference.route?.profileId!==next.profileId)throw new Error('Review Claude CLI in Coding platforms before resuming this legacy connection with a managed account.');
        this.connections.save(b,next);this.store.set(`managed-claude:${b.id}`,'true');route=next;
      }
      this.beforeRun?.(b);await this.connections.assert(b);
      if(!this.store.binding(b.id)?.enabled)throw new Error('Session was paused before delivery.');
    }
    const id=deliveryId(jobId),dir=join(stateDir,'native-delivery');mkdirSync(dir,{recursive:true,mode:0o700});
    const file=join(dir,`${id}.txt`);
    const response=`${quote(process.execPath)} ${quote(cli)} respond ${quote(b.alias)} ${quote(jobId)}`;
    const managed=route.transport==='managed-cli';
    const sender=jobId.startsWith('master:')?'WhatsApp master':jobId.startsWith('report:')?'WhatsApp worker report':'Owner via WhatsApp';
    const attachments=this.store.job(jobId)?new Attachments(this.store).references(b,jobId,true):[];
    const reply=managed?{tool:'whatsapp_reply',requestId:jobId,kinds:['progress','final']}:
      {command:response,stdin:'Use a quoted heredoc; append progress for an interim update.',...(b.id===this.store.get('master')?{coordination:`${quote(process.execPath)} ${quote(cli)} master --binding ${quote(b.alias)}`}:{})};
    const envelope=turnEnvelope(this.store,b,text,jobId,reply,attachments,stateDir,managed);
    const message=envelope.body;
    if(Buffer.byteLength(message)>63000)throw new Error('Message exceeds native transport size limit');
    if(managed) {
      if(b.provider==='claude'&&!this.managedActive?.(b)) {
        const current=(await this.catalog('claude',undefined,{fresh:true})).sessions.find(s=>s.id===b.native_id);
        if(!current||current.liveDiscoveryComplete===false||current.executionMode!=='cli')throw new Error('The exact Claude CLI runtime could not be checked. Resume held; no replacement process was started.');
        if(current.live)throw new Error('This Claude session is already running outside the managed connection. No duplicate process or fork was started.');
      }
      if(!this.managedRun)throw new Error('Managed native runtime is unavailable.');
      await this.managedRun(b,message,jobId);envelope.acknowledge();return;
    }
    writeFileSync(file,message,{mode:0o600});
    const args=['--config',this.configPath,'--coord-dir',dir,...(b.provider==='codex'?['send-codex','--target',b.native_id,'--id',id]:['send-claude','--session',b.native_id]),'--sender',sender,'--file',file];
    try {
      if(b.provider==='claude')await this.desktopConfig();
      const {stdout}=await exec(helper,args,{timeout:30000,maxBuffer:1024*1024});
      const r=JSON.parse(stdout);
      if(r.status!=='submitted'&&r.status!=='received')throw new Error(`Native delivery is ${r.status??'unconfirmed'}. Reference ${id}`);
      envelope.acknowledge();
      this.store.audit('native-submitted',b.id,id);
    } catch(e:any) {
      let receipt;try{receipt=JSON.parse(e.stdout);}catch{}
      throw new Error(receipt?`Native delivery ${receipt.status}; reference ${id}. Do not resubmit until checked.`:e.message);
    } finally {try{unlinkSync(file);}catch{}}
  }
  async sendDesktopCreation(sessionId:string,file:string) {
    await this.desktopConfig();
    const {stdout}=await exec(helper,['--config',this.configPath,'send-claude','--session',sessionId,'--sender','FarFromDesk owner-requested session setup','--file',file],{timeout:30000,maxBuffer:1024*1024});
    const receipt=JSON.parse(stdout);
    if(receipt.status!=='submitted'&&receipt.status!=='received')throw new Error('Desktop creation submission could not be confirmed. Do not resubmit.');
  }
  stop(b:Binding){this.approvals.cancel(b.id);}
  close(){this.approvals.cancel();}
}
