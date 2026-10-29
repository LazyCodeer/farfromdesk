import assert from 'node:assert/strict';
import {Store} from '../../src/store.js';
import {DEFAULT_BRAIN,MetaSecret} from '../../src/meta-brain-config.js';
import {Schedules} from '../../src/schedules.js';
import {Router} from '../../src/router.js';
import {Coordinator} from '../../src/coordinator.js';
import {Approvals} from '../../src/approvals.js';
import {NativeAgents} from '../../src/native.js';
import {recordBriefDispatch} from '../../src/brief-dispatch-guard.js';
import {MorningBrief} from '../../src/morning-brief.js';

globalThis.fetch=async()=>{throw new Error('Unexpected network request in isolated test');};
const root=process.env.WSB_STATE_DIR;if(!root)throw Error('An isolated WSB_STATE_DIR is required.');
const store=new Store(':memory:'),owner='owner@s.whatsapp.net';store.set('whatsapp-owner',owner);
if(process.argv[2]==='no-schema'){assert.equal(store.requestOwnerOrigin('schedule:missing'),undefined);store.close();console.log('ok');process.exit(0);}
store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:['codex']}));
const secret=new MetaSecret(root);secret.save('synthetic-secret-not-real-123');
let now=Date.parse('2026-10-29T12:29:00Z');
const scenario=process.argv[2];
const binding=store.register('site','codex','11111111-1111-4111-8111-111111111111','/tmp/isolated-site').binding;
if(scenario==='delegated')store.set('master',binding.id);
const approvals=new Approvals(store);let started!:()=>void,release!:()=>void,startedWait=new Promise<void>(r=>started=r),held=new Promise<void>(r=>release=r),sends=0;
const native:any={store,connections:{assert:async()=>{started();await held;},route:()=>({transport:'managed-cli',executionMode:'cli'})},run:NativeAgents.prototype.run,managedRun:async()=>{sends++;}};
const router=new Router(store,native,approvals);router.coordinator=new Coordinator(store,native,router,()=>{});router.brain.tick=()=>{};
router.schedules=new Schedules(store,secret,async()=>({kind:'create',action:'session',date:'2026-10-29',time:'18:00',zone:'Asia/Kolkata',repeat:'once',text:'check PR 20',target:'site',question:''}),()=>now);
await router.schedules.handle(router,{id:'wa:create',text:'At 6 PM ask site to check PR 20',ownerCommand:true},true);
now=Date.parse('2026-10-29T12:30:00Z');
if(scenario==='composition'){
  const pump=router.pump;router.pump=()=>{};await router.schedules.tick(router);router.pump=pump;
  const scheduled=store.db.prepare("SELECT * FROM inbox WHERE id LIKE 'schedule:%'").get() as any;
  store.recordOwnerOrigin('wa:brief',owner,owner);store.enqueue('wa:brief',binding,'Continue the item',owner);
  const stamp=Date.now(),insert=store.db.prepare("INSERT INTO items(title,status,binding_id,created_at,updated_at) VALUES('Test item','in progress',?,?,?)").run(binding.id,stamp,stamp),item=Number(insert.lastInsertRowid);
  store.db.prepare('INSERT INTO item_owner_origins VALUES(?,?,?)').run(item,owner,owner);store.linkItem('wa:brief',item);
  recordBriefDispatch(router,store.job('wa:brief')!,item,binding.id);
  assert.equal(router.assertDispatchAllowed(scheduled.id,binding),true);assert.equal(router.assertDispatchAllowed('wa:brief',binding),true);
  store.db.prepare("UPDATE items SET status='done' WHERE id=?").run(item);
  assert.throws(()=>router.assertDispatchAllowed('wa:brief',binding));assert.equal(router.assertDispatchAllowed(scheduled.id,binding),true);
  store.set('whatsapp-owner','other@s.whatsapp.net');assert.throws(()=>router.assertDispatchAllowed(scheduled.id,binding));
  assert.equal(store.job(scheduled.id)?.status,'failed');assert.equal(store.job('wa:brief')?.status,'failed');
}else if(scenario==='brief'){
  store.db.prepare("UPDATE schedules SET status='cancelled'").run();
  now=Date.parse('2026-10-29T03:29:00Z');
  const brief=new MorningBrief(store,router,async()=>({opening:'Good morning.',priorities:[]}),()=>now,async()=>{throw Error('No network expected');});
  router.morningBrief=brief;router.scheduledBrief=(destination,expectedOwner,occurrence,canSend)=>brief.scheduledBrief(destination,expectedOwner,occurrence,canSend);
  router.schedules=new Schedules(store,secret,async()=>({kind:'create',action:'brief',date:'2026-10-29',time:'09:00',zone:'Asia/Kolkata',repeat:'weekdays',text:'',target:'',question:''}),()=>now);
  await router.schedules.handle(router,{id:'wa:brief-schedule',text:'Every weekday at 9 send my brief',ownerCommand:true},true);
  now=Date.parse('2026-10-29T03:30:00Z');await router.schedules.tick(router);await router.schedules.tick(router);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM morning_briefs').get()?.n,1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM schedule_occurrences').get()?.n,1);
  assert.equal(await brief.request(owner,'first-message',now),false);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM outbox WHERE source LIKE 'morning-brief:%'").get()?.n,1);
}else if(scenario==='delegated'){
  const worker=store.register('worker','codex','22222222-2222-4222-8222-222222222222','/tmp/isolated-worker').binding;
  store.set('selected',JSON.stringify([worker.id]));const pump=router.pump;router.pump=()=>{};
  await router.schedules.tick(router);const parent=store.db.prepare("SELECT id FROM inbox WHERE id LIKE 'schedule:%'").get() as {id:string};
  const ids=router.coordinator!.dispatch(parent.id,[worker.id],'Check the PR status only.','test-event');
  const item=store.itemOf(parent.id);assert.ok(item);assert.ok(store.db.prepare('SELECT 1 FROM item_owner_origins WHERE item_id=? AND owner=? AND destination=?').get(item,owner,owner));
  store.jobState(parent.id,'submitted');router.pump=pump;router.pump();await startedWait;
  assert.equal(store.job(ids[0])?.status,'dispatched');store.set('whatsapp-owner','other@s.whatsapp.net');release();
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sends,0);assert.equal(store.job(ids[0])?.status,'failed');assert.match(store.job(ids[0])?.error??'',/not sent/);
}else{
  await router.schedules.tick(router);await startedWait;
  const job=store.db.prepare("SELECT id,status FROM inbox WHERE id LIKE 'schedule:%'").get() as {id:string;status:string};assert.equal(job.status,'dispatched');
  if(scenario==='channel-hold'){store.set('telegram-owner','tg:1:2');store.set('control-channel','telegram');}
  else if(scenario==='owner')store.set('whatsapp-owner','other@s.whatsapp.net');
  else if(scenario==='binding')store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run('99999999-9999-4999-8999-999999999999',binding.id);
  else throw Error('Unknown scenario');
  release();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sends,0);
  if(scenario==='channel-hold'){
    assert.equal(store.job(job.id)?.status,'queued');
    router.pump();await new Promise(resolve=>setImmediate(resolve));assert.equal(sends,0);
    store.set('control-channel','whatsapp');router.pump();
    await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
    assert.equal(sends,1);assert.equal(store.job(job.id)?.status,'submitted');
    router.pump();await new Promise(resolve=>setImmediate(resolve));assert.equal(sends,1);
  }else {assert.equal(store.job(job.id)?.status,'failed');assert.match(store.job(job.id)?.error??'',/not sent/);}
}
router.stopped=true;approvals.cancel();store.close();console.log('ok');
