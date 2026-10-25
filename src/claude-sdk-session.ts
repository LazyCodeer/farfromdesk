import { query, type Query, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { nativeCommand } from './platform.js';

/** Public SDK transport; native account and permission settings remain authoritative. */
export class ClaudeSDKSession {
  alive=true;
  private active?:Query;
  constructor(private binary:string,private cwd:string,private id:string,private resume:boolean,
    private permission:(tool:string,input:unknown)=>Promise<boolean>,private mcpServers:Record<string,McpServerConfig>,private queryFactory:typeof query=query) {}
  async initialize() { nativeCommand(this.binary,[]); }
  async run(prompt:string) {
    if(!this.alive||this.active)throw new Error('Claude session is offline or already running.');
    const command=nativeCommand(this.binary,[]);
    const abortController=new AbortController();
    const timeout=setTimeout(()=>abortController.abort(),60*60*1000);
    const q=this.queryFactory({prompt,options:{cwd:this.cwd,pathToClaudeCodeExecutable:command.binary,
      ...(this.resume?{resume:this.id}:{sessionId:this.id}),forkSession:false,persistSession:true,
      permissionMode:'default',settingSources:['user','project','local'],mcpServers:this.mcpServers,
      systemPrompt:{type:'preset',preset:'claude_code'},abortController,
      canUseTool:async(tool,input)=>await this.permission(tool,input)?{behavior:'allow',updatedInput:input}:{behavior:'deny',message:'Owner approval denied or unavailable.'}}});
    this.active=q;
    try {
      let result:string|undefined;
      for await(const message of q) {
        if('session_id' in message&&message.session_id!==this.id)throw new Error('Claude returned a different session identity. Delivery stopped.');
        if(message.type==='result') {
          if(message.subtype!=='success'||message.is_error)throw new Error('Claude could not complete this turn. Check native sign-in, folder permissions and the exact session before retrying.');
          result=message.result;
        }
      }
      if(result===undefined)throw new Error('Claude ended without a confirmed result. Check the session before retrying.');
      this.resume=true;return result;
    } finally {clearTimeout(timeout);q.close();this.active=undefined;}
  }
  close() {this.alive=false;this.active?.close();}
}
