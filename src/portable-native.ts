import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { listSessions, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { NativeAgents } from './native.js';
import { CodexSession } from './codex-session.js';
import { codexBin } from './config.js';
import type { Store, Binding, Provider } from './store.js';
import type { Approvals } from './approvals.js';
import type { Session } from './session-catalog.js';

export function exactSession(expected:{id:string;cwd:string}, actual:any, canonical = realpathSync) {
  if (actual?.id !== expected.id || typeof actual?.cwd !== 'string' || canonical(actual.cwd) !== canonical(expected.cwd))
    throw new Error('The native session ID or project changed. Delivery stopped; no replacement was selected.');
}
export class PortableNative extends NativeAgents {
  constructor(private portableStore:Store, approvals:Approvals) { super(portableStore,approvals); }
  async probe<T>(action:(runtime:CodexSession)=>Promise<T>) {
    const runtime=new CodexSession(codexBin,homedir(),async()=>{throw new Error('Discovery cannot approve native operations.');});
    try { await runtime.initialize(); return await action(runtime); } finally { runtime.close(); }
  }
  protected override async readCatalog(provider:Provider,cursor?:string):Promise<{sessions:Session[];cursor:string|null}> {
    if(provider==='claude') {
      const offset=Number(cursor||0);if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid session cursor.');
      const rows=await listSessions({limit:51,offset});
      return {sessions:rows.slice(0,50).filter(s=>s.cwd).map(s=>({id:s.sessionId,provider,executionMode:'cli',name:(s.customTitle||s.summary||basename(s.cwd!)).slice(0,160),cwd:s.cwd!,updatedAt:s.lastModified,available:true,status:'Saved CLI session · finish any native turn before resuming'})),cursor:rows.length>50?String(offset+50):null};
    }
    return this.probe(async runtime=>{
      const page=await runtime.request('thread/list',{limit:50,cursor:cursor??null,archived:false,sourceKinds:['cli','appServer']});
      if(!Array.isArray(page.data))throw new Error('This Codex version does not expose a compatible session catalog.');
      return {sessions:page.data.filter((s:any)=>s.id&&s.cwd&&!s.agentPath&&!s.parentThreadId).map((s:any)=>({id:s.id,provider,executionMode:'cli',name:(s.name||s.preview||s.id).slice(0,160),cwd:s.cwd,updatedAt:s.updatedAt*1000,available:s.status?.type!=='active',status:s.status?.type==='active'?'Native turn is active':'Saved session · resumes through CLI'})),cursor:page.nextCursor??null};
    });
  }
  override async validateSessions(sessions:{provider:Provider;id:string;cwd:string}[]) {
    for(const session of sessions) {
      if(session.provider==='claude') {
        const info=await getSessionInfo(session.id,{dir:session.cwd});
        exactSession(session,{id:info?.sessionId,cwd:info?.cwd});
      } else await this.probe(async runtime=>{
        const r=await runtime.request('thread/read',{threadId:session.id,includeTurns:false});
        exactSession(session,r.thread);
        if(r.thread.status?.type==='active')throw new Error('Finish the native turn before connecting this session.');
      });
    }
  }
  override async run(b:Binding,text:string,jobId:string) {
    if(this.portableStore.get(`execution-mode:${b.id}`)==='desktop')throw new Error('Desktop delivery is unsupported. Select a CLI session.');
    this.portableStore.set(`managed-${b.provider}:${b.id}`,'true');
    await super.run(b,text,jobId);
  }
  override async sendDesktopCreation():Promise<void> { throw new Error('Desktop creation is unsupported on this adapter.'); }
}
