import { randomUUID } from 'node:crypto';
import { constants,openSync,closeSync,fstatSync,readFileSync,writeFileSync,realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Store,Binding } from './store.js';
import type { NativeAgents } from './native.js';

type Start={bindingId:string;parentId:string;cwd:string;nonce:string;status:'prepared'|'submitted'|'uncertain'|'ready';nativeId?:string};
export function readStartReceipt(path:string):any {
  let fd:number;
  try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(e:any){if(e.code==='ENOENT')return null;throw new Error('Desktop setup receipt is not a regular local file.');}
  try {
    const st=fstatSync(fd);
    if(!st.isFile()||st.uid!==process.getuid?.()||st.size>4096||st.nlink!==1)throw new Error('Desktop setup receipt is invalid.');
    return JSON.parse(readFileSync(fd,'utf8'));
  }finally{closeSync(fd);}
}
export function desktopStartPrompt(op:Start,title:string,instructions:string) {
  const ready=join(op.cwd,'.tether-desktop-ready.json'),receipt=join(op.cwd,'.tether-desktop-created.json');
  const args={initiation:'user_asked',title:title.slice(0,59),context:'fresh',target:'local',cwd:op.cwd,use_worktree:false,
    prompt:`Initialize this owner-requested Sidekick session. Read CLAUDE.md in this project. ${instructions}\nAfter you have started, write exactly ${JSON.stringify({nonce:op.nonce,ready:true})} to ${JSON.stringify(ready)} using your normal file tool. Do not execute the user's project task yet. End your turn and wait for its separately correlated WhatsApp request.`,
    background:'The owner explicitly requested a separate Claude Desktop session through their local Sidekick application. This is initialization only, inside a newly created empty project folder approved for this purpose. Preserve native permissions and any folder-access prompts. Keep existing conversations intact. Do not use standalone Claude CLI, copy credentials, alter permission settings, or contact other sessions. The bridge verifies the returned identity and a separate startup acknowledgment before connecting this session.'};
  return `The owner selected this exact Claude Desktop session to create a new desktop session. Use normal native permissions.\nCall mcp__ccd_session__start_session once with these arguments:\n${JSON.stringify(args)}\nUse the exact session_id returned by that tool, never a task_id, name, placeholder, or your own ID. Write ${JSON.stringify({nonce:op.nonce,sessionId:'EXACT_RETURNED_SESSION_ID'})} to ${JSON.stringify(receipt)}. Do not repeat creation if the call is uncertain. If it returns a proposal card, is unavailable, or requires folder approval, write ${JSON.stringify({nonce:op.nonce,error:'Explain the actual native blocker briefly here'})} there instead. Do not change permission modes or bypass a refusal. A successful start is not proof of the child's acknowledgment. No other work is requested. Operation ${op.bindingId}.`;
}
export class DesktopStarts {
  private stopped=false;
  constructor(private store:Store,private native:NativeAgents,private timeoutMs=90000) {}
  get(id:string):Start|null{return JSON.parse(this.store.get(`desktop-start:${id}`)??'null');}
  save(op:Start){this.store.set(`desktop-start:${op.bindingId}`,JSON.stringify(op));}
  async parent(id:unknown) {
    if(typeof id!=='string'||!id)throw new Error('Choose an existing Claude Desktop session to start new sessions. No CLI fallback is used.');
    const c=await this.native.catalog('claude'),s=c.sessions.find((s:any)=>s.id===id&&s.executionMode==='desktop'&&s.available===true);
    if(!s)throw new Error('The selected Claude Desktop session has no reachable inbox. Open it in Claude and check its Peer address in /status.');
    return s;
  }
  async create(b:Binding,parentId:string,title:string,instructions:string) {
    if(this.get(b.id))throw new Error('Desktop creation already has a receipt. Recover it; do not create again.');
    await this.parent(parentId);
    if(realpathSync(b.cwd)!==b.cwd)throw new Error('Desktop project path changed.');
    const op:Start={bindingId:b.id,parentId,cwd:b.cwd,nonce:randomUUID(),status:'prepared'};
    this.save(op);
    const file=join(b.cwd,'.tether-desktop-start.txt');
    writeFileSync(file,desktopStartPrompt(op,title,instructions),{mode:0o600,flag:'wx'});
    // Save before sending: after a crash, never blindly send a second creation instruction.
    this.save({...op,status:'uncertain'});
    try{await this.native.sendDesktopCreation(parentId,file);}catch{throw new Error('Desktop creation submission is unconfirmed. Recover this exact setup before retrying.');}
    this.save({...op,status:'submitted'});
    return this.confirm(b);
  }
  async confirm(b:Binding) {
    const op=this.get(b.id);if(!op)throw new Error('No desktop creation receipt exists.');
    const until=Date.now()+this.timeoutMs;
    do {
      if(this.stopped||this.store.get(`desktop-abandoned:${b.id}`)==='true')throw new Error('Desktop setup paused. Recover the exact operation after restart.');
      if(realpathSync(op.cwd)!==op.cwd||b.cwd!==op.cwd)throw new Error('Desktop project path changed.');
      const created=readStartReceipt(join(op.cwd,'.tether-desktop-created.json'));
      if(created) {
        if(created.nonce!==op.nonce)throw new Error('Desktop setup receipt belongs to a different operation.');
        if(created.error)throw new Error('Claude Desktop could not start this session. Check its native start_session result or folder-access prompt.');
        if(typeof created.sessionId!=='string'||!/^(?:local_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(created.sessionId)||created.sessionId===op.parentId)throw new Error('Desktop setup did not return a new exact session identity.');

        const ready=readStartReceipt(join(op.cwd,'.tether-desktop-ready.json'));
        if(ready&&ready.nonce!==op.nonce)throw new Error('Desktop startup acknowledgment belongs to a different operation.');
        if(ready?.ready===true) {
          const catalog=await this.native.catalog('claude');
          const match=catalog.sessions.find((s:any)=>s.desktopId===created.sessionId||s.id===created.sessionId);
          if(!match)throw new Error('Desktop session ID has not appeared in the native catalog. Recover this same setup.');
          const s=await this.parent(match.id);
          if(s.id===op.parentId||(op.nativeId&&op.nativeId!==s.id))throw new Error('Desktop setup identity changed or points to its parent.');
          if(realpathSync(s.cwd)!==op.cwd)throw new Error('Created Claude Desktop session has a different project folder.');
          const collision=this.store.bindings().find(x=>x.provider==='claude'&&x.native_id===s.id&&x.id!==b.id);
          if(collision)throw new Error('Created desktop identity is already bound to another session.');
          this.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(s.id,b.id);
          this.save({...op,nativeId:s.id,status:'ready'});return;
        }
      }
      if(Date.now()<until)await new Promise(r=>setTimeout(r,1000));
    }while(Date.now()<until);
    this.save({...op,status:'uncertain'});
    throw new Error('Desktop start has no verified child acknowledgment yet. Recover this setup; do not create another. Check the selected desktop session for a held message or folder prompt.');
  }
  close(){this.stopped=true;}
}
