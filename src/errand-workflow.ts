import {authenticatedOwner} from './owner-commands.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {ErrandMissions,canonicalSkills,errandBindingIdentity,type ErrandContract,type ErrandRanker,type ErrandScope,type VerifiedListingReader} from './errand-missions.js';
import {greenhouseBoardReader} from './errand-greenhouse.js';
import {wonderErrandRanker} from './errand-ranker.js';
import {ErrandOrder} from './errand-order.js';
import {hash,type Binding} from './store.js';
import {toWhatsApp} from './whatsapp-format.js';
import type {Incoming,Router} from './router.js';

type Request={board:string;contract:ErrandContract};
type Guard={outbox_id:string;mission_id:string;root_request:string;request_id:string;owner:string;destination:string;binding_id:string;binding_identity:string;kind:string;body_hash:string;authority_generation:string};

/** Exact, owner-authored criteria only. No free text is interpreted as authority. */
export function parseGreenhouseRequest(text:string):Request|undefined {
  if(!/^greenhouse jobs\s*;/i.test(text.trim()))return;
  const parts=text.trim().split(';').map(x=>x.trim());parts.shift();const values:Record<string,string>=Object.create(null);
  for(const part of parts){const m=/^(board|role|location|salary|avoid|skills)\s*=\s*(.+)$/i.exec(part);if(!m||values[m[1].toLowerCase()])throw new Error('Use greenhouse jobs; board=NAME; role=TITLE; location=PLACE, with optional salary=, avoid= and skills=.');values[m[1].toLowerCase()]=m[2].trim();}
  if(!/^[a-z0-9][a-z0-9_-]{0,49}$/.test(values.board??'')||!values.role||!values.location||Object.values(values).some(v=>v.length>120||/[\r\n\x00-\x1f]/.test(v)))throw new Error('Provide a board, role and location in the Greenhouse request.');
  return {board:values.board,contract:{role:values.role,location:values.location,...(values.salary?{salary:values.salary}:{}),...(values.avoid?{avoid:values.avoid}:{}),...(values.skills?{skills:canonicalSkills(values.skills.split(','))}:{})}};
}

/** Owner-scoped local orchestration. No application submission or contact exists. */
export class ErrandWorkflow {
  readonly order:ErrandOrder;
  readonly ledger:ErrandMissions;
  private rankScope=new AsyncLocalStorage<{scope:ErrandScope;mission:string}>();
  private activeSearch=new Map<string,{scope:ErrandScope;controller:AbortController}>();
  isActive(id:string){return this.activeSearch.has(id);}
  hasActiveSearch(){return this.activeSearch.size>0;}
  pause(){for(const entry of this.activeSearch.values())entry.controller.abort();}
  /** Explicit transport disconnection revokes existing work, including after reconnect. */
  invalidateAuthority(){this.router.store.set('errand-authority-generation',randomUUID());this.pause();}
  constructor(readonly router:Router,reader?:VerifiedListingReader,ranker?:ErrandRanker,fetcher:typeof fetch=fetch){
    const store=router.store;this.order=new ErrandOrder(store);
    store.db.exec(`CREATE TABLE IF NOT EXISTS errand_outbox_guards(
      outbox_id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,root_request TEXT NOT NULL,request_id TEXT NOT NULL,
      owner TEXT NOT NULL,destination TEXT NOT NULL,binding_id TEXT NOT NULL,binding_identity TEXT NOT NULL,kind TEXT NOT NULL,body_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS errand_notice_guards(outbox_id TEXT PRIMARY KEY,owner TEXT NOT NULL,destination TEXT NOT NULL,body_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS errand_search_guards(root_request TEXT PRIMARY KEY,authority_generation TEXT NOT NULL);`);
    for(const table of ['errand_outbox_guards','errand_notice_guards'])if(!store.db.prepare(`PRAGMA table_info(${table})`).all().some((column:any)=>column.name==='authority_generation'))store.db.exec(`ALTER TABLE ${table} ADD COLUMN authority_generation TEXT NOT NULL DEFAULT ''`);
    const current=(scope:ErrandScope)=>{
      try{const row=store.db.prepare('SELECT root_request,contract_json,state FROM errand_missions WHERE root_request=?').get(scope.requestId) as {root_request:string;contract_json:string;state:string}|undefined;
        return !!row&&row.state==='searching'&&store.job(scope.requestId)?.status==='submitted'&&this.authorized(scope,JSON.parse(row.contract_json),row.root_request);
      }catch{return false;}
    };
    const source=reader??greenhouseBoardReader(current);
    const choose:ErrandRanker=ranker??(async(input,signal)=>{
      const context=this.rankScope.getStore();
      const currentRank=()=>{if(!context||signal.aborted)return false;try{
        const row=store.db.prepare('SELECT root_request,contract_json,state FROM errand_missions WHERE id=?').get(context.mission) as {root_request:string;contract_json:string;state:string}|undefined;
        return !!row&&row.state==='gathered'&&store.job(row.root_request)?.status==='submitted'&&this.authorized(context.scope,JSON.parse(row.contract_json),row.root_request);
      }catch{return false;}};
      if(!currentRank())throw new Error('The owner request changed.');
      const key=router.brain.secret.read();if(!key)throw new Error('Add the Meta Brain key before searching.');
      const guarded:typeof fetch=async(url,init)=>{if(!currentRank())throw new Error('The owner request changed.');return fetcher(url,init);};
      return wonderErrandRanker(key,guarded)(input,signal);
    });
    this.ledger=new ErrandMissions(store,(scope,contract,root)=>this.authorized(scope,contract,root),source,choose,()=>Date.now(),(scope,outboxId)=>this.order.after(scope,outboxId));
  }
  private request(root:string):Request|undefined {
    const {store,contracts}=this.router,job=store.job(root);if(!job)return;
    const approved=contracts.approved(root);
    if(approved){
      // Free-form edits may contain extra constraints that this narrow parser
      // cannot safely preserve yet; never silently drop them.
      const edits=JSON.parse(approved.edits) as unknown[];if(!Array.isArray(edits)||edits.length)return;
      return parseGreenhouseRequest(approved.review_text);
    }
    if(contracts.hasGuard(root))return;
    return parseGreenhouseRequest(job.body);
  }
  private authorized(scope:ErrandScope,contract:ErrandContract,root:string) {
    const r=this.router,s=r.store,b=s.binding(scope.bindingId),rootJob=s.job(root);
    if(r.stopped||s.controlChannel()!=='whatsapp'||s.destination()!==scope.destination||s.ownerFor(scope.destination)!==scope.owner||!b?.enabled||!rootJob||!['submitted','completed'].includes(rootJob.status)||rootJob.binding_id!==b.id||rootJob.destination!==scope.destination||errandBindingIdentity(s,b)!==scope.bindingIdentity||s.get(`parent:${root}`)||s.get(`report-parent:${root}`))return false;
    const origin=s.requestOwnerOrigin(root),caller=s.requestOwnerOrigin(scope.requestId);
    if(!origin||!caller||origin.owner!==scope.owner||origin.destination!==scope.destination||caller.owner!==scope.owner||caller.destination!==scope.destination)return false;
    const request=this.request(root);if(!request||JSON.stringify(request.contract)!==JSON.stringify(contract))return false;
    const approved=r.contracts.approved(root);if(approved){try{r.contracts.assertDispatch(r,root,b,rootJob.body);}catch{return false;}}
    return true;
  }
  private binding():Binding {
    const s=this.router.store,d=s.destination(),targetRaw=s.get(`owner-target:${d}`);let target:any;
    try{target=targetRaw?JSON.parse(targetRaw):null;}catch{throw new Error('The selected session changed. Select it again.');}
    const id=target?.kind==='session'?target.id:s.get('active')??s.get('master');if(typeof id!=='string')throw new Error('Select a session before finding jobs.');
    const b=this.router.need(id);
    if(target?.kind==='session'){
      const identity=hash(JSON.stringify([b.id,b.native_id,b.cwd,b.token_hash,s.get(`execution-mode:${b.id}`),s.get(`session-route:${b.id}`),this.router.coordinator?.registry.entry(b.id)]));
      if(target.identity!==identity)throw new Error('The selected session changed. Select it again.');
    }
    return b;
  }
  private scope(requestId:string,b:Binding):ErrandScope {
    const s=this.router.store,d=s.destination(),owner=s.ownerFor(d);if(!d||!owner)throw new Error('The owner chat is unavailable.');
    return {requestId,owner,destination:d,bindingId:b.id,bindingIdentity:errandBindingIdentity(s,b)};
  }
  private queueGuarded(mission:string,root:string,scope:ErrandScope,kind:'shortlist'|'draft',text:string) {
    const s=this.router.store,source=kind==='shortlist'?`errand-shortlist:${mission}`:`errand-draft:${scope.requestId}`;
    const b=s.binding(scope.bindingId);if(!b?.enabled)throw new Error('The errand session is unavailable.');
    s.output(b,text,source,scope.destination,{requestId:scope.requestId,kind:'system',origin:'system',plain:true});
    const rows=s.db.prepare('SELECT id,body FROM outbox WHERE source=? AND destination=?').all(`${source}:0`,scope.destination) as {id:string;body:string}[];
    if(rows.length!==1||rows[0].body!==toWhatsApp(text)||s.db.prepare('SELECT 1 FROM outbox WHERE source=?').get(`${source}:1`))throw new Error('The errand message could not be queued safely.');
    if(kind==='shortlist')this.ledger.bindShortlistMessage(mission,scope,rows[0].id);
    s.db.prepare('INSERT INTO errand_outbox_guards VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(rows[0].id,mission,root,scope.requestId,scope.owner,scope.destination,scope.bindingId,scope.bindingIdentity,kind,hash(rows[0].body),s.get('errand-authority-generation')??'');
  }
  private notice(owner:string,destination:string,generation:string,source:string,text:string){
    const s=this.router.store;
    if((s.get('errand-authority-generation')??'')!==generation||s.controlChannel()!=='whatsapp'||(s.get('destination-jid')??s.get('whatsapp-owner'))!==destination||s.ownerFor(destination)!==owner||(destination!==owner&&!s.get(`owned-group:${destination}`)))return;
    // Never leave an unguarded notice behind if registering its guard fails.
    s.db.exec('SAVEPOINT errand_notice');
    try{
      s.output(undefined,text,source,destination,{plain:true});
      const notice=s.db.prepare('SELECT id,body FROM outbox WHERE source=? AND destination=?').get(`${source}:0`,destination) as {id:string;body:string}|undefined;
      if(!notice||notice.body!==toWhatsApp(text))throw new Error('Errand notice could not be queued.');
      s.db.prepare('INSERT OR IGNORE INTO errand_notice_guards VALUES(?,?,?,?,?)').run(notice.id,owner,destination,hash(notice.body),generation);
      s.db.exec('RELEASE errand_notice');
    }catch(e){s.db.exec('ROLLBACK TO errand_notice; RELEASE errand_notice');throw e;}
  }
  unsupportedInput(m:Incoming){
    return /^greenhouse jobs\s*;/i.test(m.text.trim())&&(this.router.store.controlChannel()!=='whatsapp'||m.ownerCommand!==true||!!m.quotedId);
  }
  async start(m:Incoming) {
    if(!/^greenhouse jobs\s*;/i.test(m.text.trim()))return false;
    const s=this.router.store,d=s.destination(),owner=s.ownerFor(d);
    // Do not interpret forwarded, quoted or transcribed text as an approved
    // search. Explain the supported input instead of silently consuming it.
    if(!d||!owner||!authenticatedOwner(this.router,m))return true;
    if(s.controlChannel()==='telegram'){
      // This fixed, non-sensitive notice uses Telegram's paired-owner
      // destination check in its existing outbound delivery path.
      s.output(undefined,'Job search is available in WhatsApp. Send it there as a new text message.',`errand-channel:${m.id}`,d,{plain:true});
      s.remember(m.id);return true;
    }
    if(m.ownerCommand!==true||m.quotedId){
      try{this.notice(owner,d,s.get('errand-authority-generation')??'',`errand-input:${m.id}`,'Send the job search as a new text message in your WhatsApp owner chat.');}catch{}
      s.remember(m.id);return true;
    }
    const generation=s.get('errand-authority-generation')??'';
    try{return await this.startExact(m);}catch(e){
      const error=e instanceof Error?e.message:'',text=/^(Use greenhouse jobs; board=NAME; role=TITLE; location=PLACE, with optional salary=, avoid= and skills=\.|Provide a board, role and location in the Greenhouse request\.|Provide one to five (?:distinct )?short skills\.|Select a session before finding jobs\.|The selected session changed\. Select it again\.)$/.test(error)?error:'Could not start this job search. Check the session and try again.';
      try{this.notice(owner,d,generation,`errand-start-error:${m.id}`,text);}catch{}
      s.remember(m.id);return true;
    }
  }
  private async startExact(m:Incoming) {
    const r=this.router,s=r.store,request=parseGreenhouseRequest(m.text);if(!request)return false;
    if(!authenticatedOwner(r,m)||m.ownerCommand!==true||m.quotedId||s.controlChannel()!=='whatsapp')throw new Error('Send the Greenhouse request as a new message in your WhatsApp owner chat.');
    const b=this.binding(),scope=this.scope(m.id,b),generation=s.get('errand-authority-generation')??'';let mission:string;
    s.db.exec('SAVEPOINT start_errand');
    try{r.queue(m.id,b,m.text.trim());s.jobState(m.id,'submitted');mission=this.ledger.begin(scope,request.contract);s.db.prepare('INSERT INTO errand_search_guards VALUES(?,?)').run(m.id,generation);s.remember(m.id);s.db.exec('RELEASE start_errand');}
    catch(e){s.db.exec('ROLLBACK TO start_errand; RELEASE start_errand');throw e;}
    const controller=new AbortController();this.activeSearch.set(m.id,{scope,controller});
    try{
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(120000)]);
      await this.ledger.gather(mission,scope,{board:request.board,role:request.contract.role,location:request.contract.location},signal);
      const items=await this.rankScope.run({scope,mission},()=>this.ledger.shortlist(mission,scope,signal));
      if(!items.length)throw new Error('No matching listings.');
      s.db.exec('SAVEPOINT queue_errand_shortlist');
      try{this.queueGuarded(mission,m.id,scope,'shortlist',this.ledger.shortlistText(mission,scope));s.db.exec('RELEASE queue_errand_shortlist');}
      catch(e){s.db.exec('ROLLBACK TO queue_errand_shortlist; RELEASE queue_errand_shortlist');throw e;}
    }catch{
      const state=s.db.prepare('SELECT state FROM errand_missions WHERE id=?').get(mission) as {state:string}|undefined;
      if(state?.state==='cancelled')return true;
      try{if(s.job(m.id)?.status==='submitted')s.jobState(m.id,'failed','Could not prepare the shortlist.');}catch{}
      try{this.notice(scope.owner,scope.destination,generation,`errand-search-error:${m.id}`,'Could not prepare a verified shortlist for this board.');}catch{}
      return true;
    }finally{this.activeSearch.delete(m.id);}
    return true;
  }
  /** Explicit owner cancellation stops in-flight reads; no request is resent. */
  cancel(m:Incoming) {
    const s=this.router.store,d=s.destination(),owner=s.ownerFor(d);
    if(!/^cancel job search[.!]?$/i.test(m.text.trim())||m.ownerCommand!==true||m.quotedId||!d||!owner||!authenticatedOwner(this.router,m))return false;
    const generation=s.get('errand-authority-generation')??'';
    try{return this.cancelExact(m);}catch{
      try{this.notice(owner,d,generation,`errand-cancel-error:${m.id}`,'Could not cancel this job search. Check its status before retrying.');}catch{}
      s.remember(m.id);return true;
    }
  }
  private cancelExact(m:Incoming) {
    const r=this.router,s=r.store,d=s.destination(),owner=s.ownerFor(d);
    if(!/^cancel job search[.!]?$/i.test(m.text.trim())||m.ownerCommand!==true||m.quotedId||!d||!owner||!authenticatedOwner(r,m))return false;
    const matches=[...this.activeSearch.entries()].filter(([,v])=>v.scope.owner===owner&&v.scope.destination===d);
    if(!matches.length){this.notice(owner,d,s.get('errand-authority-generation')??'',`errand-cancel:${m.id}`,'No job search is running.');s.remember(m.id);return true;}
    if(matches.length!==1)throw new Error('More than one job search is running. Wait for them to finish.');
    const [root,entry]=matches[0];const mission=s.db.prepare('SELECT id FROM errand_missions WHERE root_request=?').get(root) as {id:string}|undefined;
    if(!mission)throw new Error('The job search is unavailable.');
    s.db.exec('SAVEPOINT cancel_errand');
    try{
      this.ledger.cancel(mission.id,entry.scope);s.jobState(root,'completed',null,'cancelled');s.remember(m.id);
      s.db.exec('RELEASE cancel_errand');
    }catch(e){s.db.exec('ROLLBACK TO cancel_errand; RELEASE cancel_errand');throw e;}
    entry.controller.abort();
    try{this.notice(owner,d,s.get('errand-authority-generation')??'',`errand-cancel:${m.id}`,'Job search cancelled.');}catch{}
    return true;
  }
  /** Return false only when no errand shortlist exists; otherwise fail closed. */
  draft(m:Incoming) {
    const s=this.router.store,d=s.destination(),owner=s.ownerFor(d);
    if(!/^\s*(?:please\s+)?draft\s+([1-5])\s*[.!?]*\s*$/i.test(m.text)||!d||!owner||!authenticatedOwner(this.router,m)||m.ownerCommand!==true||m.quotedId||s.controlChannel()!=='whatsapp')return false;
    const generation=s.get('errand-authority-generation')??'';
    try{return this.draftExact(m);}catch(e){
      const error=e instanceof Error?e.message:'',text=/^(Wait for the shortlist to arrive before choosing a draft\.|That shortlist is no longer available\. Start a new errand\.)$/.test(error)?error:'Could not prepare that draft. Start a new errand to try again.';
      try{this.notice(owner,d,generation,`errand-draft-error:${m.id}`,text);}catch{}
      s.remember(m.id);return true;
    }
  }
  private draftExact(m:Incoming) {
    const match=/^\s*(?:please\s+)?draft\s+([1-5])\s*[.!?]*\s*$/i.exec(m.text);if(!match)return false;
    const r=this.router,s=r.store,d=s.destination(),owner=s.ownerFor(d);if(!d||!owner||!authenticatedOwner(r,m)||m.ownerCommand!==true||m.quotedId||s.controlChannel()!=='whatsapp')return false;
    const rows=s.db.prepare(`SELECT g.* FROM errand_outbox_guards g JOIN outbox o ON o.id=g.outbox_id
      WHERE g.kind='shortlist' AND g.owner=? AND g.destination=? AND o.status='sent' AND o.delivered_at IS NOT NULL ORDER BY o.delivered_at DESC LIMIT 1`).all(owner,d) as Guard[];
    const latest=rows[0];
    if(!latest){
      if(s.db.prepare(`SELECT 1 FROM errand_outbox_guards g JOIN outbox o ON o.id=g.outbox_id WHERE g.kind='shortlist' AND g.owner=? AND g.destination=? AND o.status IN ('queued','sending') LIMIT 1`).get(owner,d))throw new Error('Wait for the shortlist to arrive before choosing a draft.');
      if(s.db.prepare(`SELECT 1 FROM errand_outbox_guards g WHERE g.kind='shortlist' AND g.owner=? AND g.destination=? LIMIT 1`).get(owner,d))throw new Error('That shortlist is no longer available. Start a new errand.');
      return false;
    }
    const fresh=s.db.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN observed_at<? OR observed_at>? OR
      (verification!='public-listing-verified' AND (verification!='public-listing-published' OR application_deadline IS NULL OR application_deadline<=?)) THEN 1 ELSE 0 END) stale
      FROM errand_candidates WHERE mission_id=? AND position IS NOT NULL`).get(Date.now()-86400000,Date.now()+5000,Date.now(),latest.mission_id) as {total:number;stale:number|null};
    if(!fresh.total||fresh.stale)throw new Error('That shortlist is no longer available. Start a new errand.');
    const b=r.need(latest.binding_id),scope=this.scope(m.id,b);
    s.db.exec('SAVEPOINT queue_errand_draft');
    try{
      s.enqueue(m.id,b,m.text,d);s.jobState(m.id,'submitted');
      const draft=this.ledger.draft(latest.mission_id,scope,Number(match[1]));
      const text=`Draft for ${draft.title}\n${draft.url}\n\n${draft.text}\n\nReview the listing and draft yourself. Application availability is unverified.`;
      this.queueGuarded(latest.mission_id,latest.root_request,scope,'draft',text);s.remember(m.id);s.db.exec('RELEASE queue_errand_draft');return true;
    }catch(e){s.db.exec('ROLLBACK TO queue_errand_draft; RELEASE queue_errand_draft');throw e;}
  }
  deliveryState(outboxId:string):'ready'|'hold'|'invalid' {
    const s=this.router.store,g=s.db.prepare('SELECT * FROM errand_outbox_guards WHERE outbox_id=?').get(outboxId) as Guard|undefined;
    if(!g){
      const n=s.db.prepare('SELECT * FROM errand_notice_guards WHERE outbox_id=?').get(outboxId) as {owner:string;destination:string;body_hash:string;authority_generation:string}|undefined;
      if(!n)return 'ready';if(s.controlChannel()!=='whatsapp')return 'hold';
      const o=s.db.prepare('SELECT body,destination,status FROM outbox WHERE id=?').get(outboxId) as {body:string;destination:string|null;status:string}|undefined;
      return !!o&&o.status==='queued'&&o.destination===n.destination&&hash(o.body)===n.body_hash&&(s.get('errand-authority-generation')??'')===n.authority_generation&&(s.get('destination-jid')??s.get('whatsapp-owner'))===n.destination&&s.ownerFor(n.destination)===n.owner&&(n.destination===n.owner||!!s.get(`owned-group:${n.destination}`))?'ready':'invalid';
    }
    if(s.controlChannel()!=='whatsapp')return 'hold';
    const o=s.db.prepare('SELECT body,destination,status FROM outbox WHERE id=?').get(outboxId) as {body:string;destination:string|null;status:string}|undefined;
    if(!o||o.status!=='queued'||o.destination!==g.destination||hash(o.body)!==g.body_hash)return 'invalid';
    const scope:ErrandScope={requestId:g.request_id,owner:g.owner,destination:g.destination,bindingId:g.binding_id,bindingIdentity:g.binding_identity};
    try{const mission=s.db.prepare('SELECT contract_json FROM errand_missions WHERE id=? AND root_request=?').get(g.mission_id,g.root_request) as {contract_json:string}|undefined;
      if(!mission||!this.authorized(scope,JSON.parse(mission.contract_json),g.root_request))return 'invalid';
      this.ledger.viewShortlist(g.mission_id,scope);
      if(g.kind==='shortlist'&&toWhatsApp(this.ledger.shortlistText(g.mission_id,scope))!==o.body)return 'invalid';
      if(g.kind==='draft'&&!s.db.prepare('SELECT 1 FROM errand_draft_claims WHERE request_id=? AND mission_id=? AND owner=? AND destination=? AND draft_json IS NOT NULL').get(g.request_id,g.mission_id,g.owner,g.destination))return 'invalid';
      return 'ready';
    }catch{return 'invalid';}
  }
  /** Called after a guarded outbox message has been sent, never before I/O. */
  sent(outboxId:string){
    const s=this.router.store,row=s.db.prepare(`SELECT g.request_id,g.body_hash,o.body,o.status FROM errand_outbox_guards g
      JOIN outbox o ON o.id=g.outbox_id WHERE g.outbox_id=?`).get(outboxId) as {request_id:string;body_hash:string;body:string;status:string}|undefined;
    if(row?.status==='sent'&&row.body_hash===hash(row.body)&&s.job(row.request_id)?.status==='submitted')s.jobState(row.request_id,'completed');
  }
  /** Atomically invalidate a guarded output and, only in the original owner context, queue a guarded notice. */
  invalidate(outboxId:string,reason:string,uncertainOnSending=false){
    const s=this.router.store,g=s.db.prepare('SELECT * FROM errand_outbox_guards WHERE outbox_id=?').get(outboxId) as Guard|undefined;if(!g)return false;
    s.db.exec('SAVEPOINT invalidate_errand_output');
    try{
      s.db.prepare("UPDATE outbox SET status='cancelled',error=? WHERE id=? AND status='queued'").run(reason,outboxId);
      if(uncertainOnSending)s.db.prepare("UPDATE outbox SET status='uncertain',error=? WHERE id=? AND status='sending'").run(reason,outboxId);
      const out=s.db.prepare('SELECT status FROM outbox WHERE id=?').get(outboxId) as {status:string}|undefined;
      if(!out||!['cancelled','failed','uncertain'].includes(out.status)){s.db.exec('RELEASE invalidate_errand_output');return true;}
      const uncertain=out.status==='uncertain';
      if(s.job(g.request_id)?.status==='submitted')s.jobState(g.request_id,uncertain?'uncertain':'failed',uncertain?'The errand message delivery could not be confirmed.':'The errand message was not delivered.');
      const text=uncertain?'The job-search message could not be confirmed. Check your chat before trying again.':'The job-search message was not delivered. Start a new errand to try again.';
      // A missing optional notice must not undo required output settlement.
      try{this.notice(g.owner,g.destination,g.authority_generation,`errand-delivery-notice:${outboxId}`,text);}catch{}
      s.db.exec('RELEASE invalidate_errand_output');return true;
    }catch(e){s.db.exec('ROLLBACK TO invalidate_errand_output; RELEASE invalidate_errand_output');throw e;}
  }
  /** Outbox selection skips disabled bindings, so settle their guarded rows explicitly. */
  sweepDisabled(){
    const s=this.router.store,rows=s.db.prepare(`SELECT g.outbox_id FROM errand_outbox_guards g JOIN outbox o ON o.id=g.outbox_id
      LEFT JOIN bindings b ON b.id=g.binding_id WHERE o.status='queued' AND (b.id IS NULL OR b.enabled=0)`).all() as {outbox_id:string}[];
    for(const row of rows)if(this.deliveryState(row.outbox_id)==='invalid')this.invalidate(row.outbox_id,'The errand session is paused or unavailable.');
  }
  /** Reconcile only durable sent outputs; interrupted searches are not replayed. */
  recover(){
    const s=this.router.store;
    this.sweepDisabled();
    // Older interrupted cancellations may have changed the mission without
    // settling its request. Finish that local transition without replaying it.
    const cancelled=s.db.prepare(`SELECT m.root_request,m.owner,m.destination,sg.authority_generation FROM errand_missions m JOIN inbox i ON i.id=m.root_request LEFT JOIN errand_search_guards sg ON sg.root_request=m.root_request
      WHERE m.state='cancelled' AND i.status='submitted'`).all() as {root_request:string;owner:string;destination:string;authority_generation:string|null}[];
    for(const row of cancelled){
      s.db.exec('SAVEPOINT recover_errand_cancel');
      try{
        s.jobState(row.root_request,'completed',null,'cancelled');
        const origin=s.requestOwnerOrigin(row.root_request);
        if(origin?.owner===row.owner&&origin.destination===row.destination&&row.authority_generation!==null){
          // Cancellation is durable even if its optional notice cannot be queued.
          try{this.notice(row.owner,row.destination,row.authority_generation,`errand-cancel-recovery:${row.root_request}`,'Job search cancelled.');}catch{}
        }
        s.db.exec('RELEASE recover_errand_cancel');
      }catch(e){s.db.exec('ROLLBACK TO recover_errand_cancel; RELEASE recover_errand_cancel');throw e;}
    }
    const sent=s.db.prepare("SELECT g.outbox_id FROM errand_outbox_guards g JOIN outbox o ON o.id=g.outbox_id WHERE o.status='sent'").all() as {outbox_id:string}[];
    for(const row of sent)this.sent(row.outbox_id);
    const sending=s.db.prepare("SELECT g.outbox_id FROM errand_outbox_guards g JOIN outbox o ON o.id=g.outbox_id WHERE o.status='sending'").all() as {outbox_id:string}[];
    for(const row of sending)this.invalidate(row.outbox_id,'Job-search delivery was interrupted; check your chat.',true);
    const invalid=s.db.prepare("SELECT g.outbox_id FROM errand_outbox_guards g JOIN outbox o ON o.id=g.outbox_id WHERE o.status IN ('cancelled','failed','uncertain')").all() as {outbox_id:string}[];
    for(const row of invalid)this.invalidate(row.outbox_id,'The errand message was not delivered.');
    const interrupted=s.db.prepare(`SELECT m.root_request,m.owner,m.destination,sg.authority_generation FROM errand_missions m JOIN inbox i ON i.id=m.root_request LEFT JOIN errand_search_guards sg ON sg.root_request=m.root_request
      WHERE i.status='submitted' AND m.state!='cancelled' AND NOT EXISTS(SELECT 1 FROM errand_outbox_guards g WHERE g.root_request=m.root_request AND g.kind='shortlist')`).all() as {root_request:string;owner:string;destination:string;authority_generation:string|null}[];
    for(const row of interrupted){
      s.db.exec('SAVEPOINT recover_errand_search');
      try{
        s.jobState(row.root_request,'failed','Job search interrupted. Send a new request to retry.');
        const origin=s.requestOwnerOrigin(row.root_request);
        if(origin?.owner===row.owner&&origin.destination===row.destination&&row.authority_generation!==null){
          const source=`errand-restart:${row.root_request}`,text='Job search was interrupted when FarFromDesk restarted. Start a new errand to retry.';
          try{this.notice(row.owner,row.destination,row.authority_generation,source,text);}catch{}
        }
        s.db.exec('RELEASE recover_errand_search');
      }catch(e){s.db.exec('ROLLBACK TO recover_errand_search; RELEASE recover_errand_search');throw e;}
    }
  }
}
