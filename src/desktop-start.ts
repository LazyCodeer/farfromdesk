import { CoordinatorRegistry } from './coordinator-registry.js';
import { randomUUID } from 'node:crypto';
import { constants,openSync,closeSync,fstatSync,readFileSync,writeFileSync,realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Store,Binding } from './store.js';
import { sameProject, type Session } from './session-catalog.js';
import type { NativeAgents } from './native.js';
import { openClaudeNewSession } from './session-activation.js';

type Start={supportDir?:string;stage?:string;requireDetached?:boolean;accountScope?:string;createdId?:string;detachSubmitted?:boolean;proposalId?:string;bindingId:string;parentId:string;cwd:string;nonce:string;status:'prepared'|'submitted'|'uncertain'|'ready'|'needs_action';nativeId?:string};
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
  const ready=join(op.supportDir??op.cwd,'.tether-desktop-ready.json'),receipt=join(op.supportDir??op.cwd,'.tether-desktop-created.json');
  const args={title:title.slice(0,59),context:'fresh',target:'local',cwd:op.cwd,use_worktree:false,
    prompt:`Initialize this owner-requested FarFromDesk session. Respect existing project instructions. ${instructions}\nAfter you have started, use get_session to identify your own exact native session ID, then write ${JSON.stringify({nonce:op.nonce,ready:true,sessionId:'YOUR_EXACT_NATIVE_SESSION_ID'})} to ${JSON.stringify(ready)} using your normal file tool. Do not execute the user's project task yet. End your turn and wait for its separately correlated WhatsApp request.`,
    background:'The owner explicitly requested a separate Claude Desktop session through their local FarFromDesk application. This is initialization only, inside the workspace selected by the owner. This selection does not grant new folder permissions. Preserve native permissions and any folder-access prompts. Keep existing conversations intact. Do not use standalone Claude CLI, copy credentials, alter permission settings, or contact other sessions. The bridge verifies the returned identity and a separate startup acknowledgment before connecting this session.'};
  return `This is an owner-authorized creation request relayed through FarFromDesk, not locally typed user input. Preserve its provenance and your native rules. Choose initiation only as permitted by your native tool; if this turn cannot start a session, report the required owner action instead.\nCall mcp__ccd_session__start_session once with these arguments:\n${JSON.stringify(args)}\nUse the exact session_id returned by that tool, never a task_id, name, placeholder, or your own ID. Immediately write ${JSON.stringify({nonce:op.nonce,sessionId:'EXACT_RETURNED_SESSION_ID',detached:false})} to ${JSON.stringify(receipt)} before any further step. Then use mcp__ccd_session_mgmt__detach_session on that exact child and verify detached=true and the project folder using get_session. Only after verification update the same receipt with detached:true. Do not restart the child task; initialization only, then wait. Do not repeat creation if the call is uncertain. If it returns a proposal card, write ${JSON.stringify({nonce:op.nonce,proposalId:'EXACT_RETURNED_TASK_ID',needsOwnerAction:true})} to ${JSON.stringify(receipt)} and wait for the owner; do not start or recreate that proposal yourself. If the tool is unavailable or requires folder approval, write ${JSON.stringify({nonce:op.nonce,error:'Explain the actual native blocker briefly here'})} there instead. Do not change permission modes or bypass a refusal. A successful start is not proof of the child's acknowledgment. No other work is requested. Operation ${op.bindingId}.`;
}
export class DesktopStarts {
  private stopped=false;
  constructor(private store:Store,private native:NativeAgents,private timeoutMs=90000,private openNew=openClaudeNewSession) {}
  get(id:string):Start|null{return JSON.parse(this.store.get(`desktop-start:${id}`)??'null');}
  save(op:Start){this.store.set(`desktop-start:${op.bindingId}`,JSON.stringify(op));}
  acknowledgment(b:Binding):string|null {
    const op=this.get(b.id);
    if(!op||op.status==='ready'||this.stopped||this.store.get(`desktop-abandoned:${b.id}`)==='true')return null;
    if(realpathSync(op.cwd)!==op.cwd||b.cwd!==op.cwd)throw new Error('Desktop project path changed.');
    if(op.supportDir&&realpathSync(op.supportDir)!==op.supportDir)throw new Error('Desktop setup directory changed.');
    const ready=readStartReceipt(join(op.supportDir??op.cwd,'.tether-desktop-ready.json'));
    const created=readStartReceipt(join(op.supportDir??op.cwd,'.tether-desktop-created.json'))??(op.parentId?null:ready);
    if(!created||!ready||ready.ready!==true)return null;
    if(created.nonce!==op.nonce||ready.nonce!==op.nonce)throw new Error('Desktop startup acknowledgment belongs to a different operation.');
    const id=created.sessionId??ready.sessionId;
    if(typeof id!=='string'||!/^(?:local_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)||id===op.parentId)return null;
    return JSON.stringify([created,ready]);
  }
  private connectedCandidates(sessions:Session[]) {
    const bindings=[...new CoordinatorRegistry(this.store).entries().map(r=>this.store.binding(r.bindingId)),...JSON.parse(this.store.get('selected')??'[]').map((key:string)=>this.store.binding(key))].filter(Boolean);
    return sessions.filter(s=>s.executionMode==='desktop'&&s.available===true&&bindings.some((b:any)=>b.enabled&&b.provider==='claude'&&b.native_id===s.id&&sameProject(b.cwd,s.cwd)&&this.store.get(`execution-mode:${b.id}`)==='desktop'));
  }
  private async catalog() {
    const sessions:Session[]=[];let cursor:string|undefined;const seen=new Set<string>();
    do {
      const page=await this.native.catalog('claude',cursor,{fresh:true});sessions.push(...page.sessions);cursor=page.cursor??undefined;
      if(cursor){if(seen.has(cursor))throw new Error('Desktop catalog pagination repeated. Reopen the workspace picker.');seen.add(cursor);}
    }while(cursor);
    return {sessions};
  }
  // A fresh Claude scan takes seconds (~3.7s warm for ~2350 records), so a caller
  // holding a scan from this same step passes it instead of rescanning.
  async parent(id:unknown,accountScope?:string,sessions?:Session[]) {
    const c=sessions?{sessions}:await this.catalog();
    if(id===undefined||id===null||id==='') {
      const candidates=this.connectedCandidates(c.sessions);
      const scopes=new Set(candidates.map(s=>s.accountScope??'unknown'));
      if(!candidates.length)throw new Error('No owner-connected Claude Desktop launcher is available. Connect one Desktop chat once, or choose Claude CLI. This Claude command cannot start a new Desktop chat with a prompt on its own.');
      if(scopes.size>1)throw new Error('Connected Claude Desktop chats belong to different accounts. Select the launcher account before creating a new chat.');
      id=candidates.sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0)||a.id.localeCompare(b.id))[0].id;
    }
    const s=c.sessions.find((s:any)=>s.id===id&&s.executionMode==='desktop'&&s.available===true);
    if(!s)throw new Error('The selected Claude Desktop session has no reachable inbox. Open it in Claude and check its Peer address in /status.');
    if(accountScope&&s.accountScope!==accountScope)throw new Error('Claude Desktop launcher account changed. Select the original account before recovery.');
    return s.activation==='desktop-open'?await this.native.activation.ready(s):s;
  }
  async create(b:Binding,parentId:string,title:string,instructions:string) {
    if(this.get(b.id))throw new Error('Desktop creation already has a receipt. Recover it; do not create again.');
    const route=JSON.parse(this.store.get(`session-route:${b.id}`)??'null');
    const launcher=await this.parent(parentId,route?.accountScope);parentId=launcher.id;
    if(realpathSync(b.cwd)!==b.cwd)throw new Error('Desktop project path changed.');
    const op:Start={supportDir:this.store.get(`master-support:${b.id}`),stage:'Sending creation request to Claude',bindingId:b.id,parentId,cwd:b.cwd,nonce:randomUUID(),status:'prepared',requireDetached:true,accountScope:launcher.accountScope};
    this.save(op);
    const file=join(op.supportDir??b.cwd,'.tether-desktop-start.txt');
    writeFileSync(file,desktopStartPrompt(op,title,instructions),{mode:0o600,flag:'wx'});
    // Save before sending: after a crash, never blindly send a second creation instruction.
    this.save({...op,status:'uncertain'});
    try{await this.native.sendDesktopCreation(parentId,file);}catch{throw new Error('Desktop creation submission is unconfirmed. Recover this exact setup before retrying.');}
    this.save({...op,status:'submitted',stage:'Waiting for Claude to start the session'});
    return this.confirm(b);
  }
  // Starts a top-level session in the coordinator's own folder without a launcher chat.
  async createDirect(b:Binding,instructions:string) {
    if(this.get(b.id))throw new Error('Desktop creation already has a receipt. Recover it; do not create again.');
    if(realpathSync(b.cwd)!==b.cwd)throw new Error('Desktop project path changed.');
    const op:Start={supportDir:this.store.get(`master-support:${b.id}`),stage:'Opening Claude',bindingId:b.id,parentId:'',cwd:b.cwd,nonce:randomUUID(),status:'uncertain',requireDetached:false};
    const ready=join(op.supportDir??b.cwd,'.tether-desktop-ready.json');
    const prompt=`Set up this folder as my FarFromDesk coordinator. ${instructions}\nNow use get_session to find your own exact session ID and write ${JSON.stringify({nonce:op.nonce,ready:true,sessionId:'YOUR_EXACT_SESSION_ID'})} to ${JSON.stringify(ready)}. Then reply READY and wait for my WhatsApp requests.`;
    // Save before opening: after a crash, never open a second new-session page blindly.
    this.save(op);
    try{await this.openNew(b.cwd,prompt);}catch{throw new Error('Claude Desktop did not open. Open Claude, then recover this setup.');}
    this.save({...op,status:'needs_action',stage:'Press Send in Claude to start your coordinator'});
    // The owner's Send arrives later; the setup poll picks up the session's ready receipt.
    throw new Error('Desktop start needs owner action: confirm the folder and press Send in the new Claude chat that just opened. FarFromDesk connects it automatically.');
  }
  async confirm(b:Binding,recover=false) {
    const op=this.get(b.id);if(!op)throw new Error('No desktop creation receipt exists.');
    const until=Date.now()+this.timeoutMs;
    do {
      if(this.stopped||this.store.get(`desktop-abandoned:${b.id}`)==='true')throw new Error('Desktop setup paused. Recover the exact operation after restart.');
      if(realpathSync(op.cwd)!==op.cwd||b.cwd!==op.cwd)throw new Error('Desktop project path changed.');
      if(op.supportDir&&realpathSync(op.supportDir)!==op.supportDir)throw new Error('Desktop setup directory changed.');
      // A direct start (no launcher chat) has no creation receipt; the session's own ready receipt names it.
      const created=readStartReceipt(join(op.supportDir??op.cwd,'.tether-desktop-created.json'))??(op.parentId?null:readStartReceipt(join(op.supportDir??op.cwd,'.tether-desktop-ready.json')));
      if(created) {
        if(created.nonce!==op.nonce)throw new Error('Desktop setup receipt belongs to a different operation.');
        const ready=readStartReceipt(join(op.supportDir??op.cwd,'.tether-desktop-ready.json'));
        if(ready&&ready.nonce!==op.nonce)throw new Error('Desktop startup acknowledgment belongs to a different operation.');
        if(created.proposalId) {
          if(typeof created.proposalId!=='string'||!/^task_[a-zA-Z0-9_-]{1,80}$/.test(created.proposalId)||(op.proposalId&&op.proposalId!==created.proposalId))throw new Error('Desktop proposal identity is invalid or changed.');
          op.proposalId=created.proposalId;
          if(!created.sessionId&&ready?.ready===true&&typeof ready.sessionId==='string')created.sessionId=ready.sessionId;
          if(!created.sessionId){this.save({...op,status:'needs_action',stage:'Waiting for your action in Claude'});throw new Error(`Desktop start needs owner action: start the existing proposal ${op.proposalId} in the selected Claude coordinator, then recover this setup. No child has been confirmed.`);}
        }
        if(created.error&&!created.sessionId) {
          const reason=typeof created.error==='string'?created.error:'';
          if(/user_asked|outside this project|another session.s message/i.test(reason))throw new Error('Claude Desktop could not start this session: its native rules require a direct owner request for this start. Choose the same workspace as an open Claude chat, or start the session in Claude and connect it here. No child was created.');
          throw new Error('Claude Desktop could not start this session. Check its native start_session result or folder-access prompt.');
        }
        if(typeof created.sessionId!=='string'||!/^(?:local_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(created.sessionId)||created.sessionId===op.parentId)throw new Error('Desktop setup did not return a new exact session identity.');

        if(op.createdId&&op.createdId!==created.sessionId)throw new Error('Desktop child identity changed during recovery.');
        op.createdId=created.sessionId;op.stage=ready?.ready===true?'Verifying session identity and detachment':'Session created; waiting for startup acknowledgment';this.save(op);
        if(ready?.ready===true) {
          const catalog=await this.catalog();
          const match=catalog.sessions.find((s:any)=>s.executionMode==='desktop'&&(s.desktopId===created.sessionId||s.id===created.sessionId));
          if(match&&typeof ready.sessionId==='string'&&ready.sessionId!==match.id&&ready.sessionId!==match.desktopId)throw new Error('Desktop startup acknowledgment names a different session.');
          if(op.requireDetached&&match?.detached!==true) {
            if(recover&&match&&!op.detachSubmitted) {
              // Recover only the confirmed child; record before sending to avoid duplicate actions.
              const file=join(op.supportDir??op.cwd,'.tether-desktop-detach.txt');
              writeFileSync(file,`Owner-authorized recovery of an existing FarFromDesk child. Preserve native permissions. Do not create any session or start/restart a task. Inspect exact child ${JSON.stringify(created.sessionId)} with get_session, confirm cwd ${JSON.stringify(op.cwd)}, and only if still attached use mcp__ccd_session_mgmt__detach_session on that exact ID. Verify detached=true. Operation ${op.bindingId}. If not allowed, report the native blocker.`,{mode:0o600,flag:'wx'});
              op.detachSubmitted=true;this.save(op);
              await this.native.sendDesktopCreation(op.parentId,file);
            }
            if(Date.now()<until)await new Promise(r=>setTimeout(r,1000));
            continue;
          }
          if(!match)throw new Error('Desktop session ID has not appeared in the native catalog. Recover this same setup.');
          const s=await this.parent(match.id,op.accountScope,catalog.sessions);
          if(s.id===op.parentId||(op.nativeId&&op.nativeId!==s.id))throw new Error('Desktop setup identity changed or points to its parent.');
          if(realpathSync(s.cwd)!==op.cwd)throw new Error('Created Claude Desktop session has a different project folder.');
          const collision=this.store.bindings().find(x=>x.provider==='claude'&&x.native_id===s.id&&x.id!==b.id);
          if(collision)throw new Error('Created desktop identity is already bound to another session.');
          this.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(s.id,b.id);
          // A direct start has no launcher account; record the verified session's own account so replacement matches exactly.
          if(!op.parentId&&s.accountScope){const route=JSON.parse(this.store.get(`session-route:${b.id}`)??'null');if(route&&!route.accountScope)this.store.set(`session-route:${b.id}`,JSON.stringify({...route,accountScope:s.accountScope}));op.accountScope=s.accountScope;}
          this.save({...op,nativeId:s.id,status:'ready'});return;
        }
      }
      if(Date.now()<until)await new Promise(r=>setTimeout(r,1000));
    }while(Date.now()<until);
    this.save({...op,status:'uncertain'});
    throw new Error((op.requireDetached&&op.createdId?'Desktop child exists; detachment or startup acknowledgment is not verified. ':'')+'Desktop start has no verified child acknowledgment yet. Recover this setup; do not create another. Check the selected desktop session for a held message or folder prompt.');
  }
  close(){this.stopped=true;}
}
