import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync } from 'node:fs';
import type { Session } from './session-catalog.js';
import type { Store } from './store.js';
import { probeDesktopApps } from './app-liveness.js';
import { openWithShell, windowsClaudeDesktop, windowsCodexDesktop, type WindowsDesktopApp } from './desktop-apps.js';
import { computerName } from './platform.js';

const exec=promisify(execFile);
export function codexDesktopUrl(id:string,wakeOnly=false) {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new Error('An exact Codex session ID is required.');
  return `codex://threads/${wakeOnly?'wake/':''}${id}`;
}
/** Codex Desktop's wake route resumes queued work without resubmitting it or
 * navigating the current window. New setup uses the normal visible chat route.
 *
 * `-g` leaves the app in the background, which is right for a wake while Codex is
 * already running: the owner is doing something else and the queued turn resumes
 * by itself. It is wrong when Codex is closed, because that starts the app with
 * no window and the queued turn never runs, which reads as "it opened in the
 * background but nothing happened". The flag is chosen from real app liveness,
 * and a launch that never appears is reported instead of being passed off as a
 * wake. */
export function codexOpenArguments(wakeOnly:boolean,running:boolean,url:string) {
  return [...(wakeOnly&&running?['-g']:[]),'-b','com.openai.codex',url];
}
/**
 * What opens a desktop app or one of its URLs on this OS. macOS asks LaunchServices for the
 * app's bundle; Windows hands the URL (claude:, codex:) or the app's Start entry to the shell,
 * which is how those apps register their links there. Anything else is refused plainly.
 */
export type DesktopOpen={kind:'mac';args:string[]}|{kind:'shell';target:string};
export function desktopOpenPlan(app:'claude'|'codex',url:string|undefined,platform:NodeJS.Platform=process.platform,
  windows:{claude?:WindowsDesktopApp;codex?:WindowsDesktopApp}={claude:windowsClaudeDesktop(),codex:windowsCodexDesktop()},running=false):DesktopOpen {
  const name=app==='claude'?'Claude Desktop':'Codex Desktop';
  if(platform==='darwin')return {kind:'mac',args:app==='codex'?codexOpenArguments(url?.includes('/wake/')===true,running,url!):['-b','com.anthropic.claudefordesktop',...(url?[url]:[])]};
  if(platform!=='win32')throw new Error(`Opening ${name} automatically works on macOS and Windows only. Open it yourself on this ${computerName(platform)}.`);
  const installed=windows[app];
  if(!installed)throw new Error(`${name} is not installed on this PC. Install it from ${app==='claude'?'claude.ai/download':'the Microsoft Store (it is listed as ChatGPT)'}, sign in, then try again.`);
  if(url)return {kind:'shell',target:url};
  return {kind:'shell',target:installed.aumid?`shell:AppsFolder\\${installed.aumid}`:installed.executable!};
}
async function openDesktop(plan:DesktopOpen) {
  if(plan.kind==='mac')await exec('/usr/bin/open',plan.args,{timeout:10000,maxBuffer:65536});
  else await openWithShell(plan.target);
}
export async function openCodexDesktop(id:string,wakeOnly=false) {
  const url=codexDesktopUrl(id,wakeOnly);
  if(process.env.NODE_TEST_CONTEXT)throw new Error('Refusing to open Codex Desktop from a test run.');
  if(process.platform!=='darwin'&&process.platform!=='win32')throw new Error('Automatic Codex Desktop opening is not supported by this OS adapter.');
  const running=(await probeDesktopApps()).codex;
  await openDesktop(desktopOpenPlan('codex',url,process.platform,undefined,running));
  if(running)return;
  // A closed app takes a moment to appear, and only a running Codex can process
  // the wake route. Wait briefly, then say what is actually true.
  for(let i=0;i<16;i++){
    if((await probeDesktopApps()).codex)return;
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw new Error('Codex Desktop was asked to open but is still not running, so the queued message has not been picked up. Open Codex to continue; do not resend the message.');
}
/** Open the exact native Desktop identity without creating a CLI runtime. */
export async function openClaudeDesktop(session:Session) {
  if(process.env.NODE_TEST_CONTEXT)throw new Error('Refusing to open Claude Desktop from a test run.');
  if(process.platform!=='darwin'&&process.platform!=='win32')throw new Error('Automatic Claude Desktop reopening is not supported by this OS adapter.');
  if(!/^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.desktopId??''))throw new Error('An exact native Desktop ID is required to reopen this chat.');
  await openDesktop(desktopOpenPlan('claude',`claude://claude.ai/epitaxy/${session.desktopId}`));
}

// Opens Claude's new-session page on a folder with a prefilled prompt. The owner presses Send,
// so the session starts from a genuine owner action; `folder` is the param Claude's own Finder service uses.
export async function openClaudeNewSession(folder:string,prompt:string) {
  // Tests must never open the owner's real Claude app.
  if(process.env.NODE_TEST_CONTEXT)throw new Error('Refusing to open Claude Desktop from a test run.');
  await openDesktop(desktopOpenPlan('claude',`claude://code/new?${new URLSearchParams({folder,q:prompt})}`));
}
// Brings Claude to the front without opening another new-session page (that could start a second session).
export async function focusClaudeDesktop() {
  if(process.env.NODE_TEST_CONTEXT)throw new Error('Refusing to open Claude Desktop from a test run.');
  await openDesktop(desktopOpenPlan('claude',undefined));
}
export const CLAUDE_DESKTOP_READY_TIMEOUT_MS=180_000;
/** Readiness failed before a native message was submitted. The router can report
 * this immediately instead of applying its ambiguous-submission grace period. */
export class DesktopReadinessError extends Error {
  readonly notSubmitted=true;
}
type ActivationClock={now:()=>number;sleep:(ms:number)=>Promise<void>};
const realClock:ActivationClock={now:()=>Date.now(),sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms))};
export class SessionActivation {
  private pending=new Map<string,Promise<Session>>();
  constructor(private store:Store,private catalog:()=>Promise<Session[]>,private open=openClaudeDesktop,private timeoutMs=CLAUDE_DESKTOP_READY_TIMEOUT_MS,private clock:ActivationClock=realClock) {}
  ready(session:Session):Promise<Session> {
    if(session.activation!=='desktop-open')return Promise.resolve(session);
    const key=`desktop-wake:${session.id}`;
    const pending=this.pending.get(key);if(pending)return pending;
    const task=this.activate(key,session).finally(()=>this.pending.delete(key));
    this.pending.set(key,task);return task;
  }
  private async activate(key:string,session:Session) {
    if(session.provider!=='claude'||session.executionMode!=='desktop'||!session.desktopId||!session.accountScope||!/^[0-9a-f-]{36}$/i.test(session.id))throw new Error('Desktop resume requires an exact saved session and account scope.');
    const until=this.clock.now()+this.timeoutMs;
    const project=realpathSync(session.cwd);
    const prior=JSON.parse(this.store.get(key)??'null');
    if(prior&&((prior.project?prior.project!==project:prior.cwd!==session.cwd)||prior.accountScope!==session.accountScope))throw new Error('Desktop resume account or project changed.');
    const current=()=>this.catalog().then(rows=>{
      const row=rows.find(s=>s.id===session.id&&s.executionMode==='desktop');
      if(!row||realpathSync(session.cwd)!==project||realpathSync(row.cwd)!==project||row.provider!=='claude'||row.executionMode!=='desktop'||row.accountScope!==session.accountScope||(row.desktopId&&row.desktopId!==session.desktopId))throw new Error('Desktop resume identity or account changed. No message was sent.');
      return row;
    });
    const already=await current();if(already.available===true&&!already.activation)return already;
    // Persist before opening; crashes and repeated requests never create an open loop.
    if(!prior||prior.status==='ready') {
      this.store.set(key,JSON.stringify({cwd:session.cwd,project,accountScope:session.accountScope,status:'opening',at:Date.now()}));
      try {await this.open(session);}catch{throw new Error('Claude Desktop reopen was not confirmed. Check its login or native prompt; no CLI fallback or task submission occurred.');}
    }
    do {
      const row=await current();
      if(row.available===true&&!row.activation){this.store.set(key,JSON.stringify({cwd:session.cwd,project,accountScope:session.accountScope,status:'ready',at:Date.now()}));return row;}
      if(this.clock.now()<until)await this.clock.sleep(Math.min(750,until-this.clock.now()));
    }while(this.clock.now()<until);
    throw new DesktopReadinessError('Claude Desktop was asked to reopen this exact chat, but its inbox is not live after waiting up to three minutes. Check its login, folder prompt or native app. No task was sent and the open command will not be repeated automatically.');
  }
}
