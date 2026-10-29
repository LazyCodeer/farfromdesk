import { DesktopReadinessError } from './session-activation.js';
import { ownerCommand, routeOwnerTarget, clearOwnerTarget, authenticatedOwner, ownerAttachmentTarget, isOwnerCommand, pickOwnerTarget, ownerTurnLabel } from './owner-commands.js';
import { selectOption, previewOption, parseMessageOptions } from './message-options.js';
import { MetaBrain } from './meta-brain.js';
import { Schedules,scheduleJobState,scheduleRootState,hasScheduleGuard,failScheduledBeforeSubmission } from './schedules.js';
import { TaskContracts } from './task-contracts.js';
import { queueOwnerReceipt } from './coordinator-experience.js';
import { hash, Store, type Binding } from './store.js';
import type { NativeAgents } from './native.js';
import type { Approvals } from './approvals.js';
import type { Coordinator } from './coordinator.js';
import { Attachments, type IncomingFile } from './attachments.js';
import { updateRole, turnEnvelope } from './roles.js';
import { errorCode, type ReplyContext, type RequestOutcome } from './request-events.js';
import { OwnerReplyPolicy,replyFindings } from './owner-reply-policy.js';
import { namedItem, directSession, startDirect, endDirect, backToProxy } from './owner-routing.js';
import type { MorningBrief } from './morning-brief.js';
import { DispatchNotSubmittedError,BriefDispatchError,briefDestinationValid,briefDispatchGuard,briefDispatchValid,recordBriefDispatch } from './brief-dispatch-guard.js';

/** A scheduled request was held before any native submission. */
class ScheduledChannelHold extends DispatchNotSubmittedError {}

export type RouteResult={status:'queued'|'handled'|'ignored'|'blocked';requestId:string;code?:string};
export type Incoming = {id:string;text:string;quotedId?:string;optionToken?:string;source?:'text'|'voice';ownerCommand?:boolean;ownerIntent?:boolean;ownerChoice?:boolean};
export const help = `Just tell me what you need.

• Show my recent sessions.
• Find the website session.
• Use Checkout fix and tell me its progress.
• Claude, create a session for this task.

Reply to a permission message with “Yes, allow it” or “No, deny it”. Reply to a session’s message to continue in that session. You don’t need commands or session IDs.`;
export class Router {
  coordinator?:Coordinator;
  brain:MetaBrain;
  schedules:Schedules;
  scheduledBrief?:(destination:string,expectedOwner:string,occurrenceId:string,canSend?:()=>boolean)=>Promise<'queued'|'already-queued'|'retry'|'invalid'>;
  contracts:TaskContracts;
  hasPendingCreation?:(requestId:string)=>boolean;
  workspaceCommand?:(args:string)=>string;
  remoteControl?:(text:string)=>Promise<string|undefined>;
  morningBrief?:MorningBrief;
  busy=new Set<string>();
  channelClients=new Map<string,{id:string;seen:number}>();
  stopped=false;
  // How long a session gets to answer before an uncertain hand-off is reported to the owner.
  uncertainNoticeMs=120_000;
  attachments:Attachments;
  private ownerReplyPolicy:OwnerReplyPolicy;
  constructor(public store:Store,public native:NativeAgents,public approvals:Approvals) {this.brain=new MetaBrain(store);this.schedules=new Schedules(store,this.brain.secret);this.contracts=new TaskContracts(store,this.brain.secret);this.attachments=new Attachments(store);this.ownerReplyPolicy=new OwnerReplyPolicy(store);native.beforeDispatch=(b,id)=>this.assertDispatchAllowed(id,b);}
  attachmentTarget(m:Incoming) {
    let text=m.text.trim(),b:Binding|undefined;
    if(text.startsWith('/')) {
      const match=/^\/to\s+(\S+)(?:\s+([\s\S]*))?$/i.exec(text);
      if(!match)throw new Error('Attachment captions cannot run bridge commands. Use /to NAME caption or quote a session reply.');
      b=this.need(match[1]);text=match[2]?.trim()??'';
    } else if(m.quotedId) {
      b=this.store.quotedBinding(m.quotedId);if(!b)throw new Error('That quoted message does not identify a registered session. Use /to NAME caption.');
      this.checkQuotedPlatform(text,b);
    } else b=ownerAttachmentTarget(this,m)??(this.coordinator?this.coordinator.destination(text):this.store.binding(this.store.get('active')??''));
    if(this.schedules.isScheduleLike(text))throw new Error('Send schedules as a new text message in your own chat. Attachments cannot schedule or immediately send future actions.');
    if(!b)throw new Error('Choose an exact session before sending an attachment.');
    this.need(b.id);
    if(text.length>32000)throw new Error('Attachment caption exceeds 32,000 characters.');
    return {binding:b,text:text||'The owner sent an attachment without a caption. Acknowledge receipt and ask what they want done with it; do not execute it.',
      identity:JSON.stringify([b.id,b.native_id,b.cwd,b.token_hash,this.store.get('master'),this.store.get('active'),this.store.get('selected'),this.store.ownerFor(this.store.destination()),this.store.controlChannel(),this.store.get(`owner-target:${this.store.destination()}`)])};
  }
  receiveAttachment(m:Incoming,file:IncomingFile,target:ReturnType<Router['attachmentTarget']>) {
    if(this.stopped||this.store.seen(m.id))return;
    // Attachment captions use a separate synchronous path; do not let them bypass task review.
    if(this.contracts.enabled()&&m.text.trim())throw new Error('Send the task as a text or voice message first. Attachment task review is not available yet. Nothing was sent.');
    if(this.attachmentTarget(m).identity!==target.identity)throw new Error('The intended session changed during download. Please resend to the intended session.');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      if(this.store.job(m.id))throw new Error('This attachment request already exists. Check its status before resending.');
      this.queue(m.id,this.need(target.binding.id),target.text);
      this.attachments.stage(target.binding,m.id,file);this.store.remember(m.id);
      this.store.db.prepare("UPDATE media_inbox SET status='processed' WHERE id=?").run(m.id);
      this.store.db.exec('COMMIT');
    }catch(e){this.store.db.exec('ROLLBACK');this.attachments.cleanupOrphans();throw e;}
    this.pump();
  }
  private receiving=new Set<string>();
  hasPendingIngress(){return this.receiving.size>0;}
  async receive(m:Incoming):Promise<RouteResult> {
    if(!this.store.incomingOwnerContext.getStore()&&authenticatedOwner(this,m)){
      const destination=this.store.destination(),captured=destination&&this.store.captureIncomingOwner(destination,this.store.controlChannel());
      if(captured)return this.store.incomingOwnerContext.run(captured,()=>this.receive(m));
    }
    if(!this.store.incomingOwnerCurrent())return {status:'blocked',requestId:m.id,code:'routing_unavailable'};
    if(this.receiving.has(m.id))return {status:'ignored',requestId:m.id};
    this.receiving.add(m.id);
    try{
      // History is best effort: a failure to label or record it must not fail a turn that already ran, or Telegram re-polls it.
      const failed=(e:unknown)=>{try{this.store.event(m.id,'owner_history_failed',{code:errorCode(e)});}catch{}};
      let label:string|undefined;try{label=ownerTurnLabel(this,m);}catch(e){failed(e);}
      const result=await this.receiveOnce(m);
      try{if(this.store.incomingOwnerCurrent()&&label&&result.status!=='ignored'&&!this.store.job(m.id))this.store.recordOwnerCommand(m.id,label,result.status);}catch(e){failed(e);}
      return result;
    }finally{this.receiving.delete(m.id);}
  }
  private async receiveOnce(m:Incoming,contractApproved=false):Promise<RouteResult> {
    if(this.stopped||!this.store.incomingOwnerCurrent())return {status:'blocked',requestId:m.id,code:'routing_unavailable'};
    if(this.store.seen(m.id))return {status:'ignored',requestId:m.id};
    if((m.ownerCommand||m.ownerIntent)&&!authenticatedOwner(this,m))return {status:'blocked',requestId:m.id};
    if(this.store.controlChannel()==='whatsapp'&&authenticatedOwner(this,m)){
      const destination=this.store.destination(),owner=this.store.ownerFor(destination);
      try{if(destination&&owner)this.store.recordOwnerOrigin(m.id,destination,owner);}catch{return {status:'blocked',requestId:m.id,code:'routing_unavailable'};}
    }
    let text=m.text.trim();if(!text)return {status:'ignored',requestId:m.id};
    this.morningBrief?.firstMessage(m);
    // Natural-language controls may be spoken; slash commands must be typed.
    const ownerIntent=m.ownerIntent??(m.ownerCommand!==false);
    // Screen-control links and the phone's answer code are handled before any routing.
    if(this.remoteControl&&!m.quotedId&&ownerIntent&&(!text.startsWith('/')||m.ownerCommand!==false)){const reply=await this.remoteControl(text).catch(()=>'Screen control could not start. Check FarFromDesk on your Mac.');if(!this.store.incomingOwnerCurrent())return {status:'blocked',requestId:m.id,code:'routing_unavailable'};if(reply){this.store.output(undefined,reply,`command:${m.id}`,undefined,{plain:true});this.store.remember(m.id);return {status:'handled',requestId:m.id};}}
    // Exact typed decisions are resolved before ordinary model routing.
    let ownerReply=false;
    try {
      if(!contractApproved){const recovered=this.contracts.recoverApproved(this,m);if(recovered)return await this.receiveOnce(recovered,true);}
      // Replies to owner commands and session picks, errors included, go out without the session header and footer.
      ownerReply=true;const targetReply=pickOwnerTarget(this,m);ownerReply=false;
      if(targetReply!==undefined){this.store.output(undefined,targetReply,`command:${m.id}`,undefined,{plain:true});this.store.remember(m.id);return {status:'handled',requestId:m.id};}
      if(m.quotedId&&(m.optionToken||m.source!=='voice'&&/^\d+$/.test(text))){
        const input={responseId:m.id,destination:this.store.destination()??'',messageId:m.quotedId,token:m.optionToken,number:Number(text)};
        const preview=previewOption(this.store,input);
        if(preview){
          const guarded=this.contracts.hasGuard(preview.row.request_id);
          const reviewBody=guarded?this.contracts.choiceReview(this,preview.row.request_id,preview.body):preview.body;
          if(preview.row.selected_id){if(contractApproved)throw new Error('These choices were already answered. Nothing was sent.');selectOption(this.store,input,()=>{throw new Error('Choice was already answered.');});return {status:'handled',requestId:m.id};}
          if(!contractApproved&&(this.contracts.enabled()||guarded)){
            // Token callbacks and polls have already been authenticated by their channel adapter.
            // Typed choices must be direct owner replies, never forwarded data.
            if(!m.optionToken&&(!authenticatedOwner(this,m)||m.ownerChoice!==true))throw new Error('Choose with your own direct reply. Nothing was sent.');
            if(!this.contracts.enabled())throw new Error('Send your answer as a new message so it can be reviewed. Nothing was sent.');
            const contract=await this.contracts.preflight(this,m,reviewBody,undefined,undefined,true,true);
            if(contract.kind==='handled')return {status:'handled',requestId:m.id};
            if(contract.kind==='replay')return await this.receiveOnce(contract.incoming,true);
          }
          const selected=selectOption(this.store,input,(bindingId,body)=>{if(bindingId!==preview.row.binding_id||body!==preview.body)throw new Error('These choices changed. Nothing was sent.');const b=this.need(bindingId);if(guarded&&!contractApproved){const item=this.store.itemOf(preview.row.request_id);const guardedBody=this.contracts.bindChild(this,preview.row.request_id,m.id,b,body,item);this.store.enqueue(m.id,b,guardedBody);}else this.queue(m.id,b,contractApproved?reviewBody:body);this.contracts.bindChoice(this,preview.row.request_id,m.id,preview.row.id);});
          if(selected){this.pump();return {status:this.store.job(m.id)?'queued':'handled',requestId:m.id};}
        }
      }
      const answer=this.approvals.naturalReply(text,m.quotedId,m.source??'text');
      if(answer){this.store.output(answer.binding,answer.message,`decision:${m.id}`);this.store.remember(m.id);return {status:'handled',requestId:m.id};}
      const briefAction=this.morningBrief?.action(m);
      if(briefAction?.reply){this.store.output(undefined,briefAction.reply,`brief-action:${m.id}`,undefined,{plain:true});this.store.remember(m.id);return {status:'handled',requestId:m.id};}
      if(briefAction?.text&&briefAction.target&&briefAction.itemId){
        if(contractApproved)this.contracts.verifyBrief(this,m.id,briefAction.itemId,briefAction.target,briefAction.text);
        if(!contractApproved&&this.contracts.shouldHandle(this,m)){
          const contract=await this.contracts.preflight(this,m,briefAction.text,undefined,this.contracts.briefIntent(this,briefAction.itemId,briefAction.target,briefAction.text));
          if(contract.kind==='handled')return {status:'handled',requestId:m.id};
          if(contract.kind==='replay')return await this.receiveOnce(contract.incoming,true);
        }
        this.store.db.exec('SAVEPOINT brief_action');
        try{
          this.store.linkItem(m.id,briefAction.itemId);if(this.store.itemOf(m.id)!==briefAction.itemId)throw new Error('This reply is already associated with a different item.');this.queue(m.id,this.need(briefAction.target),briefAction.text);recordBriefDispatch(this,this.store.job(m.id)!,briefAction.itemId,briefAction.target);if(briefAction.ack)this.store.output(undefined,briefAction.ack,`brief-action:${m.id}`,undefined,{plain:true});this.store.remember(m.id);this.store.db.exec('RELEASE brief_action');}
        catch(e){this.store.db.exec('ROLLBACK TO brief_action; RELEASE brief_action');throw e;}
        this.pump();return {status:'queued',requestId:m.id};
      }
      if(contractApproved&&this.contracts.approvedBrief(m.id))throw new Error('The approved brief item is unavailable. Nothing was sent.');
      if((m.quotedId||!ownerIntent)&&authenticatedOwner(this,m)&&this.schedules.isScheduleLike(text)){this.store.output(undefined,'Send schedules as a new message in your own chat. Nothing was scheduled or sent to a session.',`schedule-reply:${m.id}`,undefined,{plain:true});this.store.remember(m.id);return {status:'blocked',requestId:m.id};}
      if(this.schedules.shouldHandle(this,m,ownerIntent)&&await this.schedules.handle(this,m,ownerIntent,contractApproved))return {status:'handled',requestId:m.id};
      if(!contractApproved&&this.contracts.shouldHandle(this,m)){
        const contract=await this.contracts.preflight(this,m);
        if(contract.kind==='handled')return {status:'handled',requestId:m.id};
        if(contract.kind==='replay')return await this.receiveOnce(contract.incoming,true);
      }
      // A quoted native answer is data even when it starts with a slash.
      if(m.ownerCommand===false&&text.startsWith('/')){this.store.output(undefined,'Type commands as a new text message, not in a quote, forward, file or voice note.',`command:${m.id}`);this.store.remember(m.id);return {status:'blocked',requestId:m.id};}
      ownerReply=!!m.ownerCommand&&isOwnerCommand(text);const commandReply=ownerReply?await ownerCommand(this,m):undefined;ownerReply=false;
      if(commandReply!==undefined){this.store.output(undefined,commandReply,`command:${m.id}`,undefined,{plain:true});this.store.remember(m.id);return {status:'handled',requestId:m.id};}
      if(authenticatedOwner(this,m)&&ownerIntent&&!m.quotedId&&backToProxy.test(text)&&this.store.get(`owner-target:${this.store.destination()}`)&&this.store.get(`owner-target:${this.store.destination()}`)!=='null'){
        clearOwnerTarget(this);this.store.output(undefined,'Back to normal routing.',`command:${m.id}`,undefined,{plain:true});this.store.remember(m.id);return {status:'handled',requestId:m.id};
      }
      if(this.store.get(`owner-target:${this.store.destination()}`)&&this.store.get(`owner-target:${this.store.destination()}`)!=='null'&&!text.startsWith('/')&&await routeOwnerTarget(this,m)){this.store.remember(m.id);this.pump();return {status:this.brain.get(m.id)?.state==='blocked'?'blocked':this.store.job(m.id)?'queued':'handled',requestId:m.id};}
      const browsing=/^(?:\/sessions(?:\s+.*)?|sessions|list sessions|show (?:me )?(?:my )?(?:recent )?sessions|list (?:my |all |recent )?sessions|(?:check|show) more(?: sessions)?|more sessions|(?:go )?back(?: in)? (?:the )?history|older sessions|previous page|(?:find|search)(?: for)? sessions? .+)$/i.test(text);
      if(this.coordinator&&!m.quotedId&&ownerIntent&&browsing) {
        this.brain.clearChoice();
        queueOwnerReceipt(this.store,m.id,this.coordinator.master(),true);
        let search=text.replace(/^\/sessions\s*/i,'');
        const more=/^(?:(?:check|show) more(?: sessions)?|more sessions|(?:go )?back(?: in)? (?:the )?history|older sessions|\/sessions more)$/i.test(text);
        const back=/^(?:previous page|\/sessions back)$/i.test(text);
        if(!/^\/sessions\s+/i.test(text))search=/^(?:find|search)(?: for)? sessions? (.+)$/i.exec(text)?.[1]??'';
        this.store.output(undefined,await this.coordinator.list(search,more?'more':back?'back':0),`command:${m.id}`);this.store.remember(m.id);return {status:'handled',requestId:m.id};
      }
      const selection=/^(?:(?:\/select|select|choose|pick)\s+)?(\d+(?:(?:\s*,\s*|\s+and\s+|\s+)\d+)*)$/i.exec(text);
      if(this.coordinator&&!m.quotedId&&ownerIntent&&selection&&!this.brain.hasChoice()&&(this.store.get('selection-awaiting')==='true'||/^(?:\/select|select|choose|pick)\s/i.test(text))) {
        this.store.output(undefined,await this.coordinator.select(selection[1].replace(/\band\b/gi,',')),`command:${m.id}`);this.store.remember(m.id);return {status:'handled',requestId:m.id};
      }
      if(!m.quotedId&&ownerIntent&&backToProxy.test(text)&&endDirect(this.store)) {
        this.store.output(undefined,'↩️ *Back to your proxy*\nYour next messages go to the proxy again.',`command:${m.id}`);this.store.remember(m.id);return {status:'handled',requestId:m.id};
      }
      if(text.startsWith('/')) {
        const match=/^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text)!;
        const cmd=match[1].toLowerCase(),args=match[2]?.trim()??'';
        if(cmd==='help')this.store.output(undefined,help,`command:${m.id}`);
        else if(cmd==='workspace'){if(!this.workspaceCommand)throw new Error('Workspace creation is unavailable.');this.store.output(undefined,this.workspaceCommand(args),`command:${m.id}`);}
        else if(cmd==='sessions')this.store.output(undefined,this.store.bindings().map(b=>`${b.enabled?'●':'○'} ${b.alias} · ${b.provider} · ${b.mode}`).join('\n')||'No sessions registered. Open Session Bridge.app.',`command:${m.id}`);
        else if(cmd==='use') {const b=this.need(args);clearOwnerTarget(this);this.store.set('active',b.id);this.store.output(b,'Selected. Your next messages go to this exact session.',`command:${m.id}`);}
        else if(cmd==='talk')this.store.output(undefined,this.talkDirect(this.need(args)),`command:${m.id}`);
        else if(cmd==='to') {const [alias,...words]=args.split(/\s+/);if(!words.length)throw new Error('Use /to NAME message');this.queue(m.id,this.need(alias),words.join(' '));}
        else if(cmd==='status')this.store.output(undefined,`Active: ${this.store.binding(this.store.get('active')??'')?.alias??'none'}\nRunning: ${this.busy.size}\nWaiting permissions: ${this.approvals.pending.size}\n${this.store.jobs().slice(0,8).map(j=>`${j.id} · ${this.store.binding(j.binding_id)?.alias} · ${j.status}${j.error?` · ${j.error}`:''}`).join('\n')}`,`command:${m.id}`);
        else if(cmd==='style') {const [name,style,...extra]=args.split(/\s+/);if(extra.length||!style)throw new Error('Use /style NAME friendly|cheerful|professional|coding.');const b=this.need(name==='master'?this.store.get('master')??'':name);updateRole(this.store,b,style);this.store.output(b,`Reply style set to ${style}. It applies from the next work turn.`,`command:${m.id}`);}
        else if(cmd==='stop') {const b=this.need(args);this.native.stop(b);this.store.output(b,'Pending bridge approvals denied. Interrupt active work using the native app stop control. The bridge does not kill your session.',`command:${m.id}`);}
        else if(cmd==='pause'||cmd==='resume') {const b=this.store.binding(args);if(!b)throw new Error('Unknown session');this.store.enable(b.id,cmd==='resume');if(cmd==='pause'){this.native.stop(b);this.channelClients.delete(b.id);}this.store.output(undefined,`${b.alias}: ${cmd==='resume'?'enabled':'paused'}`,`command:${m.id}`);}
        else if(cmd==='approve'||cmd==='deny') {this.approvals.answer(args,cmd,'approval');this.store.output(undefined,'Decision delivered.',`command:${m.id}`);}
        else if(cmd==='answer') {const [code,...words]=args.split(/\s+/);if(!words.length)throw new Error('Use /answer CODE your answer');this.approvals.answer(code,words.join(' '),'question');this.store.output(undefined,'Answer delivered.',`command:${m.id}`);}
        else if(cmd==='retry') {throw new Error('Uncertain native submissions are never resent automatically. Check the exact native session and delivery receipt before deciding to send a new request.');}
        else throw new Error('Tell me what you need in ordinary words. For example: “Show my recent sessions”.');
      } else {
        let b:Binding|undefined;
        const named=!m.quotedId?namedItem(text,JSON.parse(this.store.get(`item-codes:${this.store.destination()}`)??this.store.get('item-codes')??'{}')):undefined,known=named&&this.coordinator&&this.store.db.prepare('SELECT 1 FROM items WHERE id=?').get(named.id)?named:undefined;
        if(m.quotedId) {
          b=this.store.quotedBinding(m.quotedId);
          if(!b)throw new Error('That reply does not identify a connected session. Tell me the session name and what you need.');
          this.checkQuotedPlatform(text,b);
          const item=this.store.itemOf(this.store.quotedRequest(m.quotedId));if(item)this.store.linkItem(m.id,item);
        } else if(known&&this.coordinator) {
          // A follow-up on a numbered item goes to the session that owns it; the proxy only routes items without one.
          const items=this.coordinator.items(),item=items.get(known.id),owner=item.binding_id?this.store.binding(item.binding_id):undefined;
          this.store.linkItem(m.id,item.id);
          // A replaced or paused owner is explained, never silently swapped for the current proxy.
          if(item.binding_id&&!owner?.enabled&&item.status!=='done'){const board=this.brain.memory.board().find(i=>i.id===item.id);throw new Error((board&&this.brain.memory.attention(board))??`#${item.id} ${item.title}: its session is paused or was removed, so I didn't send this. Say "start #${item.id} again" to send it to your current proxy.`);}
          if(owner?.enabled&&!this.coordinator.isCoordinator(owner.id)&&this.coordinator.enabled().includes(owner.provider)){b=owner;items.note(item.id,`Owner follow-up went straight to ${this.coordinator.name(owner).slice(0,60)}.`);}
          else {this.coordinator.routeToMaster(m.id,text);this.store.remember(m.id);this.pump();return {status:'queued',requestId:m.id};}
        } else if(this.coordinator&&(b=directSession(this.store,id=>this.coordinator!.isCoordinator(id)))) {
          const item=this.coordinator.items().list().find(i=>i.binding_id===b!.id);if(item)this.store.linkItem(m.id,item.id);
        } else if(this.coordinator){
          if(await this.brain.handle(this,m)) {
            this.store.remember(m.id);this.pump();
            const blocked=this.brain.get(m.id)?.state==='blocked';
            return {status:blocked?'blocked':this.store.job(m.id)?'queued':'handled',requestId:m.id,...(blocked?{code:'routing_unavailable'}:{})};
          }
          this.coordinator.routeToMaster(m.id,text);this.store.remember(m.id);this.pump();return {status:'queued',requestId:m.id};
        }
        else b=this.store.binding(this.store.get('active')??'');
        if(!b)throw new Error('Choose a proxy in the app, then ask me to show your recent sessions.');
        this.queue(m.id,this.need(b.id),text);
      }
      this.store.remember(m.id);
    } catch(e) {if(!this.store.incomingOwnerCurrent())return {status:'blocked',requestId:m.id,code:'routing_unavailable'};this.store.output(undefined,(e as Error).message,`command-error:${m.id}`,undefined,ownerReply?{plain:true}:{});this.store.remember(m.id);this.store.event(m.id,'routing_failed',{code:errorCode(e)});return {status:'blocked',requestId:m.id,code:errorCode(e)};}
    this.pump();return {status:this.store.job(m.id)?'queued':'handled',requestId:m.id};
  }
  /** Hands this chat to one session until the owner says back, switches, or goes quiet for two hours. */
  talkDirect(b:Binding,destination?:string|null) {
    if(!b.enabled)throw new Error('That session is paused. Resume it first.');
    if(this.coordinator?.isCoordinator(b.id))throw new Error('That is a proxy. Name the session you want to talk to.');
    clearOwnerTarget(this);startDirect(this.store,b,destination);
    const name=this.coordinator?.name(b)??b.alias;
    return `🔀 *Now talking to ${name.replace(/[*_~`]/g,'').slice(0,60)}*\n- Your messages go straight to this session, and it answers you itself. Its permissions do not change.\nYou: say *back* to return to your proxy. After two quiet hours it switches back on its own.`;
  }
  unfinishedChildren(id:string) {
    return !!this.store.db.prepare(`SELECT 1 FROM inbox i JOIN settings s ON s.key='parent:'||i.id
      WHERE s.value=? AND i.status NOT IN ('completed','reviewed','auto_closed','replaced') LIMIT 1`).get(id);
  }
  resolveOwner(id:string,outcome:RequestOutcome,acknowledgingReport?:string) {
    const job=this.store.job(id),master=this.coordinator?.requestMaster(id);
    if(this.coordinator?.scope.getStore()&&master?.id!==this.coordinator.scope.getStore())throw new Error('Request belongs to another coordinator.');
    const scheduleState=scheduleRootState(this,id);
    if(!job||!/^(wa|tg|local|master|schedule):/.test(id)||scheduleState==='invalid'||scheduleState==='hold'||id.startsWith('schedule:')&&scheduleState!=='ready'||job.binding_id!==master?.id||job.status==='replaced')throw new Error('An original request for the current master is required.');
    if(!['done','blocked','reviewed','cancelled'].includes(outcome))throw new Error('An explicit outcome is required.');
    if(job.status==='completed'){if(job.outcome!==outcome)throw new Error('This request already has a different outcome.');return;}
    const children=this.store.db.prepare(`SELECT i.id,i.binding_id FROM inbox i JOIN settings s ON s.key='parent:'||i.id WHERE s.value=?`).all(id) as {id:string;binding_id:string}[];
    const related=new Set([job.binding_id,...children.map(c=>c.binding_id)]);
    const pendingReports=this.store.db.prepare(`SELECT i.id FROM inbox i LEFT JOIN settings s ON s.key='report-parent:'||i.id LEFT JOIN settings legacy ON legacy.key='parent:'||substr(i.id,8) WHERE i.id LIKE 'report:%' AND COALESCE(s.value,legacy.value)=? AND i.status NOT IN ('completed','reviewed','auto_closed','replaced')`).all(id) as {id:string}[];
    if(this.hasPendingCreation?.(id)||this.unfinishedChildren(id)||pendingReports.some(r=>r.id!==acknowledgingReport)||[...this.approvals.pending.values()].some(p=>related.has(p.binding.id)))throw new Error('Finish or review delegated work, reports and pending approvals before resolving the owner request.');
    this.store.jobState(id,'completed',null,outcome);this.store.event(id,'owner_resolved',{outcome});
    if(id.startsWith('master:')&&master)this.coordinator?.workerReply(master,`Delegated work resolved: ${outcome}.`,id,true,'final');
  }
  requestProtected(id:string,bindingId:string) {
    if(this.busy.has(bindingId)||this.store.hasDispatched(bindingId)||[...this.approvals.pending.values()].some(p=>p.binding.id===bindingId))return true;
    // A parent's tracking must remain open while delegated requests are outstanding.
    return !!this.store.db.prepare(`SELECT 1 FROM inbox i JOIN settings s ON s.key='parent:'||i.id
      WHERE s.value=? AND i.status IN ('queued','dispatched','submitted','uncertain','failed') LIMIT 1`).get(id);
  }
  cleanupPolicy() {
    const hours=Number(this.store.get('cleanup-hours')??24);
    return {enabled:this.store.get('cleanup-enabled')==='true',afterHours:[24,72,168].includes(hours)?hours:24};
  }
  updateCleanup(enabled:boolean,afterHours:number) {
    if(typeof enabled!=='boolean'||![24,72,168].includes(afterHours))throw new Error('Choose 24 hours, 3 days or 7 days.');
    this.store.set('cleanup-hours',String(afterHours));this.store.set('cleanup-enabled',String(enabled));
    return this.cleanupPolicy();
  }
  reviewRequests(items:{requestId:string;expectedStatus:string;expectedUpdatedAt:number}[]) {
    if(!Array.isArray(items)||!items.length||items.length>500||new Set(items.map(i=>i.requestId)).size!==items.length)throw new Error('Select 1–500 distinct requests.');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      for(const item of items) {
        if(!item||typeof item.requestId!=='string'||typeof item.expectedStatus!=='string'||!Number.isFinite(item.expectedUpdatedAt))throw new Error('Request identity, status and last update are required.');
        const j=this.store.job(item.requestId);
        if(!j||j.status!==item.expectedStatus||(j.updated_at??j.created_at)!==item.expectedUpdatedAt)throw new Error('A selected request changed. Refresh Activity and select it again.');
        if(!['submitted','uncertain','failed'].includes(j.status)||this.requestProtected(j.id,j.binding_id))throw new Error('A selected request is active, has pending permission, or has unfinished delegated work. Nothing was closed.');
      }
      for(const item of items) {
        const j=this.store.job(item.requestId)!;
        this.store.jobState(j.id,'reviewed');this.store.audit('request-reviewed',j.binding_id,JSON.stringify({requestId:j.id,previousStatus:j.status,bulk:true}));
      }
      this.store.db.exec('COMMIT');return {closed:items.length};
    } catch(e) {this.store.db.exec('ROLLBACK');throw e;}
  }
  autoCloseStale(now=Date.now()) {
    const policy=this.cleanupPolicy();if(this.stopped||!policy.enabled)return 0;
    let closed=0;
    for(const j of this.store.pendingJobs()) {
      if(!['submitted','uncertain','failed'].includes(j.status)||(j.updated_at??j.created_at)>now-policy.afterHours*3600000||this.requestProtected(j.id,j.binding_id))continue;
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        this.store.jobState(j.id,'auto_closed');
        this.store.audit('request-auto-closed',j.binding_id,JSON.stringify({requestId:j.id,previousStatus:j.status,afterHours:policy.afterHours}));
        this.store.db.exec('COMMIT');closed++;
      }catch(e){this.store.db.exec('ROLLBACK');throw e;}
    }
    return closed;
  }
  reviewRequest(id:string,expectedStatus:string) {
    const job=this.store.job(id);
    if(!job)throw new Error('Request not found. Refresh Activity.');
    if(job.status==='reviewed')return {ok:true};
    if(job.status!==expectedStatus)throw new Error('This request changed. Refresh Activity before reviewing it.');
    if(!['submitted','uncertain','failed'].includes(job.status))throw new Error('Only requests awaiting a reply or needing review can be closed after checking the native chat.');
    if(this.requestProtected(job.id,job.binding_id))throw new Error('This session is still delivering a request. Wait for delivery, permissions and delegated work to finish before reviewing it.');
    // Owner review is not an agent completion receipt and never resends work.
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.jobState(id,'reviewed');
      this.store.audit('request-reviewed',job.binding_id,JSON.stringify({requestId:id,previousStatus:job.status}));
      this.store.db.exec('COMMIT');
    } catch(e) {this.store.db.exec('ROLLBACK');throw e;}
    return {ok:true};
  }
  private checkQuotedPlatform(text:string,b:Binding) {
    const target=this.coordinator?.explicitDestination(text);if(!target||target.id===b.id)return;
    const route=this.native.connections?.route(b);
    if(!this.coordinator!.registry.matches(target.id,{provider:b.provider,executionMode:route?.executionMode??this.store.get(`execution-mode:${b.id}`),accountScope:route?.accountScope}))throw new Error('The quoted session and named platform conflict. Choose one destination.');
  }
  need(id:string){const b=this.store.binding(id);if(!b?.enabled)throw new Error('That session is missing or paused. Ask me to show your recent sessions, or resume it in the app.');return b;}
  queue(id:string,b:Binding,text:string) {
    if(text.length>32000)throw new Error('Message exceeds 32,000 characters.');
    this.store.db.exec('SAVEPOINT queue_owner');
    try {
      const exists=!!this.store.job(id);
      text=this.contracts.augment(this,id,b,text);
      this.store.enqueue(id,b,text);
      const approved=this.contracts.approved(id);
      if(approved){
        let item=this.store.itemOf(id);
        if(!item){const title=approved.original.replace(/\s+/g,' ').slice(0,200);item=this.brain.memory.items.add(title,'Owner',undefined,`contract:${approved.id}`,id).id;this.store.linkItem(id,item);}
        this.contracts.bindItem(id,item);
      }
      const item=this.store.itemOf(id),destination=this.store.destination();
      if(item&&destination)this.store.set(`brain-topic:${destination}`,`item:${item}`);
      if(!exists&&this.coordinator?.isCoordinator(b.id))queueOwnerReceipt(this.store,id,b);
      this.store.db.exec('RELEASE queue_owner');
    }catch(e){this.store.db.exec('ROLLBACK TO queue_owner; RELEASE queue_owner');throw e;}
  }
  private rejectBriefDispatch(job:ReturnType<Store['job']>,reason?:string) {
    if(!job||!['queued','dispatched'].includes(job.status))return;
    const guard=briefDispatchGuard(this.store,job.id);if(!guard)return;
    const message=reason??new BriefDispatchError().message;
    this.store.db.exec('SAVEPOINT reject_brief_dispatch');
    try{
      this.store.jobState(job.id,'failed',message);
      this.store.db.prepare("UPDATE outbox SET status='cancelled',error='Brief action was not sent' WHERE status='queued' AND source=?").run(`native-opening:${job.id}:0`);
      if(briefDestinationValid(this.store,guard.destination,guard.owner))this.store.output(undefined,message,`brief-action-error:${job.id}`,guard.destination,{requestId:job.id,kind:'system',origin:'system',plain:true});
      this.store.db.exec('RELEASE reject_brief_dispatch');
    }catch(e){this.store.db.exec('ROLLBACK TO reject_brief_dispatch; RELEASE reject_brief_dispatch');throw e;}
  }
  /** Called before every channel/native submit; future dispatch guards share this boundary. */
  assertDispatchAllowed(id:string,b:Binding){
    const scheduled=hasScheduleGuard(this,id),guard=briefDispatchGuard(this.store,id),contract=this.contracts.hasGuard(id),choice=this.contracts.hasOptionGuard(id);
    if(!scheduled&&!guard&&!contract&&!choice)return false;
    const job=this.store.job(id);if(!job)throw new DispatchNotSubmittedError('The request no longer exists.');
    if(scheduled){
      const state=job.binding_id===b.id?scheduleJobState(this,id):'invalid';
      if(state==='hold')throw new ScheduledChannelHold('Scheduled request held until its original channel is active.');
      if(state==='invalid'){const reason='The scheduled request was not sent because its owner or session changed.';this.failBeforeSubmission(id,reason);throw new DispatchNotSubmittedError(reason);}
    }
    if(choice){try{this.contracts.assertOption(this,id,b,true);}catch{throw new DispatchNotSubmittedError('The original choice or session changed. Nothing was sent.');}if(this.contracts.optionChannel(id)!==this.store.controlChannel())throw new ScheduledChannelHold('Choice held until its original channel is active.');}
    if(contract){const approved=this.contracts.approved(id);if(approved&&this.store.controlChannel()!==approved.channel){try{this.contracts.assertDispatch(this,id,b,job.body,new Set(),true);}catch{throw new DispatchNotSubmittedError('The approved task or session changed. Nothing was sent.');}throw new ScheduledChannelHold('Task held until its original channel is active.');}try{this.contracts.assertDispatch(this,id,b,job.body);}catch{throw new DispatchNotSubmittedError('The approved task or session changed. Nothing was sent.');}}
    if(guard&&!briefDispatchValid(this,job,b)){this.rejectBriefDispatch(job);throw new BriefDispatchError();}
    return true;
  }
  failBeforeSubmission(id:string,reason:string){this.rejectBriefDispatch(this.store.job(id),reason);failScheduledBeforeSubmission(this,id,reason);this.contracts.rejectDispatch(id,reason);const j=this.store.job(id);if(j&&this.contracts.hasOptionGuard(id)&&['queued','dispatched'].includes(j.status))this.store.jobState(id,'failed',reason);}
  private routableJob(b:Binding) {
    for(;;){
      const channel=this.store.controlChannel();
      const job=this.store.db.prepare(`SELECT i.* FROM inbox i LEFT JOIN schedule_jobs s ON s.job_id=i.id
        LEFT JOIN task_contract_jobs cj ON cj.job_id=i.id LEFT JOIN task_contracts c ON c.id=cj.contract_id OR c.dispatch_id=i.id LEFT JOIN task_contract_option_proofs p ON p.job_id=i.id
        WHERE i.binding_id=? AND i.status='queued' AND (s.job_id IS NULL OR s.channel=?) AND (c.id IS NULL OR c.channel=?) AND (p.job_id IS NULL OR p.channel=?) ORDER BY i.created_at,i.rowid LIMIT 1`).get(b.id,channel,channel,channel) as import('./store.js').Job|undefined;if(!job)return;
      const state=scheduleJobState(this,job.id);
      if(state==='hold')return;
      if(state==='invalid'){this.failBeforeSubmission(job.id,'The paired owner or session changed; scheduled request was not sent.');if(this.store.job(job.id)?.status==='queued')this.store.jobState(job.id,'failed','Request ownership is unavailable; nothing was sent.');continue;}
      return job;
    }
  }
  pump() {
    if(this.stopped)return;
    this.brain.tick(this);
    for(const job of this.store.db.prepare("SELECT i.* FROM inbox i JOIN brief_dispatch_guards g ON g.request_id=i.id WHERE i.status='queued'").all() as unknown as import('./store.js').Job[]){
      if(!briefDispatchValid(this,job))this.rejectBriefDispatch(job);
    }
    for(const b of this.store.bindings()) {
      if(!b.enabled||b.mode==='channel'||this.busy.has(b.id))continue;
      const job=this.routableJob(b);if(!job)continue;
      try{this.assertDispatchAllowed(job.id,b);}catch(e){if(e instanceof ScheduledChannelHold)continue;if(e instanceof DispatchNotSubmittedError){this.failBeforeSubmission(job.id,e.message);continue;}throw e;}
      this.busy.add(b.id);this.store.jobState(job.id,'dispatched');
      const run=()=>job.destination?this.store.destinationContext.run(job.destination!,()=>this.native.run(b,job.body,job.id)):this.native.run(b,job.body,job.id);
      const task=this.coordinator?(this.coordinator.isCoordinator(b.id)?this.coordinator.scope.run(b.id,run):this.coordinator.scope.exit(run)):run();
      void task.then(()=>{if(this.store.job(job.id)?.status==='dispatched')this.store.jobState(job.id,'submitted');}).catch(e=>{
        if(e instanceof ScheduledChannelHold){if(this.store.job(job.id)?.status==='dispatched')this.store.jobState(job.id,'queued');return;}
        if(e instanceof DispatchNotSubmittedError){this.failBeforeSubmission(job.id,e.message);return;}
        if(['completed','reviewed','auto_closed','replaced'].includes(this.store.job(job.id)?.status??''))return;
        this.store.jobState(job.id,'uncertain',(e as Error).message);
        // A slow native hand-off often still lands. Internal report deliveries never reach the owner; for
        // owner messages, warn only if the session has not answered by the time the notice is due.
        if(job.id.startsWith('report:'))return;
        if(e instanceof DesktopReadinessError){this.store.output(b,e.message,`error:${job.id}`,job.destination??this.store.get('whatsapp-owner')??null,{requestId:job.id,kind:'system',origin:'system'});return;}
        const notice=()=>{if(this.stopped||this.store.job(job.id)?.status!=='uncertain')return;
          this.store.output(b,`I couldn't confirm a reply from this session, so I won't repeat the task automatically. Please check the native session before sending a new request.\nDetails: ${(e as Error).message}\nReference: ${job.id}`,`error:${job.id}`,job.destination??this.store.get('whatsapp-owner')??null,{requestId:job.id,kind:'system',origin:'system'});};
        // ponytail: in-memory timer, so a restart inside the window drops the notice; the request stays uncertain.
        if(this.uncertainNoticeMs>0)setTimeout(notice,this.uncertainNoticeMs).unref?.();else notice();
      }).finally(()=>{this.busy.delete(b.id);this.pump();});
    }
  }
  channelPoll(b:Binding,client:string) {
    if(b.mode!=='channel')throw new Error('Session is not registered in channel mode.');
    const prior=this.channelClients.get(b.id);
    if(prior&&prior.id!==client&&Date.now()-prior.seen<20000)throw new Error('Another channel client owns this binding.');
    this.channelClients.set(b.id,{id:client,seen:Date.now()});
    if(this.store.hasDispatched(b.id))return null;
    const job=this.routableJob(b);if(!job)return null;
    try{this.assertDispatchAllowed(job.id,b);}catch(e){if(e instanceof ScheduledChannelHold)return null;if(e instanceof DispatchNotSubmittedError){this.failBeforeSubmission(job.id,e.message);return null;}throw e;}
    const envelope=turnEnvelope(this.store,b,job.body,job.id,{tool:'whatsapp_reply'},this.attachments.references(b,job.id,true));
    this.store.jobState(job.id,'dispatched');envelope.acknowledge();return {...job,body:envelope.body};
  }
  channelReply(b:Binding,text:string,kind:string,requestId?:string,source?:string,context:Pick<ReplyContext,'turnId'|'outcome'|'options'>={}) {
    if(context.options!==undefined)context={...context,options:parseMessageOptions(context.options)};
    const replyIdentity=context.options?JSON.stringify([text,context.options]):text;
    if(!['progress','final'].includes(kind))throw new Error('Use progress or final');
    if(typeof text!=='string'||!text.trim()||text.length>100000)throw new Error('Reply text must be nonempty and under 100,000 characters');
    if(context.turnId!==undefined&&(typeof context.turnId!=='string'||!context.turnId.length||context.turnId.length>200||/[\x00-\x20]/.test(context.turnId)))throw new Error('Invalid provider turn ID.');
    if(context.outcome!==undefined&&!['done','blocked','reviewed','cancelled'].includes(context.outcome))throw new Error('Invalid request outcome.');
    if(!this.store.binding(b.id)?.enabled)throw new Error('This session is inactive.');
    if(requestId&&this.store.job(requestId)?.status==='replaced')throw new Error('This request was closed when its master was replaced.');
    if(kind==='final'&&[...this.approvals.pending.values()].some(p=>p.binding.id===b.id))throw new Error('A native approval is still pending. Resolve it before marking this request final.');
    if(kind==='final'&&requestId&&(this.hasPendingCreation?.(requestId)||this.unfinishedChildren(requestId)))throw new Error('Delegated work or session creation is still pending. Send progress and keep the owner request open.');
    if(kind==='final'&&!requestId&&this.store.unfinished(b.id).length)throw new Error('This session has open bridge requests. Use respond NAME REQUEST-ID (or whatsapp_reply with requestId) from the original message so the final reply closes the correct request. Use progress for an interim update.');
    if(requestId){const j=this.store.job(requestId);if(!j||j.binding_id!==b.id)throw new Error('Reply request does not belong to this session.');}
    const coordinator=this.coordinator?.isCoordinator(b.id)===true;
    if(coordinator&&kind==='final'&&!replyFindings(text)&&(!requestId?.startsWith('report:')||context.outcome==='done'))throw new Error('A final marker is not a verified result. Give the findings and remaining limits, or acknowledge the report without resolving the owner request.');
    if(requestId&&kind==='final') {
      const previous=this.store.get(`final-reply:${requestId}`);
      if(previous!==undefined){if(previous!==replyIdentity)throw new Error('This request already has a different final reply.');return {accepted:true,newlyQueued:false};}
      if(this.store.job(requestId)?.status==='completed')return {accepted:true,newlyQueued:false};
    }
    if(requestId?.startsWith('report:')&&kind==='final') {
      this.coordinator?.quiet(requestId,context.outcome);return {accepted:true,newlyQueued:false,acknowledged:true};
    }
    if(!context.options&&coordinator&&requestId&&this.ownerReplyPolicy.alreadySent(requestId,text)) {
      this.store.event(requestId,'duplicate_coordinator_suppressed');
      return {accepted:true,newlyQueued:false,duplicate:true};
    }
    if(requestId)source=`reply:${kind}:${b.id}:${requestId}:${kind==='final'?'final':context.turnId?hash(context.turnId+':'+replyIdentity):source??hash(replyIdentity)}`;
    let queued=false;
    // A coordinator answering another coordinator's hand-off reports back only; the owner hears it once, from the asking coordinator.
    const relayOnly=!!requestId&&!!this.coordinator?.delegatedCoordinator(b,requestId);
    if(relayOnly&&context.options)throw new Error('Message choices must be offered by the owner-facing proxy, not a relay-only reply.');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
    queued=relayOnly||this.store.output(b,text,source,requestId?this.store.job(requestId)?.destination??this.store.get('whatsapp-owner')??null:this.store.destination(),{...context,requestId,kind:kind==='final'?'final':'progress',origin:'agent'})===true;
    if(queued&&!coordinator&&requestId&&source)this.ownerReplyPolicy.recordWorker(requestId,source,text);
    if(requestId&&kind==='final')this.store.set(`final-reply:${requestId}`,replyIdentity);
    if(requestId&&kind==='final')this.store.jobState(requestId,'completed',null,context.outcome);
    else if(requestId){const j=this.store.job(requestId)!;if(['uncertain','failed'].includes(j.status))this.store.jobState(requestId,'submitted');else this.store.db.prepare('UPDATE inbox SET updated_at=? WHERE id=?').run(Date.now(),requestId);}
    if(kind==='final')this.store.set(`explicit-final:${b.id}`,String(Date.now()));
    if(queued&&requestId)this.coordinator?.workerReply(b,text,requestId,false,kind as 'progress'|'final',!relayOnly);
    if(queued&&requestId&&kind==='final')this.coordinator?.itemReport(b,text,requestId);
    this.store.db.exec('COMMIT');
    }catch(e){this.store.db.exec('ROLLBACK');throw e;}
    if(queued&&this.coordinator)this.pump();return {accepted:true,newlyQueued:queued};
  }
}
