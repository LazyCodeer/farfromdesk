import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { listSessions, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { NativeAgents, mergeClaudeSessions, claudeOwnerEnvironment } from './native.js';
import { CodexSession } from './codex-session.js';
import { codexBin } from './config.js';
import { desktopSessions } from './platform.js';
import { claudeDesktopHistory } from './session-catalog.js';
import { claudeDesktopProcesses, hasClaudeInboxes } from './desktop-claude.js';
import { claudeConfigHome, claudeDesktopDataDir } from './desktop-apps.js';
import { cursorOwnerHome } from './cursor-paths.js';
import type { Store, Binding, Provider } from './store.js';
import type { Approvals } from './approvals.js';
import type { Session } from './session-catalog.js';

export function exactSession(expected:{id:string;cwd:string}, actual:any, canonical = realpathSync) {
  if (actual?.id !== expected.id || typeof actual?.cwd !== 'string' || canonical(actual.cwd) !== canonical(expected.cwd))
    throw new Error('The native session ID or project changed. Delivery stopped; no replacement was selected.');
}
/**
 * Claude Desktop chats off macOS: the app's saved chats plus the live ones it runs, kept apart
 * from CLI history by runtime. A live chat counts only when its process descends from the app and
 * its inbox is published; a saved chat must be reopened in the app before it can take work.
 */
export function desktopClaudeRows(desktopHistory:Session[],live:any[],desktopPids:Set<number>,inboxes:Set<number>,liveComplete:boolean):Session[] {
  const all=mergeClaudeSessions([],desktopHistory,live.filter(s=>desktopPids.has(s?.pid)),desktopPids,inboxes);
  return [...all.values()].filter(s=>s.executionMode==='desktop').map(row=>({
    ...row,liveDiscoveryComplete:liveComplete,
    ...(row.activation?{available:liveComplete,activation:liveComplete?row.activation:undefined,
      status:liveComplete?'Saved Desktop chat · reopening must be verified':'Live session discovery failed · automatic resume held'}:{}),
  }));
}
export class PortableNative extends NativeAgents {
  constructor(private portableStore:Store, approvals:Approvals) { super(portableStore,approvals); }
  async probe<T>(action:(runtime:CodexSession)=>Promise<T>) {
    const runtime=new CodexSession(codexBin,homedir(),async()=>{throw new Error('Discovery cannot approve native operations.');});
    try { await runtime.initialize(); return await action(runtime); } finally { runtime.close(); }
  }
  /** Claude Desktop discovery. A failure here hides nothing else: CLI history still lists. */
  protected async desktopClaudeCatalog():Promise<Session[]> {
    const home=cursorOwnerHome();
    const [history,processes]=await Promise.all([
      claudeDesktopHistory(join(claudeDesktopDataDir(home),'claude-code-sessions')).catch(()=>[] as Session[]),
      claudeDesktopProcesses().then(pids=>({ok:true as const,pids}),()=>({ok:false as const,pids:new Set<number>()})),
    ]);
    let live:any[]=[],liveComplete:boolean=processes.ok;
    // No app process means no live Desktop chat, so the CLI listing is skipped entirely.
    if(processes.ok&&processes.pids.size)try{live=await this.liveClaudeSessions();}catch{liveComplete=false;}
    const inboxes=await hasClaudeInboxes(live.filter(s=>processes.pids.has(s?.pid)).map(s=>s.pid),claudeConfigHome(claudeOwnerEnvironment(),home));
    return desktopClaudeRows(history,live,processes.pids,inboxes,liveComplete);
  }
  protected override async readCatalog(provider:Provider,cursor?:string):Promise<{sessions:Session[];cursor:string|null}> {
    if(provider==='claude') {
      const offset=Number(cursor||0);if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid session cursor.');
      const [rows,desktop]=await Promise.all([listSessions({limit:51,offset}),desktopSessions&&offset===0?this.desktopClaudeCatalog():Promise.resolve([] as Session[])]);
      const cli:Session[]=rows.slice(0,50).filter(s=>s.cwd).map(s=>({id:s.sessionId,provider,executionMode:'cli',name:(s.customTitle||s.summary||basename(s.cwd!)).slice(0,160),cwd:s.cwd!,updatedAt:s.lastModified,available:true,status:'Saved CLI session · finish any native turn before resuming'}));
      // A chat running in Desktop cannot also resume through the CLI at the same time.
      const running=new Set(desktop.filter(s=>s.live).map(s=>s.id));
      return {sessions:[...cli.map(s=>running.has(s.id)?{...s,available:false,status:'This session is running in Desktop. Use that runtime or close it there before switching.'}:s),...desktop],cursor:rows.length>50?String(offset+50):null};
    }
    return this.probe(async runtime=>{
      const page=await runtime.request('thread/list',{limit:50,cursor:cursor??null,archived:false,sourceKinds:['cli','appServer']});
      if(!Array.isArray(page.data))throw new Error('This Codex version does not expose a compatible session catalog.');
      return {sessions:page.data.filter((s:any)=>s.id&&s.cwd&&!s.agentPath&&!s.parentThreadId).map((s:any)=>({id:s.id,provider,executionMode:'cli',name:(s.name||s.preview||s.id).slice(0,160),cwd:s.cwd,updatedAt:s.updatedAt*1000,available:s.status?.type!=='active',status:s.status?.type==='active'?'Native turn is active':'Saved session · resumes through CLI'})),cursor:page.nextCursor??null};
    });
  }
  override async validateSessions(sessions:{provider:Provider;id:string;cwd:string;executionMode?:'desktop'|'cli'}[]) {
    // Desktop chats are checked against the live Desktop catalog, exactly as on macOS.
    const desktop=sessions.filter(s=>s.provider==='claude'&&s.executionMode==='desktop');
    if(desktop.length) {
      if(!desktopSessions)throw new Error('Desktop session delivery is not supported by this platform adapter. Choose an exact saved CLI session.');
      await super.validateSessions(desktop);
    }
    for(const session of sessions) {
      if(session.provider==='claude'&&session.executionMode==='desktop')continue;
      if(session.provider==='claude') {
        const info=await getSessionInfo(session.id,{dir:session.cwd});
        exactSession(session,{id:info?.sessionId,cwd:info?.cwd});
      } else await this.probe(async runtime=>{
        const r=await runtime.request('thread/read',{threadId:session.id,includeTurns:false});
        exactSession(session,r.thread);
        // Codex Desktop's queue takes work while a turn runs; only a CLI resume must wait for it.
        const desktopQueue=session.executionMode==='desktop'||this.portableStore.bindings().some(b=>b.provider==='codex'&&b.native_id===session.id&&this.portableStore.get(`execution-mode:${b.id}`)==='desktop');
        if(r.thread.status?.type==='active'&&!desktopQueue)throw new Error('Finish the native turn before connecting this session.');
      });
    }
  }
  override async run(b:Binding,text:string,jobId:string) {
    if(this.portableStore.get(`execution-mode:${b.id}`)==='desktop') {
      if(!desktopSessions)throw new Error('Desktop delivery is unsupported. Select a CLI session.');
      // The Desktop app owns this chat: its queue takes the turn, never a managed CLI.
      return super.run(b,text,jobId);
    }
    this.portableStore.set(`managed-${b.provider}:${b.id}`,'true');
    await super.run(b,text,jobId);
  }
  override async sendDesktopCreation(sessionId:string,file:string):Promise<void> {
    if(!desktopSessions)throw new Error('Desktop creation is unsupported on this adapter.');
    return super.sendDesktopCreation(sessionId,file);
  }
}
