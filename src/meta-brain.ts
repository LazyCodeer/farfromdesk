import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { appendFileSync, existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { stateDir } from './config.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';
import { basename, join, sep } from 'node:path';
import {captureGuidedResearchRequest} from './agent-reach-request.js';
import {bindSessionSpecialty,prepareSpecialties,specialtyEpoch,markPendingSpecialty} from './session-specialty.js';
import {socialSpecialty} from './social-agent.js';
import {requestedSocialImageProvider} from './social-image-provider.js';
import { BrainMemory } from './brain-memory.js';
import type { Store, Binding } from './store.js';
import type { Incoming, Router } from './router.js';
import { brainPolicy, brainView, MetaSecret, type BrainPolicy, type BrainProvider } from './meta-brain-config.js';
import { BRAIN_PROMPT, Interpretation, MetaModel, type MemoryTool } from './meta-model.js';
import { runDevicePlan, deviceRefusal, deviceTargets, detectDevicePlan, deviceVerbLike, appInventoryRequest, notesAuthoringRequest, authoringText, notesWritePlan, type DeviceControl, type DevicePlan } from './brain-device.js';
import { DesktopControl } from './desktop-control.js';
import { mentionedItems } from './owner-routing.js';
import { brainSelected } from './owner-commands.js';
import { overviewTool, selectTools, shortlistTools } from './app-tools/retrieve.js';
import { allPackTools, toolByName } from './app-tools/packs.js';
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
const PLATFORM_RE_ALL=new RegExp(`\\b(?:${PLATFORM_ALTERNATION})\\b`,'gi');
/**
 * Fast-path phrasings that carry a platform name. These must be built with the RegExp constructor:
 * a regex literal never interpolates ${...}, so a platform name spliced into a literal silently
 * matches nothing at all - the phrase then falls through to the model instead of the fast path.
 */
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
  constructor(private store:Store,readonly secret=new MetaSecret(),private model:Pick<MetaModel,'interpret'>&Partial<Pick<MetaModel,'compose'>>=new MetaModel(),private injectedDevice?:DeviceControl) {
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
  /** The brain asked the owner a question, so a bare number answers it, never a stale session menu. */
  hasChoice() {return brainPolicy(this.store).enabled&&this.awaitingAnswer(this.store.destination()??'');}
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
  private requestUpdate(router:Router,m:Incoming,item:ReturnType<BrainMemory['board']>[number],original=m.text,provider?:string) {
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
    // A platform the brain carried over from an earlier turn ("ask claude", then "1") constrains it too.
    const named=[...new Set([...namedPlatforms(original),...(provider&&provider!=='unspecified'?[provider]:[])])];
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
  /**
   * Owner operations the brain chose (decision.operation). These used to be matched by patterns
   * before the model ran ("undo", "notify me when it's done", "start #3 again"); now the model
   * decides and this code does exactly what those patterns did. Undefined means not an operation.
   */
  private async ownerOperation(router:Router,m:Incoming,decision:Interpretation):Promise<boolean|undefined>{
    const op=decision.operation,policy=brainPolicy(this.store),destination=this.store.destination();
    if(!op||!['undo_memory','watch','stop_watching','restart','recent_sessions','list_items'].includes(op))return undefined;
    const answer=(s:string)=>{this.answer(m.id,s);return true;};
    if(op==='undo_memory'){
      // Only a memory line this chat saved in the last 30 minutes.
      let saved:{source:string;at:number}|undefined;try{saved=JSON.parse(this.store.get(`memory-last:${destination}`)??'null')??undefined;}catch{}
      if(!saved||Date.now()-saved.at>=30*60000)return answer('There is nothing recent in your memory to take back.');
      this.store.set(`memory-last:${destination}`,'null');
      try{for(const c of this.owner.changes(saved.source).reverse())this.owner.undo(c.id);return answer('Done, I took that back out of your memory.');}catch(e){return answer((e as Error).message);}
    }
    const board=this.memory.board(),ref=decision.taskIds[0];
    const item=ref?board.find(i=>i.ref===ref||this.store.itemOf(ref)===i.id):undefined;
    if(op==='restart'){if(!item)return answer('Which item should I start again? Ask for your items to see the codes.');return this.restart(router,m,String(item.id));}
    if(!policy.allowStatus){this.stop(m.id,'Status summaries and follow-up notifications are disabled in Meta Settings.');return true;}
    if(op==='recent_sessions'){
      const provider=decision.provider==='unspecified'?undefined:decision.provider,hours=decision.hours??24;
      if(!provider)return answer('Which coding platform should I list sessions for?');
      if(!policy.providers.includes(provider)||!router.coordinator?.enabled().includes(provider))return answer('That coding platform is disabled in Settings.');
      try{return answer(await router.coordinator.recentSessions(provider,Date.now()-hours*3600000));}
      catch{return answer('Session discovery is unavailable. Nothing was dispatched; check the native app connection.');}
    }
    // The coded list (P1, D2) the owner reads is what later "update on P1" resolves against.
    if(op==='list_items')return answer(this.memory.items.text(true,board,`item-codes:${destination}`));
    if(op==='stop_watching'){this.store.db.prepare("UPDATE brain_watches SET state='cancelled' WHERE destination IS ? AND state='waiting'").run(destination);return answer('Follow-up notifications cancelled. Tasks and sessions are unchanged.');}
    if(!item)return answer('Which task should I watch? Ask for your items to see the codes.');
    this.store.set(`brain-topic:${destination}`,item.ref);
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
  /** With the brain selected it decides when coding work needs a review, so the router runs none first. */
  decidesContracts(router:Router):boolean{return brainPolicy(this.store).enabled&&brainSelected(router)&&this.secret.present();}
  private pendingContract(router:Router):boolean{const owner=this.store.ownerFor(this.store.destination());return !!owner&&!!router.contracts?.hasPendingOwner(owner,this.store.destination()??'');}
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
  /**
   * Every reviewed tool, compact: what OpenClaw does with its skills list. The model decides; a
   * matcher only orders the list so the likeliest tools come first.
   */
  private async reviewedTools(text:string):Promise<{name:string;app:string;writes:boolean;summary:string;args:{name:string;description:string;required:boolean}[]}[]|undefined>{
    try{
      const front=await this.deviceControl().activeApp?.();
      const rank=(await shortlistTools(text,{app:front})).map(entry=>entry.tool.name);
      const at=(name:string)=>{const i=rank.indexOf(name);return i<0?rank.length:i;};
      const all=allPackTools().sort((x,y)=>at(x.name)-at(y.name));
      return all.map(tool=>({name:tool.name,app:tool.app,writes:tool.writes,summary:tool.description.split('. ')[0].slice(0,220),args:tool.args.map(arg=>({name:arg.name,description:arg.description.slice(0,140),required:Boolean(arg.required)}))}));
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
    // A device answer is the tool's own words, and a listing of the owner's notes needs more
    // room than a sentence: measured live on 4 November 2026, a 900-character cap cut a
    // "summarise all my notes" answer to the first seven notes and hid the rest. 1800 still
    // fits one chat message and covers a twenty-note listing.
    this.store.outputBrain(m.id,await this.explain(m,policy,{app:plan.app,tool:plan.tool,action:plan.action},outcome));
    return true;
  }
  /**
   * The owner's answer, written from what the tool read.
   *
   * Measured live on 4 November 2026: the raw tool output was pasted into the chat, twice, as one
   * run-on block of folder names and timestamps, with a private-key note's title in it. A
   * companion reads the result and explains it. The model only words what the tool returned; when
   * it is unavailable the result is still shown, once, and tidied.
   */
  private async explain(m:Incoming,policy:BrainPolicy,what:Record<string,unknown>,outcome:{ok:boolean;line:string;evidence:string|null}):Promise<string>{
    const evidence=outcome.evidence?.trim()??'';
    const plain=(!evidence||evidence.startsWith(outcome.line.trim().slice(0,120))||outcome.line.trim().startsWith(evidence.slice(0,120))?evidence||outcome.line:`${outcome.line}\n\n${evidence}`).slice(0,1800);
    if(!outcome.ok||!evidence)return plain;
    const key=this.secret.read();if(!key)return plain;
    try{
      if(!this.model.compose)return plain;const written=(await this.model.compose(key,policy,DEVICE_ANSWER_PROMPT,{request:m.text,...what,now:localStamp(),result:evidence.slice(0,14000)},20000)).trim();
      return written?written.slice(0,3000):plain;
    }catch{return plain;}
  }
  /** "what tabs are open": every supported browser that is running, plus Safari, as one answer. */
  /**
   * The first sign of life for a request that needs the Mac: sent once, when the first tool starts,
   * so the owner knows the brain has it and what it is doing before the answer is ready.
   */
  private acked=new Set<string>();
  private ack(m:Incoming,what:string){
    if(this.acked.has(m.id))return;this.acked.add(m.id);if(this.acked.size>500)this.acked.clear();
    try{this.store.output(undefined,`🧠 Checking ${what}…`,`brain-ack:${m.id}`,this.store.destination(),{kind:'system',origin:'system',plain:true});}catch{}
  }
  /** Screenshots taken for a request, sent after its answer. */
  private files=new Map<string,{bytes:Buffer;name:string}[]>();
  /**
   * send_file: a file from the owner's own folders to their own chat, after the reply. Only
   * Downloads, Desktop, Documents, Pictures, Movies and Music; never hidden folders or Library,
   * never a link that leads outside them, at most 50 MB ("Send me 3.jpg from downloads", live).
   */
  private sendFileFor(m:Incoming,raw:string):string{
    const home=userInfo().homedir,roots=['Downloads','Desktop','Documents','Pictures','Movies','Music'].map(d=>join(home,d));
    const asked=raw.trim().replace(/^~(?=\/|$)/,home);
    const path=asked.startsWith('/')?asked:join(home,'Downloads',asked);
    let real:string;try{real=realpathSync(path);}catch{return `No file at ${raw}. Use the Finder tools to find its exact path.`;}
    const root=roots.find(r=>real.startsWith(r+sep));
    if(!root||real.slice(root.length).split(sep).some(part=>part.startsWith('.')))return 'I can send files only from Downloads, Desktop, Documents, Pictures, Movies or Music, and never hidden ones.';
    const st=lstatSync(real);if(!st.isFile())return `${basename(real)} is a folder, not a file.`;
    if(st.size>50_000_000)return `${basename(real)} is over 50 MB, which is more than the chat accepts.`;
    const list=this.files.get(m.id)??[];if(list.length>=5)return 'At most five files per message.';
    list.push({bytes:readFileSync(real),name:basename(real)});this.files.set(m.id,list);
    return JSON.stringify({queued:basename(real),bytes:st.size,note:'It is sent to the owner right after your reply. Say it follows.'});
  }
  /**
   * The newest Social drafts, so "post the one you just made" uses that draft's own caption and image.
   * The chat history can hold an older caption (live, 5 Nov 2026: LinkedIn got the previous post's text).
   * Each finished image is written once to Downloads for pick_file.
   */
  private socialDraftsFor():string{
    if(!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='social_drafts'").get())return 'No social drafts yet.';
    const rows=this.store.db.prepare('SELECT id,json FROM social_drafts ORDER BY rowid DESC LIMIT 3').all() as {id:string;json:string}[];
    if(!rows.length)return 'No social drafts yet.';
    const downloads=join(userInfo().homedir,'Downloads');
    return JSON.stringify(rows.map(row=>{
      const d=JSON.parse(row.json),slides=(d.carousel?.slides??(d.image?[d.image]:[])) as {base64?:string}[];
      const images=slides.slice(0,10).flatMap((slide,i)=>{
        if(!slide?.base64)return [];
        const file=join(downloads,`farfromdesk-${String(d.platform??'post').toLowerCase().replace(/[^a-z0-9]+/g,'-')}-${row.id.slice(0,8)}-${i+1}.jpg`);
        try{if(!existsSync(file))writeFileSync(file,Buffer.from(slide.base64,'base64'));return [file];}catch{return [];}
      });
      return {platform:d.platform??null,caption:typeof d.caption==='string'?d.caption:'',images};
    }));
  }
  /** The owner's folders the brain may put or open files in: never hidden ones, never Library. */
  private ownerPath(raw:string,base:'Downloads'|'Documents'='Downloads'):string|undefined{
    const home=userInfo().homedir,roots=['Downloads','Desktop','Documents','Pictures','Movies','Music'].map(d=>join(home,d));
    const asked=raw.trim().replace(/^~(?=\/|$)/,home),path=asked.startsWith('/')?asked:/^(Downloads|Desktop|Documents|Pictures|Movies|Music)\//.test(asked)?join(home,asked):join(home,base,asked);
    const root=roots.find(r=>path.startsWith(r+sep));
    // After the root's own separator, so the first part is the file or folder, not an empty string (which refused every path).
    if(!root||path.slice(root.length+1).split(sep).some(part=>!part||part.startsWith('.')||part==='..'))return undefined;
    return path;
  }
  /**
   * write_file: a new file the owner asked for (a sheet as CSV, notes, a list) in Downloads or
   * Documents. Never overwrites: an existing name gets a number. Text formats only, at most 2 MB.
   */
  private writeFileFor(name:string,content:string):string{
    if(!/\.(csv|tsv|txt|md|json|html)$/i.test(name))return 'Use a .csv, .tsv, .txt, .md, .json or .html name.';
    if(Buffer.byteLength(content)>2_000_000)return 'That is more than 2 MB of text.';
    const path=this.ownerPath(name);if(!path)return 'Files go in Downloads or Documents, never hidden folders.';
    const parent=realpathSync(join(path,'..'));if(!this.ownerPath(join(parent,'x.txt')))return 'That folder is outside Downloads or Documents.';
    let final=path;for(let i=2;existsSync(final)&&i<100;i++)final=path.replace(/(\.[^.]+)$/,` ${i}$1`);
    writeFileSync(final,content,{flag:'wx',mode:0o644});
    return JSON.stringify({written:final,bytes:Buffer.byteLength(content)});
  }
  /** open_file: open a file from the owner's folders, in a named app if given (Numbers for a CSV). */
  private async openFileFor(raw:string,app?:string):Promise<string>{
    const path=this.ownerPath(raw);if(!path)return 'I can open files only from Downloads, Desktop, Documents, Pictures, Movies or Music.';
    let real:string;try{real=realpathSync(path);}catch{return `No file at ${raw}.`;}
    if(!this.ownerPath(real))return 'That file is outside your folders.';
    try{await promisify(execFile)('/usr/bin/open',[...(app?['-a',app]:[]),real],{timeout:15000});return `Opened ${basename(real)}${app?` in ${app}`:''}. Read the window to check it.`;}
    catch{return app?`${app} could not open ${basename(real)}. Is ${app} installed?`:`${basename(real)} could not be opened.`;}
  }
  /**
   * The browser tab this request chose to work in. read_tab switches back to whichever tab was
   * active, so typing after a read went into the owner's own tab, not the sheet (live, 4 November
   * 2026: keystrokes meant for a Google Sheet reached a store page). Browser input is refused until
   * focus_tab or open_page has picked the tab in this same request.
   */
  private focused=new Map<string,string>();
  /**
   * Whether this request clicked into the page since its last tab switch or read. Keystrokes sent
   * without that reached nothing: a new sheet stayed empty while both typing steps said done and
   * the owner was told all 11 rows were in (live, 4 November 2026).
   */
  private armed=new Set<string>();
  private async focusTabFor(m:Incoming,match:string):Promise<string>{
    const control=this.desktop();if(!control.run)return 'Not available in this build.';
    const want=match.toLowerCase().split(/\s+/).filter(Boolean);
    for(const browser of ['comet','chrome','edge','brave']){
      let listed:any;try{listed=await control.run(`brain:${m.id}`,{action:'list_tabs',browser});}catch{continue;}
      for(const w of listed?.windows??[])for(const t of w.tabs??[]){
        if(!want.every(word=>`${t.title??''} ${t.url??''}`.toLowerCase().includes(word)))continue;
        try{await control.run(`brain:${m.id}`,{action:'focus_tab',tabRef:t.tabRef,actionId:randomUUID()});}catch(e){return `Refused: ${deviceRefusal(e)}`;}
        this.focused.set(m.id,browser);
        return JSON.stringify({focused:t.title,url:t.url,browser,next:'This tab now has focus. Click into it and type; read_tab keeps it in front.'});
      }
    }
    return `No open tab matches "${match}". Use list_tabs to see them.`;
  }
  private shots=new Map<string,Buffer[]>();
  /** Requests whose screenshots also go out as files: Telegram recompresses photos, never documents. */
  private original=new Set<string>();
  private wanted=new Set<string>();
  private keepShot(m:Incoming,result:any,key=''){
    this.wanted.add(m.id);
    const b64=result?.screenshot?.pngBase64;
    this.store.event(m.id,'device_action',{action:'read_window',outcome:typeof b64==='string'&&b64?'done':'blocked'});
    if(typeof b64!=='string'||!b64)return false;
    // One screenshot per app, the newest: reading the same window again sent near-identical copies (owner chat, 5 Nov 2026).
    const list=(this.shots.get(m.id)??[]).filter(s=>(s as {key?:string}).key!==key);
    if(list.length<3)list.push(Object.assign(Buffer.from(b64,'base64'),{key}));this.shots.set(m.id,list);return true;
  }
  /** Sends the screenshots taken for this request, after its text answer. */
  /**
   * A window capture includes the frame's undrawn strip as transparent pixels, which Telegram
   * shows as a white band (live: 182 of 1,366 columns on Comet). Crop to the drawn area.
   */
  private async trimShot(png:Buffer):Promise<Buffer>{
    try{
      const {data,info}=await sharp(png).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      const {width:w,height:h,channels:c}=info;let left=w,right=-1,top=h,bottom=-1;
      for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(data[(y*w+x)*c+c-1]>8){if(x<left)left=x;if(x>right)right=x;if(y<top)top=y;if(y>bottom)bottom=y;}
      if(right<0)return png;
      return await sharp(png).extract({left,top,width:right-left+1,height:bottom-top+1}).flatten({background:'#ffffff'}).png().toBuffer();
    }catch{return png;}
  }
  private sendShots(m:Incoming){
    // ponytail: cleared only on the chat path; a stray entry per non-chat request is a few bytes.
    this.focused.delete(m.id);this.armed.delete(m.id);
    const files=this.files.get(m.id);this.files.delete(m.id);
    for(const f of files??[]){try{this.store.outputBrainFile(m.id,f.bytes,f.name,f.name);}catch{}}
    const list=this.shots.get(m.id);this.shots.delete(m.id);
    const asked=this.wanted.delete(m.id),original=this.original.delete(m.id);
    // Live on build 2421 the model wrote "screenshot follows" and no image existed. A screenshot
    // that was asked for and not taken is said plainly, with the permission that blocks it.
    if(asked&&!list?.length){try{this.store.output(undefined,'I could not take the screenshot this time. If it keeps failing, check that Screen Recording is on for FarFromDesk Local in System Settings > Privacy & Security. The text above is what I could read.',`brain-shot-missing:${m.id}`,this.store.destination(),{kind:'system',origin:'system',plain:true});}catch{}return;}
    // Trimmed off the reply path; the photo rows follow the reply in order.
    void (async()=>{for(const [i,png] of (list??[]).entries()){try{
      // Only the full-quality file: Telegram recompresses a photo, and the owner got a blurry copy and a sharp
      // one of the same screen (5 Nov 2026). A file keeps every pixel and still previews in the chat.
      const shot=await this.trimShot(png),label=list!.length>1?`Screenshot ${i+1} of ${list!.length}`:'Screenshot';
      void original;this.store.outputBrainFile(m.id,shot,`screenshot-${i+1}.png`,label);
    }catch{}}})();
  }
  private desktop(){return this.deviceControl() as DeviceControl&{run?:(scope:string,raw:unknown)=>Promise<any>};}
  /** read_tab: the tab whose title or URL matches, read in place (the prior tab is restored). */
  private async readTabFor(m:Incoming,match:string,screenshot:boolean):Promise<string>{
    const control=this.desktop();if(!control.run)return 'Reading tabs is not available in this build.';
    const want=match.toLowerCase().split(/\s+/).filter(Boolean);
    for(const browser of ['comet','chrome','edge','brave']){
      let listed:any;try{listed=await control.run(`brain:${m.id}`,{action:'list_tabs',browser});}catch{continue;}
      for(const w of listed?.windows??[])for(const t of w.tabs??[]){
        const hay=`${t.title??''} ${t.url??''}`.toLowerCase();
        if(!want.every(word=>hay.includes(word)))continue;
        try{
          const read=()=>control.run!(`brain:${m.id}`,{action:'read_tab',tabRef:t.tabRef,...(screenshot?{screenshot:true}:{})});
          // A tab the loop opened a moment ago is still loading, and the driver drops that read
          // (live, 4 November 2026: open_page then read_tab on Gmail). One retry after it settles.
          const page=await read().catch(async e=>{if(!/lost the connection/.test(deviceRefusal(e)))throw e;await new Promise(r=>setTimeout(r,3000));return read();});
          const sent=screenshot&&this.keepShot(m,page,'app:'+browser);
          const {screenshot:_omit,...rest}=page??{};
          // The whole page text the driver gives (24,000 characters). This was cut at 14,000, and on
          // Gmail the sidebar comes first, so only five of the owner's messages today survived (live,
          // 4 November 2026). A cut is said out loud so the model never presents part as all.
          const out=JSON.stringify({browser,...rest,...(screenshot?{screenshot:sent?'taken, sent to the owner after your reply':'not available (Screen Recording may not be allowed)'}:{})});
          this.store.event(m.id,'device_action',{action:'read_tab',chars:out.length});
          return out.length>64000?out.slice(0,64000)+' [cut here: the page has more than this]':out;
        }catch(e){return `Refused: ${deviceRefusal(e)}`;}
      }
    }
    return `No open tab matches "${match}". Use list_tabs to see them.`;
  }
  /**
   * open_page: a new tab in the chosen browser, through the gated desktop route. Live on build
   * 2424, "Open gmail in comet" only opened Comet, because the brain could open apps but not pages.
   */
  private async openPageFor(m:Incoming,url:string,browser:string):Promise<string>{
    const control=this.desktop();if(!control.run)return 'Opening pages is not available in this build.';
    const name=browser.toLowerCase().trim();
    try{
      const listed=await control.run(`brain:${m.id}`,{action:'list_tabs',browser:name});
      const win=listed?.windows?.[0];
      if(!win)return `${browser} has no window open. Open ${browser} first, then ask again.`;
      const done=await control.run(`brain:${m.id}`,{action:'new_tab',windowRef:win.windowRef,url,actionId:randomUUID()});
      return JSON.stringify({opened:url,browser:name,result:done?.ok??true});
    }catch(e){
      const said=String((e as Error)?.message??e);
      if(/^DESKTOP_BROWSER_NOT_RUNNING/.test(said))return `${browser} is not running. Ask the owner whether to open it.`;
      return `Refused: ${deviceRefusal(e)}`;
    }
  }
  /** read_window: the front window of a running app, with an optional screenshot. */
  private async readWindowFor(m:Incoming,app:string,screenshot:boolean):Promise<string>{
    const control=this.desktop();if(!control.run)return 'Reading windows is not available in this build.';
    try{
      const apps=(await control.run(`brain:${m.id}`,{action:'list_apps',query:app.slice(0,160)}))?.apps??[];
      const target=apps.find((a:any)=>a.running&&a.active)??apps.find((a:any)=>a.running);
      if(!target)return `${app} is not running. Ask the owner whether to open it.`;
      const windows=(await control.run(`brain:${m.id}`,{action:'list_windows',appRef:target.appRef}))?.windows??[];
      const win=windows.find((w:any)=>w.onScreen)??windows[0];
      if(!win)return `${target.name} is running but has no window open.`;
      const state=await control.run(`brain:${m.id}`,{action:'read_window',windowRef:win.windowRef,...(screenshot?{screenshot:true}:{})});
      const sent=screenshot&&this.keepShot(m,state,'app:'+app.toLowerCase().replace(/[^a-z0-9]/g,''));
      const controls=(state?.controls??[]).slice(0,250).map((c:any)=>[c.role,c.label,c.value].filter(Boolean).join(': ')).filter(Boolean);
      return JSON.stringify({app:target.name,window:win.title,controls,...(state?.elementsEmpty?{note:'This window publishes no readable text (a canvas app); rely on the screenshot.'}:{}),...(screenshot?{screenshot:sent?'taken, sent to the owner after your reply':'not available (Screen Recording may not be allowed)'}:{})}).slice(0,14000);
    }catch(e){return `Refused: ${deviceRefusal(e)}`;}
  }
  /** The open tabs, as data for the model's list_tabs tool. */
  private async tabsData(m:Incoming):Promise<string>{
    const control=this.deviceControl() as DeviceControl&{run?:(scope:string,raw:unknown)=>Promise<any>;view?:()=>{enabled:boolean}};
    if(!control.run)return 'Tab listing is not available in this build.';
    if(control.view?.().enabled===false)return 'Desktop control is switched off in Settings. Turn on Remote control, then ask again.';
    const browsers:unknown[]=[],unread:string[]=[];
    for(const browser of ['comet','chrome','edge','brave']){
      try{const listed=await control.run(`brain:${m.id}`,{action:'list_tabs',browser});browsers.push({browser,windows:(listed?.windows??[]).map((w:any)=>({tabs:(w.tabs??[]).map((t:any)=>({title:String(t.title??'').slice(0,160),url:String(t.url??'').slice(0,200)}))}))});}
      catch(e){const said=String((e as Error)?.message??e);if(!/^DESKTOP_BROWSER_NOT_RUNNING/.test(said))unread.push(`${browser}: ${deviceRefusal(e)}`);}
    }
    let safari='';try{safari=String((await control.packTool?.(`brain:${m.id}`,'safari_tabs',{}))?.output??'');}catch{}
    return JSON.stringify({browsers,...(safari?{safari}:{}),...(unread.length?{couldNotRead:unread}:{})}).slice(0,14000);
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
    // Only what decides the target counts: another Social turn finishing refreshes the mode's expiry
    // and busy flag, which aborted every brain turn in flight (live, 5 Nov 2026).
    const routingSnapshot=()=>{const g=router.guidedModes.get(router,m);return JSON.stringify([specialtyEpoch(this.store),g?.kind,g?.socialTarget]);};
    const routingAtStart=routingSnapshot();
    if(mode)this.store.set(`brain-mode:${m.id}`,router.guidedModes.summary(router,m));
    const routingChanged=()=>{if(routingSnapshot()===routingAtStart)return false;this.stop(m.id,'Executor or task mode changed while Brain was routing. Nothing was sent; send a new message.');return true;};
    this.memory.synchronize();
    if(revoked()||routingChanged())return true;
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
    // No device command runs in code before the model. The model reads the request with the
    // whole tool catalog and decides, the way OpenClaw runs its loop: "open gmail in comet" was
    // turned into "open Comet" by a pattern here and the owner never got Gmail (4 November 2026).
    const last=mine?this.lastDeviceApp():undefined;
    try {
      const key=this.secret.read();if(!key)throw Object.assign(new Error('Meta API key is missing. Configure it in desktop Settings.'),{code:'configuration_missing'});
      // Consent is read when the model calls the tool, not when the request began: switching learning off mid-call stops writes.
      const authorize=()=>{this.store.assertIncomingOwner();if(router.stopped||JSON.stringify(brainPolicy(this.store))!==JSON.stringify(policy))throw new Error('Brain authority changed.');};
      const memoryTool=(i:Parameters<MemoryTool>[0])=>{authorize();return this.owner.command(i,`brain:${m.id}`,policy.learn);};
      decision=Interpretation.parse(await this.model.interpret(key,policy,{original:m.text,taskMode:mode?.kind,imageProvider:mode?.imageProvider,conversation:this.conversation(m.id),source:m.source??'text',tasks:[...board.slice(0,60).map(i=>({id:i.ref,title:i.title,status:`${i.status}; execution: ${i.executionState}`})),...this.tasks(this.store.destination()).filter(t=>t.id!==m.id&&!this.store.itemOf(t.id)&&!['answered','managed'].includes(t.state)).slice(0,20).map(t=>({id:t.id,title:t.original.slice(0,300),status:t.status}))],sessions:this.memory.candidates(router).map(b=>({id:b.id,name:this.store.get(`name:${b.id}`)??b.alias,provider:b.provider,enabled:!!b.enabled})),deviceControl:mine?'brain' as const:'session' as const,...(mine&&last?{lastDeviceApp:last}:{}),...(appTools?.length?{appTools}:{}),...(mine?{now:localStamp()}:{}),...(devices?.length?{devices}:{}),activeTaskId:this.store.get(topicKey),...(this.decidesContracts(router)&&this.pendingContract(router)?{pendingContract:true}:{}),memory:this.owner.always(),...(this.owner.introNeeded()?{intro:'needed' as const}:{}),itemCodes:Object.fromEntries(Object.entries(JSON.parse(this.store.get(`item-codes:${this.store.destination()}`)??'{}') as Record<string,number>).map(([k,v])=>[k,`item:${v}`])),needsOwner:board.filter(i=>i.status==='waiting on owner'||i.status==='blocked').slice(0,10).map(i=>({id:i.ref,title:i.title,why:this.memory.gone(i.jobs[0])??i.executionState}))},memoryTool,authorize,observeMeta,mine?{
        // The model's own tool calls. A refusal comes back as the sentence for the owner, so the
        // model can say why and what to switch on, instead of the loop failing.
        run:async(tool,args)=>{const found=toolByName(tool);if(!found)return `No tool named ${tool}. Use a name from appTools.`;this.ack(m,found.app);const outcome=await runDevicePlan(this.deviceControl(),{action:'app_tool',tool,app:found.app,args},`brain:${m.id}`,authorize);this.store.event(m.id,'device_action',{action:'app_tool',outcome:outcome.ok?'done':'blocked',...(outcome.code?{code:outcome.code}:{})});return (outcome.ok?(outcome.evidence??outcome.line):`Refused: ${outcome.line}`).slice(0,14000);},
        tabs:()=>{this.ack(m,'your browser tabs');return this.tabsData(m);},
        readTab:(match,shot)=>{this.armed.delete(m.id);if(shot==='file')this.original.add(m.id);this.ack(m,`the ${match} tab`);return this.readTabFor(m,match,!!shot);},
        readWindow:(app,shot)=>{if(shot==='file')this.original.add(m.id);this.ack(m,app);return this.readWindowFor(m,app,!!shot);},
        findApp:async query=>{const control=this.desktop();if(!control.run)return 'Not available in this build.';try{const apps=(await control.run(`brain:${m.id}`,{action:'list_apps',query:query.slice(0,80)}))?.apps??[];return apps.length?JSON.stringify(apps.slice(0,10).map((a:any)=>({name:String(a.name).replace(/[\u200e\u200f]/g,''),running:a.running===true}))):`${query} is not installed on this Mac. Use its web version in the owner's browser if it has one.`;}catch(e){return `Refused: ${deviceRefusal(e)}`;}},
        writeFile:(name,content)=>{this.ack(m,'Finder');return Promise.resolve(this.writeFileFor(name,content));},
        openFile:(path,app)=>{this.ack(m,app??'Finder');return this.openFileFor(path,app);},
        sendFile:path=>{this.ack(m,'Finder');return Promise.resolve(this.sendFileFor(m,path));},
        socialDrafts:()=>this.socialDraftsFor(),
        // Click, type and key presses inside the loop, so "send hi to Riya" can type, press return
        // and read the chat back. As a one-shot decision it typed "hi" and could not send it (live).
        act:async plan=>{
          if(plan.action==='pick_file'){const asked=(plan.text||plan.name||'').trim(),path=this.ownerPath(asked);if(!path||!existsSync(path)){try{appendFileSync(join(stateDir,'logs','brain-act.log'),`${new Date().toISOString()} pick_file refused path ${JSON.stringify(asked)} -> ${path}\n`);}catch{}return `Refused: no file at ${asked||'(no path given)'} in Downloads, Desktop, Documents, Pictures, Movies or Music. Put the full path in text, such as ~/Downloads/report.pdf.`;}plan={...plan,text:path,name:undefined};}
          const browser=/\b(comet|chrome|edge|brave|safari|arc|firefox)\b/i.test(plan.app);
          if(browser&&!this.focused.has(m.id))return 'Refused: first call focus_tab (or open_page) for the tab you mean to work in, so the input reaches that page and not the owner\'s own tab.';
          if(browser&&plan.action==='type'&&!plan.name&&!plan.role&&!this.armed.has(m.id))return 'Refused: click where the text should go first (in a sheet: click the Name box, type the cell such as A1, press return), after the last tab switch or read. Keystrokes sent without that land nowhere.';
          this.ack(m,plan.app);const outcome=await runDevicePlan(this.deviceControl(),plan as DevicePlan,`brain:${m.id}`,authorize);this.store.event(m.id,'device_action',{action:plan.action,outcome:outcome.ok?'done':'blocked'});if(browser&&outcome.ok&&(plan.action==='click'||plan.action==='press_key'&&(plan as {modifiers?:string[]}).modifiers?.length))this.armed.add(m.id);if(!outcome.ok&&outcome.detail)try{appendFileSync(join(stateDir,'logs','brain-act.log'),`${new Date().toISOString()} ${plan.action} in ${plan.app} refused: ${outcome.detail}\n`,{mode:0o600});}catch{}return outcome.ok?[outcome.line,outcome.evidence].filter(Boolean).join('\n').slice(0,6000):`Refused: ${outcome.line}${outcome.detail?` (driver: ${outcome.detail})`:''}`;},
        // Opening inside the loop, so "open whatsapp" can go on to read what is new there.
        openApp:async app=>{this.ack(m,app);const outcome=await runDevicePlan(this.deviceControl(),{action:'open_app',app},`brain:${m.id}`,authorize);this.store.event(m.id,'device_action',{action:'open_app',outcome:outcome.ok?'done':'blocked'});return outcome.ok?outcome.line:`Refused: ${outcome.line}`;},
        openPage:async(url,browser)=>{this.ack(m,browser);this.armed.delete(m.id);const r=await this.openPageFor(m,url,browser);if(r.startsWith('{'))this.focused.set(m.id,browser.toLowerCase());return r;},
        focusTab:match=>{this.ack(m,`the ${match} tab`);this.armed.delete(m.id);return this.focusTabFor(m,match);},
        reminders:{create:i=>router.schedules.brainCreate(router,m,i),list:()=>router.schedules.brainList(),cancel:id=>router.schedules.brainCancel(id),session:i=>router.schedules.brainScheduleSession(router,m,i)},
      }:undefined));
      this.store.event(m.id,'brain_interpreted',{durationMs:Date.now()-interpretationStarted});
    }catch(e) {
      if(revoked()||routingChanged())return true;
      const raw=(e as {code?:unknown})?.code,code=typeof raw==='string'?raw:errorCode(e);
      this.store.event(m.id,'brain_interpretation_failed',{code,field:(e as {field?:unknown})?.field,durationMs:Date.now()-interpretationStarted});
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
    // Room for an answer built from tool results (a tab list was cut mid-word at 400).
    const said=this.deviceFactLine(m,decision.reply??'')??(decision.reply??'').trim().slice(0,3800);
    if(decision.intent==='clarify') {this.stop(m.id,said||'Please clarify the task and which coding platform you want. Nothing has been dispatched.','clarification');return true;}
    if(decision.intent==='chat') {this.store.db.prepare("UPDATE brain_tasks SET state='answered',permission='allowed' WHERE id=?").run(m.id);// The screenshot is the fact. Live on build 2423 the image was taken and sent while the
      // reply, echoing earlier failures in the conversation, said it could not be taken.
      const taken=!!this.shots.get(m.id)?.length;
      const reply=taken?(said.split('\n').map(line=>line.replace(/[^.!?\n]*\b(could not|couldn't|unable to|can't|cannot)\b[^.!?\n]*screenshot[^.!?\n]*[.!?]?\s*/gi,'')).filter((line,i,all)=>line.trim()||i<all.length-1).join('\n').trim()||'Here it is.'):said;
      const withNote=taken&&!/screenshot follows/i.test(reply)?`${reply}\nScreenshot follows.`:reply;
      this.store.outputBrain(m.id,withNote||'Send a task, or ask where are we.');this.sendShots(m);return true;}
    const operated=await this.ownerOperation(router,m,decision);if(operated!==undefined)return operated;
    if(decision.intent==='device') return await this.runDevice(router,m,decision,policy);
    // The brain decided this is coding work (or the answer to a pending review), so the task
    // review runs now, on its decision. The router no longer guesses with a pattern first.
    if(decision.intent==='task'&&this.decidesContracts(router)&&router.contracts?.shouldHandle(router,m)&&!router.contracts.approved(m.id)){
      const contract=await router.contracts.preflight(router,m);
      if(contract.kind==='handled'){this.store.db.prepare("UPDATE brain_tasks SET state='managed',permission='allowed' WHERE id=? AND state='interpreting'").run(m.id);return true;}
      // Approved: the original request runs again as approved work, under this message id.
      if(contract.kind==='replay'){this.store.db.prepare('DELETE FROM brain_tasks WHERE id=?').run(m.id);await router.replayApproved(contract.incoming);return true;}
    }
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
      // No tracked item: the owner never sees item codes, so ask the session itself ("check the cloud server session", sim 7 Nov 2026).
      if(picked)return this.requestUpdate(router,m,picked,m.text,decision.provider);
      decision={...decision,intent:'task',taskIds:[]};
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
      // A Social brief names platforms as its subject ("a post about Claude and Codex"), so there
      // a name routes only when the model also read it as the destination. Still owner-named.
      const named=namedPlatforms(m.text).filter(p=>mode?.kind!=='social'||p===decision.provider);
      if(named.length>1)throw new Error('Please choose one coding platform for this request.');
      if(named.length&&decision.provider!=='unspecified'&&named[0]!==decision.provider)throw new Error('The platform interpretation conflicts with your original message. Please clarify.');
      // Display names and aliases of any length name a session: "UX", "开发", "claude-proxy" as surely as "Payments API".
      const norm=(t:string)=>t.normalize('NFKC').replace(/[‘’]/g,"'").replace(/\s+/g,' ').trim().toLowerCase();
      const esc=(t:string)=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),said=norm(m.text);
      const hit=(n:string)=>/[^\x00-\x7f]/.test(n)?said.includes(n):new RegExp(`(?:^|[^a-z0-9])${esc(n)}(?:[^a-z0-9]|$)`).test(said);
      // Any enabled session the owner can see by name counts, connected or not: naming it is as exact as /to (sim, 7 Nov 2026).
      const mentioned=this.store.bindings().filter(b=>b.enabled&&[this.label(b),b.alias].map(norm).some(n=>n&&!PLATFORM_WORDS.some(([,words])=>words.includes(n))&&hit(n)));
      if(mentioned.length>1)throw new Error('Your message names more than one session. Please choose one with /claude list or /codex list. Nothing was sent.');
      // Wording can exclude a destination without naming it ("not the session that worked on this"), so a named session, or a negation
      // next to destination words, is ambiguous: the owner is asked and nothing is sent.
      // Checked per clause, so "Codex, fix it. Do not publish" still goes straight to Codex.
      const negated=/\b(?:not|no|never|except|avoid|instead|without|exclude|nobody|nowhere|other than|anyone but|away from)\b|n't\b|[不别勿]/;
      const destinationWord=new RegExp(`\\b(?:send|sent|forward|route|give|assign|pass|hand|session|coordinator|agent|worker|platform|${PLATFORM_ALTERNATION}|anywhere|anyone|someone|elsewhere)\\b|[发给派]`,'i');
      const ambiguous=said.split(/[.,;:!?\n。，；！？]+/).some(clause=>negated.test(clause)&&destinationWord.test(clause));
      const provider=named[0]??(decision.provider==='unspecified'?undefined:decision.provider);
      // A model may pick a platform the owner didn't name only by following the owner's collaboration.md rules.
      // "Yes" to "pass this to Cursor?" names Cursor through the owner's own message just before it (live, 4 Nov 2026).
      // Only a platform a rule actually names: a rule for Codex never lets the model pick Cursor.
      const ruled=()=>(this.owner.read('collaboration.md')??'').split('\n').filter(l=>/^[-*]\s+\S/.test(l)).flatMap(namedPlatforms);
      const earlier=()=>this.conversation(m.id).slice(-3).flatMap(t=>namedPlatforms(t.original));
      if(!named.length&&!mentioned.length&&decision.provider!=='unspecified'&&!ruled().includes(decision.provider)&&!earlier().includes(decision.provider))throw new Error('Please name the coding platform you want, or use your default coordinator.');
      if(decision.taskIds.length>1)throw new Error('Please choose one topic before forwarding this follow-up.');
      // A topic id the model guessed wrong, or one owned by another session than the owner now names, starts fresh:
      // the owner's latest words win over the model's guess (sim, 7 Nov 2026).
      if(decision.taskIds.length)try{topic=this.memory.resolve(decision.taskIds[0]);}catch{topic=undefined;}
      target=topic?this.memory.owner(topic,router):undefined;
      if(target&&((mentioned.length&&target.id!==mentioned[0].id)||(provider&&target.provider!==provider))){topic=undefined;target=undefined;}
      // An item nobody owns yet goes to the session the owner named, never the default coordinator.
      target??=mentioned[0];
      // A replaced or paused owner is never silently swapped for the current proxy.
      const stale=topic&&this.memory.attention(this.memory.board().find(i=>i.id===topic!.id)!);if(stale)throw new Error(stale);
      if(target&&provider&&target.provider!==provider)throw new Error('This topic belongs to another platform. Please clarify whether you want to change its assignment.');
      if(!target)target=provider?c.registry.choose(provider,/\bdesktop\b/i.test(m.text)?'desktop':/\bcli\b/i.test(m.text)?'cli':undefined):c.master();
      if(!target?.enabled||!policy.providers.includes(target.provider)||!c.enabled().includes(target.provider))throw new Error('The selected platform is paused or denied by your routing policy.');
      coordinator=c.isCoordinator(target.id)?target:c.registry.bindingFor(target);
      if(!coordinator?.enabled||c.registry.identity(coordinator).key!==c.registry.entry(coordinator.id)?.key)throw new Error('Coordinator account or runtime changed. Review Coding platforms.');
      if(target.id!==mentioned[0]?.id&&!c.isCoordinator(target.id)&&!c.selected().some(b=>b.id===target!.id))throw new Error('The owning session is not connected. Connect that exact session first.');
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
      const instructions=mode?socialSpecialty(provider):undefined;
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

/** A tab command (open a new tab, close it, go to a page), not a question about the tabs that are open. */
export const TAB_COMMAND=/\b(close|open (?:a |the )?(?:new )?tabs?|new tab|go to|navigate|switch to)\b/i;

/** How a reviewed tool's raw result becomes the owner's reply. Facts only come from the result. */
export const DEVICE_ANSWER_PROMPT=`You are Atlas, the owner's companion on their Mac, replying in a phone chat. You get the owner's request and the raw result a reviewed tool read from one of their apps (or their browser tabs). Write the reply.
- First line: the direct answer, with counts (for example "You have 7 notes; the newest is from today." or "12 tabs open in Comet across 2 windows.").
- Then at most 8 short lines starting with "- ", the items that matter, newest or most relevant first. Summarise each in a few words; never paste long text. Collapse repeats ("5 near-identical test notes named x").
- Dates short and human: "today 11:25", "yesterday", "Wed 2 Sep".
- Use only what is in the result. Never invent an item, a time or a count. If the result is empty, say so in one line.
- Never reveal secrets: for anything that looks like a password, key, token, private key or credential, say only that such an item exists, never its content or full title.
- Plain text for WhatsApp or Telegram: no headings, no tables, no em or en dashes, at most one emoji.
- If something more can be done ("ask me to read one in full"), end with one short line saying so.`;
