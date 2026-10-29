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
import {DEFAULT_BRAIN,MetaSecret} from '../src/meta-brain-config.js';
import {TaskContracts} from '../src/task-contracts.js';
import {Schedules,scheduleJobState} from '../src/schedules.js';

function fixture(repeat:'once'|'daily'='once') {
  const dir=mkdtempSync(join(tmpdir(),'ffd-contract-schedule-')),store=new Store(':memory:'),approvals=new Approvals(store);
  const native={run:async()=>{},stop:()=>{}},router=new Router(store,native as any,approvals);
  router.pump=()=>{};store.set('whatsapp-owner','owner@s.whatsapp.net');
  store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:['codex']}));
  const secret=new MetaSecret(dir);secret.save('synthetic-contract-key-not-real');
  const binding=store.register('site','codex',randomUUID(),'/tmp/site').binding;
  const coordinator=new Coordinator(store,native as any,router,()=>{});router.coordinator=coordinator;
  let now=Date.parse('2026-10-29T12:29:00Z'),calls=0;
  router.contracts=new TaskContracts(store,secret,async()=>{calls++;return {kind:'contract',goal:'Check the release',exclusions:['Do not deploy'],checks:['Check status','Report outcome'],question:''};},()=>now);
  router.schedules=new Schedules(store,secret,async()=>({kind:'create',action:'session',date:'2026-10-29',time:'18:00',zone:'Asia/Kolkata',repeat,text:'check PR 20',target:'site',question:''}),()=>now);
  const send=(id:string,text:string)=>router.receive({id:`wa:${id}`,text,source:'text',ownerIntent:true,ownerCommand:true});
  return {store,router,binding,send,setNow:(n:number)=>{now=n;},calls:()=>calls,markSent:()=>store.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run(),close:()=>{approvals.cancel();store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('unclear scheduled work requires owner approval and uses the exact reviewed plan',async()=>{
  const f=fixture();try{
    await f.send('one','At 6 PM ask site to check PR 20');
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM schedules').get()?.n,0);
    assert.equal(f.store.jobs().length,0);
    const proposal=f.store.db.prepare("SELECT body FROM outbox WHERE source LIKE 'task-contract:%'").get() as {body:string};
    assert.match(proposal.body,/Schedule: 2026-10-29 at 18:00/);assert.match(proposal.body,/approval expires/i);
    f.markSent();await f.send('approve','ok');
    assert.equal(f.calls(),1);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM schedules').get()?.n,1);
    f.setNow(Date.parse('2026-10-29T12:30:00Z'));await f.router.schedules.tick(f.router);
    const job=f.store.jobs()[0];assert.ok(job);assert.equal(job.binding_id,f.binding.id);assert.match(job.body,/Owner-approved task contract/);assert.match(job.body,/Do not deploy/);
    assert.ok(f.store.itemOf(job.id));assert.equal(scheduleJobState(f.router,job.id),'ready');assert.equal(f.router.assertDispatchAllowed(job.id,f.binding),true);
  }finally{f.close();}
});

test('scheduled task keeps a do-not constraint in the exact owner text',async()=>{
  const f=fixture();try{
    f.router.schedules=new Schedules(f.store,f.router.contracts.secret,async()=>({kind:'create',action:'session',date:'2026-10-29',time:'18:00',zone:'Asia/Kolkata',repeat:'once',text:'check PR 20 and do NOT deploy',target:'site',question:''}),()=>Date.parse('2026-10-29T12:29:00Z'));
    await f.send('one','At 6 PM ask site to check PR 20 and do NOT deploy');f.markSent();await f.send('approve','ok');
    f.setNow(Date.parse('2026-10-29T12:30:00Z'));const task=f.store.db.prepare('SELECT text FROM schedules').get() as {text:string};
    assert.equal(task.text,'check PR 20 and do NOT deploy');
  }finally{f.close();}
});

test('approval interrupted before schedule creation resumes exactly once',async()=>{
  const f=fixture();try{
    await f.send('one','At 6 PM ask site to check PR 20');f.markSent();
    const incoming={id:'wa:approve',text:'ok',source:'text' as const,ownerIntent:true,ownerCommand:true};
    assert.equal((await f.router.contracts.preflight(f.router,incoming)).kind,'replay');
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM schedules').get()?.n,0);
    assert.equal((await f.router.receive(incoming)).status,'handled');await f.router.receive(incoming);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM schedules').get()?.n,1);assert.equal(f.calls(),1);
  }finally{f.close();}
});

test('owner changes or schedule edits after approval cannot dispatch',async()=>{
  for(const change of ['owner','task','time','target']){const f=fixture();try{
    await f.send('one','At 6 PM ask site to check PR 20');f.markSent();await f.send('approve','ok');
    if(change==='owner')f.store.set('whatsapp-owner','another@s.whatsapp.net');
    if(change==='task')f.store.db.prepare('UPDATE schedules SET text=?').run('deploy production');
    if(change==='time')f.store.db.prepare('UPDATE schedules SET next_at=next_at+60000').run();
    if(change==='target')f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),f.binding.id);
    f.setNow(Date.parse('2026-10-29T12:32:00Z'));await f.router.schedules.tick(f.router);
    assert.equal(f.store.jobs().length,0,change);
  }finally{f.close();}}
});

test('recurring approval is bounded and not renewed after two years',async()=>{
  const f=fixture('daily');try{
    await f.send('one','Every day at 6 PM ask site to check PR 20');f.markSent();await f.send('approve','ok');
    f.setNow(Date.parse('2028-11-01T12:30:00Z'));await f.router.schedules.tick(f.router);
    assert.equal(f.store.jobs().length,0);
    assert.equal(f.store.db.prepare('SELECT status FROM schedules').get()?.status,'invalid');
  }finally{f.close();}
});

test('a recurring approval binds each occurrence to the same owner contract and item',async()=>{
  const f=fixture('daily');try{
    await f.send('one','Every day at 6 PM ask site to check PR 20');f.markSent();await f.send('approve','ok');
    f.setNow(Date.parse('2026-10-29T12:30:00Z'));await f.router.schedules.tick(f.router);
    f.setNow(Date.parse('2026-10-30T12:30:00Z'));await f.router.schedules.tick(f.router);
    const jobs=f.store.jobs();assert.equal(jobs.length,2);assert.equal(f.calls(),1);
    assert.ok(jobs.every(job=>/Owner-approved task contract/.test(job.body)));
    assert.equal(f.store.itemOf(jobs[0].id),f.store.itemOf(jobs[1].id));
    for(const job of jobs){assert.equal(scheduleJobState(f.router,job.id),'ready');assert.equal(f.router.assertDispatchAllowed(job.id,f.binding),true);}
  }finally{f.close();}
});

test('a queued scheduled contract cannot dispatch after its approval or owner changes',async()=>{
  for(const change of ['contract','owner','binding','cancel']){const f=fixture();try{
    await f.send('one','At 6 PM ask site to check PR 20');f.markSent();await f.send('approve','ok');
    f.setNow(Date.parse('2026-10-29T12:30:00Z'));await f.router.schedules.tick(f.router);const job=f.store.jobs()[0];assert.ok(job);
    if(change==='contract')f.store.db.prepare("UPDATE task_contracts SET state='cancelled'").run();
    if(change==='owner')f.store.set('whatsapp-owner','other@s.whatsapp.net');
    if(change==='binding')f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),f.binding.id);
    if(change==='cancel')f.store.db.prepare("UPDATE schedules SET status='cancelled'").run();
    assert.throws(()=>f.router.assertDispatchAllowed(job.id,f.store.binding(f.binding.id)!),/not sent|changed/i,change);
  }finally{f.close();}}
});

test('the owner can revoke a queued one-time scheduled contract before submission',async()=>{
  const f=fixture();try{
    await f.send('one','At 6 PM ask site to check PR 20');f.markSent();await f.send('approve','ok');
    f.setNow(Date.parse('2026-10-29T12:30:00Z'));await f.router.schedules.tick(f.router);const job=f.store.jobs()[0];assert.ok(job);
    await f.send('list','list my reminders');await f.send('cancel','cancel 1');
    assert.equal(f.store.db.prepare('SELECT status FROM schedules').get()?.status,'cancelled');
    assert.throws(()=>f.router.assertDispatchAllowed(job.id,f.binding),/not sent|changed/i);
  }finally{f.close();}
});

test('existing scheduled work cannot bypass task review when contracts are enabled',async()=>{
  const f=fixture();try{
    f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:['codex'],taskContracts:false}));
    await f.send('one','At 6 PM ask site to check PR 20');assert.equal(f.calls(),0);
    f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:['codex'],taskContracts:true}));
    f.setNow(Date.parse('2026-10-29T12:30:00Z'));await f.router.schedules.tick(f.router);
    assert.equal(f.store.jobs().length,0);assert.equal(f.store.db.prepare('SELECT status FROM schedules').get()?.status,'invalid');
  }finally{f.close();}
});

test('delegated scheduled work carries the approved contract and rechecks both sessions',async()=>{
  const f=fixture();try{
    const c=f.router.coordinator!;c.registry.register(f.binding);f.store.set('master',f.binding.id);
    const worker=f.store.register('worker','codex',randomUUID(),'/tmp/worker').binding;
    f.store.set('selected',JSON.stringify([worker.id]));
    await f.send('one','At 6 PM ask site to check PR 20');f.markSent();await f.send('approve','ok');
    f.setNow(Date.parse('2026-10-29T12:30:00Z'));await f.router.schedules.tick(f.router);const root=f.store.jobs()[0];assert.ok(root);
    const [id]=c.dispatch(root.id,[worker.id],'Check the PR only.','event');const child=f.store.job(id)!;
    assert.match(child.body,/Owner-approved task contract/);assert.match(child.body,/Do not deploy/);
    assert.equal(f.store.itemOf(child.id),f.store.itemOf(root.id));assert.equal(f.router.assertDispatchAllowed(child.id,worker),true);
    f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),f.binding.id);
    assert.throws(()=>f.router.assertDispatchAllowed(child.id,worker),/not sent|changed/i);
  }finally{f.close();}
});
