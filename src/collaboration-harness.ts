import { randomUUID } from 'node:crypto';
import { hash, type Binding, type Store } from './store.js';
import {hasUnresolvedProviderSetup} from './provider-setup-barrier.js';

/** A scope resolved from an owner-approved contract by trusted bridge code. */
export type CollaborationScope = {
  owner: string;
  destination: string;
  rootRequestId: string;
  itemId: number;
  contractId: string;
  revision: number;
  approvedHash: string;
};

/** These synchronous adapters are a trust boundary, not an API for an agent.
 * They must read current authorization from the supplied Store's SQLite
 * connection. The feature is not wired until F3 provides those adapters. */
export type CollaborationAuthority = {
  approved(rootRequestId:string,itemId:number):CollaborationScope|undefined;
  mayWork(scope:CollaborationScope,binding:Binding):boolean;
  /** Optional trusted lifecycle adapter. Never accept IDs from an agent here. */
  ignoreLive?(scope:CollaborationScope,job:{id:string;binding_id:string;status:string}):boolean;
  observedFinished?(scope:CollaborationScope,binding:Binding):boolean;
};

type ClaimRow = {
  item_id:number; owner:string; destination:string; root_request_id:string;
  contract_id:string; contract_revision:number; approved_hash:string;
  owner_generation:string|null;
  generation:number; holder_id:string|null; holder_identity:string|null;
  token:string|null; lease_until:number|null;
};
type EventRow = {event_id:string;kind:string;fingerprint:string;generation:number;token:string|null};
export type Claim = {itemId:number;bindingId:string;generation:number;token:string;leaseUntil:number};
export type HandoffEvent = {
  eventId:string;itemId:number;at:number;kind:'claimed'|'renewed'|'released'|'handoff';
  fromBindingId:string|null;toBindingId:string|null;summary:string|null;
  contractId:string;revision:number;approvedHash:string;drift:'not_checked';
};

const MAX_LEASE=15*60_000;
const allowedEventId=/^[A-Za-z0-9._:-]{1,160}$/;
const fingerprint=(parts:unknown[])=>hash(JSON.stringify(parts));

/** Internal, bridge-owned claim and handoff ledger. Not a dispatch guard. */
export class CollaborationHarness {
  constructor(private store:Store,private authority:CollaborationAuthority,private clock:()=>number=Date.now) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS collaboration_claims(
      item_id INTEGER PRIMARY KEY,owner TEXT NOT NULL,destination TEXT NOT NULL,root_request_id TEXT NOT NULL,
      contract_id TEXT NOT NULL,contract_revision INTEGER NOT NULL,approved_hash TEXT NOT NULL,
      generation INTEGER NOT NULL,holder_id TEXT,holder_identity TEXT,token TEXT,lease_until INTEGER,owner_generation TEXT);
      CREATE TABLE IF NOT EXISTS collaboration_events(
      event_id TEXT PRIMARY KEY,item_id INTEGER NOT NULL,owner TEXT NOT NULL,destination TEXT NOT NULL,
      contract_id TEXT NOT NULL,contract_revision INTEGER NOT NULL,approved_hash TEXT NOT NULL,
      kind TEXT NOT NULL,fingerprint TEXT NOT NULL,generation INTEGER NOT NULL,token TEXT,
      from_binding_id TEXT,to_binding_id TEXT,summary TEXT,at INTEGER NOT NULL,owner_generation TEXT);
      CREATE INDEX IF NOT EXISTS collaboration_events_item ON collaboration_events(item_id,at,event_id);`);
    for(const table of ['collaboration_claims','collaboration_events'])
      if(!store.db.prepare(`PRAGMA table_info(${table})`).all().some((c:any)=>c.name==='owner_generation'))
        store.db.exec(`ALTER TABLE ${table} ADD COLUMN owner_generation TEXT`);
  }
  private transaction<T>(f:()=>T):T {
    this.store.db.exec('SAVEPOINT collaboration');
    try{const value=f();this.store.db.exec('RELEASE collaboration');return value;}
    catch(e){this.store.db.exec('ROLLBACK TO collaboration; RELEASE collaboration');throw e;}
  }
  private scope(root:string,itemId:number):CollaborationScope & {ownerGeneration:string} {
    this.store.assertIncomingOwner();
    if(!root||!Number.isSafeInteger(itemId)||itemId<1)throw new Error('A scoped owner request and item are required.');
    const s=this.authority.approved(root,itemId);
    if(!s||s.rootRequestId!==root||s.itemId!==itemId||!s.owner||!s.destination||!s.contractId||
      !Number.isSafeInteger(s.revision)||s.revision<1||!/^[a-f0-9]{64}$/i.test(s.approvedHash))throw new Error('The approved contract is unavailable.');
    const job=this.store.job(root);
    if(!job||job.destination!==s.destination||this.store.ownerFor(s.destination)!==s.owner||
      this.store.controlChannel()!==(s.destination.startsWith('tg:')?'telegram':'whatsapp')||this.store.itemOf(root)!==itemId||
      !this.store.db.prepare('SELECT 1 FROM item_owner_origins WHERE item_id=? AND owner=? AND destination=?').get(itemId,s.owner,s.destination)||
      (s.destination!==s.owner&&(!s.destination.endsWith('@g.us')||this.store.get('destination-jid')!==s.destination||!this.store.get(`owned-group:${s.destination}`))))throw new Error('The owner, chat or item changed.');
    return {...s,ownerGeneration:this.store.get('incoming-owner-generation')??''};
  }
  private binding(scope:CollaborationScope,id:string):Binding {
    const b=this.store.binding(id);
    // Never resolve aliases at this trust boundary; handoffs must name the exact session ID.
    if(!b||b.id!==id||!b.enabled||!this.authority.mayWork(scope,b))throw new Error('The exact session is unavailable or not authorized.');
    return b;
  }
  private bindingIdentity(b:Binding) {
    return fingerprint([b.id,b.provider,b.native_id,b.cwd,b.mode,b.token_hash,
      this.store.get(`execution-mode:${b.id}`)??null,this.store.get(`session-route:${b.id}`)??null]);
  }
  private row(itemId:number){return this.store.db.prepare('SELECT * FROM collaboration_claims WHERE item_id=?').get(itemId) as ClaimRow|undefined;}
  private requireClaimable(itemId:number) {
    const item=this.store.db.prepare('SELECT status FROM items WHERE id=?').get(itemId) as {status:string}|undefined;
    if(!item||!['not started','in progress'].includes(item.status))throw new Error('The item is not available to claim.');
  }
  private sameScope(r:ClaimRow,s:CollaborationScope & {ownerGeneration:string}) {
    return r.owner===s.owner&&r.destination===s.destination&&r.root_request_id===s.rootRequestId&&
      r.contract_id===s.contractId&&r.contract_revision===s.revision&&r.approved_hash===s.approvedHash&&r.owner_generation===s.ownerGeneration;
  }
  private event(id:string,kind:string,fp:string) {
    if(!allowedEventId.test(id))throw new Error('A stable event ID is required.');
    const row=this.store.db.prepare('SELECT event_id,kind,fingerprint,generation,token FROM collaboration_events WHERE event_id=?').get(id) as EventRow|undefined;
    if(row&&(row.kind!==kind||row.fingerprint!==fp))throw new Error('An event ID cannot be reused for different content.');
    return row;
  }
  private record(id:string,s:CollaborationScope & {ownerGeneration:string},kind:HandoffEvent['kind'],fp:string,generation:number,token:string|null,from:string|null,to:string|null,summary:string|null,now:number) {
    this.store.db.prepare('INSERT INTO collaboration_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,s.itemId,s.owner,s.destination,s.contractId,s.revision,s.approvedHash,kind,fp,generation,token,from,to,summary,now,s.ownerGeneration);
  }
  /** Any linked queued/running/uncertain job prevents a second claimant.
   * Use itemOf rather than only direct links so parent/report chains count. */
  private hasLiveWork(scope:CollaborationScope) {
    // A final reply can mark the inbox job completed while its managed turn is
    // still running. The managed fence, not inbox status, decides liveness.
    const managed=this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_collaboration_handoffs'").get();
    if(managed&&this.store.db.prepare("SELECT 1 FROM managed_collaboration_handoffs WHERE item_id=? AND state='claimed' AND COALESCE(finished,0)<>1 LIMIT 1").get(scope.itemId))return true;
    const jobs=this.store.db.prepare("SELECT id,binding_id,status FROM inbox WHERE status IN ('queued','dispatched','submitted','uncertain') OR attempt_id IS NOT NULL").all() as {id:string;binding_id:string;status:string}[];
    return jobs.some(j=>this.store.itemsInAncestry(j.id).includes(scope.itemId)&&!this.authority.ignoreLive?.(scope,j));
  }
  private hasLiveSession(scope:CollaborationScope,bindingId:string) {
    const jobs=this.store.db.prepare("SELECT id,binding_id,status FROM inbox WHERE binding_id=? AND (status IN ('dispatched','submitted','uncertain') OR attempt_id IS NOT NULL)").all(bindingId) as {id:string;binding_id:string;status:string}[];
    return jobs.some(j=>!this.authority.ignoreLive?.(scope,j));
  }
  private current(s:CollaborationScope & {ownerGeneration:string},token:string,allowExpired=false) {
    const r=this.row(s.itemId);
    if(!r||!this.sameScope(r,s)||!r.holder_id||!r.token||r.token!==token)throw new Error('The claim is unavailable or changed.');
    if(!allowExpired&&(!r.lease_until||r.lease_until<=this.clock()))throw new Error('The claim expired.');
    const b=this.binding(s,r.holder_id);
    if(this.bindingIdentity(b)!==r.holder_identity)throw new Error('The claimed session changed.');
    return {r,b};
  }
  /** Recheck a fenced claim at an internal pre-submission boundary. */
  assertClaim(root:string,itemId:number,bindingId:string,token:string,generation:number):void {
    this.transaction(()=>{const s=this.scope(root,itemId);this.requireClaimable(itemId);const {r,b}=this.current(s,token);if(b.id!==bindingId||r.generation!==generation)throw new Error('The claim or session changed.');});
  }
  /** Explicitly claim an idle item. An expired lease never steals active work. */
  claim(root:string,itemId:number,bindingId:string,eventId:string):Claim {
    return this.transaction(()=>{
      const s=this.scope(root,itemId),b=this.binding(s,bindingId),now=this.clock(),identity=this.bindingIdentity(b);
      if(hasUnresolvedProviderSetup(this.store))throw new Error('Provider setup or recovery is unresolved.');
      this.requireClaimable(itemId);
      const fp=fingerprint([root,itemId,bindingId,s.owner,s.destination,s.contractId,s.revision,s.approvedHash,s.ownerGeneration]);
      const prior=this.event(eventId,'claimed',fp),r=this.row(itemId);
      if(prior){
        if(!r||!this.sameScope(r,s)||r.generation!==prior.generation||r.token!==prior.token||r.holder_id!==b.id||r.holder_identity!==identity||!r.lease_until||r.lease_until<=now)throw new Error('The earlier claim is no longer active.');
        return {itemId,bindingId:b.id,generation:r.generation,token:r.token!,leaseUntil:r.lease_until};
      }
      if(r&&(r.owner!==s.owner||r.destination!==s.destination))throw new Error('The item belongs to another owner or chat.');
      if(r&&r.owner_generation!==s.ownerGeneration)throw new Error('The owner connection changed.');
      if(r?.holder_id&&r.lease_until!==null&&r.lease_until>now)throw new Error('The item is already claimed.');
      if(this.hasLiveWork(s)||this.hasLiveSession(s,b.id))throw new Error('The item or session has active or uncertain work.');
      const generation=(r?.generation??0)+1,token=randomUUID(),leaseUntil=now+MAX_LEASE;
      if(r)this.store.db.prepare(`UPDATE collaboration_claims SET root_request_id=?,contract_id=?,contract_revision=?,approved_hash=?,
        generation=?,holder_id=?,holder_identity=?,token=?,lease_until=? WHERE item_id=?`).run(root,s.contractId,s.revision,s.approvedHash,generation,b.id,identity,token,leaseUntil,itemId);
      else this.store.db.prepare('INSERT INTO collaboration_claims VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(itemId,s.owner,s.destination,root,s.contractId,s.revision,s.approvedHash,generation,b.id,identity,token,leaseUntil,s.ownerGeneration);
      this.record(eventId,s,'claimed',fp,generation,token,null,b.id,null,now);
      return {itemId,bindingId:b.id,generation,token,leaseUntil};
    });
  }
  /** Renew only the exact fenced claim, even after expiry if it has not changed. */
  renew(root:string,itemId:number,token:string,eventId:string):Claim {
    return this.transaction(()=>{
      const s=this.scope(root,itemId),{r,b}=this.current(s,token,true),now=this.clock();
      if((!r.lease_until||r.lease_until<=now)&&!this.hasLiveWork(s)&&!this.hasLiveSession(s,b.id))throw new Error('The claim expired.');
      const fp=fingerprint([root,itemId,token,s.contractId,s.revision,s.approvedHash,s.ownerGeneration]);
      const prior=this.event(eventId,'renewed',fp);
      if(prior){if(prior.generation!==r.generation||!r.lease_until||r.lease_until<=now)throw new Error('The earlier renewal is no longer active.');return {itemId,bindingId:b.id,generation:r.generation,token,leaseUntil:r.lease_until};}
      const leaseUntil=now+MAX_LEASE;
      this.store.db.prepare('UPDATE collaboration_claims SET lease_until=? WHERE item_id=? AND generation=? AND token=?').run(leaseUntil,itemId,r.generation,token);
      this.record(eventId,s,'renewed',fp,r.generation,token,b.id,b.id,null,now);
      return {itemId,bindingId:b.id,generation:r.generation,token,leaseUntil};
    });
  }
  /** Explicit release never cancels or interrupts a queued or active turn. */
  release(root:string,itemId:number,token:string,eventId:string):void {
    this.transaction(()=>{
      const s=this.scope(root,itemId),fp=fingerprint([root,itemId,token,s.contractId,s.revision,s.approvedHash,s.ownerGeneration]);
      if(this.event(eventId,'released',fp))return;
      const {r,b}=this.current(s,token);if(this.hasLiveWork(s)||this.hasLiveSession(s,b.id))throw new Error('The item or session has active or uncertain work.');
      this.store.db.prepare('UPDATE collaboration_claims SET holder_id=NULL,holder_identity=NULL,token=NULL,lease_until=NULL WHERE item_id=? AND generation=? AND token=?').run(itemId,r.generation,token);
      this.record(eventId,s,'released',fp,r.generation,null,b.id,null,null,this.clock());
    });
  }
  /** Bridge-only: release after a trusted provider completion was observed.
   * An expired token is allowed only if it still fences the same claim and no
   * other linked work is active. This does not prove the work was correct. */
  releaseObserved(root:string,itemId:number,token:string,eventId:string):void {
    this.transaction(()=>{
      const s=this.scope(root,itemId),fp=fingerprint([root,itemId,token,s.contractId,s.revision,s.approvedHash,s.ownerGeneration]);
      if(this.event(eventId,'released',fp))return;
      const {r,b}=this.current(s,token,true);if(!this.authority.observedFinished?.(s,b))throw new Error('A trusted session completion is required.');
      if(this.hasLiveWork(s)||this.hasLiveSession(s,b.id))throw new Error('The item or session has active or uncertain work.');
      this.store.db.prepare('UPDATE collaboration_claims SET holder_id=NULL,holder_identity=NULL,token=NULL,lease_until=NULL WHERE item_id=? AND generation=? AND token=?').run(itemId,r.generation,token);
      this.record(eventId,s,'released',fp,r.generation,null,b.id,null,null,this.clock());
    });
  }
  /** Record a handoff but do not automatically claim, dispatch or judge drift. */
  handoff(root:string,itemId:number,token:string,toBindingId:string,summary:string,eventId:string):void {
    this.transaction(()=>{
      const s=this.scope(root,itemId),to=this.binding(s,toBindingId),text=summary.trim();
      if(!text||text.length>1000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))throw new Error('A short handoff summary is required.');
      const fp=fingerprint([root,itemId,token,toBindingId,text,s.contractId,s.revision,s.approvedHash,s.ownerGeneration]);
      if(this.event(eventId,'handoff',fp))return;
      this.requireClaimable(itemId);
      const {r,b}=this.current(s,token);if(to.id===b.id)throw new Error('Choose a different session for the handoff.');
      if(this.hasLiveWork(s)||this.hasLiveSession(s,b.id))throw new Error('The item or session has active or uncertain work.');
      this.store.db.prepare('UPDATE collaboration_claims SET holder_id=NULL,holder_identity=NULL,token=NULL,lease_until=NULL WHERE item_id=? AND generation=? AND token=?').run(itemId,r.generation,token);
      this.record(eventId,s,'handoff',fp,r.generation,null,b.id,to.id,text,this.clock());
    });
  }
  /** History is visible only after the current owner/contract is rechecked. */
  history(root:string,itemId:number):HandoffEvent[] {
    const s=this.scope(root,itemId),r=this.row(itemId);if(!r||!this.sameScope(r,s))return [];
    const rows=this.store.db.prepare(`SELECT event_id,item_id,at,kind,from_binding_id,to_binding_id,summary,contract_id,contract_revision,approved_hash
      FROM collaboration_events WHERE item_id=? AND owner=? AND destination=? AND contract_id=? AND contract_revision=? AND approved_hash=? AND owner_generation=? ORDER BY rowid`).all(itemId,s.owner,s.destination,s.contractId,s.revision,s.approvedHash,s.ownerGeneration) as any[];
    return rows.map(v=>({eventId:v.event_id,itemId:v.item_id,at:v.at,kind:v.kind,fromBindingId:v.from_binding_id,toBindingId:v.to_binding_id,summary:v.summary,contractId:v.contract_id,revision:v.contract_revision,approvedHash:v.approved_hash,drift:'not_checked'}));
  }
}
