import {CollaborationHarness,type CollaborationScope} from './collaboration-harness.js';
import {DispatchNotSubmittedError} from './brief-dispatch-guard.js';
import {bindScheduledChild} from './schedules.js';
import {hash,type Binding,type Job} from './store.js';
import type {Router} from './router.js';

/** A managed handoff remains queued until a verified source turn has ended. */
export class CollaborationHold extends DispatchNotSubmittedError {}
/** Must be implemented by trusted bridge code from owner-approved role rules. */
export type HandoffAuthority={allows(scope:CollaborationScope,from:Binding,to:Binding,summary:string):boolean};
type Row={job_id:string;source_id:string;source_attempt:string;source_binding:string;source_identity:string;source_body:string;
  target_binding:string;target_identity:string;item_id:number;root_id:string;owner:string;destination:string;
  contract_id:string;revision:number;approved_hash:string;body_hash:string;summary:string;yielded:number;
  claim_token:string|null;generation:number|null;target_attempt:string|null;submission_started:number;finished:number;state:string;owner_generation:string|null};

/** Experimental internal adapter. No endpoint or default Router enables this. */
export class ManagedCollaboration {
  constructor(private router:Router,private authority:HandoffAuthority) {
    router.store.db.exec(`CREATE TABLE IF NOT EXISTS managed_collaboration_handoffs(
      job_id TEXT PRIMARY KEY,source_id TEXT NOT NULL,source_attempt TEXT NOT NULL,source_binding TEXT NOT NULL,
      source_identity TEXT NOT NULL,source_body TEXT NOT NULL,target_binding TEXT NOT NULL,target_identity TEXT NOT NULL,
      item_id INTEGER NOT NULL,root_id TEXT NOT NULL,owner TEXT NOT NULL,destination TEXT NOT NULL,
      contract_id TEXT NOT NULL,revision INTEGER NOT NULL,approved_hash TEXT NOT NULL,body_hash TEXT NOT NULL,
      summary TEXT NOT NULL,yielded INTEGER NOT NULL DEFAULT 0,claim_token TEXT,generation INTEGER,target_attempt TEXT,submission_started INTEGER NOT NULL DEFAULT 0,
      finished INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'waiting',owner_generation TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS managed_collaboration_active_item ON managed_collaboration_handoffs(item_id) WHERE state IN ('waiting','claimed');`);
    // Older prototype rows have no trustworthy submission boundary.
    if(!router.store.db.prepare('PRAGMA table_info(managed_collaboration_handoffs)').all().some((c:any)=>c.name==='submission_started'))
      router.store.db.exec('ALTER TABLE managed_collaboration_handoffs ADD COLUMN submission_started INTEGER NOT NULL DEFAULT 1');
    if(!router.store.db.prepare('PRAGMA table_info(managed_collaboration_handoffs)').all().some((c:any)=>c.name==='owner_generation'))
      router.store.db.exec('ALTER TABLE managed_collaboration_handoffs ADD COLUMN owner_generation TEXT');
    this.recoverKnownUnsent();
  }
  private get store(){return this.router.store;}
  private row(id:string){return this.store.db.prepare('SELECT * FROM managed_collaboration_handoffs WHERE job_id=?').get(id) as Row|undefined;}
  private sourceOwner(root:string,owner:string,destination:string,channel:string){
    const origin=this.store.recordedIncomingInput(root);
    if(!origin||origin.owner!==owner||origin.destination!==destination||origin.channel!==channel||
      origin.generation!==(this.store.get('incoming-owner-generation')??''))throw new Error('The source owner connection changed or cannot be verified.');
    return origin.generation;
  }
  private identity(b:Binding){return hash(JSON.stringify([b.id,b.native_id,b.cwd,b.mode,b.provider,b.enabled,b.token_hash,this.store.get(`execution-mode:${b.id}`),this.store.get(`session-route:${b.id}`),this.router.coordinator?.registry.entry(b.id)]));}
  private managed(b:Binding){return b.mode!=='channel'&&this.router.native.connections?.route(b)?.transport==='managed-cli';}
  private context(row:Row):CollaborationScope {
    const source=this.store.job(row.source_id),binding=source&&this.store.binding(source.binding_id),target=this.store.binding(row.target_binding);
    const contract=this.router.contracts.approved(row.source_id);
    if(row.owner_generation===null||row.owner_generation!==(this.store.get('incoming-owner-generation')??'')||
      !source||!binding||!target||source.binding_id!==row.source_binding||source.attempt_id!==row.source_attempt||
      this.identity(binding)!==row.source_identity||hash(source.body)!==row.source_body||!this.managed(binding)||
      this.identity(target)!==row.target_identity||!this.managed(target)||!contract||contract.id!==row.contract_id||
      contract.revision!==row.revision||contract.approved_hash!==row.approved_hash||contract.dispatch_id!==row.root_id||
      contract.item_id!==row.item_id||contract.owner!==row.owner||contract.destination!==row.destination)throw new Error('The source, target or approved contract changed.');
    if(this.sourceOwner(row.root_id,row.owner,row.destination,contract.channel)!==row.owner_generation)throw new Error('The source owner connection changed.');
    this.router.contracts.assertDispatch(this.router,source.id,binding,source.body,new Set(),true);
    const scope={owner:row.owner,destination:row.destination,rootRequestId:row.root_id,itemId:row.item_id,
      contractId:row.contract_id,revision:row.revision,approvedHash:row.approved_hash};
    if(!this.selected(binding,target)||!this.authority.allows(scope,binding,target,row.summary))throw new Error('The owner-approved handoff is unavailable.');
    return scope;
  }
  private selected(source:Binding,target:Binding) {
    const c=this.router.coordinator;if(!c||!c.isCoordinator(source.id))return false;
    if(c.isCoordinator(target.id))return c.enabled().includes(target.provider)&&c.registry.entry(target.id)?.key===c.registry.identity(target).key;
    return c.scope.run(source.id,()=>c.selected().some(b=>b.id===target.id));
  }
  /** A report can continue its exact coordinator ancestry after those turns
   * have yielded. It must not ignore unrelated, busy or uncertain work. */
  private parkedAncestor(sourceId:string,job:Pick<Job,'id'|'binding_id'|'status'>){
    if(job.status!=='submitted')return false;
    const source=this.store.job(sourceId),binding=this.store.binding(job.binding_id);
    if(!source||!binding||!this.router.coordinator?.isCoordinator(binding.id)||!this.managed(binding))return false;
    const busy=this.router.busy.has(binding.id);
    if(busy&&!(source.status==='dispatched'&&source.binding_id===binding.id))return false;
    const seen=new Set<string>();let cursor=sourceId;
    while(cursor&&!seen.has(cursor)&&seen.size<8){
      seen.add(cursor);const parent=this.store.get(`parent:${cursor}`)??this.store.get(`report-parent:${cursor}`);
      if(!parent)return false;if(parent===job.id)return true;cursor=parent;
    }
    return false;
  }
  /** Internal prototype only: called by trusted bridge code during the exact managed source turn. */
  stage(sourceId:string,targetId:string,body:string,eventId:string) {
    this.store.assertIncomingOwner();
    const source=this.store.job(sourceId),from=source&&this.store.binding(source.binding_id),target=this.store.binding(targetId),c=this.router.coordinator;
    if(!source||!from||!target||target.id!==targetId||!c||!c.isCoordinator(from.id)||!target.enabled||from.id===target.id||
      !this.selected(from,target)||!this.managed(from)||!this.managed(target)||!this.router.busy.has(from.id)||source.status!=='dispatched'||!source.attempt_id)
      throw new Error('A running managed coordinator and exact managed target are required. Nothing was sent.');
    if(!/^[A-Za-z0-9._:-]{1,100}$/.test(eventId)||!body.trim()||body.length>24000)throw new Error('A bounded task and stable event ID are required.');
    const contract=this.router.contracts.approved(sourceId),item=this.store.itemOf(sourceId),root=contract?.dispatch_id,rootJob=root&&this.store.job(root);
    if(!contract||!item||contract.item_id!==item||!root||!contract.approved_hash||!rootJob)throw new Error('An exact approved owner contract and item are required.');
    const ownerGeneration=this.sourceOwner(root,contract.owner,contract.destination,contract.channel);
    this.router.contracts.assertDispatch(this.router,sourceId,from,source.body);
    const scope={owner:contract.owner,destination:contract.destination,rootRequestId:root,itemId:item,contractId:contract.id,revision:contract.revision,approvedHash:contract.approved_hash};
    if(!this.authority.allows(scope,from,target,body))throw new Error('The owner did not authorize this handoff. Nothing was sent.');
    let cursor:string|undefined=sourceId;const visited=new Set<string>();
    while(cursor){if(visited.has(cursor)||visited.size>=4)throw new Error('Collaboration delegation depth exceeded.');visited.add(cursor);if(this.store.job(cursor)?.binding_id===target.id)throw new Error('Collaboration delegation cycle refused.');cursor=this.store.get(`parent:${cursor}`)??this.store.get(`report-parent:${cursor}`);}
    const jobId=`master:${sourceId}:f5-${eventId}:${target.id}`,prior=this.row(jobId);
    if(prior){if(prior.source_id!==sourceId||prior.target_binding!==target.id||prior.summary!==body)throw new Error('The handoff ID was reused.');this.context(prior);return jobId;}
    this.store.db.exec('SAVEPOINT managed_collaboration_stage');
    try{
      const live=this.store.db.prepare("SELECT id,binding_id,status FROM inbox WHERE status IN ('queued','dispatched','submitted','uncertain') AND id<>?").all(sourceId) as Pick<Job,'id'|'binding_id'|'status'>[];
      if(live.some(j=>this.store.itemOf(j.id)===item&&!this.parkedAncestor(sourceId,j)))throw new Error('The item already has active or uncertain work.');
      // A report to the original coordinator can hand off under the same
      // approved root, while its exact source remains recorded in this row.
      const parent=sourceId.startsWith('report:')&&source.binding_id===rootJob.binding_id?root:sourceId;
      this.store.set(`parent:${jobId}`,parent);this.store.linkItem(jobId,item);
      const scoped=this.router.contracts.bindChild(this.router,parent,jobId,target,body,item);
      bindScheduledChild(this.router,parent,jobId,target,scoped);
      this.store.enqueue(jobId,target,scoped,contract.destination);
      this.store.db.prepare(`INSERT INTO managed_collaboration_handoffs(job_id,source_id,source_attempt,source_binding,source_identity,source_body,
        target_binding,target_identity,item_id,root_id,owner,destination,contract_id,revision,approved_hash,body_hash,summary,submission_started,owner_generation)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`).run(jobId,sourceId,source.attempt_id,from.id,this.identity(from),hash(source.body),target.id,this.identity(target),item,root,contract.owner,contract.destination,contract.id,contract.revision,contract.approved_hash,hash(scoped),body,ownerGeneration);
      this.store.db.exec('RELEASE managed_collaboration_stage');return jobId;
    }catch(e){this.store.db.exec('ROLLBACK TO managed_collaboration_stage; RELEASE managed_collaboration_stage');throw e;}
  }
  has(id:string){return !!this.row(id);}
  private blockers(row:Row,ignoreQueued=false) {
    const jobs=this.store.db.prepare("SELECT id,binding_id,status FROM inbox WHERE status IN ('queued','dispatched','submitted','uncertain')").all() as Pick<Job,'id'|'binding_id'|'status'>[];
    return jobs.some(j=>this.store.itemOf(j.id)===row.item_id&&j.id!==row.job_id&&!(ignoreQueued&&j.status==='queued')&&!this.parkedAncestor(row.source_id,j)&&!(j.id===row.source_id&&j.binding_id===row.source_binding&&j.status==='submitted'&&row.yielded===1&&!this.router.busy.has(row.source_binding)));
  }
  /** A staged handoff must not block unrelated queued jobs for the same session. */
  shouldHold(id:string){
    const row=this.row(id);if(row){try{this.context(row);}catch{return false;}return row.state==='waiting'&&(!row.yielded||this.router.busy.has(row.source_binding)||this.blockers(row));}
    const item=this.store.itemOf(id);if(!item)return false;
    return !!this.store.db.prepare("SELECT 1 FROM managed_collaboration_handoffs WHERE item_id=? AND state IN ('waiting','claimed') AND source_id<>? LIMIT 1").get(item,id);
  }
  private core(row:Row,finishing=false){
    const scope=()=>this.context(row),r=this.router;
    return new CollaborationHarness(this.store,{
      approved:(root,item)=>{const s=scope();return s.rootRequestId===root&&s.itemId===item?s:undefined;},
      mayWork:(_s,b)=>b.id===row.target_binding&&this.identity(b)===row.target_identity&&this.managed(b)&&!!this.store.binding(b.id)?.enabled,
      ignoreLive:(_s,j)=>j.id===row.job_id&&j.binding_id===row.target_binding||this.parkedAncestor(row.source_id,j)||j.id===row.source_id&&row.yielded===1&&!r.busy.has(row.source_binding)&&j.status==='submitted'||
        finishing&&j.status==='queued',
      observedFinished:(_s,b)=>finishing&&b.id===row.target_binding&&row.finished===1&&this.store.job(row.job_id)?.status==='completed',
    });
  }
  /** Called only inside Router's existing synchronous pre-submission guard. */
  assertDispatch(id:string,b:Binding) {
    const row=this.row(id);if(!row)return false;
    const job=this.store.job(id);if(!['waiting','claimed'].includes(row.state)||!job||!['queued','dispatched'].includes(job.status)||job.binding_id!==row.target_binding||b.id!==row.target_binding||hash(job.body)!==row.body_hash)throw new DispatchNotSubmittedError('The collaboration handoff changed. Nothing was sent.');
    if(job.status==='dispatched'&&(!job.attempt_id||row.target_attempt&&row.target_attempt!==job.attempt_id))throw new DispatchNotSubmittedError('The handoff attempt changed. Nothing was sent.');
    try{this.context(row);}catch{throw new DispatchNotSubmittedError('The collaboration owner, task or session changed. Nothing was sent.');}
    if(!row.yielded||this.router.busy.has(row.source_binding)||!row.claim_token&&this.blockers(row))throw new CollaborationHold('Waiting for the previous managed turn to finish.');
    if(row.claim_token&&this.blockers(row,true))throw new DispatchNotSubmittedError('Other work for this item is active or uncertain. Nothing was sent.');
    try{
      this.store.db.exec('SAVEPOINT managed_collaboration_claim');
      try{
        this.context(row);const core=this.core(row);
        if(row.claim_token&&row.generation!==null)core.assertClaim(row.root_id,row.item_id,b.id,row.claim_token,row.generation);
        else {const claim=core.claim(row.root_id,row.item_id,b.id,`f5-claim:${hash(id)}`);this.store.db.prepare("UPDATE managed_collaboration_handoffs SET claim_token=?,generation=?,state='claimed' WHERE job_id=? AND state='waiting'").run(claim.token,claim.generation,id);}
        if(job.status==='dispatched')this.store.db.prepare('UPDATE managed_collaboration_handoffs SET target_attempt=? WHERE job_id=? AND target_attempt IS NULL').run(job.attempt_id!,id);
        this.store.db.exec('RELEASE managed_collaboration_claim');
      }catch(e){this.store.db.exec('ROLLBACK TO managed_collaboration_claim; RELEASE managed_collaboration_claim');throw e;}
      return true;
    }catch(e){throw new DispatchNotSubmittedError('The collaboration claim or owner changed. Nothing was sent.');}
  }
  /** A hold is thrown only before provider submission; a fresh attempt may follow. */
  heldBeforeSubmission(id:string){this.store.db.prepare("UPDATE managed_collaboration_handoffs SET target_attempt=NULL WHERE job_id=? AND state='claimed'").run(id);}
  /** Called in the same transaction as the claim and dispatch attempt. */
  captureDispatchAttempt(id:string){
    const row=this.row(id);if(!row)throw new DispatchNotSubmittedError('The collaboration handoff changed. Nothing was sent.');
    try{this.context(row);}catch{throw new DispatchNotSubmittedError('The collaboration owner, task or session changed. Nothing was sent.');}
    const job=this.store.job(id);
    if(!job?.attempt_id||job.status!=='dispatched')throw new DispatchNotSubmittedError('The collaboration attempt changed. Nothing was sent.');
    const changed=this.store.db.prepare(`UPDATE managed_collaboration_handoffs SET target_attempt=?
      WHERE job_id=? AND state='claimed' AND submission_started=0 AND (target_attempt IS NULL OR target_attempt=?)`).run(job.attempt_id,id,job.attempt_id);
    if(!changed.changes)throw new DispatchNotSubmittedError('The collaboration attempt changed. Nothing was sent.');
  }
  /** Store.recover has already fenced dispatched work as uncertain. Retire
   * only a persisted zero marker tied to this exact attempt and claim. */
  private recoverKnownUnsent(){
    if(!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collaboration_claims'").get())return;
    if(!this.store.db.prepare('PRAGMA table_info(collaboration_claims)').all().some((c:any)=>c.name==='owner_generation'))
      this.store.db.exec('ALTER TABLE collaboration_claims ADD COLUMN owner_generation TEXT');
    this.store.db.exec('SAVEPOINT managed_collaboration_recover');
    try {
      const rows=this.store.db.prepare(`SELECT h.* FROM managed_collaboration_handoffs h
        JOIN inbox i ON i.id=h.job_id JOIN collaboration_claims c ON c.item_id=h.item_id
        JOIN incoming_owner_inputs a ON a.id=h.root_id
        WHERE h.state='claimed' AND h.submission_started=0 AND h.target_attempt IS NOT NULL
        AND i.status='uncertain' AND i.error='Bridge restarted during delivery. Check the native session before retrying.'
        AND i.attempt_id=h.target_attempt AND i.binding_id=h.target_binding
        AND c.token=h.claim_token AND c.generation=h.generation AND c.holder_id=h.target_binding
        AND c.owner=h.owner AND c.destination=h.destination AND c.root_request_id=h.root_id
        AND c.contract_id=h.contract_id AND c.contract_revision=h.revision AND c.approved_hash=h.approved_hash
        AND h.owner_generation IS NOT NULL AND c.owner_generation=h.owner_generation AND h.owner_generation=?
        AND a.owner=h.owner AND a.destination=h.destination AND a.generation=h.owner_generation AND a.channel=?`).all(this.store.get('incoming-owner-generation')??'',this.store.controlChannel()) as Row[];
      for(const row of rows){
        const cleared=this.store.db.prepare(`UPDATE collaboration_claims SET holder_id=NULL,holder_identity=NULL,token=NULL,lease_until=NULL
          WHERE item_id=? AND generation=? AND token=? AND holder_id=? AND owner=? AND destination=? AND root_request_id=?
          AND contract_id=? AND contract_revision=? AND approved_hash=? AND owner_generation=?`).run(row.item_id,row.generation!,row.claim_token!,row.target_binding,row.owner,row.destination,row.root_id,row.contract_id,row.revision,row.approved_hash,row.owner_generation!);
        if(!cleared.changes)continue;
        this.store.jobState(row.job_id,'failed','FarFromDesk restarted before this managed handoff was sent.');
        this.store.db.prepare("UPDATE managed_collaboration_handoffs SET state='invalid' WHERE job_id=? AND state='claimed' AND submission_started=0 AND target_attempt=?").run(row.job_id,row.target_attempt!);
      }
      this.store.db.exec('RELEASE managed_collaboration_recover');
    }catch(e){this.store.db.exec('ROLLBACK TO managed_collaboration_recover; RELEASE managed_collaboration_recover');throw e;}
  }
  /** Persist uncertainty before crossing the managed-provider boundary. */
  markSubmissionStarted(id:string,b:Binding){
    const row=this.row(id);if(!row)return;
    this.store.db.exec('SAVEPOINT managed_collaboration_submit');
    try {
      this.assertDispatch(id,b);
      const job=this.store.job(id);
      if(!job?.attempt_id||job.status!=='dispatched')throw new DispatchNotSubmittedError('The collaboration attempt changed. Nothing was sent.');
      const changed=this.store.db.prepare("UPDATE managed_collaboration_handoffs SET submission_started=1 WHERE job_id=? AND state='claimed' AND target_attempt=? AND submission_started=0").run(id,job.attempt_id);
      if(!changed.changes)throw new DispatchNotSubmittedError('The collaboration submission was already started or changed. Nothing was sent.');
      this.store.db.exec('RELEASE managed_collaboration_submit');
    } catch(e) {this.store.db.exec('ROLLBACK TO managed_collaboration_submit; RELEASE managed_collaboration_submit');throw e;}
  }
  mayHaveSubmitted(id:string){return this.row(id)?.submission_started===1;}
  /** Drop only a known-not-submitted handoff; uncertain work remains held. */
  reject(id:string,reason:string) {
    const row=this.row(id),job=this.store.job(id);
    if(!row||!job||row.submission_started||!['waiting','claimed'].includes(row.state)||!['queued','dispatched','failed'].includes(job.status)||
      row.target_attempt&&job.attempt_id!==row.target_attempt)return;
    this.store.db.exec('SAVEPOINT managed_collaboration_reject');
    try {
      if(job.status!=='failed')this.store.jobState(id,'failed',reason);
      let sourceCurrent=false;try{const contract=this.router.contracts.approved(row.source_id);sourceCurrent=!!contract&&this.sourceOwner(row.root_id,row.owner,row.destination,contract.channel)===row.owner_generation;}catch{}
      if(row.claim_token&&row.generation!==null&&row.owner_generation!==null&&sourceCurrent)this.store.db.prepare(`UPDATE collaboration_claims SET holder_id=NULL,holder_identity=NULL,token=NULL,lease_until=NULL
        WHERE item_id=? AND generation=? AND token=? AND holder_id=? AND owner=? AND destination=? AND root_request_id=?
        AND contract_id=? AND contract_revision=? AND approved_hash=? AND owner_generation=?`).run(row.item_id,row.generation,row.claim_token,row.target_binding,row.owner,row.destination,row.root_id,row.contract_id,row.revision,row.approved_hash,row.owner_generation);
      this.store.db.prepare("UPDATE managed_collaboration_handoffs SET state='invalid' WHERE job_id=? AND state IN ('waiting','claimed') AND submission_started=0").run(id);
      this.store.db.exec('RELEASE managed_collaboration_reject');
    } catch(e) {this.store.db.exec('ROLLBACK TO managed_collaboration_reject; RELEASE managed_collaboration_reject');throw e;}
  }
  /** Called solely after NativeAgents.run has resolved a managed provider turn. */
  managedTurnEnded(id:string,b:Binding) {
    const job=this.store.job(id);if(!job||job.binding_id!==b.id||!this.managed(b))return;
    for(const row of this.store.db.prepare("SELECT * FROM managed_collaboration_handoffs WHERE source_id=? AND state='waiting'").all(id) as Row[]){
      try{this.context(row);if(job.attempt_id===row.source_attempt&&(job.status==='submitted'||job.status==='completed'&&job.id.startsWith('report:')))this.store.db.prepare('UPDATE managed_collaboration_handoffs SET yielded=1 WHERE job_id=? AND source_attempt=?').run(row.job_id,row.source_attempt);}catch{}
    }
    const row=this.row(id);if(!row||row.state!=='claimed'||!row.claim_token||job.status!=='completed'||!job.attempt_id||job.attempt_id!==row.target_attempt)return;
    // Do not infer test/proof success from a final reply: only the managed turn's
    // liveness ended. Refuse release if other linked work is still active.
    this.store.db.exec('SAVEPOINT managed_collaboration_finish');
    try{
      this.context(row);this.store.db.prepare('UPDATE managed_collaboration_handoffs SET finished=1 WHERE job_id=?').run(id);
      const finished=this.row(id)!;this.core(finished,true).releaseObserved(finished.root_id,finished.item_id,finished.claim_token!,`f5-release:${hash(id)}`);
      this.store.db.prepare("UPDATE managed_collaboration_handoffs SET state='complete' WHERE job_id=?").run(id);this.store.db.exec('RELEASE managed_collaboration_finish');
    }catch{this.store.db.exec('ROLLBACK TO managed_collaboration_finish; RELEASE managed_collaboration_finish');}
  }
  /** This is recorded task context, never a verified outcome or a Meta drift check. */
  history(root:string,itemId:number) {
    const rows=this.store.db.prepare('SELECT * FROM managed_collaboration_handoffs WHERE root_id=? AND item_id=? ORDER BY rowid').all(root,itemId) as Row[];
    return rows.filter(row=>{try{this.context(row);return true;}catch{return false;}}).map(row=>{
      const text=row.state==='complete'?this.store.get(`final-reply:${row.job_id}`):undefined;
      return {sourceId:row.source_id,targetBindingId:row.target_binding,itemId:row.item_id,contractId:row.contract_id,revision:row.revision,approvedHash:row.approved_hash,summary:row.summary,
        result:text===undefined?null:{kind:'session_report' as const,verification:'unverified' as const,text},state:row.state,drift:'not_checked' as const};
    });
  }
}
