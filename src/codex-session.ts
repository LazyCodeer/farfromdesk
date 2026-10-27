import { spawn,type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { stat,realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { nativeCommand } from './platform.js';

export async function requireCodexHistory(path:unknown) {
  if(typeof path!=='string'||!isAbsolute(path))throw new Error('Codex has not saved this conversation yet. Recover this exact setup before sending a task.');
  try {
    const info=await stat(path);
    if(!info.isFile()||info.size===0)throw new Error('Empty history');
  }catch(error:any) {throw Object.assign(new Error('Codex conversation history is unavailable. Open this exact chat in Codex before sending a task.'),{code:error?.code});}
}

/** thread/start can return before its rollout is written. Read the saved history
 * before stopping app-server; a database row alone is not a usable chat. */
export async function confirmCodexSession(runtime:Pick<CodexSession,'request'>,id:string,cwd:string) {
  const result=await runtime.request('thread/read',{threadId:id,includeTurns:true});
  const thread=result?.thread;
  if(thread?.id!==id||typeof thread.cwd!=='string'||await realpath(thread.cwd)!==await realpath(cwd))throw new Error('Native session identity does not match this setup.');
  await requireCodexHistory(thread.path);
}

/** thread/start configures its runtime, but Desktop's first queued turn can use
 * separately saved settings. Only call for a newly provisioned, owner-approved
 * worker, never to reset an existing chat's user-selected permission policy. */
export async function saveNewCodexWorkerSettings(runtime:Pick<CodexSession,'request'>,id:string,cwd:string) {
  const workspace=await realpath(cwd);
  try {
    await runtime.request('thread/settings/update',{
      threadId:id,cwd:workspace,approvalPolicy:'on-request',
      sandboxPolicy:{type:'workspaceWrite',writableRoots:[workspace],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false},
    });
  }catch {
    throw new Error('Codex could not save this new worker’s workspace-editing settings. No task was sent. Update Codex or recover this exact setup; do not create another chat or disable approvals.');
  }
}

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
    const gone=()=>{if(!this.alive)return;this.alive=false;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Native Codex connection ended; delivery may be uncertain.'));}this.pending.clear();this.emit('closed');};
    this.process.on('error',gone);this.process.on('exit',gone);
    // Pipe failures are stream errors, not child-process errors. Treat delivery as uncertain, never replay it.
    this.process.stdin.on('error',()=>{gone();this.close();});
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

/** Read only: never resume, launch a turn, or treat the latest unrelated turn as this request. */
export async function observeCodexRequest(runtime:Pick<CodexSession,'request'>,binding:{native_id:string;cwd:string},requestId:string):Promise<{status:string;turnId:string}|undefined> {
  const result=await runtime.request('thread/read',{threadId:binding.native_id,includeTurns:true});
  const t=result?.thread;
  if(t?.id!==binding.native_id||typeof t.cwd!=='string'||await realpath(t.cwd)!==await realpath(binding.cwd))throw new Error('Native observation identity mismatch');
  const matches=(t.turns??[]).filter((turn:any)=>(turn.items??[]).some((i:any)=>i.type==='userMessage'&&(i.content??[]).some((c:any)=>{
    if(c.type!=='text'||typeof c.text!=='string')return false;
    // Envelope metadata is a standalone JSON line. Quoted prose is not identity evidence.
    return c.text.split('\n').some((line:string)=>{try{return JSON.parse(line).requestId===requestId;}catch{return false;}});
  })));
  if(matches.length!==1||typeof matches[0].id!=='string'||!['inProgress','completed','interrupted','failed'].includes(matches[0].status))return undefined;
  return {status:matches[0].status,turnId:matches[0].id};
}
