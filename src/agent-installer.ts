import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Store } from './store.js';

/** Native file access can wait for OS consent. Never put it on the API event loop. */
export class AgentInstaller {
  private child?:ChildProcess;
  private timer?:ReturnType<typeof setTimeout>;
  constructor(private store:Store,private timeoutMs=10000,private launch=()=>spawn(process.execPath,[fileURLToPath(new URL('./agent-sync.js',import.meta.url))],{stdio:'ignore',env:process.env,windowsHide:true})) {}
  start() {
    if(this.child)return;
    this.store.set('agent-sync-status',JSON.stringify({state:'pending',at:Date.now()}));
    let child:ChildProcess;
    const finish=(state:string)=>{
      if(this.child!==child)return;
      clearTimeout(this.timer);this.child=undefined;
      this.store.set('agent-sync-status',JSON.stringify({state,at:Date.now(),...(state==='unavailable'?{message:'Agent files could not be refreshed. Check native file/disk permissions. The bridge remains available.'}:{})}));
    };
    try {child=this.launch();this.child=child;}
    catch {this.store.set('agent-sync-status',JSON.stringify({state:'unavailable',at:Date.now()}));return;}
    child.once('error',()=>finish('unavailable'));
    child.once('exit',code=>finish(code===0?'complete':'unavailable'));
    this.timer=setTimeout(()=>{finish('unavailable');child.kill('SIGTERM');},this.timeoutMs);
    this.timer.unref();
  }
  close(){clearTimeout(this.timer);const child=this.child;this.child=undefined;child?.kill('SIGTERM');}
}
