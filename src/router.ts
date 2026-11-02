import {prepareSocialPreviews,queueSocialPreviews} from './social-preview.js';
import {asksForSocialCreation} from './social-intent.js';
import {requestedSocialImageProvider} from './social-image-provider.js';
import { DesktopReadinessError } from './session-activation.js';
import { ownerCommand, routeOwnerTarget, clearOwnerTarget, authenticatedOwner, ownerAttachmentTarget, isOwnerCommand, pickOwnerTarget, ownerTurnLabel, specialtyTarget, brainSelected } from './owner-commands.js';
import { selectOption, previewOption, parseMessageOptions } from './message-options.js';
import { MetaBrain } from './meta-brain.js';
import { Schedules,scheduleJobState,scheduleRootState,hasScheduleGuard,failScheduledBeforeSubmission } from './schedules.js';
import { TaskContracts } from './task-contracts.js';
import { queueReportedProof } from './proof-report.js';
import { closedAfterQueueText, queueOwnerReceipt, sessionShortName } from './coordinator-experience.js';
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
import {parsePublicCheck,publicCheckObservation} from './proof-public-check.js';
import {agentReach} from './agent-reach.js';
import {captureResearchRequest,captureGuidedResearchRequest} from './agent-reach-request.js';
import {GuidedModes} from './guided-modes.js';
import {cancelGuidedJobs,resumeGuidedJobs} from './guided-jobs.js';
import {jobsFollowup,jobsFollowupBody,jobsAttachmentQuestion,jobsAttachmentBody,captureJobsFollowup,jobsFollowupCurrent,assertFollowupContracts,needsFollowupReview,saveFollowupReview,endFollowupReview,dropFollowupReview,loadFollowupReview,proposedPublicJobQuery} from './jobs-followup.js';
import {researchFollowup,researchFollowupBody,captureResearchFollowup,researchFollowupCurrent,assertResearchFollowupContracts,proposedPublicResearchQuery,saveResearchFollowupReview,endResearchFollowupReview,dropResearchFollowupReview,loadResearchFollowupReview} from './research-followup.js';
import {researchSpecialty} from './research-agent.js';
import {jobsSpecialty} from './jobs-agent.js';
import {socialSpecialty} from './social-agent.js';
import {prepareSpecialties,specialtyEpoch,specialtyIdentity,markPendingSpecialty,pendingSpecialty,hasPendingSpecialty,bindSessionSpecialty,hasSessionSpecialty,sessionSpecialty,specialtyNoticeDestination,type PendingSpecialty} from './session-specialty.js';
import {prepareAttachmentTargetEpochs,attachmentTargetEpoch} from './attachment-target-epoch.js';

/** A scheduled request was held before any native submission. */
class ScheduledChannelHold extends DispatchNotSubmittedError {}

export type RouteResult={status:'queued'|'handled'|'ignored'|'blocked';requestId:string;code?:string};
export type Incoming = {id:string;text:string;quotedId?:string;optionToken?:string;source?:'text'|'voice';ownerCommand?:boolean;ownerIntent?:boolean;ownerChoice?:boolean;activityScope?:{destination:string;owner:string}};
export const help = `Just tell me what you need.

• Show my recent sessions.
• Find the website session.
• Use Checkout fix and tell me its progress.
• Claude, create a session for this task.
• /research, /jobs and /social use your selected session for research, job search or social drafts.

Reply to a permission message with “Yes, allow it” or “No, deny it”. Reply to a session’s message to continue in that session.

In WhatsApp, bind an approved GitHub check with /proof bind #ITEM CHECK_NUMBER OWNER/REPO. This does not verify the task.`;
/** The same words are already waiting for an answer: this is a retry, not a new request. */
export class DuplicateOwnerRequest extends Error {}
export class Router {
  coordinator?:Coordinator;
  brain:MetaBrain;
  schedules:Schedules;
  scheduledBrief?:(destination:string,expectedOwner:string,occurrenceId:string,canSend?:()=>boolean)=>Promise<'queued'|'already-queued'|'retry'|'invalid'>;
  contracts:TaskContracts;
  /** Optional internal prototype; no production route enables it. */
  collaboration?:ManagedCollaboration;
  proofBindings?:ProofOwnerBindings;
  /** Injectable only by bridge-owned tests; the default uses public HTTPS. */
  publicCheckFetch:typeof fetch=fetch;
  private publicCheckActive=0;
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
    } else b=ownerAttachmentTarget(this,m)??(this.coordinator?this.coordinator.destination(text):this.store.binding(this.store.get('active')??''));
    if(this.schedules.isScheduleLike(text))throw new Error('Send schedules as a new text message in your own chat. Attachments cannot schedule or immediately send future actions.');
    if(!b)throw new Error('Choose an exact session before sending an attachment.');
    this.need(b.id);
    if(text.length>32000)throw new Error('Attachment caption exceeds 32,000 characters.');
    return {binding:b,text:text||'The owner sent an attachment without a caption. Acknowledge receipt and ask what they want done with it; do not execute it.',
      identity:JSON.stringify([b.id,b.native_id,b.cwd,b.token_hash,b.provider,b.mode,this.store.get(`execution-mode:${b.id}`),this.store.get(`session-route:${b.id}`),this.store.get('master'),this.store.get('active'),this.store.get('selected'),this.store.ownerFor(this.store.destination()),this.store.controlChannel(),this.store.get('incoming-owner-generation'),this.store.get(`owner-target:${this.store.destination()}`),attachmentTargetEpoch(this.store,b.id),...(selectedRoute?[specialtyEpoch(this.store)]:[])])};
  }
  receiveAttachment(m:Incoming,file:IncomingFile,target:ReturnType<Router['attachmentTarget']>) {
    if(this.stopped||this.store.seen(m.id))return;
    // Attachment captions use a separate synchronous path; do not let them bypass task review.
    if(this.contracts.enabled()&&m.text.trim())throw new Error('Send the task as a text or voice message first. Attachment task review is not available yet. Nothing was sent.');
    if(this.attachmentTarget(m).identity!==target.identity)throw new Error('The intended session changed during download. Please resend to the intended session.');
    const jobsQuestion=file.kind==='document'?jobsAttachmentQuestion(this,m):undefined;
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      if(this.store.job(m.id))throw new Error('This attachment request already exists. Check its status before resending.');
      if(jobsQuestion){
        const body=jobsAttachmentBody(this,jobsQuestion),binding=captureJobsFollowup(this,{...m,text:'unspecified'},jobsQuestion,body);
        if(binding.id!==target.binding.id)throw new Error('The job-search session changed. Nothing was sent.');
        this.queue(m.id,binding,body);bindSessionSpecialty(this.store,m.id,binding,'jobs',jobsSpecialty());
      } else this.queue(m.id,this.need(target.binding.id),target.text);
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
    if(this.remoteControl&&!m.quotedId&&ownerIntent&&(!text.startsWith('/')||m.ownerCommand!==false)){const reply=await this.remoteControl(text).catch(()=>'Screen control could not start. Check FarFromDesk on your Mac.');if(!this.store.incomingOwnerCurrent())return {status:'blocked',requestId:m.id,code:'routing_unavailable'};if(reply){this.store.output(undefined,reply,`command:${m.id}`,undefined,{plain:true});this.store.remember(m.id);return {status:'handled',requestId:m.id};}}
    // Exact typed decisions are resolved before ordinary model routing.
    let ownerReply=false;
    try {
      if(!contractApproved){const recovered=this.contracts.recoverApproved(this,m);if(recovered)return await this.receiveOnce(recovered,true);}
      if(contractApproved){
        const approved=this.contracts.approved(m.id),saved=approved&&loadFollowupReview(this,approved.origin_id);
        if(saved){
          if(approved!.original!==m.text.trim()||approved!.review_text!==saved.body||!jobsFollowupCurrent(this.store,saved.q.request_id))throw new Error('The job-search review changed. Nothing was sent.');
          const result=this.finishJobsFollowup(m,saved.q,saved.body,`pending:${approved!.origin_id}`,saved.confirmedQuery);
          dropFollowupReview(this,approved!.origin_id,saved.q);return result;
        }
        const research=approved&&loadResearchFollowupReview(this,approved.origin_id);
        if(research){
          if(approved!.original!==m.text.trim()||approved!.review_text!==research.body||!researchFollowupCurrent(this.store,research.q.request_id))throw new Error('The research review changed. Nothing was sent.');
          const result=this.finishResearchFollowup(m,research.q,research.body,research.confirmedQuery,`pending:${approved!.origin_id}`);
          dropResearchFollowupReview(this,approved!.origin_id,research.q);return result;
        }
      }
      // An owner must explicitly approve sending an additional answer to a
      // public search provider. No search runs while confirmation is pending.
      const confirmationKey=`jobs-public-query-confirm:${this.store.destination()??''}`;
      const confirmationRaw=this.store.get(confirmationKey);
      if(confirmationRaw&&authenticatedOwner(this,m)&&m.source!=='voice'){
        let pending:{origin:Incoming;question:NonNullable<ReturnType<typeof jobsFollowup>>;body:string;query:string;context:string;bindingHash:string;captureHash:string;selectionEpoch:string;expires:number};
        try{pending=JSON.parse(confirmationRaw);}catch{this.store.db.prepare('DELETE FROM settings WHERE key=?').run(confirmationKey);throw Error('The public search confirmation changed. Nothing was sent.');}
        const answer=/^(?:yes|no)[.!]?$/i.exec(text);
        if(answer){
          if(!m.quotedId||m.ownerChoice!==true)throw Error('Reply to the confirmation message with your own typed yes or no. Nothing was sent.');
          const delivered=this.store.db.prepare('SELECT status,destination,wa_id FROM outbox WHERE source=?').get(`jobs-public:${pending.origin.id}:0`) as {status:string;destination:string;wa_id:string}|undefined;
          if(!delivered||delivered.status!=='sent'||delivered.destination!==this.store.destination()||m.quotedId&&m.quotedId!==delivered.wa_id)throw Error('Wait for the public search confirmation and reply directly to it. Nothing was sent.');
          this.store.db.prepare('DELETE FROM settings WHERE key=? AND value=?').run(confirmationKey,confirmationRaw);
          if(answer[0].toLowerCase().startsWith('no')){this.store.output(undefined,'No additional public search was sent. Send a new /jobs request when ready.',`jobs-public:${m.id}`,undefined,{plain:true});this.store.remember(m.id);return {status:'handled',requestId:m.id};}
          const context=this.store.incomingOwnerContext.getStore(),binding=this.store.binding(pending.question.binding_id),q=jobsFollowup(this,pending.origin,this.contracts.enabled());
          const bindingHash=binding&&hash(JSON.stringify([binding.id,binding.native_id,binding.cwd,binding.provider,binding.mode,binding.token_hash,this.store.get(`reach-binding-generation:${binding.id}`)]));
          if(!context||!this.store.incomingOwnerCurrent()||Date.now()>pending.expires||JSON.stringify(context)!==pending.context||(this.store.get('public-consent-generation')??'')!==pending.selectionEpoch||!q||q.id!==pending.question.id||hash(q.body)!==hash(pending.question.body)||!binding?.enabled||bindingHash!==pending.bindingHash||hash(this.store.get(`reach-owner-request:${q.request_id}`)??'')!==pending.captureHash||proposedPublicJobQuery(this.store,pending.origin,q)!==pending.query||jobsFollowupBody(this,pending.origin,q)!==pending.body)throw Error('The job search or connection changed. Send a new /jobs request. Nothing was sent.');
          this.store.recordIncomingInput(m.id);
          this.store.set(`jobs-public-query-consent:${pending.origin.id}`,JSON.stringify({detailId:pending.origin.id,questionId:q.id,query:pending.query,yesId:m.id,context:pending.context,bodyHash:hash(pending.body),expires:Date.now()+10*60_000}));
          this.store.remember(m.id);
          if(this.contracts.enabled()&&needsFollowupReview(pending.origin)){
            saveFollowupReview(this,pending.origin,q,pending.body,pending.query);
            try{
              const review=await this.contracts.preflight(this,pending.origin,pending.body,undefined,undefined,false,false,true);
              if(review.kind==='handled'){
                if(!this.store.db.prepare("SELECT 1 FROM task_contracts WHERE origin_id=? AND state='pending'").get(pending.origin.id))dropFollowupReview(this,pending.origin.id,q);
                return {status:'handled',requestId:m.id};
              }
              if(review.kind==='replay')throw Error('The job-search review changed. Nothing was sent.');
              const result=this.finishJobsFollowup(pending.origin,q,pending.body,`pending:${pending.origin.id}`,pending.query);dropFollowupReview(this,pending.origin.id,q);return result;
            }catch(e){dropFollowupReview(this,pending.origin.id,q);throw e;}finally{endFollowupReview(this,pending.origin.id);}
          }
          return this.finishJobsFollowup(pending.origin,q,pending.body,undefined,pending.query);
        }
        // Another owner message cancels an unanswered proposal rather than
        // letting a later unrelated "yes" approve it.
        this.store.db.prepare('DELETE FROM settings WHERE key=? AND value=?').run(confirmationKey,confirmationRaw);
      }
      const researchConfirmKey=`research-public-query-confirm:${this.store.destination()??''}`,researchConfirmRaw=this.store.get(researchConfirmKey);
      if(researchConfirmRaw&&authenticatedOwner(this,m)&&m.source!=='voice'){
        let pending:{origin:Incoming;question:NonNullable<ReturnType<typeof researchFollowup>>;body:string;query:string;context:string;bindingHash:string;captureHash:string;selectionEpoch:string;expires:number};
        try{pending=JSON.parse(researchConfirmRaw);}catch{this.store.db.prepare('DELETE FROM settings WHERE key=?').run(researchConfirmKey);throw Error('The public search confirmation changed. Nothing was sent.');}
        const answer=/^(?:yes|no)[.!]?$/i.exec(text);
        if(answer){
          if(!m.quotedId||m.ownerChoice!==true)throw Error('Reply to the confirmation message with your own typed yes or no. Nothing was sent.');
          const delivered=this.store.db.prepare('SELECT status,destination,wa_id FROM outbox WHERE source=?').get(`research-public:${pending.origin.id}:0`) as {status:string;destination:string;wa_id:string}|undefined;
          if(!delivered||delivered.status!=='sent'||delivered.destination!==this.store.destination()||m.quotedId!==delivered.wa_id)throw Error('Wait for the public search confirmation and reply directly to it. Nothing was sent.');
          this.store.db.prepare('DELETE FROM settings WHERE key=? AND value=?').run(researchConfirmKey,researchConfirmRaw);
          if(answer[0].toLowerCase().startsWith('no')){this.store.output(undefined,'No additional public search was sent. Send a new /research request when ready.',`research-public:${m.id}`,undefined,{plain:true});this.store.remember(m.id);return {status:'handled',requestId:m.id};}
          const context=this.store.incomingOwnerContext.getStore(),binding=this.store.binding(pending.question.binding_id),q=researchFollowup(this,pending.origin);
          const bindingHash=binding&&hash(JSON.stringify([binding.id,binding.native_id,binding.cwd,binding.provider,binding.mode,binding.token_hash,this.store.get(`reach-binding-generation:${binding.id}`)]));
          if(!context||!this.store.incomingOwnerCurrent()||Date.now()>pending.expires||JSON.stringify(context)!==pending.context||(this.store.get('public-consent-generation')??'')!==pending.selectionEpoch||!q||q.id!==pending.question.id||hash(q.body)!==hash(pending.question.body)||!binding?.enabled||bindingHash!==pending.bindingHash||hash(this.store.get(`reach-owner-request:${q.request_id}`)??'')!==pending.captureHash||proposedPublicResearchQuery(this.store,pending.origin,q)!==pending.query||researchFollowupBody(this,pending.origin,q)!==pending.body)throw Error('The research or connection changed. Send a new /research request. Nothing was sent.');
          this.store.recordIncomingInput(m.id);
          this.store.set(`research-public-query-consent:${pending.origin.id}`,JSON.stringify({detailId:pending.origin.id,questionId:q.id,query:pending.query,yesId:m.id,context:pending.context,bodyHash:hash(pending.body),expires:Date.now()+10*60_000}));this.store.remember(m.id);
          if(this.contracts.enabled()&&needsFollowupReview(pending.origin))return await this.reviewResearchFollowup(pending.origin,q,pending.body,pending.query);
          return this.finishResearchFollowup(pending.origin,q,pending.body,pending.query);
        }
        this.store.db.prepare('DELETE FROM settings WHERE key=? AND value=?').run(researchConfirmKey,researchConfirmRaw);
      }
      // Approved job-search replay is tied to its saved original turn and must
      // not be mistaken for a new picker or native approval reply.
      if(contractApproved&&await resumeGuidedJobs(this,m))return {status:'handled',requestId:m.id};
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
        if(this.store.get(targetKey)!==previousTarget||this.store.get(choiceKey)!==previousChoice){cancelGuidedJobs(this,m);this.guidedModes.retarget(this);}
        this.store.output(undefined,targetReply+'\n\n'+this.guidedModes.summary(this,{...m,quotedId:undefined,ownerCommand:true}),`command:${m.id}`,undefined,{plain:true});this.store.remember(m.id);return {status:'handled',requestId:m.id};
      }
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
      const voiceMode=this.guidedModes.voice(this,m),voiceOwner=this.store.ownerFor(this.store.destination());
      if(voiceMode&&voiceMode.kind!=='social'&&!contractApproved&&(!voiceOwner||!this.contracts.hasPendingOwner(voiceOwner,this.store.destination()??''))){
        this.store.output(undefined,'Please type your research or job-search reply. Voice is not supported in this mode.',`guided:${m.id}`,undefined,{plain:true});
        this.store.remember(m.id);return {status:'handled',requestId:m.id};
      }
      if(this.errands.cancel(m))return {status:'handled',requestId:m.id};
      const errandDestination=this.store.destination(),errandOwner=this.store.ownerFor(errandDestination);
      if(!contractApproved&&errandDestination&&errandOwner&&!this.contracts.hasPendingOwner(errandOwner,errandDestination)&&this.errands.draft(m))return {status:'handled',requestId:m.id};
      // Unsupported search input needs an explanation before task review; an
      // existing owner review still gets the first opportunity to resolve it.
      if(!contractApproved&&errandDestination&&errandOwner&&!this.contracts.hasPendingOwner(errandOwner,errandDestination)&&this.errands.unsupportedInput(m)&&await this.errands.start(m))return {status:'handled',requestId:m.id};
      if((m.quotedId||!ownerIntent)&&authenticatedOwner(this,m)&&this.schedules.isScheduleLike(text)){this.store.output(undefined,'Send schedules as a new message in your own chat. Nothing was scheduled or sent to a session.',`schedule-reply:${m.id}`,undefined,{plain:true});this.store.remember(m.id);return {status:'blocked',requestId:m.id};}
      if(this.schedules.shouldHandle(this,m,ownerIntent)&&await this.schedules.handle(this,m,ownerIntent,contractApproved))return {status:'handled',requestId:m.id};
      const followup=jobsFollowup(this,m,this.contracts.enabled());
      if(followup){
        const body=jobsFollowupBody(this,m,followup);
        const proposed=proposedPublicJobQuery(this.store,m,followup);
        if(proposed){
          const context=this.store.incomingOwnerContext.getStore(),binding=this.store.binding(followup.binding_id);
          if(!context||!this.store.incomingOwnerCurrent()||!binding?.enabled)throw Error('The job search or connection changed. Nothing was sent.');
          const pending={origin:m,question:followup,body,query:proposed,context:JSON.stringify(context),bindingHash:hash(JSON.stringify([binding.id,binding.native_id,binding.cwd,binding.provider,binding.mode,binding.token_hash,this.store.get(`reach-binding-generation:${binding.id}`)])),captureHash:hash(this.store.get(`reach-owner-request:${followup.request_id}`)??''),selectionEpoch:this.store.get('public-consent-generation')??'',expires:Date.now()+5*60_000};
          this.store.db.exec('SAVEPOINT jobs_public_confirm');try{
            this.store.set(confirmationKey,JSON.stringify(pending));
            this.store.output(undefined,`May I send this search to the public search provider?\n\n${proposed.replace(/^\/reach web search /,'')}\n\nReply to this message with yes or no.`, `jobs-public:${m.id}`,undefined,{plain:true});this.store.remember(m.id);this.store.db.exec('RELEASE jobs_public_confirm');
          }catch(e){this.store.db.exec('ROLLBACK TO jobs_public_confirm; RELEASE jobs_public_confirm');throw e;}
          return {status:'handled',requestId:m.id};
        }
        if(this.contracts.enabled()&&needsFollowupReview(m)){
          saveFollowupReview(this,m,followup,body);
          try{
            const review=await this.contracts.preflight(this,m,body,undefined,undefined,false,false,true);
            if(review.kind==='handled'){
              if(!this.store.db.prepare("SELECT 1 FROM task_contracts WHERE origin_id=? AND state='pending'").get(m.id))dropFollowupReview(this,m.id,followup);
              return {status:'handled',requestId:m.id};
            }
            if(review.kind==='replay')throw new Error('The job-search review changed. Nothing was sent.');
            const result=this.finishJobsFollowup(m,followup,body,`pending:${m.id}`);dropFollowupReview(this,m.id,followup);return result;
          }catch(e){dropFollowupReview(this,m.id,followup);throw e;}finally{endFollowupReview(this,m.id);}
        }
        return this.finishJobsFollowup(m,followup,body);
      }
      const researchQuestion=researchFollowup(this,m);
      if(researchQuestion){
        const body=researchFollowupBody(this,m,researchQuestion),proposed=proposedPublicResearchQuery(this.store,m,researchQuestion);
        if(proposed){
          const context=this.store.incomingOwnerContext.getStore(),binding=this.store.binding(researchQuestion.binding_id);
          if(!context||!this.store.incomingOwnerCurrent()||!binding?.enabled)throw Error('The research or connection changed. Nothing was sent.');
          const pending={origin:m,question:researchQuestion,body,query:proposed,context:JSON.stringify(context),bindingHash:hash(JSON.stringify([binding.id,binding.native_id,binding.cwd,binding.provider,binding.mode,binding.token_hash,this.store.get(`reach-binding-generation:${binding.id}`)])),captureHash:hash(this.store.get(`reach-owner-request:${researchQuestion.request_id}`)??''),selectionEpoch:this.store.get('public-consent-generation')??'',expires:Date.now()+5*60_000};
          this.store.db.exec('SAVEPOINT research_public_confirm');try{
            this.store.set(researchConfirmKey,JSON.stringify(pending));this.store.output(undefined,`May I send this search to the public search provider?\n\n${proposed.replace(/^\/reach web search /,'')}\n\nReply to this message with yes or no.`,`research-public:${m.id}`,undefined,{plain:true});this.store.remember(m.id);this.store.db.exec('RELEASE research_public_confirm');
          }catch(e){this.store.db.exec('ROLLBACK TO research_public_confirm; RELEASE research_public_confirm');throw e;}
          return {status:'handled',requestId:m.id};
        }
        if(this.contracts.enabled()&&needsFollowupReview(m))return await this.reviewResearchFollowup(m,researchQuestion,body);
        return this.finishResearchFollowup(m,researchQuestion,body);
      }
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
      // Never reinterpret a pending contract answer as a new mode selection.
      if(!pendingContract&&authenticatedOwner(this,m)&&!m.quotedId&&(m.source==='voice'?m.ownerIntent===true:m.ownerCommand===true)&&asksForSocialCreation(m.text)&&!this.guidedModes.get(this,m)){
        this.guidedModes.start(this,m,'social');
      }
      const guidedBeforeContract=this.guidedModes.get(this,m);
      // Guided requests perform their own contract review before session dispatch.
      // An already-pending contract always has precedence over a guided turn.
      if(!contractApproved&&this.contracts.shouldHandle(this,m)&&!(guidedBeforeContract&&!pendingContract&&!text.startsWith('/'))){
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
        if(mode?.busy&&(!text.startsWith('/')||/^\/(?:back|cancel|research|jobs|social|claude|codex|brain|use|talk)(?:\s|$)/i.test(text))){reply('A request is still being processed. Please wait before changing modes.');return {status:'handled',requestId:m.id};}
        if(mode&&/^\/(?:cancel|back)\s*$/i.test(text)){
          cancelGuidedJobs(this,m);this.guidedModes.close(this,m);
          if(/^\/back/i.test(text)){clearOwnerTarget(this);reply('Back to normal routing.');}
          else reply(`Exited ${mode.kind} mode.`);
          return {status:'handled',requestId:m.id};
        }
        const start=/^\/(research|jobs|social)(?:\s+([\s\S]*))?$/i.exec(text);
        if(start){
          const kind=start[1].toLowerCase() as 'research'|'jobs'|'social';
          const owner=this.store.ownerFor(this.store.destination());
          if(kind==='social'&&owner&&this.contracts.hasPendingOwner(owner,this.store.destination()??'')){
            reply('Finish or cancel the pending task contract before starting Social.');return {status:'handled',requestId:m.id};
          }
          cancelGuidedJobs(this,m);this.guidedModes.start(this,m,kind);
          mode=this.guidedModes.get(this,m);
          if(!start[2]?.trim()){
            reply(kind==='research'?'What would you like to research? Send /back to leave.':kind==='jobs'?'What kind of jobs are you looking for? Send /back to leave.':'What would you like to create posts about, and for which platforms? Send /back to leave.');return {status:'handled',requestId:m.id};
          }
        }
        if(mode&&(!text.startsWith('/')||!!start)){
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
            const marker=markPendingSpecialty(this.store,m.id,b,mode.kind,mode.kind==='research'?researchSpecialty():mode.kind==='jobs'?jobsSpecialty():socialSpecialty(active.imageProvider),m.text,mode.kind==='social'?active.imageProvider:undefined);
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
        if(/^\/(?:claude|codex|brain)(?:\s|$)/i.test(text)){cancelGuidedJobs(this,m);this.guidedModes.retarget(this);}
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
        else if(cmd==='checkrun') {
          const owner=this.store.incomingOwnerContext.getStore();
          if(!authenticatedOwner(this,m)||m.ownerCommand!==true||m.quotedId||m.source==='voice'||!owner||owner.owner!==owner.destination)
            throw new Error('Send /checkrun as a new typed message in your owner chat.');
          const request=parsePublicCheck(args);
          if(this.publicCheckActive>=2)throw new Error('Two public check requests are running. Please try again shortly.');
          const current=()=>!this.stopped&&this.store.incomingOwnerCurrent()&&this.store.controlChannel()===owner.channel&&this.store.ownerFor(owner.destination)===owner.owner;
          // Do not replay an interrupted request under a later owner generation.
          if(!current())return {status:'blocked',requestId:m.id,code:'routing_unavailable'};
          this.store.remember(m.id);
          this.publicCheckActive++;
          try {
            const observation=await publicCheckObservation(request,current,this.publicCheckFetch);
            if(!current())return {status:'blocked',requestId:m.id,code:'routing_unavailable'};
            this.store.db.exec('SAVEPOINT public_check_output');
            try{this.store.output(undefined,observation,`command:${m.id}`,owner.destination,{plain:true});this.store.remember(m.id);this.store.db.exec('RELEASE public_check_output');}
            catch(e){this.store.db.exec('ROLLBACK TO public_check_output; RELEASE public_check_output');throw e;}
            return {status:'handled',requestId:m.id};
          } finally {this.publicCheckActive--;}
        }
        else if(cmd==='workspace'){if(!this.workspaceCommand)throw new Error('Workspace creation is unavailable.');this.store.output(undefined,this.workspaceCommand(args),`command:${m.id}`);}
        else if(cmd==='sessions')this.store.output(undefined,this.store.bindings().map(b=>`${b.enabled?'●':'○'} ${b.alias} · ${b.provider} · ${b.mode}`).join('\n')||'No sessions registered. Open Session Bridge.app.',`command:${m.id}`);
        else if(cmd==='use') {const b=this.need(args);clearOwnerTarget(this);this.store.set('active',b.id);cancelGuidedJobs(this,m);this.guidedModes.retarget(this);this.store.output(b,'Selected. Your next messages go to this exact session.\n\n'+this.guidedModes.summary(this,m),`command:${m.id}`);}
        else if(cmd==='talk'){const message=this.talkDirect(this.need(args));cancelGuidedJobs(this,m);this.guidedModes.retarget(this);this.store.output(undefined,message+'\n\n'+this.guidedModes.summary(this,m),`command:${m.id}`);}
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
  }
  /** Replaced in tests so receipts do not depend on which desktop apps happen to be open. */
  livenessProbe:()=>{codex:boolean;claude:boolean}=probeDesktopAppsNow;
  private recordLiveness(live:{codex:boolean;claude:boolean}) {
    for(const provider of ['codex','claude'] as Provider[]){
      if(provider==='muse')continue;
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
    // Muse Code is a CLI with no companion desktop app, so it is never "closed".
    if(b.provider==='muse'){this.store.set('app-running:muse','true');queueOwnerReceipt(this.store,id,b);return;}
    const live=this.livenessProbe();
    this.store.set(`app-running:${b.provider}`,String(live[b.provider]));
    this.store.set(`app-running:${b.provider}:at`,String(Date.now()));
    queueOwnerReceipt(this.store,id,b);
  }
  /** An app that quits while a message waits corrects the receipt at once, not at the next reminder. */
  private announceClosed(provider:Provider) {
    try {
      const pending=this.store.db.prepare("SELECT id FROM inbox WHERE status IN ('queued','dispatched','submitted') AND created_at>? ORDER BY created_at").all(Date.now()-3_600_000) as {id:string}[];
      for(const {id} of pending){
        if(!/^(wa|tg):/.test(id))continue;
        const job=this.store.job(id);
        if(!job||job.first_reply_at)continue;
        const binding=this.store.binding(job.binding_id);
        if(!binding||binding.provider!==provider)continue;
        if(this.store.db.prepare('SELECT 1 FROM reply_receipts WHERE source=?').get(`closed:${id}`))continue;
        this.store.output(binding,closedAfterQueueText(sessionShortName(this.store,binding)),`closed:${id}`,
          job.destination??this.store.destination(),{kind:'system',origin:'system',plain:true,requestId:id});
        this.store.event(id,'app_closed',{provider});
      }
    } catch(e) { console.error(`Closed-app notice failed: ${e instanceof Error?e.message:'unknown failure'}`); }
  }
  appOnline(provider:Provider) { return provider==='muse'||this.store.get(`app-running:${provider}`)!=='false'; }
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
        const closed=!this.appOnline(b.provider);
        this.store.event(id,stage===1?'silence_notice':'silence_escalated',{stage,appRunning:!closed});
        const text=stage===1
          ?(closed?`📴 ${name} is closed. Your message is queued and runs when the app opens.`:`⏳ ${name} has not started this yet.`)
          :`⚠️ Still no answer from ${name} after ${Math.max(1,Math.round((Date.now()-job.created_at)/60000))} min. Open the app to continue, or send /status.`;
        this.store.output(b,text,`silence:${id}:${stage}`,destination??this.store.get('whatsapp-owner')??null,{requestId:id,kind:'system',origin:'system',plain:true});
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
  private finishJobsFollowup(m:Incoming,q:NonNullable<ReturnType<typeof jobsFollowup>>,body:string,reservation?:string,confirmedQuery?:string) {
    this.store.db.exec('SAVEPOINT jobs_followup');
    try {
      const binding=captureJobsFollowup(this,m,q,body,reservation,confirmedQuery);
      this.queue(m.id,binding,body);bindSessionSpecialty(this.store,m.id,binding,'jobs',jobsSpecialty());
      this.store.remember(m.id);this.store.db.exec('RELEASE jobs_followup');
    }catch(e){this.store.db.exec('ROLLBACK TO jobs_followup; RELEASE jobs_followup');throw e;}
    this.pump();return {status:'queued' as const,requestId:m.id};
  }
  private finishResearchFollowup(m:Incoming,q:NonNullable<ReturnType<typeof researchFollowup>>,body:string,confirmedQuery?:string,reservation?:string) {
    this.store.db.exec('SAVEPOINT research_followup');
    try{const binding=captureResearchFollowup(this,m,q,body,confirmedQuery,reservation);this.queue(m.id,binding,body);bindSessionSpecialty(this.store,m.id,binding,'research',researchSpecialty());this.store.remember(m.id);this.store.db.exec('RELEASE research_followup');}
    catch(e){this.store.db.exec('ROLLBACK TO research_followup; RELEASE research_followup');throw e;}
    this.pump();return {status:'queued' as const,requestId:m.id};
  }
  private async reviewResearchFollowup(m:Incoming,q:NonNullable<ReturnType<typeof researchFollowup>>,body:string,confirmedQuery?:string) {
    saveResearchFollowupReview(this,m,q,body,confirmedQuery);
    try{
      const review=await this.contracts.preflight(this,m,body,undefined,undefined,false,false,true);
      if(review.kind==='handled'){if(!this.store.db.prepare("SELECT 1 FROM task_contracts WHERE origin_id=? AND state='pending'").get(m.id))dropResearchFollowupReview(this,m.id,q);return {status:'handled' as const,requestId:m.id};}
      if(review.kind==='replay')throw Error('The research review changed. Nothing was sent.');
      const result=this.finishResearchFollowup(m,q,body,confirmedQuery,`pending:${m.id}`);dropResearchFollowupReview(this,m.id,q);return result;
    }catch(e){dropResearchFollowupReview(this,m.id,q);throw e;}finally{endResearchFollowupReview(this,m.id);}
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
      if(!exists&&this.coordinator?.isCoordinator(b.id))this.receiptWithLiveness(id,b);
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
    const scheduled=hasScheduleGuard(this,id),guard=briefDispatchGuard(this.store,id),contract=this.contracts.hasGuard(id),choice=this.contracts.hasOptionGuard(id),collaboration=this.collaboration?.has(id)??false,specialty=hasSessionSpecialty(this.store,id);
    if(!collaboration)this.collaboration?.assertOrdinaryDispatch(id,b);
    if(!scheduled&&!guard&&!contract&&!choice&&!collaboration&&!specialty)return false;
    const job=this.store.job(id);if(!job)throw new DispatchNotSubmittedError('The request no longer exists.');
    if(specialty&&sessionSpecialty(this.store,id)?.bindingId!==b.id)throw new DispatchNotSubmittedError('The selected session or request changed. Nothing was sent.');
    if(specialty&&!jobsFollowupCurrent(this.store,id))throw new DispatchNotSubmittedError('The original job search or question changed. Nothing was sent.');
    if(specialty)try{assertFollowupContracts(this,id);}catch{throw new DispatchNotSubmittedError('The original approved job search changed. Nothing was sent.');}
    if(specialty&&!researchFollowupCurrent(this.store,id))throw new DispatchNotSubmittedError('The original research or question changed. Nothing was sent.');
    if(specialty)try{assertResearchFollowupContracts(this,id);}catch{throw new DispatchNotSubmittedError('The original approved research changed. Nothing was sent.');}
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
      // A channel-mode session is pulled by its own client. Muse has no client and no app:
      // the bridge runs one headless turn per request, so it is pumped like a CLI session.
      if(!b.enabled||(b.mode==='channel'&&b.provider!=='muse')||this.busy.has(b.id))continue;
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
        if(e instanceof ScheduledChannelHold||e instanceof CollaborationHold||isCollaborationFenceError(e))continue;
        if(e instanceof DispatchNotSubmittedError){this.failBeforeSubmission(job.id,e.message);continue;}throw e;
      }
      this.busy.add(b.id);
      const dispatchAttempt=this.store.job(job.id)?.attempt_id;
      const run=()=>job.destination?this.store.destinationContext.run(job.destination!,()=>this.native.run(b,job.body,job.id)):this.native.run(b,job.body,job.id);
      const task=this.coordinator?(this.coordinator.isCoordinator(b.id)?this.coordinator.scope.run(b.id,run):this.coordinator.scope.exit(run)):run();
      void task.then(()=>{const current=this.store.job(job.id);if(!dispatchAttempt||current?.attempt_id!==dispatchAttempt)return;if(current.status==='dispatched')this.store.jobState(job.id,'submitted');this.watchSilence(job.id,b,job.destination??null);this.collaboration?.managedTurnEnded(job.id,b,dispatchAttempt);}).catch(e=>{
        if(!dispatchAttempt||this.store.job(job.id)?.attempt_id!==dispatchAttempt)return;
        if((e instanceof ScheduledChannelHold||e instanceof CollaborationHold)&&!this.collaboration?.mayHaveSubmitted(job.id)){this.collaboration?.heldBeforeSubmission(job.id);if(this.store.job(job.id)?.status==='dispatched')this.store.jobState(job.id,'queued');return;}
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
      if(e instanceof ScheduledChannelHold||e instanceof CollaborationHold||isCollaborationFenceError(e))return null;
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
    if(!relayOnly&&requestId&&kind==='final')queueSocialPreviews(this.store,b,requestId);
    queued=relayOnly||this.store.output(b,text,source,requestId?this.store.job(requestId)?.destination??this.store.get('whatsapp-owner')??null:this.store.destination(),{...context,requestId,kind:kind==='final'?'final':'progress',origin:'agent'})===true;
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
