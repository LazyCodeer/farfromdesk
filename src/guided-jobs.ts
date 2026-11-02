import {authenticatedOwner} from './owner-commands.js';
import {hash} from './store.js';
import {errandBindingIdentity} from './errand-missions.js';
import {parseGreenhouseRequest} from './errand-workflow.js';
import type {Incoming,Router} from './router.js';

type Result={kind:'reply';text:string}|{kind:'done';text:string}|{kind:'handled'}|{kind:'pass'};
type Draft={owner:string;destination:string;generation:string;authority:string;route:string;expires:number;role?:string;location?:string;turns:{id:string;text:string}[]};
type Marker={origin_id:string;owner:string;destination:string;generation:string;authority:string;route:string;canonical:string;original_hash:string;turns:string;state:string};
const drafts=new WeakMap<Router,Draft>();
const duration=10*60_000;
const field=(text:string)=>text.length>0&&text.length<=120&&!/[;\r\n\x00-\x1f\x7f]/.test(text);
const unsupported=/\b(?:salary|paying|paid|wages?|visa|sponsor(?:ship)?|exclude|except|without|avoid|only|apply|submit|application|skills?|experience|qualification|benefits)\b/i;

function route(r:Router,destination:string) {
  const s=r.store,raw=s.get(`owner-target:${destination}`);let target:any;
  try{target=raw?JSON.parse(raw):undefined;}catch{return '';}
  const id=target?.kind==='session'?target.id:s.get('active')??s.get('master');
  const b=typeof id==='string'?s.binding(id):undefined;
  if(!b?.enabled)return '';
  return hash(JSON.stringify([raw??'',s.get('active')??'',s.get('master')??'',s.get('guided-jobs-route-generation')??'',errandBindingIdentity(s,b),r.coordinator?.registry.entry(b.id)??null]));
}
function context(r:Router,m:Incoming){
  const s=r.store,d=s.destination(),owner=s.ownerFor(d),c=s.incomingOwnerContext.getStore();
  if(r.stopped||s.controlChannel()!=='whatsapp'||!d||d!==owner||!authenticatedOwner(r,m)||m.ownerCommand!==true||m.quotedId||m.source==='voice'||!c||c.channel!=='whatsapp'||c.owner!==owner||c.destination!==d||!c.generation||!s.incomingOwnerCurrent())return;
  const authority=s.get('errand-authority-generation')??'',routing=route(r,d);
  if(!authority||!routing)return;
  return {owner,destination:d,generation:c.generation,authority,route:routing};
}
function same(a:Draft|Marker,b:ReturnType<typeof context>){return !!b&&a.owner===b.owner&&a.destination===b.destination&&a.generation===b.generation&&a.authority===b.authority&&a.route===b.route;}
function ensure(r:Router){
  const s=r.store;
  s.db.exec(`CREATE TABLE IF NOT EXISTS guided_job_reviews(origin_id TEXT PRIMARY KEY,owner TEXT NOT NULL,destination TEXT NOT NULL,generation TEXT NOT NULL,authority TEXT NOT NULL,route TEXT NOT NULL,canonical TEXT NOT NULL,original_hash TEXT NOT NULL,turns TEXT NOT NULL,state TEXT NOT NULL)`);
  for(const operation of ['INSERT','UPDATE','DELETE'] as const){
    const row=operation==='DELETE'?'OLD':'NEW',changed=operation==='UPDATE'?' AND OLD.value IS NOT NEW.value':'';
    s.db.exec(`CREATE TRIGGER IF NOT EXISTS guided_jobs_route_${operation.toLowerCase()} AFTER ${operation} ON settings
      WHEN (${row}.key IN ('active','master','selected','enabled-apps','coordinator-registry') OR ${row}.key LIKE 'owner-target:%' OR ${row}.key LIKE 'direct:%' OR ${row}.key LIKE 'coordinator-retired:%' OR ${row}.key LIKE 'role-kind:%')${changed}
      BEGIN INSERT INTO settings(key,value) VALUES('guided-jobs-route-generation',lower(hex(randomblob(16)))) ON CONFLICT(key) DO UPDATE SET value=excluded.value; END`);
  }
  s.db.exec("INSERT OR IGNORE INTO settings(key,value) VALUES('guided-jobs-route-generation',lower(hex(randomblob(16))))");
}
function splitRoleLocation(value:string){
  const trimmed=value.replace(/^(?:(?:please|can you|could you)\s+)?(?:find|search for|look for)\s+(?:me\s+)?(?:a\s+|some\s+)?/i,'').replace(/^i\s+(?:want|need|am looking for|would like)\s+(?:a\s+)?/i,'').replace(/^(?:i'm\s+looking for\s+)(?:a\s+)?/i,'');
  const match=/^(.+?)\s+in\s+(.+)$/i.exec(trimmed);if(!match)return;
  const role=match[1].replace(/\s+(?:jobs?|roles?|positions?)$/i,'').trim(),location=match[2].trim().replace(/[.!]$/,'');
  if(!field(role)||!field(location)||unsupported.test(role)||unsupported.test(location))return;
  return {role,location};
}
function boardIds(value:string){
  const raw=value.trim().replace(/^(?:the\s+)?(?:greenhouse\s+)?boards?\s*(?:(?:is|are)\s+|[:=]\s*)?/i,'').replace(/[.!]$/,'');
  if(!/^[a-z0-9_-]+(?:\s*,\s*[a-z0-9_-]+){0,2}$/.test(raw))return;
  const boards=raw.split(',').map(x=>x.trim());
  if(boards.some(x=>!/^[a-z0-9][a-z0-9_-]{0,49}$/.test(x))||new Set(boards).size!==boards.length)return;
  return boards.join(',');
}
const askRole='What role and location should I search? For example: Flutter engineer in Bangalore.';
const askBoard='Which Greenhouse board IDs should I search? Send up to three, separated by commas. I can only search boards you name.';

/** Start or continue a typed, direct-owner job search. */
export async function guidedJobs(r:Router,m:Incoming,text:string):Promise<Result>{
  // Install the durable route epoch before the first field is accepted.
  ensure(r);
  const c=context(r,m);if(!c){
    const s=r.store,d=s.destination();
    if(!r.stopped&&m.ownerCommand===true&&!m.quotedId&&m.source!=='voice'&&authenticatedOwner(r,m)&&s.incomingOwnerContext.getStore()&&s.incomingOwnerCurrent()){
      if(s.controlChannel()!=='whatsapp')return {kind:'reply',text:'Job search is available in your direct WhatsApp chat.'};
      if(d!==s.ownerFor(d))return {kind:'reply',text:'Send /jobs in your direct WhatsApp owner chat.'};
      return {kind:'reply',text:'Connect a session in Coding platforms before starting a job search.'};
    }
    return {kind:'pass'};
  }
  if(text!==m.text)return {kind:'pass'};
  const value=text.trim();if(value.startsWith('/')&&!/^\/jobs(?:\s|$)/i.test(value))return {kind:'pass'};
  let draft=drafts.get(r);
  if(/^\/jobs(?:\s|$)/i.test(value)){
    draft={...c,expires:Date.now()+duration,turns:[]};drafts.set(r,draft);
    text=value.replace(/^\/jobs\s*/i,'').trim();
    if(!text){draft.turns.push({id:m.id,text:m.text});return {kind:'reply',text:askRole};}
  }else if(!draft||!same(draft,c)||draft.expires<=Date.now()){
    drafts.delete(r);return {kind:'reply',text:'That job-search conversation expired or changed. Send /jobs to start again.'};
  }
  if(!draft.turns.some(turn=>turn.id===m.id))draft.turns.push({id:m.id,text:m.text});
  if(draft.turns.length>8){drafts.delete(r);return {kind:'reply',text:'This job-search conversation is too long. Send /jobs to start again.'};}
  if(/^(?:cancel|cancel job search)[.!]?$/i.test(text.trim())){drafts.delete(r);return {kind:'done',text:'Job search cancelled.'};}
  let inlineBoards:string|undefined;
  if(!draft.role||!draft.location){
    const withBoard=/^(.+?)\s+(?:on|using)\s+(?:the\s+)?greenhouse\s+boards?\s+(.+)$/i.exec(text.trim());
    if(withBoard){inlineBoards=boardIds(withBoard[2]);if(!inlineBoards)return {kind:'reply',text:askBoard};text=withBoard[1];}
  }
  if(!draft.role||!draft.location){
    const value=text.trim(),both=splitRoleLocation(value);
    if(both){draft.role=both.role;draft.location=both.location;if(!inlineBoards)return {kind:'reply',text:askBoard};}
    else {
    if(!field(value)||unsupported.test(value))return {kind:'reply',text:askRole};
    if(!draft.role){draft.role=value.replace(/\s+(?:jobs?|roles?|positions?)$/i,'').trim();if(!field(draft.role))return {kind:'reply',text:askRole};return {kind:'reply',text:'What location should I search?'};}
    draft.location=value.replace(/^(?:in|near)\s+/i,'').replace(/[.!]$/,'').trim();if(!field(draft.location)){draft.location=undefined;return {kind:'reply',text:'What location should I search?'};}
    return {kind:'reply',text:askBoard};
    }
  }
  const boards=inlineBoards??boardIds(text);if(!boards)return {kind:'reply',text:askBoard};
  const canonical=`greenhouse jobs; board=${boards}; role=${draft.role}; location=${draft.location}`;
  try{if(!parseGreenhouseRequest(canonical))throw new Error('Invalid criteria');}
  catch{drafts.delete(r);return {kind:'reply',text:'Those job-search details cannot be used. Send /jobs to start again without passwords or private keys.'};}
  const s=r.store;if(r.contracts.hasPendingOwner(c.owner,c.destination))return {kind:'reply',text:'Finish or cancel the pending task contract first.'};
  ensure(r);
  try{
    s.db.prepare('INSERT INTO guided_job_reviews VALUES(?,?,?,?,?,?,?,?,?,?)').run(m.id,c.owner,c.destination,c.generation,c.authority,c.route,canonical,hash(m.text),JSON.stringify(draft.turns),'pending');
  }catch{return {kind:'reply',text:'This job-search request was already used. Send /jobs to start again.'};}
  drafts.delete(r);
  try{
    if(r.contracts.enabled()){
      const result=await r.contracts.preflight(r,m,canonical);
      if(result.kind==='handled')return {kind:'handled'};
      if(result.kind!=='pass')throw new Error('The review changed.');
    }
    if(!same(draft,context(r,m)))throw new Error('Owner or session changed.');
    s.db.prepare("UPDATE guided_job_reviews SET state='consumed' WHERE origin_id=? AND state='pending'").run(m.id);
    await r.errands.start({...m,text:canonical});return {kind:'handled'};
  }catch{
    s.db.prepare("UPDATE guided_job_reviews SET state='invalid' WHERE origin_id=? AND state='pending'").run(m.id);
    return {kind:'reply',text:'Could not start the job search. Send /jobs to try again.'};
  }
}

/** An F3 approval replays the original input; only the stored reviewed criteria may be used. */
export async function resumeGuidedJobs(r:Router,m:Incoming):Promise<boolean>{
  ensure(r);const approved=r.contracts.approved(m.id);if(!approved)return false;
  const s=r.store,marker=s.db.prepare('SELECT * FROM guided_job_reviews WHERE origin_id=?').get(approved.origin_id) as Marker|undefined;
  if(!marker)return false;
  const c=context(r,m);
  if(marker.state!=='pending'||!same(marker,c)||marker.canonical!==approved.review_text||marker.original_hash!==hash(m.text)||approved.original!==m.text||approved.owner!==marker.owner||approved.destination!==marker.destination||approved.edits!=='[]'){
    s.db.prepare("UPDATE guided_job_reviews SET state='invalid' WHERE origin_id=? AND state='pending'").run(marker.origin_id);
    if(c){s.output(undefined,'The job search or review changed. Send /jobs to start again.',`guided-jobs-error:${m.id}`,c.destination,{plain:true});s.remember(m.id);}return true;
  }
  const claim=s.db.prepare("UPDATE guided_job_reviews SET state='consumed' WHERE origin_id=? AND state='pending'").run(marker.origin_id);
  if(!claim.changes)return true;
  await r.errands.start({...m,text:marker.canonical});return true;
}
export function cancelGuidedJobs(r:Router,m:Incoming){const c=context(r,m),draft=drafts.get(r);if(c&&draft&&same(draft,c))drafts.delete(r);}
