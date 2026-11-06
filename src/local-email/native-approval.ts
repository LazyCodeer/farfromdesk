import {isAbsolute} from 'node:path';
import type {MailDraftView} from './service.js';
import {spawnMailHelper} from './helper-command.js';
/** Native review makes a user decision independently of model or client booleans. */
export async function nativeMailApproval(executable:string,draft:MailDraftView):Promise<boolean>{
  if(!isAbsolute(executable))throw new Error('Mail approval unavailable.');
  return new Promise((resolve,reject)=>{
    let p;try{p=spawnMailHelper(executable,[]);}catch{reject(new Error('Mail approval unavailable.'));return;}
    let failed=false,output='';const timer=setTimeout(()=>{failed=true;p.kill('SIGKILL');},300_000);timer.unref();
    p.stderr.resume();p.on('error',()=>{failed=true;});p.stdin.on('error',()=>{failed=true;});p.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>1024){failed=true;p.kill('SIGKILL');}});
    p.on('close',code=>{clearTimeout(timer);if(failed||code!==0){reject(new Error('Mail approval unavailable.'));return;}try{const result=JSON.parse(output);if(typeof result.approved!=='boolean')throw Error();resolve(result.approved);}catch{reject(new Error('Mail approval unavailable.'));}});
    p.stdin.end(JSON.stringify({from:draft.from,to:draft.to.join(', '),subject:draft.subject,body:draft.body}));
  });
}
