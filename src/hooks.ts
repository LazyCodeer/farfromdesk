import { readdirSync,readFileSync,mkdirSync,writeFileSync,renameSync,unlinkSync,statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stateDir,baseUrl } from './config.js';
import type { Store } from './store.js';

export function hookMessage(provider:string,input:any) {
  if(!['codex','claude'].includes(provider)||typeof input.session_id!=='string')return null;
  let files:string[];try{files=readdirSync(join(stateDir,'bindings'));}catch{return null;}
  for(const f of files.filter(f=>f.endsWith('.json')&&!f.endsWith('.mcp.json'))) {
    let c;try{c=JSON.parse(readFileSync(join(stateDir,'bindings',f),'utf8'));}catch{continue;}
    if(c.provider===provider&&c.nativeId===input.session_id)return c;
  }
  return null;
}
export async function handleHook(provider:string,input:any) {
  const c=hookMessage(provider,input);if(!c)return;
  if(input.hook_event_name==='PermissionRequest') {
    let answer='deny';
    try {
      const r=await fetch(baseUrl+'/api/session/permission',{method:'POST',headers:{Authorization:`Bearer ${c.token}`,'X-Binding-Id':c.id,'Content-Type':'application/json'},body:JSON.stringify({question:`${input.tool_name}\n${JSON.stringify(input.tool_input,null,2)}`}),signal:AbortSignal.timeout(15*60_000+5000)});
      if(r.ok)answer=((await r.json()) as any).answer;
      else if(r.status===401)return; // Paused or unregistered: native permission UI continues.
    } catch{}
    return {hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:answer==='approve'?'allow':'deny'}}};
  }
  if(input.hook_event_name!=='Stop'||input.stop_hook_active||typeof input.last_assistant_message!=='string'||!input.last_assistant_message.trim())return;
  const text=input.last_assistant_message;
  let turn=input.turn_id;
  if(!turn){try{const stat=statSync(input.transcript_path);turn=`${stat.size}:${stat.mtimeMs}`;}catch{turn=String(Date.now());}}
  const fingerprint=createHash('sha256').update(`${c.id}:${turn}:${text}`).digest('hex');
  const dir=join(stateDir,'spool');mkdirSync(dir,{recursive:true,mode:0o700});
  const temp=join(dir,`${fingerprint}.${process.pid}.tmp`);
  writeFileSync(temp,JSON.stringify({bindingId:c.id,text,at:Date.now(),eventId:`hook:${fingerprint}`}),{mode:0o600});
  renameSync(temp,join(dir,`${fingerprint}.json`));
}
export function drainHooks(store:Store) {
  const dir=join(stateDir,'spool');let files:string[];try{files=readdirSync(dir);}catch{return;}
  for(const f of files.filter(f=>f.endsWith('.json')).slice(0,100)) {
    const path=join(dir,f);
    try {
      const d=JSON.parse(readFileSync(path,'utf8')),b=store.binding(d.bindingId);
      // A final explicitly sent by this agent suppresses the immediately following Stop
      // notification. Never synthesise a completion message or read transcript files.
      const sentAt=Number(store.get(`explicit-final:${b?.id}`)??0);
      if(b?.enabled&&typeof d.text==='string'&&!(sentAt&&d.at>=sentAt&&d.at-sentAt<120000))store.output(b,d.text,d.eventId);
      unlinkSync(path);
    } catch {store.audit('invalid-hook-spool',undefined,f);}
  }
}
