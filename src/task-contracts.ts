import {randomUUID} from 'node:crypto';
import {brainPolicy,MetaSecret} from './meta-brain-config.js';
import {ContractDecision,interpretContract,type ContractInterpreter} from './task-contract-model.js';
import {authenticatedOwner} from './owner-commands.js';
import {hash,type Binding,type Store} from './store.js';
import {scheduleJobState} from './schedules.js';
import type {Incoming,Router} from './router.js';

type Draft={goal:string;exclusions:string[];checks:{id:string;text:string}[];question:string};
type ContractRow={id:string;origin_id:string;owner:string;destination:string;channel:string;original:string;review_text:string;incoming:string;edits:string;draft:string;revision:number;policy_hash:string;routing_hash:string;key_hash:string;state:string;expires_at:number;dispatch_id:string|null;item_id:number|null;binding_id:string|null;binding_hash:string|null;body_hash:string|null;approved_hash:string|null;approved_at:number|null};
export type ContractSchedule={id:string;origin:string;owner:string;destination:string;channel:string;action:'session';text:string;binding_id:string;binding_identity:string;date:string;time:string;zone:string;repeat:'once'|'daily'|'weekdays';next_at:number;valid_until:number};
type BriefIntent={itemId:number;target:string;text:string;identity:string};
export type ContractResult={kind:'pass'}|{kind:'handled'}|{kind:'replay';incoming:Incoming};
const expiry=30*60_000;
const clean=(value:string)=>value.replace(/[\x00-\x1f\x7f]/g,' ').replace(/[—–]/g,', ').replace(/\s+/g,' ').trim();

function bindingHash(r:Router,b:Binding){return hash(JSON.stringify([b.id,b.native_id,b.cwd,b.mode,b.provider,b.enabled,b.token_hash,r.store.get(`execution-mode:${b.id}`),r.store.get(`session-route:${b.id}`),r.coordinator?.registry.entry(b.id)]));}
function routingHash(r:Router,destination:string){return hash(JSON.stringify([
  r.store.get('master'),r.store.get('active'),r.store.get('selected'),r.store.get('enabled-apps'),r.store.get(`direct:${destination}`),r.store.get(`owner-target:${destination}`),
  r.store.bindings().map(b=>bindingHash(r,b)).sort(),
]));}
function contextValid(r:Router,row:Pick<ContractRow,'owner'|'destination'|'channel'|'policy_hash'|'routing_hash'>){
  return !r.stopped&&r.store.destination()===row.destination&&r.store.ownerFor(row.destination)===row.owner&&r.store.controlChannel()===row.channel&&
    hash(JSON.stringify(brainPolicy(r.store)))===row.policy_hash&&routingHash(r,row.destination)===row.routing_hash;
}
function dispatchContextValid(r:Router,row:Pick<ContractRow,'owner'|'destination'|'channel'|'policy_hash'>,inactive=false){
  const ownerValid=r.store.ownerFor(row.destination)===row.owner&&(row.channel==='telegram'?row.destination===r.store.get('telegram-owner'):row.destination===row.owner||row.destination===r.store.get('destination-jid')&&!!r.store.get(`owned-group:${row.destination}`));
  return ownerValid&&hash(JSON.stringify(brainPolicy(r.store)))===row.policy_hash&&(inactive||!r.stopped&&r.store.destination()===row.destination&&r.store.controlChannel()===row.channel);
}

/** Owner confirmation is persisted separately from the model proposal and exact original request. */
export class TaskContracts {
  constructor(readonly store:Store,readonly secret=new MetaSecret(),readonly interpret:ContractInterpreter=interpretContract,readonly now=()=>Date.now()){
    store.db.exec(`CREATE TABLE IF NOT EXISTS task_contracts(
      id TEXT PRIMARY KEY,origin_id TEXT UNIQUE NOT NULL,owner TEXT NOT NULL,destination TEXT NOT NULL,channel TEXT NOT NULL,
      original TEXT NOT NULL,review_text TEXT NOT NULL,incoming TEXT NOT NULL,edits TEXT NOT NULL,draft TEXT NOT NULL,revision INTEGER NOT NULL,
      policy_hash TEXT NOT NULL,routing_hash TEXT NOT NULL,key_hash TEXT NOT NULL,state TEXT NOT NULL,expires_at INTEGER NOT NULL,
      dispatch_id TEXT UNIQUE,item_id INTEGER,binding_id TEXT,binding_hash TEXT,body_hash TEXT,approved_hash TEXT,approved_at INTEGER,created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS task_contracts_pending ON task_contracts(owner,destination) WHERE state='pending';
      CREATE INDEX IF NOT EXISTS task_contracts_item ON task_contracts(item_id,state);
      CREATE TABLE IF NOT EXISTS task_contract_outbox(outbox_id TEXT PRIMARY KEY,contract_id TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_contract_schedule_drafts(contract_id TEXT PRIMARY KEY,payload TEXT NOT NULL,payload_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_contract_brief_drafts(contract_id TEXT PRIMARY KEY,payload TEXT NOT NULL,payload_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_contract_schedules(schedule_id TEXT PRIMARY KEY,contract_id TEXT,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,expected_next INTEGER NOT NULL,valid_until INTEGER NOT NULL,policy_hash TEXT NOT NULL,key_hash TEXT NOT NULL,mode TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_contract_jobs(job_id TEXT PRIMARY KEY,contract_id TEXT NOT NULL,parent_id TEXT,binding_id TEXT NOT NULL,binding_hash TEXT NOT NULL,raw_hash TEXT NOT NULL,body_hash TEXT NOT NULL,item_id INTEGER);
      CREATE TABLE IF NOT EXISTS task_contract_report_sources(job_id TEXT PRIMARY KEY,source_id TEXT NOT NULL,source_binding_id TEXT NOT NULL,source_binding_hash TEXT NOT NULL,source_body_hash TEXT NOT NULL,parent_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_contract_option_proofs(job_id TEXT PRIMARY KEY,option_id TEXT NOT NULL,parent_id TEXT NOT NULL,outbox_id TEXT NOT NULL,selected_id TEXT NOT NULL,choices_hash TEXT NOT NULL,outbox_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,owner TEXT NOT NULL,destination TEXT NOT NULL,channel TEXT NOT NULL,binding_id TEXT NOT NULL,binding_hash TEXT NOT NULL,parent_body_hash TEXT NOT NULL,job_body_hash TEXT NOT NULL,item_id INTEGER,parent_item_id INTEGER,policy_hash TEXT,key_hash TEXT);`);
  }
  enabled(){const p=brainPolicy(this.store);return p.enabled&&p.taskContracts;}
  private row(id:string){return this.store.db.prepare('SELECT * FROM task_contracts WHERE id=?').get(id) as ContractRow|undefined;}
  private jobContract(id:string){return this.store.db.prepare("SELECT t.* FROM task_contracts t LEFT JOIN task_contract_jobs j ON j.contract_id=t.id WHERE t.state='approved' AND (t.dispatch_id=? OR j.job_id=?) LIMIT 1").get(id,id) as ContractRow|undefined;}
  hasGuard(id:string){return !!this.store.db.prepare('SELECT 1 FROM task_contracts WHERE dispatch_id=? UNION ALL SELECT 1 FROM task_contract_jobs WHERE job_id=? LIMIT 1').get(id,id);}
  private pending(owner:string,destination:string){return this.store.db.prepare("SELECT * FROM task_contracts WHERE owner=? AND destination=? AND state='pending'").get(owner,destination) as ContractRow|undefined;}
  private context(r:Router,m:Incoming,option=false){
    const destination=this.store.destination(),owner=this.store.ownerFor(destination),channel=this.store.controlChannel();
    if(!destination||!owner||!option&&!authenticatedOwner(r,m))return;
    return {destination,owner,channel,policy_hash:hash(JSON.stringify(brainPolicy(this.store))),routing_hash:routingHash(r,destination)};
  }
  private draft(decision:ReturnType<typeof ContractDecision.parse>,id:string,revision:number):Draft {
    const goal=clean(decision.goal),checks=decision.checks.map((text,i)=>({id:`${id}:${revision}:${i+1}`,text:clean(text)}));
    if(!goal||checks.length<2||checks.some(c=>!c.text))throw new Error('The task contract was incomplete. Nothing was sent.');
    return {goal,exclusions:decision.exclusions.map(clean).filter(Boolean),checks,question:clean(decision.question)};
  }
  private prompt(row:ContractRow,draft:Draft){
    const lines=['Please review this task before it starts.',`Build: ${draft.goal}`,
      `Do not touch: ${draft.exclusions.length?draft.exclusions.join('; '):'No exclusions were specified.'}`,
      'Done when:',...draft.checks.map((check,i)=>`${i+1}. ${check.text}`),
      ...(draft.question?[`Question: ${draft.question}`,'Reply with your answer or edit: followed by a correction.']:['Reply ok to approve, edit: followed by a correction, or cancel.'])];
    // Include the exact original (bounded separately before entry), so omitted constraints remain visible.
    lines.splice(1,0,`Your request: ${row.original}`,...(row.review_text!==row.original?[`Task to review: ${row.review_text}`]:[]));
    const schedule=this.store.db.prepare('SELECT payload,payload_hash FROM task_contract_schedule_drafts WHERE contract_id=?').get(row.id) as {payload:string;payload_hash:string}|undefined;
    if(schedule){if(hash(schedule.payload)!==schedule.payload_hash)throw new Error('The scheduled task changed. Nothing was sent.');const s=JSON.parse(schedule.payload) as ContractSchedule;lines.splice(2,0,`Schedule: ${s.date} at ${s.time} (${s.zone}), ${s.repeat}. This approval expires ${new Date(s.valid_until).toISOString()}. Cancel the reminder to revoke it.`);}
    const brief=this.store.db.prepare('SELECT payload,payload_hash FROM task_contract_brief_drafts WHERE contract_id=?').get(row.id) as {payload:string;payload_hash:string}|undefined;
    if(brief){if(hash(brief.payload)!==brief.payload_hash)throw new Error('The brief item changed. Nothing was sent.');const item=JSON.parse(brief.payload) as BriefIntent;lines.splice(2,0,`Brief item: #${item.itemId}.`);}
    return lines.join('\n');
  }
  private send(row:ContractRow,draft:Draft){
    const source=`task-contract:${row.id}:${row.revision}`;
    this.store.output(undefined,this.prompt(row,draft),source,row.destination,{plain:true});
    const parts=this.store.db.prepare('SELECT id FROM outbox WHERE source LIKE ? AND destination=?').all(`${source}:%`,row.destination) as {id:string}[];
    if(!parts.length)throw new Error('Task contract could not be queued.');
    for(const part of parts)this.store.db.prepare('INSERT OR IGNORE INTO task_contract_outbox VALUES(?,?,?,?)').run(part.id,row.id,row.revision,'proposal');
  }
  private sent(row:ContractRow){
    const parts=this.store.db.prepare('SELECT o.status FROM task_contract_outbox c JOIN outbox o ON o.id=c.outbox_id WHERE c.contract_id=? AND c.revision=?').all(row.id,row.revision) as {status:string}[];
    return parts.length>0&&parts.every(part=>part.status==='sent');
  }
  private belongsToDraft(row:ContractRow,quotedId?:string){
    if(!quotedId)return true;
    return !!this.store.db.prepare('SELECT 1 FROM task_contract_outbox c JOIN outbox o ON o.id=c.outbox_id WHERE o.wa_id=? AND c.contract_id=? AND c.revision=? AND o.destination=?').get(quotedId,row.id,row.revision,row.destination);
  }
  private answer(m:Incoming,text:string){this.store.output(undefined,text,`task-contract-reply:${m.id}`,undefined,{plain:true});this.store.remember(m.id);}
  shouldHandle(r:Router,m:Incoming){
    const context=this.context(r,m);if(!context)return false;
    if(this.pending(context.owner,context.destination))return true;
    if(!this.enabled())return false;
    const text=m.text.trim();return !text.startsWith('/')||/^\/to\s+/i.test(text);
  }
  /** Recover an approval saved before a crash without routing its 'ok' as a task. */
  recoverApproved(r:Router,m:Incoming){
    const row=this.store.db.prepare("SELECT * FROM task_contracts WHERE dispatch_id=? AND state='approved'").get(m.id) as ContractRow|undefined;if(!row)return;
    if(!authenticatedOwner(r,m)||m.source==='voice'||m.quotedId||m.ownerCommand!==true||!/^(?:ok|okay)[.!]?$/i.test(m.text.trim())||!this.sent(row)||!contextValid(r,row)||hash(this.secret.read()??'')!==row.key_hash)throw new Error('The approved task or connection changed. Nothing was sent.');
    const schedule=this.store.db.prepare('SELECT payload,payload_hash FROM task_contract_schedule_drafts WHERE contract_id=?').get(row.id) as {payload:string;payload_hash:string}|undefined;
    const brief=this.store.db.prepare('SELECT payload,payload_hash FROM task_contract_brief_drafts WHERE contract_id=?').get(row.id) as {payload:string;payload_hash:string}|undefined;
    if(schedule&&hash(schedule.payload)!==schedule.payload_hash||brief&&hash(brief.payload)!==brief.payload_hash||hash(JSON.stringify([row.id,row.origin_id,row.owner,row.destination,row.revision,row.original,row.review_text,row.incoming,row.edits,row.draft,schedule?.payload_hash??null,brief?.payload_hash??null]))!==row.approved_hash)throw new Error('The approved task changed. Nothing was sent.');
    return {...JSON.parse(row.incoming) as Incoming,id:m.id};
  }
  /** Invoke only after permission/option replies have had their own chance to consume the message. */
  async preflight(r:Router,m:Incoming,reviewText?:string,schedule?:ContractSchedule,brief?:BriefIntent,option=false,optionGuarded=false):Promise<ContractResult>{
    const context=this.context(r,m,option);if(!context)return {kind:'pass'};
    let pending=this.pending(context.owner,context.destination);
    if(pending&&pending.expires_at<=this.now()){
      const expired=pending;this.store.db.prepare("UPDATE task_contracts SET state='expired' WHERE id=? AND state='pending'").run(expired.id);pending=undefined;
      if(m.quotedId?this.belongsToDraft(expired,m.quotedId):/^(?:ok|okay|cancel)(?:\s+contract)?[.!]?$/i.test(m.text.trim())){this.answer(m,'That task contract expired. Send the task again. Nothing was sent.');return {kind:'handled'};}
    }
    if(pending){
      if(option){this.answer(m,'Finish or cancel the pending task contract before choosing another answer. Nothing was sent.');return {kind:'handled'};}
      if(!contextValid(r,pending)||hash(this.secret.read()??'')!==pending.key_hash){this.store.db.prepare("UPDATE task_contracts SET state='invalid' WHERE id=? AND state='pending'").run(pending.id);this.answer(m,'The task or connection changed. Send the task again. Nothing was sent.');return {kind:'handled'};}
      if(!this.belongsToDraft(pending,m.quotedId)){this.answer(m,'Finish or cancel the pending task contract before starting another task.');return {kind:'handled'};}
      const text=m.text.trim();
      const trusted=m.quotedId?m.ownerChoice===true:m.source==='voice'?m.ownerIntent===true:m.ownerCommand===true;
      if(!trusted){this.answer(m,'Reply directly to this task contract with your own message. Nothing was sent.');return {kind:'handled'};}
      if(/^(?:cancel|cancel contract)[.!]?$/i.test(text)){
        this.store.db.prepare("UPDATE task_contracts SET state='cancelled' WHERE id=? AND state='pending'").run(pending.id);this.answer(m,'Task cancelled. Nothing was sent.');return {kind:'handled'};
      }
      const approved=/^(?:ok|okay)[.!]?$/i.test(text);
      if(approved){
        if(m.quotedId){this.answer(m,'Type ok as a new message to approve this task. Nothing was sent.');return {kind:'handled'};}
        if(m.source==='voice'){this.answer(m,'Please type ok to approve this task. Nothing was sent.');return {kind:'handled'};}
        if(!this.sent(pending)){this.answer(m,'Wait for the task contract to arrive before approving it.');return {kind:'handled'};}
        const draft=JSON.parse(pending.draft) as Draft;
        if(draft.question){this.answer(m,'Please answer the question first. Nothing was sent.');return {kind:'handled'};}
        const original=JSON.parse(pending.incoming) as Incoming;
        const schedule=this.store.db.prepare('SELECT payload,payload_hash FROM task_contract_schedule_drafts WHERE contract_id=?').get(pending.id) as {payload:string;payload_hash:string}|undefined;
        const brief=this.store.db.prepare('SELECT payload,payload_hash FROM task_contract_brief_drafts WHERE contract_id=?').get(pending.id) as {payload:string;payload_hash:string}|undefined;
        if(schedule&&hash(schedule.payload)!==schedule.payload_hash)throw new Error('The scheduled task changed. Nothing was sent.');
        if(brief&&hash(brief.payload)!==brief.payload_hash)throw new Error('The brief item changed. Nothing was sent.');
        const approvedHash=hash(JSON.stringify([pending.id,pending.origin_id,pending.owner,pending.destination,pending.revision,pending.original,pending.review_text,pending.incoming,pending.edits,pending.draft,schedule?.payload_hash??null,brief?.payload_hash??null]));
        const changed=this.store.db.prepare("UPDATE task_contracts SET state='approved',dispatch_id=?,approved_hash=?,approved_at=? WHERE id=? AND state='pending' AND revision=? AND expires_at>?").run(m.id,approvedHash,this.now(),pending.id,pending.revision,this.now());
        if(!changed.changes)throw new Error('This task contract is no longer available.');
        return {kind:'replay',incoming:{...original,id:m.id}};
      }
      if(text.startsWith('/')&&!/^\/contract\s+edit\s+/i.test(text)){
        if(/^\/to(?:\s|$)/i.test(text)){this.answer(m,'Finish or cancel the pending task contract before starting another task.');return {kind:'handled'};}
        return {kind:'pass'};
      }
      const currentDraft=JSON.parse(pending.draft) as Draft;
      if(!currentDraft.question&&!/^(?:edit\s*:|\/contract\s+edit\s+)/i.test(text)){this.answer(m,'Reply ok, edit: followed by a correction, or cancel the pending task.');return {kind:'handled'};}
      if(!this.sent(pending)){this.answer(m,'Wait for the task contract to arrive before editing it.');return {kind:'handled'};}
      const edit=text.replace(/^(?:edit\s*:\s*|\/contract\s+edit\s+)/i,'').trim();
      if(!edit||edit.length>2000){this.answer(m,'Send a short answer or use edit: followed by your correction.');return {kind:'handled'};}
      const edits=JSON.parse(pending.edits) as string[];if(edits.length>=8){this.answer(m,'This contract has too many edits. Cancel it and send a new task.');return {kind:'handled'};}
      const decision=ContractDecision.parse(await this.interpret(this.secret.read()??'',pending.review_text,[...edits,edit]));
      if(!contextValid(r,pending)||hash(this.secret.read()??'')!==pending.key_hash){this.answer(m,'The task or connection changed. Send the task again. Nothing was sent.');return {kind:'handled'};}
      // Once offered, editing never silently bypasses approval even if the model returns pass.
      if(decision.kind!=='contract'){this.answer(m,'I could not update the contract. Please send the correction again.');return {kind:'handled'};}
      const revision=pending.revision+1,draft=this.draft(decision,pending.id,revision);
      this.store.db.exec('SAVEPOINT contract_edit');
      try{
        const changed=this.store.db.prepare("UPDATE task_contracts SET edits=?,draft=?,revision=?,expires_at=? WHERE id=? AND state='pending' AND revision=?").run(JSON.stringify([...edits,edit]),JSON.stringify(draft),revision,this.now()+expiry,pending.id,pending.revision);
        if(!changed.changes)throw new Error('Contract changed.');
        pending=this.row(pending.id)!;this.send(pending,draft);this.store.remember(m.id);this.store.db.exec('RELEASE contract_edit');
      }catch(e){this.store.db.exec('ROLLBACK TO contract_edit; RELEASE contract_edit');throw e;}
      return {kind:'handled'};
    }
    if(!this.enabled())return {kind:'pass'};
    const text=m.text.trim();
    // Bridge controls are not coding work; /to is an explicit owner task and must be classified.
    if(text.startsWith('/')&&!/^\/to\s+/i.test(text))return {kind:'pass'};
    const key=this.secret.read();if(!key)throw new Error('The task contract needs a Meta key. Nothing was sent.');
    const review=(reviewText??text).trim();if(text.length>4000||review.length>4000)throw new Error('Please send a task under 4,000 characters for review. Nothing was sent.');
    const decision=ContractDecision.parse(await this.interpret(key,review,[]));
    if(!contextValid(r,context)||hash(this.secret.read()??'')!==hash(key))throw new Error('Your connection or settings changed. Nothing was sent.');
    if(decision.kind==='pass')return {kind:'pass'};
    const id=randomUUID(),draft=this.draft(decision,id,1),now=this.now();
    this.store.db.exec('SAVEPOINT contract_new');
    try{
      this.store.db.prepare('INSERT INTO task_contracts(id,origin_id,owner,destination,channel,original,review_text,incoming,edits,draft,revision,policy_hash,routing_hash,key_hash,state,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,m.id,context.owner,context.destination,context.channel,text,review,JSON.stringify(optionGuarded?{...m,contractOption:true}:m),'[]',JSON.stringify(draft),1,context.policy_hash,context.routing_hash,hash(key),'pending',now+expiry,now);
      if(schedule){if(schedule.origin!==m.id||schedule.owner!==context.owner||schedule.destination!==context.destination||schedule.channel!==context.channel||schedule.text!==review||schedule.valid_until<=now)throw new Error('The scheduled task changed. Nothing was sent.');const payload=JSON.stringify(schedule);this.store.db.prepare('INSERT INTO task_contract_schedule_drafts VALUES(?,?,?)').run(id,payload,hash(payload));}
      if(brief){if(!Number.isSafeInteger(brief.itemId)||brief.itemId<=0||!brief.target||brief.text!==review)throw new Error('The brief item changed. Nothing was sent.');const payload=JSON.stringify(brief);this.store.db.prepare('INSERT INTO task_contract_brief_drafts VALUES(?,?,?)').run(id,payload,hash(payload));}
      this.send(this.row(id)!,draft);this.store.remember(m.id);this.store.db.exec('RELEASE contract_new');
    }catch(e){this.store.db.exec('ROLLBACK TO contract_new; RELEASE contract_new');throw e;}
    return {kind:'handled'};
  }
  /** Return the exact schedule reviewed by the owner, never a second model interpretation. */
  approvedSchedule(id:string){
    const row=this.jobContract(id);if(!row)return;
    const draft=this.store.db.prepare('SELECT payload,payload_hash FROM task_contract_schedule_drafts WHERE contract_id=?').get(row.id) as {payload:string;payload_hash:string}|undefined;
    if(!draft)return;
    const expected=hash(JSON.stringify([row.id,row.origin_id,row.owner,row.destination,row.revision,row.original,row.review_text,row.incoming,row.edits,row.draft,draft.payload_hash,null]));
    if(hash(draft.payload)!==draft.payload_hash||expected!==row.approved_hash)throw new Error('The approved schedule changed. Nothing was scheduled.');
    return {contractId:row.id,schedule:JSON.parse(draft.payload) as ContractSchedule};
  }
  approvedBrief(id:string){
    const row=this.jobContract(id);if(!row)return;
    const draft=this.store.db.prepare('SELECT payload,payload_hash FROM task_contract_brief_drafts WHERE contract_id=?').get(row.id) as {payload:string;payload_hash:string}|undefined;
    if(!draft)return;
    const expected=hash(JSON.stringify([row.id,row.origin_id,row.owner,row.destination,row.revision,row.original,row.review_text,row.incoming,row.edits,row.draft,null,draft.payload_hash]));
    if(hash(draft.payload)!==draft.payload_hash||expected!==row.approved_hash)throw new Error('The approved brief item changed. Nothing was sent.');
    return JSON.parse(draft.payload) as BriefIntent;
  }
  briefIntent(r:Router,itemId:number,target:string,text:string):BriefIntent {const binding=r.store.binding(target);if(!binding?.enabled)throw new Error('The brief session is unavailable. Nothing was sent.');return {itemId,target,text,identity:bindingHash(r,binding)};}
  verifyBrief(r:Router,id:string,itemId:number,target:string,text:string){const saved=this.approvedBrief(id);if(!saved||JSON.stringify(saved)!==JSON.stringify(this.briefIntent(r,itemId,target,text)))throw new Error('The approved brief item or session changed. Nothing was sent.');}
  /** Record exact schedule data and owner authorization; future occurrences cannot silently renew it. */
  saveSchedule(schedule:ContractSchedule,contractId:string|null,mode:'approved'|'pass'|'disabled',expectedNext:number){
    const payload=JSON.stringify({...schedule,next_at:expectedNext}),policy=hash(JSON.stringify(brainPolicy(this.store))),key=hash(this.secret.read()??'');
    this.store.db.prepare('INSERT INTO task_contract_schedules VALUES(?,?,?,?,?,?,?,?,?)').run(schedule.id,contractId,payload,hash(payload),expectedNext,schedule.valid_until,policy,key,mode);
  }
  scheduleAllowed(r:Router,row:{id:string;owner:string;destination:string;channel:string;action:string;text:string;binding_id:string|null;binding_identity:string|null;date:string;time:string;zone:string;repeat:string;next_at:number;status:string},checkNext=true,inactive=false){
    const g=this.store.db.prepare('SELECT * FROM task_contract_schedules WHERE schedule_id=?').get(row.id) as {contract_id:string|null;payload:string;payload_hash:string;expected_next:number;valid_until:number;policy_hash:string;key_hash:string;mode:string}|undefined;
    if(!g)return !this.enabled();
    if(hash(g.payload)!==g.payload_hash||g.valid_until<=this.now()||g.policy_hash!==hash(JSON.stringify(brainPolicy(this.store)))||g.key_hash!==hash(this.secret.read()??'')||checkNext&&g.expected_next!==row.next_at)return false;
    let s:ContractSchedule;try{s=JSON.parse(g.payload);}catch{return false;}
    if(!['active','done'].includes(row.status)||s.id!==row.id||s.owner!==row.owner||s.destination!==row.destination||s.channel!==row.channel||s.action!==row.action||s.text!==row.text||s.binding_id!==row.binding_id||s.binding_identity!==row.binding_identity||s.date!==row.date||s.time!==row.time||s.zone!==row.zone||s.repeat!==row.repeat||s.valid_until!==g.valid_until)return false;
    if(g.mode==='disabled')return !this.enabled();
    if(g.mode==='pass')return this.enabled();
    const contract=g.contract_id?this.row(g.contract_id):undefined;
    if(g.mode!=='approved'||!contract||contract.state!=='approved'||!contract.dispatch_id||!dispatchContextValid(r,contract,inactive)||hash(this.secret.read()??'')!==contract.key_hash)return false;
    try{const approved=this.approvedSchedule(contract.dispatch_id)?.schedule;if(!approved)return false;return JSON.stringify({...approved,next_at:s.next_at})===JSON.stringify(s);}catch{return false;}
  }
  advanceSchedule(id:string,next:number){this.store.db.prepare('UPDATE task_contract_schedules SET expected_next=? WHERE schedule_id=?').run(next,id);}
  linkScheduled(r:Router,scheduleId:string,jobId:string,binding:Binding,body:string){
    const g=this.store.db.prepare('SELECT contract_id,mode FROM task_contract_schedules WHERE schedule_id=?').get(scheduleId) as {contract_id:string|null;mode:string}|undefined;
    if(!g||g.mode!=='approved')return;
    const row=g.contract_id?this.row(g.contract_id):undefined;if(!row||row.state!=='approved'||row.review_text!==body)throw new Error('The approved scheduled task changed. Nothing was sent.');
    const prior=this.store.db.prepare('SELECT contract_id,binding_id,binding_hash,raw_hash FROM task_contract_jobs WHERE job_id=?').get(jobId) as {contract_id:string;binding_id:string;binding_hash:string;raw_hash:string}|undefined;
    const identity=bindingHash(r,binding);if(prior&&(prior.contract_id!==row.id||prior.binding_id!==binding.id||prior.binding_hash!==identity||prior.raw_hash!==hash(body)))throw new Error('Scheduled task identity changed. Nothing was sent.');
    this.store.db.prepare('INSERT OR IGNORE INTO task_contract_jobs(job_id,contract_id,binding_id,binding_hash,raw_hash,body_hash,item_id) VALUES(?,?,?,?,?,?,?)').run(jobId,row.id,binding.id,identity,hash(body),'',row.item_id);
    if(row.item_id)this.store.linkItem(jobId,row.item_id);
  }
  /** Propagate the exact owner-approved contract through delegated work. */
  bindChild(r:Router,parentId:string,id:string,binding:Binding,body:string,itemId:number|undefined){
    const row=this.jobContract(parentId);if(!row){if(this.hasGuard(parentId))throw new Error('The task contract is unavailable. Nothing was sent.');return body;}
    const parent=this.store.job(parentId),parentBinding=parent&&this.store.binding(parent.binding_id);
    if(!parent||!parentBinding||!row.item_id||itemId!==row.item_id)throw new Error('The approved task or item changed. Nothing was sent.');
    this.assertDispatch(r,parentId,parentBinding,parent.body);
    const text=this.render(row,body),identity=bindingHash(r,binding),prior=this.store.db.prepare('SELECT contract_id,parent_id,binding_id,binding_hash,raw_hash,body_hash,item_id FROM task_contract_jobs WHERE job_id=?').get(id) as {contract_id:string;parent_id:string;binding_id:string;binding_hash:string;raw_hash:string;body_hash:string;item_id:number}|undefined;
    if(prior&&(prior.contract_id!==row.id||prior.parent_id!==parentId||prior.binding_id!==binding.id||prior.binding_hash!==identity||prior.raw_hash!==hash(body)||prior.body_hash!==hash(text)||prior.item_id!==itemId))throw new Error('The delegated task changed. Nothing was sent.');
    this.store.db.prepare('INSERT OR IGNORE INTO task_contract_jobs(job_id,contract_id,parent_id,binding_id,binding_hash,raw_hash,body_hash,item_id) VALUES(?,?,?,?,?,?,?,?)').run(id,row.id,parentId,binding.id,identity,hash(body),hash(text),itemId);
    return text;
  }
  childMatches(id:string,body:string){const row=this.store.db.prepare('SELECT raw_hash FROM task_contract_jobs WHERE job_id=?').get(id) as {raw_hash:string}|undefined;return !!row&&row.raw_hash===hash(body);}
  /** Persist the exact selected message and original task with its continuation. */
  bindChoice(r:Router,parentId:string,id:string,optionId:string){
    const parent=this.store.job(parentId),job=this.store.job(id),binding=parent&&this.store.binding(parent.binding_id);
    const option=this.store.db.prepare(`SELECT o.id,o.outbox_id,o.request_id,o.binding_id,o.destination,o.owner,o.selected_id,o.response_id,o.choices,o.expires_at,
      b.status,b.reply_kind,b.request_id AS reply_request,b.binding_id AS reply_binding,b.destination AS reply_destination,b.body
      FROM message_options o JOIN outbox b ON b.id=o.outbox_id WHERE o.id=?`).get(optionId) as any;
    if(!parent||!job||!binding||!option||['replaced','cancelled','reviewed','auto_closed'].includes(parent.status)||option.request_id!==parentId||option.binding_id!==parent.binding_id||job.binding_id!==binding.id||option.destination!==parent.destination||job.destination!==option.destination||option.owner!==this.store.ownerFor(option.destination)||option.response_id!==id||!option.selected_id||option.expires_at<=this.now()||option.status!=='sent'||!['progress','final'].includes(option.reply_kind)||option.reply_request!==parentId||option.reply_binding!==parent.binding_id||option.reply_destination!==parent.destination||this.store.itemOf(parentId)!==undefined&&this.store.itemOf(id)!==this.store.itemOf(parentId))throw new Error('The original choice is unavailable. Nothing was sent.');
    const checked=this.enabled();
    this.store.db.prepare('INSERT INTO task_contract_option_proofs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,option.id,parentId,option.outbox_id,option.selected_id,hash(option.choices),hash(option.body),option.expires_at,option.owner,option.destination,this.store.controlChannel(),binding.id,bindingHash(r,binding),hash(parent.body),hash(job.body),this.store.itemOf(id)??null,this.store.itemOf(parentId)??null,checked?hash(JSON.stringify(brainPolicy(this.store))):null,checked?hash(this.secret.read()??''):null);
    this.store.set(`task-option:${id}`,option.id);
  }
  hasOptionGuard(id:string){return !!this.store.get(`task-option:${id}`)||!!this.store.db.prepare('SELECT 1 FROM task_contract_option_proofs WHERE job_id=?').get(id);}
  optionChannel(id:string){return (this.store.db.prepare('SELECT channel FROM task_contract_option_proofs WHERE job_id=?').get(id) as {channel:string}|undefined)?.channel;}
  assertOption(r:Router,id:string,binding:Binding,inactive=false){
    const proof=this.store.db.prepare('SELECT * FROM task_contract_option_proofs WHERE job_id=?').get(id) as any;
    const job=this.store.job(id),parent=proof&&this.store.job(proof.parent_id),parentBinding=parent&&this.store.binding(parent.binding_id);
    const option=proof&&this.store.db.prepare(`SELECT o.*,b.status,b.reply_kind,b.request_id AS reply_request,b.binding_id AS reply_binding,b.destination AS reply_destination,b.body
      FROM message_options o JOIN outbox b ON b.id=o.outbox_id WHERE o.id=?`).get(proof.option_id) as any;
    if(!proof||this.store.get(`task-option:${id}`)!==proof.option_id||!job||!parent||!parentBinding||!option||['replaced','cancelled','reviewed','auto_closed'].includes(parent.status)||proof.binding_id!==binding.id||parent.binding_id!==binding.id||job.binding_id!==binding.id||bindingHash(r,binding)!==proof.binding_hash||bindingHash(r,parentBinding)!==proof.binding_hash||parent.destination!==proof.destination||job.destination!==proof.destination||hash(parent.body)!==proof.parent_body_hash||hash(job.body)!==proof.job_body_hash||(this.store.itemOf(id)??null)!==proof.item_id||(this.store.itemOf(parent.id)??null)!==proof.parent_item_id||this.store.ownerFor(proof.destination)!==proof.owner||(proof.channel==='telegram'?proof.destination!==this.store.get('telegram-owner'):proof.destination!==proof.owner&&(proof.destination!==this.store.get('destination-jid')||!this.store.get(`owned-group:${proof.destination}`)))||proof.policy_hash!==null&&proof.policy_hash!==hash(JSON.stringify(brainPolicy(this.store)))||proof.key_hash!==null&&proof.key_hash!==hash(this.secret.read()??'')||option.id!==proof.option_id||option.request_id!==parent.id||option.binding_id!==binding.id||option.destination!==proof.destination||option.owner!==proof.owner||option.outbox_id!==proof.outbox_id||option.response_id!==id||option.selected_id!==proof.selected_id||hash(option.choices)!==proof.choices_hash||hash(option.body)!==proof.outbox_hash||option.expires_at!==proof.expires_at||['queued','dispatched'].includes(job.status)&&proof.expires_at<=this.now()||option.status!=='sent'||!['progress','final'].includes(option.reply_kind)||option.reply_request!==parent.id||option.reply_binding!==binding.id||option.reply_destination!==proof.destination||!inactive&&(r.stopped||this.store.controlChannel()!==proof.channel)||this.store.db.prepare('SELECT 1 FROM schedule_jobs WHERE job_id=?').get(parent.id)&&scheduleJobState(r,parent.id,true)!=='ready')throw new Error('The original choice, owner or session changed. Nothing was sent.');
    return parent;
  }
  /** Include the existing owner-approved scope when another choice continues that task. */
  choiceReview(r:Router,parentId:string,body:string){
    const row=this.jobContract(parentId);if(!row){if(this.hasGuard(parentId))throw new Error('The task contract is unavailable. Nothing was sent.');return body;}
    const parent=this.store.job(parentId),binding=parent&&this.store.binding(parent.binding_id);
    if(!parent||!binding)throw new Error('The original session is unavailable. Nothing was sent.');
    this.assertDispatch(r,parentId,binding,parent.body);return this.render(row,body);
  }
  /** Reports remain bound to the owner, parent, exact source session and task contract. */
  bindReport(r:Router,parentId:string,sourceId:string|undefined,id:string,target:Binding,body:string){
    const row=this.jobContract(parentId);
    if(!row){if(this.hasGuard(parentId)||sourceId&&this.hasGuard(sourceId))throw new Error('The task contract is unavailable. Nothing was sent.');return body;}
    const parent=this.store.job(parentId),parentBinding=parent&&this.store.binding(parent.binding_id);
    if(!parent||!parentBinding||target.id!==parentBinding.id||!row.item_id||this.store.itemOf(parentId)!==row.item_id)throw new Error('The approved task or session changed. Nothing was sent.');
    this.assertDispatch(r,parentId,parentBinding,parent.body,new Set(),true);
    let sourceBinding:Binding|undefined,sourceBodyHash='';
    if(sourceId){const source=this.store.job(sourceId);sourceBinding=source&&this.store.binding(source.binding_id);
      if(!source||!sourceBinding||this.store.get(`parent:${sourceId}`)!==parentId||this.store.itemOf(sourceId)!==row.item_id||source.destination!==row.destination||this.jobContract(sourceId)?.id!==row.id)throw new Error('The report source changed. Nothing was sent.');
      this.assertDispatch(r,sourceId,sourceBinding,source.body,new Set(),true);sourceBodyHash=hash(source.body);
    }
    const text=this.render(row,body),identity=bindingHash(r,target),prior=this.store.db.prepare('SELECT contract_id,parent_id,binding_id,binding_hash,raw_hash,body_hash,item_id FROM task_contract_jobs WHERE job_id=?').get(id) as {contract_id:string;parent_id:string;binding_id:string;binding_hash:string;raw_hash:string;body_hash:string;item_id:number}|undefined;
    if(prior&&(prior.contract_id!==row.id||prior.parent_id!==parentId||prior.binding_id!==target.id||prior.binding_hash!==identity||prior.raw_hash!==hash(body)||prior.body_hash!==hash(text)||prior.item_id!==row.item_id))throw new Error('The report changed. Nothing was sent.');
    this.store.linkItem(id,row.item_id);
    this.store.db.prepare('INSERT OR IGNORE INTO task_contract_jobs(job_id,contract_id,parent_id,binding_id,binding_hash,raw_hash,body_hash,item_id) VALUES(?,?,?,?,?,?,?,?)').run(id,row.id,parentId,target.id,identity,hash(body),hash(text),row.item_id);
    const priorSource=this.store.db.prepare('SELECT * FROM task_contract_report_sources WHERE job_id=?').get(id) as {source_id:string;source_binding_id:string;source_binding_hash:string;source_body_hash:string;parent_id:string}|undefined;
    const sourceIdentity=sourceBinding?bindingHash(r,sourceBinding):'',sourceBindingId=sourceBinding?.id??'',sourceKey=sourceId??'';
    if(priorSource&&(priorSource.source_id!==sourceKey||priorSource.source_binding_id!==sourceBindingId||priorSource.source_binding_hash!==sourceIdentity||priorSource.source_body_hash!==sourceBodyHash||priorSource.parent_id!==parentId))throw new Error('The report source changed. Nothing was sent.');
    this.store.db.prepare('INSERT OR IGNORE INTO task_contract_report_sources VALUES(?,?,?,?,?,?)').run(id,sourceKey,sourceBindingId,sourceIdentity,sourceBodyHash,parentId);
    return text;
  }
  private render(row:ContractRow,body:string){
    const draft=JSON.parse(row.draft) as Draft,edits=JSON.parse(row.edits) as string[];
    const text=[body,'',`Owner's original request: ${row.original}`,...(row.review_text!==row.original?[`Owner-reviewed task: ${row.review_text}`]:[]),'Owner-approved task contract:',`Build: ${draft.goal}`,`Do not touch: ${draft.exclusions.join('; ')||'No exclusions specified.'}`,'Checks:',...draft.checks.map((c,i)=>`${i+1}. ${c.text}`),...(edits.length?['Owner corrections:',...edits.map((e,i)=>`${i+1}. ${e}`)]:[]),'The original owner request remains authoritative.'].join('\n');
    if(text.length>32000)throw new Error('The task and contract exceed the message limit. Nothing was sent.');
    return text;
  }
  /** Add the accepted contract to the exact original owner task, never replacing its words. */
  augment(r:Router,id:string,binding:Binding,body:string):string {
    const row=this.jobContract(id);
    if(!row)return body;
    if(!(row.dispatch_id===id?contextValid(r,row):dispatchContextValid(r,row))||hash(this.secret.read()??'')!==row.key_hash)throw new Error('The approved task or destination changed. Nothing was sent.');
    if(row.review_text!==row.original&&body.trim()!==row.review_text)throw new Error('The reviewed task changed. Nothing was sent.');
    const text=this.render(row,body);
    if(row.dispatch_id===id)this.store.db.prepare('UPDATE task_contracts SET binding_id=?,binding_hash=?,body_hash=? WHERE id=? AND state=\'approved\'').run(binding.id,bindingHash(r,binding),hash(text),row.id);
    else this.store.db.prepare('UPDATE task_contract_jobs SET body_hash=? WHERE job_id=? AND contract_id=? AND binding_id=? AND binding_hash=? AND raw_hash=?').run(hash(text),id,row.id,binding.id,bindingHash(r,binding),hash(body));
    return text;
  }
  approved(id:string){return this.jobContract(id);}
  /** Bind a versioned contract to the item inside the same transaction as the job. */
  bindItem(id:string,itemId:number){const row=this.jobContract(id);if(!row)throw new Error('The approved task is unavailable.');const result=this.store.db.prepare("UPDATE task_contracts SET item_id=? WHERE id=? AND state='approved' AND (item_id IS NULL OR item_id=?)").run(itemId,row.id,itemId);if(!result.changes)throw new Error('The approved task belongs to another item. Nothing was sent.');this.store.db.prepare('UPDATE task_contract_jobs SET item_id=? WHERE job_id=? AND contract_id=? AND (item_id IS NULL OR item_id=?)').run(itemId,id,row.id,itemId);}
  byItem(itemId:number,owner:string,destination:string){return this.store.db.prepare("SELECT id,origin_id,owner,destination,revision,draft,approved_hash,approved_at,dispatch_id,item_id,binding_id,binding_hash,body_hash FROM task_contracts WHERE item_id=? AND owner=? AND destination=? AND state='approved' ORDER BY created_at DESC").all(itemId,owner,destination);}
  assertDispatch(r:Router,id:string,binding:Binding,body:string,visited=new Set<string>(),inactive=false){
    if(visited.has(id)||visited.size>=5)throw new Error('Task contract delegation is invalid. Nothing was sent.');visited.add(id);
    const row=this.jobContract(id);if(!row){if(this.hasGuard(id))throw new Error('The task contract is unavailable. Nothing was sent.');return;}
    const draft=this.store.db.prepare('SELECT payload_hash FROM task_contract_schedule_drafts WHERE contract_id=?').get(row.id) as {payload_hash:string}|undefined;
    const brief=this.store.db.prepare('SELECT payload_hash FROM task_contract_brief_drafts WHERE contract_id=?').get(row.id) as {payload_hash:string}|undefined;
    const approvedHash=hash(JSON.stringify([row.id,row.origin_id,row.owner,row.destination,row.revision,row.original,row.review_text,row.incoming,row.edits,row.draft,draft?.payload_hash??null,brief?.payload_hash??null]));
    if(approvedHash!==row.approved_hash)throw new Error('The approved task contract changed. Nothing was sent.');
    const job=this.store.job(id);if(!job||job.binding_id!==binding.id||job.destination!==row.destination||job.body!==body)throw new Error('The approved task or destination changed. Nothing was sent.');
    const link=this.store.db.prepare('SELECT * FROM task_contract_jobs WHERE job_id=? AND contract_id=?').get(id,row.id) as {parent_id:string|null;binding_id:string;binding_hash:string;body_hash:string;item_id:number|null}|undefined;
    const bound=link??{binding_id:row.binding_id,binding_hash:row.binding_hash,body_hash:row.body_hash,item_id:row.item_id};
    const currentBinding=this.store.binding(binding.id);
    if(!currentBinding||bound.binding_hash!==bindingHash(r,currentBinding)||!dispatchContextValid(r,row,inactive)||hash(this.secret.read()??'')!==row.key_hash||bound.binding_id!==binding.id||bound.binding_hash!==bindingHash(r,binding)||bound.body_hash!==hash(body)||!bound.item_id||row.item_id!==bound.item_id||this.store.itemOf(id)!==bound.item_id)throw new Error('The approved task or session changed. Nothing was sent.');
    const report=this.store.db.prepare('SELECT * FROM task_contract_report_sources WHERE job_id=?').get(id) as {source_id:string;source_binding_id:string;source_binding_hash:string;source_body_hash:string;parent_id:string}|undefined;
    if(id.startsWith('report:')&&link&&(!report||report.parent_id!==link.parent_id))throw new Error('The report source is unavailable. Nothing was sent.');
    if(report?.source_id){const source=this.store.job(report.source_id),sourceBinding=source&&this.store.binding(source.binding_id);
      if(!source||!sourceBinding||source.binding_id!==report.source_binding_id||bindingHash(r,sourceBinding)!==report.source_binding_hash||hash(source.body)!==report.source_body_hash||source.destination!==row.destination||this.store.get(`parent:${report.source_id}`)!==report.parent_id||this.store.itemOf(report.source_id)!==row.item_id||this.jobContract(report.source_id)?.id!==row.id)throw new Error('The report source changed. Nothing was sent.');
      this.assertDispatch(r,report.source_id,sourceBinding,source.body,new Set(visited),inactive);
    }
    const optionRequired=row.dispatch_id===id&&(JSON.parse(row.incoming) as {contractOption?:boolean}).contractOption;
    if(optionRequired||this.hasOptionGuard(id)){
      const parent=this.assertOption(r,id,binding,inactive),parentBinding=this.store.binding(parent.binding_id);
      if(!parentBinding)throw new Error('The original session is unavailable. Nothing was sent.');
      if(this.hasGuard(parent.id))this.assertDispatch(r,parent.id,parentBinding,parent.body,new Set(visited),inactive);
    }
    if(link?.parent_id){const parent=this.store.job(link.parent_id),parentBinding=parent&&this.store.binding(parent.binding_id);if(!parent||!parentBinding||!(['queued','dispatched','submitted'].includes(parent.status)||parent.status==='completed'&&this.hasOptionGuard(id)))throw new Error('The owner request has ended. Nothing was sent.');this.assertDispatch(r,link.parent_id,parentBinding,parent.body,visited,inactive);}

  }
  rejectDispatch(id:string,reason:string){
    const row=this.jobContract(id);
    const job=this.store.job(id);if(!row||!job||!['queued','dispatched'].includes(job.status))return;
    this.store.db.exec('SAVEPOINT reject_contract_dispatch');
    try{
      this.store.jobState(id,'failed',reason);
      this.store.db.prepare("UPDATE outbox SET status='cancelled',error='Task contract was not sent' WHERE status='queued' AND source=?").run(`native-opening:${id}:0`);
      const validOwner=this.store.ownerFor(row.destination)===row.owner&&this.store.controlChannel()===row.channel&&
        (row.channel==='telegram'?row.destination===this.store.get('telegram-owner'):row.destination===row.owner||row.destination===this.store.get('destination-jid')&&!!this.store.get(`owned-group:${row.destination}`));
      if(validOwner){
        const source=`task-contract-error:${id}`;this.store.output(undefined,reason,source,row.destination,{requestId:id,kind:'system',origin:'system',plain:true});
        const parts=this.store.db.prepare('SELECT id FROM outbox WHERE source LIKE ? AND destination=?').all(`${source}:%`,row.destination) as {id:string}[];
        for(const part of parts)this.store.db.prepare('INSERT OR IGNORE INTO task_contract_outbox VALUES(?,?,?,?)').run(part.id,row.id,row.revision,'error');
      }
      this.store.db.exec('RELEASE reject_contract_dispatch');
    }catch(e){this.store.db.exec('ROLLBACK TO reject_contract_dispatch; RELEASE reject_contract_dispatch');throw e;}
  }
}

/** Checked immediately before transport I/O; pending proposals never follow a changed owner. */
export function contractDeliveryState(router:Router,outboxId:string,now=Date.now()):'ready'|'hold'|'invalid'{
  const store=router.store;
  const row=store.db.prepare(`SELECT t.*,c.revision AS output_revision,c.kind AS output_kind
    FROM task_contract_outbox c JOIN task_contracts t ON t.id=c.contract_id WHERE c.outbox_id=?`).get(outboxId) as (ContractRow&{output_revision:number;output_kind:string})|undefined;
  if(!row){
    const output=store.db.prepare('SELECT request_id,destination,binding_id FROM outbox WHERE id=?').get(outboxId) as {request_id:string|null;destination:string|null;binding_id:string|null}|undefined;
    if(!output?.request_id||!router.contracts.hasGuard(output.request_id)&&!router.contracts.hasOptionGuard(output.request_id))return 'ready';
    const job=store.job(output.request_id),binding=job&&store.binding(job.binding_id),contract=router.contracts.approved(output.request_id);
    if(!job||!binding||output.destination!==job.destination||output.binding_id!==binding.id)return 'invalid';
    if(router.contracts.hasOptionGuard(job.id)){try{router.contracts.assertOption(router,job.id,binding,true);}catch{return 'invalid';}}
    if(!contract)return router.contracts.hasGuard(job.id)?'invalid':store.controlChannel()===router.contracts.optionChannel(job.id)?'ready':'hold';
    if(output.destination!==contract.destination)return 'invalid';
    if(store.db.prepare('SELECT 1 FROM schedule_jobs WHERE job_id=?').get(job.id)&&scheduleJobState(router,job.id,true)!=='ready')return 'invalid';
    try{router.contracts.assertDispatch(router,job.id,binding,job.body,new Set(),true);}catch{return 'invalid';}
    return store.controlChannel()===contract.channel?'ready':'hold';
  }
  if(row.revision!==row.output_revision||store.ownerFor(row.destination)!==row.owner)return 'invalid';
  if(row.channel==='telegram'&&row.destination!==store.get('telegram-owner'))return 'invalid';
  if(row.channel==='whatsapp'&&row.destination!==row.owner&&(store.get('destination-jid')!==row.destination||!store.get(`owned-group:${row.destination}`)))return 'invalid';
  if(store.controlChannel()!==row.channel)return 'hold';
  if(row.output_kind==='error')return row.state==='approved'?'ready':'invalid';
  if(row.output_kind!=='proposal'||row.state!=='pending'||row.expires_at<=now)return 'invalid';
  return contextValid(router,row)&&hash(router.contracts.secret.read()??'')===row.key_hash?'ready':'invalid';
}
