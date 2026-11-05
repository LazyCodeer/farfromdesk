import { spawn } from 'node:child_process';
import { museAuthPath, museBinary as museBinaryPath, museHome } from './muse-paths.js';

/**
 * Muse Code is a terminal agent: one `muse exec` runs one prompt to completion and prints
 * machine-readable JSONL. The bridge reads that stream rather than the human terminal UI,
 * because the JSONL records carry the terminal status and the final text explicitly.
 */
export type MuseResult={text:string;sessionId:string|null;usage:{inputTokens?:number;outputTokens?:number}|null;model:string|null};

export type MuseRunOptions={
  prompt:string;
  cwd:string;
  sessionId?:string|null;
  model?:string;
  timeoutMs?:number;
  maxModelSteps?:number;
  trustWorkspace?:boolean;
  network?:boolean;
  binary?:string;
  signal?:AbortSignal;
};

const MAX_STREAM_BYTES=8*1024*1024;
const MAX_LINE_BYTES=1024*1024;

export function museBinary():string{return museBinaryPath();}

/**
 * The Local backend runs with an app-private HOME, and Muse resolves its sign-in from HOME, so a
 * signed-in owner was told "missing meta credentials" (measured on Local, 4 November 2026). Hand
 * Muse the owner's real home and credential path; the bridge already reads Muse's files there.
 */
export function museEnv(env:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv {
  return {...env,HOME:museHome(env),MUSE_AUTH_PATH:env.MUSE_AUTH_PATH?.trim()||museAuthPath(env),NO_COLOR:'1',CI:'1'};
}

export function museArgs(options:MuseRunOptions):string[] {
  const args=['exec','--json','--disable-approval','--approval-mode','never'];
  if(options.sessionId)args.push('--session-id',options.sessionId);
  if(options.model)args.push('--model',options.model);
  if(options.maxModelSteps)args.push('--max-model-steps',String(options.maxModelSteps));
  if(options.trustWorkspace)args.push('--trust-workspace');
  // The owner chose to run Muse with network access: its default proxy-only sandbox dropped every
  // call to FarFromDesk on 127.0.0.1, so a Muse coordinator could not reach the owner's apps.
  // The filesystem sandbox stays on.
  if(options.network)args.push('--sandbox-network','enabled');
  args.push(options.prompt);
  return args;
}

type Terminal={terminal?:string;text?:string;reason?:string|null};

/**
 * Run one prompt. Resolves with the terminal text, rejects when the run did not complete so a
 * caller never reports an unfinished turn as an answer.
 */
export function runMuse(options:MuseRunOptions):Promise<MuseResult> {
  if(!options.prompt.trim())return Promise.reject(new Error('Muse was given no prompt.'));
  const binary=options.binary??museBinary();
  const args=museArgs(options);
  const timeoutMs=options.timeoutMs??15*60*1000;
  return new Promise((resolve,reject)=>{
    let settled=false,bytes=0,stderr='',pending='',deltas='',model:string|null=null;
    let sessionId:string|null=options.sessionId??null;
    let usage:MuseResult['usage']=null;
    const child=spawn(binary,args,{cwd:options.cwd,env:museEnv(),stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true});
    const finish=(error?:Error,result?:MuseResult)=>{
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort',abort);
      try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM');}catch{try{child.kill('SIGTERM');}catch{}}
      child.stdout?.destroy();child.stderr?.destroy();
      if(error)reject(error);else resolve(result!);
    };
    const fail=(message:string)=>finish(new Error(message));
    const abort=()=>fail('The Muse run was cancelled.');
    options.signal?.addEventListener('abort',abort);
    const timer=setTimeout(()=>fail('Muse did not finish in time. The run was stopped; check the session before retrying.'),timeoutMs);

    child.on('error',(error:NodeJS.ErrnoException)=>{
      fail(error.code==='ENOENT'?'Muse Code is not installed. Run the Meta installer, then try again.':`Muse could not start: ${error.message}`);
    });

    const onRecord=(record:any)=>{
      const payload=record?.payload;
      if(!payload||typeof payload!=='object')return;
      const kind=payload.kind??record.payload_type;
      if(record.stream?.kind==='session'&&typeof record.stream.id==='string')sessionId=record.stream.id;
      if(kind==='run_output_delta'&&typeof payload.text==='string')deltas+=payload.text;
      if(kind==='run_usage'&&Array.isArray(payload.models)){
        for(const entry of payload.models){
          if(!entry||typeof entry!=='object')continue;
          if(typeof entry.model==='string')model=entry.model;
          if(usage===null)usage={};
          if(typeof entry.input_tokens==='number')usage.inputTokens=(usage.inputTokens??0)+entry.input_tokens;
          if(typeof entry.output_tokens==='number')usage.outputTokens=(usage.outputTokens??0)+entry.output_tokens;
        }
      }
      if(kind!=='run_terminal')return;
      const terminal:Terminal=payload;
      if(terminal.terminal!=='completed'){
        fail(`Muse ended this run as ${terminal.terminal??'unknown'}${terminal.reason?`: ${terminal.reason}`:''}. Nothing was reported as an answer.`);
        return;
      }
      const text=(typeof terminal.text==='string'?terminal.text:deltas).trim();
      if(!text)fail('Muse finished without any answer text. Check the session before retrying.');
      else finish(undefined,{text,sessionId,usage,model});
    };

    child.stdout?.on('data',(chunk:Buffer)=>{
      bytes+=chunk.length;
      if(bytes>MAX_STREAM_BYTES){fail('Muse produced more output than the bridge will read. The run was stopped.');return;}
      pending+=chunk.toString('utf8');
      let index=pending.indexOf('\n');
      while(index>=0){
        const line=pending.slice(0,index).trim();
        pending=pending.slice(index+1);
        if(line.startsWith('{')){try{onRecord(JSON.parse(line));}catch{}}
        if(settled)return;
        index=pending.indexOf('\n');
      }
      if(pending.length>MAX_LINE_BYTES){fail('Muse produced an oversized record. The run was stopped.');}
    });
    child.stderr?.on('data',(chunk:Buffer)=>{if(stderr.length<4000)stderr+=chunk.toString('utf8');});
    child.on('close',(code:number|null)=>{
      if(settled)return;
      const detail=stderr.split('\n').map(line=>line.trim()).filter(Boolean).slice(-2).join(' ');
      fail(`Muse exited with code ${code ?? 'unknown'} before reporting a finished run.${detail?` ${detail.slice(0,300)}`:''}`);
    });
  });
}
