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
import {MorningBrief} from '../src/morning-brief.js';
import {MetaBrain} from '../src/meta-brain.js';
import {DEFAULT_BRAIN,MetaSecret,brainPolicy,saveBrainConfig} from '../src/meta-brain-config.js';
import {TaskContracts,contractDeliveryState} from '../src/task-contracts.js';
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
