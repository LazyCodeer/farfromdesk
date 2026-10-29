import {proofScopeHash,type ProofCheck,type ProofDependencies,type ProofScope} from './proof-check.js';
import type {Router} from './router.js';

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
