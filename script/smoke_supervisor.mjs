// Keep the packaged smoke process bounded even if its own event loop blocks or a
// detached descendant holds its stdout open. The smoke assertions live in the child.
import {spawn} from 'node:child_process';
import {resolve,join,basename,dirname} from 'node:path';
import {readFile,realpath,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';

// No synchronous subprocess calls: even the external watchdog must keep its
// event loop responsive if an OS utility is stuck.
async function runUtility(command,args,timeoutMs=2000) {
  return new Promise(resolveResult=>{
    let output='',finished=false;
    const p=spawn(command,args,{stdio:['ignore','pipe','ignore']});
    p.stdout.on('data',chunk=>{if(output.length<32768)output+=chunk.toString();});
    const finish=result=>{if(finished)return;finished=true;clearTimeout(timer);p.stdout.destroy();p.unref();resolveResult(result);};
    const timer=setTimeout(()=>{p.kill('SIGKILL');finish(undefined);},timeoutMs);
    p.once('error',()=>finish(undefined));p.once('close',code=>finish(code===0?output:undefined));
  });
}
async function unixIdentity(pid) {
  const output=await runUtility('ps',['-p',String(pid),'-o','ppid=','-o','pgid=','-o','lstart=','-o','command=']);
  const m=output?.trim().match(/^(\d+)\s+(\d+)\s+((?:\S+\s+){4}\S+)\s+(.+)$/);
  if(!m)return;
  return {parent:Number(m[1]),group:Number(m[2]),fingerprint:`${m[2]}|${m[3]}|${m[4]}`};
}

/** Return the child exit status, or 124 when its independent deadline expires. */
export function runSupervisedSmoke(command,args,{deadlineMs=210000,pipeGraceMs=1000,env=process.env,stdout=process.stdout,stderr=process.stderr}={}) {
  return new Promise(resolveResult=>{
    const child=spawn(command,args,{stdio:['ignore','pipe','pipe','ipc'],detached:process.platform!=='win32',env});
    let finished=false,phase='initial setup',app,exitTimer,backend,backendPid,backendExited=false;
    const blocked=new WeakSet();
    const forward=(stream,data)=>{
      if(stream.destroyed||blocked.has(stream))return false;
      if(!stream.write(data)) {blocked.add(stream);stream.once('drain',()=>blocked.delete(stream));return false;}
      return true;
    };
    const say=message=>forward(stderr,`${message}\n`);
    let warned=false;
    const logs=(stream,data)=>{if(!forward(stream,data)&&!warned){warned=true;say('Native smoke output was truncated because the log consumer stopped reading.');}};
    child.stdout.on('data',data=>logs(stdout,data));child.stderr.on('data',data=>logs(stderr,data));
    child.on('message',message=>{
      if(!message||typeof message!=='object')return;
      if(message.type==='phase'&&typeof message.name==='string')phase=message.name;
      if(message.type==='backend-info'&&typeof message.state==='string'&&Number.isSafeInteger(message.port)&&message.port>0&&message.port<65536)backend={state:message.state,port:message.port};
      if(message.type==='backend-pid'&&Number.isSafeInteger(message.pid)&&message.pid>0)backendPid=message.pid;
      if(message.type==='backend-exited'&&message.pid===backendPid)backendExited=true;
      if(message.type==='app-started'&&Number.isSafeInteger(message.pid)&&message.pid>0&&process.platform!=='win32') {
        // Verify this is the smoke worker's own process-group leader before ever
        // killing it, and retain its start/command identity to guard PID reuse.
        const candidate={pid:message.pid};app=candidate;
        candidate.identity=unixIdentity(message.pid).then(found=>{
          if(found?.parent===child.pid&&found.group===message.pid)return found.fingerprint;
        });
      }
      if(message.type==='app-exited'&&app?.pid===message.pid)app=undefined;
    });
    async function stopBackend(signal) {
      if(!backend)return;
      try {
        // Only use the exact, freshly-created disposable state and its token.
        // Never print token, paths, response bodies or inspect other processes.
        const root=await realpath(tmpdir()),state=await realpath(backend.state);if(signal.aborted)return;
        if(dirname(state)!==root||!basename(state).startsWith('ffd-native-smoke-')||!(await lstat(state)).isDirectory())throw new Error('invalid smoke state');
        const tokenPath=join(state,'admin-token'),stat=await lstat(tokenPath);
        if(!stat.isFile()||stat.isSymbolicLink())throw new Error('invalid smoke token file');
        const token=(await readFile(tokenPath,{encoding:'utf8',signal})).trim();if(signal.aborted)return;if(!token||token.length>1024)throw new Error('invalid smoke token');
        const url=`http://127.0.0.1:${backend.port}`,headers={Authorization:`Bearer ${token}`};
        const check=await fetch(url+'/api/health',{headers,signal:AbortSignal.any([signal,AbortSignal.timeout(1000)])});
        if(!check.ok)throw new Error('health unavailable');
        const health=await check.json();if(signal.aborted)return;if(health?.app!=='FarFromDesk'||health.protocol!==1||!Number.isSafeInteger(health.pid)||health.pid<=0)throw new Error('unexpected backend');
        const response=await fetch(url+'/api/shutdown',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.any([signal,AbortSignal.timeout(1000)])});
        if(!response.ok)throw new Error('shutdown refused');
        say('Native smoke requested shutdown of its authenticated isolated backend.');
      } catch {if(!signal.aborted)say('Native smoke could not verify backend cleanup; it did not signal an unknown process.');}
    }
    async function stopProcesses() {
      if(process.platform==='win32') {
        if(child.pid)await runUtility('taskkill',['/pid',String(child.pid),'/T','/F'],3000);
        child.kill('SIGKILL');return;
      }
      if(app) {
        const candidate=app,fingerprint=await candidate.identity,now=await unixIdentity(candidate.pid);
        if(app===candidate&&fingerprint&&now?.fingerprint===fingerprint)try{process.kill(-candidate.pid,'SIGKILL');}catch{}
      }
      if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}
    }
    async function finish(code,{stop=false}={}) {
      if(finished)return;finished=true;clearTimeout(deadline);clearTimeout(exitTimer);
      if(stop){
        const controller=new AbortController();
        const backendTimer=setTimeout(()=>controller.abort(),2500);
        await Promise.race([stopBackend(controller.signal),new Promise(done=>controller.signal.addEventListener('abort',done,{once:true}))]);
        if(controller.signal.aborted)say('Native smoke backend cleanup timed out; unknown processes were not signaled.');
        clearTimeout(backendTimer);controller.abort();await stopProcesses();
      }
      // Never wait for a detached descendant that inherited the worker pipe.
      child.stdout.destroy();child.stderr.destroy();
      if(child.connected)child.disconnect();child.unref();resolveResult(code);
    }
    const deadline=setTimeout(()=>{say(`Native smoke supervisor exceeded ${Math.round(deadlineMs/1000)} seconds during ${phase}.`);finish(124,{stop:true});},deadlineMs);
    child.once('error',error=>{say(`Native smoke supervisor could not start the worker: ${error.message}`);finish(1,{stop:true});});
    child.once('exit',(code,signal)=>{
      if(finished)return;
      // 'exit' alone is insufficient: an orphan may still hold the output pipe.
      exitTimer=setTimeout(()=>{say(`Native smoke worker exited but its output pipes remained open during ${phase}.`);finish(code&&code!==0?code:1,{stop:true});},pipeGraceMs);
      if(signal)phase=`${phase} (worker terminated by ${signal})`;
    });
    child.once('close',(code,signal)=>{
      const result=Number.isInteger(code)?code:1;
      if(result!==0||signal)return void finish(result||1,{stop:true});
      // A real smoke worker reported a backend: success requires its explicit
      // verified-exit proof, not just an HTTP 200 or a closed output pipe.
      if(backend&&!backendExited){say('Native smoke did not confirm its isolated backend exited.');return void finish(1,{stop:true});}
      finish(0);
    });
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const code=await runSupervisedSmoke(process.execPath,['script/smoke_desktop_app.mjs']);
  process.exitCode=code;
  // A blocked CI log consumer must not keep the supervisor alive indefinitely.
  setTimeout(()=>process.exit(code),250);
}
