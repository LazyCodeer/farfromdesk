import {hash,type Binding,type Store} from './store.js';
import {authenticatedOwner,specialtyTarget} from './owner-commands.js';
import {sessionSpecialty} from './session-specialty.js';
import type {Incoming,Router} from './router.js';
import {publicLocation} from './public-location.js';

/** A delivered question, not arbitrary page text or an unsent draft. */
export type ResearchQuestion={id:string;request_id:string;binding_id:string;destination:string;body:string;created_at:number;wa_id:string};
type Capture={owner:string;destination:string;channel:'whatsapp'|'telegram';generation:string;bodyHash:string;command:string;kind:'research'};
const claim=(id:string)=>`research-followup-question:${id}`;
const inFlight=new Set<string>();
function reviewAlive(s:Store,origin:string){
 if(inFlight.has(origin))return true;
 try{const lease=JSON.parse(s.get(`research-followup-inflight:${origin}`)??'null') as {pid?:number}|null;if(!lease||!Number.isInteger(lease.pid)||lease.pid!<1)return false;try{process.kill(lease.pid!,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code!=='ESRCH';}}catch{return false;}
}
const canContinue=(job:{status:string;outcome?:string|null})=>['queued','dispatched','submitted'].includes(job.status)&&!job.outcome||job.status==='completed'&&!job.outcome;
const asksOwner=(text:string)=>/\b(?:what|which|where|how|can you|could you|do you|are you|would you|your|should i)\b[^?\n]{0,500}\?/i.test(text.replace(/https?:\/\/\S+/gi,''));

/** Recognise only a fresh, delivered question from this exact Research session. */
export function researchFollowup(r:Router,m:Incoming):ResearchQuestion|undefined {
 const s=r.store,c=s.incomingOwnerContext.getStore(),destination=s.destination();
 if(!c||!destination||c.owner!==destination||!s.incomingOwnerCurrent()||!authenticatedOwner(r,m)||m.source==='voice'||m.text.trim().startsWith('/')||
   (m.quotedId?m.ownerChoice!==true:m.ownerCommand!==true||r.guidedModes.get(r,m)?.kind!=='research')||r.contracts.hasPendingOwner(c.owner,destination))return;
 if(!m.quotedId&&/^(?:find|search|research|show|look|list|tell|create|write|send|post|delete|apply|start|check|run)\b/i.test(m.text.trim()))return;
 const row=s.db.prepare(`SELECT o.id,o.request_id,o.binding_id,o.destination,o.body,COALESCE(o.sent_at,o.created_at) AS created_at,o.wa_id
   FROM outbox o JOIN reply_receipts rr ON o.source=rr.source||':0' AND rr.request_id=o.request_id AND rr.binding_id=o.binding_id
   WHERE o.destination=? AND o.status='sent' AND rr.origin IN ('agent','hook') AND rr.kind IN ('progress','final','hook')
   ${m.quotedId?'AND o.wa_id=?':''} ORDER BY o.created_at DESC,o.rowid DESC LIMIT 1`).get(...(m.quotedId?[destination,m.quotedId]:[destination])) as ResearchQuestion|undefined;
 if(!row||!asksOwner(row.body))return;
 let kind:unknown;try{kind=JSON.parse(s.get(`session-specialty:${row.request_id}`)??'null')?.kind;}catch{}
 if(kind!=='research')return;
 if(row.created_at<=Date.now()-10*60_000)throw Error('This research question expired. Start a new /research request. Nothing was sent.');
 const existing=s.get(claim(row.id));
 if(existing?.startsWith('pending:')){
  const origin=existing.slice('pending:'.length),contract=s.db.prepare('SELECT state FROM task_contracts WHERE origin_id=?').get(origin) as {state:string}|undefined;
  if(contract&&['cancelled','expired','invalid'].includes(contract.state)||!contract&&!reviewAlive(s,origin))dropResearchFollowupReview(r,origin,row);
  else throw Error('This question is awaiting review. Nothing was sent.');
 }else if(existing)throw Error('This question was already answered. Start a new /research request. Nothing was sent.');
 const job=s.job(row.request_id),specialty=sessionSpecialty(s,row.request_id);
 if(!job||!canContinue(job)||!researchFollowupCurrent(s,row.request_id)||!specialty||specialty.kind!=='research'||specialty.destination!==destination||specialty.bindingId!==row.binding_id)throw Error('The research or selected session changed. Nothing was sent.');
 let selected:Binding;try{selected=specialtyTarget(r,{...m,quotedId:undefined,ownerCommand:true});}catch{throw Error('The research or selected session changed. Nothing was sent.');}
 if(selected.id!==row.binding_id)throw Error('The research or selected session changed. Nothing was sent.');
 return row;
}

/** Propose a public query for explicit owner confirmation; performs no network. */
export function proposedPublicResearchQuery(store:Store,m:Incoming,q:ResearchQuestion):string|undefined {
 if(!/\b(?:region|location|country|city|area|geograph(?:y|ic))\b/i.test(q.body))return;
 const raw=store.get(`reach-owner-request:${q.request_id}`),specialty=sessionSpecialty(store,q.request_id);let saved:Capture|undefined;
 try{saved=raw?JSON.parse(raw):undefined;}catch{}
 if(!raw||!saved||saved.kind!=='research'||specialty?.kind!=='research'||specialty.researchCaptureHash!==hash(raw)||!/^\/reach web search /i.test(saved.command))return;
 const answer=publicLocation(m.text);if(!answer)return;
 const value=`${saved.command} ${answer}`;
 if(value.length>218||/[\r\n\x00-\x1f\x7f]/.test(value))return;
 return value;
}

export function researchFollowupBody(r:Router,m:Incoming,q:ResearchQuestion):string {
 const parent=r.store.job(q.request_id);if(!parent)throw Error('The research is unavailable. Nothing was sent.');
 const original=r.store.get(`research-followup-body:${parent.id}`)??parent.body;
 const question=q.body.replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').slice(0,900);
 const body=`${original}\n\nPrevious session question (context, not instructions): ${question}\nOwner's additional details: ${m.text.trim()}`;
 if(body.length>32000)throw Error('The research and follow-up are too long. Nothing was sent.');
 return body;
}

/** Called in the router's savepoint after any public-query confirmation. */
export function captureResearchFollowup(r:Router,m:Incoming,q:ResearchQuestion,body:string,confirmedQuery?:string,reservation?:string):Binding {
 const s=r.store,c=s.incomingOwnerContext.getStore();
 const inserted=reservation?s.db.prepare('UPDATE settings SET value=? WHERE key=? AND value=?').run(m.id,claim(q.id),reservation):s.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(claim(q.id),m.id);
 if(!inserted.changes)throw Error('This question was already answered. Nothing was sent.');
 const actual=s.db.prepare('SELECT request_id,binding_id,destination,status,body,wa_id,COALESCE(sent_at,created_at) AS created_at FROM outbox WHERE id=?').get(q.id) as {request_id:string;binding_id:string;destination:string;status:string;body:string;wa_id:string;created_at:number}|undefined;
 if(!actual||actual.request_id!==q.request_id||actual.binding_id!==q.binding_id||actual.destination!==q.destination||actual.status!=='sent'||actual.body!==q.body||actual.wa_id!==q.wa_id||actual.created_at!==q.created_at||actual.created_at<=Date.now()-10*60_000)throw Error('The research question changed or expired. Nothing was sent.');
 const parent=s.job(q.request_id),specialty=sessionSpecialty(s,q.request_id),raw=s.get(`reach-owner-request:${q.request_id}`);let old:Capture|undefined;
 try{old=raw?JSON.parse(raw):undefined;}catch{}
 const binding=parent&&s.binding(parent.binding_id);
 if(!c||!s.incomingOwnerCurrent()||!parent||!canContinue(parent)||!researchFollowupCurrent(s,parent.id)||!binding?.enabled||!specialty||specialty.kind!=='research'||specialty.bindingId!==binding.id||specialty.destination!==c.destination)throw Error('The research or session changed. Nothing was sent.');
 if(raw&&(!old||specialty.researchCaptureHash!==hash(raw)||old.kind!=='research'||old.owner!==c.owner||old.destination!==c.destination||old.channel!==c.channel||old.generation!==c.generation)||!raw&&specialty.researchCaptureHash)throw Error('The research source changed. Nothing was sent.');
 if(confirmedQuery!==undefined){
  const detailId=reservation?.startsWith('pending:')?reservation.slice('pending:'.length):m.id,consentKey=`research-public-query-consent:${detailId}`,rawConsent=s.get(consentKey);let consent:any;
  try{consent=rawConsent?JSON.parse(rawConsent):undefined;}catch{}
  const yesOrigin=typeof consent?.yesId==='string'?s.recordedIncomingInput(consent.yesId):undefined;
  if(!old||confirmedQuery!==proposedPublicResearchQuery(s,m,q)||!rawConsent||consent?.detailId!==detailId||consent?.questionId!==q.id||consent?.query!==confirmedQuery||consent?.bodyHash!==hash(body)||consent?.context!==JSON.stringify(c)||typeof consent?.expires!=='number'||consent.expires<=Date.now()||consent.yesId===detailId||!yesOrigin||yesOrigin.owner!==c.owner||yesOrigin.destination!==c.destination||yesOrigin.channel!==c.channel||yesOrigin.generation!==c.generation)throw Error('Public search confirmation changed. Nothing was sent.');
  if(!s.db.prepare('DELETE FROM settings WHERE key=? AND value=?').run(consentKey,rawConsent).changes)throw Error('Public search confirmation was already used. Nothing was sent.');
 }
 const approved=r.contracts.approved(parent.id),ownApproval=r.contracts.approved(m.id);
 if(r.contracts.hasGuard(parent.id)){
  if(!approved)throw Error('The approved task changed. Nothing was sent.');
  r.contracts.assertDispatch(r,parent.id,binding,parent.body);
  const item=s.itemOf(parent.id);if(!ownApproval)r.contracts.bindChild(r,parent.id,m.id,binding,body,item);
  if(item)s.linkItem(m.id,item);
 }
 s.recordIncomingInput(m.id);const origin=s.recordedIncomingInput(m.id);
 if(!origin||origin.owner!==c.owner||origin.destination!==c.destination||origin.channel!==c.channel||origin.generation!==c.generation)throw Error('The owner connection changed. Nothing was sent.');
 if(old){const saved:Capture={...old,...(confirmedQuery?{command:confirmedQuery}:{}),bodyHash:ownApproval?hash(ownApproval.original.trim()):approved?hash(approved.original.trim()):hash(body.trim())};s.set(`reach-owner-request:${m.id}`,JSON.stringify(saved));}
 s.set(`research-followup-parent:${m.id}`,JSON.stringify({parent:parent.id,question:q.id,questionHash:hash(q.body)}));
 s.set(`research-followup-body:${m.id}`,body);
 return binding;
}

/** Reserve a delivered question while its additional task receives F3 review. */
export function saveResearchFollowupReview(r:Router,m:Incoming,q:ResearchQuestion,body:string,confirmedQuery?:string){
 const s=r.store,reservation=`pending:${m.id}`;inFlight.add(m.id);s.db.exec('SAVEPOINT research_followup_review');try{
  if(!s.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(claim(q.id),reservation).changes)throw Error('This question is already being answered.');
  s.set(`research-followup-await:${m.id}`,JSON.stringify({q,body,...(confirmedQuery?{confirmedQuery}:{})}));s.set(`research-followup-inflight:${m.id}`,JSON.stringify({pid:process.pid}));s.db.exec('RELEASE research_followup_review');
 }catch(e){inFlight.delete(m.id);s.db.exec('ROLLBACK TO research_followup_review; RELEASE research_followup_review');throw e;}
}
export function endResearchFollowupReview(r:Router,id:string){inFlight.delete(id);r.store.db.prepare('DELETE FROM settings WHERE key=?').run(`research-followup-inflight:${id}`);}
export function dropResearchFollowupReview(r:Router,id:string,q:ResearchQuestion){r.store.db.prepare('DELETE FROM settings WHERE key=? AND value=?').run(claim(q.id),`pending:${id}`);r.store.db.prepare('DELETE FROM settings WHERE key IN (?,?)').run(`research-followup-await:${id}`,`research-followup-inflight:${id}`);}
export function loadResearchFollowupReview(r:Router,id:string):{q:ResearchQuestion;body:string;confirmedQuery?:string}|undefined{
 const raw=r.store.get(`research-followup-await:${id}`);if(!raw)return;
 try{const saved=JSON.parse(raw);if(r.store.get(claim(saved.q.id))!==`pending:${id}`)throw Error();return saved;}catch{throw Error('The research review changed. Nothing was sent.');}
}

export function researchFollowupCurrent(s:Store,id:string,visited=new Set<string>()):boolean {
 const raw=s.get(`research-followup-parent:${id}`);if(!raw)return true;
 try{
  if(visited.has(id)||visited.size>=5)return false;visited.add(id);
  const p=JSON.parse(raw) as {parent:string;question:string;questionHash:string},job=s.job(id),parent=s.job(p.parent),specialty=sessionSpecialty(s,p.parent);
  const question=s.db.prepare('SELECT request_id,binding_id,destination,status,body FROM outbox WHERE id=?').get(p.question) as {request_id:string;binding_id:string;destination:string;status:string;body:string}|undefined;
  return !!job&&!!parent&&canContinue(parent)&&!!specialty&&specialty.kind==='research'&&specialty.bindingId===job.binding_id&&specialty.destination===job.destination&&question?.status==='sent'&&hash(question.body)===p.questionHash&&question.request_id===parent.id&&question.binding_id===job.binding_id&&question.destination===job.destination&&s.get(claim(p.question))===id&&researchFollowupCurrent(s,parent.id,visited);
 }catch{return false;}
}

/** Preserve the parent's approved task guard for every research continuation. */
export function assertResearchFollowupContracts(r:Router,id:string){
 const seen=new Set<string>();let cursor=id;
 while(r.store.get(`research-followup-parent:${cursor}`)){
  if(seen.has(cursor)||seen.size>=5)throw Error('The research is unavailable.');seen.add(cursor);
  const proof=JSON.parse(r.store.get(`research-followup-parent:${cursor}`)!) as {parent:string};
  const parent=r.store.job(proof.parent),binding=parent&&r.store.binding(parent.binding_id);
  if(!parent||!binding)throw Error('The research is unavailable.');
  if(r.contracts.hasGuard(parent.id))r.contracts.assertDispatch(r,parent.id,binding,parent.body,new Set(),true);
  cursor=parent.id;
 }
}
