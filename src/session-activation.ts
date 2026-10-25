import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync } from 'node:fs';
import { claudeBin } from './config.js';
import { claudeDiscoveryBinary } from './desktop-claude.js';
import type { Session } from './session-catalog.js';
import type { Store } from './store.js';

const exec=promisify(execFile);
/** The Desktop CLI requires a terminal; script allocates one without a shell or prompt. */
export async function openClaudeDesktop(session:Session) {
  if(process.platform!=='darwin')throw new Error('Automatic Claude Desktop reopening is not supported by this OS adapter.');
  const binary=await claudeDiscoveryBinary(claudeBin);
  const {stdout}=await exec(binary,['--help'],{timeout:5000,maxBuffer:65536});
  if(!stdout.includes('--desktop')||!stdout.includes('--resume'))throw new Error('This Claude version does not support Desktop resume. Update Claude.');
  await exec('/usr/bin/script',['-q','/dev/null',binary,'--desktop','--resume',session.id],{cwd:session.cwd,timeout:10000,maxBuffer:65536});
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
    if(realpathSync(session.cwd)!==session.cwd)throw new Error('Desktop project path changed; resume stopped.');
    const prior=JSON.parse(this.store.get(key)??'null');
    if(prior&&(prior.cwd!==session.cwd||prior.accountScope!==session.accountScope))throw new Error('Desktop resume account or project changed.');
    const current=()=>this.catalog().then(rows=>{
      const row=rows.find(s=>s.id===session.id);
      if(!row||row.cwd!==session.cwd||row.executionMode!=='desktop'||row.accountScope!==session.accountScope)throw new Error('Desktop resume identity or account changed. No message was sent.');
      return row;
    });
    const already=await current();if(already.available===true&&!already.activation)return already;
    // Persist before opening; crashes and repeated requests never create an open loop.
    if(!prior||prior.status==='ready') {
      this.store.set(key,JSON.stringify({cwd:session.cwd,accountScope:session.accountScope,status:'opening',at:Date.now()}));
      try {await this.open(session);}catch{throw new Error('Claude Desktop reopen was not confirmed. Check its login or native prompt; no CLI fallback or task submission occurred.');}
    }
    const until=Date.now()+this.timeoutMs;
    do {
      const row=await current();
      if(row.available===true&&!row.activation){this.store.set(key,JSON.stringify({cwd:session.cwd,accountScope:session.accountScope,status:'ready',at:Date.now()}));return row;}
      if(Date.now()<until)await new Promise(r=>setTimeout(r,750));
    }while(Date.now()<until);
    throw new Error('Claude Desktop was asked to reopen this exact chat, but its inbox is not live yet. A native login, folder prompt or app action may still be required. No task was sent and the open command will not be repeated automatically.');
  }
}
