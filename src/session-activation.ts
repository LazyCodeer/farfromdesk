import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync } from 'node:fs';
import type { Session } from './session-catalog.js';
import type { Store } from './store.js';

const exec=promisify(execFile);
export function codexDesktopUrl(id:string,wakeOnly=false) {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new Error('An exact Codex session ID is required.');
  return `codex://threads/${wakeOnly?'wake/':''}${id}`;
}
/** Codex Desktop's wake route resumes queued work without resubmitting it or
 * navigating the current window. New setup uses the normal visible chat route. */
export async function openCodexDesktop(id:string,wakeOnly=false) {
  const url=codexDesktopUrl(id,wakeOnly);
  if(process.env.NODE_TEST_CONTEXT)throw new Error('Refusing to open Codex Desktop from a test run.');
  if(process.platform!=='darwin')throw new Error('Automatic Codex Desktop opening is not supported by this OS adapter.');
  await exec('/usr/bin/open',[...(wakeOnly?['-g']:[]),'-b','com.openai.codex',url],{timeout:10000,maxBuffer:65536});
}
/** Open the exact native Desktop identity without creating a CLI runtime. */
export async function openClaudeDesktop(session:Session) {
  if(process.platform!=='darwin')throw new Error('Automatic Claude Desktop reopening is not supported by this OS adapter.');
  if(!/^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.desktopId??''))throw new Error('An exact native Desktop ID is required to reopen this chat.');
  await exec('/usr/bin/open',['-b','com.anthropic.claudefordesktop',`claude://claude.ai/epitaxy/${session.desktopId}`],{timeout:10000,maxBuffer:65536});
}

// Opens Claude's new-session page on a folder with a prefilled prompt. The owner presses Send,
// so the session starts from a genuine owner action; `folder` is the param Claude's own Finder service uses.
export async function openClaudeNewSession(folder:string,prompt:string) {
  // Tests must never open the owner's real Claude app.
  if(process.env.NODE_TEST_CONTEXT)throw new Error('Refusing to open Claude Desktop from a test run.');
  await exec('/usr/bin/open',['-b','com.anthropic.claudefordesktop',`claude://code/new?${new URLSearchParams({folder,q:prompt})}`],{timeout:10000,maxBuffer:65536});
}
// Brings Claude to the front without opening another new-session page (that could start a second session).
export async function focusClaudeDesktop() {
  if(process.env.NODE_TEST_CONTEXT)throw new Error('Refusing to open Claude Desktop from a test run.');
  await exec('/usr/bin/open',['-b','com.anthropic.claudefordesktop'],{timeout:10000,maxBuffer:65536});
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
