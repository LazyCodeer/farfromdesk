import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {mkdtempSync,mkdirSync,openSync,closeSync,readSync,writeSync,rmSync,constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {NativeCall} from '../mac-native.js';

/** Launch the independently granted test app through LaunchServices.
 * Private FIFOs carry correlated commands; closing stdin ends only this instance.
 * No bundle rebuild, permission mutation, persistent service or message replay.
 */
export function launchServicesNative(app:string):NativeCall {
 let dir:string|undefined, input:number|undefined, output:number|undefined, process:ChildProcess|undefined;
 let buffer='', chain:Promise<unknown>=Promise.resolve(), stopped=false;
 let pending:((error:Error)=>void)|undefined;
 const cleanup=()=>{
   stopped=true;pending?.(Error('OWNER_HELPER_STOPPED'));pending=undefined;
   if(input!==undefined){closeSync(input);input=undefined;}
   if(output!==undefined){closeSync(output);output=undefined;}
   if(dir){rmSync(dir,{recursive:true,force:true});dir=undefined;}
   // Do not kill by bundle ID: the owner's setup window is a separate instance.
 };
 const start=()=>{
   if(input!==undefined)return;
   if(stopped)throw Error('OWNER_HELPER_STOPPED');
   dir=mkdtempSync(join(tmpdir(),'ffd-owner-ipc-'));
   const i=join(dir,'input'),o=join(dir,'output');
   execFileSync('/usr/bin/mkfifo',['-m','600',i,o]);
   input=openSync(i,constants.O_RDWR|constants.O_NONBLOCK);
   output=openSync(o,constants.O_RDWR|constants.O_NONBLOCK);
   process=spawn('/usr/bin/open',['-n','-g','-W','-a',app,'--stdin',i,'--stdout',o,'--stderr','/dev/null','--args','--server'],{stdio:'ignore'});
   process.once('error',cleanup);process.once('exit',cleanup);
 };
 const call:NativeCall=(command,signal)=>{
  const work=chain.then(()=>new Promise((resolve,reject)=>{
   if(signal?.aborted||stopped){reject(Error('OWNER_HELPER_STOPPED'));return;}
   try{start();}catch(e){cleanup();reject(e);return;}
   const id=randomUUID();let finished=false;
   const end=(error?:Error,value?:unknown)=>{if(finished)return;finished=true;clearInterval(poll);clearTimeout(timeout);signal?.removeEventListener('abort',abort);pending=undefined;error?reject(error):resolve(value);};
   const abort=()=>{end(Error('OWNER_HELPER_UNCERTAIN'));cleanup();};
   const poll=setInterval(()=>{
    try{
     const chunk=Buffer.alloc(65536);let count=0;
     try{count=readSync(output!,chunk,0,chunk.length,null);}catch(e){if((e as NodeJS.ErrnoException).code!=='EAGAIN')throw e;}
     if(count)buffer+=chunk.subarray(0,count).toString('utf8');
     if(buffer.length>1024*1024)throw Error('OWNER_HELPER_RESPONSE_TOO_LARGE');
     const newline=buffer.indexOf('\n');if(newline<0)return;
     const response=JSON.parse(buffer.slice(0,newline));buffer=buffer.slice(newline+1);
     if(response.commandId!==id)throw Error('OWNER_HELPER_CORRELATION_FAILED');
     if(response.error){end(Error(response.error));return;}end(undefined,response);
    }catch(e){end(e as Error);cleanup();}
   },20);
   const timeout=setTimeout(abort,12000);pending=e=>end(e);signal?.addEventListener('abort',abort,{once:true});
   try{const data=Buffer.from(JSON.stringify({...command,commandId:id})+'\n');if(data.length>32000||writeSync(input!,data)!==data.length)throw Error('OWNER_HELPER_WRITE_UNCERTAIN');}catch(e){end(e as Error);cleanup();}
  }));
  chain=work.catch(()=>{});return work;
 };
 call.stop=cleanup;return call;
}
