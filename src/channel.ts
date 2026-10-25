/** Runs inside one Claude Code session as its MCP channel. No model client here. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema,CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { baseUrl } from './config.js';
import { companionOperatingInstructions } from './roles.js';

const file=process.argv[2];if(!file)throw new Error('Session credentials file required');
const credentials=JSON.parse(readFileSync(file,'utf8'));
const clientId=randomUUID();
async function api(path:string,body:any) {
  const r=await fetch(baseUrl+path,{method:'POST',headers:{Authorization:`Bearer ${credentials.token}`,'X-Binding-Id':credentials.id,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json() as any;if(!r.ok)throw new Error(d.error??'Bridge unavailable');return d;
}
const server=new Server({name:'whatsapp-session',version:'0.1.0'},{capabilities:{tools:{},experimental:{'claude/channel':{},'claude/channel/permission':{}}},instructions:
  `${companionOperatingInstructions}\nThis channel is scoped to the registered session ${credentials.alias}. Pass request_id from incoming channel metadata to whatsapp_reply. Use whatsapp_document only for an exact artifact already prepared locally with owner authorization. The reply tools cannot choose another recipient or session.`});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'whatsapp_reply',description:'Send your own message to this request’s frozen WhatsApp destination.',inputSchema:{type:'object',properties:{text:{type:'string'},kind:{type:'string',enum:['progress','final']},request_id:{type:'string'},turnId:{type:'string'},outcome:{type:'string',enum:['done','blocked','reviewed','cancelled']}},required:['text','kind']}},{name:'whatsapp_document',description:'Send an exact locally approved prepared artifact for this request.',inputSchema:{type:'object',properties:{request_id:{type:'string'},artifact_id:{type:'string'},caption:{type:'string'}},required:['request_id','artifact_id']}}]}));
server.setRequestHandler(CallToolRequestSchema,async request=>{
  const a=request.params.arguments as any;
  if(request.params.name==='whatsapp_document')return {content:[{type:'text',text:JSON.stringify(await api('/api/session/document',{requestId:a.request_id,artifactId:a.artifact_id,caption:a.caption??''}))}]};
  if(request.params.name!=='whatsapp_reply')throw new Error('Unknown tool');
  await api('/api/session/reply',{text:a.text,kind:a.kind,requestId:a.request_id,eventId:randomUUID(),turnId:a.turnId,outcome:a.outcome});
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
