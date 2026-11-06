import { query, type Query, type McpServerConfig, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { nativeCommand } from './platform.js';

export type ClaudeSDKOptions={
  /**
   * Keep one Claude process between turns (streaming input) instead of starting one per turn.
   * Starting Claude with a full user setup took 6-9 s, and every new process rebuilt a prompt
   * cache of 35-66k tokens; a warm process skips both. It closes after WARM_IDLE_MS idle, on any
   * failure, and on close(); the next turn then resumes the same session in a new process.
   */
  warm?:boolean;
  /**
   * The coordinator works through FarFromDesk's bridge, so it does not load the owner's other MCP
   * servers, the skill listing, or the native subagent tool (whose prompt listed every agent in
   * ~/.claude/agents: 289 on one PC, half of a 66k-token prompt). Permissions and env still come
   * from the owner's settings.
   */
  lean?:boolean;
};
export const WARM_IDLE_MS=10*60*1000;
const TURN_MS=60*60*1000;

/** A queue the SDK reads user messages from, for a warm process. */
function inputQueue(){
  const items:SDKUserMessage[]=[];let wake:(()=>void)|undefined,ended=false;
  async function* stream():AsyncGenerator<SDKUserMessage>{
    while(true){
      while(items.length)yield items.shift()!;
      if(ended)return;
      await new Promise<void>(r=>{wake=r;});wake=undefined;
    }
  }
  return {stream:stream(),push(m:SDKUserMessage){items.push(m);wake?.();},end(){ended=true;wake?.();}};
}

/** Public SDK transport; native account and permission settings remain authoritative. */
export class ClaudeSDKSession {
  alive=true;
  lastUsage?:{inputTokens?:number;outputTokens?:number};
  private active?:Query;
  private busy=false;
  private warm?:{q:Query;input:ReturnType<typeof inputQueue>;messages:AsyncIterator<any>;idle?:ReturnType<typeof setTimeout>};
  constructor(private binary:string,private cwd:string,private id:string,private resume:boolean,
    private permission:(tool:string,input:unknown)=>Promise<boolean>,private mcpServers:Record<string,McpServerConfig>,private queryFactory:typeof query=query,private instructions='',private opts:ClaudeSDKOptions={}) {}
  async initialize() { nativeCommand(this.binary,[]); }
  private options(abortController:AbortController){
    const command=nativeCommand(this.binary,[]);
    return {cwd:this.cwd,pathToClaudeCodeExecutable:command.binary,
      // Inherit the same provider/model environment used by connection discovery.
      // Claude itself applies user/project/local settings; never invoke shell aliases.
      env:{...process.env},
      ...(this.resume?{resume:this.id}:{sessionId:this.id}),forkSession:false,persistSession:true,
      permissionMode:'default' as const,settingSources:['user' as const,'project' as const,'local' as const],mcpServers:this.mcpServers,
      ...(this.opts.lean?{strictMcpConfig:true,disallowedTools:['Task','Agent'],skills:[] as string[]}:{}),
      // Native prompt snapshots otherwise ignore updated append text on resume.
      systemPrompt:{type:'preset' as const,preset:'claude_code' as const,...(this.instructions?{append:this.instructions,snapshot:false}:{})},abortController,
      canUseTool:async(tool:string,input:Record<string,unknown>)=>await this.permission(tool,input)?{behavior:'allow' as const,updatedInput:input}:{behavior:'deny' as const,message:'Owner approval denied or unavailable.'}};
  }
  private check(message:any):string|undefined{
    if('session_id' in message&&message.session_id!==this.id)throw new Error('Claude returned a different session identity. Delivery stopped.');
    if(message.type==='result') {
      if(message.usage)this.lastUsage={inputTokens:message.usage.input_tokens,outputTokens:message.usage.output_tokens};
      if(message.subtype!=='success'||message.is_error)throw new Error('Claude could not complete this turn. Check native sign-in, folder permissions and the exact session before retrying.');
      return message.result as string;
    }
    return undefined;
  }
  async run(prompt:string,images:any[]=[]) {
    this.lastUsage=undefined;
    if(!this.alive||this.busy)throw new Error('Claude session is offline or already running.');
    this.busy=true;
    try{return this.opts.warm?await this.runWarm(prompt,images):await this.runOnce(prompt,images);}
    finally{this.busy=false;}
  }
  private async runOnce(prompt:string,images:any[]) {
    const abortController=new AbortController();
    const timeout=setTimeout(()=>abortController.abort(),TURN_MS);
    const id=this.id;
    async function* input():AsyncGenerator<SDKUserMessage>{yield {type:'user',session_id:id,parent_tool_use_id:null,message:{role:'user',content:[{type:'text',text:prompt},...images]}};}
    const q=this.queryFactory({prompt:images.length?input():prompt,options:this.options(abortController)});
    this.active=q;
    try {
      let result:string|undefined;
      for await(const message of q) {const r=this.check(message);if(r!==undefined)result=r;}
      if(result===undefined)throw new Error('Claude ended without a confirmed result. Check the session before retrying.');
      this.resume=true;return result;
    } finally {clearTimeout(timeout);q.close();this.active=undefined;}
  }
  private async runWarm(prompt:string,images:any[]) {
    if(!this.warm){
      const input=inputQueue(),abortController=new AbortController();
      const q=this.queryFactory({prompt:input.stream,options:this.options(abortController)});
      this.warm={q,input,messages:q[Symbol.asyncIterator]()};this.active=q;
    }
    const w=this.warm;clearTimeout(w.idle);
    const timeout=setTimeout(()=>this.dropWarm(),TURN_MS);
    try{
      w.input.push({type:'user',session_id:this.id,parent_tool_use_id:null,message:{role:'user',content:[{type:'text',text:prompt},...images]}});
      while(true){
        const next=await w.messages.next();
        if(next.done)throw new Error('Claude ended without a confirmed result. Check the session before retrying.');
        const r=this.check(next.value);
        if(r!==undefined){
          this.resume=true;
          w.idle=setTimeout(()=>this.dropWarm(),WARM_IDLE_MS);w.idle.unref?.();
          return r;
        }
      }
    }catch(e){this.dropWarm();throw e;}
    finally{clearTimeout(timeout);}
  }
  /** Ends the warm process; the next turn resumes the same session in a new one. */
  private dropWarm(){
    const w=this.warm;if(!w)return;
    this.warm=undefined;if(this.active===w.q)this.active=undefined;
    clearTimeout(w.idle);w.input.end();try{w.q.close();}catch{}
  }
  close() {this.alive=false;this.dropWarm();this.active?.close();}
}
