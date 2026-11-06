import {execFile} from 'node:child_process';
import {connect,type Socket} from 'node:net';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {windowsPowerShell} from './power.js';
import type {WindowsHelper} from './remote-p2p/windows-desktop.js';

/**
 * The FarFromDesk Screen Helper (native/screen-service/FfdScreenService.cs): an opt-in Windows
 * service that lets the phone see and type on the lock screen, which nothing running as the
 * owner can do. This module checks it, installs and removes it (one admin prompt), and talks to
 * it over its pipe with the same line protocol as native/remote-windows.ps1.
 */
export const SCREEN_SERVICE='FarFromDeskScreen';
export const SCREEN_PIPE='\\\\.\\pipe\\farfromdesk-screen';
const native=(name:string)=>fileURLToPath(new URL(`../native/${name}`,import.meta.url));
export const screenServiceExe=()=>native('ffd-screen-service.exe');
const installScript=()=>native('screen-service-install.ps1');

type Run=(file:string,args:string[],timeoutMs:number)=>Promise<{code:number;stdout:string}>;
const run:Run=(file,args,timeoutMs)=>new Promise(resolve=>{
 execFile(file,args,{timeout:timeoutMs,windowsHide:true,encoding:'utf8'},(error,stdout)=>resolve({code:error?Number((error as {code?:unknown}).code)||1:0,stdout:String(stdout)}));
});

export type ScreenServiceStatus={supported:boolean;bundled:boolean;installed:boolean;running:boolean};

let cached:{at:number;value:ScreenServiceStatus}|undefined;
/** Installed and running, read from the service registry through sc.exe; no admin needed. The app polls
 * the remote-control status every few seconds, so a reading is reused for 5 seconds. */
export async function screenServiceStatus(platform:NodeJS.Platform=process.platform,exec:Run=run):Promise<ScreenServiceStatus>{
 if(platform!=='win32')return {supported:false,bundled:false,installed:false,running:false};
 if(exec===run&&cached&&Date.now()-cached.at<5000)return cached.value;
 const value=await readStatus(exec);
 if(exec===run)cached={at:Date.now(),value};
 return value;
}
async function readStatus(exec:Run):Promise<ScreenServiceStatus>{
 const bundled=existsSync(screenServiceExe());
 const sc=join(process.env.SystemRoot??'C:\\Windows','System32','sc.exe');
 const q=await exec(sc,['query',SCREEN_SERVICE],10_000);
 const installed=q.code===0&&/SERVICE_NAME/i.test(q.stdout);
 return {supported:true,bundled,installed,running:installed&&/STATE\s*:\s*4\b|RUNNING/i.test(q.stdout)};
}

/** The current user's SID, which the service is registered for: only this account can open its pipe. */
export async function currentUserSid(exec:Run=run):Promise<string>{
 const r=await exec(join(process.env.SystemRoot??'C:\\Windows','System32','whoami.exe'),['/user','/fo','csv','/nh'],10_000);
 const sid=/"(S-1-5-21-[0-9-]+)"/.exec(r.stdout)?.[1];
 if(!sid)throw new Error('SCREEN_SERVICE_FAILED: could not read this account.');
 return sid;
}

/**
 * Turns the service on or off. Windows shows its admin prompt on the PC; the owner has to accept
 * it there, so this is started from the app, never from a phone message. The elevated script
 * writes its answer to a file, because an elevated process's output cannot be read back.
 */
export async function setScreenService(enable:boolean,exec:Run=run):Promise<ScreenServiceStatus>{
 if(process.platform!=='win32')throw new Error('SCREEN_SERVICE_UNSUPPORTED: unlocking from the phone is for Windows.');
 const source=screenServiceExe();
 if(enable&&!existsSync(source))throw new Error('SCREEN_SERVICE_MISSING: this build does not include the screen helper.');
 const dir=mkdtempSync(join(tmpdir(),'ffd-screen-service-')),result=join(dir,'result.json');
 try{
  const args=enable
   ?['-Source',source,'-Sha256',createHash('sha256').update(readFileSync(source)).digest('hex'),'-UserSid',await currentUserSid(exec),'-Result',result]
   :['-Uninstall','-Result',result];
  // Start-Process -Verb RunAs is what raises the UAC prompt; arguments are quoted for PowerShell.
  const quoted=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',installScript(),...args].map(a=>`'${a.replace(/'/g,"''")}'`).join(',');
  const command=`try { $p = Start-Process -FilePath '${windowsPowerShell().replace(/'/g,"''")}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList ${quoted}; exit $p.ExitCode } catch { exit 1223 }`;
  const r=await exec(windowsPowerShell(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',command],5*60_000);
  let answer:{ok?:boolean;error?:string}|null=null;try{answer=JSON.parse(readFileSync(result,'utf8'));}catch{}
  if(!answer){
   if(r.code===1223)throw new Error('SCREEN_SERVICE_DECLINED: the Windows admin prompt was declined, so nothing changed.');
   throw new Error('SCREEN_SERVICE_FAILED: the Windows admin step did not finish.');
  }
  if(!answer.ok)throw new Error(`SCREEN_SERVICE_FAILED: ${answer.error??'the screen helper could not be set up'}.`);
  cached=undefined;
  return screenServiceStatus('win32',exec);
 }finally{cached=undefined;rmSync(dir,{recursive:true,force:true});}
}

/**
 * A WindowsHelper over the service's pipe. The service starts a screen agent in the owner's
 * console session for each connection and refuses (first line, id 0) when the caller or the
 * console is not the owner's.
 */
export class ServicePipeHelper implements WindowsHelper{
 private socket?:Socket;private buffer='';private next=1;private refusal?:string;
 private waiting=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
 constructor(private path=SCREEN_PIPE,private connectFn:(path:string)=>Socket=p=>connect(p)){}
 /** Connects, or resolves false when the service is not there; a refusal is remembered. */
 open(timeoutMs=1500):Promise<boolean>{
  if(this.socket&&!this.socket.destroyed)return Promise.resolve(true);
  return new Promise(resolve=>{
   const s=this.connectFn(this.path);let done=false;
   const finish=(ok:boolean)=>{if(done)return;done=true;clearTimeout(timer);if(!ok)s.destroy();resolve(ok);};
   const timer=setTimeout(()=>finish(false),timeoutMs);
   s.setEncoding('utf8');
   s.on('connect',()=>{this.socket=s;this.buffer='';finish(true);});
   s.on('error',()=>finish(false));
   s.on('data',(d:string)=>this.onData(d));
   s.on('close',()=>{if(this.socket===s)this.socket=undefined;for(const w of this.waiting.values())w.reject(new Error(this.refusal??'HELPER_EXITED'));this.waiting.clear();});
  });
 }
 private onData(d:string){
  this.buffer+=d;let i;
  while((i=this.buffer.indexOf('\n'))>=0){
   const line=this.buffer.slice(0,i).trim();this.buffer=this.buffer.slice(i+1);if(!line)continue;
   let r:any;try{r=JSON.parse(line);}catch{continue;}
   if(Number(r.id)===0&&r.ok===false){this.refusal=String(r.error??'SCREEN_SERVICE_REFUSED');continue;}
   const w=this.waiting.get(Number(r.id));if(!w)continue;this.waiting.delete(Number(r.id));
   if(r.ok===true)w.resolve(r);else w.reject(new Error(String(r.error??'HELPER_ERROR')));
  }
 }
 get refused(){return this.refusal;}
 request(body:Record<string,unknown>,signal?:AbortSignal,timeoutMs=10_000){
  if(signal?.aborted)return Promise.reject(new Error('DESKTOP_STOPPED'));
  const s=this.socket;if(!s||s.destroyed)return Promise.reject(new Error(this.refusal??'HELPER_EXITED'));
  const id=this.next++;
  return new Promise<any>((resolve,reject)=>{
   const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
   const timer=setTimeout(()=>{this.waiting.delete(id);this.stop();reject(new Error('HELPER_TIMEOUT'));},timeoutMs);
   const abort=()=>{this.waiting.delete(id);done();reject(new Error('DESKTOP_STOPPED'));};
   signal?.addEventListener('abort',abort,{once:true});
   this.waiting.set(id,{resolve:v=>{done();resolve(v);},reject:e=>{done();reject(e);}});
   s.write(JSON.stringify({...body,id})+'\n');
  });
 }
 stop(){const s=this.socket;this.socket=undefined;s?.destroy();}
}
