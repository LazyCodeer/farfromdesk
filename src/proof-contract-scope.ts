import {proofScopeHash,type ProofCheck,type ProofDependencies,type ProofScope} from './proof-check.js';
import type {Router} from './router.js';
import type {Store} from './store.js';

/** Install before an approval is created. Never backfill earlier approvals. */
export class ProofScopeFence {
  constructor(store:Store) {
    store.db.exec('SAVEPOINT proof_scope_install');
    try {
    store.db.exec(`CREATE TABLE IF NOT EXISTS proof_scope_epoch(id INTEGER PRIMARY KEY CHECK(id=1),generation TEXT NOT NULL);
      INSERT OR IGNORE INTO proof_scope_epoch VALUES(1,lower(hex(randomblob(16))));
      CREATE TABLE IF NOT EXISTS proof_scope_approvals(contract_id TEXT PRIMARY KEY,root_request TEXT NOT NULL,generation TEXT NOT NULL,owner_generation TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS proof_scope_approval AFTER UPDATE OF state ON task_contracts
      WHEN OLD.state='pending' AND NEW.state='approved' AND NEW.dispatch_id IS NOT NULL
      BEGIN INSERT OR IGNORE INTO proof_scope_approvals VALUES(NEW.id,NEW.dispatch_id,
        (SELECT generation FROM proof_scope_epoch WHERE id=1),COALESCE((SELECT value FROM settings WHERE key='incoming-owner-generation'),'')); END;`);
    const relevant="('meta-brain-policy','coordinator-registry','master','active','selected','enabled-apps','background-enabled')";
    for(const op of ['INSERT','UPDATE','DELETE'] as const){
      const row=op==='DELETE'?'OLD':'NEW',changed=op==='UPDATE'?' AND OLD.value IS NOT NEW.value':'';
      store.db.exec(`CREATE TRIGGER IF NOT EXISTS proof_scope_settings_${op.toLowerCase()} AFTER ${op} ON settings
        WHEN (${row}.key IN ${relevant} OR ${row}.key LIKE 'execution-mode:%' OR ${row}.key LIKE 'session-route:%' OR ${row}.key LIKE 'direct:%' OR ${row}.key LIKE 'owner-target:%')${changed}
        BEGIN UPDATE proof_scope_epoch SET generation=lower(hex(randomblob(16))) WHERE id=1; END`);
      const bindingChanged=op==='UPDATE'?'WHEN OLD.id IS NOT NEW.id OR OLD.provider IS NOT NEW.provider OR OLD.native_id IS NOT NEW.native_id OR OLD.cwd IS NOT NEW.cwd OR OLD.mode IS NOT NEW.mode OR OLD.token_hash IS NOT NEW.token_hash OR OLD.enabled IS NOT NEW.enabled':'';
      store.db.exec(`CREATE TRIGGER IF NOT EXISTS proof_scope_binding_${op.toLowerCase()} AFTER ${op} ON bindings ${bindingChanged}
        BEGIN UPDATE proof_scope_epoch SET generation=lower(hex(randomblob(16))) WHERE id=1; END`);
    }
    store.db.exec('RELEASE proof_scope_install');
    } catch(e) {store.db.exec('ROLLBACK TO proof_scope_install; RELEASE proof_scope_install');throw e;}
  }
}

/**
 * Experimental F3-to-F4 provenance adapter. This establishes only the exact
 * recorded owner approval, contract, item, binding and bridge dispatch attempt.
 * It does not establish that the provider performed work or independently
 * verify a workspace, revision, test, screenshot, PR or result. Accordingly
 * it supplies no evidence binding and no target repository/revision. It is not
 * installed in any production route.
 *
 * Approval inputs without an original authenticated owner generation fail
 * closed, including legacy and unsupported background/scheduled roots. The
 * normal text approval path does not yet guarantee such a record on main.
 */
export function contractProofScope(router:Router,rootRequestId:string):ReturnType<ProofDependencies['current']> {
  const {store,contracts}=router;
  try {
    if(!rootRequestId||store.get(`parent:${rootRequestId}`)||store.get(`report-parent:${rootRequestId}`))return;
    const job=store.job(rootRequestId),contract=contracts.approved(rootRequestId);
    if(!job||!contract||contract.dispatch_id!==rootRequestId||job.status!=='completed'||
       job.outcome&&job.outcome!=='done'||!job.attempt_id||!contract.approved_hash||!contract.binding_hash||
       !contract.approved_at||!contract.item_id||job.destination!==contract.destination||job.binding_id!==contract.binding_id)return;
    const binding=store.binding(job.binding_id),origin=store.recordedIncomingInput(rootRequestId);
    if(!binding?.enabled||!origin||origin.owner!==contract.owner||origin.destination!==contract.destination||origin.channel!==contract.channel||
       origin.generation!==(store.get('incoming-owner-generation')??'')||store.controlChannel()!==origin.channel||
       store.ownerFor(origin.destination)!==origin.owner||!store.incomingOwnerCurrent())return;
    const fence=store.db.prepare(`SELECT a.owner_generation,a.generation,e.generation AS current_generation
      FROM proof_scope_approvals a JOIN proof_scope_epoch e ON e.id=1 WHERE a.contract_id=? AND a.root_request=?`).get(contract.id,rootRequestId) as {owner_generation:string;generation:string;current_generation:string}|undefined;
    if(!fence||fence.owner_generation!==origin.generation||fence.generation!==fence.current_generation)return;
    if(origin.channel==='whatsapp'){
      const owned=store.requestOwnerOrigin(rootRequestId);
      if(!owned||owned.owner!==origin.owner||owned.destination!==origin.destination)return;
    }else if(origin.owner!==origin.destination||origin.destination!==store.get('telegram-owner'))return;
    if(!store.db.prepare('SELECT 1 FROM item_owner_origins WHERE item_id=? AND owner=? AND destination=?').get(contract.item_id,contract.owner,contract.destination))return;
    contracts.assertDispatch(router,rootRequestId,binding,job.body);
    const events=store.db.prepare("SELECT at FROM request_events WHERE request_id=? AND binding_id=? AND attempt_id=? AND event='dispatched'").all(rootRequestId,binding.id,job.attempt_id) as {at:number}[];
    if(events.length!==1||!Number.isSafeInteger(events[0].at)||events[0].at<contract.approved_at)return;
    const draft=JSON.parse(contract.draft) as {checks:unknown};
    if(!Array.isArray(draft.checks))return;
    const checks:ProofCheck[]=draft.checks.map((check:any)=>({id:check?.id,text:check?.text}));
    const scope:ProofScope={contractId:contract.id,revision:contract.revision,approvedHash:contract.approved_hash,
      approvedAt:contract.approved_at,owner:contract.owner,destination:contract.destination,rootRequestId,itemId:contract.item_id,
      bindingId:binding.id,bindingHash:contract.binding_hash,attemptId:job.attempt_id,startedAt:events[0].at,
      targetRepository:null,targetRevision:null};
    // The shared validator checks check IDs and hashes before returning any scope.
    proofScopeHash(scope,checks);
    return {scope,checks};
  } catch {return;}
}
