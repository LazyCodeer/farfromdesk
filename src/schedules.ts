import {randomUUID} from 'node:crypto';
import {authenticatedOwner} from './owner-commands.js';
import {brainPolicy,MetaSecret} from './meta-brain-config.js';
import {interpretSchedule,type ScheduleInterpreter} from './schedule-model.js';
import {addDay,localDate,localInstants,nextOccurrence,validZone,type Recurrence} from './schedule-time.js';
import {hash,type Binding,type Store} from './store.js';
import type {Incoming,Router} from './router.js';
import type {ContractSchedule} from './task-contracts.js';

type Action='message'|'brief'|'session';
type Row={id:string;owner:string;destination:string;channel:string;action:Action;text:string;binding_id:string|null;binding_identity:string|null;date:string;time:string;zone:string;repeat:Recurrence;next_at:number;status:string;created_at:number};
type ListSnapshot={owner:string;destination:string;expires:number;ids:string[]};
const MAX_TEXT=2000, MAX_SCHEDULES=100;
const normalized=(s:string)=>s.trim().replace(/\s+/g,' ').toLowerCase();
function containsExact(text:string,part:string) {
  const source=normalized(text),value=normalized(part);let at=-1;
  if(!value)return false;
  while((at=source.indexOf(value,at+1))>=0){const before=source[at-1],after=source[at+value.length];if((!before||!/[\p{L}\p{N}_-]/u.test(before))&&(!after||!/[\p{L}\p{N}_-]/u.test(after)))return true;}
  return false;
}
const candidate=(s:string)=>{
  if(/\bremind(?:\s+me|er|ers)\b/i.test(s)||/^(?:(?:every|each)\s+(?:day|weekday)|daily|weekdays)\b.*\b(?:send|remind|check|ask)\b/i.test(s))return true;
  const past=/^(?:at|on)\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\s+(?:(?:i|we|he|she|they)|(?:the|a|an)\s+[a-z0-9_-]+)\s+(?:saw|noticed|observed|experienced|received|found|encountered|reported|heard|had|was|were|went|broke|fell|crashed|failed|stopped|disconnected|restarted)\b[^.!?]*[.!?]/i.exec(s);
  if(past&&!/\b(?:at|on)\s+\d|\b(?:later|tomorrow|tonight|next\s+\w+|after|before|remind|schedule)\b/i.test(s.slice(past[0].length)))return false;
  return /^(?:(?:tomorrow|tonight)\s+)?(?:at|on)\s+\d/i.test(s);
};
const listCommand=(s:string)=>/^(?:please\s+)?(?:list|show)(?:\s+me)?(?:\s+my)?\s+(?:reminders|schedules)\s*[.!?]*$/i.test(s);
const cancelCommand=(s:string)=>/^(?:please\s+)?cancel\s+(?:(?:reminder|schedule)\s+)?(\d{1,3})\s*[.!?]*$/i.exec(s);
const readOnlyPrStatus=(s:string)=>/^(?:please\s+)?check\s+(?:whether|if)\s+(?:pr|pull request)\s+#?\d{1,9}\s+is\s+green\s+and\s+tell\s+me[.!?]*$/i.test(s.trim());
const cleanAction=(s:string)=>normalized(s).replace(/[.!?]+$/,'');
function reminderDirective(original:string,body:string):{directive:string;action:string}|undefined {
  const match=/\bremind\s+me\b[\s\S]*?\bto\s+/i.exec(original);
  if(!match||cleanAction(original.slice(match.index+match[0].length))!==cleanAction(body))return;
  return {directive:original.slice(0,match.index+match[0].length),action:original.slice(match.index+match[0].length).trim()};
}
function briefDirective(original:string):string|undefined {
  if(/\b(?:remind\s+me|do\s+not|don['’]?t|never|not|cancel|avoid)\b/i.test(original))return;
  const match=/\b(?:send|give|deliver)\s+(?:(?:me|my|the)\s+)*brief[.!?]*\s*$/i.exec(original);
  return match?original.slice(0,match.index):undefined;
}
function explicitSessionDispatch(original:string,target:string,body:string):{directive:string;action:string}|undefined {
  // A model cannot turn "remind me to ..." or a negated request into a live task.
  if(/\bremind\s+me\b/i.test(original))return;
  const name=normalized(target).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  if(!name)return;
  const match=new RegExp(`\\b(?:ask|tell)\\s+(?:session\\s+)?${name}\\s+to\\s+`,'iu').exec(original);
  // Every qualifier after "ask SESSION to" remains part of the task. A substring
  // such as "deploy" must not replace "check whether it is safe to deploy".
  if(!match||/\b(?:do\s+not|don['’]?t|never|not|cancel|avoid)\b/i.test(original.slice(0,match.index+match[0].length))||cleanAction(original.slice(match.index+match[0].length))!==cleanAction(body))return;
  // Timing is checked only against the directive, not words inside the task.
  return {directive:original.slice(0,match.index+match[0].length),action:original.slice(match.index+match[0].length).trim()};
}
/** Independently derive supported timing from the owner's words; never trust model guesses. */
function checkedTiming(original:string,decision:{time:string;date:string;repeat:Recurrence;action:string},now:number,zone:string) {
  if(/\b(?:do\s+not|don['’]?t|never|stop)\s+(?:remind|schedule|send|ask|tell)\b|\b(?:not|never)\s+(?:every|daily|weekdays)\b/i.test(original))throw new Error('I did not schedule that. Please state the reminder and time without negation.');
  const matches=[...original.matchAll(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?!\w)/gi)];
  if(matches.length!==1)throw new Error('Please specify one time, for example at 6 PM or at 18:00.');
  const match=matches[0],hour=Number(match[1]),minute=Number(match[2]??'0');let ampm=(match[3]??'').toLowerCase().replace(/\./g,'');
  if(!ampm&&decision.action==='brief'&&hour===9&&/\b(?:every|each)\s+weekday\b/i.test(original))ampm='am';
  if(minute>59||hour>23||ampm&&(!hour||hour>12)||!ampm&&hour>0&&hour<=12)throw new Error('Please specify AM or PM, for example at 6 PM.');
  const hour24=ampm?(hour%12+(ampm==='pm'?12:0)):hour,time=`${String(hour24).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
  if(decision.time!==time)throw new Error('I could not confirm that time. Please restate it, for example at 6 PM.');
  const weekdays=/\b(?:(?:every|each)\s+weekday(?:s)?|weekdays)\b/i.test(original),daily=/\b(?:(?:every|each)\s+day|daily)\b/i.test(original);
  if(weekdays&&daily||/\b(?:weekly|monthly|hourly|weekends|(?:every|each)\s+(?:week|month|hour|\d+))\b/i.test(original))throw new Error('Please choose a one-time, daily or weekday schedule.');
  const repeat:Recurrence=weekdays?'weekdays':daily?'daily':'once';
  if(decision.repeat!==repeat)throw new Error('I could not confirm how often. Please say once, daily or every weekday.');
  const today=localDate(now,zone),tomorrow=addDay(today),hasToday=/\b(?:today|tonight)\b/i.test(original),hasTomorrow=/\btomorrow\b/i.test(original),absolute=[...original.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(m=>m[0]);
  if(Number(hasToday)+Number(hasTomorrow)+absolute.length>1||/\b(?:next|this)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month)\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(original))throw new Error('Please specify the date as today, tomorrow or YYYY-MM-DD.');
  const explicit=absolute[0]??(hasTomorrow?tomorrow:hasToday?today:undefined);
  let date=explicit??today;
  if(repeat==='once'&&!explicit&&nextOccurrence(today,time,zone,'once',now)===undefined)date=tomorrow;
  const next=nextOccurrence(date,time,zone,repeat,now);
  if(next===undefined)throw new Error('Please choose a future time.');
  const actualDate=localDate(next,zone);
  if(decision.date!==date&&!(repeat!=='once'&&decision.date===actualDate))throw new Error('I could not confirm the date. Please specify today, tomorrow or YYYY-MM-DD.');
  return {date,time,repeat,next};
}
const scheduleKey=(destination:string)=>`schedule-list:${destination}`;
const clarifyKey=(destination:string)=>`schedule-clarify:${destination}`;
const bareTime=(s:string)=>/^\s*(?:(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|a\.?m\.?|p\.?m\.?|morning|afternoon|evening|tonight|tomorrow|today)\s*[.!?]*\s*$/i.test(s);

/** Revalidate the paired owner and channel. F2 deliberately supports self-chat only. */
export function validScheduleOwner(store:Store,owner:string,destination:string,channel:string) {
  return !!owner&&destination===owner&&store.ownerFor(destination)===owner&&
    (channel==='telegram'?destination===store.get('telegram-owner'):channel==='whatsapp'&&destination===store.get('whatsapp-owner'));
}
function bindingFingerprint(router:Router,b:Binding) {
  return hash(JSON.stringify([b.id,b.native_id,b.cwd,b.token_hash,b.mode,b.provider,router.store.get(`execution-mode:${b.id}`),router.store.get(`session-route:${b.id}`),router.coordinator?.registry.entry(b.id)]));
}
function sessionAvailable(router:Router,row:Pick<Row,'binding_id'|'binding_identity'>) {
  const b=row.binding_id?router.store.binding(row.binding_id):undefined,policy=brainPolicy(router.store),c=router.coordinator;
  if(!b?.enabled||!policy.enabled||!policy.allowRouting||!policy.providers.includes(b.provider)||!c?.enabled().includes(b.provider)||bindingFingerprint(router,b)!==row.binding_identity)return;
  const entry=c.registry.entry(b.id);if(entry&&c.registry.identity(b).key!==entry.key)return;
  return b;
}

export class Schedules {
  private ticking=false;
  private briefTurn=0;
  constructor(readonly store:Store,readonly secret=new MetaSecret(),readonly interpret:ScheduleInterpreter=interpretSchedule,readonly now=()=>Date.now(),readonly briefTimeoutMs=35000) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS schedules(
      id TEXT PRIMARY KEY,origin_id TEXT UNIQUE NOT NULL,owner TEXT NOT NULL,destination TEXT NOT NULL,channel TEXT NOT NULL,
      action TEXT NOT NULL,text TEXT NOT NULL,binding_id TEXT,binding_identity TEXT,date TEXT NOT NULL,time TEXT NOT NULL,zone TEXT NOT NULL,
      repeat TEXT NOT NULL,next_at INTEGER NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules(status,next_at);
      CREATE TABLE IF NOT EXISTS schedule_occurrences(id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,owner TEXT NOT NULL,destination TEXT NOT NULL,channel TEXT NOT NULL,due_at INTEGER NOT NULL,state TEXT NOT NULL,UNIQUE(schedule_id,due_at));
      CREATE TABLE IF NOT EXISTS schedule_outbox(outbox_id TEXT PRIMARY KEY,occurrence_id TEXT NOT NULL,owner TEXT NOT NULL,destination TEXT NOT NULL,channel TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedule_jobs(job_id TEXT PRIMARY KEY,occurrence_id TEXT NOT NULL,owner TEXT NOT NULL,destination TEXT NOT NULL,channel TEXT NOT NULL,binding_id TEXT,binding_identity TEXT,body_hash TEXT);`);
    for(const name of ['binding_id','binding_identity','body_hash'])if(!store.db.prepare('PRAGMA table_info(schedule_jobs)').all().some(c=>c.name===name))store.db.exec(`ALTER TABLE schedule_jobs ADD COLUMN ${name} TEXT`);
  }
  private owner(destination:string){return this.store.ownerFor(destination)??'';}
  private context(destination:string,owner:string,channel:string){return this.store.controlChannel()===channel&&validScheduleOwner(this.store,owner,destination,channel);}
  private answer(m:Incoming,message:string){this.store.output(undefined,message,`schedule-reply:${m.id}`,undefined,{plain:true});this.store.remember(m.id);}
  private snapshot(destination:string):ListSnapshot|undefined{try{return JSON.parse(this.store.get(scheduleKey(destination))??'null')??undefined;}catch{return;}}
  private clarification(destination:string){try{return JSON.parse(this.store.get(clarifyKey(destination))??'null') as {owner:string;expires:number}|null;}catch{return null;}}
  isScheduleLike(text:string){return candidate(text.trim());}
  private list(m:Incoming,destination:string,owner:string) {
    const rows=this.store.db.prepare(`SELECT s.* FROM schedules s WHERE s.owner=? AND s.destination=? AND (s.status='active' OR (s.status='done' AND EXISTS(SELECT 1 FROM schedule_occurrences o JOIN schedule_jobs j ON j.occurrence_id=o.id JOIN inbox i ON i.id=j.job_id WHERE o.schedule_id=s.id AND i.status IN ('queued','dispatched')))) ORDER BY s.next_at,s.id LIMIT 100`).all(owner,destination) as Row[];
    this.store.set(scheduleKey(destination),JSON.stringify({owner,destination,expires:this.now()+600000,ids:rows.map(r=>r.id)}));
    const lines=rows.map((r,i)=>`${i+1}. ${r.action==='brief'?'Morning brief':r.text} · ${new Intl.DateTimeFormat('en-IN',{timeZone:r.zone,dateStyle:'medium',timeStyle:'short'}).format(r.next_at)} (${r.zone}${r.repeat==='once'?'':`, ${r.repeat}`})`);
    this.answer(m,lines.length?`Your reminders:\n${lines.join('\n')}\nReply cancel NUMBER to cancel one.`:'You have no active reminders.');
  }
  private cancel(m:Incoming,destination:string,owner:string,index:number) {
    const snap=this.snapshot(destination),id=snap&&snap.owner===owner&&snap.destination===destination&&snap.expires>this.now()?snap.ids[index-1]:undefined;
    if(!id){this.answer(m,'That reminder list is unavailable or expired. Say list my reminders first.');return;}
    this.store.db.exec('SAVEPOINT schedule_cancel');
    try{
      const result=this.store.db.prepare("UPDATE schedules SET status='cancelled' WHERE id=? AND owner=? AND destination=? AND status IN ('active','done')").run(id,owner,destination);
      this.store.set(scheduleKey(destination),'null');
      this.answer(m,result.changes?'Reminder cancelled. Work already submitted may still run.':'That reminder is no longer active.');
      this.store.db.exec('RELEASE schedule_cancel');
    }catch(e){this.store.db.exec('ROLLBACK TO schedule_cancel; RELEASE schedule_cancel');throw e;}
  }
  /** Synchronous guard preserves the existing immediate acknowledgment for ordinary messages. */
  shouldHandle(router:Router,m:Incoming,ownerIntent:boolean) {
    const destination=this.store.destination(),text=m.text.trim();
    if(!destination||!ownerIntent||m.quotedId||!authenticatedOwner(router,m))return false;
    const snap=this.snapshot(destination),live=!!(snap&&snap.owner===this.owner(destination)&&snap.destination===destination&&snap.expires>this.now());
    const clarify=this.clarification(destination),pending=!!(clarify&&clarify.owner===this.owner(destination)&&clarify.expires>this.now());
    return listCommand(text)||candidate(text)||!!(pending&&bareTime(text))||!!(cancelCommand(text)&&(live||/\b(?:reminder|schedule)\b/i.test(text)));
  }
  async handle(router:Router,m:Incoming,ownerIntent:boolean,contractApproved=false):Promise<boolean> {
    if(!this.store.incomingOwnerCurrent())return true;
    const destination=this.store.destination(),owner=destination?this.owner(destination):'',channel=this.store.controlChannel();
    try{return await this.handleOnce(router,m,ownerIntent,contractApproved);}
    catch(error){
      if(!this.store.incomingOwnerCurrent())return true;
      // A short response to a validation error must not be delivered as a session task.
      if(destination&&this.context(destination,owner,channel))this.store.set(clarifyKey(destination),JSON.stringify({owner,expires:this.now()+600000}));
      throw new Error(`${error instanceof Error?error.message:'I could not save that schedule.'} Please resend the complete reminder. Nothing was scheduled.`);
    }
  }
  private async handleOnce(router:Router,m:Incoming,ownerIntent:boolean,contractApproved:boolean):Promise<boolean> {
    const text=m.text.trim(),destination=this.store.destination();
    if(!destination||!this.shouldHandle(router,m,ownerIntent))return false;
    const isList=listCommand(text),cancel=cancelCommand(text),snapshot=this.snapshot(destination);
    const owner=this.owner(destination),channel=this.store.controlChannel();
    if(!this.context(destination,owner,channel)){this.answer(m,'For reminders, please message me in your own self-chat.');return true;}
    if(contractApproved){
      const approved=router.contracts.approvedSchedule(m.id);
      if(approved){
        const s=approved.schedule,now=this.now();
        if(s.owner!==owner||s.destination!==destination||s.channel!==channel||s.valid_until<=now)throw new Error('Your approved schedule or connection changed.');
        let next=s.next_at;
        if(next<=now){if(s.repeat==='once')throw new Error('The approved time has passed.');next=nextOccurrence(localDate(now,s.zone),s.time,s.zone,s.repeat,now)??0;}
        if(!next||next>s.valid_until||!sessionAvailable(router,{binding_id:s.binding_id,binding_identity:s.binding_identity}))throw new Error('The approved schedule or session is no longer available.');
        this.store.db.exec('SAVEPOINT approved_schedule');
        try{
          this.store.db.prepare('INSERT INTO schedules VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(s.id,m.id,s.owner,s.destination,s.channel,s.action,s.text,s.binding_id,s.binding_identity,s.date,s.time,s.zone,s.repeat,next,'active',now);
          router.contracts.saveSchedule(s,approved.contractId,'approved',next);
          const when=new Intl.DateTimeFormat('en-IN',{timeZone:s.zone,dateStyle:'medium',timeStyle:'short'}).format(next);
          this.answer(m,`Approved schedule set for ${when} (${s.zone}${s.repeat==='once'?'':`, ${s.repeat}`}).`);
          this.store.db.exec('RELEASE approved_schedule');return true;
        }catch(e){this.store.db.exec('ROLLBACK TO approved_schedule; RELEASE approved_schedule');throw e;}
      }
    }
    const pending=this.clarification(destination);
    if(pending&&pending.owner===owner&&pending.expires>this.now()&&bareTime(text)){this.answer(m,'Please resend the complete reminder with its date, time and action. Nothing has been scheduled.');return true;}
    if(!isList&&!candidate(text)&&!(cancel&&(snapshot||/\b(?:reminder|schedule)\b/i.test(text))))return false;
    if(isList){this.list(m,destination,owner);return true;}
    if(cancel){this.cancel(m,destination,owner,Number(cancel[1]));return true;}
    if(!brainPolicy(this.store).enabled||!this.secret.present()){this.answer(m,'Turn on Meta Brain and add your key before creating a reminder.');return true;}
    const zone=this.store.get('schedule-timezone')??'Asia/Kolkata';if(!validZone(zone))throw new Error('Choose a valid reminder time zone in settings.');
    const decision=await this.interpret(text,this.now(),zone,this.secret.read()!);
    // Changes during the model call cannot create a schedule under another owner, group or channel.
    if(router.stopped||!this.store.incomingOwnerCurrent()||!this.context(destination,owner,channel)||!brainPolicy(this.store).enabled||!this.secret.present())throw new Error('Your connection or Brain settings changed. Please send the reminder again.');
    // An explicit time-shaped request must never fall through into immediate work.
    if(decision.kind==='not_schedule'){this.store.set(clarifyKey(destination),JSON.stringify({owner,expires:this.now()+600000}));this.answer(m,'I could not confirm that schedule. Please resend the complete request with its time and action. Nothing was sent.');return true;}
    if(decision.kind==='clarify'){this.store.set(clarifyKey(destination),JSON.stringify({owner,expires:this.now()+600000}));this.answer(m,'Please resend the complete reminder with its date, time and action, and the session if needed. Nothing has been scheduled.');return true;}
    if(decision.kind!=='create'||!['message','brief','session'].includes(decision.action))throw new Error('I could not safely identify the reminder. Please say the time and action again.');
    const action=decision.action as Action;let body=decision.text.trim(),timingText=text;
    if(action!=='brief'&&(!body||body.length>MAX_TEXT||!normalized(text).includes(normalized(body))))throw new Error('Please state the exact reminder or session request in your message.');
    if(action==='message'){
      const directive=reminderDirective(text,body);if(!directive)throw new Error('Please say "remind me at TIME to" followed by the complete reminder.');timingText=directive.directive;body=directive.action;
    }
    if(action==='brief'){
      const directive=briefDirective(text);if(directive===undefined)throw new Error('Please explicitly ask me to send your brief. A reminder alone will not send it.');timingText=directive;
      if(channel!=='whatsapp')throw new Error('Scheduled briefs are available in your WhatsApp self-chat.');
      if(!router.scheduledBrief)throw new Error('Scheduled briefs are not available yet. No reminder was created.');
    }
    let binding:Binding|undefined;
    if(action==='session'){
      if(decision.target){
        const directive=explicitSessionDispatch(text,decision.target,body);
        if(!containsExact(text,decision.target)||!directive)throw new Error('To schedule work, explicitly say ask SESSION to do the task. A reminder alone will not send work.');
        timingText=directive.directive;body=directive.action;
        binding=this.store.binding(decision.target);
      }else if(readOnlyPrStatus(body)&&cleanAction(text).endsWith(cleanAction(body))&&!/\b(?:remind\s+me|do\s+not|don['’]?t|never|not|cancel|avoid)\b/i.test(text)){
        const match=/(?:please\s+)?check\s+(?:whether|if)\s+(?:pr|pull request)\s+#?\d{1,9}\s+is\s+green\s+and\s+tell\s+me[.!?]*\s*$/i.exec(text);
        if(!match||cleanAction(match[0])!==cleanAction(body))throw new Error('Please state the complete PR status request.');
        binding=router.coordinator?.master();timingText=text.slice(0,match.index);body=match[0].trim();
      }
      else throw new Error('Name the exact connected session for this scheduled request.');
      if(!binding)throw new Error('That session is not registered. Name an exact connected session.');
      const identity=bindingFingerprint(router,binding);if(!sessionAvailable(router,{binding_id:binding.id,binding_identity:identity}))throw new Error('That session is unavailable or Brain routing is disabled.');
    }
    const zoneNames=[...timingText.matchAll(/\b[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/g)].map(m=>m[0]);
    if(!zoneNames.length&&/\b(?:IST|PST|PDT|CST|CDT|EST|EDT|MST|MDT|UTC|GMT)\b/i.test(timingText))throw new Error('Please specify the time zone using an IANA name such as Asia/Kolkata.');
    if(zoneNames.length>1||zoneNames.length===1&&decision.zone!==zoneNames[0]||zoneNames.length===0&&decision.zone!==zone)throw new Error('Please name the time zone explicitly in the time directive.');
    if(!validZone(decision.zone))throw new Error('Please choose a valid time zone.');
    const now=this.now(),{date,time,repeat,next}=checkedTiming(timingText,decision,now,decision.zone);
    if(repeat==='once'&&!localInstants(date,time,decision.zone).length)throw new Error('That local time does not exist. Please choose another time.');
    if(next>now+2*366*86400000)throw new Error('Please choose a future time within two years.');
    const id=randomUUID();
    const schedule:ContractSchedule|undefined=action==='session'&&binding?{id,origin:m.id,owner,destination,channel,action:'session',text:body,binding_id:binding.id,binding_identity:bindingFingerprint(router,binding),date,time,zone:decision.zone,repeat,next_at:next,valid_until:now+2*366*86400000}:undefined;
    if(schedule&&router.contracts.enabled()){
      const contract=await router.contracts.preflight(router,m,body,schedule);
      if(contract.kind==='handled')return true;
      if(contract.kind==='replay')throw new Error('Finish the pending task contract before scheduling another task.');
      if(!this.context(destination,owner,channel)||!sessionAvailable(router,{binding_id:schedule.binding_id,binding_identity:schedule.binding_identity}))throw new Error('Your session or connection changed.');
    }
    this.store.db.exec('SAVEPOINT schedule_create');
    try{
      if(!this.context(destination,owner,channel))throw new Error('Your paired owner changed. No reminder was created.');
      if(Number((this.store.db.prepare("SELECT count(*) AS n FROM schedules WHERE owner=? AND destination=? AND status='active'").get(owner,destination) as {n:number}).n)>=MAX_SCHEDULES)throw new Error('You have 100 active reminders. Cancel one first.');
      this.store.db.prepare("INSERT INTO schedules VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,m.id,owner,destination,channel,action,body,binding?.id??null,binding?bindingFingerprint(router,binding):null,date,time,decision.zone,repeat,next,'active',now);
      if(schedule)router.contracts.saveSchedule(schedule,null,router.contracts.enabled()?'pass':'disabled',next);
      this.store.set(clarifyKey(destination),'null');
      const when=new Intl.DateTimeFormat('en-IN',{timeZone:decision.zone,dateStyle:'medium',timeStyle:'short'}).format(next);
      this.answer(m,`Reminder set for ${when} (${decision.zone}${repeat==='once'?'':`, ${repeat}`})${binding?` for ${binding.alias}`:''}.${schedule&&repeat!=='once'?` Authorization expires ${new Date(schedule.valid_until).toISOString()}.`:''}`);
      this.store.db.exec('RELEASE schedule_create');
    }catch(e){this.store.db.exec('ROLLBACK TO schedule_create; RELEASE schedule_create');throw e;}
    return true;
  }
  private advance(row:Row,now:number) {
    const start=localDate(now,row.zone),next=row.repeat==='once'?undefined:nextOccurrence(start,row.time,row.zone,row.repeat,now);
    this.store.db.prepare('UPDATE schedules SET status=?,next_at=? WHERE id=?').run(next===undefined?'done':'active',next??row.next_at,row.id);
    if(row.action==='session')this.store.db.prepare('UPDATE task_contract_schedules SET expected_next=? WHERE schedule_id=?').run(next??row.next_at,row.id);
  }
  /** Serialize due claims. Occurrence + outbox/job are one transaction; uncertain network sends are never assumed delivered. */
  async tick(router:Router):Promise<void> {
    if(this.ticking||router.stopped)return;this.ticking=true;
    try {
      const now=this.now();
      // Invalidate stale account ownership first, so abandoned rows cannot starve the current owner's due work.
      for(const channel of ['whatsapp','telegram']){const owner=this.store.get(channel==='telegram'?'telegram-owner':'whatsapp-owner')??'';this.store.db.prepare("UPDATE schedules SET status='invalid' WHERE status='active' AND channel=? AND owner<>?").run(channel,owner);}
      const channel=this.store.controlChannel(),rows=this.store.db.prepare("SELECT * FROM schedules WHERE status='active' AND action<>'brief' AND next_at<=? AND channel=? ORDER BY next_at,id LIMIT 100").all(now,channel) as Row[];
      // A slow brief must not starve ordinary reminders. Rotate through due briefs one per tick.
      const count=Number((this.store.db.prepare("SELECT count(*) AS n FROM schedules WHERE status='active' AND action='brief' AND next_at<=? AND channel=?").get(now,channel) as {n:number}).n);
      if(count){const offset=this.briefTurn++%count,brief=this.store.db.prepare("SELECT * FROM schedules WHERE status='active' AND action='brief' AND next_at<=? AND channel=? ORDER BY next_at,id LIMIT 1 OFFSET ?").get(now,channel,offset) as Row|undefined;if(brief)rows.push(brief);}
      for(const row of rows) {
        if(router.stopped)break;
        if(!validScheduleOwner(this.store,row.owner,row.destination,row.channel)){this.store.db.prepare("UPDATE schedules SET status='invalid' WHERE id=? AND status='active'").run(row.id);continue;}
        if(this.store.controlChannel()!==row.channel)continue;
        const occurrence=`schedule:${row.id}:${row.next_at}`;
        if(row.action==='brief') {
          if(!router.scheduledBrief)continue;
          // F1 owns its daily transaction and must dedupe occurrenceId on retries.
          let active=true,timer:ReturnType<typeof setTimeout>|undefined;
          const canSend=()=>active&&!router.stopped&&this.context(row.destination,row.owner,row.channel)&&!!this.store.db.prepare("SELECT 1 FROM schedules WHERE id=? AND status='active' AND next_at=?").get(row.id,row.next_at);
          const result=await Promise.race([Promise.resolve().then(()=>router.scheduledBrief!(row.destination,row.owner,occurrence,canSend)).catch(()=>'retry' as const),new Promise<'retry'>(resolve=>{timer=setTimeout(()=>resolve('retry'),this.briefTimeoutMs);})]);
          active=false;if(timer)clearTimeout(timer);
          if(router.stopped||!this.context(row.destination,row.owner,row.channel))continue;
          if(result==='retry')continue;
          this.store.db.exec('SAVEPOINT schedule_brief');
          try{if(!this.store.db.prepare("SELECT 1 FROM schedules WHERE id=? AND status='active' AND next_at=?").get(row.id,row.next_at)){this.store.db.exec('RELEASE schedule_brief');continue;}this.store.db.prepare('INSERT OR IGNORE INTO schedule_occurrences VALUES(?,?,?,?,?,?,?)').run(occurrence,row.id,row.owner,row.destination,row.channel,row.next_at,result==='invalid'?'invalid':'queued');if(result==='invalid')this.store.db.prepare("UPDATE schedules SET status='invalid' WHERE id=?").run(row.id);else this.advance(row,now);this.store.db.exec('RELEASE schedule_brief');}catch(e){this.store.db.exec('ROLLBACK TO schedule_brief; RELEASE schedule_brief');throw e;}
          continue;
        }
        this.store.db.exec('SAVEPOINT schedule_fire');
        try{
          const current=this.store.db.prepare("SELECT * FROM schedules WHERE id=? AND status='active' AND next_at=?").get(row.id,row.next_at) as Row|undefined;
          if(!current||!this.context(row.destination,row.owner,row.channel)){this.store.db.exec('RELEASE schedule_fire');continue;}
          if(row.action==='session'&&!router.contracts.scheduleAllowed(router,row)){
            this.store.db.prepare("UPDATE schedules SET status='invalid' WHERE id=?").run(row.id);
            this.store.output(undefined,'The scheduled request needs a new owner review or its approval expired. Nothing was sent.',`${occurrence}:contract-unavailable`,row.destination,{plain:true});
            const out=this.store.db.prepare('SELECT id FROM outbox WHERE source=?').get(`${occurrence}:contract-unavailable:0`) as {id:string}|undefined;if(out)this.store.db.prepare('INSERT OR IGNORE INTO schedule_outbox VALUES(?,?,?,?,?)').run(out.id,occurrence,row.owner,row.destination,row.channel);
            this.store.db.exec('RELEASE schedule_fire');continue;
          }
          const binding=row.action==='session'?sessionAvailable(router,row):undefined;
          if(row.action==='session'&&!binding){this.store.db.prepare("UPDATE schedules SET status='invalid' WHERE id=?").run(row.id);this.store.output(undefined,'A scheduled request was not sent because its session or Brain permissions changed.',`${occurrence}:unavailable`,row.destination,{plain:true});const out=this.store.db.prepare('SELECT id FROM outbox WHERE source=?').get(`${occurrence}:unavailable:0`) as {id:string}|undefined;if(out)this.store.db.prepare('INSERT OR IGNORE INTO schedule_outbox VALUES(?,?,?,?,?)').run(out.id,occurrence,row.owner,row.destination,row.channel);this.store.db.exec('RELEASE schedule_fire');continue;}
          this.store.db.prepare('INSERT OR IGNORE INTO schedule_occurrences VALUES(?,?,?,?,?,?,?)').run(occurrence,row.id,row.owner,row.destination,row.channel,row.next_at,'queued');
          if(row.action==='message'){
            this.store.output(undefined,`Reminder: ${row.text}`,occurrence,row.destination,{plain:true});
            const out=this.store.db.prepare('SELECT id FROM outbox WHERE source=?').get(`${occurrence}:0`) as {id:string}|undefined;
            if(!out)throw new Error('Reminder could not be queued.');
            this.store.db.prepare('INSERT OR IGNORE INTO schedule_outbox VALUES(?,?,?,?,?)').run(out.id,occurrence,row.owner,row.destination,row.channel);
          }else if(binding){
            const existing=this.store.job(occurrence);if(existing&&existing.destination!==row.destination)throw new Error('Scheduled request identity was reused.');
            router.contracts.linkScheduled(router,row.id,occurrence,binding,row.text);
            this.store.destinationContext.run(row.destination,()=>router.queue(occurrence,binding,row.text));
            this.store.db.prepare('INSERT OR IGNORE INTO schedule_jobs(job_id,occurrence_id,owner,destination,channel,binding_id,binding_identity,body_hash) VALUES(?,?,?,?,?,?,?,?)').run(occurrence,occurrence,row.owner,row.destination,row.channel,binding.id,row.binding_identity,hash(this.store.job(occurrence)!.body));
          }
          this.advance(row,now);this.store.db.exec('RELEASE schedule_fire');
        }catch(e){this.store.db.exec('ROLLBACK TO schedule_fire; RELEASE schedule_fire');throw e;}
      }
      router.pump();
    }finally{this.ticking=false;}
  }
}

/** Called at the actual delivery/dispatch boundary; old paired-owner work fails closed. */
export function scheduleOwnerValid(store:Store,kind:'job'|'outbox',id:string) {
  const table=kind==='job'?'schedule_jobs':'schedule_outbox',key=kind==='job'?'job_id':'outbox_id';
  if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))return true;
  const row=store.db.prepare(`SELECT owner,destination,channel FROM ${table} WHERE ${key}=?`).get(id) as {owner:string;destination:string;channel:string}|undefined;
  return !row||validScheduleOwner(store,row.owner,row.destination,row.channel);
}
/** Channel changes hold work; pairing/session changes invalidate it rather than reroute it. */
export function scheduleJobState(router:Router,id:string,inactive=false):'ready'|'hold'|'invalid' {
  const row=router.store.db.prepare(`SELECT j.owner,j.destination,j.channel,j.binding_id,j.binding_identity,j.occurrence_id,j.body_hash FROM schedule_jobs j
    JOIN schedule_occurrences o ON o.id=j.occurrence_id AND o.owner=j.owner AND o.destination=j.destination AND o.channel=j.channel
    JOIN schedules s ON s.id=o.schedule_id AND s.owner=j.owner AND s.destination=j.destination AND s.channel=j.channel WHERE j.job_id=?`).get(id) as (Pick<Row,'owner'|'destination'|'channel'|'binding_id'|'binding_identity'>&{occurrence_id:string;body_hash:string})|undefined;
  if(!row){
    if(id.startsWith('schedule:')||router.store.db.prepare('SELECT 1 FROM schedule_jobs WHERE job_id=?').get(id))return 'invalid';
    // A descendant of a scheduled request must have its own persisted guard.
    let root=id;const seen=new Set<string>();
    while(root.startsWith('master:')){if(seen.has(root)||seen.size>=4)return 'invalid';seen.add(root);const parent=router.store.get(`parent:${root}`);if(!parent)return 'invalid';root=parent;}
    return root.startsWith('schedule:')?'invalid':'ready';
  }
  const job=router.store.job(id);
  if(!validScheduleOwner(router.store,row.owner,row.destination,row.channel)||!sessionAvailable(router,row)||!job||job.binding_id!==row.binding_id||job.destination!==row.destination||hash(job.body)!==row.body_hash)return 'invalid';
  const schedule=router.store.db.prepare('SELECT s.* FROM schedule_occurrences o JOIN schedules s ON s.id=o.schedule_id WHERE o.id=?').get(row.occurrence_id) as Row|undefined;
  if(!schedule||!router.contracts.scheduleAllowed(router,schedule,false,true))return 'invalid';
  if(row.occurrence_id!==id){const root=scheduleJobState(router,row.occurrence_id,inactive);if(root!=='ready')return root;if(!['queued','dispatched','submitted'].includes(router.store.job(row.occurrence_id)?.status??''))return 'invalid';}
  return !inactive&&router.store.controlChannel()!==row.channel?'hold':'ready';
}
/** Follow coordinator delegation to its root; scheduled roots require a live owner-bound occurrence. */
export function scheduleRootState(router:Router,id:string,inactive=false):'not-schedule'|'ready'|'hold'|'invalid' {
  let root=id;const seen=new Set<string>();
  while(root.startsWith('master:')){if(seen.has(root)||seen.size>=4)return 'invalid';seen.add(root);const parent=router.store.get(`parent:${root}`);if(!parent)return 'invalid';root=parent;}
  if(root.startsWith('schedule:')&&root!==id){if(!['queued','dispatched','submitted'].includes(router.store.job(root)?.status??''))return 'invalid';const child=router.store.db.prepare('SELECT 1 FROM schedule_jobs WHERE job_id=? AND occurrence_id=?').get(id,root);if(!child)return 'invalid';return scheduleJobState(router,id,inactive);}
  return root.startsWith('schedule:')?scheduleJobState(router,root,inactive):'not-schedule';
}
/** True for guarded schedule roots, descendants and their internal reports. */
export function hasScheduleGuard(router:Router,id:string) {
  if(id.startsWith('schedule:')||router.store.db.prepare('SELECT 1 FROM schedule_jobs WHERE job_id=?').get(id))return true;
  let root=id;const seen=new Set<string>();
  while(root.startsWith('master:')){if(seen.has(root)||seen.size>=4)return false;seen.add(root);const parent=router.store.get(`parent:${root}`);if(!parent)return false;root=parent;}
  return root.startsWith('schedule:');
}
/** A known pre-submit rejection is recorded without claiming uncertain delivery. */
export function failScheduledBeforeSubmission(router:Router,id:string,reason:string) {
  const job=router.store.job(id),guard=router.store.db.prepare('SELECT owner,destination,channel FROM schedule_jobs WHERE job_id=?').get(id) as Pick<Row,'owner'|'destination'|'channel'>|undefined;
  if(!hasScheduleGuard(router,id)||!job||!['queued','dispatched'].includes(job.status))return;
  router.store.db.exec('SAVEPOINT reject_schedule_dispatch');
  try{
    router.store.jobState(id,'failed',reason);
    router.store.db.prepare("UPDATE outbox SET status='cancelled',error='Scheduled action was not sent' WHERE status='queued' AND source=?").run(`native-opening:${id}:0`);
    if(guard&&validScheduleOwner(router.store,guard.owner,guard.destination,guard.channel)&&router.store.controlChannel()===guard.channel){
      const source=`schedule-error:${id}`;router.store.output(undefined,reason,source,guard.destination,{plain:true});
      const out=router.store.db.prepare('SELECT id FROM outbox WHERE source=?').get(`${source}:0`) as {id:string}|undefined;
      if(out)router.store.db.prepare('INSERT OR IGNORE INTO schedule_outbox VALUES(?,?,?,?,?)').run(out.id,id,guard.owner,guard.destination,guard.channel);
    }
    router.store.db.exec('RELEASE reject_schedule_dispatch');
  }catch(e){router.store.db.exec('ROLLBACK TO reject_schedule_dispatch; RELEASE reject_schedule_dispatch');throw e;}
}
/** Carry the immutable owner/occurrence and exact target fingerprint through delegation. */
export function bindScheduledChild(router:Router,parentId:string,id:string,target:Binding,body:string,inactive=false) {
  const parent=router.store.db.prepare('SELECT occurrence_id,owner,destination,channel FROM schedule_jobs WHERE job_id=?').get(parentId) as {occurrence_id:string;owner:string;destination:string;channel:string}|undefined;
  if(!parent){if(scheduleRootState(router,parentId)!=='not-schedule')throw new Error('Scheduled request ownership is unavailable.');return;}
  if(scheduleJobState(router,parentId,inactive)!=='ready')throw new Error('The scheduled request owner or session changed.');
  const identity=bindingFingerprint(router,target),bodyHash=hash(body),existing=router.store.db.prepare('SELECT binding_id,binding_identity,occurrence_id,body_hash FROM schedule_jobs WHERE job_id=?').get(id) as {binding_id:string;binding_identity:string;occurrence_id:string;body_hash:string}|undefined;
  if(existing&&(existing.binding_id!==target.id||existing.binding_identity!==identity||existing.occurrence_id!==parent.occurrence_id||existing.body_hash!==bodyHash))throw new Error('Scheduled delegation identity changed.');
  router.store.db.prepare('INSERT OR IGNORE INTO schedule_jobs(job_id,occurrence_id,owner,destination,channel,binding_id,binding_identity,body_hash) VALUES(?,?,?,?,?,?,?,?)').run(id,parent.occurrence_id,parent.owner,parent.destination,parent.channel,target.id,identity,bodyHash);
}
export function scheduleDeliveryState(store:Store,id:string):'ready'|'hold'|'invalid' {
  if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schedule_outbox'").get())return 'ready';
  const row=store.db.prepare('SELECT owner,destination,channel FROM schedule_outbox WHERE outbox_id=?').get(id) as Pick<Row,'owner'|'destination'|'channel'>|undefined;
  if(!row)return 'ready';
  if(!validScheduleOwner(store,row.owner,row.destination,row.channel))return 'invalid';
  return store.controlChannel()===row.channel?'ready':'hold';
}
