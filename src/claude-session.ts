import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Native Claude CLI's SDK stdio protocol. No API proxy or permission bypass. */
export class ClaudeSession {
  process:ChildProcessWithoutNullStreams;
  alive=true;
  lastUsage?:{inputTokens?:number;outputTokens?:number};
  private roleInstructions=false;
  private initializeWait?:{resolve:()=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout};
  private turn?:{resolve:(text:string)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout};
  constructor(binary:string,cwd:string,private id:string,resume:boolean,private permission:(tool:string,input:unknown)=>Promise<boolean>,env:NodeJS.ProcessEnv=process.env,options:{name?:string;permissionMode?:'manual'|'acceptEdits';mcpConfig?:string;allowedTools?:string;instructions?:string}={}) {
    this.roleInstructions=!!options.instructions;
    this.process=spawn(binary,['-p','--verbose','--input-format','stream-json','--output-format','stream-json','--permission-mode',options.permissionMode??'acceptEdits','--permission-prompts','host',...(options.instructions?['--append-system-prompt',options.instructions,'--system-prompt-snapshot','off']:[]),...(options.mcpConfig?['--mcp-config',options.mcpConfig]:[]),...(options.allowedTools?['--allowedTools',options.allowedTools]:[]),...(!resume&&options.name?['--name',options.name]:[]),resume?'--resume':'--session-id',id],{cwd,stdio:'pipe',env});
    this.process.stderr.resume();
    createInterface({input:this.process.stdout}).on('line',line=>{
      if(line.length>4*1024*1024){this.close();return;}
      let m:any;try{m=JSON.parse(line);}catch{return;}
      if(m.session_id&&m.session_id!==id){this.fail(new Error('Claude returned a different session identity; delivery stopped.'));this.close();return;}
      if(m.type==='control_response'&&m.response?.request_id==='initialize') {
        const w=this.initializeWait;if(!w)return;clearTimeout(w.timer);this.initializeWait=undefined;
        m.response.subtype==='error'?w.reject(new Error('Claude SDK initialization failed.')):w.resolve();return;
      }
      if(m.type==='control_request') {
        const r=m.request;
        void (async()=>{
          let allow=false;
          if(r?.subtype==='can_use_tool'&&typeof r.tool_name==='string')allow=await permission(r.tool_name,r.input);
          if(!this.alive)return;
          this.write({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:allow?{behavior:'allow',updatedInput:r.input}:{behavior:'deny',message:'Owner approval was denied or unavailable.'}}});
        })().catch(()=>this.write({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{behavior:'deny',message:'Owner approval unavailable.'}}}));return;
      }
      if(m.type==='result') {
        if(m.usage)this.lastUsage={inputTokens:m.usage.input_tokens,outputTokens:m.usage.output_tokens};
        const turn=this.turn;if(!turn)return;clearTimeout(turn.timer);this.turn=undefined;
        if(m.is_error||m.subtype!=='success') {
          const auth=/auth|oauth|sign.?in/i.test(String(m.result??''));
          turn.reject(new Error(auth?'Claude authentication expired. Sign in to the native Claude CLI, then recover this exact session.':'Claude could not complete this native turn. Check its session before retrying.'));
        }else turn.resolve(typeof m.result==='string'?m.result:'');
      }
    });
    this.process.on('error',()=>this.fail(new Error('Claude CLI could not start.')));
    this.process.on('exit',()=>this.fail(new Error('Native Claude connection ended; delivery may be uncertain.')));
  }
  write(m:unknown){if(this.alive)this.process.stdin.write(JSON.stringify(m)+'\n');}
  initialize(){return new Promise<void>((resolve,reject)=>{
    this.initializeWait={resolve,reject,timer:setTimeout(()=>{this.fail(new Error('Claude initialization timed out.'));this.close();},45000)};
    this.write({type:'control_request',request_id:'initialize',request:{subtype:'initialize',hooks:null,...(this.roleInstructions?{systemPromptSnapshot:false}:{})}});
  });}
  run(text:string,images:unknown[]=[]){
    this.lastUsage=undefined;
    if(!this.alive||this.turn)return Promise.reject(new Error('Claude session is offline or already running.'));
    return new Promise<string>((resolve,reject)=>{
      this.turn={resolve,reject,timer:setTimeout(()=>{this.fail(new Error('Claude turn timed out; check the exact session before retrying.'));this.close();},60*60_000)};
      this.write({type:'user',session_id:this.id,message:{role:'user',content:images.length?[{type:'text',text},...images]:text}});
    });
  }
  private fail(e:Error){this.alive=false;for(const pending of [this.initializeWait,this.turn])if(pending){clearTimeout(pending.timer);pending.reject(e);}this.initializeWait=undefined;this.turn=undefined;}
  close(){this.fail(new Error('Native Claude runtime closed.'));this.process.kill();}
}
