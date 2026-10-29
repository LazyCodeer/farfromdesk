import {createHash,randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {hash,type Binding,type Store} from './store.js';
import {toWhatsApp} from './whatsapp-format.js';

/**
 * Internal F6 foundation. This module is not connected to a route, browser,
 * session or delivery API. Only bridge-owned, independently reviewed adapters
 * may authorize a contract or supply listing evidence; session or model text
 * must never be used as an evidence adapter.
 */
export type ErrandContract={role:string;location:string;salary?:string;avoid?:string};
export type ErrandScope={requestId:string;owner:string;destination:string;bindingId:string;bindingIdentity:string};
/** The marker and workplace attestation are meaningful only from a trusted bridge-owned verifier. */
export type Workplace='remote-only'|'onsite'|'hybrid'|'unknown';
export type Listing={sourceUrl:string;url:string;title:string;excerpt:string;observedAt:number;sourceHash:string;workplace:Workplace;verification:'public-listing-verified'|'public-listing-published';applicationDeadline?:number};
export type VerifiedListingReader=(scope:ErrandScope,request:unknown,signal:AbortSignal)=>Promise<Listing[]>;
export type RankInput={id:string;title:string;excerpt:string;workplace:Workplace;role:string;location:string;salary?:string;avoid?:string};
export type ErrandRanker=(input:RankInput[],signal:AbortSignal)=>Promise<string[]>;
export type ContractAuthority=(scope:ErrandScope,contract:ErrandContract,rootRequest:string)=>boolean;
/** Bridge-owned ordering proof, captured at authenticated ingress before async work. */
export type ShortlistOrderProof=(scope:ErrandScope,outboxId:string)=>boolean;
type Mission={id:string;root_request:string;owner:string;destination:string;binding_id:string;binding_identity:string;contract_json:string;contract_hash:string;state:string;version:number;created_at:number};
type Candidate={id:string;mission_id:string;source_url:string;url:string;title:string;excerpt:string;observed_at:number;source_hash:string;workplace:Workplace;verification:string;application_deadline:number|null;position:number|null};
const MAX_CANDIDATES=40,MAX_TITLE=160,MAX_EXCERPT=600,MAX_AGE=24*60*60*1000;
// Defense in depth only; a trusted source must still exclude private content.
const SENSITIVE=/\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{16,}|xox[baprs]-[a-z0-9-]{12,}|AKIA[A-Z0-9]{16}|bearer\s+[^\s]{8,}|(?:api[ _-]?key|password)\s*[:=]\s*[^\s]{8,})/i;
const clean=(s:string,n:number)=>s.replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,n);
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

/** Lexical defense in depth only; the future verifier must validate public URLs. */
export function publicListingUrl(value:string):string {
  if(typeof value!=='string'||value.length>2048)throw new Error('Invalid public listing URL.');
  let u:URL;try{u=new URL(value);}catch{throw new Error('Invalid public listing URL.');}
  const host=u.hostname.toLowerCase().replace(/\.$/,'');
  if(u.protocol!=='https:'||u.username||u.password||!host||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||!host.includes('.')||isIP(host.replace(/^\[|\]$/g,'')))throw new Error('Only public HTTPS listing URLs are supported.');
  // Query/fragment data may contain credentials or be essential to the page.
  // Until a trusted verifier supplies a safe canonical link, neither silently
  // stripping them nor forwarding them is safe.
  if(u.search||u.hash)throw new Error('A safe canonical listing URL without query or fragment is required.');
  let path:string;try{path=decodeURIComponent(u.pathname);}catch{throw new Error('Invalid public listing URL.');}
  if(SENSITIVE.test(host)||SENSITIVE.test(path))throw new Error('A listing URL contains private data.');
  return u.href;
}

export function errandBindingIdentity(store:Store,b:Binding) {return hash(JSON.stringify([b.id,b.native_id,b.cwd,b.mode,b.provider,b.token_hash,store.get(`execution-mode:${b.id}`),store.get(`session-route:${b.id}`)]));}
async function bounded<T>(signal:AbortSignal,work:(signal:AbortSignal)=>Promise<T>):Promise<T> {
  const combined=AbortSignal.any([signal,AbortSignal.timeout(30000)]);
  if(combined.aborted)throw new Error('Errand operation cancelled or timed out.');
  let onAbort:()=>void=()=>{};
  try {
    return await Promise.race([work(combined),new Promise<T>((_,reject)=>{onAbort=()=>reject(new Error('Errand operation cancelled or timed out.'));combined.addEventListener('abort',onAbort,{once:true});if(combined.aborted)onAbort();})]);
  } finally {combined.removeEventListener('abort',onAbort);}
}
function canonicalContract(input:ErrandContract):ErrandContract {
  if(!input||typeof input.role!=='string'||typeof input.location!=='string'||(input.salary!==undefined&&typeof input.salary!=='string')||(input.avoid!==undefined&&typeof input.avoid!=='string'))throw new Error('Role and location are required.');
  const role=clean(input.role,121),location=clean(input.location,121),salary=input.salary?clean(input.salary,121):'',avoid=input.avoid?clean(input.avoid,501):'';
  if(!role||role.length>120||!location||location.length>120||salary.length>120||avoid.length>500)throw new Error('Provide a concise role and location.');
  if(SENSITIVE.test([role,location,salary,avoid].join(' ')))throw new Error('Remove credentials from the errand criteria.');
  return {role,location,...(salary?{salary}:{}),...(avoid?{avoid}:{})};
}
/** Only explicitly supported exclusions can be evaluated without guessing. */
function eligible(row:Candidate,contract:ErrandContract):boolean {
  if(!contract.avoid)return true;
  const avoid=contract.avoid.toLowerCase().trim().replace(/\s+/g,' ');
  if(!/^(?:(?:no|avoid|exclude)\s+)?on[ -]?site$/.test(avoid))throw new Error('This exclusion cannot be verified safely. Please refine it.');
  // A page excerpt can omit negation or contrary context, so text heuristics
  // and the model may never decide this. Unknown/unattested always fails closed.
  return row.workplace==='remote-only';
}

/** Internal ledger only. No search, browser navigation, message or submission is performed here. */
export class ErrandMissions {
  constructor(private store:Store,private approved:ContractAuthority,private readListings:VerifiedListingReader,private rank:ErrandRanker,private now=()=>Date.now(),private orderedAfter:ShortlistOrderProof=()=>false) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS errand_missions(
      id TEXT PRIMARY KEY,root_request TEXT UNIQUE NOT NULL,owner TEXT NOT NULL,destination TEXT NOT NULL,
      binding_id TEXT NOT NULL,binding_identity TEXT NOT NULL,contract_json TEXT NOT NULL,contract_hash TEXT NOT NULL,
      state TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS errand_candidates(
      id TEXT PRIMARY KEY,mission_id TEXT NOT NULL REFERENCES errand_missions(id),source_url TEXT NOT NULL,url TEXT NOT NULL,
      title TEXT NOT NULL,excerpt TEXT NOT NULL,observed_at INTEGER NOT NULL,source_hash TEXT NOT NULL,workplace TEXT NOT NULL DEFAULT 'unknown',verification TEXT NOT NULL DEFAULT 'unverified',application_deadline INTEGER,position INTEGER,
      UNIQUE(mission_id,url));
      CREATE TABLE IF NOT EXISTS errand_shortlist_messages(
      outbox_id TEXT PRIMARY KEY,mission_id TEXT NOT NULL REFERENCES errand_missions(id),owner TEXT NOT NULL,destination TEXT NOT NULL,root_request TEXT NOT NULL,body_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS errand_draft_claims(
      request_id TEXT PRIMARY KEY,mission_id TEXT NOT NULL REFERENCES errand_missions(id),candidate_id TEXT NOT NULL,owner TEXT NOT NULL,destination TEXT NOT NULL,draft_json TEXT);`);
    // Existing local prototypes have no workplace attestation; never infer one.
    if(!store.db.prepare('PRAGMA table_info(errand_candidates)').all().some((c:any)=>c.name==='workplace'))store.db.exec("ALTER TABLE errand_candidates ADD COLUMN workplace TEXT NOT NULL DEFAULT 'unknown'");
    if(!store.db.prepare('PRAGMA table_info(errand_candidates)').all().some((c:any)=>c.name==='verification'))store.db.exec("ALTER TABLE errand_candidates ADD COLUMN verification TEXT NOT NULL DEFAULT 'unverified'");
    if(!store.db.prepare('PRAGMA table_info(errand_candidates)').all().some((c:any)=>c.name==='application_deadline'))store.db.exec('ALTER TABLE errand_candidates ADD COLUMN application_deadline INTEGER');
    if(!store.db.prepare('PRAGMA table_info(errand_draft_claims)').all().some((c:any)=>c.name==='draft_json'))store.db.exec('ALTER TABLE errand_draft_claims ADD COLUMN draft_json TEXT');
  }
  private active(scope:ErrandScope) {
    const origin=this.store.requestOwnerOrigin(scope.requestId),job=this.store.job(scope.requestId),binding=this.store.binding(scope.bindingId);
    return !!origin&&origin.owner===scope.owner&&origin.destination===scope.destination&&!!job&&job.binding_id===scope.bindingId&&job.destination===scope.destination&&
      ['queued','dispatched','submitted'].includes(job.status)&&!!binding?.enabled&&errandBindingIdentity(this.store,binding)===scope.bindingIdentity;
  }
  private mission(id:string,scope:ErrandScope):Mission {
    const row=this.store.db.prepare('SELECT * FROM errand_missions WHERE id=?').get(id) as Mission|undefined;
    if(!row||row.owner!==scope.owner||row.destination!==scope.destination||row.binding_id!==scope.bindingId||row.binding_identity!==scope.bindingIdentity||!this.active(scope)||row.state==='cancelled')throw new Error('This errand is unavailable for the current owner and session.');
    const contract=JSON.parse(row.contract_json) as ErrandContract;
    if(digest(row.contract_json)!==row.contract_hash||!this.approved(scope,contract,row.root_request))throw new Error('The approved errand contract is unavailable or changed.');
    return row;
  }
  private fresh(row:Candidate) {
    const time=this.now();return row.observed_at>=time-MAX_AGE&&row.observed_at<=time+5000&&
      (row.verification==='public-listing-verified'||(row.verification==='public-listing-published'&&Number.isSafeInteger(row.application_deadline)&&row.application_deadline!>time));
  }
  begin(scope:ErrandScope,input:ErrandContract) {
    const contract=canonicalContract(input),json=JSON.stringify(contract);
    if(!this.active(scope)||!this.approved(scope,contract,scope.requestId))throw new Error('An approved owner request and exact session are required.');
    const existing=this.store.db.prepare('SELECT * FROM errand_missions WHERE root_request=?').get(scope.requestId) as Mission|undefined;
    if(existing){if(existing.owner!==scope.owner||existing.destination!==scope.destination||existing.binding_id!==scope.bindingId||existing.binding_identity!==scope.bindingIdentity||existing.contract_hash!==digest(json)||existing.state==='cancelled')throw new Error('This request already belongs to a different or cancelled errand.');return existing.id;}
    const id=randomUUID();this.store.db.prepare('INSERT INTO errand_missions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,scope.requestId,scope.owner,scope.destination,scope.bindingId,scope.bindingIdentity,json,digest(json),'searching',1,this.now());return id;
  }
  /** `readListings` must verify public pages independently and bind every result to this exact request. */
  async gather(id:string,scope:ErrandScope,query:unknown,signal:AbortSignal) {
    const before=this.mission(id,scope);if(before.state!=='searching')throw new Error('This errand is no longer searching.');
    const result=await bounded(signal,s=>this.readListings(scope,query,s));
    if(signal.aborted)throw new Error('Search cancelled.');
    const current=this.mission(id,scope);if(current.version!==before.version||current.state!=='searching')throw new Error('The errand changed while searching.');
    if(!Array.isArray(result)||result.length>MAX_CANDIDATES)throw new Error('Invalid listing evidence.');
    const unique=new Map<string,Listing>();
    for(const raw of result){
      if(!raw||!['public-listing-verified','public-listing-published'].includes(raw.verification)||(raw.verification==='public-listing-published'&&(!Number.isSafeInteger(raw.applicationDeadline)||raw.applicationDeadline!<=this.now()))||!['remote-only','onsite','hybrid','unknown'].includes(raw.workplace)||typeof raw.title!=='string'||typeof raw.excerpt!=='string'||!Number.isSafeInteger(raw.observedAt)||raw.observedAt>this.now()+5000||raw.observedAt<this.now()-MAX_AGE||!/^[a-f0-9]{64}$/.test(raw.sourceHash))throw new Error('Invalid or stale listing evidence.');
      const title=clean(raw.title,MAX_TITLE+1),excerpt=clean(raw.excerpt,MAX_EXCERPT+1),url=publicListingUrl(raw.url),sourceUrl=publicListingUrl(raw.sourceUrl);
      if(!title||title.length>MAX_TITLE||!excerpt||excerpt.length>MAX_EXCERPT||unique.has(url)||SENSITIVE.test(title+' '+excerpt))throw new Error('Listing evidence is empty, oversized, private or duplicated.');
      unique.set(url,{...raw,title,excerpt,url,sourceUrl});
    }
    this.store.db.exec('SAVEPOINT errand_gather');
    try{
      this.mission(id,scope);if((this.store.db.prepare('SELECT version FROM errand_missions WHERE id=?').get(id) as {version:number}).version!==before.version)throw new Error('The errand changed while searching.');
      this.store.db.prepare('DELETE FROM errand_candidates WHERE mission_id=?').run(id);
      const insert=this.store.db.prepare('INSERT INTO errand_candidates(id,mission_id,source_url,url,title,excerpt,observed_at,source_hash,workplace,verification,application_deadline,position) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)');
      for(const l of unique.values())insert.run(randomUUID(),id,l.sourceUrl,l.url,l.title,l.excerpt,l.observedAt,l.sourceHash,l.workplace,l.verification,l.applicationDeadline??null);
      this.store.db.prepare("UPDATE errand_missions SET state='gathered',version=version+1 WHERE id=?").run(id);
      this.store.db.exec('RELEASE errand_gather');return unique.size;
    }catch(e){this.store.db.exec('ROLLBACK TO errand_gather; RELEASE errand_gather');throw e;}
  }
  async shortlist(id:string,scope:ErrandScope,signal:AbortSignal) {
    const before=this.mission(id,scope);if(before.state!=='gathered')throw new Error('Find verified listings first.');
    const contract=JSON.parse(before.contract_json) as ErrandContract;
    const allRows=this.store.db.prepare('SELECT * FROM errand_candidates WHERE mission_id=? ORDER BY id').all(id) as Candidate[];
    if(!allRows.length)return [];
    const fresh=()=>allRows.every(r=>this.fresh(r));
    if(!fresh())throw new Error('Listing evidence is stale. Start a new errand with a new owner request.');
    const rows=allRows.filter(r=>eligible(r,contract));
    if(!rows.length)throw new Error('No listings have sufficient evidence to verify your exclusion.');
    const proposed=await bounded(signal,s=>this.rank(rows.map(r=>({id:r.id,title:r.title,excerpt:r.excerpt,workplace:r.workplace,role:contract.role,location:contract.location,salary:contract.salary,avoid:contract.avoid})),s));
    if(signal.aborted)throw new Error('Ranking cancelled.');
    const current=this.mission(id,scope);if(current.version!==before.version||current.state!=='gathered')throw new Error('The errand changed while ranking.');
    if(!fresh())throw new Error('Listing evidence is stale. Start a new errand with a new owner request.');
    if(!Array.isArray(proposed)||proposed.length>MAX_CANDIDATES||proposed.some(x=>typeof x!=='string')||new Set(proposed).size!==proposed.length||proposed.some(x=>!rows.some(r=>r.id===x)))throw new Error('Ranking did not match the verified listings.');
    const chosen=proposed.slice(0,5).map(candidateId=>rows.find(r=>r.id===candidateId)!);
    if(!chosen.length)throw new Error('No verified listing was selected.');
    this.store.db.exec('SAVEPOINT errand_rank');
    try{
      this.mission(id,scope);const latest=this.store.db.prepare('SELECT version,state FROM errand_missions WHERE id=?').get(id) as {version:number;state:string};
      if(latest.version!==before.version||latest.state!=='gathered')throw new Error('The errand changed while ranking.');
      if(!fresh())throw new Error('Listing evidence is stale. Start a new errand with a new owner request.');
      for(let i=0;i<chosen.length;i++)this.store.db.prepare('UPDATE errand_candidates SET position=? WHERE id=? AND mission_id=?').run(i+1,chosen[i].id,id);
      this.store.db.prepare("UPDATE errand_missions SET state='shortlisted',version=version+1 WHERE id=?").run(id);this.store.db.exec('RELEASE errand_rank');
    }catch(e){this.store.db.exec('ROLLBACK TO errand_rank; RELEASE errand_rank');throw e;}
    if(!fresh())throw new Error('Listing evidence is stale. Start a new errand with a new owner request.');
    return chosen.map((r,i)=>({number:i+1,title:r.title,url:r.url,sourceUrl:r.source_url,observedAt:r.observed_at,listingPageIdentity:'unverified' as const,applicationAvailability:'unverified' as const,reason:this.reason(r,contract)}));
  }
  private reason(row:Candidate,contract:ErrandContract){
    const data=`${row.title} ${row.excerpt}`.toLocaleLowerCase(),reasons:string[]=[];
    if(data.includes(contract.role.toLocaleLowerCase()))reasons.push(`Mentions ${contract.role}`);
    if(data.includes(contract.location.toLocaleLowerCase()))reasons.push(`Mentions ${contract.location}`);
    return reasons.length?reasons.join('; '):'Review the listing against your criteria';
  }
  /** A fresh owner request can reopen only its own unexpired immutable snapshot. */
  viewShortlist(id:string,scope:ErrandScope) {
    const mission=this.mission(id,scope);if(mission.state!=='shortlisted')throw new Error('No shortlist is available.');
    const rows=this.store.db.prepare('SELECT * FROM errand_candidates WHERE mission_id=? AND position IS NOT NULL ORDER BY position').all(id) as Candidate[];
    if(!rows.length||rows.some(r=>!this.fresh(r)))throw new Error('That shortlist is stale. Start a new errand with a new owner request.');
    const contract=JSON.parse(mission.contract_json) as ErrandContract;
    return rows.map(r=>({number:r.position!,title:r.title,url:r.url,sourceUrl:r.source_url,observedAt:r.observed_at,listingPageIdentity:'unverified' as const,applicationAvailability:'unverified' as const,reason:this.reason(r,contract)}));
  }
  /** Build exactly one bounded message. This returns text; it never enqueues or sends. */
  shortlistText(id:string,scope:ErrandScope) {
    const rows=this.viewShortlist(id,scope);
    const text=['Job shortlist. Listing page identity and application availability are unverified.',...rows.map(r=>`${r.number}. ${r.title}\n${r.url}\n${r.reason}`),'Reply draft NUMBER to prepare a draft.'].join('\n');
    if(toWhatsApp(text).length>3500)throw new Error('The shortlist is too long to deliver as one message.');
    return text;
  }
  /**
   * Internal bridge-only registration. The future sender must atomically queue
   * and bind the exact message BEFORE transport sees it; this code never sends.
   */
  bindShortlistMessage(id:string,scope:ErrandScope,outboxId:string) {
    const mission=this.mission(id,scope);if(scope.requestId!==mission.root_request)throw new Error('Only the original owner request may queue its shortlist.');
    const body=toWhatsApp(this.shortlistText(id,scope)),source=`errand-shortlist:${id}`;
    const row=this.store.db.prepare('SELECT id,source,body,destination,binding_id,request_id,reply_kind,status FROM outbox WHERE id=?').get(outboxId) as {id:string;source:string;body:string;destination:string|null;binding_id:string|null;request_id:string|null;reply_kind:string|null;status:string}|undefined;
    if(!row||row.source!==`${source}:0`||row.body!==body||row.destination!==scope.destination||row.binding_id!==null||row.request_id!==mission.root_request||row.reply_kind!=='system'||row.status!=='queued'||this.store.db.prepare('SELECT 1 FROM outbox WHERE source=?').get(`${source}:1`))throw new Error('The queued shortlist message does not match this owner and snapshot.');
    const existing=this.store.db.prepare('SELECT mission_id,owner,destination,root_request,body_hash FROM errand_shortlist_messages WHERE outbox_id=?').get(outboxId) as {mission_id:string;owner:string;destination:string;root_request:string;body_hash:string}|undefined;
    if(existing){if(existing.mission_id!==id||existing.owner!==scope.owner||existing.destination!==scope.destination||existing.root_request!==mission.root_request||existing.body_hash!==digest(body))throw new Error('The shortlist message identity was reused.');return;}
    this.store.db.prepare('INSERT INTO errand_shortlist_messages VALUES(?,?,?,?,?,?)').run(outboxId,id,scope.owner,scope.destination,mission.root_request,digest(body));
  }
  /** Select only from the stored exact snapshot, using a new authenticated owner request. */
  draft(id:string,scope:ErrandScope,number:number) {
    const mission=this.mission(id,scope);if(mission.state!=='shortlisted'||!Number.isInteger(number)||number<1||number>5)throw new Error('Choose a number from the current shortlist.');
    const request=this.store.job(scope.requestId),body=request?.body??'',match=/^\s*(?:please\s+)?draft\s+([1-5])\s*[.!?]*\s*$/i.exec(body);
    if(!scope.requestId.startsWith('wa:')||scope.requestId===mission.root_request||this.store.get(`parent:${scope.requestId}`)||this.store.get(`report-parent:${scope.requestId}`)||!match||Number(match[1])!==number)throw new Error('Send a new owner message such as draft 1 to choose this listing.');
    const delivered=this.store.db.prepare(`SELECT o.id,m.mission_id,m.body_hash,o.body,o.delivered_at,o.sent_at,o.source,o.request_id,o.binding_id,o.reply_kind,o.destination
      FROM errand_shortlist_messages m JOIN outbox o ON o.id=m.outbox_id
      WHERE m.owner=? AND m.destination=? AND o.status='sent' AND o.delivered_at IS NOT NULL AND o.sent_at IS NOT NULL
        AND o.sent_at<=o.delivered_at
      ORDER BY o.delivered_at DESC LIMIT 2`).all(scope.owner,scope.destination) as {id:string;mission_id:string;body_hash:string;body:string;delivered_at:number;sent_at:number;source:string;request_id:string|null;binding_id:string|null;reply_kind:string|null;destination:string|null}[];
    const latest=delivered[0];
    if(!latest||latest.mission_id!==id||delivered[1]?.delivered_at===latest.delivered_at||latest.source!==`errand-shortlist:${id}:0`||latest.request_id!==mission.root_request||latest.binding_id!==null||latest.reply_kind!=='system'||latest.destination!==scope.destination||latest.body_hash!==digest(latest.body)||latest.body!==toWhatsApp(this.shortlistText(id,scope)))throw new Error('That shortlist was not confirmed delivered or is no longer the latest.');
    // inbox.received_at is assigned after routing, so it is not ingress proof.
    // Until a bridge-owned ordering adapter exists, every draft fails closed.
    if(!this.orderedAfter(scope,latest.id))throw new Error('Cannot verify that this request followed the delivered shortlist.');
    const row=this.store.db.prepare('SELECT * FROM errand_candidates WHERE mission_id=? AND position=?').get(id,number) as Candidate|undefined;
    if(!row||!this.fresh(row))throw new Error('That listing is unavailable or stale. Start a new errand with a new owner request.');
    const contract=JSON.parse(mission.contract_json) as ErrandContract;
    // Persist the result with the claim, so a crash after commit can recover
    // the same result without creating another draft or repeating an effect.
    const result={title:row.title,url:row.url,text:`Hello,\n\nI am interested in the ${row.title} opportunity. I am looking for a ${contract.role} role in ${contract.location}.\n\nI would welcome the opportunity to discuss the position and how my experience fits your needs.\n\nThank you.`};
    this.store.db.exec('SAVEPOINT errand_draft');
    try{
      this.mission(id,scope);const existing=this.store.db.prepare('SELECT mission_id,candidate_id,owner,destination,draft_json FROM errand_draft_claims WHERE request_id=?').get(scope.requestId) as {mission_id:string;candidate_id:string;owner:string;destination:string;draft_json:string|null}|undefined;
      if(existing){
        if(existing.mission_id!==id||existing.candidate_id!==row.id||existing.owner!==scope.owner||existing.destination!==scope.destination||!existing.draft_json)throw new Error('That draft request was already used.');
        const saved=JSON.parse(existing.draft_json) as typeof result;
        if(!saved||saved.title!==row.title||saved.url!==row.url||typeof saved.text!=='string'||!saved.text||saved.text.length>10000)throw new Error('The saved draft is unavailable.');
        this.store.db.exec('RELEASE errand_draft');return saved;
      }
      this.store.db.prepare('INSERT INTO errand_draft_claims(request_id,mission_id,candidate_id,owner,destination,draft_json) VALUES(?,?,?,?,?,?)').run(scope.requestId,id,row.id,scope.owner,scope.destination,JSON.stringify(result));this.store.db.exec('RELEASE errand_draft');
    }catch(e){this.store.db.exec('ROLLBACK TO errand_draft; RELEASE errand_draft');throw e;}
    // No invented experience, name or recipient. This is a local draft only.
    return result;
  }
  cancel(id:string,scope:ErrandScope) {this.mission(id,scope);this.store.db.prepare("UPDATE errand_missions SET state='cancelled',version=version+1 WHERE id=?").run(id);}
}
