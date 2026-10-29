import {createHash,randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {hash,type Binding,type Store} from './store.js';

/**
 * Internal F6 foundation. This module is not connected to a route, browser,
 * session or delivery API. Only bridge-owned, independently reviewed adapters
 * may authorize a contract or supply listing evidence; session or model text
 * must never be used as an evidence adapter.
 */
export type ErrandContract={role:string;location:string;salary?:string;avoid?:string};
export type ErrandScope={requestId:string;owner:string;destination:string;bindingId:string;bindingIdentity:string};
/** The marker is meaningful only when issued by a trusted bridge-owned verifier. */
export type Listing={sourceUrl:string;url:string;title:string;excerpt:string;observedAt:number;sourceHash:string;verification:'public-listing-verified'};
export type VerifiedListingReader=(scope:ErrandScope,request:unknown,signal:AbortSignal)=>Promise<Listing[]>;
export type RankInput={id:string;title:string;excerpt:string;role:string;location:string;salary?:string;avoid?:string};
export type ErrandRanker=(input:RankInput[],signal:AbortSignal)=>Promise<string[]>;
export type ContractAuthority=(scope:ErrandScope,contract:ErrandContract,rootRequest:string)=>boolean;
type Mission={id:string;root_request:string;owner:string;destination:string;binding_id:string;binding_identity:string;contract_json:string;contract_hash:string;state:string;version:number;created_at:number};
type Candidate={id:string;mission_id:string;source_url:string;url:string;title:string;excerpt:string;observed_at:number;source_hash:string;position:number|null};
const MAX_CANDIDATES=40,MAX_TITLE=160,MAX_EXCERPT=600,MAX_AGE=24*60*60*1000;
// Defense in depth only; a trusted source must still exclude private content.
const SENSITIVE=/\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{16,}|xox[baprs]-[a-z0-9-]{12,}|AKIA[A-Z0-9]{16}|bearer\s+[^\s]{8,}|(?:api[ _-]?key|password)\s*[:=]\s*[^\s]{8,})/i;
const clean=(s:string,n:number)=>s.replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,n);
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

/** No secret-bearing or local URLs may leave this foundation in a shortlist. */
export function publicListingUrl(value:string):string {
  if(typeof value!=='string'||value.length>2048)throw new Error('Invalid public listing URL.');
  let u:URL;try{u=new URL(value);}catch{throw new Error('Invalid public listing URL.');}
  const host=u.hostname.toLowerCase().replace(/\.$/,'');
  if(u.protocol!=='https:'||u.username||u.password||!host||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||!host.includes('.')||isIP(host.replace(/^\[|\]$/g,'')))throw new Error('Only public HTTPS listing URLs are supported.');
  for(const key of u.searchParams.keys())if(/(?:token|secret|password|auth|session|signature|credential|api[-_]?key|code|email)/i.test(key))throw new Error('A listing URL contains private parameters.');
  u.hash='';return u.href;
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

/** Internal ledger only. No search, browser navigation, message or submission is performed here. */
export class ErrandMissions {
  constructor(private store:Store,private approved:ContractAuthority,private readListings:VerifiedListingReader,private rank:ErrandRanker,private now=()=>Date.now()) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS errand_missions(
      id TEXT PRIMARY KEY,root_request TEXT UNIQUE NOT NULL,owner TEXT NOT NULL,destination TEXT NOT NULL,
      binding_id TEXT NOT NULL,binding_identity TEXT NOT NULL,contract_json TEXT NOT NULL,contract_hash TEXT NOT NULL,
      state TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS errand_candidates(
      id TEXT PRIMARY KEY,mission_id TEXT NOT NULL REFERENCES errand_missions(id),source_url TEXT NOT NULL,url TEXT NOT NULL,
      title TEXT NOT NULL,excerpt TEXT NOT NULL,observed_at INTEGER NOT NULL,source_hash TEXT NOT NULL,position INTEGER,
      UNIQUE(mission_id,url));`);
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
  begin(scope:ErrandScope,input:ErrandContract) {
    const contract=canonicalContract(input),json=JSON.stringify(contract);
    if(!this.active(scope)||!this.approved(scope,contract,scope.requestId))throw new Error('An approved owner request and exact session are required.');
    const existing=this.store.db.prepare('SELECT * FROM errand_missions WHERE root_request=?').get(scope.requestId) as Mission|undefined;
    if(existing){if(existing.owner!==scope.owner||existing.destination!==scope.destination||existing.binding_id!==scope.bindingId||existing.binding_identity!==scope.bindingIdentity||existing.contract_hash!==digest(json)||existing.state==='cancelled')throw new Error('This request already belongs to a different or cancelled errand.');return existing.id;}
    const id=randomUUID();this.store.db.prepare('INSERT INTO errand_missions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,scope.requestId,scope.owner,scope.destination,scope.bindingId,scope.bindingIdentity,json,digest(json),'searching',1,this.now());return id;
  }
  /** `readListings` must verify public pages independently and bind every result to this exact request. */
  async gather(id:string,scope:ErrandScope,query:unknown,signal:AbortSignal) {
    const before=this.mission(id,scope),result=await bounded(signal,s=>this.readListings(scope,query,s));
    if(signal.aborted)throw new Error('Search cancelled.');
    const current=this.mission(id,scope);if(current.version!==before.version||current.state!=='searching')throw new Error('The errand changed while searching.');
    if(!Array.isArray(result)||result.length>MAX_CANDIDATES)throw new Error('Invalid listing evidence.');
    const unique=new Map<string,Listing>();
    for(const raw of result){
      if(!raw||raw.verification!=='public-listing-verified'||typeof raw.title!=='string'||typeof raw.excerpt!=='string'||!Number.isSafeInteger(raw.observedAt)||raw.observedAt>this.now()+5000||raw.observedAt<this.now()-MAX_AGE||!/^[a-f0-9]{64}$/.test(raw.sourceHash))throw new Error('Invalid or stale listing evidence.');
      const title=clean(raw.title,MAX_TITLE+1),excerpt=clean(raw.excerpt,MAX_EXCERPT+1),url=publicListingUrl(raw.url),sourceUrl=publicListingUrl(raw.sourceUrl);
      if(!title||title.length>MAX_TITLE||!excerpt||excerpt.length>MAX_EXCERPT||unique.has(url)||SENSITIVE.test(title+' '+excerpt))throw new Error('Listing evidence is empty, oversized, private or duplicated.');
      unique.set(url,{...raw,title,excerpt,url,sourceUrl});
    }
    this.store.db.exec('SAVEPOINT errand_gather');
    try{
      this.mission(id,scope);if((this.store.db.prepare('SELECT version FROM errand_missions WHERE id=?').get(id) as {version:number}).version!==before.version)throw new Error('The errand changed while searching.');
      this.store.db.prepare('DELETE FROM errand_candidates WHERE mission_id=?').run(id);
      const insert=this.store.db.prepare('INSERT INTO errand_candidates VALUES(?,?,?,?,?,?,?,?,NULL)');
      for(const l of unique.values())insert.run(randomUUID(),id,l.sourceUrl,l.url,l.title,l.excerpt,l.observedAt,l.sourceHash);
      this.store.db.prepare("UPDATE errand_missions SET state='gathered',version=version+1 WHERE id=?").run(id);
      this.store.db.exec('RELEASE errand_gather');return unique.size;
    }catch(e){this.store.db.exec('ROLLBACK TO errand_gather; RELEASE errand_gather');throw e;}
  }
  async shortlist(id:string,scope:ErrandScope,signal:AbortSignal) {
    const before=this.mission(id,scope);if(before.state!=='gathered')throw new Error('Find verified listings first.');
    const contract=JSON.parse(before.contract_json) as ErrandContract;
    const rows=this.store.db.prepare('SELECT * FROM errand_candidates WHERE mission_id=? ORDER BY id').all(id) as Candidate[];
    if(!rows.length)return [];
    if(rows.some(r=>r.observed_at<this.now()-MAX_AGE||r.observed_at>this.now()+5000))throw new Error('Listing evidence is stale. Search again.');
    const proposed=await bounded(signal,s=>this.rank(rows.map(r=>({id:r.id,title:r.title,excerpt:r.excerpt,role:contract.role,location:contract.location,salary:contract.salary,avoid:contract.avoid})),s));
    if(signal.aborted)throw new Error('Ranking cancelled.');
    const current=this.mission(id,scope);if(current.version!==before.version||current.state!=='gathered')throw new Error('The errand changed while ranking.');
    if(!Array.isArray(proposed)||proposed.length>MAX_CANDIDATES||proposed.some(x=>typeof x!=='string')||new Set(proposed).size!==proposed.length||proposed.some(x=>!rows.some(r=>r.id===x)))throw new Error('Ranking did not match the verified listings.');
    const chosen=proposed.slice(0,5).map(candidateId=>rows.find(r=>r.id===candidateId)!);
    if(!chosen.length)throw new Error('No verified listing was selected.');
    this.store.db.exec('SAVEPOINT errand_rank');
    try{
      this.mission(id,scope);const latest=this.store.db.prepare('SELECT version,state FROM errand_missions WHERE id=?').get(id) as {version:number;state:string};
      if(latest.version!==before.version||latest.state!=='gathered')throw new Error('The errand changed while ranking.');
      for(let i=0;i<chosen.length;i++)this.store.db.prepare('UPDATE errand_candidates SET position=? WHERE id=? AND mission_id=?').run(i+1,chosen[i].id,id);
      this.store.db.prepare("UPDATE errand_missions SET state='shortlisted',version=version+1 WHERE id=?").run(id);this.store.db.exec('RELEASE errand_rank');
    }catch(e){this.store.db.exec('ROLLBACK TO errand_rank; RELEASE errand_rank');throw e;}
    return chosen.map((r,i)=>({number:i+1,title:r.title,url:r.url,sourceUrl:r.source_url,observedAt:r.observed_at,reason:this.reason(r,contract)}));
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
    if(!rows.length||rows.some(r=>r.observed_at<this.now()-MAX_AGE||r.observed_at>this.now()+5000))throw new Error('That shortlist is stale. Search again.');
    const contract=JSON.parse(mission.contract_json) as ErrandContract;
    return rows.map(r=>({number:r.position!,title:r.title,url:r.url,sourceUrl:r.source_url,observedAt:r.observed_at,reason:this.reason(r,contract)}));
  }
  /** Select only from the stored exact snapshot, using a new authenticated owner request. */
  draft(id:string,scope:ErrandScope,number:number) {
    const mission=this.mission(id,scope);if(mission.state!=='shortlisted'||!Number.isInteger(number)||number<1||number>5)throw new Error('Choose a number from the current shortlist.');
    const row=this.store.db.prepare('SELECT * FROM errand_candidates WHERE mission_id=? AND position=?').get(id,number) as Candidate|undefined;
    if(!row||row.observed_at<this.now()-MAX_AGE||row.observed_at>this.now()+5000)throw new Error('That listing is unavailable or stale. Search again.');
    const contract=JSON.parse(mission.contract_json) as ErrandContract;
    // No invented experience, name or recipient. This is a local draft only.
    return {title:row.title,url:row.url,text:`Hello,\n\nI am interested in the ${row.title} opportunity. I am looking for a ${contract.role} role in ${contract.location}.\n\nI would welcome the opportunity to discuss the position and how my experience fits your needs.\n\nThank you.`};
  }
  cancel(id:string,scope:ErrandScope) {this.mission(id,scope);this.store.db.prepare("UPDATE errand_missions SET state='cancelled',version=version+1 WHERE id=?").run(id);}
}
