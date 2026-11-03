import { spawn } from 'node:child_process';
import { dshBinary as dshBinaryPath, dshHome } from './dsh-paths.js';

/**
 * DeepSeek Harness is driven through its own headless profile: one `dsh --profile headless` runs
 * one task to completion and exits. The bridge reads the `--json` event stream rather than the
 * human stdout line, because that stream names the session identity and carries the finished
 * answer explicitly.
 *
 * The contract below is the shipped one (`dsh --profile headless --help`, and the `dsh-headless`
 * README in the installed app): the stream opens with `session`, closes with `final`, and carries
 * `status`, `text`, `thinking`, `tool_call`, `tool_result` and `error` between them. Exit code 0
 * means the task completed and 1 means it aborted or errored, so a `final` event is never treated
 * as success on its own. A failed turn still emits a `final` event, sometimes empty, which is why
 * the exit code and the answer text are both required.
 *
 * `--session-id` adopts a persisted session, and that adoption is scoped: the CLI refuses a session
 * recorded in another working directory, a subagent or forked session, a session with no recorded
 * directory, or one whose preset this profile does not compose. Those refusals arrive as an `error`
 * event and exit 1 before the task runs, and they are reported rather than retried.
 */
export type DshResult={text:string;sessionId:string|null;error:string|null};

export type DshRunOptions={
  prompt:string;
  cwd:string;
  sessionId?:string|null;
  timeoutMs?:number;
  binary?:string;
  env?:NodeJS.ProcessEnv;
  signal?:AbortSignal;
};

// The terminal `final` event is not capped by the CLI, so the answer can be large; the other
// bounds only stop a runaway stream from growing the bridge's memory without limit.
const MAX_STREAM_BYTES=64*1024*1024;
const MAX_LINE_BYTES=8*1024*1024;

export function dshBinary():string{return dshBinaryPath();}

export function dshArgs(options:DshRunOptions):string[] {
  const args=['--profile','headless','--json'];
  if(options.sessionId)args.push('--session-id',options.sessionId);
  // A lone `-` is the documented stdin marker. Sending the task on stdin keeps a long prompt out
  // of the argument vector and out of any shell quoting.
  args.push('-');
  return args;
}

/**
 * Run one task. Resolves with the finished answer, rejects when the run did not complete so a
 * caller never reports an unfinished turn as an answer.
 */
export function runDsh(options:DshRunOptions):Promise<DshResult> {
  if(!options.prompt.trim())return Promise.reject(new Error('DeepSeek was given no prompt.'));
  const binary=options.binary??dshBinary();
  const args=dshArgs(options);
  const timeoutMs=options.timeoutMs??20*60*1000;
  const env={...process.env,...options.env,NO_COLOR:'1',CI:'1',DSH_HOME:dshHome(options.env??process.env)};
  return new Promise((resolve,reject)=>{
    let settled=false,bytes=0,stderr='',pending='',text:string|null=null,streamError:string|null=null;
    let sessionId:string|null=options.sessionId??null;
    const child=spawn(binary,args,{cwd:options.cwd,env,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
    const finish=(error?:Error,result?:DshResult)=>{
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort',abort);
      try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM');}catch{try{child.kill('SIGTERM');}catch{}}
      child.stdout?.destroy();child.stderr?.destroy();
      if(error)reject(error);else resolve(result!);
    };
    const fail=(message:string)=>finish(new Error(message));
    const abort=()=>fail('The DeepSeek run was cancelled.');
    options.signal?.addEventListener('abort',abort);
    const timer=setTimeout(()=>fail('DeepSeek did not finish in time. The run was stopped; check the session before retrying.'),timeoutMs);

    child.on('error',(error:NodeJS.ErrnoException)=>{
      fail(error.code==='ENOENT'?'DeepSeek Harness is not installed. Install it, then try again.':`DeepSeek could not start: ${error.message}`);
    });

    const onEvent=(event:any)=>{
      const type=typeof event?.type==='string'?event.type:'';
      if(type==='session'&&typeof event.sessionId==='string'&&event.sessionId)sessionId=event.sessionId;
      if(type==='error'&&typeof event.message==='string'&&event.message)streamError=event.message;
      // `final` is the terminal event and carries the same lossless answer as the plain stdout
      // line. A later one wins, matching the CLI's own last-answer-wins aggregation.
      if(type==='final'&&typeof event.text==='string')text=event.text;
    };

    child.stdout?.on('data',(chunk:Buffer)=>{
      bytes+=chunk.length;
      if(bytes>MAX_STREAM_BYTES){fail('DeepSeek produced more output than the bridge will read. The run was stopped.');return;}
      pending+=chunk.toString('utf8');
      let index=pending.indexOf('\n');
      while(index>=0){
        const line=pending.slice(0,index).trim();
        pending=pending.slice(index+1);
        if(line.startsWith('{')){try{onEvent(JSON.parse(line));}catch{/* an unreadable line is not an answer */}}
        if(settled)return;
        index=pending.indexOf('\n');
      }
      if(pending.length>MAX_LINE_BYTES)fail('DeepSeek produced an oversized record. The run was stopped.');
    });
    child.stderr?.on('data',(chunk:Buffer)=>{if(stderr.length<4000)stderr+=chunk.toString('utf8');});
    // Keep the prompt off the shell and out of the argument vector.
    child.stdin?.on('error',()=>{});
    child.stdin?.end(options.prompt);
    child.on('close',(code:number|null)=>{
      if(settled)return;
      // The writer ends every event with a newline, but a stream that ends mid-line must still be
      // read: dropping a trailing `final` would report a finished run as an empty answer.
      const tail=pending.trim();
      if(tail.startsWith('{')){try{onEvent(JSON.parse(tail));}catch{}}
      const detail=stderr.split('\n').map(line=>line.replace(/^dsh:\s*/,'').trim()).filter(Boolean).slice(-2).join(' ').slice(0,300);
      const reason=detail||streamError||'';
      if(code!==0)fail(`DeepSeek Harness exited with code ${code ?? 'unknown'}${reason?`: ${reason}`:''} before completing the task.`);
      else {
        if(streamError&&!text)fail(streamError);
        else if(!text?.trim())fail('DeepSeek finished without any answer text. Check the session before retrying.');
        else finish(undefined,{text,sessionId,error:null});
      }
    });
  });
}