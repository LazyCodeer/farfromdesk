import {randomUUID} from 'node:crypto';
import {hash,type Binding,type Store} from './store.js';
import type {CollaborationScope} from './collaboration-harness.js';
import type {HandoffAuthority} from './managed-collaboration.js';

export type CollaborationRoleRule={role:string;fromBindingId:string;toBindingId:string};
/** The trusted memory adapter must change revision on every edit, including
 * changes outside the app and change-away-and-back, across restarts. */
export type CollaborationMemorySnapshot={text:string;revision:string};
type BoundRule=CollaborationRoleRule&{fromIdentity:string;toIdentity:string};
export type RoleProposal={scope:CollaborationScope;ownerGeneration:string;memoryHash:string;rules:BoundRule[];nonce:string;digest:string};
type RoleRow={proposal:string;digest:string;revision:string;active:number};

/** The caller must authenticate an explicit owner approval of this exact digest.
 * A model response, memory edit or a worker's statement is not an approval. */
export type VerifyRoleApproval=(scope:CollaborationScope,digest:string,receipt:unknown)=>boolean;

/** Internal prototype only. Neither proposal nor activation is exposed to agents. */
export class CollaborationRoles implements HandoffAuthority {
  constructor(private store:Store,private readCollaboration:()=>CollaborationMemorySnapshot|undefined,private verifyApproval:VerifyRoleApproval) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS collaboration_role_policies(
      root_id TEXT PRIMARY KEY,proposal TEXT NOT NULL,digest TEXT NOT NULL,revision TEXT NOT NULL,active INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_role_approvals(digest TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS collaboration_session_revisions(binding_id TEXT PRIMARY KEY,revision TEXT NOT NULL);`);
    // Persist an epoch for every relevant session edit, including a roundtrip
    // back to identical values while the bridge is stopped.
    for(const op of ['INSERT','UPDATE','DELETE'] as const){
      const row=op==='DELETE'?'OLD':'NEW';
      store.db.exec(`CREATE TRIGGER IF NOT EXISTS collaboration_binding_${op.toLowerCase()} AFTER ${op} ON bindings
        BEGIN INSERT INTO collaboration_session_revisions VALUES(${row}.id,lower(hex(randomblob(16))))
          ON CONFLICT(binding_id) DO UPDATE SET revision=excluded.revision; END`);
      for(const side of op==='UPDATE'?['OLD','NEW']:[row]){
        const key=`${side}.key`,changed=op==='UPDATE'?' AND (OLD.key IS NOT NEW.key OR OLD.value IS NOT NEW.value)':'';
        store.db.exec(`CREATE TRIGGER IF NOT EXISTS collaboration_setting_${op.toLowerCase()}_${side.toLowerCase()} AFTER ${op} ON settings
          WHEN (${key} LIKE 'execution-mode:%' OR ${key} LIKE 'session-route:%')${changed}
          BEGIN INSERT INTO collaboration_session_revisions VALUES(CASE WHEN ${key} LIKE 'execution-mode:%' THEN substr(${key},16) ELSE substr(${key},15) END,lower(hex(randomblob(16))))
            ON CONFLICT(binding_id) DO UPDATE SET revision=excluded.revision; END`);
      }
    }
  }
  private identity(b:Binding) {
    const revision=(this.store.db.prepare('SELECT revision FROM collaboration_session_revisions WHERE binding_id=?').get(b.id) as {revision:string}|undefined)?.revision;
    if(!revision)throw new Error('The session revision is unavailable.');
    return hash(JSON.stringify([b.id,b.native_id,b.cwd,b.mode,b.provider,b.enabled,b.token_hash,
      this.store.get(`execution-mode:${b.id}`),this.store.get(`session-route:${b.id}`),revision]));
  }
  private generation(scope:CollaborationScope) {
    const origin=this.store.recordedIncomingInput(scope.rootRequestId),generation=this.store.get('incoming-owner-generation')??'';
    if(!origin||origin.owner!==scope.owner||origin.destination!==scope.destination||origin.generation!==generation||
      origin.channel!==this.store.controlChannel()||this.store.ownerFor(scope.destination)!==scope.owner||
      this.store.itemOf(scope.rootRequestId)!==scope.itemId)throw new Error('The owner or task is unavailable.');
    return generation;
  }
  private memoryHash() {
    const snapshot=this.readCollaboration();
    if(!snapshot||typeof snapshot.text!=='string'||!snapshot.text.trim()||snapshot.text.length>8000||
      typeof snapshot.revision!=='string'||!snapshot.revision||snapshot.revision.length>256)throw new Error('Collaboration memory is unavailable.');
    return hash(JSON.stringify([snapshot.text,snapshot.revision]));
  }
  private bind(rules:CollaborationRoleRule[],initialize=false):BoundRule[] {
    if(!Array.isArray(rules)||rules.length!==3||rules.some((r,i)=>r?.role!==['plan','build','review'][i]))
      throw new Error('Roles must follow plan, build, review order.');
    const seen=new Set<string>();
    return rules.map(rule=>{
      if(!rule||!/^[a-z][a-z0-9-]{0,31}$/.test(rule.role)||typeof rule.fromBindingId!=='string'||typeof rule.toBindingId!=='string'||rule.fromBindingId===rule.toBindingId)
        throw new Error('Each role needs a valid name and two different sessions.');
      const from=this.store.binding(rule.fromBindingId),to=this.store.binding(rule.toBindingId);
      if(!from?.enabled||!to?.enabled)throw new Error('A role session is unavailable.');
      const key=JSON.stringify([rule.role,from.id,to.id]);if(seen.has(key))throw new Error('Duplicate role rule.');seen.add(key);
      if(initialize){const insert=this.store.db.prepare('INSERT OR IGNORE INTO collaboration_session_revisions VALUES(?,lower(hex(randomblob(16))))');
        insert.run(from.id);insert.run(to.id);}
      return {role:rule.role,fromBindingId:from.id,toBindingId:to.id,fromIdentity:this.identity(from),toIdentity:this.identity(to)};
    });
  }
  private digest(p:Omit<RoleProposal,'digest'>) {return hash(JSON.stringify([p.scope.owner,p.scope.destination,p.scope.rootRequestId,p.scope.itemId,
    p.scope.contractId,p.scope.revision,p.scope.approvedHash,p.ownerGeneration,p.memoryHash,p.rules,p.nonce]));}
  /** A proposal is for review, not authorization. The interpreter may suggest rules,
   * but the exact digest must later be approved by the owner. */
  propose(scope:CollaborationScope,rules:CollaborationRoleRule[]):RoleProposal {
    const p={scope:{...scope},ownerGeneration:this.generation(scope),memoryHash:this.memoryHash(),rules:this.bind(rules,true),nonce:randomUUID()};
    return {...p,digest:this.digest(p)};
  }
  private currentProposal({scope,ownerGeneration,memoryHash,rules,nonce,digest}:RoleProposal) {
    return /^[a-f0-9-]{36}$/.test(nonce)&&this.digest({scope,ownerGeneration,memoryHash,rules,nonce})===digest&&
      this.generation(scope)===ownerGeneration&&this.memoryHash()===memoryHash&&JSON.stringify(this.bind(rules))===JSON.stringify(rules);
  }
  /** Only a trusted owner-approval adapter may call this. Approvals cannot be replayed. */
  activate(proposal:RoleProposal,receipt:unknown) {
    const {scope,digest}=proposal;
    const revision=randomUUID();
    this.store.db.exec('SAVEPOINT collaboration_role_activate');
    try {
      if(!this.currentProposal(proposal)||!this.verifyApproval(scope,digest,receipt)||!this.currentProposal(proposal))
        throw new Error('The role proposal or owner approval changed. Nothing was enabled.');
      this.store.db.prepare('INSERT INTO collaboration_role_approvals(digest) VALUES(?)').run(digest);
      this.store.db.prepare(`INSERT INTO collaboration_role_policies(root_id,proposal,digest,revision,active) VALUES(?,?,?,?,1)
        ON CONFLICT(root_id) DO UPDATE SET proposal=excluded.proposal,digest=excluded.digest,revision=excluded.revision,active=1`)
        .run(scope.rootRequestId,JSON.stringify(proposal),digest,revision);
      this.store.db.exec('RELEASE collaboration_role_activate');
    }catch(e){this.store.db.exec('ROLLBACK TO collaboration_role_activate; RELEASE collaboration_role_activate');throw e;}
    return revision;
  }
  revoke(rootRequestId:string){this.store.db.prepare('UPDATE collaboration_role_policies SET active=0 WHERE root_id=?').run(rootRequestId);}
  authorize(scope:CollaborationScope,from:Binding,to:Binding,_summary:string,role:string,stage:{sourceId:string;jobId:string}):string|undefined {
    try {
      const row=this.store.db.prepare('SELECT * FROM collaboration_role_policies WHERE root_id=? AND active=1').get(scope.rootRequestId) as RoleRow|undefined;
      if(!row)return;
      const p=JSON.parse(row.proposal) as RoleProposal;
      if(p.digest!==row.digest||this.digest(p)!==row.digest||this.generation(scope)!==p.ownerGeneration||this.memoryHash()!==p.memoryHash||
        !Array.isArray(p.rules)||p.rules.length!==3||p.rules.some((r,i)=>r.role!==['plan','build','review'][i])||
        JSON.stringify([scope.owner,scope.destination,scope.rootRequestId,scope.itemId,scope.contractId,scope.revision,scope.approvedHash])!==
        JSON.stringify([p.scope.owner,p.scope.destination,p.scope.rootRequestId,p.scope.itemId,p.scope.contractId,p.scope.revision,p.scope.approvedHash]))return;
      const currentFrom=this.store.binding(from.id),currentTo=this.store.binding(to.id);
      if(!currentFrom?.enabled||!currentTo?.enabled||this.identity(from)!==this.identity(currentFrom)||this.identity(to)!==this.identity(currentTo))return;
      if(p.rules.some(r=>{const a=this.store.binding(r.fromBindingId),b=this.store.binding(r.toBindingId);
        return !a?.enabled||!b?.enabled||this.identity(a)!==r.fromIdentity||this.identity(b)!==r.toIdentity;}))return;
      const index=p.rules.findIndex(r=>r.role===role&&r.fromBindingId===from.id&&r.toBindingId===to.id&&r.fromIdentity===this.identity(currentFrom)&&r.toIdentity===this.identity(currentTo));
      if(index<0||!stage?.sourceId||!stage.jobId)return;
      const all=this.store.db.prepare(`SELECT job_id,source_id,source_binding,target_binding,handoff_role,state,finished,submission_started,target_attempt,role_order_version,finished_event_id,claim_token
        FROM managed_collaboration_handoffs WHERE root_id=? AND item_id=? AND owner=? AND destination=? AND owner_generation=?
        AND contract_id=? AND revision=? AND approved_hash=? AND authority_revision=?`).all(scope.rootRequestId,scope.itemId,scope.owner,scope.destination,p.ownerGeneration,scope.contractId,scope.revision,scope.approvedHash,row.revision) as any[];
      if(all.some(s=>s.role_order_version!==1||!['plan','build','review'].includes(s.handoff_role)||!['waiting','claimed','complete','invalid'].includes(s.state)))return;
      const hasClaims=this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collaboration_claims'").get();
      for(const failed of all.filter(s=>s.state==='invalid')){
        const job=this.store.job(failed.job_id);
        if(failed.role_order_version!==1||failed.submission_started!==0||job?.status!=='failed'||
          failed.claim_token&&hasClaims&&this.store.db.prepare('SELECT 1 FROM collaboration_claims WHERE item_id=? AND token=?').get(scope.itemId,failed.claim_token))return;
      }
      const steps=all.filter(s=>s.state!=='invalid');
      let predecessor:string|undefined;
      for(let i=0;i<=index;i++){
        const matches=steps.filter(s=>s.handoff_role===p.rules[i].role);
        if(matches.length>1)return;
        const step=matches[0],expectedSource=i===0?scope.rootRequestId:`report:${predecessor}`;
        if(i===index){
          if(stage.sourceId!==expectedSource||step&&step.job_id!==stage.jobId||!step&&steps.some(s=>p.rules.findIndex(r=>r.role===s.handoff_role)>index))return;
        }else {
          if(!step||step.state!=='complete'||step.finished!==1||step.submission_started!==1||!step.target_attempt||!step.finished_event_id)return;
          const job=this.store.job(step.job_id);
          if(!job||job.status!=='completed'||job.binding_id!==step.target_binding||job.attempt_id!==step.target_attempt||job.outcome==='blocked'||job.outcome==='cancelled'||
            this.store.db.prepare("SELECT 1 FROM request_events WHERE request_id=? AND id>? AND event IN ('queued','dispatched','uncertain','failed','cancelled','completed','reviewed','auto_closed','replaced') LIMIT 1").get(step.job_id,step.finished_event_id))return;
        }
        if(step&&(step.role_order_version!==1||step.source_id!==expectedSource||step.source_binding!==p.rules[i].fromBindingId||step.target_binding!==p.rules[i].toBindingId))return;
        if(i>0){const report=this.store.db.prepare('SELECT source_id FROM task_contract_report_sources WHERE job_id=?').get(expectedSource) as {source_id:string}|undefined;if(report?.source_id!==predecessor)return;}
        predecessor=step?.job_id;
      }
      return row.revision;
    }catch{return;}
  }
}
