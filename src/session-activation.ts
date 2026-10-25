import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync } from 'node:fs';
import type { Session } from './session-catalog.js';
import type { Store } from './store.js';

const exec=promisify(execFile);
/** Open the exact native Desktop identity without creating a CLI runtime. */
export async function openClaudeDesktop(session:Session) {
  if(process.platform!=='darwin')throw new Error('Automatic Claude Desktop reopening is not supported by this OS adapter.');
  if(!/^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.desktopId??''))throw new Error('An exact native Desktop ID is required to reopen this chat.');
  await exec('/usr/bin/open',['-b','com.anthropic.claudefordesktop',`claude://claude.ai/epitaxy/${session.desktopId}`],{timeout:10000,maxBuffer:65536});
}

export class SessionActivation {
  private pending=new Map<string,Promise<Session>>();
  constructor(private store:Store,private catalog:()=>Promise<Session[]>,private open=openClaudeDesktop,private timeoutMs=20000) {}
  ready(session:Session):Promise<Session> {
    if(session.activation!=='desktop-open')return Promise.resolve(session);
    const key=`desktop-wake:${session.id}`;
    const pending=this.pending.get(key);if(pending)return pending;
    const task=this.activate(key,session).finally(()=>this.pending.delete(key));
    this.pending.set(key,task);return task;
  }
  private async activate(key:string,session:Session) {
    if(session.provider!=='claude'||session.executionMode!=='desktop'||!session.desktopId||!session.accountScope||!/^[0-9a-f-]{36}$/i.test(session.id))throw new Error('Desktop resume requires an exact saved session and account scope.');
    const project=realpathSync(session.cwd);
    const prior=JSON.parse(this.store.get(key)??'null');
    if(prior&&((prior.project?prior.project!==project:prior.cwd!==session.cwd)||prior.accountScope!==session.accountScope))throw new Error('Desktop resume account or project changed.');
    const current=()=>this.catalog().then(rows=>{
      const row=rows.find(s=>s.id===session.id&&s.executionMode==='desktop');
      if(!row||realpathSync(session.cwd)!==project||realpathSync(row.cwd)!==project||row.executionMode!=='desktop'||row.accountScope!==session.accountScope)throw new Error('Desktop resume identity or account changed. No message was sent.');
      return row;
    });
    const already=await current();if(already.available===true&&!already.activation)return already;
    // Persist before opening; crashes and repeated requests never create an open loop.
    if(!prior||prior.status==='ready') {
      this.store.set(key,JSON.stringify({cwd:session.cwd,project,accountScope:session.accountScope,status:'opening',at:Date.now()}));
      try {await this.open(session);}catch{throw new Error('Claude Desktop reopen was not confirmed. Check its login or native prompt; no CLI fallback or task submission occurred.');}
    }
    const until=Date.now()+this.timeoutMs;
    do {
      const row=await current();
      if(row.available===true&&!row.activation){this.store.set(key,JSON.stringify({cwd:session.cwd,project,accountScope:session.accountScope,status:'ready',at:Date.now()}));return row;}
      if(Date.now()<until)await new Promise(r=>setTimeout(r,750));
    }while(Date.now()<until);
    throw new Error('Claude Desktop was asked to reopen this exact chat, but its inbox is not live yet. A native login, folder prompt or app action may still be required. No task was sent and the open command will not be repeated automatically.');
  }
}
