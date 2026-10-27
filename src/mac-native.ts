import { spawn,type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
export type NativeCall=((input:Record<string,unknown>,signal?:AbortSignal)=>Promise<any>) & {stop?:()=>void};
/** Backend-owned helper. No reconnect replay: the next command gets a fresh generation after exit. */
export function createMacNative(path:string,errors:ReadonlySet<string>,launch=()=>spawn(path,['--server'],{stdio:['pipe','pipe','pipe']}) as ChildProcessWithoutNullStreams,deadlineMs=12000):NativeCall {
  let child:ChildProcessWithoutNullStreams|undefined,buffer='',chain:Promise<unknown>=Promise.resolve();
  let pending:{id:string;resolve:(value:any)=>void;reject:(e:Error)=>void;cleanup:()=>void}|undefined;
  const end=(message:string)=>{const active=child;child=undefined;buffer='';if(pending){const p=pending;pending=undefined;p.cleanup();p.reject(new Error(message));}active?.kill('SIGKILL');};
  const start=()=>{
    if(child)return;
    const c=launch();child=c;buffer='';
    c.stdout.setEncoding('utf8');c.stdout.on('data',(data:string)=>{
      if(child!==c)return;buffer+=data;
      if(buffer.length>12*1024*1024){end('MAC_HELPER_INVALID_RESPONSE');return;}
      let index:number;
      while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);let result:any;try{result=JSON.parse(line);}catch{end('MAC_HELPER_INVALID_RESPONSE');return;}
        if(!pending||result.commandId!==pending.id){end('MAC_HELPER_INVALID_RESPONSE');return;}
        const p=pending;pending=undefined;p.cleanup();
        if(result.error)p.reject(new Error(errors.has(result.error)?result.error:'ACCESSIBILITY_UNAVAILABLE'));else p.resolve(result);
      }
    });
    // Never persist native stderr, which can contain target data from OS diagnostics.
    c.stdin.on('error',()=>{if(child===c)end('MAC_OPERATION_UNCERTAIN: Helper input closed; no automatic replay.');});c.stderr.resume();c.on('error',(e:NodeJS.ErrnoException)=>{if(child===c)end(e.code==='ENOENT'?'MAC_HELPER_NOT_BUILT':'MAC_OPERATION_UNCERTAIN: Inspect before another action.');});
    c.on('exit',()=>{if(child===c)end('MAC_OPERATION_UNCERTAIN: Helper exited; no automatic replay.');});
  };
  const run:NativeCall=(input,signal)=>{
    const work=chain.then(()=>new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(new Error('MAC_CONTROL_STOPPED'));return;}
      start();const id=randomUUID();const abort=()=>end('MAC_CONTROL_STOPPED');const timer=setTimeout(()=>end('MAC_OPERATION_UNCERTAIN: Helper deadline exceeded; no automatic replay.'),deadlineMs);
      pending={id,resolve,reject,cleanup:()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);}};
      signal?.addEventListener('abort',abort,{once:true});child!.stdin.write(JSON.stringify({...input,commandId:id})+'\n');
    }));
    chain=work.catch(()=>{});return work;
  };
  run.stop=()=>end('MAC_CONTROL_STOPPED');return run;
}
