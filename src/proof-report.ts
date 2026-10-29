import type {Router} from './router.js';
import type {Binding} from './store.js';

/** Queue an honest owner-facing summary of an approved task's final report.
 * The session's words and links are claims, not independently verified proof.
 * This sends no screenshot, makes no network request, and never dispatches a correction.
 */
export function queueReportedProof(router:Router,binding:Binding,requestId:string,reply:string):boolean {
  const {store,contracts}=router,job=store.job(requestId),contract=contracts.approved(requestId);
  // Delegated/report turns need separate parent and owner provenance; do not
  // infer a completed owner request from a worker's own message.
  if(!job||!contract||contract.dispatch_id!==requestId||job.binding_id!==binding.id||
     job.status!=='completed'||job.outcome!=='done'||!job.attempt_id||job.destination!==contract.destination||!contract.approved_hash||
     !store.db.prepare("SELECT 1 FROM request_events WHERE request_id=? AND attempt_id=? AND event='dispatched'").get(requestId,job.attempt_id))return false;
  try{contracts.assertDispatch(router,requestId,binding,job.body);}catch{return false;}
  let checks:{id:string;text:string}[];
  try{
    const draft=JSON.parse(contract.draft) as {checks:unknown};
    if(!Array.isArray(draft.checks)||draft.checks.length<1||draft.checks.length>3)return false;
    checks=draft.checks as {id:string;text:string}[];
    if(checks.some((c,i)=>!c||c.id!==`${contract.id}:${contract.revision}:${i+1}`||typeof c.text!=='string'||!c.text.trim()||c.text.length>1000||/[\x00-\x1f\x7f]/.test(c.text)))return false;
  }catch{return false;}
  const excerpt=reply.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim().slice(0,300);
  const links=[...new Set(reply.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*/g)??[])];
  const lines=['Task check',`Session reported (unverified): ${excerpt}${reply.trim().length>300?'…':''}`,
    ...(links.length===1?[`PR mentioned (unverified): ${links[0]}`]:[]),
    'Checks needing confirmation:',...checks.map((check,i)=>`${i+1}. ${check.text}`),
    'No test, PR or screenshot has been independently verified.'];
  const source=`proof-report:${requestId}:${contract.id}:${contract.revision}`;
  return store.output(binding,lines.join('\n'),source,job.destination,{requestId,kind:'system',origin:'system',plain:true})===true;
}
