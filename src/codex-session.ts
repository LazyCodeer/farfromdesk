import { spawn,type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { nativeCommand } from './platform.js';

/** One native app-server transport. No shell, API keys or alternate model client. */
export class CodexSession extends EventEmitter {
  process:ChildProcessWithoutNullStreams;
  pending=new Map<number,{resolve:(r:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  sequence=0;
  alive=true;
  constructor(binary:string,cwd:string,private approval:(method:string,params:any)=>Promise<any>) {
    super();
    const command=nativeCommand(binary,['app-server']);
    this.process=spawn(command.binary,command.args,{cwd,stdio:'pipe',env:process.env,windowsHide:true});
    this.process.stderr.resume(); // Native diagnostics may contain private content; never echo them.
    const lines=createInterface({input:this.process.stdout});
    lines.on('line',line=>{
      if(line.length>4*1024*1024){this.close();return;}
      let m:any;try{m=JSON.parse(line);}catch{return;}
      if(m.method&&m.id!==undefined){void approval(m.method,m.params).then(result=>this.write({id:m.id,result})).catch(()=>this.write({id:m.id,error:{code:-32000,message:'Owner approval unavailable; operation denied'}}));return;}
      if(m.id!==undefined){const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(new Error(m.error.message??'Native request failed')):p.resolve(m.result);}return;}
      if(m.method)this.emit('notification',m.method,m.params);
    });
    const gone=()=>{this.alive=false;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Native Codex connection ended; delivery may be uncertain.'));}this.pending.clear();this.emit('closed');};
    this.process.on('error',gone);this.process.on('exit',gone);
  }
  write(value:any){if(this.alive)this.process.stdin.write(JSON.stringify(value)+'\n');}
  request(method:string,params:any):Promise<any>{
    if(!this.alive)return Promise.reject(new Error('Native Codex is offline'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Native request timed out; do not repeat creation or delivery blindly.'));},45000);
      this.pending.set(id,{resolve,reject,timer});this.write({id,method,params});
    });
  }
  async initialize(){await this.request('initialize',{clientInfo:{name:'session_bridge',version:'0.3.0'},capabilities:{experimentalApi:true}});this.write({method:'initialized',params:{}});}
  close(){this.process.kill();}
}
