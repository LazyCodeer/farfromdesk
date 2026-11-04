import {researchSpecialty} from './research-agent.js';
import {jobsSpecialty} from './jobs-agent.js';
import {captureGuidedResearchRequest} from './agent-reach-request.js';
import {bindSessionSpecialty,prepareSpecialties,specialtyEpoch,markPendingSpecialty} from './session-specialty.js';
import {socialSpecialty} from './social-agent.js';
import {requestedSocialImageProvider} from './social-image-provider.js';
import { BrainMemory } from './brain-memory.js';
import type { Store, Binding } from './store.js';
import type { Incoming, Router } from './router.js';
import { brainPolicy, brainView, MetaSecret, type BrainPolicy, type BrainProvider } from './meta-brain-config.js';
import { BRAIN_PROMPT, Interpretation, MetaModel, type MemoryTool } from './meta-model.js';
import { runDevicePlan, deviceTargets, detectDevicePlan, deviceVerbLike, appInventoryRequest, notesAuthoringRequest, authoringText, notesWritePlan, type DeviceControl, type DevicePlan } from './brain-device.js';
import { DesktopControl } from './desktop-control.js';
import { mentionedItems } from './owner-routing.js';
import { brainSelected } from './owner-commands.js';
import { overviewTool, shortlistTools } from './app-tools/retrieve.js';
import { OwnerMemory } from './owner-memory.js';
import { errorCode } from './request-events.js';
import { metaObserver } from './meta-timeline.js';

/** How long a driver report stays usable as the fact behind a later question about the same app. */
const DEVICE_FACT_MS=10*60_000;

/**
 * The owner's local clock as one fact for the model.
 *
 * "put a meeting on my calendar tomorrow at 5" needs an exact date and the model has no clock of
 * its own, so "tomorrow" would otherwise be guessed. The weekday rides along because that is how
 * the owner says it, and the wall-clock format matches what the calendar tool accepts.
 */
export function localStamp(date:Date=new Date()):string{
  const pad=(n:number)=>String(n).padStart(2,'0');
  const weekday=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][date.getDay()];
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${weekday}`;
}

/**
 * The words the owner can type for each coding platform, and the platform each maps to.
 * Every place that reads a platform out of owner text must use these: a platform missing here is
 * invisible to routing, so the owner naming it still lands on the default coordinator instead.
 * Longest spelling first, because the alternation stops at the first match.
 */
const PLATFORM_WORDS:ReadonlyArray<readonly [BrainProvider,readonly string[]]>=[
  ['codex',['codex']],
  ['claude',['claude']],
  ['muse',['muse code','muse']],
  ['deepseek',['deepseek harness','deepseek']],
  ['cursor',['cursor']],
];
const PLATFORM_ALTERNATION=PLATFORM_WORDS.flatMap(([,words])=>words).join('|');
/** Any spoken platform name. */
const PLATFORM_RE=new RegExp(`\\b(?:${PLATFORM_ALTERNATION})\\b`,'i');
const PLATFORM_RE_ALL=new RegExp(`\\b(?:${PLATFORM_ALTERNATION})\\b`,'gi');
/**
 * Fast-path phrasings that carry a platform name. These must be built with the RegExp constructor:
 * a regex literal never interpolates ${...}, so a platform name spliced into a literal silently
 * matches nothing at all - the phrase then falls through to the model instead of the fast path.
 */
const RECENT_RE=new RegExp(`^(?:please )?(?:list|show|give me)(?: all)?(?: my| the)? (${PLATFORM_ALTERNATION}) sessions?(?: in| from)? (?:the )?last (\\d{1,3}) (?:h|hr|hrs|hra|hours?)$`,'i');
const STATUS_ONE_RE=new RegExp(`^(?:the )?(?:${PLATFORM_ALTERNATION}) one i want to know the update$`,'i');
/** The platform a spoken name refers to, or undefined when the word isn't a platform. */
function platformProvider(word:string|undefined):BrainProvider|undefined {
  const w=(word??'').toLowerCase();
  return PLATFORM_WORDS.find(([,words])=>words.includes(w))?.[0];
}
/** Every distinct platform named in owner text, in the order first mentioned. */
function namedPlatforms(text:string):BrainProvider[] {
  return [...new Set((text.match(PLATFORM_RE_ALL)??[]).map(w=>platformProvider(w)).filter((p):p is BrainProvider=>!!p))];
}

type Task={id:string;original:string;normalized:string|null;source:string;destination:string|null;coordinator_id:string|null;target_session_id:string|null;state:string;permission:string;reason:string|null;verified_at:number|null;created_at:number};
/** Only Router's authenticated owner ingress calls handle. Reports and attachments never do. */
export class MetaBrain {
  readonly memory:BrainMemory;
  readonly owner:OwnerMemory;
  private refreshTurn=0;private watchTurn=new Map<string|null,number>();
  private device?:DeviceControl;
  constructor(private store:Store,readonly secret=new MetaSecret(),private model:Pick<MetaModel,'interpret'>=new MetaModel(),private injectedDevice?:DeviceControl) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS brain_tasks(id TEXT PRIMARY KEY,original TEXT NOT NULL,normalized TEXT,source TEXT NOT NULL,destination TEXT,coordinator_id TEXT,state TEXT NOT NULL,permission TEXT NOT NULL,reason TEXT,verified_at INTEGER,created_at INTEGER NOT NULL);`);
    this.memory=new BrainMemory(store);
    this.owner=new OwnerMemory(store,secret.root,brainPolicy(store).notes);
    if(!store.db.prepare('PRAGMA table_info(brain_tasks)').all().some((c:any)=>c.name==='target_session_id'))store.db.exec('ALTER TABLE brain_tasks ADD COLUMN target_session_id TEXT');
    store.db.exec(`CREATE TABLE IF NOT EXISTS brain_watches(request_id TEXT PRIMARY KEY,destination TEXT NOT NULL,item_id INTEGER NOT NULL,job_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'waiting',created_at INTEGER NOT NULL);`);
    for(const row of store.db.prepare('SELECT id,destination FROM brain_tasks').all())store.correlateBrainReply(String(row.id),`brain:${row.id}`,row.destination as string|null);
    // A prior process may have paid for inference but not saved its result. Never replay it.
    store.db.prepare("UPDATE brain_tasks SET state='blocked',permission='denied',reason='Interpretation interrupted; no automatic retry' WHERE state='interpreting'").run();
  }
  view(){return {...brainView(this.store,this.secret),instructions:BRAIN_PROMPT};}
  get(id:string){return this.store.db.prepare('SELECT * FROM brain_tasks WHERE id=?').get(id) as Task|undefined;}
  tasks(destination?:string|null) {
    const rows=(destination===undefined?this.store.db.prepare('SELECT * FROM brain_tasks ORDER BY created_at DESC LIMIT 100').all():this.store.db.prepare('SELECT * FROM brain_tasks WHERE destination IS ? ORDER BY created_at DESC LIMIT 100').all(destination)) as Task[];
    return rows.map(row=>{
      const job=this.store.job(row.id),events=this.store.db.prepare('SELECT id,event,at,details FROM request_events WHERE request_id=? ORDER BY id DESC LIMIT 20').all(row.id);
      const reports=this.store.db.prepare('SELECT source,kind,origin,created_at FROM reply_receipts WHERE request_id=? ORDER BY created_at DESC LIMIT 10').all(row.id);
      let status=row.state;
      if(row.verified_at&&job?.status==='completed'&&job.outcome==='done')status='complete';
      else if(job){status=job.outcome==='blocked'||['failed','uncertain'].includes(job.status)?'blocked':job.outcome==='done'?'reported complete, awaiting verification':job.first_reply_at?'running':job.status==='submitted'?'delivered':job.status==='dispatched'?'dispatching':job.status==='completed'?'reported finished, outcome unverified':job.status;}
      const children=this.store.db.prepare("SELECT i.id,i.binding_id,i.status,i.outcome,i.first_reply_at,i.final_reply_at FROM inbox i JOIN settings s ON s.key='parent:'||i.id WHERE s.value=?").all(row.id);
      const item=this.store.itemOf(row.id);
      const notes=item?this.store.db.prepare('SELECT at,by,note FROM item_notes WHERE item_id=? ORDER BY id DESC LIMIT 3').all(item):[];
      const deliveries=this.store.deliveries(row.id).filter(d=>!job||d.reply_kind!=='system');
      const responseState=!deliveries.length?'none':deliveries.every(d=>d.sent_at)?'sent':deliveries.some(d=>Number(d.attempts)>0&&!d.sent_at)?'retrying':'queued';
      if(!job&&row.state==='answered')status=responseState==='sent'?'answer sent':'answer '+responseState;
      return {...row,responseState,origin:'owner' as const,status,evidence:{events,reports,children,notes,deliveries},nativeOutcome:job?.outcome??null};
    });
  }
  verify(id:string) {
    const task=this.get(id),job=this.store.job(id);
    if(!task||job?.outcome!=='done'||job.status!=='completed')throw new Error('A coordinator completion outcome must be recorded before owner verification.');
    if(this.store.db.prepare("SELECT 1 FROM inbox i JOIN settings s ON s.key='parent:'||i.id WHERE s.value=? AND i.status NOT IN ('completed','reviewed','auto_closed','replaced') LIMIT 1").get(id))throw new Error('Delegated work is still unresolved.');
    this.store.db.prepare('UPDATE brain_tasks SET verified_at=? WHERE id=?').run(Date.now(),id);
    this.store.event(id,'brain_owner_verified');
  }
  private stop(id:string,reason:string,state='blocked') {
    this.store.db.prepare('UPDATE brain_tasks SET state=?,permission=?,reason=? WHERE id=?').run(state,state==='clarification'?'needs-clarification':'denied',reason,id);
    const task=this.get(id)!;
    this.store.outputBrain(id,reason);
  }
  async refresh(router:Router) {
    if(router.stopped||!brainPolicy(this.store).enabled||!brainPolicy(this.store).allowStatus)return;
    await this.refreshEvidence(router,this.memory.board());this.memory.synchronize();
  }
  private async refreshEvidence(router:Router,items:ReturnType<BrainMemory['board']>) {
    if(!router.native.requestStatus)return;
    const fresh=(id:string)=>{try{return Date.now()-JSON.parse(this.store.get(`brain-native:${id}`)!).at<15000;}catch{return false;}};
    const due=items.flatMap(i=>i.jobs).filter(j=>['submitted','dispatched','uncertain'].includes(String(j.status))&&!fresh(String(j.id)));
    // Three at a time, taking turns, so a fourth active job is not starved by the first three.
    const start=due.length?this.refreshTurn%due.length:0,jobs=[...due.slice(start),...due.slice(0,start)].slice(0,3);this.refreshTurn=start+jobs.length;
    await Promise.all(jobs.map(async j=>{
      const id=String(j.id);
      try {
        const observed=await router.native.requestStatus({id,binding_id:String(j.binding_id)});if(!this.store.incomingOwnerCurrent())return;
        this.store.set(`brain-native:${id}`,JSON.stringify({at:Date.now(),status:observed?.status??'unknown',turnId:observed?.turnId}));
        if(observed){
          this.store.event(id,'native_observed',{code:observed.status},observed.turnId);
          const current=this.store.job(id);
          if(current&&['submitted','dispatched','uncertain'].includes(current.status)&&['interrupted','failed','completed'].includes(observed.status))
            this.store.jobState(id,'uncertain',observed.status==='completed'?'Native turn ended without a recorded reply':'Native turn '+observed.status);
        }
      }catch{this.store.set(`brain-native:${id}`,JSON.stringify({at:Date.now(),status:'unavailable'}));}
    }));
  }
  hasChoice() {return brainPolicy(this.store).enabled&&!!this.store.get(`brain-choice:${this.store.destination()}`)&&this.store.get(`brain-choice:${this.store.destination()}`)!=='null';}
  clearChoice(){this.store.set(`brain-choice:${this.store.destination()}`,'null');}
  /** Recent owner messages from every route (brain, named item, direct, quoted) with the replies they got,
   * including worker and proxy answers on delegated children. Untrusted history, never new permission. */
  private conversation(exclude:string) {
    const d=this.store.destination();
    return (this.store.db.prepare(`SELECT id,original,state,created_at FROM brain_tasks WHERE destination IS ? AND id<>?
      UNION ALL SELECT id,body,status,created_at FROM inbox WHERE destination IS ? AND id<>? AND id NOT IN (SELECT id FROM brain_tasks) AND (id LIKE 'wa:%' OR id LIKE 'tg:%' OR id LIKE 'local:%')
      ORDER BY created_at DESC LIMIT 12`).all(d,exclude,d,exclude))
      .reverse().map(row=>({original:String(row.original).slice(0,2000),state:String(row.state),response:(this.store.db.prepare(`SELECT body FROM outbox WHERE (request_id=? OR request_id IN (SELECT key FROM (SELECT substr(key,8) AS key,value FROM settings WHERE key LIKE 'parent:%') WHERE value=?)) AND destination IS ? AND (reply_kind<>'system' OR source LIKE ?) ORDER BY created_at LIMIT 3`).all(row.id,row.id,d,`brain:${row.id}:%`).map(r=>String(r.body)).join('\n')).slice(0,1500)}));
  }
  /** The owner's explicit recovery for an item whose session was replaced or paused: send its original request,
   * word for word, to the current default proxy. Only the owner's "start #N again" does this; nothing replays on its own. */
  private restart(router:Router,m:Incoming,ref:string) {
    const answer=(s:string)=>{this.answer(m.id,s);return true;};
    const codes=JSON.parse(this.store.get(`item-codes:${this.store.destination()}`)??'{}');
    const id=/^\d+$/.test(ref)?Number(ref):codes[ref.toUpperCase()],item=this.memory.board().find(i=>i.id===id);
    if(!item)return answer(`I can't find that item in this chat. Ask for your items to see the current codes.`);
    if(!this.memory.attention(item))return answer(`#${item.id} ${item.title} still has a working session, so I didn't start it again. Ask for an update instead.`);
    const c=router.coordinator,proxy=c?.master(),policy=brainPolicy(this.store);
    if(!policy.allowRouting)return answer('Routing is disabled in Meta Settings, so nothing was sent.');
    if(!c||!proxy?.enabled||!c.enabled().includes(proxy.provider)||!policy.providers.includes(proxy.provider)||c.registry.identity(proxy).key!==c.registry.entry(proxy.id)?.key)return answer('Your current proxy isn\'t ready, so nothing was sent. Check Coding platforms.');
    const original=item.jobs.map(j=>this.store.job(String(j.id))).filter(j=>j&&this.store.ownerInputId(j.id)).at(-1);
    if(!original)return answer(`I don't have the original request for #${item.id}, so nothing was sent. Send the task again in your own words.`);
    const name=(this.store.get(`name:${proxy.id}`)??proxy.alias).replace(/\s+/g,' ').slice(0,60);
    this.store.db.exec('SAVEPOINT brain_restart');
    try {
      router.queue(m.id,proxy,original.body);
      this.memory.link(m.id,item.id);
      this.store.set(`brain-restart:${m.id}`,String(item.id));
      this.memory.items.setSession(item.id,proxy.id,'Owner');this.memory.items.setStatus(item.id,'in progress','Owner');
      this.memory.items.note(item.id,`Owner started it again with ${name}.`,'Owner',`brain-restart:${m.id}`);
      this.store.db.prepare("UPDATE brain_tasks SET coordinator_id=?,target_session_id=?,state='queued',permission='allowed' WHERE id=?").run(proxy.id,proxy.id,m.id);
      this.store.set(`brain-topic:${this.store.destination()}`,item.ref);
      this.store.db.exec('RELEASE brain_restart');
    }catch{this.store.db.exec('ROLLBACK TO brain_restart; RELEASE brain_restart');return answer('I couldn\'t send it. Nothing was sent; try again in a moment.');}
    return true;
  }
  /** Ask the session that owns an item for a fresh report. It is a status question, never a rerun of the task. */
  private requestUpdate(router:Router,m:Incoming,item:ReturnType<BrainMemory['board']>[number],original=m.text) {
    const answer=(s:string)=>{this.answer(m.id,s);return true;};
    const policy=brainPolicy(this.store);
    // Model intent is advisory. Explicit negation and quoted instructions cannot authorize a dispatch.
    if(/\b(?:don['’]?t|do not|never|stop|cancel|not to)\b/i.test(original)||/["“][^"”]*\b(?:ask|ping|check with|request)\b/i.test(original))return answer('No update request was sent. If you want a fresh report, ask me to contact the owning session.');
    if(!policy.allowRouting)return answer('Asking sessions for updates is disabled in Meta Settings. Here is the saved status:\n'+this.statusText([item],router));
    const stale=this.memory.attention(item);if(stale)return answer(stale);
    if(!item.jobs.length)return answer(`#${item.id} ${item.title} hasn't been sent to a session yet, so there's no one to ask. Tell me what you want done and I'll send it.`);
    const c=router.coordinator;if(!c)return answer('Connect a proxy in Coding platforms before asking for updates.');
    let target:Binding|undefined;
    try{target=this.memory.owner(item,router);}catch(e){return answer(`#${item.id} ${item.title}: ${(e as Error).message}`);}
    if(!target?.enabled||!policy.providers.includes(target.provider)||!c.enabled().includes(target.provider)||(!c.isCoordinator(target.id)&&!c.selected().some(b=>b.id===target!.id)))
      return answer(`#${item.id} ${item.title}: its session isn't connected, so I can't ask it. Connect it in the app, or send the task again.`);
    const named=namedPlatforms(original);
    if(named.length>1||(named.length===1&&named[0]!==target.provider))return answer('This item belongs to another platform. Please clarify which owning session you want to ask. Nothing was sent.');
    const proxy=c.isCoordinator(target.id)?target:c.registry.bindingFor(target);
    if(!proxy?.enabled||c.registry.identity(proxy).key!==c.registry.entry(proxy.id)?.key)return answer(`#${item.id} ${item.title}: the account or app behind its session changed, so I didn't ask it. Review it in Coding platforms first.`);
    const name=(this.store.get(`name:${target.id}`)??target.alias).replace(/\s+/g,' ').slice(0,60);
    this.store.db.exec('SAVEPOINT brain_update');
    try {
      router.queue(m.id,target,`Status check from the owner for #${item.id} ${item.title}.\nOwner's words: "${original.slice(0,2000)}"\nReply with what is done, what is still in progress and anything blocking it. This is a status question only. Report existing progress, results and blockers. Do not resume, rerun or continue the task, change files, or send messages anywhere else.`);
      this.store.set(`brain-ask:${m.id}`,String(item.id));
      this.memory.link(m.id,item.id);
      this.memory.items.note(item.id,`Owner asked ${name} for an update.`,'Brain',`brain-ask:${m.id}`);
      this.store.db.prepare("UPDATE brain_tasks SET coordinator_id=?,target_session_id=?,state='queued',permission='allowed' WHERE id=?").run(proxy.id,target.id,m.id);
      this.store.set(`brain-topic:${this.store.destination()}`,item.ref);
      this.store.event(m.id,'brain_update_requested');
      this.store.output(undefined,`🔎 *Asking ${name}*\nAn update request is queued for #${item.id} ${item.title}. Its reply will come here after delivery.`,`brain-ask:${m.id}`,this.store.destination(),{kind:'system',origin:'system',requestId:m.id});
      this.store.db.exec('RELEASE brain_update');
    }catch{this.store.db.exec('ROLLBACK TO brain_update; RELEASE brain_update');return answer('I couldn\'t send the update request. Nothing was sent; try again in a moment.');}
    return true;
  }
  /** Tells the owner what the brain saved for this message, so nothing lands in memory silently. */
  private announce(m:Incoming) {
    const source=`brain:${m.id}`,saved=this.owner.changes(source);if(!saved.length)return;
    this.store.set(`memory-last:${this.store.destination()}`,JSON.stringify({source,at:Date.now()}));
    this.store.outputBrain(m.id,`🧠 ${saved.map(c=>c.summary).join('\n').slice(0,600)}\nReply *undo* to take it back.`,`brain-memory:${m.id}`);
  }
  private answer(id:string,text:string) {
    this.store.db.prepare("UPDATE brain_tasks SET state='answered',permission='allowed' WHERE id=?").run(id);
    this.store.outputBrain(id,text);
  }
  /**
   * What the owner sees for "where are we" and for one task's status.
   *
   * Measured live, one task's status read "#1 open TextEdit and type hello (FarFromDesk
   * coordinator setup): in progress, sent to session; no reply yet." The facts are the
   * same; nothing in it looks like a message. One task gets a heading and a line per
   * fact, several tasks get one line each, which is the shape the companion instructions
   * already ask for. A task whose session can no longer answer keeps its own sentence,
   * because that sentence carries the two things the owner can do next.
   */
  private statusText(items:ReturnType<BrainMemory['board']>,router:Router) {
    const rows:{ref:string;title:string;session?:string;state:string;asked?:string}[]=[];
    const notes:string[]=[];
    for(const i of items){
      const latest=i.jobs[0];
      let native:any;try{native=latest?JSON.parse(this.store.get(`brain-native:${latest.id}`)??'null'):null;}catch{}
      const observed=native&&Date.now()-native.at<30000?(native.status==='interrupted'?'Native turn interrupted; no automatic retry':native.status==='failed'?'Native turn failed; check the session':native.status==='completed'?'Native turn ended; no recorded answer':undefined):undefined;
      const approval=latest&&[...router.approvals.pending.values()].some(p=>p.binding.id===latest.binding_id);
      const stale=this.memory.attention(i);if(stale){notes.push(stale);continue;}
      const b=this.store.binding(String(latest?.binding_id??i.binding_id));
      const session=b?String(this.store.get(`name:${b.id}`)??b.alias):undefined;
      const asked=latest?.outcome==='blocked'?this.store.get(`blocked-text:${latest.id}`):undefined;
      const state=approval?'waiting for your native approval':observed??i.executionState;
      rows.push({ref:`#${i.id}`,title:i.title.slice(0,80),...(session?{session}:{}),state:i.status+(state===i.status?'':', '+state),...(asked?{asked:String(asked).slice(0,200)}:{})});
    }
    const out:string[]=[];
    if(rows.length===1){
      const r=rows[0]!;
      out.push(`📋 *${r.ref} ${r.title}*`);
      if(r.session)out.push(`- Session: ${r.session}`);
      out.push(`- State: ${r.state}`);
      if(r.asked)out.push(`- It asked: "${r.asked}"`);
    }else if(rows.length){
      out.push(`📋 *${rows.length} tasks*`);
      for(const r of rows)out.push(`- *${r.ref}* ${r.title}${[r.session,r.state].filter(Boolean).length?` · ${[r.session,r.state].filter(Boolean).join(' · ')}`:''}${r.asked?` · it asked: "${r.asked}"`:''}`);
    }
    out.push(...notes);
    return out.join('\n')||'No matching tracked tasks.';
  }
  /** Fast paths are literal, read-only owner intents. They never reinterpret consent. */
  private async localIntent(router:Router,m:Incoming) {
    const text=m.text.trim().replace(/[.!?]+$/,'').toLowerCase(),policy=brainPolicy(this.store),destination=this.store.destination();
    const key=`brain-choice:${destination}`,topic=this.store.get(`brain-topic:${destination}`),board=this.memory.board();
    const answer=(s:string)=>{this.answer(m.id,s);return true;};
    // "undo" only takes back a memory line this chat saved in the last 30 minutes.
    if(text==='undo'){let saved:{source:string;at:number}|undefined;try{saved=JSON.parse(this.store.get(`memory-last:${destination}`)??'null')??undefined;}catch{}
      if(saved&&Date.now()-saved.at<30*60000){this.store.set(`memory-last:${destination}`,'null');try{for(const c of this.owner.changes(saved.source).reverse())this.owner.undo(c.id);return answer('Done, I took that back out of your memory.');}catch(e){return answer((e as Error).message);}}}
    // Greetings skip the model, except while the brain still has to introduce itself.
    if(/^(?:(?:hey|hi|hello)(?: there)?|how are you(?: doing)?)$/.test(text)&&!this.owner.introNeeded()){
      const waiting=board.filter(i=>i.status==='waiting on owner'||i.status==='blocked');
      return answer(waiting.length?`Hi! ${waiting.length===1?'One item needs':`${waiting.length} items need`} you: ${waiting.slice(0,3).map(i=>`#${i.id} ${i.title}`).join(', ')}. Ask for your items, an update, or tell me what you want done.`:'Hi! Ask for your items, a task update, or tell me what you want done.');
    }
    const recent=RECENT_RE.exec(text);
    const list=/^(?:please )?(?:list|show|give me)(?: all)?(?: of)?(?: my| the)? (?:items|tasks)(?: list)?$/.test(text);
    const status=/^(?:any update(?:s)?(?: from that session)?|(?:what(?: is|'s) )?(?:the )?(?:status|progress)(?: of (?:that|it))?)$/.test(text)||STATUS_ONE_RE.test(text);
    const watch=/^(?:(?:okay|ok)[, ]+)?(?:please )?(?:let me know|notify me) (?:once|when) (?:it(?:'s| is|ls)?|that(?:'s| is)?) (?:done|finished|complete)$/.test(text);
    const cancel=/^(?:stop|cancel) (?:the )?(?:notification|notifications|follow-up)$/.test(text);
    const numeric=/^\d+$/.test(text);
    const bareTask=/^(?:task|item) (\d{1,5})$/.exec(text);
    const mentioned=bareTask?[Number(bareTask[1])]:mentionedItems(m.text,JSON.parse(this.store.get(`item-codes:${destination}`)??'{}'));
    const updateWord=/\b(?:upd\w*|status|progress|news)\b/.test(text);
    // "Ask update from codex" asks the session; "update on P1" reads the saved status.
    const ask=updateWord&&/^(?:please )?(?:ask|check with|ping|request)\b/.test(text);
    const named=!ask&&(updateWord||!!bareTask)&&mentioned.length>0;
    let choice:{kind:'status'|'watch'|'update';ids:number[];at:number;original?:string}|undefined;
    try{choice=JSON.parse(this.store.get(key)??'null')??undefined;}catch{}
    const restart=/^(?:start|send|resend|restart) (?:#\s?|item )?(\d{1,5}|[tpd]\d{1,3}) again$/.exec(text);
    if(restart)return this.restart(router,m,restart[1]);
    if(!recent&&!list&&!status&&!watch&&!cancel&&!ask&&!named&&!(numeric&&choice)){this.clearChoice();return false;}
    if(recent||list)this.clearChoice();
    if(!policy.allowStatus){this.stop(m.id,'Status summaries and follow-up notifications are disabled in Meta Settings.');return true;}
    if(recent){
      const provider=platformProvider(recent[1]),hours=Number(recent[2]);
      if(!provider)return answer('Choose a coding platform to list sessions for.');
      if(!hours||hours>168)return answer('Choose a time range between 1 and 168 hours.');
      if(!policy.providers.includes(provider)||!router.coordinator?.enabled().includes(provider))return answer('That coding platform is disabled in Settings.');
      try{return answer(await router.coordinator.recentSessions(provider,Date.now()-hours*3600000));}
      catch{return answer('Session discovery is unavailable. Nothing was dispatched; check the native app connection.');}
    }
    if(cancel){this.store.db.prepare("UPDATE brain_watches SET state='cancelled' WHERE destination IS ? AND state='waiting'").run(destination);return answer('Follow-up notifications cancelled. Tasks and sessions are unchanged.');}
    if(list)return answer(this.memory.items.text(true,board,`item-codes:${destination}`));
    let selected=board.filter(i=>i.ref===topic);
    let kind:'status'|'watch'|'update'=watch?'watch':ask?'update':'status';
    if(numeric&&choice){
      if(Date.now()-choice.at>30*60000){this.store.set(key,'null');return answer('That choice has expired. Ask for the task update again.');}
      const id=choice.ids[Number(text)-1];selected=board.filter(i=>i.id===id);kind=choice.kind;
      if(!selected.length)return answer('Choose one of the numbers in the last task question.');
      this.store.set(key,'null');
    }else if(mentioned.length){
      selected=board.filter(i=>mentioned.includes(i.id));
      if(!selected.length)return answer(`I can't find ${mentioned.length===1?`item #${mentioned[0]}`:'those items'} in this chat. Ask for your items to see the current codes.`);
    }else{
      const provider=platformProvider(PLATFORM_RE.exec(text)?.[0]);
      if(provider)selected=board.filter(i=>i.jobs.some(j=>this.store.binding(String(j.binding_id))?.provider===provider));
      if(!selected.length&&board.length===1)selected=board;
    }
    if(selected.length!==1){
      const options=(selected.length?selected:board).slice(0,8);
      if(!options.length)return answer('No tracked task in this chat yet. Tell me which task you mean.');
      this.store.set(key,JSON.stringify({kind,ids:options.map(i=>i.id),at:Date.now(),original:m.text}));
      return answer('Which task do you mean?\n'+options.map((i,n)=>`${n+1}. #${i.id} ${i.title}`).join('\n'));
    }
    const item=selected[0];this.store.set(`brain-topic:${destination}`,item.ref);
    if(kind==='update'){
      if(numeric&&!choice?.original)return answer('Ask for the update again so I can confirm the original session choice.');
      return this.requestUpdate(router,m,item,numeric?choice!.original:m.text);
    }
    if(kind==='status'){await this.refreshEvidence(router,selected);return answer(this.statusText(this.memory.board().filter(i=>i.id===item.id),router));}
    const job=item.jobs[0];
    if(!job)return answer('This task has not been sent to a session yet. I cannot watch for completion until it starts.');
    this.store.db.prepare("INSERT OR IGNORE INTO brain_watches(request_id,destination,item_id,job_id,created_at) VALUES(?,?,?,?,?)").run(m.id,destination,item.id,job.id,Date.now());
    return answer(`I’ll notify you when #${item.id} has a completion report or needs attention. The app must be running and connected.`);
  }
  /** Persisted watches only observe saved execution evidence. They never restart native work. */
  tick(router:Router) {
    const policy=brainPolicy(this.store);if(router.stopped||!policy.enabled||!policy.allowStatus)return;
    this.memory.synchronize();
    // Filtered and retired before the limit, so rows that can never fire don't hold back current ones.
    this.store.db.prepare("UPDATE brain_watches SET state='gone' WHERE state='waiting' AND (NOT EXISTS(SELECT 1 FROM items i WHERE i.id=item_id) OR NOT EXISTS(SELECT 1 FROM inbox j WHERE j.id=job_id))").run();
    // 100 per tick, taking turns, so unfinished watches never hold back the ones after them.
    // One cursor per chat: ticks run in whichever chat is current, and a shared one would reset another chat's turn.
    const destination=this.store.destination(),turn=this.watchTurn.get(destination)??0;
    const watches=this.store.db.prepare("SELECT * FROM brain_watches WHERE state='waiting' AND destination=? ORDER BY created_at,request_id LIMIT 100 OFFSET ?").all(destination,turn);
    this.watchTurn.set(destination,watches.length<100?0:turn+watches.length);
    for(const w of watches){
      const item=this.memory.item(Number(w.item_id),String(w.destination)),job=this.store.job(String(w.job_id));if(!item||!job)continue;
      const jobs=item.jobs.filter(j=>Number(j.created_at)>=job.created_at);
      const terminal=(j:typeof jobs[number])=>['completed','reviewed','auto_closed','replaced'].includes(String(j.status));
      const blocked=jobs.some(j=>j.outcome==='blocked'||['failed','uncertain'].includes(String(j.status)));
      const done=jobs.length>0&&jobs.every(j=>terminal(j)&&j.outcome==='done'&&this.store.db.prepare("SELECT 1 FROM reply_receipts WHERE request_id=? AND kind='final' AND origin='agent'").get(j.id));
      if(!blocked&&!done)continue;
      // The existing final already uses the durable delivery queue. Do not send a paraphrase.
      const covered=jobs.some(j=>this.store.db.prepare("SELECT 1 FROM outbox WHERE request_id=? AND reply_kind='final' AND destination=? AND status IN ('queued','sent')").get(j.id,w.destination));
      if(covered){this.store.db.prepare("UPDATE brain_watches SET state='covered-by-reply' WHERE request_id=?").run(w.request_id);continue;}
      const source=`brain-watch:${w.request_id}`;
      this.store.db.exec('SAVEPOINT brain_watch');
      try {
        this.store.outputBrain(String(w.request_id),`#${item.id} ${item.title}: ${blocked?'needs attention. Check the session before retrying.':'reported complete. This is the session’s report, not owner verification.'}`,source);
        this.store.db.prepare("UPDATE brain_watches SET state='notified' WHERE request_id=?").run(w.request_id);
        this.store.db.exec('RELEASE brain_watch');
      }catch(e){this.store.db.exec('ROLLBACK TO brain_watch; RELEASE brain_watch');throw e;}
    }
  }
  /**
   * Whether the deterministic device router would claim this message.
   *
   * Public because the router must ask before running its task-contract preflight: that
   * preflight is a second, narrower classifier with no device concept, and it intercepted
   * "press escape in Comet" before the brain ever saw the message, turning one keypress
   * into an owner-facing contract review. Cheap by construction: the shape test runs first,
   * so only device-shaped messages ever touch the driver, and its target list is cached.
   */
  async claimsDevice(router:Router,text:string):Promise<boolean>{
    if(!brainPolicy(this.store).enabled||!brainSelected(router))return false;
    // Two shapes must be claimed before any plan exists, or the contract flow takes them:
    // an inventory request ("show me opened apps") and a follow-up about the app just used
    // ("now write the notes"). Both reached the coding classifier on 2026-11-03 and came
    // back as "I could not update the contract".
    if(appInventoryRequest(text))return true;
    if(notesAuthoringRequest(text)&&this.lastDeviceApp())return true;
    if(!deviceVerbLike(text))return false;
    try{return detectDevicePlan(text,await deviceTargets(this.deviceControl()))!==null;}catch{return false;}
  }
  /**
   * The brain asked a question and the owner's next message is the answer.
   *
   * The router must know this before it hands the message to the task-contract flow: a
   * pending contract used to answer every turn, so "Yes make it open" (the answer to a
   * device question) became a coding contract and the two turns after it were swallowed
   * as contract edits (measured 2026-11-03).
   */
  awaitingAnswer(destination:string):boolean{return (this.store.db.prepare('SELECT state FROM brain_tasks WHERE destination IS ? ORDER BY created_at DESC LIMIT 1').get(destination) as {state?:string}|undefined)?.state==='clarification';}
  /** The app the owner last reached on this Mac, so a follow-up needs no app name. */
  lastDeviceApp():string|undefined{return this.deviceFact()?.app;}
  /**
   * The reviewed tools worth sending for this message, or undefined when none apply.
   *
   * Why a shortlist at all: the driver exposes 62 tools and the selector research is uniform
   * that accuracy falls past roughly 30 in one prompt, so the model is never handed the whole
   * surface. It gets the reviewed tools for the app the owner is in, which is also what makes
   * "remind me to buy milk later" reachable while Notes is on screen.
   *
   * Order and size come from `shortlistTools`: the lexical scorer decides, and on-device
   * embeddings may only append candidates for that same app. A failure here is never fatal:
   * the model simply gets no tool list and falls back to the actions it already had.
   */
  private async reviewedTools(text:string):Promise<{name:string;app:string;summary:string;args:{name:string;description:string;required:boolean}[];examples:string[]}[]|undefined>{
    try{
      const control=this.deviceControl();
      const front=await control.activeApp?.();
      const shortlist=await shortlistTools(text,{app:front});
      if(!shortlist.length)return undefined;
      return shortlist.map(entry=>({name:entry.tool.name,app:entry.tool.app,summary:entry.tool.description,args:entry.tool.args.map(arg=>({name:arg.name,description:arg.description,required:Boolean(arg.required)})),examples:entry.tool.examples}));
    }catch{return undefined;}
  }
  /**
   * The last thing the driver reported on this Mac, kept per destination. The model is
   * shown the app so a bare "write the notes" can name it, and the sentence is reused
   * verbatim when model prose would otherwise re-describe the same app from memory.
   * Expires, because app state an hour old is not a fact any more.
   */
  private deviceFact(){const raw=this.store.get(`brain-device-last:${this.store.destination()}`);if(!raw)return undefined;try{const v=JSON.parse(raw) as {app?:unknown;line?:unknown;ok?:unknown;at?:unknown};if(typeof v.line!=='string'||typeof v.at!=='number'||Date.now()-v.at>DEVICE_FACT_MS)return undefined;return {app:typeof v.app==='string'&&v.app?v.app:undefined,line:v.line,ok:v.ok===true};}catch{return undefined;}}
  /**
   * The driver's own sentence, when it is the one that should answer.
   *
   * The model has no app state of its own, so a reply that describes app state for the
   * app the driver just handled is replaced by what the driver reported. Ordinary prose is
   * left alone: only a state word in the model's reply makes it a claim about the Mac.
   */
  private deviceFactLine(m:Incoming,reply:string){
    const fact=this.deviceFact();if(!fact)return undefined;
    if(fact.app&&!m.text.toLowerCase().includes(fact.app.toLowerCase()))return undefined;
    return /\b(?:open|opened|closed|running|launch(?:ed|ing)?|ready|drawn|window|displayed)\b/i.test(reply)?fact.line:undefined;
  }
  /** The driver is started on first use: a brain that never controls the Mac never starts it. */
  private deviceControl():DeviceControl {return this.device??=this.injectedDevice??new DesktopControl(this.store);}
  /**
   * The owner asked for something on the Mac itself.
   *
   * Answered here rather than dispatched: no coding session can open an app on this
   * Mac, so turning this into a task would lose it silently. The reply is written
   * from what the driver reported, never from what the model guessed.
   */
  private async runDevice(router:Router,m:Incoming,decision:Interpretation,policy:BrainPolicy){
    const plan=decision.device;
    if(!plan){this.stop(m.id,'Tell me the one thing to do on your Mac, like "open Comet" or "press escape".','clarification');return true;}
    return await this.executeDevice(router,m,plan,policy);
  }
  /**
   * Execute one device plan and report facts.
   *
   * Shared by the model path and the deterministic one, so both obey the same selection
   * rule and produce the same reply.
   */
  private async executeDevice(router:Router,m:Incoming,plan:DevicePlan,policy:BrainPolicy){
    if(!brainSelected(router)){this.stop(m.id,'Your messages are going to a session right now, not to me. Send /brain and ask again, or send this to the session with /codex or /claude. Nothing was sent.','clarification');return true;}
    const authorize=()=>{this.store.assertIncomingOwner();if(router.stopped||JSON.stringify(brainPolicy(this.store))!==JSON.stringify(policy))throw new Error('Brain authority changed.');};
    const outcome=await runDevicePlan(this.deviceControl(),plan,`brain:${m.id}`,authorize);
    if(router.stopped||this.get(m.id)?.state!=='interpreting')return true;
    // Codes only: a request event excludes driver text by design, and the owner's reason
    // is a sentence written for them, not the log line.
    this.store.event(m.id,'device_action',{action:plan.action,outcome:outcome.ok?'done':'blocked',...(outcome.code?{code:outcome.code}:{})});
    this.store.set(`brain-device-last:${this.store.destination()}`,JSON.stringify({app:plan.app??null,line:outcome.line,ok:outcome.ok,at:Date.now()}));
    this.store.db.prepare("UPDATE brain_tasks SET state='answered',permission='allowed' WHERE id=?").run(m.id);
    this.store.outputBrain(m.id,[outcome.line,...(outcome.evidence?[outcome.evidence]:[])].join('\n\n').slice(0,900));
    return true;
  }
  async handle(router:Router,m:Incoming,strict=false):Promise<boolean> {
    if(!this.store.incomingOwnerCurrent())return true;
    const policy=brainPolicy(this.store);
    if(!policy.enabled)return false;
    // IDs from internal delegation/reports cannot masquerade as owner input. The app's own
    // composer is owner input: its id is only trusted with the single-use claim the admin
    // route mints, which a transported wa:/tg:-style id can never carry.
    const shaped=this.store.ownerInputId(m.id);
    if(!shaped||this.store.get(`parent:${m.id}`)||this.store.get(`report-parent:${m.id}`))return false;
    const origin=m.activityScope;
    const observeMeta=origin?metaObserver(this.store,'sorted',origin.destination,origin.owner):undefined;
    const prior=this.get(m.id);
    if(prior){if(prior.original!==m.text||prior.destination!==this.store.destination())throw new Error('Owner event identity was reused.');if(prior.state==='interpreting')this.stop(m.id,'Interpretation was interrupted. No automatic retry was made; send a new message when ready.');return true;}
    this.store.db.prepare("INSERT INTO brain_tasks(id,original,source,destination,state,permission,created_at) VALUES(?,?,?,?,'interpreting','pending',?)").run(m.id,m.text,m.source??'text',this.store.destination(),Date.now());
    const revoked=()=>{if(this.store.incomingOwnerCurrent())return false;this.store.db.prepare("UPDATE brain_tasks SET state='blocked',permission='denied',reason='Owner connection changed; no automatic retry' WHERE id=? AND state='interpreting'").run(m.id);return true;};
    prepareSpecialties(this.store);
    const mode=router.guidedModes.get(router,m);
    if(mode?.kind==='social')mode.imageProvider=requestedSocialImageProvider(m.text)??mode.imageProvider??'local';
    const routingSnapshot=()=>JSON.stringify([specialtyEpoch(this.store),router.guidedModes.get(router,m)]);
    const routingAtStart=routingSnapshot();
    if(mode)this.store.set(`brain-mode:${m.id}`,router.guidedModes.summary(router,m));
    const routingChanged=()=>{if(routingSnapshot()===routingAtStart)return false;this.stop(m.id,'Executor or task mode changed while Brain was routing. Nothing was sent; send a new message.');return true;};
    this.memory.synchronize();
    let handled:boolean;
    try{handled=await this.localIntent(router,m);}catch(e){if(revoked())return true;throw e;}
    if(revoked()||routingChanged())return true;if(handled)return true;
    let decision:Interpretation;const interpretationStarted=Date.now();
    const board=this.memory.board();
    const topicKey=`brain-topic:${this.store.destination()}`;
    // Device control follows the owner's selection rather than a second setting: /brain
    // means the brain acts, /codex or /claude means the chosen session does through the
    // desktop tools it already has. Read the targets only when it is ours, so a message
    // aimed at a session never starts the desktop driver.
    const mine=brainSelected(router);
    const devices=mine?await deviceTargets(this.deviceControl()):undefined;
    // Only the reviewed tools for the app in front are offered, and only when the owner's
    // message matches them. The model picks from that list or falls back to the five actions.
    const appTools=mine?await this.reviewedTools(m.text):undefined;
    // An unambiguous device command is executed in code, before the model is asked: the
    // measured failure was the model choosing coding work for "press escape in Comet",
    // which turned a Mac request into a task-contract review.
    const last=mine?this.lastDeviceApp():undefined;
    if(mine){
      const direct=detectDevicePlan(m.text,devices??[]);
      if(direct)return await this.executeDevice(router,m,direct,policy);
      // "check my notes" or "chek my calender" is a read with one answer; the model used to
      // answer it from window chrome or not at all (owner chat, 4 November 2026).
      const overview=overviewTool(m.text);
      if(overview)return await this.executeDevice(router,m,{action:'app_tool',tool:overview.name,app:overview.app,args:{}},policy);
      // "now write the notes" names no app, so no pattern can match it. The app the owner
      // last used is the target; the text is theirs verbatim. Nothing is invented: if the
      // driver cannot reach that app, its report is what the owner reads. When that app is
      // Notes the reviewed Notes tool does the write, because a blind type landed in the
      // search field and was reported to the owner as if it had been written down.
      const written=notesAuthoringRequest(m.text)?authoringText(m.text):undefined;
      if(written&&last)return await this.executeDevice(router,m,notesWritePlan(last,written),policy);
    }
    try {
      const key=this.secret.read();if(!key)throw Object.assign(new Error('Meta API key is missing. Configure it in desktop Settings.'),{code:'configuration_missing'});
      // Consent is read when the model calls the tool, not when the request began: switching learning off mid-call stops writes.
      const authorize=()=>{this.store.assertIncomingOwner();if(router.stopped||JSON.stringify(brainPolicy(this.store))!==JSON.stringify(policy))throw new Error('Brain authority changed.');};
      const memoryTool=(i:Parameters<MemoryTool>[0])=>{authorize();return this.owner.command(i,`brain:${m.id}`,policy.learn);};
      decision=Interpretation.parse(await this.model.interpret(key,policy,{original:m.text,taskMode:mode?.kind,imageProvider:mode?.imageProvider,conversation:this.conversation(m.id),source:m.source??'text',tasks:[...board.slice(0,60).map(i=>({id:i.ref,title:i.title,status:`${i.status}; execution: ${i.executionState}`})),...this.tasks(this.store.destination()).filter(t=>t.id!==m.id&&!this.store.itemOf(t.id)&&!['answered','managed'].includes(t.state)).slice(0,20).map(t=>({id:t.id,title:t.original.slice(0,300),status:t.status}))],sessions:this.memory.candidates(router).map(b=>({id:b.id,name:this.store.get(`name:${b.id}`)??b.alias,provider:b.provider,enabled:!!b.enabled})),deviceControl:mine?'brain' as const:'session' as const,...(mine&&last?{lastDeviceApp:last}:{}),...(appTools?.length?{appTools}:{}),...(mine?{now:localStamp()}:{}),...(devices?.length?{devices}:{}),activeTaskId:this.store.get(topicKey),memory:this.owner.always(),...(this.owner.introNeeded()?{intro:'needed' as const}:{}),itemCodes:Object.fromEntries(Object.entries(JSON.parse(this.store.get(`item-codes:${this.store.destination()}`)??'{}') as Record<string,number>).map(([k,v])=>[k,`item:${v}`])),needsOwner:board.filter(i=>i.status==='waiting on owner'||i.status==='blocked').slice(0,10).map(i=>({id:i.ref,title:i.title,why:this.memory.gone(i.jobs[0])??i.executionState}))},memoryTool,authorize,observeMeta));
      this.store.event(m.id,'brain_interpreted',{durationMs:Date.now()-interpretationStarted});
    }catch(e) {
      if(revoked()||routingChanged())return true;
      const raw=(e as {code?:unknown})?.code,code=typeof raw==='string'?raw:errorCode(e);
      this.store.event(m.id,'brain_interpretation_failed',{code,durationMs:Date.now()-interpretationStarted});
      if(this.get(m.id)?.state!=='interpreting')return true;
      // Policy changes during an HTTP call revoke its result; never silently resume under old consent.
      if(JSON.stringify(brainPolicy(this.store))!==JSON.stringify(policy)||router.stopped){this.stop(m.id,'Meta routing stopped because Settings changed or forwarding paused.');return true;}
      if(policy.failure==='legacy'&&!strict){
        this.store.db.prepare("UPDATE brain_tasks SET state='legacy',permission='legacy',reason='Meta unavailable; owner-selected legacy fallback' WHERE id=?").run(m.id);
        return false;
      }
      this.stop(m.id,!this.secret.present()?'Meta API key is missing. Add it in the Brain page, or turn the brain off.'
        :code==='authentication_required'?'Meta rejected your API key. Replace it in the Brain page, then send your message again.'
        :code==='timeout'?'Meta took too long to answer. Send your message again.'
        :'Meta could not read that message right now. Send it again in a moment.');return true;
    }
    if(revoked()||this.get(m.id)?.state!=='interpreting'||routingChanged())return true;
    this.store.db.prepare('UPDATE brain_tasks SET normalized=? WHERE id=?').run(decision.normalized,m.id);
    this.announce(m);
    if(JSON.stringify(brainPolicy(this.store))!==JSON.stringify(policy)||router.stopped){this.stop(m.id,'Meta routing stopped because Settings changed or forwarding paused.');return true;}
    // Model wording is only allowed for questions and small talk; claims always come from saved data.
    // No dash rule here: both branches below go through outputBrain, where ownerReply applies it
    // once. A second copy would silently stop applying when that one changes.
    const said=this.deviceFactLine(m,decision.reply??'')??(decision.reply??'').trim().slice(0,400);
    if(decision.intent==='clarify') {this.stop(m.id,said||'Please clarify the task and which coding platform you want. Nothing has been dispatched.','clarification');return true;}
    if(decision.intent==='chat') {this.store.db.prepare("UPDATE brain_tasks SET state='answered',permission='allowed' WHERE id=?").run(m.id);this.store.outputBrain(m.id,said||'Send a task, or ask where are we.');return true;}
    if(decision.intent==='device') return await this.runDevice(router,m,decision,policy);
    if(decision.intent==='manage') {
      if(!policy.allowManagement){this.stop(m.id,'Task and session management is disabled in Meta Settings.');return true;}
      this.store.db.exec('SAVEPOINT brain_manage');
      try {
        const response=this.memory.manage(router,m,decision);
        this.store.db.prepare("UPDATE brain_tasks SET state='managed',permission='allowed' WHERE id=?").run(m.id);
        const item=this.store.itemOf(m.id);if(item)this.store.set(topicKey,`item:${item}`);
        this.store.outputBrain(m.id,response);
        this.store.remember(m.id);
        this.store.db.exec('RELEASE brain_manage');
      }catch(e){this.store.db.exec('ROLLBACK TO brain_manage; RELEASE brain_manage');this.stop(m.id,(e as Error).message,'clarification');}
      return true;
    }
    if(decision.intent==='update') {
      if(!policy.allowStatus){this.stop(m.id,'Status summaries are disabled by your Meta brain policy.');return true;}
      const picked=decision.taskIds.length===1?this.memory.board().find(i=>i.ref===decision.taskIds[0]||this.store.itemOf(decision.taskIds[0])===i.id):undefined;
      if(!picked){this.stop(m.id,'Which item should I ask about? Ask for your items and name its code, like P1.','clarification');return true;}
      return this.requestUpdate(router,m,picked);
    }
    if(decision.intent==='status') {
      if(!policy.allowStatus){this.stop(m.id,'Status summaries are disabled by your Meta brain policy.');return true;}
      const relevant=this.memory.board().filter(i=>!decision.taskIds.length||decision.taskIds.some(ref=>ref===i.ref||this.store.itemOf(ref)===i.id));
      await this.refreshEvidence(router,relevant);
      if(revoked())return true;
      const selectedItems=this.memory.board().filter(i=>!decision.taskIds.length||decision.taskIds.some(ref=>ref===i.ref||this.store.itemOf(ref)===i.id));
      if(selectedItems.length===1)this.store.set(topicKey,selectedItems[0].ref);
      const rows=this.tasks(this.get(m.id)!.destination).filter(t=>t.id!==m.id&&!this.store.itemOf(t.id)&&!['answered','managed'].includes(t.state)&&(!decision.taskIds.length||decision.taskIds.includes(t.id))).slice(0,20);
      if(selectedItems.length) {
        const text=this.statusText(selectedItems,router);
        this.store.db.prepare("UPDATE brain_tasks SET state='answered',permission='allowed' WHERE id=?").run(m.id);
        this.store.outputBrain(m.id,text);return true;
      }
      this.store.db.prepare("UPDATE brain_tasks SET state='answered',permission='allowed' WHERE id=?").run(m.id);
      // Model selects relevant rows; only deterministic persisted evidence supplies claims.
      // Same reason as `statusText`: the facts are unchanged, the layout is the owner's.
      const listed=rows.map(t=>{
        const title=t.original.replace(/\s+/g,' ').slice(0,100);
        const alias=t.coordinator_id?this.store.binding(t.coordinator_id)?.alias??'a saved session':undefined;
        const child=t.evidence.children.map(c=>`${this.store.binding(String(c.binding_id))?.alias??'a saved session'} ${c.status}${c.outcome?` (${c.outcome}, reported)`:''}`).join(', ');
        return `- ${title}${title.length>=100?'...':''} · ${t.status}${alias?` · ${alias}`:''}${child?` · delegated to ${child}`:''}`;
      });
      this.store.outputBrain(m.id,rows.length?[`📋 *${rows.length===1?'1 task':`${rows.length} tasks`}*`,...listed].join('\n'):'No matching tracked tasks.');return true;
    }
    if(!policy.allowRouting){this.stop(m.id,'Routing is disabled by your Meta brain policy.');return true;}
    const c=router.coordinator;if(!c){this.stop(m.id,'Connect an existing coordinator in Coding platforms first.');return true;}
    let target:Binding|undefined,coordinator:Binding|undefined,topic:ReturnType<BrainMemory['resolve']>|undefined;
    try {
      // The original text, never cleaned-up consent, controls explicit platform constraints.
      const named=namedPlatforms(m.text);
      if(named.length>1)throw new Error('Please choose one coding platform for this request.');
      if(named.length&&decision.provider!=='unspecified'&&named[0]!==decision.provider)throw new Error('The platform interpretation conflicts with your original message. Please clarify.');
      // Display names and aliases of any length name a session: "UX", "开发", "claude-proxy" as surely as "Payments API".
      const norm=(t:string)=>t.normalize('NFKC').replace(/[‘’]/g,"'").replace(/\s+/g,' ').trim().toLowerCase();
      const esc=(t:string)=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),said=norm(m.text);
      const hit=(n:string)=>/[^\x00-\x7f]/.test(n)?said.includes(n):new RegExp(`(?:^|[^a-z0-9])${esc(n)}(?:[^a-z0-9]|$)`).test(said);
      const mentioned=this.memory.candidates(router).filter(b=>[this.label(b),b.alias].map(norm).some(n=>n&&!PLATFORM_WORDS.some(([,words])=>words.includes(n))&&hit(n)));
      if(mentioned.length>1)throw new Error('Your message names more than one session. Please choose one with /claude list or /codex list. Nothing was sent.');
      // Wording can exclude a destination without naming it ("not the session that worked on this"), so a named session, or a negation
      // next to destination words, is ambiguous: the owner is asked and nothing is sent.
      // Checked per clause, so "Codex, fix it. Do not publish" still goes straight to Codex.
      const negated=/\b(?:not|no|never|except|avoid|instead|without|exclude|nobody|nowhere|other than|anyone but|away from)\b|n't\b|[不别勿]/;
      const destinationWord=new RegExp(`\\b(?:send|sent|forward|route|give|assign|pass|hand|session|coordinator|agent|worker|platform|${PLATFORM_ALTERNATION}|anywhere|anyone|someone|elsewhere)\\b|[发给派]`,'i');
      const ambiguous=mentioned.length>0||said.split(/[.,;:!?\n。，；！？]+/).some(clause=>negated.test(clause)&&destinationWord.test(clause));
      const provider=named[0]??(decision.provider==='unspecified'?undefined:decision.provider);
      // A model may pick a platform the owner didn't name only by following the owner's collaboration.md rules.
      if(!named.length&&!mentioned.length&&decision.provider!=='unspecified'&&!this.owner.collaborates())throw new Error('Please name the coding platform you want, or use your default coordinator.');
      if(decision.taskIds.length>1)throw new Error('Please choose one topic before forwarding this follow-up.');
      if(decision.taskIds.length)topic=this.memory.resolve(decision.taskIds[0]);
      target=topic?this.memory.owner(topic,router):undefined;
      if(mentioned.length&&target&&target.id!==mentioned[0].id)throw new Error('That task belongs to another session. Please clarify whether you want to change its assignment.');
      // An item nobody owns yet goes to the session the owner named, never the default coordinator.
      target??=mentioned[0];
      // A replaced or paused owner is never silently swapped for the current proxy.
      const stale=topic&&this.memory.attention(this.memory.board().find(i=>i.id===topic!.id)!);if(stale)throw new Error(stale);
      if(target&&provider&&target.provider!==provider)throw new Error('This topic belongs to another platform. Please clarify whether you want to change its assignment.');
      if(!target)target=provider?c.registry.choose(provider,/\bdesktop\b/i.test(m.text)?'desktop':/\bcli\b/i.test(m.text)?'cli':undefined):c.master();
      if(!target?.enabled||!policy.providers.includes(target.provider)||!c.enabled().includes(target.provider))throw new Error('The selected platform is paused or denied by your routing policy.');
      coordinator=c.isCoordinator(target.id)?target:c.registry.bindingFor(target);
      if(!coordinator?.enabled||c.registry.identity(coordinator).key!==c.registry.entry(coordinator.id)?.key)throw new Error('Coordinator account or runtime changed. Review Coding platforms.');
      if(!c.isCoordinator(target.id)&&!c.selected().some(b=>b.id===target!.id))throw new Error('The owning session is not connected. Connect that exact session first.');
      if(this.store.get(`native-history-error:${target.id}`))throw new Error('The coordinator connection needs attention in Coding platforms.');
      // Asking is the whole answer: a later "yes" can't be tied safely to this question, the session or the item, so nothing is held for it.
      if(ambiguous)throw new Error(`Please clarify where this should go. Did you mean ${this.label(target)}? To send it there, use /to ${target.alias} and your message${topic?` (it won't be filed under item #${topic.id})`:''}, or choose with /claude list or /codex list. Nothing was sent.`);
    }catch(e){const reason=(e as Error).message;this.stop(m.id,reason,/clarify|choose|name the coding platform|again" to send/i.test(reason)?'clarification':'blocked');return true;}
    this.send(router,m.id,m.text,target,coordinator,topic,m);
    return true;
  }
  private label(b:Binding){return this.store.get(`name:${b.id}`)??b.alias;}
  private send(router:Router,id:string,text:string,target:Binding,coordinator:Binding,topic?:ReturnType<BrainMemory['resolve']>,incoming?:Incoming) {
    this.store.db.exec('SAVEPOINT brain_dispatch');
    try {
      // Queue original verbatim. Normalized wording is advisory ledger data, never an authorization source.
      // A pre-existing topic must be linked before a contract binds the request to an item.
      if(topic){const linked=this.store.itemOf(id);if(linked&&linked!==topic.id)throw new Error('Request belongs to another item.');this.memory.link(id,topic.id);}
      const mode=incoming?router.guidedModes.get(router,incoming):undefined;
      if(mode&&incoming)captureGuidedResearchRequest(this.store,router,incoming,mode.kind);
      const provider=mode?.kind==='social'?(requestedSocialImageProvider(text)??mode.imageProvider??'local'):undefined;
      const instructions=mode?(mode.kind==='social'?socialSpecialty(provider):mode.kind==='research'?researchSpecialty():jobsSpecialty()):undefined;
      if(mode&&instructions)markPendingSpecialty(this.store,id,target,mode.kind,instructions,text,provider);
      this.store.set(`brain-routed:${id}`,'true');
      router.queue(id,target,text);
      if(mode){
        bindSessionSpecialty(this.store,id,target,mode.kind,instructions!,provider);
        if(mode.kind==='social'){mode.imageProvider=provider;router.guidedModes.end(mode,router,incoming!);}
      }
      const existing=this.store.itemOf(id);
      const item=topic??(existing?this.memory.items.get(existing):this.memory.add(id,text));
      this.memory.link(id,item.id);
      if(!item.binding_id)this.memory.items.setSession(item.id,target.id,'Brain');
      // The owner's follow-up answers a block the Brain recorded from job evidence; blocks set by the owner, a coordinator or anyone else stay.
      if(['not started','done','waiting on owner'].includes(item.status)||item.status==='blocked'&&this.memory.items.statusBy(item.id)==='Brain evidence')this.memory.items.setStatus(item.id,'in progress','Brain');
      this.store.set(`brain-topic:${this.store.destination()}`,`item:${item.id}`);
      this.store.db.prepare("UPDATE brain_tasks SET coordinator_id=?,target_session_id=?,state='queued',permission='allowed' WHERE id=?").run(coordinator.id,target.id,id);
      this.store.remember(id);
      this.store.db.exec('RELEASE brain_dispatch');return true;
    }catch{this.store.db.exec('ROLLBACK TO brain_dispatch; RELEASE brain_dispatch');this.stop(id,'Dispatch could not be queued. Check the saved request before sending a new message.');return false;}
  }
}
