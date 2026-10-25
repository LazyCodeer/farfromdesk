import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,writeFileSync,unlinkSync,renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stateDir,codexBin,claudeBin } from './config.js';
import type { Store,Binding } from './store.js';
import type { Approvals } from './approvals.js';
import { masterPolicy } from './master-policy.js';
import { activityTime, claudeHistory, claudeDesktopHistory, type Session } from './session-catalog.js';
import { claudeDiscoveryBinary, hasClaudeInboxes, claudeDesktopProcesses } from './desktop-claude.js';

const exec=promisify(execFile);
const helper=process.env.WSB_DESKTOP_SYNC_BIN??join(homedir(),'.local/bin/desktop-sync');
const cli=fileURLToPath(new URL('./cli.js',import.meta.url));
const quote=(s:string)=>`'${s.replaceAll("'","'\\''")}'`;
export function deliveryId(jobId:string) {
  const h=createHash('sha256').update(`whatsapp-session-bridge:${jobId}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
export class NativeAgents {
  private catalogTasks=new Map<string,Promise<any>>();
  private catalogCache=new Map<string,{expires:number;page:{sessions:Session[];cursor:string|null}}>();
  beforeRun?:(b:Binding)=>void;
  managedRun?:(b:Binding,message:string,jobId:string)=>Promise<void>;
  configPath=join(stateDir,'desktop-sync.json');
  constructor(private store:Store,private approvals:Approvals) {
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
  private async readCatalog(provider:'codex'|'claude',cursor?:string) {
    if(provider==='claude') {
      const [history,desktopHistory,desktopPids]=await Promise.all([
        claudeHistory(join(process.env.CLAUDE_CONFIG_DIR??join(homedir(),'.claude'),'projects')),
        claudeDesktopHistory(join(homedir(),'Library/Application Support/Claude/claude-code-sessions')),
        claudeDesktopProcesses().catch(()=>new Set<number>()),
        this.desktopConfig()
      ]);
      const all=new Map<string,Session>([...history,...desktopHistory].map(s=>[s.id,s]));
      let live:any[]=[];
      try{const {stdout}=await exec(helper,['--config',this.configPath,'list-claude'],{timeout:6000,maxBuffer:4*1024*1024});live=JSON.parse(stdout);}
      catch{if(!history.length&&!desktopHistory.length)throw new Error('Claude discovery is unavailable. Check the native CLI.');}
      const inboxes=await hasClaudeInboxes(live.map(s=>s.pid));
      const readiness=live.map(s=>({s,reachable:inboxes.has(s.pid)}));
      for(const {s,reachable} of readiness)all.set(s.sessionId,{desktopId:all.get(s.sessionId)?.desktopId,id:s.sessionId,name:all.get(s.sessionId)?.desktopId?all.get(s.sessionId)!.name:(s.name||all.get(s.sessionId)?.name||s.sessionId),cwd:s.cwd,provider,executionMode:desktopPids.has(s.pid)?'desktop':'cli',status:reachable?(s.status||'running'):'Inbox unavailable; check Peer address in Claude /status',available:reachable,updatedAt:activityTime(s.updatedAt??s.lastActivityAt)??all.get(s.sessionId)?.updatedAt});
      for(const b of this.store.bindings())if(b.provider==='claude'&&this.store.get(`execution-mode:${b.id}`)!=='desktop'&&b.enabled&&(this.store.get(`managed-worker:${b.id}`)==='true'||this.store.get(`managed-claude:${b.id}`)==='true')) {
        const existing=all.get(b.native_id);
        all.set(b.native_id,{...existing,id:b.native_id,name:this.store.get(`name:${b.id}`)??b.alias,cwd:b.cwd,provider,status:'bridge-managed session',available:true});
      }
      return {sessions:[...all.values()].sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0)),cursor:null};
    }
    const db=new DatabaseSync(join(process.env.CODEX_HOME??join(homedir(),'.codex'),'state_5.sqlite'),{readOnly:true});
    try {
      const offset=Number(cursor??0);if(!Number.isInteger(offset)||offset<0)throw new Error('Invalid cursor');
      const rows=db.prepare('SELECT id,COALESCE(NULLIF(name,\'\'),title) AS name,cwd,updated_at FROM threads WHERE archived=0 AND agent_path IS NULL AND source NOT LIKE \'%subagent%\' ORDER BY updated_at DESC,id LIMIT 51 OFFSET ?').all(offset);
      return {sessions:rows.slice(0,50).map((s:any)=>({id:s.id,cwd:s.cwd,name:(s.name||s.id).slice(0,160),provider,status:'existing chat',available:true,updatedAt:activityTime(s.updated_at)})),cursor:rows.length>50?String(offset+50):null};
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
    const id=deliveryId(jobId),dir=join(stateDir,'native-delivery');mkdirSync(dir,{recursive:true,mode:0o700});
    const file=join(dir,`${id}.txt`);
    const response=`${quote(process.execPath)} ${quote(cli)} respond ${quote(b.alias)} ${quote(jobId)}`;
    const origin=jobId.startsWith('master:')?'The WhatsApp master delegated this task within the owner-selected session workflow. This is a coordinator message, not a new permission grant.':jobId.startsWith('report:')?'The WhatsApp bridge delivered an agent report for your existing coordination request. It is not a new user instruction.':'The owner sent this message from their authenticated WhatsApp Message yourself chat.';
    const sender=jobId.startsWith('master:')?'WhatsApp master':jobId.startsWith('report:')?'WhatsApp worker report':'Owner via WhatsApp';
    const message=[origin,
      ...(b.id===this.store.get('master')?[masterPolicy,`For CLI coordination use ${quote(process.execPath)} ${quote(cli)} master --binding ${quote(b.alias)} followed by sessions, connect, selected, dispatch or quiet.`]:[]),
      `This message is addressed only to your existing ${b.provider} session ${b.native_id}. Bridge request: ${jobId}.`,
      `Use your normal instructions, tools and permissions. Read the whatsapp-session skill.`,
      ...(this.store.get(`native-master:${b.id}`)==='true'&&this.store.get(`execution-mode:${b.id}`)!=='desktop'&&(this.store.get(`managed-codex:${b.id}`)==='true'||this.store.get(`managed-claude:${b.id}`)==='true')?
        [`Use the preinstalled session_bridge MCP tools. Send your response with whatsapp_reply using requestId=${jobId}, your text, and kind=progress or final.`]:
        [`Write your own response to WhatsApp with this command, sending the reply on stdin using a quoted heredoc (rtk proxy prefix where required):`,response]),
      `Use "progress" as the final command argument for an interim update; omit it for your final reply. Complete the work or explain the blocker before the final reply.`,
      `The transport receipt is not a completion acknowledgment. Do not route replies to another model or chat.`,
      '', '--- WhatsApp message ---',text].join('\n');
    if(Buffer.byteLength(message)>63000)throw new Error('Message exceeds native transport size limit');
    if(this.store.get(`execution-mode:${b.id}`)!=='desktop'&&(this.store.get(`managed-codex:${b.id}`)==='true'||this.store.get(`managed-claude:${b.id}`)==='true'||this.store.get(`managed-worker:${b.id}`)==='true')) {
      if(!this.managedRun)throw new Error('Managed native runtime is unavailable.');
      await this.managedRun(b,message,jobId);return;
    }
    writeFileSync(file,message,{mode:0o600});
    const args=['--config',this.configPath,'--coord-dir',dir,...(b.provider==='codex'?['send-codex','--target',b.native_id,'--id',id]:['send-claude','--session',b.native_id]),'--sender',sender,'--file',file];
    try {
      if(b.provider==='claude')await this.desktopConfig();
      const {stdout}=await exec(helper,args,{timeout:30000,maxBuffer:1024*1024});
      const r=JSON.parse(stdout);
      if(r.status!=='submitted'&&r.status!=='received')throw new Error(`Native delivery is ${r.status??'unconfirmed'}. Reference ${id}`);
      this.store.audit('native-submitted',b.id,id);
    } catch(e:any) {
      let receipt;try{receipt=JSON.parse(e.stdout);}catch{}
      throw new Error(receipt?`Native delivery ${receipt.status}; reference ${id}. Do not resubmit until checked.`:e.message);
    } finally {try{unlinkSync(file);}catch{}}
  }
  async sendDesktopCreation(sessionId:string,file:string) {
    await this.desktopConfig();
    const {stdout}=await exec(helper,['--config',this.configPath,'send-claude','--session',sessionId,'--sender','Sidekick owner-requested session setup','--file',file],{timeout:30000,maxBuffer:1024*1024});
    const receipt=JSON.parse(stdout);
    if(receipt.status!=='submitted'&&receipt.status!=='received')throw new Error('Desktop creation submission could not be confirmed. Do not resubmit.');
  }
  stop(b:Binding){this.approvals.cancel(b.id);}
  close(){this.approvals.cancel();}
}
