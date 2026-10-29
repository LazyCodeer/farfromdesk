import './brain-fixture-isolation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {Router} from '../src/router.js';
import {Approvals} from '../src/approvals.js';
import {Coordinator} from '../src/coordinator.js';
import {NativeAgents} from '../src/native.js';
import {MorningBrief} from '../src/morning-brief.js';
import {MetaBrain} from '../src/meta-brain.js';
import {DEFAULT_BRAIN,MetaSecret,brainPolicy,saveBrainConfig} from '../src/meta-brain-config.js';
import {TaskContracts,contractDeliveryState} from '../src/task-contracts.js';
import {optionsMarkup} from '../src/message-options.js';
import type {ContractDecision} from '../src/task-contract-model.js';

const proposal=(question=''):ContractDecision=>({kind:'contract',goal:'Add the requested dark theme',exclusions:['Do not publish'],checks:['Theme can be enabled','Existing theme still works'],question});
const pass:ContractDecision={kind:'pass',goal:'',exclusions:[],checks:[],question:''};
function fixture(answer:ContractDecision=proposal()){
  const dir=mkdtempSync(join(tmpdir(),'ffd-contract-test-')),store=new Store(':memory:'),approvals=new Approvals(store);
  const native={run:async()=>{},stop:()=>{}},r=new Router(store,native as any,approvals);
  r.pump=()=>{};store.set('whatsapp-owner','owner@s.whatsapp.net');
  const binding=store.register('codex-one','codex',randomUUID(),'/tmp').binding;store.set('active',binding.id);
  const secret=new MetaSecret(dir);secret.save('synthetic-key-not-a-real-secret');
  r.brain=new MetaBrain(store,secret,{interpret:async()=>{throw new Error('unused');}} as any);
  saveBrainConfig(store,secret,{policy:{...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:['codex'],failure:'block'}});
  let decide:()=>Promise<ContractDecision>=async()=>answer;
  r.contracts=new TaskContracts(store,secret,async()=>decide());
  const send=async(id:string,text:string,source:'text'|'voice'='text')=>r.receive({id:`wa:${id}`,text,source,ownerIntent:true,ownerCommand:source==='text'});
  const out=()=>store.db.prepare('SELECT * FROM outbox ORDER BY rowid').all() as any[];
  const markSent=()=>store.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
  return {r,store,binding,secret,send,out,markSent,setDecision(fn:()=>Promise<ContractDecision>){decide=fn;},close(){approvals.cancel();store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('unclear task waits for typed owner approval and keeps immutable contract on its item',async()=>{
  const f=fixture();try{
    const original='Add dark theme. Do NOT publish.';
    assert.equal((await f.send('1',original,'voice')).status,'handled');assert.equal(f.store.jobs().length,0);
    assert.match(f.out()[0].body,/Do NOT publish/);f.markSent();
    await f.send('2','ok','voice');assert.equal(f.store.jobs().length,0);
    assert.equal((await f.send('3','ok')).status,'queued');
    const job=f.store.job('wa:3')!;assert.match(job.body,/Do NOT publish/);assert.match(job.body,/Owner-approved task contract/);
    const item=f.store.itemOf(job.id)!;assert.ok(item>0);
    const [contract]=f.r.contracts.byItem(item,'owner@s.whatsapp.net','owner@s.whatsapp.net') as any[];
    assert.ok(contract.approved_hash);assert.equal(contract.revision,1);assert.equal(contract.binding_id,f.binding.id);
    assert.deepEqual(JSON.parse(contract.draft).checks.map((x:any)=>x.id),[`${contract.id}:1:1`,`${contract.id}:1:2`]);
    await f.send('3','ok');assert.equal(f.store.jobs().length,1);
  }finally{f.close();}
});

test('question and edited draft each require a fresh delivered approval',async()=>{
  const f=fixture(proposal('Which page?'));try{
    await f.send('1','Add dark theme');f.markSent();await f.send('2','ok');assert.equal(f.store.jobs().length,0);
    f.setDecision(async()=>proposal());await f.send('3','The invoice page');assert.equal(f.store.jobs().length,0);
    await f.send('4','ok');assert.equal(f.store.jobs().length,0);f.markSent();await f.send('5','ok');
    assert.match(f.store.job('wa:5')!.body,/The invoice page/);
    const [c]=f.r.contracts.byItem(f.store.itemOf('wa:5')!,'owner@s.whatsapp.net','owner@s.whatsapp.net') as any[];
    assert.equal(c.revision,2);assert.match(JSON.parse(c.draft).checks[0].id,/:2:1$/);
  }finally{f.close();}
});

test('owner, selected route, and settings changes invalidate a pending approval',async()=>{
  for(const change of ['owner','route','policy']){const f=fixture();try{
    await f.send('1','Add dark theme');f.markSent();
    if(change==='owner')f.store.set('whatsapp-owner','different@s.whatsapp.net');
    if(change==='route')f.store.set('active','other');
    if(change==='policy')saveBrainConfig(f.store,f.secret,{policy:{...brainPolicy(f.store),allowRouting:false}});
    await f.send('2','ok');assert.equal(f.store.jobs().length,0,change);
  }finally{f.close();}}
});

test('model failure, changed identity during inference, and a missing key never dispatch',async()=>{
  for(const mode of ['failure','changed','missing']){const f=fixture();try{
    if(mode==='missing')f.secret.remove();
    if(mode==='failure')f.setDecision(async()=>{throw new Error('provider failed');});
    if(mode==='changed')f.setDecision(async()=>{f.store.set('active','different');return proposal();});
    assert.equal((await f.send('1','Add dark theme')).status,'blocked');assert.equal(f.store.jobs().length,0,mode);
  }finally{f.close();}}
});

test('clear asks pass, disabling contracts works, and old settings saves retain the choice',async()=>{
  const f=fixture(pass);try{
    assert.equal((await f.send('1','Hello')).status,'queued');assert.equal(f.store.job('wa:1')!.body,'Hello');
    saveBrainConfig(f.store,f.secret,{policy:{...brainPolicy(f.store),taskContracts:false}});
    const legacy:any={...brainPolicy(f.store)};delete legacy.taskContracts;saveBrainConfig(f.store,f.secret,{policy:legacy});
    assert.equal(brainPolicy(f.store).taskContracts,false);
    f.setDecision(async()=>{throw new Error('should not call model');});assert.equal((await f.send('2','Hello again')).status,'queued');
  }finally{f.close();}
});

test('a quoted reply to another message cannot approve a pending contract',async()=>{
  const f=fixture();try{
    await f.send('1','Add dark theme');f.markSent();
    await f.r.receive({id:'wa:2',text:'ok',quotedId:'another-message',ownerIntent:true,ownerCommand:true});
    assert.equal(f.store.jobs().length,0);
  }finally{f.close();}
});

test('a quoted reply to the contract itself cannot approve it',async()=>{
  const f=fixture();try{
    await f.send('1','Add dark theme');f.markSent();
    f.store.db.prepare("UPDATE outbox SET wa_id='contract-message' WHERE source LIKE 'task-contract:%'").run();
    await f.r.receive({id:'wa:2',text:'ok',quotedId:'contract-message',ownerIntent:true,ownerCommand:false,ownerChoice:true});
    assert.equal(f.store.jobs().length,0);assert.match(f.out().at(-1).body,/new message/i);
  }finally{f.close();}
});

test('agent-authored message choices cannot bypass task-contract review',async()=>{
  for(const token of [false,true]){const f=fixture();try{
    const owner='owner@s.whatsapp.net';f.store.enqueue('wa:legacy',f.binding,'Original task',owner);
    f.store.output(f.binding,'Choose next','legacy-offer',owner,{requestId:'wa:legacy',kind:'progress',origin:'agent',options:{choices:[{id:'go',label:'Deploy now'},{id:'no',label:'Do not deploy'}],expiresInSeconds:60}});
    const offer=f.store.db.prepare("SELECT * FROM outbox WHERE source='legacy-offer:0'").get() as any;f.store.sent(offer.id);
    const callback=optionsMarkup(f.store,offer.id)!.inline_keyboard[0][0].callback_data;
    const result=await f.r.receive({id:'wa:choice',text:token?'Selected message option':'1',quotedId:offer.wa_id,optionToken:token?callback:undefined,ownerIntent:true,ownerChoice:true});
    assert.equal(result.status,'blocked');assert.equal(f.store.job('wa:choice'),undefined);
    assert.equal(f.store.db.prepare('SELECT selected_id FROM message_options WHERE outbox_id=?').get(offer.id)?.selected_id,null);
    assert.match(f.out().at(-1).body,/reviewed|nothing was sent/i);
  }finally{f.close();}}
});

test('disabling new contract reviews does not bypass an existing approved contract via choices',async()=>{
  const f=fixture();try{
    const owner='owner@s.whatsapp.net';await f.send('request','Add the dark theme. Do NOT publish.');f.markSent();await f.send('approved','ok');
    f.store.output(f.binding,'Choose next','guarded-offer',owner,{requestId:'wa:approved',kind:'progress',origin:'agent',options:{choices:[{id:'go',label:'Deploy now'},{id:'no',label:'Do not deploy'}],expiresInSeconds:60}});
    const offer=f.store.db.prepare("SELECT * FROM outbox WHERE source='guarded-offer:0'").get() as any;f.store.sent(offer.id);
    saveBrainConfig(f.store,f.secret,{policy:{...brainPolicy(f.store),taskContracts:false}});
    const result=await f.r.receive({id:'wa:choice',text:'1',quotedId:offer.wa_id,ownerIntent:true,ownerChoice:true});
    assert.equal(result.status,'blocked');assert.equal(f.store.job('wa:choice'),undefined);
    assert.equal(f.store.db.prepare('SELECT selected_id FROM message_options WHERE outbox_id=?').get(offer.id)?.selected_id,null);
  }finally{f.close();}
});

test('forwarded text cannot approve a contract and a changed native identity cannot receive it',async()=>{
  const f=fixture();try{
    await f.send('1','Add dark theme');f.markSent();
    await f.r.receive({id:'wa:2',text:'ok',ownerCommand:false,ownerIntent:false,ownerChoice:false});
    assert.equal(f.store.jobs().length,0);
    await f.send('3','ok');const job=f.store.job('wa:3')!;
    f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),f.binding.id);
    assert.throws(()=>f.r.contracts.assertDispatch(f.r,job.id,f.store.binding(f.binding.id)!,job.body),/changed/);
  }finally{f.close();}
});

test('all chunks must arrive before a long contract can be approved',async()=>{
  const f=fixture();try{
    await f.send('1','Build '+('x'.repeat(3700)));
    const parts=f.out().filter(x=>x.source.startsWith('task-contract:'));assert.ok(parts.length>1);
    f.store.db.prepare("UPDATE outbox SET status='sent' WHERE id=?").run(parts[0].id);
    await f.send('2','ok');assert.equal(f.store.jobs().length,0);
    f.markSent();await f.send('3','ok');assert.equal(f.store.jobs().length,1);
  }finally{f.close();}
});

test('revoked keys and stale routing cannot deliver or approve a queued contract',async()=>{
  for(const mode of ['key','route','owner']){const f=fixture();try{
    await f.send('1','Build the requested theme');const pending=f.out().find(x=>x.source.startsWith('task-contract:'));
    assert.equal(contractDeliveryState(f.r,pending.id),'ready');
    if(mode==='key')f.secret.save('new-synthetic-key-not-a-real-secret');
    if(mode==='route')f.store.set('active','different');
    if(mode==='owner')f.store.set('whatsapp-owner','different@s.whatsapp.net');
    assert.equal(contractDeliveryState(f.r,pending.id),'invalid');
    f.markSent();await f.send('2','ok');assert.equal(f.store.jobs().length,0);
  }finally{f.close();}}
});

test('a brief go action needing a contract cannot queue until owner approves the exact item',async()=>{
  const f=fixture();try{
    const coordinator=new Coordinator(f.store,f.r.native,f.r,()=>{});f.r.coordinator=coordinator;
    const owner='owner@s.whatsapp.net',worker=f.binding,when=Date.parse('2026-10-29T03:00:00Z');
    f.store.recordOwnerOrigin('wa:original',owner,owner);
    const item=f.store.destinationContext.run(owner,()=>f.r.brain.memory.add('wa:original','Build the invoice page'));
    f.r.brain.memory.items.setSession(item.id,worker.id);
    const brief=new MorningBrief(f.store,f.r,async()=>({opening:'Hello.',priorities:[]}),()=>when);f.r.morningBrief=brief;
    await brief.request(owner,'first-message');const briefOut=f.out().find(x=>x.source.startsWith('morning-brief:'));assert.ok(briefOut);f.store.sent(briefOut.id);
    assert.equal((await f.send('go','go 1')).status,'handled');assert.equal(f.store.job('wa:go'),undefined);
    const contract=f.out().find(x=>x.source.startsWith('task-contract:'));assert.match(contract.body,/Task to review/);f.markSent();
    assert.equal((await f.send('approve','ok')).status,'queued');
    const job=f.store.job('wa:approve')!;assert.equal(job.binding_id,worker.id);assert.equal(f.store.itemOf(job.id),item.id);
    assert.match(job.body,/Owner-approved task contract/);assert.equal(f.r.assertDispatchAllowed(job.id,worker),true);
  }finally{f.close();}
});

test('an approved brief contract cannot fall through if its source brief disappears',async()=>{
  const f=fixture();try{
    const coordinator=new Coordinator(f.store,f.r.native,f.r,()=>{});f.r.coordinator=coordinator;
    const owner='owner@s.whatsapp.net',when=Date.parse('2026-10-29T03:00:00Z');
    f.store.recordOwnerOrigin('wa:original',owner,owner);
    const item=f.store.destinationContext.run(owner,()=>f.r.brain.memory.add('wa:original','Build the invoice page'));
    f.r.brain.memory.items.setSession(item.id,f.binding.id);
    const brief=new MorningBrief(f.store,f.r,async()=>({opening:'Hello.',priorities:[]}),()=>when);f.r.morningBrief=brief;
    await brief.request(owner,'first-message');const out=f.out().find(x=>x.source.startsWith('morning-brief:'));f.store.sent(out.id);
    await f.send('go','go 1');f.markSent();f.store.db.prepare('DELETE FROM morning_briefs').run();
    assert.equal((await f.send('approve','ok')).status,'blocked');assert.equal(f.store.jobs().length,0);
    assert.match(f.out().at(-1).body,/unavailable|nothing was sent/i);
  }finally{f.close();}
});

test('an approval saved before interruption resumes the original request, not the word ok',async()=>{
  const f=fixture();try{
    await f.send('one','Add dark theme. Do NOT publish.');f.markSent();
    const incoming={id:'wa:approve',text:'ok',source:'text' as const,ownerIntent:true,ownerCommand:true};
    assert.equal((await f.r.contracts.preflight(f.r,incoming)).kind,'replay');assert.equal(f.store.jobs().length,0);
    assert.equal((await f.r.receive(incoming)).status,'queued');
    assert.match(f.store.job(incoming.id)!.body,/Do NOT publish/);assert.doesNotMatch(f.store.job(incoming.id)!.body,/^ok$/);
    await f.r.receive(incoming);assert.equal(f.store.jobs().length,1);
  }finally{f.close();}
});

async function contractedReport(f:ReturnType<typeof fixture>,channel=false){
  if(channel){f.store.db.prepare("UPDATE bindings SET mode='channel' WHERE id=?").run(f.binding.id);Object.assign(f.binding,f.store.binding(f.binding.id));}
  const c=new Coordinator(f.store,f.r.native,f.r,()=>{});f.r.coordinator=c;c.registry.register(f.binding);f.store.set('master',f.binding.id);
  f.r.brain.handle=async()=>false;
  const worker=f.store.register('worker','codex',randomUUID(),'/tmp/worker').binding;f.store.set('selected',JSON.stringify([worker.id]));
  const created=await f.send('request','Add the dark theme. Do NOT publish.');f.markSent();const confirmed=await f.send('approved','ok');
  const parent=f.store.job('wa:approved')!;assert.ok(parent,JSON.stringify({created,confirmed,replies:f.out().map(o=>o.body)}));
  const [childId]=c.dispatch(parent.id,[worker.id],'Inspect the requested theme.','report-fixture');
  f.store.jobState(parent.id,'submitted');f.store.jobState(childId,'completed');
  c.workerReply(worker,'Inspection finished.',childId,false,'final');
  const report=f.store.db.prepare("SELECT id FROM inbox WHERE id LIKE 'report:%'").get() as {id:string};assert.ok(report);
  return {parent,worker,childId,reportId:report.id};
}

test('contracted worker reports bind owner, item, parent, source and target identities',async()=>{
  for(const change of ['owner','target','source','parent','item','body','destination','approval','source-record']){const f=fixture();try{
    const {parent,worker,childId,reportId}=await contractedReport(f);const report=f.store.job(reportId)!;
    assert.match(report.body,/Owner-approved task contract/);assert.equal(f.r.assertDispatchAllowed(reportId,f.binding),true);
    if(change==='owner')f.store.set('whatsapp-owner','other@s.whatsapp.net');
    if(change==='target')f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),f.binding.id);
    if(change==='source')f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),worker.id);
    if(change==='parent')f.store.jobState(parent.id,'completed');
    if(change==='item'){const other=f.r.brain.memory.items.add('Another task').id;f.store.db.prepare('UPDATE item_requests SET item_id=? WHERE request_id=?').run(other,childId);}
    if(change==='body')f.store.db.prepare('UPDATE inbox SET body=? WHERE id=?').run('Altered report',reportId);
    if(change==='destination')f.store.db.prepare('UPDATE inbox SET destination=? WHERE id=?').run('another@g.us',reportId);
    if(change==='approval')f.store.db.prepare("UPDATE task_contracts SET state='cancelled'").run();
    if(change==='source-record')f.store.db.prepare('DELETE FROM task_contract_report_sources WHERE job_id=?').run(reportId);
    assert.throws(()=>f.r.assertDispatchAllowed(reportId,f.store.binding(f.binding.id)!),/changed|not sent|unavailable/i,change);
  }finally{f.close();}}
});

test('contracted reports fail closed at the channel-poll boundary after owner changes',async()=>{
  const f=fixture();try{
    const {reportId}=await contractedReport(f,true);f.store.set('whatsapp-owner','other@s.whatsapp.net');
    assert.equal(f.r.channelPoll(f.binding,'synthetic-client'),null);
    assert.equal(f.store.job(reportId)?.status,'failed');
  }finally{f.close();}
});

test('contracted report rechecks its source after native readiness and never sends to a changed session',async()=>{
  const f=fixture();try{
    const {worker,reportId}=await contractedReport(f);let start!:()=>void,release!:()=>void;
    const started=new Promise<void>(r=>start=r),waiting=new Promise<void>(r=>release=r);let sent=0;
    const native:any={store:f.store,connections:{assert:async()=>{start();await waiting;},route:()=>({transport:'managed-cli',executionMode:'cli'})},run:NativeAgents.prototype.run,managedRun:async()=>{sent++;}};
    native.beforeDispatch=(binding:any,id:string)=>f.r.assertDispatchAllowed(id,binding);f.r.native=native;f.r.brain.tick=()=>{};
    Router.prototype.pump.call(f.r);await started;
    f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),worker.id);release();
    await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
    assert.equal(sent,0);assert.equal(f.store.job(reportId)?.status,'failed');assert.match(f.store.job(reportId)?.error??'',/not sent|nothing was sent/i);
  }finally{f.r.stopped=true;f.close();}
});
