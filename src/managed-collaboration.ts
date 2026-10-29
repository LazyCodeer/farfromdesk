import {CollaborationHarness,type CollaborationScope} from './collaboration-harness.js';
import {randomUUID} from 'node:crypto';
import {installCollaborationDispatchFence} from './collaboration-dispatch-fence.js';
import {hasUnresolvedProviderSetup} from './provider-setup-barrier.js';
import {DispatchNotSubmittedError} from './brief-dispatch-guard.js';
import {bindScheduledChild} from './schedules.js';
import {hash,type Binding,type Job} from './store.js';
import type {Router} from './router.js';

/** A managed handoff remains queued until a verified source turn has ended. */
export class CollaborationHold extends DispatchNotSubmittedError {}
/** Trusted bridge code returns the current approval revision, or refuses the handoff. */
export type HandoffAuthority={authorize(scope:CollaborationScope,from:Binding,to:Binding,summary:string,role:string,stage:{sourceId:string;jobId:string}):string|undefined};
/** Trusted provider adapter only: revisions attest provider-enforced ownership
 * of both exact sessions, including the source since before dispatch. Revisions
 * are non-secret IDs, never reused after a fence is lost. A local mutex or
 * process scan is not sufficient. The report needs its own exact attempt fence. */
export type ProviderExclusivity={
  authorize(scope:CollaborationScope,from:Binding,to:Binding,sourceAttempt:string,ownerGeneration:string,targetAttempt?:string):string|undefined;
  authorizeReport(scope:CollaborationScope,binding:Binding,reportId:string,attemptId:string,ownerGeneration:string):string|undefined;
  /** Must attest this exact turn ended with no continuation or background work. */
  finished(scope:CollaborationScope,binding:Binding,requestId:string,attemptId:string,ownerGeneration:string,revision:string):boolean;
};
type Row={job_id:string;source_id:string;source_attempt:string;source_binding:string;source_identity:string;source_body:string;
  target_binding:string;target_identity:string;item_id:number;root_id:string;owner:string;destination:string;
  contract_id:string;revision:number;approved_hash:string;body_hash:string;summary:string;yielded:number;
  claim_token:string|null;generation:number|null;target_attempt:string|null;submission_started:number;finished:number;state:string;owner_generation:string|null;
  handoff_role:string|null;authority_revision:string|null;role_order_version:number|null;finished_event_id:number|null;exclusive_revision:string|null};

/** Experimental internal adapter. No endpoint or default Router enables this. */
export class ManagedCollaboration {
  constructor(private router:Router,private authority:HandoffAuthority,private exclusivity?:ProviderExclusivity) {
    router.store.db.exec('SAVEPOINT managed_collaboration_init');
    try {
    // Acquire a write lock before inspecting legacy handoffs. Setup reservation
    // and workflow migration must never publish concurrently.
    router.store.db.exec(`CREATE TABLE IF NOT EXISTS collaboration_init_lock(id INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO collaboration_init_lock VALUES(1);
      UPDATE collaboration_init_lock SET id=id WHERE id=1`);
    router.store.db.exec(`CREATE TABLE IF NOT EXISTS managed_collaboration_handoffs(
      job_id TEXT PRIMARY KEY,source_id TEXT NOT NULL,source_attempt TEXT NOT NULL,source_binding TEXT NOT NULL,
      source_identity TEXT NOT NULL,source_body TEXT NOT NULL,target_binding TEXT NOT NULL,target_identity TEXT NOT NULL,
      item_id INTEGER NOT NULL,root_id TEXT NOT NULL,owner TEXT NOT NULL,destination TEXT NOT NULL,
      contract_id TEXT NOT NULL,revision INTEGER NOT NULL,approved_hash TEXT NOT NULL,body_hash TEXT NOT NULL,
      summary TEXT NOT NULL,yielded INTEGER NOT NULL DEFAULT 0,claim_token TEXT,generation INTEGER,target_attempt TEXT,submission_started INTEGER NOT NULL DEFAULT 0,
      finished INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'waiting',owner_generation TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS managed_collaboration_active_item ON managed_collaboration_handoffs(item_id) WHERE state IN ('waiting','claimed');
      CREATE TABLE IF NOT EXISTS collaboration_workflow_reservations(
      root_id TEXT NOT NULL,item_id INTEGER NOT NULL,approval TEXT NOT NULL,created_at INTEGER NOT NULL,
      PRIMARY KEY(root_id,item_id,approval));
      CREATE TABLE IF NOT EXISTS collaboration_report_attempts(
      job_id TEXT PRIMARY KEY,source_id TEXT NOT NULL,root_id TEXT NOT NULL,item_id INTEGER NOT NULL,approval TEXT NOT NULL,attempt_id TEXT NOT NULL,exclusive_revision TEXT);
      CREATE TABLE IF NOT EXISTS managed_collaboration_turn_ends(
      request_id TEXT NOT NULL,attempt_id TEXT NOT NULL,binding_id TEXT NOT NULL,binding_identity TEXT NOT NULL,
      body_hash TEXT NOT NULL,owner_generation TEXT NOT NULL,root_id TEXT NOT NULL,item_id INTEGER NOT NULL,
      contract_id TEXT NOT NULL,revision INTEGER NOT NULL,approved_hash TEXT NOT NULL,ended_event_id INTEGER,PRIMARY KEY(request_id,attempt_id));`);
    // Older prototype rows have no trustworthy submission boundary.
    if(!router.store.db.prepare('PRAGMA table_info(managed_collaboration_handoffs)').all().some((c:any)=>c.name==='submission_started'))
      router.store.db.exec('ALTER TABLE managed_collaboration_handoffs ADD COLUMN submission_started INTEGER NOT NULL DEFAULT 1');
    if(!router.store.db.prepare('PRAGMA table_info(managed_collaboration_handoffs)').all().some((c:any)=>c.name==='owner_generation'))
      router.store.db.exec('ALTER TABLE managed_collaboration_handoffs ADD COLUMN owner_generation TEXT');
    // Old rows have no role approval revision and cannot acquire one retroactively.
    for(const column of ['handoff_role','authority_revision'])
      if(!router.store.db.prepare('PRAGMA table_info(managed_collaboration_handoffs)').all().some((c:any)=>c.name===column))
        router.store.db.exec(`ALTER TABLE managed_collaboration_handoffs ADD COLUMN ${column} TEXT`);
    if(!router.store.db.prepare('PRAGMA table_info(managed_collaboration_handoffs)').all().some((c:any)=>c.name==='role_order_version'))
      router.store.db.exec('ALTER TABLE managed_collaboration_handoffs ADD COLUMN role_order_version INTEGER');
    if(!router.store.db.prepare('PRAGMA table_info(managed_collaboration_handoffs)').all().some((c:any)=>c.name==='finished_event_id'))
      router.store.db.exec('ALTER TABLE managed_collaboration_handoffs ADD COLUMN finished_event_id INTEGER');
    if(!router.store.db.prepare('PRAGMA table_info(managed_collaboration_handoffs)').all().some((c:any)=>c.name==='exclusive_revision'))
      router.store.db.exec('ALTER TABLE managed_collaboration_handoffs ADD COLUMN exclusive_revision TEXT');
    if(!router.store.db.prepare('PRAGMA table_info(collaboration_report_attempts)').all().some((c:any)=>c.name==='exclusive_revision'))
      router.store.db.exec('ALTER TABLE collaboration_report_attempts ADD COLUMN exclusive_revision TEXT');
    if(router.store.db.prepare('SELECT 1 FROM managed_collaboration_handoffs LIMIT 1').get()&&hasUnresolvedProviderSetup(router.store))
      throw new Error('Existing collaboration and provider setup are both unresolved. Reconciliation is required.');
    router.store.db.exec(`INSERT OR IGNORE INTO collaboration_workflow_reservations(root_id,item_id,approval,created_at)
      SELECT root_id,item_id,COALESCE(authority_revision,'legacy:'||job_id),0 FROM managed_collaboration_handoffs`);
    if(!router.store.db.prepare('PRAGMA table_info(managed_collaboration_turn_ends)').all().some((c:any)=>c.name==='ended_event_id'))
      router.store.db.exec('ALTER TABLE managed_collaboration_turn_ends ADD COLUMN ended_event_id INTEGER');
    new CollaborationHarness(router.store,{approved:()=>undefined,mayWork:()=>false});
    installCollaborationDispatchFence(router.store);
    this.recoverKnownUnsent();
    router.store.db.exec('RELEASE managed_collaboration_init');
    }catch(e){router.store.db.exec('ROLLBACK TO managed_collaboration_init; RELEASE managed_collaboration_init');throw e;}
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
    if(hasUnresolvedProviderSetup(this.store))throw new Error('Provider setup or recovery is unresolved.');
    const source=this.store.job(row.source_id),binding=source&&this.store.binding(source.binding_id),target=this.store.binding(row.target_binding);
    const contract=this.router.contracts.approved(row.source_id);
    if(row.owner_generation===null||row.owner_generation!==(this.store.get('incoming-owner-generation')??'')||
      !source||!binding||!target||source.binding_id!==row.source_binding||source.attempt_id!==row.source_attempt||
      this.identity(binding)!==row.source_identity||hash(source.body)!==row.source_body||binding.provider!=='codex'||!this.managed(binding)||
      this.identity(target)!==row.target_identity||target.provider!=='codex'||!this.managed(target)||!contract||contract.id!==row.contract_id||
      contract.revision!==row.revision||contract.approved_hash!==row.approved_hash||contract.dispatch_id!==row.root_id||
      contract.item_id!==row.item_id||contract.owner!==row.owner||contract.destination!==row.destination)throw new Error('The source, target or approved contract changed.');
    if(this.sourceOwner(row.root_id,row.owner,row.destination,contract.channel)!==row.owner_generation)throw new Error('The source owner connection changed.');
    this.router.contracts.assertDispatch(this.router,source.id,binding,source.body,new Set(),true);
    const scope={owner:row.owner,destination:row.destination,rootRequestId:row.root_id,itemId:row.item_id,
      contractId:row.contract_id,revision:row.revision,approvedHash:row.approved_hash};
    if(row.handoff_role===null||row.authority_revision===null||row.exclusive_revision===null||row.role_order_version!==1||!this.selected(binding,target)||
      this.authority.authorize(scope,binding,target,row.summary,row.handoff_role,{sourceId:row.source_id,jobId:row.job_id})!==row.authority_revision)throw new Error('The owner-approved handoff is unavailable.');
    if(this.exclusivity?.authorize(scope,binding,target,row.source_attempt,row.owner_generation,row.target_attempt??undefined)!==row.exclusive_revision)throw new Error('Provider session exclusivity is unavailable.');
    if(!this.ordered(scope,row.authority_revision,row.handoff_role,row.source_id,row.job_id))throw new Error('The collaboration stage order changed.');
    return scope;
  }
  /** Enforce the order even if a trusted authority callback is too permissive. */
  private ordered(scope:CollaborationScope,approval:string,role:string,sourceId:string,jobId:string):boolean {
    try {
      const order=['plan','build','review'],index=order.indexOf(role);if(index<0)return false;
      const generation=this.store.get('incoming-owner-generation')??'';
      const rows=this.store.db.prepare(`SELECT * FROM managed_collaboration_handoffs WHERE root_id=? AND item_id=? AND owner=? AND destination=?
        AND owner_generation=? AND contract_id=? AND revision=? AND approved_hash=? AND authority_revision=?`)
        .all(scope.rootRequestId,scope.itemId,scope.owner,scope.destination,generation,scope.contractId,scope.revision,scope.approvedHash,approval) as Row[];
      if(rows.some(r=>r.role_order_version!==1||!order.includes(r.handoff_role??'')||!['waiting','claimed','complete','invalid'].includes(r.state)))return false;
      for(const failed of rows.filter(r=>r.state==='invalid')){
        const job=this.store.job(failed.job_id);
        if(failed.role_order_version!==1||failed.submission_started!==0||job?.status!=='failed'||
          failed.claim_token&&this.store.db.prepare('SELECT 1 FROM collaboration_claims WHERE item_id=? AND token=?').get(scope.itemId,failed.claim_token))return false;
      }
      const steps=rows.filter(r=>r.state!=='invalid');let previous:string|undefined;
      for(let i=0;i<=index;i++){
        const found=steps.filter(r=>r.handoff_role===order[i]);if(found.length>1)return false;
        const step=found[0],expected=i===0?scope.rootRequestId:`report:${previous}`;
        if(i===index){if(sourceId!==expected||step&&step.job_id!==jobId||!step&&steps.some(r=>order.indexOf(r.handoff_role??'')>index))return false;}
        else {
          if(!step||step.state!=='complete'||step.finished!==1||step.submission_started!==1||!step.finished_event_id||!step.target_attempt)return false;
          const job=this.store.job(step.job_id);
          if(!job||job.status!=='completed'||job.binding_id!==step.target_binding||job.attempt_id!==step.target_attempt||job.outcome==='blocked'||job.outcome==='cancelled'||
            this.store.db.prepare("SELECT 1 FROM request_events WHERE request_id=? AND id>? AND event IN ('queued','dispatched','uncertain','failed','cancelled','completed','reviewed','auto_closed','replaced') LIMIT 1").get(step.job_id,step.finished_event_id))return false;
          if(!this.knownEnded({id:step.job_id,binding_id:step.target_binding,status:'completed'}))return false;
        }
        if(step&&(step.role_order_version!==1||step.source_id!==expected))return false;
        if(i>0){const report=this.store.db.prepare('SELECT source_id FROM task_contract_report_sources WHERE job_id=?').get(expected) as {source_id:string}|undefined;if(report?.source_id!==previous)return false;}
        previous=step?.job_id;
      }
      return true;
    }catch{return false;}
  }
  private selected(source:Binding,target:Binding) {
    const c=this.router.coordinator;if(!c||!c.isCoordinator(source.id))return false;
    if(c.isCoordinator(target.id))return c.enabled().includes(target.provider)&&c.registry.entry(target.id)?.key===c.registry.identity(target).key;
    return c.scope.run(source.id,()=>c.selected().some(b=>b.id===target.id));
  }
  /** Only a still-valid, exact managed Codex turn-end record can authorize a yield. */
  private confirmedEnded(id:string){
    try{
      const job=this.store.job(id),binding=job&&this.store.binding(job.binding_id),contract=this.router.contracts.approved(id);
      if(!job?.attempt_id||!binding||binding.provider!=='codex'||!this.managed(binding)||!this.router.coordinator?.isCoordinator(binding.id)||
        !(job.status==='submitted'||job.status==='completed'&&id.startsWith('report:'))||!contract?.dispatch_id||!contract.item_id||!contract.approved_hash||this.store.itemOf(id)!==contract.item_id)return false;
      const generation=this.sourceOwner(contract.dispatch_id,contract.owner,contract.destination,contract.channel);
      this.router.contracts.assertDispatch(this.router,id,binding,job.body,new Set(),true);
      const recorded=!!this.store.db.prepare(`SELECT 1 FROM managed_collaboration_turn_ends e WHERE request_id=? AND attempt_id=? AND binding_id=? AND binding_identity=? AND body_hash=? AND owner_generation=? AND root_id=? AND item_id=? AND contract_id=? AND revision=? AND approved_hash=? AND ended_event_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM request_events r WHERE r.request_id=e.request_id AND r.id>e.ended_event_id AND r.event IN ('queued','dispatched','uncertain','failed','cancelled','completed','reviewed','auto_closed','replaced'))`)
        .get(id,job.attempt_id,binding.id,this.identity(binding),hash(job.body),generation,contract.dispatch_id,contract.item_id,contract.id,contract.revision,contract.approved_hash);
      return recorded&&this.sourceFinished(id,binding,job.attempt_id);
    }catch{return false;}
  }
  /** A report can continue its exact coordinator ancestry after those turns
   * have yielded. It must not ignore unrelated, busy or uncertain work. */
  private parkedAncestor(sourceId:string,job:Pick<Job,'id'|'binding_id'|'status'>){
    if(job.status!=='submitted')return false;
    const source=this.store.job(sourceId),binding=this.store.binding(job.binding_id);
    if(!source||!binding||!this.confirmedEnded(job.id))return false;
    // Submitted can be restored by late progress after an uncertain transport.
    // Only the exact provider turn's successful return proves it ended.
    try{
      const contract=this.router.contracts.approved(job.id),sourceContract=this.router.contracts.approved(sourceId);
      if(!contract||!sourceContract||sourceContract.id!==contract.id||sourceContract.approved_hash!==contract.approved_hash)return false;
    }catch{return false;}
    const busy=this.router.busy.has(binding.id);
    if(busy&&!(source.status==='dispatched'&&source.binding_id===binding.id))return false;
    const seen=new Set<string>();let cursor=sourceId;
    while(cursor&&!seen.has(cursor)&&seen.size<8){
      seen.add(cursor);const parent=this.store.get(`parent:${cursor}`)??this.store.get(`report-parent:${cursor}`);
      if(!parent)return false;if(parent===job.id)return true;cursor=parent;
    }
    return false;
  }
  /** A completed reply alone does not establish that its provider stopped. */
  private knownEnded(job:Pick<Job,'id'|'binding_id'|'status'>) {
    const row=this.row(job.id),current=this.store.job(job.id);
    if(row?.state==='invalid'&&row.submission_started===0&&current?.status==='failed'&&
      (!row.target_attempt||row.target_attempt===current.attempt_id)&&
      (!row.claim_token||!this.store.db.prepare('SELECT 1 FROM collaboration_claims WHERE item_id=? AND token=?').get(row.item_id,row.claim_token)))return true;
    if(job.status!=='completed')return false;
    if(job.id.startsWith('report:')&&this.confirmedEnded(job.id))return true;
    if(!row||!current||row.state!=='complete'||row.finished!==1||!row.finished_event_id||!row.target_attempt||
      current.attempt_id!==row.target_attempt||current.binding_id!==row.target_binding)return false;
    if(this.store.db.prepare("SELECT 1 FROM request_events WHERE request_id=? AND id>? AND event IN ('queued','dispatched','uncertain','failed','cancelled','completed','reviewed','auto_closed','replaced') LIMIT 1").get(job.id,row.finished_event_id))return false;
    try {
      const binding=this.store.binding(row.target_binding),scope=this.context(row);
      return !!binding&&!!row.exclusive_revision&&!!row.owner_generation&&this.finishedProvider(scope,binding,row.job_id,row.target_attempt,row.owner_generation,row.exclusive_revision);
    }catch{return false;}
  }
  /** A claim also fences the exact session, including work on other items. */
  private competingSessionWork(bindingId:string,exceptId:string,sourceId:string) {
    const jobs=this.store.db.prepare("SELECT id,binding_id,status FROM inbox WHERE binding_id=? AND id<>? AND (status IN ('dispatched','submitted','uncertain') OR attempt_id IS NOT NULL)").all(bindingId,exceptId) as Pick<Job,'id'|'binding_id'|'status'>[];
    return jobs.some(j=>!this.knownEnded(j)&&!this.parkedAncestor(sourceId,j));
  }
  /** Internal prototype only: called by trusted bridge code during the exact managed source turn. */
  stage(sourceId:string,targetId:string,body:string,eventId:string,role='plan') {
    this.store.assertIncomingOwner();
    const source=this.store.job(sourceId),from=source&&this.store.binding(source.binding_id),target=this.store.binding(targetId),c=this.router.coordinator;
    if(!source||!from||!target||from.provider!=='codex'||target.provider!=='codex'||target.id!==targetId||!c||!c.isCoordinator(from.id)||!target.enabled||from.id===target.id||
      !this.selected(from,target)||!this.managed(from)||!this.managed(target)||!this.router.busy.has(from.id)||source.status!=='dispatched'||!source.attempt_id)
      throw new Error('A running managed Codex coordinator and exact managed Codex target are required. Nothing was sent.');
    if(!/^[A-Za-z0-9._:-]{1,100}$/.test(eventId)||!body.trim()||body.length>24000||!/^(?:[a-z][a-z0-9-]{0,31})?$/.test(role))throw new Error('A bounded task, role and stable event ID are required.');
    const contract=this.router.contracts.approved(sourceId),item=this.store.itemOf(sourceId),root=contract?.dispatch_id,rootJob=root&&this.store.job(root);
    if(!contract||!item||contract.item_id!==item||!root||!contract.approved_hash||!rootJob)throw new Error('An exact approved owner contract and item are required.');
    const ownerGeneration=this.sourceOwner(root,contract.owner,contract.destination,contract.channel);
    this.router.contracts.assertDispatch(this.router,sourceId,from,source.body);
    const scope={owner:contract.owner,destination:contract.destination,rootRequestId:root,itemId:item,contractId:contract.id,revision:contract.revision,approvedHash:contract.approved_hash};
    const jobId=`master:${sourceId}:f5-${eventId}:${target.id}`;
    const authorityRevision=this.authority.authorize(scope,from,target,body,role,{sourceId,jobId});
    if(!authorityRevision||!/^[A-Za-z0-9._:-]{1,128}$/.test(authorityRevision))throw new Error('The owner did not authorize this handoff. Nothing was sent.');
    const exclusiveRevision=this.exclusivity?.authorize(scope,from,target,source.attempt_id,ownerGeneration);
    if(!exclusiveRevision||!/^[A-Za-z0-9._:-]{1,128}$/.test(exclusiveRevision))throw new Error('Provider session exclusivity is unavailable. Nothing was sent.');
    let cursor:string|undefined=sourceId;const visited=new Set<string>();
    while(cursor){if(visited.has(cursor)||visited.size>=4)throw new Error('Collaboration delegation depth exceeded.');visited.add(cursor);if(this.store.job(cursor)?.binding_id===target.id)throw new Error('Collaboration delegation cycle refused.');cursor=this.store.get(`parent:${cursor}`)??this.store.get(`report-parent:${cursor}`);}
    const prior=this.row(jobId);
    if(prior){if(prior.source_id!==sourceId||prior.target_binding!==target.id||prior.summary!==body||prior.handoff_role!==role||prior.authority_revision!==authorityRevision||prior.exclusive_revision!==exclusiveRevision)throw new Error('The handoff ID was reused.');this.context(prior);return jobId;}
    this.store.db.exec('SAVEPOINT managed_collaboration_stage');
    try{
      if(hasUnresolvedProviderSetup(this.store))throw new Error('Provider setup or recovery is unresolved.');
      if(this.competingSessionWork(from.id,sourceId,sourceId)||this.competingSessionWork(target.id,jobId,sourceId))throw new Error('A collaboration session already has active or uncertain work.');
      const live=this.store.db.prepare("SELECT id,binding_id,status FROM inbox WHERE (status IN ('queued','dispatched','submitted','uncertain') OR attempt_id IS NOT NULL) AND id<>?").all(sourceId) as Pick<Job,'id'|'binding_id'|'status'>[];
      if(live.some(j=>this.store.itemsInAncestry(j.id).includes(item)&&!this.parkedAncestor(sourceId,j)&&!this.knownEnded(j)))throw new Error('The item already has active or uncertain work.');
      if(!this.ordered(scope,authorityRevision,role,sourceId,jobId))throw new Error('The collaboration stage order is unavailable. Nothing was sent.');
      this.store.db.prepare('INSERT OR IGNORE INTO collaboration_workflow_reservations(root_id,item_id,approval,created_at) VALUES(?,?,?,?)').run(root,item,authorityRevision,Date.now());
      // A report to the original coordinator can hand off under the same
      // approved root, while its exact source remains recorded in this row.
      const parent=sourceId.startsWith('report:')&&source.binding_id===rootJob.binding_id?root:sourceId;
      this.store.set(`parent:${jobId}`,parent);this.store.linkItem(jobId,item);
      const scoped=this.router.contracts.bindChild(this.router,parent,jobId,target,body,item);
      bindScheduledChild(this.router,parent,jobId,target,scoped);
      this.store.enqueue(jobId,target,scoped,contract.destination);
      this.store.db.prepare(`INSERT INTO managed_collaboration_handoffs(job_id,source_id,source_attempt,source_binding,source_identity,source_body,
        target_binding,target_identity,item_id,root_id,owner,destination,contract_id,revision,approved_hash,body_hash,summary,submission_started,owner_generation,handoff_role,authority_revision,role_order_version,exclusive_revision)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,1,?)`).run(jobId,sourceId,source.attempt_id,from.id,this.identity(from),hash(source.body),target.id,this.identity(target),item,root,contract.owner,contract.destination,contract.id,contract.revision,contract.approved_hash,hash(scoped),body,ownerGeneration,role,authorityRevision,exclusiveRevision);
      this.context(this.row(jobId)!);
      this.store.db.exec('RELEASE managed_collaboration_stage');return jobId;
    }catch(e){this.store.db.exec('ROLLBACK TO managed_collaboration_stage; RELEASE managed_collaboration_stage');throw e;}
  }
  has(id:string){return !!this.row(id);}
  private workflowReport(id:string,b:Binding,workflow:{root_id:string;item_id:number;approval:string}) {
    const job=this.store.job(id);
    if(!job||job.binding_id!==b.id||!(job.status==='queued'&&!job.attempt_id||job.status==='dispatched'&&!!job.attempt_id))return false;
    const prior=this.store.db.prepare(`SELECT h.* FROM managed_collaboration_handoffs h
      JOIN task_contract_report_sources r ON r.source_id=h.job_id
      WHERE r.job_id=? AND ?='report:'||h.job_id AND h.root_id=? AND h.item_id=? AND h.authority_revision=?
      AND h.source_binding=? AND h.state='complete' AND h.finished=1 AND h.role_order_version=1`).get(id,id,workflow.root_id,workflow.item_id,workflow.approval,b.id) as Row|undefined;
    if(!prior||!this.knownEnded({id:prior.job_id,binding_id:prior.target_binding,status:'completed'}))return false;
    if(job.status==='dispatched')return this.validReportFence(id,b,job.attempt_id!);
    return true;
  }
  private validReportFence(id:string,b:Binding,attempt:string) {
    try {
      const record=this.store.db.prepare('SELECT * FROM collaboration_report_attempts WHERE job_id=? AND attempt_id=?').get(id,attempt) as {source_id:string;root_id:string;item_id:number;approval:string;exclusive_revision:string|null}|undefined;
      const prior=record&&this.row(record.source_id);
      if(!record||!prior||!record.exclusive_revision||prior.root_id!==record.root_id||prior.item_id!==record.item_id||prior.authority_revision!==record.approval||prior.source_binding!==b.id)return false;
      const scope=this.context(prior);
      return this.exclusivity?.authorizeReport(scope,b,id,attempt,prior.owner_generation!)===record.exclusive_revision;
    }catch{return false;}
  }
  private finishedProvider(scope:CollaborationScope,b:Binding,id:string,attempt:string,generation:string,revision:string) {
    try{return this.exclusivity?.finished(scope,b,id,attempt,generation,revision)===true;}catch{return false;}
  }
  private sourceFinished(id:string,b:Binding,attempt:string) {
    try {
      const report=this.store.db.prepare('SELECT source_id,exclusive_revision FROM collaboration_report_attempts WHERE job_id=? AND attempt_id=?').get(id,attempt) as {source_id:string;exclusive_revision:string|null}|undefined;
      if(report){
        const prior=this.row(report.source_id);if(!prior||!report.exclusive_revision||!this.validReportFence(id,b,attempt))return false;
        return this.finishedProvider(this.context(prior),b,id,attempt,prior.owner_generation!,report.exclusive_revision);
      }
      const rows=this.store.db.prepare("SELECT * FROM managed_collaboration_handoffs WHERE source_id=? AND source_attempt=? AND state IN ('waiting','claimed','complete')").all(id,attempt) as Row[];
      return rows.some(row=>!!row.exclusive_revision&&!!row.owner_generation&&this.finishedProvider(this.context(row),b,id,attempt,row.owner_generation,row.exclusive_revision));
    }catch{return false;}
  }
  /** Reserve the exact coordinator report attempt in the dispatch transaction. */
  reserveWorkflowReport(id:string,b:Binding):string|undefined {
    const items=this.store.itemsInAncestry(id),workflows=this.store.db.prepare('SELECT * FROM collaboration_workflow_reservations').all() as {root_id:string;item_id:number;approval:string}[];
    const relevant=workflows.filter(w=>items.includes(w.item_id)||!!this.store.db.prepare('SELECT 1 FROM managed_collaboration_handoffs WHERE root_id=? AND item_id=? AND authority_revision=? AND source_binding=? LIMIT 1').get(w.root_id,w.item_id,w.approval,b.id));
    if(!relevant.length)return;
    if(relevant.length!==1||!this.workflowReport(id,b,relevant[0]))throw new CollaborationHold('The collaboration report is unavailable.');
    const source=this.store.db.prepare('SELECT source_id FROM task_contract_report_sources WHERE job_id=?').get(id) as {source_id:string}|undefined;
    if(!source?.source_id||this.store.db.prepare('SELECT 1 FROM collaboration_report_attempts WHERE job_id=?').get(id))throw new CollaborationHold('The collaboration report attempt already exists.');
    const attempt=randomUUID(),w=relevant[0],prior=this.row(source.source_id);
    if(!prior)throw new CollaborationHold('The collaboration report source is unavailable.');
    const scope=this.context(prior),exclusive=this.exclusivity?.authorizeReport(scope,b,id,attempt,prior.owner_generation!);
    if(!exclusive||!/^[A-Za-z0-9._:-]{1,128}$/.test(exclusive))throw new CollaborationHold('Provider report exclusivity is unavailable.');
    this.store.db.prepare('INSERT INTO collaboration_report_attempts(job_id,source_id,root_id,item_id,approval,attempt_id,exclusive_revision) VALUES(?,?,?,?,?,?,?)')
      .run(id,source.source_id,w.root_id,w.item_id,w.approval,attempt,exclusive);
    return attempt;
  }
  /** Recheck every ordinary, item-linked delivery, including after readiness.
   * A retained claim blocks work even when its handoff row was invalidated. */
  assertOrdinaryDispatch(id:string,b:Binding) {
    if(this.has(id))return;
    // A released claim is safe only while the exact target completion remains
    // valid. Provider evidence may be revoked after the claim was released.
    for(const row of this.store.db.prepare("SELECT * FROM managed_collaboration_handoffs WHERE target_binding=? AND state='complete'").all(b.id) as Row[]){
      const completed=this.store.job(row.job_id);
      if(!completed||!this.knownEnded(completed))throw new CollaborationHold('This session has an uncertain collaboration completion.');
    }
    if(this.store.db.prepare("SELECT 1 FROM managed_collaboration_handoffs WHERE source_binding=? AND source_id<>? AND state IN ('waiting','claimed')").get(b.id,id))
      throw new CollaborationHold('This session is yielding a collaboration handoff.');
    const claimTable=this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collaboration_claims'").get();
    if(claimTable&&this.store.db.prepare('SELECT 1 FROM collaboration_claims WHERE holder_id=? AND token IS NOT NULL').get(b.id))
      throw new CollaborationHold('This session has an active or uncertain collaboration claim.');
    const items=this.store.itemsInAncestry(id),job=this.store.job(id);
    const workflows=this.store.db.prepare('SELECT * FROM collaboration_workflow_reservations').all() as {root_id:string;item_id:number;approval:string}[];
    for(const workflow of workflows){
      const source=this.store.db.prepare(`SELECT * FROM managed_collaboration_handoffs WHERE root_id=? AND item_id=? AND authority_revision=?
        AND source_binding=? AND state IN ('waiting','claimed') AND source_id=?`).get(workflow.root_id,workflow.item_id,workflow.approval,b.id,id) as Row|undefined;
      const relevant=items.includes(workflow.item_id)||!!this.store.db.prepare('SELECT 1 FROM managed_collaboration_handoffs WHERE root_id=? AND item_id=? AND authority_revision=? AND source_binding=? LIMIT 1').get(workflow.root_id,workflow.item_id,workflow.approval,b.id);
      if(!relevant)continue;
      if(source?.state==='waiting'&&job?.status==='dispatched'&&job.attempt_id===source.source_attempt&&this.identity(b)===source.source_identity)continue;
      if(this.workflowReport(id,b,workflow))continue;
      throw new CollaborationHold('This item or session belongs to an unresolved collaboration workflow.');
    }
    for(const item of items){
      if(claimTable&&this.store.db.prepare('SELECT 1 FROM collaboration_claims WHERE item_id=? AND token IS NOT NULL').get(item))
        throw new CollaborationHold('This item has an active or uncertain collaboration claim.');
      const active=this.store.db.prepare("SELECT * FROM managed_collaboration_handoffs WHERE item_id=? AND state IN ('waiting','claimed')").get(item) as Row|undefined;
      if(!active)continue;
      if(active.state==='waiting'&&active.source_id===id&&active.source_binding===b.id&&job?.status==='dispatched'&&job.attempt_id===active.source_attempt&&this.identity(b)===active.source_identity)continue;
      throw new CollaborationHold('This item is waiting for its collaboration handoff.');
    }
  }
  private blockers(row:Row,ignoreQueued=false) {
    if(this.competingSessionWork(row.source_binding,row.source_id,row.source_id)||this.competingSessionWork(row.target_binding,row.job_id,row.source_id))return true;
    const jobs=this.store.db.prepare("SELECT id,binding_id,status FROM inbox WHERE status IN ('queued','dispatched','submitted','uncertain') OR attempt_id IS NOT NULL").all() as Pick<Job,'id'|'binding_id'|'status'>[];
    return jobs.some(j=>this.store.itemsInAncestry(j.id).includes(row.item_id)&&j.id!==row.job_id&&!(ignoreQueued&&j.status==='queued')&&!this.parkedAncestor(row.source_id,j)&&!this.knownEnded(j)&&!(j.id===row.source_id&&j.binding_id===row.source_binding&&j.status==='submitted'&&row.yielded===1&&this.confirmedEnded(j.id)&&!this.router.busy.has(row.source_binding)));
  }
  /** A staged handoff must not block unrelated queued jobs for the same session. */
  shouldHold(id:string){
    const row=this.row(id);if(row){try{this.context(row);}catch{return false;}return row.state==='waiting'&&(!row.yielded||!this.confirmedEnded(row.source_id)||this.router.busy.has(row.source_binding)||this.blockers(row));}
    const job=this.store.job(id),binding=job&&this.store.binding(job.binding_id);if(!binding)return false;
    try{this.assertOrdinaryDispatch(id,binding);return false;}catch(e){if(e instanceof CollaborationHold)return true;throw e;}
  }
  private core(row:Row,finishing=false){
    const scope=()=>this.context(row),r=this.router;
    return new CollaborationHarness(this.store,{
      approved:(root,item)=>{const s=scope();return s.rootRequestId===root&&s.itemId===item?s:undefined;},
      mayWork:(_s,b)=>b.id===row.target_binding&&this.identity(b)===row.target_identity&&this.managed(b)&&!!this.store.binding(b.id)?.enabled,
      ignoreLive:(_s,j)=>j.id===row.job_id&&j.binding_id===row.target_binding||this.parkedAncestor(row.source_id,j)||this.knownEnded(j)||j.id===row.source_id&&row.yielded===1&&this.confirmedEnded(j.id)&&!r.busy.has(row.source_binding)&&j.status==='submitted'||
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
    if(!row.yielded||!this.confirmedEnded(row.source_id)||this.router.busy.has(row.source_binding)||!row.claim_token&&this.blockers(row))throw new CollaborationHold('Waiting for the previous managed turn to finish.');
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
  /** Reserve the exact attempt inside the same transaction as its dispatch. */
  reserveDispatchAttempt(id:string){
    const row=this.row(id);if(!row)throw new DispatchNotSubmittedError('The collaboration handoff changed. Nothing was sent.');
    try{this.context(row);}catch{throw new DispatchNotSubmittedError('The collaboration owner, task or session changed. Nothing was sent.');}
    const attempt=randomUUID();
    const changed=this.store.db.prepare("UPDATE managed_collaboration_handoffs SET target_attempt=? WHERE job_id=? AND state='claimed' AND submission_started=0 AND target_attempt IS NULL").run(attempt,id);
    if(!changed.changes)throw new DispatchNotSubmittedError('The collaboration attempt changed. Nothing was sent.');
    return attempt;
  }
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
  managedTurnEnded(id:string,b:Binding,attemptId:string) {
    const job=this.store.job(id);if(!job||!attemptId||job.attempt_id!==attemptId||job.binding_id!==b.id||!this.managed(b))return;
    // Neither Claude stdio nor the current SDK adapter supplies a verified
    // per-request turn identity. A result or matching session ID alone cannot
    // prove that this exact turn ended, so do not yield or release its claim.
    if(b.provider!=='codex')return;
    if(id.startsWith('report:')&&this.store.itemsInAncestry(id).some(item=>!!this.store.db.prepare('SELECT 1 FROM collaboration_workflow_reservations WHERE item_id=?').get(item))&&
      !this.validReportFence(id,b,attemptId))return;
    // This method is called only by Router after the exact managed run
    // resolves. Legacy or interrupted turns have no such evidence and stay
    // blocking even if a later progress message changes their status.
    if(this.router.coordinator?.isCoordinator(b.id)&&(job.status==='submitted'||job.status==='completed'&&id.startsWith('report:'))){
      if(!this.sourceFinished(id,b,attemptId))return;
      try{
        const contract=this.router.contracts.approved(id);
        if(contract?.dispatch_id&&contract.item_id&&contract.approved_hash&&this.store.itemOf(id)===contract.item_id){
          const generation=this.sourceOwner(contract.dispatch_id,contract.owner,contract.destination,contract.channel);
          this.router.contracts.assertDispatch(this.router,id,b,job.body,new Set(),true);
          const dispatched=this.store.db.prepare("SELECT 1 FROM request_events WHERE request_id=? AND attempt_id=? AND event='dispatched'").get(id,attemptId);
          const last=this.store.db.prepare('SELECT MAX(id) AS id FROM request_events WHERE request_id=?').get(id) as {id:number|null};
          if(dispatched&&last.id!==null)this.store.db.prepare('INSERT OR IGNORE INTO managed_collaboration_turn_ends(request_id,attempt_id,binding_id,binding_identity,body_hash,owner_generation,root_id,item_id,contract_id,revision,approved_hash,ended_event_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(id,attemptId,b.id,this.identity(b),hash(job.body),generation,contract.dispatch_id,contract.item_id,contract.id,contract.revision,contract.approved_hash,last.id);
        }
      }catch{/* Without exact completion evidence the ancestor remains blocking. */}
    }
    const targetRow=this.row(id),isClaimedTarget=targetRow?.state==='claimed'&&targetRow.target_attempt===attemptId;
    if(this.router.coordinator?.isCoordinator(b.id)&&!isClaimedTarget&&!this.confirmedEnded(id))return;
    for(const row of this.store.db.prepare("SELECT * FROM managed_collaboration_handoffs WHERE source_id=? AND state='waiting'").all(id) as Row[]){
      try{this.context(row);if(job.attempt_id===row.source_attempt&&(job.status==='submitted'||job.status==='completed'&&job.id.startsWith('report:')))this.store.db.prepare('UPDATE managed_collaboration_handoffs SET yielded=1 WHERE job_id=? AND source_attempt=?').run(row.job_id,row.source_attempt);}catch{}
    }
    const row=targetRow;if(!row||row.state!=='claimed'||!row.claim_token||job.status!=='completed'||!job.attempt_id||job.attempt_id!==row.target_attempt)return;
    // Do not infer test/proof success from a final reply: only the managed turn's
    // liveness ended. Refuse release if other linked work is still active.
    this.store.db.exec('SAVEPOINT managed_collaboration_finish');
    try{
      const scope=this.context(row);
      if(!row.exclusive_revision||!row.owner_generation||!this.finishedProvider(scope,b,id,attemptId,row.owner_generation,row.exclusive_revision))throw new Error('Provider completion is unavailable.');
      this.store.db.prepare('UPDATE managed_collaboration_handoffs SET finished=1 WHERE job_id=?').run(id);
      const finished=this.row(id)!;this.core(finished,true).releaseObserved(finished.root_id,finished.item_id,finished.claim_token!,`f5-release:${hash(id)}`);
      const last=this.store.db.prepare('SELECT MAX(id) AS id FROM request_events WHERE request_id=?').get(id) as {id:number|null};
      if(last.id===null)throw new Error('Completion event is unavailable.');
      this.store.db.prepare("UPDATE managed_collaboration_handoffs SET state='complete',finished_event_id=? WHERE job_id=?").run(last.id,id);this.store.db.exec('RELEASE managed_collaboration_finish');
    }catch{this.store.db.exec('ROLLBACK TO managed_collaboration_finish; RELEASE managed_collaboration_finish');}
  }
  /** This is recorded task context, never a verified outcome or a Meta drift check. */
  history(root:string,itemId:number) {
    const rows=this.store.db.prepare('SELECT * FROM managed_collaboration_handoffs WHERE root_id=? AND item_id=? ORDER BY rowid').all(root,itemId) as Row[];
    return rows.filter(row=>{try{this.context(row);return true;}catch{return false;}}).map(row=>{
      const text=row.state==='complete'?this.store.get(`final-reply:${row.job_id}`):undefined;
      return {sourceId:row.source_id,targetBindingId:row.target_binding,itemId:row.item_id,contractId:row.contract_id,revision:row.revision,approvedHash:row.approved_hash,role:row.handoff_role,summary:row.summary,
        result:text===undefined?null:{kind:'session_report' as const,verification:'unverified' as const,text},state:row.state,drift:'not_checked' as const};
    });
  }
}
