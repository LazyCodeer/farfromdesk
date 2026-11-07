import {prepareSocialPreviews,queueSocialPreviews, withoutPreviewCaptions} from './social-preview.js';
import {asksForSocialCreation} from './social-intent.js';
import {requestedSocialImageProvider} from './social-image-provider.js';
import { DesktopReadinessError } from './session-activation.js';
import { ownerCommand, routeOwnerTarget, clearOwnerTarget, authenticatedOwner, ownerAttachmentTarget, ownerAttachmentTool, keepToolAttachment, runToolAttachment, toolName, isOwnerCommand, pickOwnerTarget, ownerTurnLabel, specialtyTarget, brainSelected, toolSelected } from './owner-commands.js';
import { selectOption, previewOption, parseMessageOptions, createOptions, markActionOption, optionAction } from './message-options.js';
import { MetaBrain } from './meta-brain.js';
import { MetaModel } from './meta-model.js';
import { composeNotice, CLOSED_FALLBACK, ESCALATED_FALLBACK } from './companion-voice.js';
import { DeliveryChoiceHold, deliveryAlternatives, heldCard, escalatedCard, readDeliveryHold, saveDeliveryHold, releaseDeliveryHold, heldDelivery, openHolds, holdTarget, runningApps, openTarget, DELIVERY_CHOICE_MINUTES } from './delivery-choice.js';
import { Schedules,scheduleJobState,scheduleRootState,hasScheduleGuard,failScheduledBeforeSubmission } from './schedules.js';
import { TaskContracts } from './task-contracts.js';
import { queueReportedProof } from './proof-report.js';
import { appClosedFor, closedAfterQueueText, queueOwnerReceipt, sessionShortName } from './coordinator-experience.js';
import { hash, Store, type Binding, type Provider } from './store.js';
import type { NativeAgents } from './native.js';
import { probeDesktopApps, probeDesktopAppsNow } from './app-liveness.js';
import type { Approvals } from './approvals.js';
import type { Coordinator } from './coordinator.js';
import { Attachments, type IncomingFile } from './attachments.js';
import { updateRole, turnEnvelope } from './roles.js';
import { errorCode, type ReplyContext, type RequestOutcome } from './request-events.js';
import { OwnerReplyPolicy,replyFindings } from './owner-reply-policy.js';
import { ErrandWorkflow } from './errand-workflow.js';
import { namedItem, directSession, startDirect, endDirect, backToProxy } from './owner-routing.js';
import type { MorningBrief } from './morning-brief.js';
import type { StuckDetection } from './stuck-detection.js';
import type { StuckCiWatch } from './stuck-ci-watch.js';
import { DispatchNotSubmittedError,BriefDispatchError,briefDestinationValid,briefDispatchGuard,briefDispatchValid,recordBriefDispatch } from './brief-dispatch-guard.js';
import {CollaborationHold,type ManagedCollaboration} from './managed-collaboration.js';
import {isCollaborationFenceError} from './collaboration-dispatch-fence.js';
import type {ProofOwnerBindings} from './proof-owner-binding.js';
import {agentReach} from './agent-reach.js';
import {captureResearchRequest,captureGuidedResearchRequest} from './agent-reach-request.js';
import {GuidedModes} from './guided-modes.js';
import {socialSpecialty} from './social-agent.js';
import {prepareSpecialties,specialtyEpoch,specialtyIdentity,markPendingSpecialty,pendingSpecialty,hasPendingSpecialty,bindSessionSpecialty,hasSessionSpecialty,sessionSpecialty,specialtyNoticeDestination,type PendingSpecialty} from './session-specialty.js';
import {prepareAttachmentTargetEpochs,attachmentTargetEpoch} from './attachment-target-epoch.js';
import { computerName } from './platform.js';

/** A scheduled request was held before any native submission. */
class ScheduledChannelHold extends DispatchNotSubmittedError {}

export type RouteResult={status:'queued'|'handled'|'ignored'|'blocked';requestId:string;code?:string};
export type Incoming = {id:string;text:string;quotedId?:string;optionToken?:string;source?:'text'|'voice';ownerCommand?:boolean;ownerIntent?:boolean;ownerChoice?:boolean;activityScope?:{destination:string;owner:string}};
export const help = `Just tell me what you need.

• Show my recent sessions.
• Find the website session.
• Use Checkout fix and tell me its progress.
• Claude, create a session for this task.
• /social uses your selected session for social drafts.

Reply to a permission message with “Yes, allow it” or “No, deny it”. Reply to a session’s message to continue in that session.

In WhatsApp, bind an approved GitHub check with /proof bind #ITEM CHECK_NUMBER OWNER/REPO. This does not verify the task.`;
/** The same words are already waiting for an answer: this is a retry, not a new request. */
export class DuplicateOwnerRequest extends Error {}
export class Router {
  coordinator?:Coordinator;
  /** Server mode's low battery answer, set by main. */
  serverMode?:{setLowBatteryOk(ok:boolean):Promise<string>};
  brain:MetaBrain;
  schedules:Schedules;
  scheduledBrief?:(destination:string,expectedOwner:string,occurrenceId:string,canSend?:()=>boolean)=>Promise<'queued'|'already-queued'|'retry'|'invalid'>;
  contracts:TaskContracts;
  /** Optional internal prototype; no production route enables it. */
  collaboration?:ManagedCollaboration;
  proofBindings?:ProofOwnerBindings;
  /** Injectable only by bridge-owned tests; the default uses public HTTPS. */
  errands:ErrandWorkflow;
  hasPendingCreation?:(requestId:string)=>boolean;
  workspaceCommand?:(args:string)=>string;
  remoteControl?:(text:string)=>Promise<string|undefined>;
  morningBrief?:MorningBrief;
  stuckDetection?:StuckDetection;
  stuckCiWatch?:StuckCiWatch;
  reach=agentReach;
  guidedModes=new GuidedModes();
  busy=new Set<string>();
  channelClients=new Map<string,{id:string;seen:number}>();
  private paused=false;
  get stopped(){return this.paused;}
  set stopped(value:boolean){if(value&&!this.paused){this.errands?.pause();this.clearSilenceTimers();}this.paused=value;}
  // How long a session gets to answer before an uncertain hand-off is reported to the owner.
  uncertainNoticeMs=120_000;
  // A submitted request that never answers must not leave the receipt as the last word.
  // First notice, then one escalation; both timers live only while a request is in flight.
  silenceNoticeMs=75_000;
  silenceEscalateMs=240_000;
  private silenceTimers=new Map<string,ReturnType<typeof setTimeout>>();
  attachments:Attachments;
  private ownerReplyPolicy:OwnerReplyPolicy;
  constructor(public store:Store,public native:NativeAgents,public approvals:Approvals) {prepareSocialPreviews(store);this.brain=new MetaBrain(store);this.schedules=new Schedules(store,this.brain.secret);this.contracts=new TaskContracts(store,this.brain.secret);this.attachments=new Attachments(store);this.ownerReplyPolicy=new OwnerReplyPolicy(store);this.errands=new ErrandWorkflow(this);native.beforeDispatch=(b,id)=>this.assertDispatchAllowed(id,b);native.beforeManagedSubmission=(b,id)=>this.collaboration?.markSubmissionStarted(id,b);}
  attachmentTarget(m:Incoming) {
    let text=m.text.trim(),b:Binding|undefined;
    prepareAttachmentTargetEpochs(this.store);
    const selectedRoute=!text.startsWith('/')&&!m.quotedId;
    if(selectedRoute)prepareSpecialties(this.store);
    if(text.startsWith('/')) {
      const match=/^\/to\s+(\S+)(?:\s+([\s\S]*))?$/i.exec(text);
      if(!match)throw new Error('Attachment captions cannot run bridge commands. Use /to NAME caption or quote a session reply.');
      b=this.need(match[1]);text=match[2]?.trim()??'';
    } else if(m.quotedId) {
      b=this.store.quotedBinding(m.quotedId);if(!b)throw new Error('That quoted message does not identify a registered session. Use /to NAME caption.');
      this.checkQuotedPlatform(text,b);
    } else {
      const tool=ownerAttachmentTool(this,m);
      if(tool){
        if(this.schedules.isScheduleLike(text))throw new Error('Send schedules as a new text message in your own chat. Attachments cannot schedule or immediately send future actions.');
        if(text.length>32000)throw new Error('Attachment caption exceeds 32,000 characters.');
        return {tool,binding:undefined as unknown as Binding,text,identity:JSON.stringify(['tool',tool,this.store.get(`owner-target:${this.store.destination()}`),this.store.ownerFor(this.store.destination()),this.store.get('incoming-owner-generation')])};
      }
      b=ownerAttachmentTarget(this,m)??(this.coordinator?this.coordinator.destination(text):this.store.binding(this.store.get('active')??''));
    }
    if(this.schedules.isScheduleLike(text))throw new Error('Send schedules as a new text message in your own chat. Attachments cannot schedule or immediately send future actions.');
    if(!b)throw new Error('Choose an exact session before sending an attachment.');
    this.need(b.id);
    if(text.length>32000)throw new Error('Attachment caption exceeds 32,000 characters.');
    return {tool:undefined as undefined|ReturnType<typeof ownerAttachmentTool>,binding:b,text:text||'The owner sent an attachment without a caption. Acknowledge receipt and ask what they want done with it; do not execute it.',
      identity:JSON.stringify([b.id,b.native_id,b.cwd,b.token_hash,b.provider,b.mode,this.store.get(`execution-mode:${b.id}`),this.store.get(`session-route:${b.id}`),this.store.get('master'),this.store.get('active'),this.store.get('selected'),this.store.ownerFor(this.store.destination()),this.store.controlChannel(),this.store.get('incoming-owner-generation'),this.store.get(`owner-target:${this.store.destination()}`),attachmentTargetEpoch(this.store,b.id),...(selectedRoute?[specialtyEpoch(this.store)]:[])])};
  }
  receiveAttachment(m:Incoming,file:IncomingFile,target:ReturnType<Router['attachmentTarget']>) {
    if(this.stopped||this.store.seen(m.id))return;
    // Attachment captions use a separate synchronous path; do not let them bypass task review.
    if(this.contracts.enabled()&&m.text.trim())throw new Error('Send the task as a text or voice message first. Attachment task review is not available yet. Nothing was sent.');
    if(this.attachmentTarget(m).identity!==target.identity)throw new Error('The intended session changed during download. Please resend to the intended session.');
    if(target.tool){
      const tool=target.tool,path=keepToolAttachment(m.id,file);
      this.store.remember(m.id);this.store.db.prepare("UPDATE media_inbox SET status='processed' WHERE id=?").run(m.id);
      const destination=this.store.destination();
      if(destination)this.store.output(undefined,`File received. I’m passing it to ${toolName(tool)}.`,`tool-attachment:${m.id}`,destination,{kind:'system',origin:'system',plain:true});
      void runToolAttachment(this,m,tool,m.text,{kind:file.kind,filename:file.filename,path}).catch(e=>{
        this.store.output(undefined,`${toolName(tool)} could not finish with that file: ${String((e as Error)?.message??e).slice(0,300)}`,`command:${m.id}`,undefined,{plain:true});
      });
      return;
    }
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
    let evidenceFinalized=false;
    try{
      // History is best effort: a failure to label or record it must not fail a turn that already ran, or Telegram re-polls it.
      const failed=(e:unknown)=>{try{this.store.event(m.id,'owner_history_failed',{code:errorCode(e)});}catch{}};
      let label:string|undefined;try{label=ownerTurnLabel(this,m);}catch(e){failed(e);}
      const result=await this.receiveOnce(m);
      // Evidence captured before F3 yields is provisional. Rejected/ignored
      // turns must not make a still-unanswered choice disappear.
      try{this.stuckDetection?.finishInput(m.id,(result.status==='handled'||result.status==='queued')&&this.store.incomingOwnerCurrent());}catch{}
      evidenceFinalized=true;
      try{if(this.store.incomingOwnerCurrent()&&label&&result.status!=='ignored'&&!this.store.job(m.id))this.store.recordOwnerCommand(m.id,label,result.status);}catch(e){failed(e);}
      return result;
    }finally{if(!evidenceFinalized)try{this.stuckDetection?.finishInput(m.id,false);}catch{}this.receiving.delete(m.id);}
  }
  /** The brain approved a pending task review; the original request runs as approved work. */
  replayApproved(m:Incoming){return this.receiveOnce(m,true);}
  private async receiveOnce(m:Incoming,contractApproved=false):Promise<RouteResult> {
    if(this.stopped||!this.store.incomingOwnerCurrent())return {status:'blocked',requestId:m.id,code:'routing_unavailable'};
    if(this.store.seen(m.id))return {status:'ignored',requestId:m.id};
    if((m.ownerCommand||m.ownerIntent)&&!authenticatedOwner(this,m))return {status:'blocked',requestId:m.id};
    // A number quoted to a notice must resolve to its exact original
    // delivered request; never let an unavailable notice fall into routing.
    if(m.quotedId&&this.stuckDetection){
      let choice:ReturnType<StuckDetection['quotedChoice']>;
      try{choice=this.stuckDetection.quotedChoice(m);}catch{choice={kind:'unavailable'};}
      if(choice?.kind==='unavailable'){
        if(this.store.incomingOwnerCurrent()){this.store.output(undefined,'That choice notice is unavailable or expired. Nothing was sent.',`stuck-choice-error:${m.id}`,undefined,{plain:true});this.store.remember(m.id);}
        return {status:'blocked',requestId:m.id,code:'routing_unavailable'};
      }
      if(choice?.kind==='mapped')m={...m,quotedId:choice.quotedId,text:choice.text??m.text};
    }
    // Owner provenance follows the live channel. It is what the proactive watch
      // and the item list are built on, so a Telegram owner request needs it too.
      if(authenticatedOwner(this,m)){
      const destination=this.store.destination(),owner=this.store.ownerFor(destination);
      try{if(destination&&owner)this.store.recordOwnerOrigin(m.id,destination,owner);}catch{return {status:'blocked',requestId:m.id,code:'routing_unavailable'};}
      // Capture a reply to the exact message before task-review or other
      // routing can intercept it; no answer text is retained here.
      if(m.quotedId&&m.text.trim())try{this.stuckDetection?.recordQuotedReply(m);}catch{
        // Do not let F3 consume a reply while its exact association could not
        // be recorded: a later notice could incorrectly say it is unanswered.
        try{this.store.output(undefined,'Could not process this reply. Please resend it.',`stuck-reply-error:${m.id}`,undefined,{plain:true});this.store.remember(m.id);}catch{}
        return {status:'blocked',requestId:m.id,code:'routing_unavailable'};
      }
    }
    let text=m.text.trim();if(!text)return {status:'ignored',requestId:m.id};
    // Retired commands are ordinary words now, so they get the normal answer instead of an unknown-command error.
    if(/^\/(?:checkrun|reach|research|jobs)(?:\s|$)/i.test(text)){text=text.slice(1);m={...m,text};}
    captureResearchRequest(this.store,this,m);
    this.morningBrief?.firstMessage(m);
    let ciReply:string|undefined;
    try{ciReply=this.stuckCiWatch?.command(m);}catch{
      if(this.store.incomingOwnerCurrent()){this.store.output(undefined,'The CI watch could not be saved. Please try again.',`stuck-ci-error:${m.id}`,undefined,{plain:true});this.store.remember(m.id);}
      return {status:'blocked',requestId:m.id,code:'routing_unavailable'};
    }
    const stuckReply=ciReply??this.stuckDetection?.dismiss(m);
    if(stuckReply!==undefined){this.store.output(undefined,stuckReply,`stuck-action:${m.id}`,undefined,{plain:true});this.store.remember(m.id);return {status:'handled',requestId:m.id};}
    // Natural-language controls may be spoken; slash commands must be typed.
    const ownerIntent=m.ownerIntent??(m.ownerCommand!==false);
    // Screen-control links and the phone's answer code are handled before any routing.
    if(this.remoteControl&&!m.quotedId&&ownerIntent&&(!text.startsWith('/')||m.ownerCommand!==false)){const reply=await this.remoteControl(text).catch(()=>`Screen control could not start. Check FarFromDesk on your ${computerName()}.`);if(!this.store.incomingOwnerCurrent())return {status:'blocked',requestId:m.id,code:'routing_unavailable'};if(reply){this.store.output(undefined,reply,`command:${m.id}`,undefined,{plain:true});this.store.remember(m.id);return {status:'handled',requestId:m.id};}}
    // Exact typed decisions are resolved before ordinary model routing.
    let ownerReply=false;
    try {
      if(!contractApproved){const recovered=this.contracts.recoverApproved(this,m);if(recovered)return await this.receiveOnce(recovered,true);}
      if(contractApproved){
        const approved=this.contracts.approved(m.id);
        if(approved&&hasPendingSpecialty(this.store,approved.origin_id)){
          const marker=pendingSpecialty(this.store,approved.origin_id,m.text);
          if(!marker)throw new Error('The selected session or approved request changed. Nothing was sent.');
          return this.queueSpecialty(m,approved.origin_id,marker);
        }
      }
      // Replies to owner commands and session picks, errors included, go out without the session header and footer.
      const targetKey=`owner-target:${this.store.destination()}`,choiceKey=`owner-target-choice:${this.store.destination()}`;
      const previousTarget=this.store.get(targetKey),previousChoice=this.store.get(choiceKey);
      const guidedBusy=this.guidedModes.busyForContext(this);
      const quotedTarget=guidedBusy&&m.quotedId&&this.store.db.prepare('SELECT 1 FROM owner_target_options t JOIN message_options o ON o.id=t.option_id JOIN outbox b ON b.id=o.outbox_id WHERE b.wa_id=? AND o.destination=?').get(m.quotedId,this.store.destination());
      if(guidedBusy&&(quotedTarget||authenticatedOwner(this,m)&&m.ownerCommand===true&&!!previousChoice&&previousChoice!=='null'&&/^\d+$/.test(text))){
        this.store.output(undefined,'A request is still being processed. Please wait before changing sessions.',`guided:${m.id}`,undefined,{plain:true});this.store.remember(m.id);return {status:'handled',requestId:m.id};
      }
      ownerReply=true;const targetReply=pickOwnerTarget(this,m);ownerReply=false;
      if(targetReply!==undefined){
        // Selection may come from a channel-authenticated button or a typed
        // reply. Only a successful claim actually changes the selected target.
        if(this.store.get(targetKey)!==previousTarget||this.store.get(choiceKey)!==previousChoice){this.guidedModes.retarget(this);}
        // An empty reply means the handler already answered (a pass-it-on tap sends its own note under
        // command:<id>). Writing the mode line there too clashed with that note, or sent a bare
        // "Mode: General" (Windows test, 7 Nov 2026).
        if(targetReply)this.store.output(undefined,targetReply+'\n\n'+this.guidedModes.summary(this,{...m,quotedId:undefined,ownerCommand:true}),`command:${m.id}`,undefined,{plain:true});
        this.store.remember(m.id);return {status:'handled',requestId:m.id};
      }
      if(m.quotedId&&(m.optionToken||m.source!=='voice'&&/^\d+$/.test(text))){
        const input={responseId:m.id,destination:this.store.destination()??'',messageId:m.quotedId,token:m.optionToken,number:Number(text)};
        const preview=previewOption(this.store,input);
        if(preview){
          const guarded=this.contracts.hasGuard(preview.row.request_id);
          const reviewBody=guarded?this.contracts.choiceReview(this,preview.row.request_id,preview.body):preview.body;
          if(preview.row.selected_id){if(contractApproved)throw new Error('These choices were already answered. Nothing was sent.');selectOption(this.store,input,()=>{throw new Error('Choice was already answered.');});return {status:'handled',requestId:m.id};}
          // A delivery choice runs bridge code: it moves or releases a held message, so it is
          // never a task contract, never a session instruction, and never a forwarded reply.
          const action=optionAction(this.store,preview.row.id);
          if(action){
            if(!m.optionToken&&(!authenticatedOwner(this,m)||m.ownerChoice!==true))throw new Error('Choose this with your own direct reply. Nothing was sent.');
            const claimed=selectOption(this.store,input,()=>{throw new Error('This choice does not send a task.');},undefined,({row,choice})=>this.applyDeliveryChoice(m.id,row,choice));
            if(claimed)return {status:'handled',requestId:m.id};
          }
          if(!contractApproved&&(this.contracts.enabled()||guarded)){
            // Token callbacks and polls have already been authenticated by their channel adapter.
            // Typed choices must be direct owner replies, never forwarded data.
            if(!m.optionToken&&(!authenticatedOwner(this,m)||m.ownerChoice!==true))throw new Error('Choose with your own direct reply. Nothing was sent.');
            if(!this.contracts.enabled())throw new Error('Send your answer as a new message so it can be reviewed. Nothing was sent.');
            const contract=await this.contracts.preflight(this,m,reviewBody,undefined,undefined,true,true);
            if(contract.kind==='handled'){
              // An existing F3 review can reject a choice rather than hold it.
              // Only a newly created review for this input retains evidence.
              const held=this.store.db.prepare("SELECT 1 FROM task_contracts WHERE origin_id=? AND state='pending'").get(m.id);
              if(!held)try{this.stuckDetection?.finishInput(m.id,false);}catch{}
              return {status:'handled',requestId:m.id};
            }
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
      if(this.errands.cancel(m))return {status:'handled',requestId:m.id};
      const errandDestination=this.store.destination(),errandOwner=this.store.ownerFor(errandDestination);
      if(!contractApproved&&errandDestination&&errandOwner&&!this.contracts.hasPendingOwner(errandOwner,errandDestination)&&this.errands.draft(m))return {status:'handled',requestId:m.id};
      // Unsupported search input needs an explanation before task review; an
      // existing owner review still gets the first opportunity to resolve it.
      if(!contractApproved&&errandDestination&&errandOwner&&!this.contracts.hasPendingOwner(errandOwner,errandDestination)&&this.errands.unsupportedInput(m)&&await this.errands.start(m))return {status:'handled',requestId:m.id};
      if((m.quotedId||!ownerIntent)&&authenticatedOwner(this,m)&&this.schedules.isScheduleLike(text)){this.store.output(undefined,'Send schedules as a new message in your own chat. Nothing was scheduled or sent to a session.',`schedule-reply:${m.id}`,undefined,{plain:true});this.store.remember(m.id);return {status:'blocked',requestId:m.id};}
      if(this.schedules.shouldHandle(this,m,ownerIntent)&&await this.schedules.handle(this,m,ownerIntent,contractApproved))return {status:'handled',requestId:m.id};
      // A quoted answer is accepted only to an actual delivered question from
      // this exact Social session. Forwarded text and other quotes are data.
      if(m.quotedId&&m.ownerChoice===true&&m.source!=='voice'&&authenticatedOwner(this,m)&&!text.startsWith('/')){
        const owner=this.store.ownerFor(this.store.destination());
        const mode=this.guidedModes.get(this,{...m,quotedId:undefined,ownerCommand:true});
        const q=this.store.db.prepare(`SELECT o.id,o.request_id,o.binding_id,o.destination,o.body,COALESCE(o.sent_at,o.created_at) AS sent_at
          FROM outbox o JOIN reply_receipts rr ON o.source=rr.source||':0' AND rr.request_id=o.request_id AND rr.binding_id=o.binding_id
          WHERE o.wa_id=? AND o.destination=? AND o.status='sent' AND rr.origin IN ('agent','hook') AND rr.kind IN ('progress','final','hook') LIMIT 1`).get(m.quotedId,this.store.destination()) as {id:string;request_id:string;binding_id:string;destination:string;body:string;sent_at:number}|undefined;
        const parent=q&&sessionSpecialty(this.store,q.request_id),b=q&&this.store.binding(q.binding_id);
        if(mode?.kind==='social'&&q&&parent?.kind==='social'&&b?.enabled&&/\?/.test(q.body)){
          if(!owner||this.contracts.hasPendingOwner(owner,q.destination)||this.contracts.hasGuard(q.request_id))throw Error('Send your answer as a new message so it can be reviewed.');
          const target=mode.socialTarget;
          if(!target||target.bindingId!==b.id||target.identity!==specialtyIdentity(this.store,b)||target.epoch!==specialtyEpoch(this.store)||parent.bindingId!==b.id||parent.destination!==q.destination||q.sent_at<=Date.now()-24*60*60_000)throw Error('The Social question or session changed. Send /social again.');
          this.store.db.exec('SAVEPOINT social_followup');
          try{
            const claim=this.store.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(`social-question:${q.id}`,m.id);
            if(!claim.changes)throw Error('This Social question was already answered.');
            this.store.recordIncomingInput(m.id);this.queue(m.id,b,m.text);const imageProvider=requestedSocialImageProvider(m.text)??parent.imageProvider??'local';bindSessionSpecialty(this.store,m.id,b,'social',socialSpecialty(imageProvider),imageProvider);this.store.remember(m.id);
            this.store.db.exec('RELEASE social_followup');
          }catch(e){this.store.db.exec('ROLLBACK TO social_followup; RELEASE social_followup');throw e;}
          this.pump();return {status:'queued',requestId:m.id};
        }
      }
      const guidedOwner=this.store.ownerFor(this.store.destination());
      const pendingContract=!!guidedOwner&&this.contracts.hasPendingOwner(guidedOwner,this.store.destination()??'');
      // The answer to the low battery question server mode sends to the phone.
      if(this.serverMode&&authenticatedOwner(this,m)&&!m.quotedId&&m.ownerCommand===true&&/^\/(?:keepawake|letsleep)\s*$/i.test(text)){
        const message=await this.serverMode.setLowBatteryOk(/keepawake/i.test(text));
        this.store.output(undefined,message,`power:${m.id}`,undefined,{plain:true});this.store.remember(m.id);
        return {status:'handled',requestId:m.id};
      }
      // Never reinterpret a pending contract answer as a new mode selection.
      if(!pendingContract&&authenticatedOwner(this,m)&&!m.quotedId&&(m.source==='voice'?m.ownerIntent===true:m.ownerCommand===true)&&asksForSocialCreation(m.text)&&!this.guidedModes.get(this,m)){
        this.guidedModes.start(this,m,'social');
      }
      const guidedBeforeContract=this.guidedModes.get(this,m);
      // Guided requests perform their own contract review before session dispatch.
      // An already-pending contract always has precedence over a guided turn.
      if(!contractApproved&&!this.brain.decidesContracts(this)&&this.contracts.shouldHandle(this,m)&&!(guidedBeforeContract&&!pendingContract&&!text.startsWith('/'))){
        // F3 may consume an unquoted owner turn without queueing a job. Record
        // which currently delivered choices might have been answered before
        // yielding to the contract classifier; no answer text is retained.
        if(!m.quotedId)try{this.stuckDetection?.recordUnquotedReview(m);}catch{throw new Error('Could not process this reply. Please resend it.');}
        const contract=await this.contracts.preflight(this,m);
        if(contract.kind==='handled'){
          if(/^\/to\s/i.test(m.text)&&!this.store.db.prepare("SELECT 1 FROM task_contracts WHERE origin_id=? AND state='pending'").get(m.id))try{this.stuckDetection?.finishInput(m.id,false);}catch{}
          return {status:'handled',requestId:m.id};
        }
        if(contract.kind==='replay')return await this.receiveOnce(contract.incoming,true);
      }
      // Modes are available only to a new typed, authenticated owner turn. Other
      // slash commands keep their existing meaning; neither quotes nor voice
      // can answer a guided prompt or authorize its operations.
      if(authenticatedOwner(this,m)&&!m.quotedId&&(m.ownerCommand===true&&m.source!=='voice'||m.source==='voice'&&m.ownerIntent===true&&this.guidedModes.get(this,m)?.kind==='social'&&!text.startsWith('/'))){
        let mode=this.guidedModes.get(this,m);
        const reply=(message:string)=>{this.store.output(undefined,message+'\n\n'+this.guidedModes.summary(this,m),`guided:${m.id}`,undefined,{plain:true});this.store.remember(m.id);};
        if(mode?.busy&&(!text.startsWith('/')||/^\/(?:back|cancel|social|claude|codex|brain|use|talk)(?:\s|$)/i.test(text))){reply('A request is still being processed. Please wait before changing modes.');return {status:'handled',requestId:m.id};}
        if(mode&&/^\/(?:cancel|back)\s*$/i.test(text)){
          this.guidedModes.close(this,m);
          if(/^\/back/i.test(text)){clearOwnerTarget(this);reply('Back to normal routing.');}
          else reply(`Exited ${mode.kind} mode.`);
          return {status:'handled',requestId:m.id};
        }
        const start=/^\/(social)(?:\s+([\s\S]*))?$/i.exec(text);
        if(start){
          const kind='social' as const;
          const owner=this.store.ownerFor(this.store.destination());
          if(owner&&this.contracts.hasPendingOwner(owner,this.store.destination()??'')){
            reply('Finish or cancel the pending task contract before starting Social.');return {status:'handled',requestId:m.id};
          }
          this.guidedModes.start(this,m,kind);
          mode=this.guidedModes.get(this,m);
          if(!start[2]?.trim()){
            reply('What would you like to create posts about, and for which platforms? Send /back to leave.');return {status:'handled',requestId:m.id};
          }
        }
        // A tool mode picked after /social (/muse, /cursor, /deepseek) owns plain messages until /back.
        if(mode&&(!!start||!text.startsWith('/')&&!toolSelected(this))){
          if(brainSelected(this)){
            // Brain remains a router. Its chosen native executor receives the
            // same task mode, without silently switching the user's executor.
            if(!await this.brain.handle(this,m,true))throw Error('Brain is unavailable. Task mode remains selected; nothing was sent to another session.');
            this.pump();return {status:this.store.job(m.id)?'queued':'handled',requestId:m.id};
          }
          const active=this.guidedModes.begin(this,m);if(!active){reply('A request is still being processed. Please wait.');return {status:'handled',requestId:m.id};}
          try {
            prepareSpecialties(this.store);
            const b=mode.kind==='social'&&active.socialTarget?this.need(active.socialTarget.bindingId):specialtyTarget(this,m);
            if(mode.kind==='social'){
              const target={bindingId:b.id,identity:specialtyIdentity(this.store,b),epoch:specialtyEpoch(this.store)};
              if(active.socialTarget&&JSON.stringify(active.socialTarget)!==JSON.stringify(target)){
                this.guidedModes.close(this,m);
                throw new Error('Your selected session changed. Send /social again to start a new request. Nothing was sent to another session.');
              }
              active.socialTarget=target;
              active.imageProvider=requestedSocialImageProvider(m.text)??active.imageProvider??'local';
            }
            const marker=markPendingSpecialty(this.store,m.id,b,mode.kind,socialSpecialty(active.imageProvider),m.text,active.imageProvider);
            // Social creates content drafts; the optional contract is for coding
            // tasks. Pending contracts were already handled above, and the
            // selected native session asks any missing content questions.
            if(mode.kind!=='social'&&this.contracts.enabled()&&!contractApproved){
              const result=await this.contracts.preflight(this,m,m.text,undefined,undefined,false,false,true);
              if(result.kind==='handled')return {status:'handled',requestId:m.id};
              if(result.kind==='replay')return await this.receiveOnce(result.incoming,true);
            }
            return this.queueSpecialty(m,m.id,marker);
          } finally {this.guidedModes.end(active,this,m);}
        }
      }
      if(/^greenhouse jobs\s*;/i.test(m.text.trim())&&await this.errands.start(m))return {status:'handled',requestId:m.id};
      // A quoted native answer is data even when it starts with a slash.
      if(m.ownerCommand===false&&text.startsWith('/')){this.store.output(undefined,'Type commands as a new text message, not in a quote, forward, file or voice note.',`command:${m.id}`);this.store.remember(m.id);return {status:'blocked',requestId:m.id};}
      ownerReply=!!m.ownerCommand&&isOwnerCommand(text);const commandReply=ownerReply?await ownerCommand(this,m):undefined;ownerReply=false;
      if(commandReply!==undefined){
        if(/^\/(?:claude|codex|brain)(?:\s|$)/i.test(text)){this.guidedModes.retarget(this);}
        this.store.output(undefined,commandReply+(commandReply?'\n\n'+this.guidedModes.summary(this,m):''),`command:${m.id}`,undefined,{plain:true});this.store.remember(m.id);return {status:'handled',requestId:m.id};
      }
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
        else if(cmd==='proof'){
          if(!this.proofBindings)throw new Error('Proof binding is unavailable.');
          this.store.db.exec('SAVEPOINT proof_bind_command');
          try{
            const binding=this.proofBindings.approve(m);
            this.store.output(undefined,`Saved your binding for ${binding.checkName} in ${binding.repository}. This does not verify the task or any run.`, `command:${m.id}`,undefined,{plain:true});
            this.store.remember(m.id);this.store.db.exec('RELEASE proof_bind_command');return {status:'handled',requestId:m.id};
          }catch(e){this.store.db.exec('ROLLBACK TO proof_bind_command; RELEASE proof_bind_command');throw e;}
        }
        else if(cmd==='workspace'){if(!this.workspaceCommand)throw new Error('Workspace creation is unavailable.');this.store.output(undefined,this.workspaceCommand(args),`command:${m.id}`);}
        else if(cmd==='sessions')this.store.output(undefined,this.store.bindings().map(b=>`${b.enabled?'●':'○'} ${b.alias} · ${b.provider} · ${b.mode}`).join('\n')||'No sessions registered. Open Session Bridge.app.',`command:${m.id}`);
        else if(cmd==='use') {const b=this.need(args);clearOwnerTarget(this);this.store.set('active',b.id);this.guidedModes.retarget(this);this.store.output(b,'Selected. Your next messages go to this exact session.\n\n'+this.guidedModes.summary(this,m),`command:${m.id}`);}
        else if(cmd==='talk'){const message=this.talkDirect(this.need(args));this.guidedModes.retarget(this);this.store.output(undefined,message+'\n\n'+this.guidedModes.summary(this,m),`command:${m.id}`);}
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
          else {this.assertNotDuplicate(undefined,text,m.id);this.coordinator.routeToMaster(m.id,text);this.store.remember(m.id);this.pump();return {status:'queued',requestId:m.id};}
        } else if(this.coordinator&&(b=directSession(this.store,id=>this.coordinator!.isCoordinator(id)))) {
          const item=this.coordinator.items().list().find(i=>i.binding_id===b!.id);if(item)this.store.linkItem(m.id,item.id);
        } else if(this.coordinator){
          if(await this.brain.handle(this,m)) {
            this.store.remember(m.id);this.pump();
            const blocked=this.brain.get(m.id)?.state==='blocked';
            return {status:blocked?'blocked':this.store.job(m.id)?'queued':'handled',requestId:m.id,...(blocked?{code:'routing_unavailable'}:{})};
          }
          this.assertNotDuplicate(undefined,text,m.id);
          this.coordinator.routeToMaster(m.id,text);this.store.remember(m.id);this.pump();return {status:'queued',requestId:m.id};
        }
        else b=this.store.binding(this.store.get('active')??'');
        if(!b)throw new Error('Choose a proxy in the app, then ask me to show your recent sessions.');
        // The owner repeating themselves while the first copy is still unanswered is a retry, not a second task.
        this.assertNotDuplicate(b,text,m.id);
        this.queue(m.id,this.need(b.id),text);
      }
      this.store.remember(m.id);
    } catch(e) {if(!this.store.incomingOwnerCurrent())return {status:'blocked',requestId:m.id,code:'routing_unavailable'};this.store.output(undefined,(e as Error).message,`command-error:${m.id}`,undefined,ownerReply||e instanceof DuplicateOwnerRequest?{plain:true}:{});this.store.remember(m.id);this.store.event(m.id,'routing_failed',{code:errorCode(e)});return {status:'blocked',requestId:m.id,code:errorCode(e)};}
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
    if(job.status==='completed'){
      if(job.outcome!==outcome)throw new Error('This request already has a different outcome.');
      if(outcome==='done'&&master)try{queueReportedProof(this,master,id);}catch{}
      return;
    }
    const children=this.store.db.prepare(`SELECT i.id,i.binding_id FROM inbox i JOIN settings s ON s.key='parent:'||i.id WHERE s.value=?`).all(id) as {id:string;binding_id:string}[];
    const related=new Set([job.binding_id,...children.map(c=>c.binding_id)]);
    const pendingReports=this.store.db.prepare(`SELECT i.id FROM inbox i LEFT JOIN settings s ON s.key='report-parent:'||i.id LEFT JOIN settings legacy ON legacy.key='parent:'||substr(i.id,8) WHERE i.id LIKE 'report:%' AND COALESCE(s.value,legacy.value)=? AND i.status NOT IN ('completed','reviewed','auto_closed','replaced')`).all(id) as {id:string}[];
    if(this.hasPendingCreation?.(id)||this.unfinishedChildren(id)||pendingReports.some(r=>r.id!==acknowledgingReport)||[...this.approvals.pending.values()].some(p=>related.has(p.binding.id)))throw new Error('Finish or review delegated work, reports and pending approvals before resolving the owner request.');
    this.store.jobState(id,'completed',null,outcome);this.store.event(id,'owner_resolved',{outcome});
    if(outcome==='done'&&master)try{queueReportedProof(this,master,id);}catch{}
    if(id.startsWith('master:')&&master)this.coordinator?.workerReply(master,`Delegated work resolved: ${outcome}.`,id,true,'final');
  }
  requestProtected(id:string,bindingId:string) {
    if(this.errands.isActive(id))return true;
    if(this.busy.has(bindingId)||this.store.hasDispatched(bindingId)||[...this.approvals.pending.values()].some(p=>p.binding.id===bindingId))return true;
    // A parent's tracking must remain open while delegated requests are outstanding.
    return !!this.store.db.prepare(`SELECT 1 FROM inbox i JOIN settings s ON s.key='parent:'||i.id
      WHERE s.value=? AND i.status IN ('queued','dispatched','submitted','uncertain','failed') LIMIT 1`).get(id);
  }
  /** One lsappinfo per app per maintenance tick; receipts and notices read the cached answer. */
  probeApps() {
    void probeDesktopApps().then(r=>this.recordLiveness(r)).catch(()=>{});
    this.settleDeliveryHolds();
  }
  /** Replaced in tests so receipts do not depend on which desktop apps happen to be open. */
  livenessProbe:()=>{codex:boolean;claude:boolean}=probeDesktopAppsNow;
  /** Replaced in tests so a held message never opens the owner's real app. */
  openTarget:(b:Binding)=>Promise<void>=openTarget;
  /** The model that writes companion notice wording. Replaced in tests. */
  noticeModel=new MetaModel();
  private recordLiveness(live:{codex:boolean;claude:boolean}) {
    for(const provider of ['codex','claude'] as Provider[]){
      if(provider==='muse'||provider==='deepseek'||provider==='cursor')continue;
      const next=String(live[provider]),previous=this.store.get(`app-running:${provider}`);
      this.store.set(`app-running:${provider}`,next);
      this.store.set(`app-running:${provider}:at`,String(Date.now()));
      if(previous==='true'&&next==='false')this.announceClosed(provider);
    }
  }
  /**
   * The receipt can only speak for the moment it was written. A minute-old cached answer said
   * "queued" for an app that had already quit, so probe once per owner message instead.
   */
  private receiptWithLiveness(id:string,b:Binding) {
    // Muse Code and DeepSeek Harness are CLIs with no companion desktop app, so they are never "closed".
    if(b.provider==='muse'){this.store.set('app-running:muse','true');queueOwnerReceipt(this.store,id,b);return;}
    if(b.provider==='deepseek'){this.store.set('app-running:deepseek','true');queueOwnerReceipt(this.store,id,b);return;}
    if(b.provider==='cursor'){this.store.set('app-running:cursor','true');queueOwnerReceipt(this.store,id,b);return;}
    const live=this.livenessProbe();
    this.store.set(`app-running:${b.provider}`,String(live[b.provider]));
    this.store.set(`app-running:${b.provider}:at`,String(Date.now()));
    queueOwnerReceipt(this.store,id,b);
  }
  /**
   * The receipt is the one moment when the owner still has a choice, so a closed app asks
   * instead of only promising. Everything downstream assumes the message may already be inside
   * the app's own queue, which cannot be cancelled.
   */
  private ownerReceipt(id:string,b:Binding) {
    // Muse Code and DeepSeek Harness are CLIs with no companion desktop app, so they are never "closed".
    if(b.provider==='muse'){this.store.set('app-running:muse','true');queueOwnerReceipt(this.store,id,b);return;}
    if(b.provider==='deepseek'){this.store.set('app-running:deepseek','true');queueOwnerReceipt(this.store,id,b);return;}
    if(b.provider==='cursor'){this.store.set('app-running:cursor','true');queueOwnerReceipt(this.store,id,b);return;}
    // One fresh probe per owner message: a minute-old answer is how a closed app still read "queued".
    const live=this.livenessProbe();
    this.store.set(`app-running:${b.provider}`,String(live[b.provider]));
    this.store.set(`app-running:${b.provider}:at`,String(Date.now()));
    if(this.holdClosedTarget(id,b))return;
    queueOwnerReceipt(this.store,id,b);
  }
  /**
   * Hold a message for a closed desktop app, and ask where it should go.
   *
   * Codex takes queued work through `codex queue`, which has no list and no cancel, so a message
   * handed over cannot be moved afterwards without risking the same task running twice. Holding
   * it in the bridge keeps "one message, one session" true. A hold only happens when another
   * session can genuinely take the work now; otherwise the ordinary receipt stands, and the
   * escalation card below still offers to open the app.
   */
  private holdClosedTarget(id:string,b:Binding):boolean {
    try {
      // Only the owner's own message is worth asking about; reports and coordinator traffic are not.
      if(!/^(wa|tg):/.test(id))return false;
      if(b.provider==='muse'||b.provider==='deepseek'||b.provider==='cursor')return false;
      if(this.store.get(`execution-mode:${b.id}`)!=='desktop')return false;
      if(this.appOnline(b.provider))return false;
      // A contract, a schedule or an earlier choice owns this dispatch. Never stand in front of it.
      if(this.contracts.hasGuard(id)||this.contracts.hasOptionGuard(id)||hasScheduleGuard(this,id))return false;
      const job=this.store.job(id),destination=this.store.destination();
      if(!job||job.status!=='queued'||!destination)return false;
      const owner=this.store.captureIncomingOwner(destination,this.store.controlChannel());
      if(!owner)return false;
      const alternatives=deliveryAlternatives(this.store,b,id=>!!this.coordinator?.isCoordinator(id),provider=>this.appOnline(provider as Provider));
      if(!alternatives.length)return false;
      const at=Date.now();
      saveDeliveryHold(this.store,{requestId:id,bindingId:b.id,...holdTarget(this.store,b),body:job.body,destination,
        owner:owner.owner,channel:owner.channel,alternatives,at,expiresAt:at+DELIVERY_CHOICE_MINUTES*60_000});
      this.store.event(id,'delivery_held',{provider:b.provider,alternatives:alternatives.length});
      void this.sendHeldCard(id,b,owner).catch(e=>{
        // The hold must never outlive its card: without a card the owner cannot answer.
        if(!this.stopped)console.error(`Held-message card failed: ${e instanceof Error?e.message:'unknown failure'}`);
        try{releaseDeliveryHold(this.store,id);this.pump();}catch{/* the bridge is stopping */ }
      });
      return true;
    } catch(e) {
      if(!this.stopped)console.error(`Delivery choice failed: ${e instanceof Error?e.message:'unknown failure'}`);
      return false;
    }
  }
  /** One card per held message. The brain writes the lead when it is configured, never the facts. */
  private async sendHeldCard(id:string,b:Binding,owner:NonNullable<ReturnType<Store['captureIncomingOwner']>>) {
    const hold=readDeliveryHold(this.store,id);if(!hold)return;
    const running=runningApps(this.store);
    const card=heldCard({short:false,lead:'',hold,running});
    const {lead}=await composeNotice({store:this.store,secret:this.brain.secret,model:this.noticeModel,
      facts:{state:'closed',app:hold.app,session:hold.session,folder:hold.folder,running,alternatives:hold.alternatives.map(a=>a.label),
        held:true,options:card.choices.map(c=>c.label),expiresMinutes:DELIVERY_CHOICE_MINUTES},
      fallback:CLOSED_FALLBACK(hold.app,hold.session)});
    // Writing the wording is asynchronous, so the bridge can shut down or be paused meanwhile.
    if(this.stopped||this.paused)return;
    try {
      this.store.incomingOwnerContext.run(owner,()=>{
        if(!this.store.incomingOwnerCurrent()){releaseDeliveryHold(this.store,id);return;}
        const current=readDeliveryHold(this.store,id),job=this.store.job(id);
        // The app may have opened on its own, or the request moved on, while the wording was written.
        if(!current||!job||job.status!=='queued'){releaseDeliveryHold(this.store,id);return;}
        const filled=heldCard({short:current.destination.startsWith('tg:'),lead,hold:current,running});
        const optionId=this.sendChoices(b,id,current.destination,filled,`delivery-choice:${id}`,'delivery');
        if(optionId)saveDeliveryHold(this.store,{...current,optionId});
      });
      this.pump();
    } catch(e) {
      // The message is never held without its card: release it so the ordinary path takes over.
      if(!this.stopped)console.error(`Held-message card failed: ${e instanceof Error?e.message:'unknown failure'}`);
      try{releaseDeliveryHold(this.store,id);}catch{/* the bridge is stopping */ }
    }
  }
  /** Write a card and attach its choices as action options, so an answer runs bridge code. */
  private sendChoices(binding:Binding,requestId:string,destination:string,card:{text:string;choices:{id:string;label:string}[]},source:string,kind:string):string|undefined {
    this.store.output(binding,card.text,source,destination,{requestId,kind:'system',origin:'system',plain:true});
    const row=this.store.db.prepare('SELECT id FROM outbox WHERE source=?').get(`${source}:0`) as {id:string}|undefined;
    if(!row)return undefined;
    const optionId=createOptions(this.store,row.id,requestId,binding.id,destination,{choices:card.choices,expiresInSeconds:DELIVERY_CHOICE_MINUTES*60},binding);
    markActionOption(this.store,optionId,kind);
    return optionId;
  }
  /** A hold ends by itself: the app opened, the choice expired, or the request moved on. */
  settleDeliveryHolds() {
    for(const hold of openHolds(this.store)){
      try {
        const job=this.store.job(hold.requestId),binding=this.store.binding(hold.bindingId);
        if(!job||!binding||job.status!=='queued'){releaseDeliveryHold(this.store,hold.requestId);continue;}
        if(this.appOnline(binding.provider)){
          this.releaseHeld(hold,`✅ ${hold.app} is open now, so your held message is on its way to ${hold.session}.`,'delivery-opened');
          continue;
        }
        if(Date.now()>=hold.expiresAt)this.releaseHeld(hold,`⌛️ I had no answer for ${DELIVERY_CHOICE_MINUTES} minutes, so your message goes to ${hold.app} as usual and runs when the app opens.`,'delivery-expired');
      } catch(e) {
        console.error(`Delivery hold could not be settled: ${e instanceof Error?e.message:'unknown failure'}`);
      }
    }
  }
  private releaseHeld(hold:{requestId:string;bindingId:string;destination:string},text:string,source:string) {
    releaseDeliveryHold(this.store,hold.requestId);
    this.store.output(this.store.binding(hold.bindingId),text,`${source}:${hold.requestId}`,hold.destination,{requestId:hold.requestId,kind:'system',origin:'system',plain:true});
    this.store.event(hold.requestId,source==='delivery-expired'?'delivery_choice_expired':'delivery_app_opened');
    this.pump();
  }
  /** The escalation card: the message is already inside the app's queue, so opening it is all we can offer. */
  private async sendWakeCard(id:string,b:Binding,destination:string,minutes:number) {
    const app=sessionShortName(this.store,b)||b.alias,name=this.store.get(`name:${b.id}`)??b.alias;
    const card=escalatedCard({short:destination.startsWith('tg:'),lead:'',app,session:name,minutes});
    const {lead}=await composeNotice({store:this.store,secret:this.brain.secret,model:this.noticeModel,
      facts:{state:'escalated',app,session:name,running:runningApps(this.store),held:false,minutes,options:card.choices.map(c=>c.label)},
      fallback:ESCALATED_FALLBACK(app,minutes)});
    if(this.stopped||this.paused)return;
    // A wake card is a courtesy on top of an already-submitted message, so it fails quietly.
    try {
      if(!this.store.incomingOwnerCurrent())return;
      const filled=escalatedCard({short:destination.startsWith('tg:'),lead,app,session:name,minutes});
      this.sendChoices(b,id,destination,filled,`silence:${id}:2`,'wake');
    } catch(e) {
      if(!this.stopped)console.error(`Escalation card failed: ${e instanceof Error?e.message:'unknown failure'}`);
    }
  }
  /** Carry out the owner's answer. Each branch says what is true before and after it acts. */
  private applyDeliveryChoice(answerId:string,row:any,choice:{id:string;label:string}):void {
    void this.runDeliveryChoice(answerId,row,choice).catch(e=>{
      const hold=readDeliveryHold(this.store,row.request_id);
      const text=`⚠️ I could not do that: ${e instanceof Error?e.message:'unknown failure'}. ${hold?`Your message is still held for ${hold.app}; ask again or send it yourself.`:'Nothing was changed.'}`;
      try{this.store.output(this.store.binding(row.binding_id),text,`delivery-choice-error:${row.id}`,row.destination,{requestId:row.request_id,kind:'system',origin:'system',plain:true});}catch{}
    });
  }
  private async runDeliveryChoice(answerId:string,row:any,choice:{id:string;label:string}) {
    const hold=readDeliveryHold(this.store,row.request_id);
    const binding=this.store.binding(row.binding_id);if(!binding)throw new Error('that session no longer exists');
    const destination=row.destination as string,app=hold?.app??(sessionShortName(this.store,binding)||binding.alias);
    const say=(text:string,source:string)=>this.store.output(binding,text,`${source}:${answerId}`,destination,{requestId:row.request_id,kind:'system',origin:'system',plain:true});
    if(choice.id==='wait'){
      if(hold){releaseDeliveryHold(this.store,hold.requestId);say(`👍 Kept for ${hold.session}. It sends as soon as ${hold.app} opens.`,'delivery-wait');this.pump();}
      else say(`👍 Left with ${app}. It runs as soon as the app is ready.`,'delivery-wait');
      return;
    }
    if(choice.id==='open'){
      say(`🔓 Opening ${app}…`,'delivery-open');
      await this.openTarget(binding);
      if(hold){
        releaseDeliveryHold(this.store,hold.requestId);
        this.store.event(hold.requestId,'delivery_opened');
        say(`✅ ${app} is open. Sending your message to ${hold.session} now; I will tell you as soon as it answers.`,'delivery-opened');
        this.pump();
      } else say(`✅ ${app} is open. It will pick up the queued message for ${binding.id===row.binding_id?sessionShortName(this.store,binding)||binding.alias:'that session'}.`,'delivery-opened');
      return;
    }
    const match=/^switch([1-9])$/.exec(choice.id),alternative=match?hold?.alternatives[Number(match[1])-1]:undefined;
    if(!hold||!alternative)throw new Error('that session is no longer offered');
    const target=this.store.binding(alternative.bindingId);
    if(!target||!target.enabled)throw new Error('that session is no longer connected');
    if(target.provider!=='muse'&&target.provider!=='deepseek'&&target.provider!=='cursor'&&(process.platform==='darwin'?!this.appOnline(target.provider):appClosedFor(this.store,target)))throw new Error(`${sessionShortName(this.store,target)} is not running now`);
    say(`➡️ Sending this to ${alternative.label}…`,'delivery-move');
    // The held copy was never submitted, so closing it cannot leave the task running twice.
    this.store.jobState(hold.requestId,'replaced','You moved this message to another session before it was sent.');
    releaseDeliveryHold(this.store,hold.requestId);
    const item=this.store.itemOf(hold.requestId);
    this.queue(answerId,target,hold.body);
    if(item)this.store.linkItem(answerId,item);
    say(`✅ Sent to ${alternative.label}. ${hold.app} never received it, so it will not run twice. I will tell you when it answers.`,'delivery-moved');
    this.pump();
  }
  /** An app that quits while a message waits corrects the receipt at once, not at the next reminder. */
  private announceClosed(provider:Provider) {
    try {
      const pending=this.store.db.prepare("SELECT id FROM inbox WHERE status IN ('queued','dispatched','submitted') AND created_at>? ORDER BY created_at").all(Date.now()-3_600_000) as {id:string}[];
      for(const {id} of pending){
        if(!/^(wa|tg):/.test(id))continue;
        const job=this.store.job(id);
        if(!job||job.first_reply_at)continue;
        // A held message already has its own card; a second "closed since" line would only confuse.
        if(readDeliveryHold(this.store,id))continue;
        const binding=this.store.binding(job.binding_id);
        if(!binding||binding.provider!==provider)continue;
        // Off macOS a CLI connection does not wait on the desktop app.
        if(process.platform!=='darwin'&&!appClosedFor(this.store,binding))continue;
        if(this.store.db.prepare('SELECT 1 FROM reply_receipts WHERE source=?').get(`closed:${id}`))continue;
        this.store.output(binding,closedAfterQueueText(sessionShortName(this.store,binding)),`closed:${id}`,
          job.destination??this.store.destination(),{kind:'system',origin:'system',plain:true,requestId:id});
        this.store.event(id,'app_closed',{provider});
      }
    } catch(e) { console.error(`Closed-app notice failed: ${e instanceof Error?e.message:'unknown failure'}`); }
  }
  appOnline(provider:Provider) { return provider==='muse'||provider==='deepseek'||provider==='cursor'||this.store.get(`app-running:${provider}`)!=='false'; }
  private clearSilenceTimers() { for(const timer of this.silenceTimers.values())clearTimeout(timer);this.silenceTimers.clear(); }
  /**
   * Accepted by the queue is not an answer. When a submitted request goes quiet, say so once and
   * once more with what to do, instead of leaving a promise as the last thing the owner reads.
   */
  private watchSilence(id:string,b:Binding,destination:string|null) {
    if(this.silenceNoticeMs<=0||this.paused||id.startsWith('report:'))return;
    const previous=this.silenceTimers.get(id);if(previous)clearTimeout(previous);
    const name=sessionShortName(this.store,b)||this.store.get(`name:${b.id}`)||b.alias;
    const arm=(delay:number,stage:number)=>{
      const timer=setTimeout(()=>{
        this.silenceTimers.delete(id);
        const job=this.store.job(id);
        if(this.paused||!job||job.first_reply_at||!['dispatched','submitted','queued'].includes(job.status))return;
        const closed=process.platform==='darwin'?!this.appOnline(b.provider):appClosedFor(this.store,b);
        this.store.event(id,stage===1?'silence_notice':'silence_escalated',{stage,appRunning:!closed});
        const minutes=Math.max(1,Math.round((Date.now()-job.created_at)/60000));
        const target=destination??this.store.get('whatsapp-owner')??null;
        // A closed desktop app gets real buttons instead of advice: the message is already in its
        // own queue, so opening the app is the one thing that can still move this forward.
        if(stage===2&&closed&&target&&(b.provider==='codex'||b.provider==='claude')&&this.store.get(`execution-mode:${b.id}`)==='desktop'){
          void this.sendWakeCard(id,b,target,minutes).catch(e=>console.error(`Escalation card failed: ${e instanceof Error?e.message:'unknown failure'}`));
          return;
        }
        const text=stage===1
          ?(closed?`📴 ${name} is closed. Your message is queued and runs when the app opens.`:`⏳ ${name} has not started this yet.`)
          :`⚠️ Still no answer from ${name} after ${minutes} min. Open the app to continue, or send /status.`;
        this.store.output(b,text,`silence:${id}:${stage}`,target,{requestId:id,kind:'system',origin:'system',plain:true});
        if(stage===1)arm(this.silenceEscalateMs,2);
      },delay);
      timer.unref?.();
      this.silenceTimers.set(id,timer);
    };
    arm(this.silenceNoticeMs,1);
  }
  /** Throw when the owner's words are already waiting for an answer. */
  private assertNotDuplicate(b:Binding|undefined,text:string,id:string) {
    const target=b??this.coordinator?.master();
    if(!target)return;
    const duplicate=this.pendingDuplicate(target,text,id);
    if(duplicate)throw new DuplicateOwnerRequest(`⏳ Same message, already waiting ${duplicate.minutes} min for ${sessionShortName(this.store,target)||target.alias}. Nothing new was sent.`);
  }
  /** The same words already waiting for an answer are a retry, not another request. */
  private pendingDuplicate(b:Binding,text:string,id:string) {
    if(this.store.job(id))return undefined;
    const words=text.replace(/\s+/g,' ').trim().toLowerCase();
    if(!words)return undefined;
    const rows=this.store.db.prepare("SELECT id,body,created_at FROM inbox WHERE binding_id=? AND created_at>? AND status IN ('queued','dispatched','submitted') ORDER BY created_at DESC LIMIT 20")
      .all(b.id,Date.now()-10*60_000) as {id:string;body:string;created_at:number}[];
    const match=rows.find(row=>row.body.replace(/\s+/g,' ').trim().toLowerCase()===words);
    return match?{id:match.id,minutes:Math.max(1,Math.round((Date.now()-match.created_at)/60000))}:undefined;
  }
  /** Closing an unanswered request silently is how a receipt becomes the last word. */
  private notifyAutoClosed(jobs:ReturnType<Store['pendingJobs']>) {
    if(this.paused||!jobs.length)return;
    const silent=jobs.filter(job=>!job.first_reply_at&&!job.id.startsWith('report:'));
    if(!silent.length)return;
    const destination=silent[0].destination??this.store.get('whatsapp-owner')??null;
    if(silent.length>3) {
      this.store.output(undefined,`⚠️ ${silent.length} requests were closed without an answer. Nothing was resent.`, `auto-closed:batch:${silent[0].id}`,destination,{kind:'system',origin:'system',plain:true});
      return;
    }
    for(const job of silent) {
      const b=this.store.binding(job.binding_id);if(!b)continue;
      const name=sessionShortName(this.store,b)||this.store.get(`name:${b.id}`)||b.alias;
      this.store.output(b,`⚠️ ${name} never answered this. Closed without a reply; nothing was resent.`,`auto-closed:${job.id}`,job.destination??this.store.get('whatsapp-owner')??null,{requestId:job.id,kind:'system',origin:'system',plain:true});
    }
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
    const closedJobs:ReturnType<Store['pendingJobs']>=[];
    for(const j of this.store.pendingJobs()) {
      if(!['submitted','uncertain','failed'].includes(j.status)||(j.updated_at??j.created_at)>now-policy.afterHours*3600000||this.requestProtected(j.id,j.binding_id))continue;
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        this.store.jobState(j.id,'auto_closed');
        this.store.audit('request-auto-closed',j.binding_id,JSON.stringify({requestId:j.id,previousStatus:j.status,afterHours:policy.afterHours}));
        this.store.db.exec('COMMIT');closedJobs.push(this.store.job(j.id)!);
      }catch(e){this.store.db.exec('ROLLBACK');throw e;}
    }
    this.notifyAutoClosed(closedJobs);
    return closedJobs.length;
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
  private queueSpecialty(m:Incoming,originId:string,marker:PendingSpecialty) {
    const current=pendingSpecialty(this.store,originId,m.text),b=this.store.binding(marker.bindingId);
    if(!current||JSON.stringify(current)!==JSON.stringify(marker)||!b||!this.store.incomingOwnerCurrent())throw new Error('The selected session or request changed. Nothing was sent.');
    this.store.db.exec('SAVEPOINT specialty_queue');
    try {
      captureGuidedResearchRequest(this.store,this,m,marker.kind);
      this.queue(m.id,b,m.text);
      bindSessionSpecialty(this.store,m.id,b,marker.kind,marker.instructions,marker.imageProvider);
      this.store.remember(m.id);
      this.store.db.exec('RELEASE specialty_queue');
    }catch(e){this.store.db.exec('ROLLBACK TO specialty_queue; RELEASE specialty_queue');throw e;}
    this.pump();return {status:'queued' as const,requestId:m.id};
  }
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
      if(!exists&&this.coordinator?.isCoordinator(b.id))this.ownerReceipt(id,b);
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
      if(guard.owner_generation&&guard.owner_generation===(this.store.get('incoming-owner-generation')??'')&&briefDestinationValid(this.store,guard.destination,guard.owner)&&this.store.incomingOwnerCurrent()&&(!this.store.incomingOwnerContext.getStore()||this.store.incomingOwnerContext.getStore()!.destination===guard.destination))this.store.output(undefined,message,`brief-action-error:${job.id}`,guard.destination,{requestId:job.id,kind:'system',origin:'system',plain:true});
      this.store.db.exec('RELEASE reject_brief_dispatch');
    }catch(e){this.store.db.exec('ROLLBACK TO reject_brief_dispatch; RELEASE reject_brief_dispatch');throw e;}
  }
  /** Called before every channel/native submit; future dispatch guards share this boundary. */
  assertDispatchAllowed(id:string,b:Binding){
    const scheduled=hasScheduleGuard(this,id),guard=briefDispatchGuard(this.store,id),contract=this.contracts.hasGuard(id),choice=this.contracts.hasOptionGuard(id),collaboration=this.collaboration?.has(id)??false,specialty=hasSessionSpecialty(this.store,id),held=heldDelivery(this.store,id);
    if(!collaboration)this.collaboration?.assertOrdinaryDispatch(id,b);
    if(!scheduled&&!guard&&!contract&&!choice&&!collaboration&&!specialty&&!held)return false;
    const job=this.store.job(id);if(!job)throw new DispatchNotSubmittedError('The request no longer exists.');
    // The owner has been asked where this should go. Nothing is submitted until they answer.
    if(held){
      const hold=readDeliveryHold(this.store,id);
      if(!hold||hold.bindingId!==b.id)throw new DispatchNotSubmittedError('The session changed while this message was held. Nothing was sent.');
      throw new DeliveryChoiceHold(`${hold.app} is closed. This message is held until you choose where it goes.`);
    }
    if(specialty&&sessionSpecialty(this.store,id)?.bindingId!==b.id)throw new DispatchNotSubmittedError('The selected session or request changed. Nothing was sent.');
    if(scheduled){
      const state=job.binding_id===b.id?scheduleJobState(this,id):'invalid';
      if(state==='hold')throw new ScheduledChannelHold('Scheduled request held until its original channel is active.');
      if(state==='invalid'){const reason='The scheduled request was not sent because its owner or session changed.';this.failBeforeSubmission(id,reason);throw new DispatchNotSubmittedError(reason);}
    }
    if(choice){try{this.contracts.assertOption(this,id,b,true);}catch{throw new DispatchNotSubmittedError('The original choice or session changed. Nothing was sent.');}if(this.contracts.optionChannel(id)!==this.store.controlChannel())throw new ScheduledChannelHold('Choice held until its original channel is active.');}
    if(contract){const approved=this.contracts.approved(id);if(approved&&this.store.controlChannel()!==approved.channel){try{this.contracts.assertDispatch(this,id,b,job.body,new Set(),true);}catch{throw new DispatchNotSubmittedError('The approved task or session changed. Nothing was sent.');}throw new ScheduledChannelHold('Task held until its original channel is active.');}try{this.contracts.assertDispatch(this,id,b,job.body);}catch{throw new DispatchNotSubmittedError('The approved task or session changed. Nothing was sent.');}}
    if(guard&&!briefDispatchValid(this,job,b)){this.rejectBriefDispatch(job);throw new BriefDispatchError();}
    if(collaboration)this.collaboration!.assertDispatch(id,b);
    return true;
  }
  failBeforeSubmission(id:string,reason:string){
    this.rejectBriefDispatch(this.store.job(id),reason);failScheduledBeforeSubmission(this,id,reason);this.contracts.rejectDispatch(id,reason);
    const j=this.store.job(id);
    if(j&&(this.contracts.hasOptionGuard(id)||hasSessionSpecialty(this.store,id))&&['queued','dispatched'].includes(j.status)){
      this.store.jobState(id,'failed',reason);
      const destination=hasSessionSpecialty(this.store,id)?specialtyNoticeDestination(this.store,id):undefined;
      if(destination&&this.store.incomingOwnerCurrent())this.store.output(undefined,reason,`specialty-not-sent:${id}`,destination,{requestId:id,kind:'system',origin:'system',plain:true});
    }
    this.collaboration?.reject(id,reason);
    // Any other request refused before submission must end visibly; left as 'dispatched' it would wait forever.
    const left=this.store.job(id);
    if(left&&['queued','dispatched'].includes(left.status)){
      this.store.jobState(id,'failed',reason);
      const destination=left.destination??this.store.get('whatsapp-owner')??null;
      if(destination&&!id.startsWith('report:')&&this.store.incomingOwnerCurrent())this.store.output(this.store.binding(left.binding_id)??undefined,reason,`not-sent:${id}`,destination,{requestId:id,kind:'system',origin:'system',plain:true});
    }
  }
  private routableJob(b:Binding) {
    for(;;){
      const channel=this.store.controlChannel();
      const jobs=this.store.db.prepare(`SELECT i.* FROM inbox i LEFT JOIN schedule_jobs s ON s.job_id=i.id
        LEFT JOIN task_contract_jobs cj ON cj.job_id=i.id LEFT JOIN task_contracts c ON c.id=cj.contract_id OR c.dispatch_id=i.id LEFT JOIN task_contract_option_proofs p ON p.job_id=i.id
        WHERE i.binding_id=? AND i.status='queued' AND (s.job_id IS NULL OR s.channel=?) AND (c.id IS NULL OR c.channel=?) AND (p.job_id IS NULL OR p.channel=?) ORDER BY i.created_at,i.rowid${this.collaboration?'':' LIMIT 1'}`).all(b.id,channel,channel,channel) as unknown as import('./store.js').Job[];
      const job=jobs.find(j=>!this.collaboration?.shouldHold(j.id));if(!job)return;
      const state=scheduleJobState(this,job.id);
      if(state==='hold')return;
      if(state==='invalid'){this.failBeforeSubmission(job.id,'The paired owner or session changed; scheduled request was not sent.');if(this.store.job(job.id)?.status==='queued')this.store.jobState(job.id,'failed','Request ownership is unavailable; nothing was sent.');continue;}
      return job;
    }
  }
  pump() {
    // A turn whose owner was revoked must not drive unrelated queued work.
    if(this.stopped||!this.store.incomingOwnerCurrent())return;
    this.brain.tick(this);
    for(const job of this.store.db.prepare("SELECT i.* FROM inbox i JOIN brief_dispatch_guards g ON g.request_id=i.id WHERE i.status='queued'").all() as unknown as import('./store.js').Job[]){
      if(!briefDispatchValid(this,job))this.rejectBriefDispatch(job);
    }
    for(const b of this.store.bindings()) {
      // A channel-mode session is pulled by its own client. Muse and DeepSeek have no client and
      // no app: the bridge runs one headless turn per request, so they are pumped like a CLI session.
      if(!b.enabled||(b.mode==='channel'&&b.provider!=='muse'&&b.provider!=='deepseek'&&b.provider!=='cursor')||this.busy.has(b.id))continue;
      const job=this.routableJob(b);if(!job)continue;
      const origin=this.store.incomingOwnerContext.getStore();
      // Wait for a neutral timer rather than inherit another chat's context.
      if(origin&&briefDispatchGuard(this.store,job.id)&&origin.destination!==job.destination)continue;
      // The claim and attempt belong to one SQLite transaction: a failed or
      // concurrent dispatch must never leave an orphaned claim behind.
      const collaboration=this.collaboration?.has(job.id)??false;
      const fence=!!this.collaboration;
      if(fence)this.store.db.exec('SAVEPOINT collaboration_dispatch');
      try{
        if(fence&&this.store.job(job.id)?.status!=='queued')throw new CollaborationHold('The request is no longer queued.');
        this.assertDispatchAllowed(job.id,b);
        const attempt=collaboration?this.collaboration!.reserveDispatchAttempt(job.id):this.collaboration?.reserveWorkflowReport(job.id,b);
        this.store.jobState(job.id,'dispatched',null,undefined,attempt);
        if(collaboration)this.collaboration!.captureDispatchAttempt(job.id);
        if(fence)this.store.db.exec('RELEASE collaboration_dispatch');
      }catch(e){
        if(fence)this.store.db.exec('ROLLBACK TO collaboration_dispatch; RELEASE collaboration_dispatch');
        if(e instanceof ScheduledChannelHold||e instanceof CollaborationHold||e instanceof DeliveryChoiceHold||isCollaborationFenceError(e))continue;
        if(e instanceof DispatchNotSubmittedError){this.failBeforeSubmission(job.id,e.message);continue;}throw e;
      }
      this.busy.add(b.id);
      const dispatchAttempt=this.store.job(job.id)?.attempt_id;
      const run=()=>job.destination?this.store.destinationContext.run(job.destination!,()=>this.native.run(b,job.body,job.id)):this.native.run(b,job.body,job.id);
      const task=this.coordinator?(this.coordinator.isCoordinator(b.id)?this.coordinator.scope.run(b.id,run):this.coordinator.scope.exit(run)):run();
      void task.then(()=>{const current=this.store.job(job.id);if(!dispatchAttempt||current?.attempt_id!==dispatchAttempt)return;if(current.status==='dispatched')this.store.jobState(job.id,'submitted');this.watchSilence(job.id,b,job.destination??null);this.collaboration?.managedTurnEnded(job.id,b,dispatchAttempt);}).catch(e=>{
        if(!dispatchAttempt||this.store.job(job.id)?.attempt_id!==dispatchAttempt)return;
        if((e instanceof ScheduledChannelHold||e instanceof CollaborationHold||e instanceof DeliveryChoiceHold)&&!this.collaboration?.mayHaveSubmitted(job.id)){this.collaboration?.heldBeforeSubmission(job.id);if(this.store.job(job.id)?.status==='dispatched')this.store.jobState(job.id,'queued');return;}
        if(e instanceof DispatchNotSubmittedError&&!this.collaboration?.mayHaveSubmitted(job.id)){this.failBeforeSubmission(job.id,e.message);return;}
        if(['completed','reviewed','auto_closed','replaced'].includes(this.store.job(job.id)?.status??''))return;
        const failure=e instanceof DispatchNotSubmittedError&&this.collaboration?.mayHaveSubmitted(job.id)?new Error('The managed session may have received this request. Check the session before retrying.'):e;
        this.store.jobState(job.id,'uncertain',(failure as Error).message);
        // A slow native hand-off often still lands. Internal report deliveries never reach the owner; for
        // owner messages, warn only if the session has not answered by the time the notice is due.
        if(job.id.startsWith('report:'))return;
        if(e instanceof DesktopReadinessError){this.store.output(b,e.message,`error:${job.id}`,job.destination??this.store.get('whatsapp-owner')??null,{requestId:job.id,kind:'system',origin:'system'});return;}
        const notice=()=>{if(this.stopped||this.store.job(job.id)?.status!=='uncertain')return;
          this.store.output(b,`I couldn't confirm a reply from this session, so I won't repeat the task automatically. Please check the native session before sending a new request.\nDetails: ${(failure as Error).message}\nReference: ${job.id}`,`error:${job.id}`,job.destination??this.store.get('whatsapp-owner')??null,{requestId:job.id,kind:'system',origin:'system'});};
        // ponytail: in-memory timer, so a restart inside the window drops the notice; the request stays uncertain.
        if(this.uncertainNoticeMs>0)setTimeout(notice,this.uncertainNoticeMs).unref?.();else notice();
      }).finally(()=>{this.busy.delete(b.id);this.pump();});
    }
  }
  channelPoll(b:Binding,client:string) {
    if(b.mode!=='channel')throw new Error('Session is not registered in channel mode.');
    if(!this.store.incomingOwnerCurrent())return null;
    const prior=this.channelClients.get(b.id);
    if(prior&&prior.id!==client&&Date.now()-prior.seen<20000)throw new Error('Another channel client owns this binding.');
    this.channelClients.set(b.id,{id:client,seen:Date.now()});
    if(this.store.hasDispatched(b.id))return null;
    const job=this.routableJob(b);if(!job)return null;
    const origin=this.store.incomingOwnerContext.getStore();
    if(origin&&briefDispatchGuard(this.store,job.id)&&origin.destination!==job.destination)return null;
    const envelope=turnEnvelope(this.store,b,job.body,job.id,{tool:'whatsapp_reply'},this.attachments.references(b,job.id,true));
    const fence=!!this.collaboration;if(fence)this.store.db.exec('SAVEPOINT collaboration_channel');
    try{
      if(fence&&this.store.job(job.id)?.status!=='queued')throw new CollaborationHold('The request is no longer queued.');
      this.assertDispatchAllowed(job.id,b);this.store.jobState(job.id,'dispatched');
      if(fence)this.store.db.exec('RELEASE collaboration_channel');
    }catch(e){
      if(fence)this.store.db.exec('ROLLBACK TO collaboration_channel; RELEASE collaboration_channel');
      if(e instanceof ScheduledChannelHold||e instanceof CollaborationHold||e instanceof DeliveryChoiceHold||isCollaborationFenceError(e))return null;
      if(e instanceof DispatchNotSubmittedError){this.failBeforeSubmission(job.id,e.message);return null;}throw e;
    }
    envelope.acknowledge();return {...job,body:envelope.body};
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
    const previews=!relayOnly&&requestId&&kind==='final'?queueSocialPreviews(this.store,b,requestId):[];
    const body=previews.length?withoutPreviewCaptions(this.store,requestId!,text):text;
    queued=relayOnly||this.store.output(b,body,source,requestId?this.store.job(requestId)?.destination??this.store.get('whatsapp-owner')??null:this.store.destination(),{...context,requestId,kind:kind==='final'?'final':'progress',origin:'agent'})===true;
    if(queued&&!coordinator&&requestId&&source)this.ownerReplyPolicy.recordWorker(requestId,source,text);
    if(requestId&&kind==='final')this.store.set(`final-reply:${requestId}`,replyIdentity);
    if(requestId&&kind==='final')this.store.jobState(requestId,'completed',null,context.outcome);
    else if(requestId){const j=this.store.job(requestId)!;if(['uncertain','failed'].includes(j.status))this.store.jobState(requestId,'submitted');else this.store.db.prepare('UPDATE inbox SET updated_at=? WHERE id=?').run(Date.now(),requestId);}
    if(kind==='final')this.store.set(`explicit-final:${b.id}`,String(Date.now()));
    if(queued&&requestId)this.coordinator?.workerReply(b,text,requestId,false,kind as 'progress'|'final',!relayOnly);
    if(queued&&requestId&&kind==='final')this.coordinator?.itemReport(b,text,requestId);
    if(!relayOnly&&requestId&&kind==='final'&&(context.outcome===undefined||context.outcome==='done')){
      // Reporting is optional: it must never roll back a session's final reply.
      try{queueReportedProof(this,b,requestId,queued?text:undefined);}catch{}
    }
    this.store.db.exec('COMMIT');
    }catch(e){this.store.db.exec('ROLLBACK');throw e;}
    if(queued&&this.coordinator)this.pump();return {accepted:true,newlyQueued:queued};
  }
}
