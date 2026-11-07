import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {isAbsolute} from 'node:path';
import type {MailKeychainVault} from './keychain-adapter.js';
import {spawnMailHelper} from './helper-command.js';

const error=()=>new Error('Keychain unavailable.');
/** One broker owns the OS lock across every operation and while parent IPC remains open. */
export class MailKeychainHelper implements MailKeychainVault {
  private process?:ChildProcessWithoutNullStreams;
  private active=false;
  private buffer='';
  private pending?:{resolve:(x:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout};
  private serial:Promise<unknown>=Promise.resolve();
  private closed?:Promise<void>;
  /** extraArgs is a trusted test seam (a synthetic credential namespace), never derived from input. */
  constructor(private readonly executable:string,private readonly lockPath:string,private readonly timeoutMs=15_000,private readonly extraArgs:string[]=[]){
    if(!isAbsolute(executable)||!isAbsolute(lockPath)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60_000)throw error();
  }
  async start(){
    if(this.process)throw error();
    let p:ChildProcessWithoutNullStreams;try{p=spawnMailHelper(this.executable,[this.lockPath,...this.extraArgs]);}catch{throw error();}
    this.process=p;this.closed=new Promise(resolve=>p.once('close',()=>{this.active=false;const pending=this.pending;this.pending=undefined;if(pending){clearTimeout(pending.timer);pending.reject(error());}resolve();}));
    p.on('error',()=>{this.active=false;});p.stdin.on('error',()=>{this.active=false;p.kill('SIGKILL');});p.stderr.resume();
    p.stdout.on('data',(chunk:Buffer)=>{
      this.buffer+=chunk.toString('utf8');if(this.buffer.length>16384){this.active=false;p.kill('SIGKILL');return;}
      for(;;){const i=this.buffer.indexOf('\n');if(i<0)break;const line=this.buffer.slice(0,i);this.buffer=this.buffer.slice(i+1);const pending=this.pending;
        if(!pending){this.active=false;p.kill('SIGKILL');return;}this.pending=undefined;clearTimeout(pending.timer);
        try{pending.resolve(JSON.parse(line));}catch{this.active=false;p.kill('SIGKILL');pending.reject(error());}}
    });
    const ready=this.waitLine();try{const result=await ready;if(result?.ready!==true)throw error();this.active=true;}catch{p.kill('SIGKILL');await this.closed;throw error();}
  }
  private waitLine(){return new Promise<any>((resolve,reject)=>{
    if(this.pending||!this.process||this.process.exitCode!==null||this.process.signalCode!==null){reject(error());return;}
    const timer=setTimeout(()=>{this.active=false;this.process?.kill('SIGKILL');},this.timeoutMs);timer.unref();this.pending={resolve,reject,timer};
  });}
  isLocked(){return this.active&&!!this.process&&this.process.exitCode===null&&this.process.signalCode===null;}
  private call(action:'read'|'write'|'remove',slot:string,value?:string):Promise<string|undefined>{
    if(!/^[a-f0-9]{32}$/.test(slot)||action==='write'&&(typeof value!=='string'||!value||Buffer.byteLength(value)>4096))return Promise.reject(error());
    const run=async()=>{if(!this.isLocked())throw error();const response=this.waitLine();this.process!.stdin.write(JSON.stringify({action,slot,...(action==='write'?{value}:{})})+'\n');
      let result;try{result=await response;}catch{await this.closed;throw error();}
      if(!this.isLocked()||result?.ok!==true||action==='read'&&result.value!==null&&typeof result.value!=='string')throw error();
      return action==='read'?result.value??undefined:undefined;};
    const next=this.serial.then(run,run);this.serial=next.catch(()=>{});return next;
  }
  read(slot:string){return this.call('read',slot);}
  async write(slot:string,value:string){await this.call('write',slot,value);}
  async remove(slot:string){await this.call('remove',slot);}
  async close(){if(!this.process)return;this.active=false;this.process.stdin.end();await this.closed;}
}
