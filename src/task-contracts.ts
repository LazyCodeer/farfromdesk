import {randomUUID} from 'node:crypto';
import {brainPolicy,MetaSecret} from './meta-brain-config.js';
import {ContractDecision,interpretContract,type ContractInterpreter} from './task-contract-model.js';
import {authenticatedOwner} from './owner-commands.js';
import {hash,type Binding,type Store} from './store.js';
import type {Incoming,Router} from './router.js';

type Draft={goal:string;exclusions:string[];checks:{id:string;text:string}[];question:string};
type ContractRow={id:string;origin_id:string;owner:string;destination:string;channel:string;original:string;review_text:string;incoming:string;edits:string;draft:string;revision:number;policy_hash:string;routing_hash:string;key_hash:string;state:string;expires_at:number;dispatch_id:string|null;item_id:number|null;binding_id:string|null;binding_hash:string|null;body_hash:string|null;approved_hash:string|null;approved_at:number|null};
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
      CREATE TABLE IF NOT EXISTS task_contract_outbox(outbox_id TEXT PRIMARY KEY,contract_id TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL);`);
  }
  enabled(){const p=brainPolicy(this.store);return p.enabled&&p.taskContracts;}
  private row(id:string){return this.store.db.prepare('SELECT * FROM task_contracts WHERE id=?').get(id) as ContractRow|undefined;}
  private pending(owner:string,destination:string){return this.store.db.prepare("SELECT * FROM task_contracts WHERE owner=? AND destination=? AND state='pending'").get(owner,destination) as ContractRow|undefined;}
  private context(r:Router,m:Incoming){
    const destination=this.store.destination(),owner=this.store.ownerFor(destination),channel=this.store.controlChannel();
    if(!destination||!owner||!authenticatedOwner(r,m))return;
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
  /** Invoke only after permission/option replies have had their own chance to consume the message. */
  async preflight(r:Router,m:Incoming,reviewText?:string):Promise<ContractResult>{
    const context=this.context(r,m);if(!context)return {kind:'pass'};
    let pending=this.pending(context.owner,context.destination);
    if(pending&&pending.expires_at<=this.now()){
      this.store.db.prepare("UPDATE task_contracts SET state='expired' WHERE id=? AND state='pending'").run(pending.id);pending=undefined;
      if(/^(?:ok|okay|cancel)(?:\s+contract)?[.!]?$/i.test(m.text.trim())||m.quotedId){this.answer(m,'That task contract expired. Send the task again. Nothing was sent.');return {kind:'handled'};}
    }
    if(pending){
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
        if(m.source==='voice'){this.answer(m,'Please type ok to approve this task. Nothing was sent.');return {kind:'handled'};}
        if(!this.sent(pending)){this.answer(m,'Wait for the task contract to arrive before approving it.');return {kind:'handled'};}
        const draft=JSON.parse(pending.draft) as Draft;
        if(draft.question){this.answer(m,'Please answer the question first. Nothing was sent.');return {kind:'handled'};}
        const original=JSON.parse(pending.incoming) as Incoming;
        const approvedHash=hash(JSON.stringify([pending.id,pending.origin_id,pending.owner,pending.destination,pending.revision,pending.original,pending.review_text,pending.edits,pending.draft]));
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
      this.store.db.prepare('INSERT INTO task_contracts(id,origin_id,owner,destination,channel,original,review_text,incoming,edits,draft,revision,policy_hash,routing_hash,key_hash,state,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,m.id,context.owner,context.destination,context.channel,text,review,JSON.stringify(m),'[]',JSON.stringify(draft),1,context.policy_hash,context.routing_hash,hash(key),'pending',now+expiry,now);
      this.send(this.row(id)!,draft);this.store.remember(m.id);this.store.db.exec('RELEASE contract_new');
    }catch(e){this.store.db.exec('ROLLBACK TO contract_new; RELEASE contract_new');throw e;}
    return {kind:'handled'};
  }
  /** Add the accepted contract to the exact original owner task, never replacing its words. */
  augment(r:Router,id:string,binding:Binding,body:string):string {
    const row=this.store.db.prepare("SELECT * FROM task_contracts WHERE dispatch_id=? AND state='approved'").get(id) as ContractRow|undefined;
    if(!row)return body;
    if(!contextValid(r,row)||hash(this.secret.read()??'')!==row.key_hash)throw new Error('The approved task or destination changed. Nothing was sent.');
    if(row.review_text!==row.original&&body.trim()!==row.review_text)throw new Error('The reviewed task changed. Nothing was sent.');
    const draft=JSON.parse(row.draft) as Draft,edits=JSON.parse(row.edits) as string[];
    const text=[body,'','Owner-approved task contract:',`Build: ${draft.goal}`,`Do not touch: ${draft.exclusions.join('; ')||'No exclusions specified.'}`,'Checks:',...draft.checks.map((c,i)=>`${i+1}. ${c.text}`),...(edits.length?['Owner corrections:',...edits.map((e,i)=>`${i+1}. ${e}`)]:[]),'The original owner message above remains authoritative.'].join('\n');
    if(text.length>32000)throw new Error('The task and contract exceed the message limit. Nothing was sent.');
    this.store.db.prepare('UPDATE task_contracts SET binding_id=?,binding_hash=?,body_hash=? WHERE id=? AND state=\'approved\'').run(binding.id,bindingHash(r,binding),hash(text),row.id);
    return text;
  }
  approved(id:string){return this.store.db.prepare("SELECT id,original,draft FROM task_contracts WHERE dispatch_id=? AND state='approved'").get(id) as {id:string;original:string;draft:string}|undefined;}
  /** Bind a versioned contract to the item inside the same transaction as the job. */
  bindItem(id:string,itemId:number){const result=this.store.db.prepare("UPDATE task_contracts SET item_id=? WHERE dispatch_id=? AND state='approved' AND (item_id IS NULL OR item_id=?)").run(itemId,id,itemId);if(!result.changes)throw new Error('The approved task belongs to another item. Nothing was sent.');}
  byItem(itemId:number,owner:string,destination:string){return this.store.db.prepare("SELECT id,origin_id,owner,destination,revision,draft,approved_hash,approved_at,dispatch_id,item_id,binding_id,binding_hash,body_hash FROM task_contracts WHERE item_id=? AND owner=? AND destination=? AND state='approved' ORDER BY created_at DESC").all(itemId,owner,destination);}
  assertDispatch(r:Router,id:string,binding:Binding,body:string){
    const row=this.store.db.prepare("SELECT * FROM task_contracts WHERE dispatch_id=? AND state='approved'").get(id) as ContractRow|undefined;if(!row)return;
    if(!contextValid(r,row)||hash(this.secret.read()??'')!==row.key_hash||row.binding_id!==binding.id||row.binding_hash!==bindingHash(r,binding)||row.body_hash!==hash(body)||!row.item_id||this.store.itemOf(id)!==row.item_id)throw new Error('The approved task or session changed. Nothing was sent.');
  }
  rejectDispatch(id:string,reason:string){
    const row=this.store.db.prepare("SELECT * FROM task_contracts WHERE dispatch_id=? AND state='approved'").get(id) as ContractRow|undefined;
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
  if(!row)return 'ready';
  if(row.revision!==row.output_revision||store.ownerFor(row.destination)!==row.owner)return 'invalid';
  if(row.channel==='telegram'&&row.destination!==store.get('telegram-owner'))return 'invalid';
  if(row.channel==='whatsapp'&&row.destination!==row.owner&&(store.get('destination-jid')!==row.destination||!store.get(`owned-group:${row.destination}`)))return 'invalid';
  if(store.controlChannel()!==row.channel)return 'hold';
  if(row.output_kind==='error')return row.state==='approved'?'ready':'invalid';
  if(row.output_kind!=='proposal'||row.state!=='pending'||row.expires_at<=now)return 'invalid';
  return contextValid(router,row)&&hash(router.contracts.secret.read()??'')===row.key_hash?'ready':'invalid';
}
