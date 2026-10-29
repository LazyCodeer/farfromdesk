import {createHash,randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {hash,type Binding,type Store} from './store.js';
import {toWhatsApp} from './whatsapp-format.js';
import {parseErrandChoice,shortlistReference} from './errand-choice.js';
import {selectErrandProfileNotes,type ErrandProfileSnapshot} from './errand-profile.js';

/**
 * Internal F6 foundation. This module is not connected to a route, browser,
 * session or delivery API. Only bridge-owned, independently reviewed adapters
 * may authorize a contract or supply listing evidence; session or model text
 * must never be used as an evidence adapter.
 */
export type ErrandContract={role:string;location:string;salary?:string;avoid?:string;skills?:string[]};
export type ErrandScope={requestId:string;owner:string;destination:string;bindingId:string;bindingIdentity:string};
/** The marker and workplace attestation are meaningful only from a trusted bridge-owned verifier. */
export type Workplace='remote-only'|'onsite'|'hybrid'|'unknown';
export type Listing={sourceUrl:string;url:string;title:string;excerpt:string;location?:string;employer?:string;observedAt:number;sourceHash:string;workplace:Workplace;verification:'public-listing-verified'|'public-listing-published'|'public-listing-published-no-deadline';applicationDeadline?:number};
export type VerifiedListingReader=(scope:ErrandScope,request:unknown,signal:AbortSignal)=>Promise<Listing[]>;
export type RankInput={id:string;title:string;excerpt:string;workplace:Workplace;role:string;location:string;salary?:string;avoid?:string};
export type ErrandRanker=(input:RankInput[],signal:AbortSignal)=>Promise<string[]>;
export type ContractAuthority=(scope:ErrandScope,contract:ErrandContract,rootRequest:string)=>boolean;
/** Bridge-owned ordering proof, captured at authenticated ingress before async work. */
export type ShortlistOrderProof=(scope:ErrandScope,outboxId:string)=>boolean;
export class ErrandSearchFailure extends Error {
  constructor(readonly reason:'no-evidence'|'unsupported-exclusion'|'exclusion-unverified',message:string){super(message);}
}
type Mission={id:string;root_request:string;owner:string;destination:string;binding_id:string;binding_identity:string;contract_json:string;contract_hash:string;root_body_hash:string|null;state:string;version:number;created_at:number};
type Candidate={id:string;mission_id:string;source_url:string;url:string;title:string;excerpt:string;listing_location:string|null;listing_employer:string|null;observed_at:number;source_hash:string;workplace:Workplace;verification:string;application_deadline:number|null;position:number|null};
const MAX_CANDIDATES=40,MAX_TITLE=160,MAX_EXCERPT=600,MAX_AGE=24*60*60*1000,NO_DEADLINE_MAX_AGE=60*60*1000;
// Defense in depth only; a trusted source must still exclude private content.
const SENSITIVE=/\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{16,}|xox[baprs]-[a-z0-9-]{12,}|AKIA[A-Z0-9]{16}|bearer\s+[^\s]{8,}|(?:api[ _-]?key|password)\s*[:=]\s*[^\s]{8,})/i;
const clean=(s:string,n:number)=>s.replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,n);
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const candidateDigest=(row:Candidate)=>digest(JSON.stringify([row.id,row.mission_id,row.source_url,row.url,row.title,row.excerpt,row.listing_location,row.listing_employer,row.observed_at,row.source_hash,row.workplace,row.verification,row.application_deadline,row.position]));

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

export function errandBindingIdentity(store:Store,b:Binding) {return hash(JSON.stringify([b.id,b.native_id,b.cwd,b.mode,b.provider,b.token_hash,store.get(`execution-mode:${b.id}`),store.get(`session-route:${b.id}`),store.get(`binding-disable-generation:${b.id}`),store.get(`errand-binding-generation:${b.id}`),store.get('incoming-owner-generation'),store.get('errand-authority-generation')]));}
async function bounded<T>(signal:AbortSignal,work:(signal:AbortSignal)=>Promise<T>):Promise<T> {
  const combined=AbortSignal.any([signal,AbortSignal.timeout(30000)]);
  if(combined.aborted)throw new Error('Errand operation cancelled or timed out.');
  let onAbort:()=>void=()=>{};
  try {
    return await Promise.race([work(combined),new Promise<T>((_,reject)=>{onAbort=()=>reject(new Error('Errand operation cancelled or timed out.'));combined.addEventListener('abort',onAbort,{once:true});if(combined.aborted)onAbort();})]);
  } finally {combined.removeEventListener('abort',onAbort);}
}
export function canonicalContract(input:ErrandContract):ErrandContract {
  if(!input||typeof input.role!=='string'||typeof input.location!=='string'||(input.salary!==undefined&&typeof input.salary!=='string')||(input.avoid!==undefined&&typeof input.avoid!=='string'))throw new Error('Role and location are required.');
  const role=clean(input.role,121),location=clean(input.location,121),salary=input.salary?clean(input.salary,121):'',avoid=input.avoid?clean(input.avoid,501):'';
  if(!role||role.length>120||!location||location.length>120||salary.length>120||avoid.length>500)throw new Error('Provide a concise role and location.');
  if(SENSITIVE.test([role,location,salary,avoid].join(' ')))throw new Error('Remove credentials from the errand criteria.');
  const skills=input.skills===undefined?undefined:canonicalSkills(input.skills);
  return {role,location,...(salary?{salary}:{}),...(avoid?{avoid}:{}),...(skills?{skills}:{})};
}
/** Only facts explicitly supplied for this search are considered; no memory or resume is read. */
export function canonicalSkills(value:unknown):string[] {
  if(!Array.isArray(value)||value.length<1||value.length>5||value.some(v=>typeof v!=='string'))throw new Error('Provide one to five short skills.');
  const skills=(value as string[]).map(s=>s.trim());
  if(skills.some(s=>!s||s.length>40||!/^[\p{L}\p{N}][\p{L}\p{N} +#.-]*$/u.test(s)||SENSITIVE.test(s))||new Set(skills.map(s=>s.toLocaleLowerCase())).size!==skills.length)throw new Error('Provide one to five distinct short skills.');
  return skills;
}
function mentionedSkills(row:Candidate,contract:ErrandContract) {
  const text=row.title;
  return (contract.skills??[]).filter(skill=>{
    const literal=skill.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return new RegExp(`(?:^|[^\\p{L}\\p{N}+#])${literal}(?=$|[^\\p{L}\\p{N}+#])`,'iu').test(text);
  });
}
/** Only explicitly supported exclusions can be evaluated without guessing. */
function eligible(row:Candidate,contract:ErrandContract):boolean {
  if(!contract.avoid)return true;
  const avoid=contract.avoid.toLowerCase().trim().replace(/\s+/g,' ');
  if(!/^(?:(?:no|avoid|exclude)\s+)?on[ -]?site$/.test(avoid))throw new ErrandSearchFailure('unsupported-exclusion','This exclusion cannot be verified safely. Please refine it.');
  // A page excerpt can omit negation or contrary context, so text heuristics
  // and the model may never decide this. Unknown/unattested always fails closed.
  return row.workplace==='remote-only';
}

/** Internal ledger only. No search, browser navigation, message or submission is performed here. */
export class ErrandMissions {
  constructor(private store:Store,private approved:ContractAuthority,private readListings:VerifiedListingReader,private rank:ErrandRanker,private now=()=>Date.now(),private orderedAfter:ShortlistOrderProof=()=>false,private readProfile:(scope:ErrandScope,contract:ErrandContract)=>ErrandProfileSnapshot|undefined=()=>undefined) {
    // Record every identity transition, including direct SQL changes and
    // change-away-and-back. Value snapshots alone cannot detect those races.
    for(const operation of ['INSERT','UPDATE','DELETE'] as const){
      const row=operation==='DELETE'?'OLD':'NEW';
      const changed=operation==='UPDATE'?' AND OLD.value IS NOT NEW.value':'';
      store.db.exec(`CREATE TRIGGER IF NOT EXISTS errand_route_${operation.toLowerCase()}_v1 AFTER ${operation} ON settings
        WHEN (${row}.key LIKE 'session-route:%' OR ${row}.key LIKE 'execution-mode:%')${changed}
        BEGIN INSERT INTO settings(key,value) VALUES('errand-binding-generation:'||substr(${row}.key,instr(${row}.key,':')+1),lower(hex(randomblob(16)))) ON CONFLICT(key) DO UPDATE SET value=excluded.value; END`);
      const bindingChanged=operation==='UPDATE'?" WHEN OLD.id IS NOT NEW.id OR OLD.provider IS NOT NEW.provider OR OLD.native_id IS NOT NEW.native_id OR OLD.cwd IS NOT NEW.cwd OR OLD.mode IS NOT NEW.mode OR OLD.token_hash IS NOT NEW.token_hash OR OLD.enabled IS NOT NEW.enabled":'';
      store.db.exec(`CREATE TRIGGER IF NOT EXISTS errand_binding_${operation.toLowerCase()}_v1 AFTER ${operation} ON bindings${bindingChanged}
        BEGIN INSERT INTO settings(key,value) VALUES('errand-binding-generation:'||${row}.id,lower(hex(randomblob(16)))) ON CONFLICT(key) DO UPDATE SET value=excluded.value; END`);
    }
    store.db.exec(`CREATE TABLE IF NOT EXISTS errand_missions(
      id TEXT PRIMARY KEY,root_request TEXT UNIQUE NOT NULL,owner TEXT NOT NULL,destination TEXT NOT NULL,
      binding_id TEXT NOT NULL,binding_identity TEXT NOT NULL,contract_json TEXT NOT NULL,contract_hash TEXT NOT NULL,
      state TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,root_body_hash TEXT);
      CREATE TABLE IF NOT EXISTS errand_candidates(
      id TEXT PRIMARY KEY,mission_id TEXT NOT NULL REFERENCES errand_missions(id),source_url TEXT NOT NULL,url TEXT NOT NULL,
      title TEXT NOT NULL,excerpt TEXT NOT NULL,listing_location TEXT,listing_employer TEXT,observed_at INTEGER NOT NULL,source_hash TEXT NOT NULL,workplace TEXT NOT NULL DEFAULT 'unknown',verification TEXT NOT NULL DEFAULT 'unverified',application_deadline INTEGER,position INTEGER,
      UNIQUE(mission_id,url));
      CREATE TABLE IF NOT EXISTS errand_shortlist_messages(
      outbox_id TEXT PRIMARY KEY,mission_id TEXT NOT NULL REFERENCES errand_missions(id),owner TEXT NOT NULL,destination TEXT NOT NULL,root_request TEXT NOT NULL,body_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS errand_draft_claims(
      request_id TEXT PRIMARY KEY,mission_id TEXT NOT NULL REFERENCES errand_missions(id),candidate_id TEXT NOT NULL,owner TEXT NOT NULL,destination TEXT NOT NULL,draft_json TEXT,candidate_hash TEXT,profile_revision TEXT);`);
    if(!store.db.prepare('PRAGMA table_info(errand_missions)').all().some((c:any)=>c.name==='root_body_hash'))store.db.exec('ALTER TABLE errand_missions ADD COLUMN root_body_hash TEXT');
    store.db.exec(`CREATE TRIGGER IF NOT EXISTS errand_root_body_change_v1 AFTER UPDATE OF body ON inbox WHEN OLD.body IS NOT NEW.body
      BEGIN UPDATE errand_missions SET state='invalidated',version=version+1 WHERE root_request=NEW.id AND state NOT IN ('cancelled','invalidated'); END;
      CREATE TRIGGER IF NOT EXISTS errand_root_id_change_v1 AFTER UPDATE OF id ON inbox WHEN OLD.id IS NOT NEW.id
      BEGIN UPDATE errand_missions SET state='invalidated',version=version+1 WHERE root_request=OLD.id AND state NOT IN ('cancelled','invalidated'); END;
      CREATE TRIGGER IF NOT EXISTS errand_root_scope_change_v1 AFTER UPDATE OF binding_id,destination ON inbox WHEN OLD.binding_id IS NOT NEW.binding_id OR OLD.destination IS NOT NEW.destination
      BEGIN UPDATE errand_missions SET state='invalidated',version=version+1 WHERE root_request=OLD.id AND state NOT IN ('cancelled','invalidated'); END;
      CREATE TRIGGER IF NOT EXISTS errand_root_unsafe_status_v2 AFTER UPDATE OF status ON inbox WHEN OLD.status IS NOT NEW.status AND NEW.status NOT IN ('submitted','completed')
      BEGIN UPDATE errand_missions SET state='invalidated',version=version+1 WHERE root_request=OLD.id AND state NOT IN ('cancelled','invalidated'); END;
      CREATE TRIGGER IF NOT EXISTS errand_root_unsafe_outcome_v1 AFTER UPDATE OF outcome ON inbox WHEN OLD.outcome IS NOT NEW.outcome AND NEW.outcome IN ('blocked','reviewed','cancelled')
      BEGIN UPDATE errand_missions SET state='invalidated',version=version+1 WHERE root_request=OLD.id AND state NOT IN ('cancelled','invalidated'); END;
      CREATE TRIGGER IF NOT EXISTS errand_root_delete_v1 AFTER DELETE ON inbox
      BEGIN UPDATE errand_missions SET state='invalidated',version=version+1 WHERE root_request=OLD.id AND state NOT IN ('cancelled','invalidated'); END;
      CREATE TRIGGER IF NOT EXISTS errand_root_insert_v1 AFTER INSERT ON inbox
      BEGIN UPDATE errand_missions SET state='invalidated',version=version+1 WHERE root_request=NEW.id AND state NOT IN ('cancelled','invalidated'); END;`);
    // Existing local prototypes have no workplace attestation; never infer one.
    if(!store.db.prepare('PRAGMA table_info(errand_candidates)').all().some((c:any)=>c.name==='workplace'))store.db.exec("ALTER TABLE errand_candidates ADD COLUMN workplace TEXT NOT NULL DEFAULT 'unknown'");
    if(!store.db.prepare('PRAGMA table_info(errand_candidates)').all().some((c:any)=>c.name==='verification'))store.db.exec("ALTER TABLE errand_candidates ADD COLUMN verification TEXT NOT NULL DEFAULT 'unverified'");
    if(!store.db.prepare('PRAGMA table_info(errand_candidates)').all().some((c:any)=>c.name==='application_deadline'))store.db.exec('ALTER TABLE errand_candidates ADD COLUMN application_deadline INTEGER');
    if(!store.db.prepare('PRAGMA table_info(errand_candidates)').all().some((c:any)=>c.name==='listing_location'))store.db.exec('ALTER TABLE errand_candidates ADD COLUMN listing_location TEXT');
    if(!store.db.prepare('PRAGMA table_info(errand_candidates)').all().some((c:any)=>c.name==='listing_employer'))store.db.exec('ALTER TABLE errand_candidates ADD COLUMN listing_employer TEXT');
    if(!store.db.prepare('PRAGMA table_info(errand_draft_claims)').all().some((c:any)=>c.name==='draft_json'))store.db.exec('ALTER TABLE errand_draft_claims ADD COLUMN draft_json TEXT');
    if(!store.db.prepare('PRAGMA table_info(errand_draft_claims)').all().some((c:any)=>c.name==='candidate_hash'))store.db.exec('ALTER TABLE errand_draft_claims ADD COLUMN candidate_hash TEXT');
    if(!store.db.prepare('PRAGMA table_info(errand_draft_claims)').all().some((c:any)=>c.name==='profile_revision'))store.db.exec('ALTER TABLE errand_draft_claims ADD COLUMN profile_revision TEXT');
  }
  private active(scope:ErrandScope) {
    const origin=this.store.requestOwnerOrigin(scope.requestId),job=this.store.job(scope.requestId),binding=this.store.binding(scope.bindingId);
    let completed=false;
    if(job?.status==='completed'&&this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='errand_outbox_guards'").get()){
      const row=this.store.db.prepare(`SELECT g.body_hash,o.body FROM errand_outbox_guards g JOIN outbox o ON o.id=g.outbox_id
        WHERE g.request_id=? AND g.owner=? AND g.destination=? AND g.binding_id=? AND g.binding_identity=? AND o.status='sent' LIMIT 1`).get(scope.requestId,scope.owner,scope.destination,scope.bindingId,scope.bindingIdentity) as {body_hash:string;body:string}|undefined;
      completed=!!row&&row.body_hash===hash(row.body);
    }
    return !!origin&&origin.owner===scope.owner&&origin.destination===scope.destination&&!!job&&job.binding_id===scope.bindingId&&job.destination===scope.destination&&
      (['queued','dispatched','submitted'].includes(job.status)||completed)&&!!binding?.enabled&&errandBindingIdentity(this.store,binding)===scope.bindingIdentity;
  }
  private mission(id:string,scope:ErrandScope):Mission {
    const row=this.store.db.prepare('SELECT * FROM errand_missions WHERE id=?').get(id) as Mission|undefined;
    const root=row&&this.store.job(row.root_request);
    if(!row||row.owner!==scope.owner||row.destination!==scope.destination||row.binding_id!==scope.bindingId||row.binding_identity!==scope.bindingIdentity||!this.active(scope)||!root||!row.root_body_hash||row.root_body_hash!==hash(root.body)||['cancelled','invalidated'].includes(row.state))throw new Error('This errand is unavailable for the current owner and session.');
    const contract=JSON.parse(row.contract_json) as ErrandContract;
    if(digest(row.contract_json)!==row.contract_hash||!this.approved(scope,contract,row.root_request))throw new Error('The approved errand contract is unavailable or changed.');
    return row;
  }
  private fresh(row:Candidate) {
    const time=this.now();return row.observed_at>=time-MAX_AGE&&row.observed_at<=time+5000&&
      (row.verification==='public-listing-verified'||(row.verification==='public-listing-published'&&Number.isSafeInteger(row.application_deadline)&&row.application_deadline!>time)||
        (row.verification==='public-listing-published-no-deadline'&&row.application_deadline===null&&row.observed_at>=time-NO_DEADLINE_MAX_AGE));
  }
  begin(scope:ErrandScope,input:ErrandContract) {
    const contract=canonicalContract(input),json=JSON.stringify(contract);
    if(!this.active(scope)||!this.approved(scope,contract,scope.requestId))throw new Error('An approved owner request and exact session are required.');
    const existing=this.store.db.prepare('SELECT * FROM errand_missions WHERE root_request=?').get(scope.requestId) as Mission|undefined;
    const root=this.store.job(scope.requestId);if(!root)throw new Error('The original owner request is unavailable.');
    if(existing){if(existing.owner!==scope.owner||existing.destination!==scope.destination||existing.binding_id!==scope.bindingId||existing.binding_identity!==scope.bindingIdentity||existing.contract_hash!==digest(json)||existing.root_body_hash!==hash(root.body)||['cancelled','invalidated'].includes(existing.state))throw new Error('This request already belongs to a different or cancelled errand.');return existing.id;}
    const id=randomUUID();this.store.db.prepare('INSERT INTO errand_missions(id,root_request,owner,destination,binding_id,binding_identity,contract_json,contract_hash,state,version,created_at,root_body_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,scope.requestId,scope.owner,scope.destination,scope.bindingId,scope.bindingIdentity,json,digest(json),'searching',1,this.now(),hash(root.body));return id;
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
      if(!raw||!['public-listing-verified','public-listing-published','public-listing-published-no-deadline'].includes(raw.verification)||(raw.verification==='public-listing-published'&&(!Number.isSafeInteger(raw.applicationDeadline)||raw.applicationDeadline!<=this.now()))||(raw.verification==='public-listing-published-no-deadline'&&(raw.applicationDeadline!==undefined||raw.observedAt<this.now()-NO_DEADLINE_MAX_AGE))||!['remote-only','onsite','hybrid','unknown'].includes(raw.workplace)||typeof raw.title!=='string'||typeof raw.excerpt!=='string'||!Number.isSafeInteger(raw.observedAt)||raw.observedAt>this.now()+5000||raw.observedAt<this.now()-MAX_AGE||!/^[a-f0-9]{64}$/.test(raw.sourceHash))throw new Error('Invalid or stale listing evidence.');
      if((raw.location!==undefined&&typeof raw.location!=='string')||(raw.employer!==undefined&&typeof raw.employer!=='string'))throw new Error('Invalid listing metadata.');
      const title=clean(raw.title,MAX_TITLE+1),excerpt=clean(raw.excerpt,MAX_EXCERPT+1),location=raw.location===undefined?undefined:clean(raw.location,161),employer=raw.employer===undefined?undefined:clean(raw.employer,161),url=publicListingUrl(raw.url),sourceUrl=publicListingUrl(raw.sourceUrl);
      if(!title||title.length>MAX_TITLE||!excerpt||excerpt.length>MAX_EXCERPT||[location,employer].some(v=>v!==undefined&&(!v||v.length>160||/[\u202a-\u202e\u2066-\u2069]|@|https?:\/\//i.test(v)))||unique.has(url)||SENSITIVE.test(title+' '+excerpt+' '+(location??'')+' '+(employer??'')))throw new Error('Listing evidence is empty, oversized, private or duplicated.');
      unique.set(url,{...raw,title,excerpt,url,sourceUrl,...(location!==undefined?{location}:{}),...(employer!==undefined?{employer}:{})});
    }
    this.store.db.exec('SAVEPOINT errand_gather');
    try{
      this.mission(id,scope);if((this.store.db.prepare('SELECT version FROM errand_missions WHERE id=?').get(id) as {version:number}).version!==before.version)throw new Error('The errand changed while searching.');
      this.store.db.prepare('DELETE FROM errand_candidates WHERE mission_id=?').run(id);
      const insert=this.store.db.prepare('INSERT INTO errand_candidates(id,mission_id,source_url,url,title,excerpt,listing_location,listing_employer,observed_at,source_hash,workplace,verification,application_deadline,position) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)');
      for(const l of unique.values())insert.run(randomUUID(),id,l.sourceUrl,l.url,l.title,l.excerpt,l.location??null,l.employer??null,l.observedAt,l.sourceHash,l.workplace,l.verification,l.applicationDeadline??null);
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
    if(!rows.length)throw new ErrandSearchFailure('exclusion-unverified','No listings have sufficient evidence to verify your exclusion.');
    const proposed=await bounded(signal,s=>this.rank(rows.map(r=>({id:r.id,title:r.title,excerpt:r.excerpt,workplace:r.workplace,role:contract.role,location:contract.location,salary:contract.salary,avoid:contract.avoid})),s));
    if(signal.aborted)throw new Error('Ranking cancelled.');
    const current=this.mission(id,scope);if(current.version!==before.version||current.state!=='gathered')throw new Error('The errand changed while ranking.');
    if(!fresh())throw new Error('Listing evidence is stale. Start a new errand with a new owner request.');
    if(!Array.isArray(proposed)||proposed.length>MAX_CANDIDATES||proposed.some(x=>typeof x!=='string')||new Set(proposed).size!==proposed.length||proposed.some(x=>!rows.some(r=>r.id===x)))throw new Error('Ranking did not match the verified listings.');
    // The owner's skills field is omitted from source and ranking inputs;
    // listing titles can contain the same terms. Mentions never change order.
    const selected=proposed.slice(0,5).map(candidateId=>rows.find(r=>r.id===candidateId)!);
    if(!selected.length)throw new Error('No verified listing was selected.');
    this.store.db.exec('SAVEPOINT errand_rank');
    try{
      this.mission(id,scope);const latest=this.store.db.prepare('SELECT version,state FROM errand_missions WHERE id=?').get(id) as {version:number;state:string};
      if(latest.version!==before.version||latest.state!=='gathered')throw new Error('The errand changed while ranking.');
      if(!fresh())throw new Error('Listing evidence is stale. Start a new errand with a new owner request.');
      for(let i=0;i<selected.length;i++)this.store.db.prepare('UPDATE errand_candidates SET position=? WHERE id=? AND mission_id=?').run(i+1,selected[i].id,id);
      this.store.db.prepare("UPDATE errand_missions SET state='shortlisted',version=version+1 WHERE id=?").run(id);this.store.db.exec('RELEASE errand_rank');
    }catch(e){this.store.db.exec('ROLLBACK TO errand_rank; RELEASE errand_rank');throw e;}
    if(!fresh())throw new Error('Listing evidence is stale. Start a new errand with a new owner request.');
    return selected.map((r,i)=>({number:i+1,title:r.title,url:r.url,sourceUrl:r.source_url,observedAt:r.observed_at,listingPageIdentity:'unverified' as const,applicationAvailability:'unverified' as const,reason:this.reason(r,contract)}));
  }
  private reason(row:Candidate,contract:ErrandContract){
    const data=`${row.title} ${row.excerpt}`.toLocaleLowerCase(),reasons:string[]=[];
    if(data.includes(contract.role.toLocaleLowerCase()))reasons.push(`Mentions ${contract.role}`);
    if(data.includes(contract.location.toLocaleLowerCase()))reasons.push(`Mentions ${contract.location}`);
    const skills=mentionedSkills(row,contract);if(skills.length)reasons.push(`Title includes your stated skill terms: ${skills.join(', ')}`);
    if(row.verification==='public-listing-published-no-deadline')reasons.push('Deadline not provided');
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
    const text=['Job shortlist. Page identity, application availability, salary and eligibility are unverified.',...rows.map(r=>`${r.number}. ${r.title}\n${r.url}\n${r.reason}`),`Reply draft NUMBER ${shortlistReference(id)} to prepare a draft.`].join('\n');
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
    if(!row||row.source!==`${source}:0`||row.body!==body||row.destination!==scope.destination||row.binding_id!==scope.bindingId||row.request_id!==mission.root_request||row.reply_kind!=='system'||row.status!=='queued'||this.store.db.prepare('SELECT 1 FROM outbox WHERE source=?').get(`${source}:1`))throw new Error('The queued shortlist message does not match this owner and snapshot.');
    const existing=this.store.db.prepare('SELECT mission_id,owner,destination,root_request,body_hash FROM errand_shortlist_messages WHERE outbox_id=?').get(outboxId) as {mission_id:string;owner:string;destination:string;root_request:string;body_hash:string}|undefined;
    if(existing){if(existing.mission_id!==id||existing.owner!==scope.owner||existing.destination!==scope.destination||existing.root_request!==mission.root_request||existing.body_hash!==digest(body))throw new Error('The shortlist message identity was reused.');return;}
    this.store.db.prepare('INSERT INTO errand_shortlist_messages VALUES(?,?,?,?,?,?)').run(outboxId,id,scope.owner,scope.destination,mission.root_request,digest(body));
  }
  /** Select only from the stored exact snapshot, using a new authenticated owner request. */
  draft(id:string,scope:ErrandScope,number:number) {
    const mission=this.mission(id,scope);if(mission.state!=='shortlisted'||!Number.isInteger(number)||number<1||number>5)throw new Error('Choose a number from the current shortlist.');
    const request=this.store.job(scope.requestId),choice=parseErrandChoice(request?.body??'');
    if(!scope.requestId.startsWith('wa:')||scope.requestId===mission.root_request||this.store.get(`parent:${scope.requestId}`)||this.store.get(`report-parent:${scope.requestId}`)||!choice||choice.number!==number)throw new Error('Send a new owner message such as draft 1 to choose this listing.');
    const delivered=this.store.db.prepare(`SELECT o.id,m.mission_id,m.body_hash,o.body,o.delivered_at,o.sent_at,o.source,o.request_id,o.binding_id,o.reply_kind,o.destination
      FROM errand_shortlist_messages m JOIN outbox o ON o.id=m.outbox_id
      WHERE m.owner=? AND m.destination=? AND o.status='sent' AND o.delivered_at IS NOT NULL AND o.sent_at IS NOT NULL
      ORDER BY o.delivered_at DESC LIMIT 2`).all(scope.owner,scope.destination) as {id:string;mission_id:string;body_hash:string;body:string;delivered_at:number;sent_at:number;source:string;request_id:string|null;binding_id:string|null;reply_kind:string|null;destination:string|null}[];
    const latest=delivered[0];
    if(!latest||latest.mission_id!==id||delivered[1]?.delivered_at===latest.delivered_at||latest.source!==`errand-shortlist:${id}:0`||latest.request_id!==mission.root_request||latest.binding_id!==scope.bindingId||latest.reply_kind!=='system'||latest.destination!==scope.destination||latest.body_hash!==digest(latest.body)||latest.body!==toWhatsApp(this.shortlistText(id,scope)))throw new Error('That shortlist was not confirmed delivered or is no longer the latest.');
    // Callback order cannot establish when a message was composed on another
    // device. Once multiple shortlists have been delivered, require the code
    // printed on the latest one so a delayed bare reply cannot select it.
    if(!choice.reference&&delivered[1])throw new Error('More than one shortlist has arrived. Reply with the code shown on the latest shortlist.');
    if(choice.reference){
      const collisions=this.store.db.prepare(`SELECT COUNT(DISTINCT mission_id) n FROM errand_shortlist_messages WHERE owner=? AND destination=? AND lower(substr(replace(mission_id,'-',''),1,8))=?`).get(scope.owner,scope.destination,choice.reference) as {n:number};
      if(choice.reference!==shortlistReference(id)||collisions.n!==1)throw new Error('That shortlist code is unavailable. Use the code on the latest shortlist.');
    }
    // inbox.received_at is assigned after routing, so it is not ingress proof.
    // Without a bridge-owned ordering adapter, every draft fails closed.
    if(!this.orderedAfter(scope,latest.id))throw new Error('Cannot verify that this request followed the delivered shortlist.');
    const row=this.store.db.prepare('SELECT * FROM errand_candidates WHERE mission_id=? AND position=?').get(id,number) as Candidate|undefined;
    if(!row||!this.fresh(row))throw new Error('That listing is unavailable or stale. Start a new errand with a new owner request.');
    const contract=JSON.parse(mission.contract_json) as ErrandContract;
    let result:{title:string;url:string;text:string};
    this.store.db.exec('SAVEPOINT errand_draft');
    try{
      this.mission(id,scope);const existing=this.store.db.prepare('SELECT mission_id,candidate_id,owner,destination,draft_json,candidate_hash,profile_revision FROM errand_draft_claims WHERE request_id=?').get(scope.requestId) as {mission_id:string;candidate_id:string;owner:string;destination:string;draft_json:string|null;candidate_hash:string|null;profile_revision:string|null}|undefined;
      if(existing){
        if(existing.mission_id!==id||existing.candidate_id!==row.id||existing.owner!==scope.owner||existing.destination!==scope.destination||!existing.draft_json||existing.candidate_hash!==candidateDigest(row))throw new Error('That draft request was already used or the listing changed.');
        if(existing.profile_revision){const current=this.readProfile(scope,contract);if(!current||current.revision!==existing.profile_revision)throw new Error('The About-you profile changed. Start a new draft.');this.mission(id,scope);}
        const saved=JSON.parse(existing.draft_json) as {title:string;url:string;text:string};
        if(!saved||saved.title!==row.title||saved.url!==row.url||typeof saved.text!=='string'||!saved.text||saved.text.length>10000)throw new Error('The saved draft is unavailable.');
        this.store.db.exec('RELEASE errand_draft');return saved;
      }
      // Capture once; later checks compare the trusted revision but never
      // substitute new profile text into an already queued draft.
      const profile=this.readProfile(scope,contract);
      const notes=profile===undefined?[]:selectErrandProfileNotes(profile.text,contract);
      this.mission(id,scope);if(!this.fresh(row))throw new Error('That listing is unavailable or stale.');
      const context=[row.listing_employer?`Listing employer (source metadata; unverified): ${row.listing_employer}`:'',row.listing_location?`Listing location (source metadata; eligibility unverified): ${row.listing_location}`:''].filter(Boolean).join('\n');
      const interest=row.listing_employer?'this role and the named employer':'this role';
      const profileNotes=notes.length?`About-you notes captured ${new Date(this.now()).toISOString()} (owner-provided; review accuracy and relevance):\n\`\`\`\n${notes.join('\n')}\n\`\`\``:profile?'No matching About-you notes were added.':'About-you was unavailable; no notes were added.';
      result={title:row.title,url:row.url,text:`${context?context+'\n\n':''}Cover letter starter — complete the brackets before using:\n\nHello [hiring team],\n\nI am interested in the ${row.title} opportunity.\n\n[Choose one responsibility from the listing and describe a relevant project or contribution using facts you can verify.]\n\n[Explain what interests you about ${interest}.]\n\nI would welcome the opportunity to discuss the position.\n\nThank you.\n\n${profileNotes}\n\nResume prompts:\n- Choose a responsibility from this listing and describe your own relevant contribution.\n- Add a result you can verify, or leave it out.\n\nApplication answer starters — complete these yourself:\n- Why this role? [Your reason.]\n- Relevant work: [A verified example.]\n- Availability or compensation, if asked: [Your own details.]`};
      this.store.db.prepare('INSERT INTO errand_draft_claims(request_id,mission_id,candidate_id,owner,destination,draft_json,candidate_hash,profile_revision) VALUES(?,?,?,?,?,?,?,?)').run(scope.requestId,id,row.id,scope.owner,scope.destination,JSON.stringify(result),candidateDigest(row),notes.length?profile!.revision:null);this.store.db.exec('RELEASE errand_draft');
    }catch(e){this.store.db.exec('ROLLBACK TO errand_draft; RELEASE errand_draft');throw e;}
    // No invented experience, name or recipient. This is a local draft only.
    return result;
  }
  cancel(id:string,scope:ErrandScope) {this.mission(id,scope);this.store.db.prepare("UPDATE errand_missions SET state='cancelled',version=version+1 WHERE id=?").run(id);}
}
