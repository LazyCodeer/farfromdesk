import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {windowsPowerShell} from '../power.js';
import type {DesktopBackend,DesktopFrame,Input} from './protocol.js';

/** One request to the Windows helper (native/remote-windows.ps1) and its one-line answer. */
export type WindowsHelper={request(body:Record<string,unknown>,signal?:AbortSignal,timeoutMs?:number):Promise<any>;stop():void};

const script=fileURLToPath(new URL('../../native/remote-windows.ps1',import.meta.url));
const TYPE_CHUNK=200,MAX_DIMENSION=1400,QUALITY=60;

/**
 * The helper is a long-lived hidden PowerShell that compiles its capture and input code once,
 * so a frame is a screen copy and a JPEG encode (about 0.1 s), not a new process. It is started
 * on first use and again after it dies; a request it does not answer in time ends it.
 */
export class PowerShellHelper implements WindowsHelper{
 private child?:ChildProcessWithoutNullStreams;private buffer='';private next=1;
 private waiting=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
 constructor(private file=script){}
 private start(){
  if(this.child&&this.child.exitCode===null&&!this.child.killed)return this.child;
  // windowsHide: the backend runs without a console, so a visible one would flash on screen.
  const child=spawn(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',this.file],{stdio:'pipe',windowsHide:true});
  this.child=child;this.buffer='';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',(d:string)=>{
   this.buffer+=d;let i;
   while((i=this.buffer.indexOf('\n'))>=0){
    const line=this.buffer.slice(0,i).trim();this.buffer=this.buffer.slice(i+1);if(!line)continue;
    let r:any;try{r=JSON.parse(line);}catch{continue;}
    const w=this.waiting.get(Number(r.id));if(!w)continue;this.waiting.delete(Number(r.id));
    if(r.ok===true)w.resolve(r);else w.reject(new Error(String(r.error??'HELPER_ERROR')));
   }
  });
  child.stderr.resume();
  const gone=()=>{if(this.child===child)this.child=undefined;for(const w of this.waiting.values())w.reject(new Error('HELPER_EXITED'));this.waiting.clear();};
  child.on('exit',gone);child.on('error',gone);
  return child;
 }
 request(body:Record<string,unknown>,signal?:AbortSignal,timeoutMs=10_000){
  if(signal?.aborted)return Promise.reject(new Error('DESKTOP_STOPPED'));
  const child=this.start(),id=this.next++;
  return new Promise<any>((resolve,reject)=>{
   const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
   // A helper that stops answering is ended, so the next request starts a fresh one.
   const timer=setTimeout(()=>{this.waiting.delete(id);this.stop();reject(new Error('HELPER_TIMEOUT'));},timeoutMs);
   const abort=()=>{this.waiting.delete(id);done();reject(new Error('DESKTOP_STOPPED'));};
   signal?.addEventListener('abort',abort,{once:true});
   this.waiting.set(id,{resolve:v=>{done();resolve(v);},reject:e=>{done();reject(e);}});
   child.stdin.write(JSON.stringify({...body,id})+'\n');
  });
 }
 stop(){const c=this.child;this.child=undefined;if(c){c.stdin.end();c.kill();}}
}

/** Windows virtual-key codes for the keys the phone may send (protocol.ts KEYS). */
const VK:Record<string,number>={return:0x0d,tab:0x09,escape:0x1b,delete:0x08,space:0x20,up:0x26,down:0x28,left:0x25,right:0x27,home:0x24,end:0x23,pageup:0x21,pagedown:0x22};
const CTRL=0x11,SHIFT=0x10,ALT=0x12,WIN=0x5b;
/** The phone page names Mac modifiers; ⌘ shortcuts mean the Ctrl ones on Windows (⌘C copies, ⌘W closes). */
const MODIFIER:Record<string,number>={cmd:CTRL,ctrl:CTRL,shift:SHIFT,option:ALT};

export function windowsKey(key:string,modifiers:string[]=[]):{vk:number;modifiers:number[]}{
 const vk=VK[key]??(/^[a-z0-9]$/.test(key)?key.toUpperCase().charCodeAt(0):undefined);
 if(vk===undefined)throw Error('INVALID_KEY');
 const mods=modifiers.map(m=>{const v=MODIFIER[m];if(v===undefined)throw Error('INVALID_KEY');return v;});
 // ⌘Tab switches apps and ⌘Q quits on a Mac; on Windows those are Alt+Tab and Alt+F4.
 if(modifiers.length===1&&modifiers[0]==='cmd'&&key==='tab')return {vk,modifiers:[ALT]};
 if(modifiers.length===1&&modifiers[0]==='cmd'&&key==='q')return {vk:0x73,modifiers:[ALT]};
 // ⌘Space opens Spotlight search; the Windows key opens Start, which searches as you type.
 if(modifiers.length===1&&modifiers[0]==='cmd'&&key==='space')return {vk:WIN,modifiers:[]};
 return {vk,modifiers:[...new Set(mods)]};
}

/**
 * Full primary display on Windows: the screen absolute mouse input addresses. The phone's
 * x and y are fractions of that frame, so they map straight onto the screen at any scaling.
 * While Windows is locked the lock screen cannot be captured or typed into, so the phone sees
 * a placeholder and input is refused (PC_LOCKED) until someone unlocks it at the PC.
 */
export class WindowsDesktopBackend implements DesktopBackend{
 readonly os='windows' as const;
 private controller=new AbortController();private readyAt=0;private lastLocked=false;
 constructor(private helper:WindowsHelper=new PowerShellHelper()){}
 async ready(fresh=false){
  if(this.controller.signal.aborted)return false;
  if(!fresh&&Date.now()-this.readyAt<1000)return this.lastLocked?'locked' as const:true;
  try{
   const s=await this.helper.request({op:'state'},this.controller.signal);
   this.lastLocked=s.locked===true;this.readyAt=Date.now();
   return this.lastLocked?'locked' as const:true;
  }catch{return false;}
 }
 async capture(signal:AbortSignal):Promise<DesktopFrame>{
  const f=await this.helper.request({op:'capture',max:MAX_DIMENSION,quality:QUALITY},signal,15_000);
  const jpeg=Buffer.from(String(f.jpeg??''),'base64');
  if(jpeg.length<4||jpeg[0]!==0xff||jpeg[1]!==0xd8)throw Error('INVALID_JPEG');
  if(!Number.isInteger(f.width)||!Number.isInteger(f.height)||f.width<1||f.height<1)throw Error('INVALID_FRAME');
  return {jpeg:new Uint8Array(jpeg),width:f.width,height:f.height,captureId:`win-${Date.now()}`};
 }
 private async send(body:Record<string,unknown>,signal:AbortSignal){
  try{await this.helper.request(body,signal);}
  catch(e){
   const code=(e as Error).message;
   // A refusal changes nothing, so the session goes on (host.ts acks it as ACTION_REFUSED).
   if(code==='PC_LOCKED'||code==='INPUT_BLOCKED')throw Error('DESKTOP_NATIVE_REFUSED: '+code);
   throw e;
  }
 }
 async act(_frame:DesktopFrame,a:Input,signal:AbortSignal){
  if(a.kind==='click'||a.kind==='double'||a.kind==='right')
   return this.send({op:'mouse',x:a.x,y:a.y,button:a.kind==='right'?'right':'left',count:a.kind==='double'?2:1},signal);
  if(a.kind==='scroll')return this.send({op:'scroll',x:a.x,y:a.y,direction:a.direction,amount:a.amount},signal);
  if(a.kind==='key')return this.send({op:'key',...windowsKey(a.key!,a.modifiers)},signal);
  // Task View is the Windows "show all windows"; tapping a window there switches to it.
  if(a.kind==='overview')return this.send({op:'key',vk:0x09,modifiers:[WIN]},signal);
  if(a.kind==='type'){
   const chars=[...a.text!];
   for(let i=0;i<chars.length;i+=TYPE_CHUNK)await this.send({op:'text',text:chars.slice(i,i+TYPE_CHUNK).join('')},signal);
   return;
  }
  // Windows has no API to list or switch virtual desktops, so desktops() is not offered
  // and the phone hides that row; a desktop request that still arrives is refused.
  if(a.kind==='desktop')throw Error('DESKTOP_NATIVE_REFUSED: DESKTOPS_UNSUPPORTED');
  throw Error('INVALID_INPUT');
 }
 stop(){this.controller.abort();this.helper.stop();}
}
