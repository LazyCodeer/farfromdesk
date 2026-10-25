/** Runs inside one Claude Code session as its MCP channel. No model client here. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema,CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { baseUrl } from './config.js';

const file=process.argv[2];if(!file)throw new Error('Session credentials file required');
const credentials=JSON.parse(readFileSync(file,'utf8'));
const clientId=randomUUID();
async function api(path:string,body:any) {
  const r=await fetch(baseUrl+path,{method:'POST',headers:{Authorization:`Bearer ${credentials.token}`,'X-Binding-Id':credentials.id,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json() as any;if(!r.ok)throw new Error(d.error??'Bridge unavailable');return d;
}
const server=new Server({name:'whatsapp-session',version:'0.1.0'},{capabilities:{tools:{},experimental:{'claude/channel':{},'claude/channel/permission':{}}},instructions:
  `This channel is scoped to the registered session ${credentials.alias}. The user reads WhatsApp. Use whatsapp_reply for progress worth sending, questions, and the final answer. You write the exact message; the bridge does not rewrite it. Pass request_id from incoming channel metadata on replies. Use kind=final only when this request is complete; use progress otherwise. Never claim work is complete based merely on a tool finishing. All your normal tools, skills and project instructions remain in effect. The reply tool cannot choose another recipient or session.`});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'whatsapp_reply',description:'Send your own message to this session’s registered WhatsApp self-chat.',inputSchema:{type:'object',properties:{text:{type:'string'},kind:{type:'string',enum:['progress','final']},request_id:{type:'string'}},required:['text','kind']}}]}));
server.setRequestHandler(CallToolRequestSchema,async request=>{
  if(request.params.name!=='whatsapp_reply')throw new Error('Unknown tool');
  const a=request.params.arguments as any;
  await api('/api/session/reply',{text:a.text,kind:a.kind,requestId:a.request_id,eventId:randomUUID()});
  return {content:[{type:'text',text:'Queued for WhatsApp delivery.'}]};
});
server.setNotificationHandler(z.object({method:z.literal('notifications/claude/channel/permission_request'),params:z.object({request_id:z.string(),tool_name:z.string(),description:z.string(),input_preview:z.string()})}),async({params:p})=>{
  let answer='deny';try{answer=(await api('/api/session/permission',{question:`${p.tool_name}\n${p.description}\n${p.input_preview}`})).answer;}catch{}
  await server.notification({method:'notifications/claude/channel/permission',params:{request_id:p.request_id,behavior:answer==='approve'?'allow':'deny'}});
});
await server.connect(new StdioServerTransport());
let polling=false;
const timer=setInterval(async()=>{
  if(polling)return;polling=true;
  try {
    const {job}=await api('/api/session/poll',{clientId});
    if(job)await server.notification({method:'notifications/claude/channel',params:{content:job.body,meta:{request_id:job.id,session:credentials.alias}}});
  } catch(e) {process.stderr.write(`WhatsApp channel: ${(e as Error).message}\n`);}
  finally{polling=false;}
},2000);
process.stdin.on('end',()=>{clearInterval(timer);process.exit(0);});
