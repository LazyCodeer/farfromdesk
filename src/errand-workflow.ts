import {authenticatedOwner} from './owner-commands.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {ErrandMissions,ErrandSearchFailure,canonicalContract,canonicalSkills,errandBindingIdentity,type ErrandContract,type ErrandRanker,type ErrandScope,type VerifiedListingReader} from './errand-missions.js';
import {greenhouseBoardsReader} from './errand-greenhouse.js';
import {wonderErrandRanker} from './errand-ranker.js';
import {ErrandOrder} from './errand-order.js';
import {parseErrandChoice} from './errand-choice.js';
import {readOwnedErrandProfile,type ErrandProfileSnapshot} from './errand-profile.js';
import {hash,type Binding} from './store.js';
import {toWhatsApp} from './whatsapp-format.js';
import type {Incoming,Router} from './router.js';

type Request={board:string|string[];contract:ErrandContract};
type Guard={outbox_id:string;mission_id:string;root_request:string;request_id:string;owner:string;destination:string;binding_id:string;binding_identity:string;kind:string;body_hash:string;authority_generation:string};
export type ErrandDocumentPin={outboxId:string;guard:Guard;source:string;messageId:string;body:string;bindingId:string;requestId:string;destination:string};
const draftText=(draft:{title:string;url:string;text:string})=>`Draft for ${draft.title}\n${draft.url}\n\n${draft.text}\n\nReview the listing and draft yourself. Application availability is unverified.`;

/** Exact, owner-authored criteria only. No free text is interpreted as authority. */
export function parseGreenhouseRequest(text:string):Request|undefined {
  if(!/^greenhouse jobs\s*;/i.test(text.trim()))return;
  const parts=text.trim().split(';').map(x=>x.trim());parts.shift();const values:Record<string,string>=Object.create(null);
  for(const part of parts){const m=/^(board|role|location|salary|avoid|skills)\s*=\s*(.+)$/i.exec(part);if(!m||values[m[1].toLowerCase()])throw new Error('Use greenhouse jobs; board=NAME; role=TITLE; location=PLACE, with optional salary=, avoid= and skills=.');values[m[1].toLowerCase()]=m[2].trim();}
  const boards=(values.board??'').split(',').map(v=>v.trim());
  if(boards.length<1||boards.length>3||boards.some(board=>!/^[a-z0-9][a-z0-9_-]{0,49}$/.test(board))||new Set(boards).size!==boards.length||!values.role||!values.location||Object.entries(values).some(([key,value])=>value.length>(key==='board'?160:120)||/[\r\n\x00-\x1f]/.test(value)))throw new Error('Provide one to three distinct boards, a role and location in the Greenhouse request.');
  return {board:boards.length===1?boards[0]:boards,contract:canonicalContract({role:values.role,location:values.location,...(values.salary?{salary:values.salary}:{}),...(values.avoid?{avoid:values.avoid}:{}),...(values.skills?{skills:canonicalSkills(values.skills.split(','))}:{})})};
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
  constructor(readonly router:Router,reader?:VerifiedListingReader,ranker?:ErrandRanker,fetcher:typeof fetch=fetch,profileReader:(scope:ErrandScope,contract:ErrandContract)=>ErrandProfileSnapshot|undefined=(scope,contract)=>readOwnedErrandProfile(router.store,scope,router.brain.owner.dir,contract)){
    const store=router.store;this.order=new ErrandOrder(store);
    store.db.exec(`CREATE TABLE IF NOT EXISTS errand_outbox_guards(
      outbox_id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,root_request TEXT NOT NULL,request_id TEXT NOT NULL,
      owner TEXT NOT NULL,destination TEXT NOT NULL,binding_id TEXT NOT NULL,binding_identity TEXT NOT NULL,kind TEXT NOT NULL,body_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS errand_notice_guards(outbox_id TEXT PRIMARY KEY,owner TEXT NOT NULL,destination TEXT NOT NULL,body_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS errand_search_guards(root_request TEXT PRIMARY KEY,authority_generation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS errand_profile_inputs(request_id TEXT PRIMARY KEY,owner TEXT NOT NULL,destination TEXT NOT NULL,generation TEXT NOT NULL,body_hash TEXT NOT NULL,eligible INTEGER NOT NULL DEFAULT 0);`);
    for(const table of ['errand_outbox_guards','errand_notice_guards'])if(!store.db.prepare(`PRAGMA table_info(${table})`).all().some((column:any)=>column.name==='authority_generation'))store.db.exec(`ALTER TABLE ${table} ADD COLUMN authority_generation TEXT NOT NULL DEFAULT ''`);
    if(!store.db.prepare('PRAGMA table_info(errand_profile_inputs)').all().some((column:any)=>column.name==='eligible'))store.db.exec('ALTER TABLE errand_profile_inputs ADD COLUMN eligible INTEGER NOT NULL DEFAULT 0');
    // Unfinished inputs retain their first classification across restarts.
    store.db.prepare("DELETE FROM errand_profile_inputs WHERE EXISTS(SELECT 1 FROM seen WHERE id=errand_profile_inputs.request_id) AND NOT EXISTS(SELECT 1 FROM owner_memory_history WHERE path='about-me.md' AND source='brain:'||errand_profile_inputs.request_id)").run();
    const current=(scope:ErrandScope)=>{
      try{const row=store.db.prepare('SELECT root_request,contract_json,state FROM errand_missions WHERE root_request=?').get(scope.requestId) as {root_request:string;contract_json:string;state:string}|undefined;
        return !!row&&row.state==='searching'&&store.job(scope.requestId)?.status==='submitted'&&this.authorized(scope,JSON.parse(row.contract_json),row.root_request);
      }catch{return false;}
    };
    const source=reader??greenhouseBoardsReader(current);
    const choose:ErrandRanker=ranker??(async(input,signal)=>{
      const context=this.rankScope.getStore();
      const currentRank=()=>{if(!context||signal.aborted)return false;try{
        const row=store.db.prepare('SELECT root_request,contract_json,state FROM errand_missions WHERE id=?').get(context.mission) as {root_request:string;contract_json:string;state:string}|undefined;
        return !!row&&row.state==='gathered'&&store.job(row.root_request)?.status==='submitted'&&this.authorized(context.scope,JSON.parse(row.contract_json),row.root_request);
      }catch{return false;}};
      if(!currentRank())throw new Error('The owner request changed.');
      const key=router.brain.secret.read();if(!key)throw Object.assign(new Error('Meta Brain key is unavailable.'),{code:'configuration_missing'});
      const guarded:typeof fetch=async(url,init)=>{if(!currentRank())throw new Error('The owner request changed.');return fetcher(url,init);};
      return wonderErrandRanker(key,guarded)(input,signal);
    });
    this.ledger=new ErrandMissions(store,(scope,contract,root)=>this.authorized(scope,contract,root),source,choose,()=>Date.now(),(scope,outboxId)=>this.order.after(scope,outboxId),profileReader);
  }
  /** Preserve first-ingress classification before routing, including forwarded text. */
  captureProfileInput(requestId:string,text:string,eligible:boolean){
    const s=this.router.store,context=s.incomingOwnerContext.getStore();
    if(!context||context.channel!=='whatsapp'||context.owner!==context.destination||!s.incomingOwnerCurrent()||!requestId.startsWith('wa:')||typeof text!=='string'||text.length>32000)return;
    const bodyHash=hash(text),previous=s.db.prepare('SELECT owner,destination,generation,body_hash,eligible FROM errand_profile_inputs WHERE request_id=?').get(requestId) as {owner:string;destination:string;generation:string;body_hash:string;eligible:number}|undefined;
    if(previous&&(previous.owner!==context.owner||previous.destination!==context.destination||previous.generation!==context.generation||previous.body_hash!==bodyHash||previous.eligible!==Number(eligible)))throw new Error('Owner input identity changed.');
    s.db.prepare('INSERT OR IGNORE INTO errand_profile_inputs VALUES(?,?,?,?,?,?)').run(requestId,context.owner,context.destination,context.generation,bodyHash,Number(eligible));
  }
  /** Keep provenance only when the turn actually wrote About-you. */
  pruneProfileInput(requestId:string){
    const s=this.router.store;
    try{if(s.seen(requestId))s.db.prepare("DELETE FROM errand_profile_inputs WHERE request_id=? AND NOT EXISTS(SELECT 1 FROM owner_memory_history WHERE path='about-me.md' AND source='brain:'||?)").run(requestId,requestId);}catch{/* Cleanup must not replay a completed message. */}
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
    if(r.stopped||s.controlChannel()!=='whatsapp'||scope.destination!==scope.owner||s.destination()!==scope.destination||s.ownerFor(scope.destination)!==scope.owner||!b?.enabled||!rootJob||!['submitted','completed'].includes(rootJob.status)||['blocked','reviewed','cancelled'].includes(rootJob.outcome??'')||rootJob.binding_id!==b.id||rootJob.destination!==scope.destination||errandBindingIdentity(s,b)!==scope.bindingIdentity||s.get(`parent:${root}`)||s.get(`report-parent:${root}`))return false;
    const mission=s.db.prepare('SELECT root_body_hash,state FROM errand_missions WHERE root_request=?').get(root) as {root_body_hash:string|null;state:string}|undefined;
    if(mission&&(!mission.root_body_hash||mission.root_body_hash!==hash(rootJob.body)||mission.state==='invalidated'))return false;
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
    if(scope.destination!==scope.owner)throw new Error('Use a direct owner chat.');
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
    const s=this.router.store,d=s.destination();
    return /^greenhouse jobs\s*;/i.test(m.text.trim())&&(s.controlChannel()!=='whatsapp'||m.ownerCommand!==true||!!m.quotedId||d!==s.ownerFor(d));
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
    if(d!==owner){
      try{this.notice(owner,d,s.get('errand-authority-generation')??'',`errand-input:${m.id}`,'Send job searches in your direct WhatsApp owner chat.');}catch{}
      s.remember(m.id);return true;
    }
    if(m.ownerCommand!==true||m.quotedId){
      try{this.notice(owner,d,s.get('errand-authority-generation')??'',`errand-input:${m.id}`,'Send the job search as a new text message in your WhatsApp owner chat.');}catch{}
      s.remember(m.id);return true;
    }
    const generation=s.get('errand-authority-generation')??'';
    try{return await this.startExact(m);}catch(e){
      const error=e instanceof Error?e.message:'',text=/^(Use greenhouse jobs; board=NAME; role=TITLE; location=PLACE, with optional salary=, avoid= and skills=\.|Provide one to three distinct boards, a role and location in the Greenhouse request\.|Provide one to five (?:distinct )?short skills\.|Select a session before finding jobs\.|The selected session changed\. Select it again\.)$/.test(error)?error:'Could not start this job search. Check the session and try again.';
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
    let phase:'search'|'ranking'|'delivery'='search';
    try{
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(120000)]);
      const gathered=await this.ledger.gather(mission,scope,{board:request.board,role:request.contract.role,location:request.contract.location},signal);
      if(!gathered)throw new ErrandSearchFailure('no-evidence','No matching listings.');
      phase='ranking';
      const items=await this.rankScope.run({scope,mission},()=>this.ledger.shortlist(mission,scope,signal));
      if(!items.length)throw new ErrandSearchFailure('no-evidence','No matching listings.');
      phase='delivery';
      s.db.exec('SAVEPOINT queue_errand_shortlist');
      try{this.queueGuarded(mission,m.id,scope,'shortlist',this.ledger.shortlistText(mission,scope));s.db.exec('RELEASE queue_errand_shortlist');}
      catch(e){s.db.exec('ROLLBACK TO queue_errand_shortlist; RELEASE queue_errand_shortlist');throw e;}
    }catch(error){
      const state=s.db.prepare('SELECT state FROM errand_missions WHERE id=?').get(mission) as {state:string}|undefined;
      if(state?.state==='cancelled')return true;
      try{if(s.job(m.id)?.status==='submitted')s.jobState(m.id,'failed','Could not prepare the shortlist.');}catch{}
      // Only bridge-generated, fixed messages cross the boundary. Never relay
      // source errors or listing content to the owner as diagnostic text.
      const text=error instanceof ErrandSearchFailure&&error.reason==='no-evidence'?'No shortlist was found in the checked candidates. Check the board, role and location or broaden your search.'
        :error instanceof ErrandSearchFailure&&error.reason==='unsupported-exclusion'?'That exclusion is not supported. Only avoid=onsite is recognized, and it requires independently verified remote-only evidence.'
        :error instanceof ErrandSearchFailure&&error.reason==='exclusion-unverified'?'No checked listings had enough evidence to verify your exclusion. No shortlist was created.'
        :phase==='ranking'&&error instanceof Error&&(error as Error&{code?:string}).code==='configuration_missing'?'Add a Meta Brain key in Settings, then start a new job search.'
        :phase==='ranking'&&error instanceof Error&&(error as Error&{code?:string}).code==='authentication_required'?'Meta Brain authentication failed. Check its key and start a new job search.'
        :phase==='ranking'&&error instanceof Error&&(error as Error&{code?:string}).code==='provider_unavailable'?'Meta ranking is unavailable. Start a new job search when it is working again.'
        :'Could not prepare a shortlist for this board. Check the board and criteria.';
      try{this.notice(scope.owner,scope.destination,generation,`errand-search-error:${m.id}`,text);}catch{}
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
    const queued=s.db.prepare(`SELECT g.outbox_id,g.mission_id,g.root_request,g.binding_id,g.binding_identity FROM errand_outbox_guards g JOIN outbox o ON o.id=g.outbox_id JOIN errand_missions m ON m.id=g.mission_id
      WHERE g.kind='shortlist' AND g.owner=? AND g.destination=? AND o.status='queued' AND m.state='shortlisted'`).all(owner,d) as {outbox_id:string;mission_id:string;root_request:string;binding_id:string;binding_identity:string}[];
    if(matches.length&&queued.some(q=>!matches.some(([root])=>root===q.root_request)))throw new Error('More than one job search is pending.');
    if(!matches.length){
      if(queued.length>1)throw new Error('More than one job search is pending.');
      if(queued.length===1){
        const q=queued[0],scope:ErrandScope={requestId:q.root_request,owner,destination:d,bindingId:q.binding_id,bindingIdentity:q.binding_identity};
        s.db.exec('SAVEPOINT cancel_queued_errand');
        try{this.ledger.cancel(q.mission_id,scope);const changed=s.db.prepare("UPDATE outbox SET status='cancelled',error='Cancelled by owner.' WHERE id=? AND status='queued'").run(q.outbox_id);if(!changed.changes)throw new Error('Delivery already started.');s.jobState(q.root_request,'completed',null,'cancelled');s.remember(m.id);s.db.exec('RELEASE cancel_queued_errand');}
        catch(e){s.db.exec('ROLLBACK TO cancel_queued_errand; RELEASE cancel_queued_errand');throw e;}
        try{this.notice(owner,d,s.get('errand-authority-generation')??'',`errand-cancel:${m.id}`,'Job search cancelled.');}catch{}
        return true;
      }
      const sending=s.db.prepare(`SELECT 1 FROM errand_outbox_guards g JOIN outbox o ON o.id=g.outbox_id WHERE g.kind='shortlist' AND g.owner=? AND g.destination=? AND o.status='sending'`).get(owner,d);
      this.notice(owner,d,s.get('errand-authority-generation')??'',`errand-cancel:${m.id}`,sending?'The shortlist is already being sent. Check your chat.':'No job search is running.');s.remember(m.id);return true;
    }
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
    if(!d||!owner||!authenticatedOwner(this.router,m)||s.controlChannel()!=='whatsapp')return false;
    const active=[...this.activeSearch.values()].some(v=>v.scope.owner===owner&&v.scope.destination===d);
    if(/^\s*(?:please\s+)?draft\s+\d/i.test(m.text)&&(!parseErrandChoice(m.text)||m.ownerCommand!==true||m.quotedId||m.source&&m.source!=='text')){
      if(!active&&!s.db.prepare("SELECT 1 FROM errand_outbox_guards WHERE kind='shortlist' AND owner=? AND destination=? LIMIT 1").get(owner,d))return false;
      try{this.notice(owner,d,s.get('errand-authority-generation')??'',`errand-draft-error:${m.id}`,'Send a new text reply using the draft number and code shown on the shortlist.');}catch{}
      s.remember(m.id);return true;
    }
    if(!parseErrandChoice(m.text)||m.ownerCommand!==true||m.quotedId)return false;
    if(active){
      try{this.notice(owner,d,s.get('errand-authority-generation')??'',`errand-draft-error:${m.id}`,'Wait for the shortlist to arrive before choosing a draft.');}catch{}
      s.remember(m.id);return true;
    }
    const generation=s.get('errand-authority-generation')??'';
    if(d!==owner){
      try{this.notice(owner,d,generation,`errand-draft-error:${m.id}`,'Send draft choices in your direct WhatsApp owner chat.');}catch{}
      s.remember(m.id);return true;
    }
    try{return this.draftExact(m);}catch(e){
      const error=e instanceof Error?e.message:'',text=/^(Wait for the shortlist to arrive before choosing a draft\.|That shortlist is no longer available\. Start a new errand\.|More than one shortlist has arrived\. Reply with the code shown on the latest shortlist\.|That shortlist code is unavailable\. Use the code on the latest shortlist\.)$/.test(error)?error:'Could not prepare that draft. Start a new errand to try again.';
      try{this.notice(owner,d,generation,`errand-draft-error:${m.id}`,text);}catch{}
      s.remember(m.id);return true;
    }
  }
  private draftExact(m:Incoming) {
    const choice=parseErrandChoice(m.text);if(!choice)return false;
    const r=this.router,s=r.store,d=s.destination(),owner=s.ownerFor(d);if(!d||!owner||!authenticatedOwner(r,m)||m.ownerCommand!==true||m.quotedId||s.controlChannel()!=='whatsapp')return false;
    const rows=s.db.prepare(`SELECT g.* FROM errand_outbox_guards g JOIN outbox o ON o.id=g.outbox_id
      WHERE g.kind='shortlist' AND g.owner=? AND g.destination=? AND o.status='sent' AND o.delivered_at IS NOT NULL ORDER BY o.delivered_at DESC LIMIT 1`).all(owner,d) as Guard[];
    const latest=rows[0];
    if(!latest){
      if(s.db.prepare(`SELECT 1 FROM errand_outbox_guards g JOIN outbox o ON o.id=g.outbox_id WHERE g.kind='shortlist' AND g.owner=? AND g.destination=? AND o.status IN ('queued','sending') LIMIT 1`).get(owner,d))throw new Error('Wait for the shortlist to arrive before choosing a draft.');
      if(s.db.prepare(`SELECT 1 FROM errand_outbox_guards g WHERE g.kind='shortlist' AND g.owner=? AND g.destination=? LIMIT 1`).get(owner,d))throw new Error('That shortlist is no longer available. Start a new errand.');
      return false;
    }
    const now=Date.now();
    const fresh=s.db.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN observed_at<? OR observed_at>? OR
      (verification!='public-listing-verified' AND NOT (verification='public-listing-published' AND application_deadline IS NOT NULL AND application_deadline>?)
        AND NOT (verification='public-listing-published-no-deadline' AND application_deadline IS NULL AND observed_at>=?)) THEN 1 ELSE 0 END) stale
      FROM errand_candidates WHERE mission_id=? AND position IS NOT NULL`).get(now-86400000,now+5000,now,now-3600000,latest.mission_id) as {total:number;stale:number|null};
    if(!fresh.total||fresh.stale)throw new Error('That shortlist is no longer available. Start a new errand.');
    const b=r.need(latest.binding_id),scope=this.scope(m.id,b);
    s.db.exec('SAVEPOINT queue_errand_draft');
    try{
      s.enqueue(m.id,b,m.text,d);s.jobState(m.id,'submitted');
      const draft=this.ledger.draft(latest.mission_id,scope,choice.number);
      const text=draftText(draft);
      this.queueGuarded(latest.mission_id,latest.root_request,scope,'draft',text);s.remember(m.id);s.db.exec('RELEASE queue_errand_draft');return true;
    }catch(e){s.db.exec('ROLLBACK TO queue_errand_draft; RELEASE queue_errand_draft');throw e;}
  }
  deliveryState(outboxId:string,allowSending=false):'ready'|'hold'|'invalid' {
    const s=this.router.store,g=s.db.prepare('SELECT * FROM errand_outbox_guards WHERE outbox_id=?').get(outboxId) as Guard|undefined;
    if(!g){
      const n=s.db.prepare('SELECT * FROM errand_notice_guards WHERE outbox_id=?').get(outboxId) as {owner:string;destination:string;body_hash:string;authority_generation:string}|undefined;
      if(!n)return 'ready';if(s.controlChannel()!=='whatsapp')return 'hold';
      const o=s.db.prepare('SELECT body,destination,status FROM outbox WHERE id=?').get(outboxId) as {body:string;destination:string|null;status:string}|undefined;
      return !!o&&o.status==='queued'&&o.destination===n.destination&&hash(o.body)===n.body_hash&&(s.get('errand-authority-generation')??'')===n.authority_generation&&(s.get('destination-jid')??s.get('whatsapp-owner'))===n.destination&&s.ownerFor(n.destination)===n.owner&&(n.destination===n.owner||!!s.get(`owned-group:${n.destination}`))?'ready':'invalid';
    }
    if(s.controlChannel()!=='whatsapp')return 'hold';
    const o=s.db.prepare('SELECT body,destination,status FROM outbox WHERE id=?').get(outboxId) as {body:string;destination:string|null;status:string}|undefined;
    if(!o||!(o.status==='queued'||allowSending&&o.status==='sending')||o.destination!==g.destination||hash(o.body)!==g.body_hash)return 'invalid';
    const scope:ErrandScope={requestId:g.request_id,owner:g.owner,destination:g.destination,bindingId:g.binding_id,bindingIdentity:g.binding_identity};
    try{const mission=s.db.prepare('SELECT contract_json FROM errand_missions WHERE id=? AND root_request=?').get(g.mission_id,g.root_request) as {contract_json:string}|undefined;
      if(!mission||!this.authorized(scope,JSON.parse(mission.contract_json),g.root_request))return 'invalid';
      this.ledger.viewShortlist(g.mission_id,scope);
      if(g.kind==='shortlist'&&toWhatsApp(this.ledger.shortlistText(g.mission_id,scope))!==o.body)return 'invalid';
      if(g.kind==='draft'){
        const claim=s.db.prepare(`SELECT c.position FROM errand_draft_claims d JOIN errand_candidates c ON c.id=d.candidate_id AND c.mission_id=d.mission_id
          WHERE d.request_id=? AND d.mission_id=? AND d.owner=? AND d.destination=? AND d.draft_json IS NOT NULL AND d.candidate_hash IS NOT NULL`).get(g.request_id,g.mission_id,g.owner,g.destination) as {position:number|null}|undefined;
        if(!claim?.position||toWhatsApp(draftText(this.ledger.draft(g.mission_id,scope,claim.position)))!==o.body)return 'invalid';
      }
      return 'ready';
    }catch{return 'invalid';}
  }
  /** Pin the exact guarded draft before upload; no caller supplies its destination or bytes. */
  pinDraftDocument(outboxId:string):ErrandDocumentPin|undefined {
    const s=this.router.store,g=s.db.prepare('SELECT * FROM errand_outbox_guards WHERE outbox_id=?').get(outboxId) as Guard|undefined;
    const o=s.db.prepare('SELECT status,source,wa_id,body,binding_id,request_id,destination,artifact_id FROM outbox WHERE id=?').get(outboxId) as {status:string;source:string;wa_id:string;body:string;binding_id:string|null;request_id:string|null;destination:string|null;artifact_id:string|null}|undefined;
    if(!g||g.kind!=='draft'||!o||o.status!=='queued'||o.source!==`errand-draft:${g.request_id}:0`||o.binding_id!==g.binding_id||o.request_id!==g.request_id||o.destination!==g.owner||g.destination!==g.owner||o.artifact_id!==null||hash(o.body)!==g.body_hash||this.deliveryState(outboxId)!=='ready')return;
    return {outboxId,guard:g,source:o.source,messageId:o.wa_id,body:o.body,bindingId:g.binding_id,requestId:g.request_id,destination:g.destination};
  }
  /** Recheck the pinned row, guard and owner-bound snapshot after upload, immediately before relay. */
  draftDocumentReady(pin:ErrandDocumentPin):boolean {
    const s=this.router.store,g=s.db.prepare('SELECT * FROM errand_outbox_guards WHERE outbox_id=?').get(pin.outboxId) as Guard|undefined;
    const o=s.db.prepare('SELECT status,source,wa_id,body,binding_id,request_id,destination,artifact_id FROM outbox WHERE id=?').get(pin.outboxId) as {status:string;source:string;wa_id:string;body:string;binding_id:string|null;request_id:string|null;destination:string|null;artifact_id:string|null}|undefined;
    return !!g&&JSON.stringify(g)===JSON.stringify(pin.guard)&&g.kind==='draft'&&!!o&&o.status==='sending'&&o.source===pin.source&&o.wa_id===pin.messageId&&o.body===pin.body&&o.binding_id===pin.bindingId&&o.request_id===pin.requestId&&o.destination===pin.destination&&o.artifact_id===null&&pin.destination===g.owner&&hash(o.body)===g.body_hash&&s.incomingOwnerDelivery(pin.outboxId)&&this.deliveryState(pin.outboxId,true)==='ready';
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
  /** Settle a missing-guard output without attributing it to an unrelated request. */
  settleOrphanErrand(outboxId:string){
    const s=this.router.store;
    s.db.prepare("UPDATE outbox SET status='uncertain',error='Job-search delivery could not be confirmed; check your chat before retrying' WHERE id=? AND status='sending'").run(outboxId);
    s.db.prepare("UPDATE outbox SET status='cancelled',error='The job-search guard is unavailable.' WHERE id=? AND status='queued' AND NOT EXISTS (SELECT 1 FROM errand_outbox_guards g WHERE g.outbox_id=outbox.id)").run(outboxId);
    s.db.prepare("UPDATE outbox SET status='uncertain',error='Job-search delivery could not be confirmed; check your chat before retrying' WHERE id=? AND status='sent' AND NOT EXISTS (SELECT 1 FROM errand_outbox_guards g WHERE g.outbox_id=outbox.id)").run(outboxId);
    const row=s.db.prepare(`SELECT i.id FROM outbox o JOIN errand_draft_claims c ON c.request_id=o.request_id
      JOIN errand_missions m ON m.id=c.mission_id JOIN inbox i ON i.id=c.request_id
      JOIN owner_request_origins origin ON origin.request_id=i.id
      WHERE o.id=? AND o.status IN ('uncertain','cancelled') AND o.source='errand-draft:'||i.id||':0'
      AND o.binding_id=m.binding_id AND i.binding_id=m.binding_id AND o.destination=c.destination
      AND i.destination=c.destination AND c.destination=c.owner AND m.owner=c.owner AND m.destination=c.destination
      AND origin.owner=c.owner AND origin.destination=c.destination AND i.status='submitted'
      AND NOT EXISTS (SELECT 1 FROM errand_outbox_guards g WHERE g.outbox_id=o.id)`).get(outboxId) as {id:string}|undefined;
    const shortlist=s.db.prepare(`SELECT i.id FROM outbox o JOIN errand_shortlist_messages l ON l.outbox_id=o.id
      JOIN errand_missions m ON m.id=l.mission_id JOIN inbox i ON i.id=m.root_request
      JOIN owner_request_origins origin ON origin.request_id=i.id
      WHERE o.id=? AND o.status IN ('uncertain','cancelled') AND o.source='errand-shortlist:'||m.id||':0'
      AND o.request_id=i.id AND o.binding_id=m.binding_id AND i.binding_id=m.binding_id
      AND o.destination=l.destination AND i.destination=l.destination AND l.destination=l.owner
      AND m.owner=l.owner AND m.destination=l.destination AND l.root_request=i.id
      AND origin.owner=l.owner AND origin.destination=l.destination AND i.status='submitted'
      AND NOT EXISTS (SELECT 1 FROM errand_outbox_guards g WHERE g.outbox_id=o.id)`).get(outboxId) as {id:string}|undefined;
    const request=row??shortlist,out=s.db.prepare('SELECT status FROM outbox WHERE id=?').get(outboxId) as {status:string}|undefined;
    if(request&&out)s.jobState(request.id,out.status==='uncertain'?'uncertain':'failed',out.status==='uncertain'?'The errand message delivery could not be confirmed.':'The errand message was not delivered.');
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
    const orphanOutputs=s.db.prepare("SELECT id FROM outbox WHERE status IN ('queued','sending','sent','uncertain','cancelled') AND (source LIKE 'errand-draft:%' OR source LIKE 'errand-shortlist:%') AND NOT EXISTS (SELECT 1 FROM errand_outbox_guards g WHERE g.outbox_id=outbox.id)").all() as {id:string}[];
    for(const row of orphanOutputs)this.settleOrphanErrand(row.id);
    const invalid=s.db.prepare("SELECT g.outbox_id FROM errand_outbox_guards g JOIN outbox o ON o.id=g.outbox_id WHERE o.status IN ('cancelled','failed','uncertain') AND NOT (o.status='cancelled' AND COALESCE(o.error,'')='Cancelled by owner.')").all() as {outbox_id:string}[];
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
