import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {DEFAULT_BRAIN,MetaSecret} from '../src/meta-brain-config.js';
import {Schedules,scheduleDeliveryState,scheduleJobState,scheduleOwnerValid,failScheduledBeforeSubmission} from '../src/schedules.js';
import {localInstants,nextOccurrence} from '../src/schedule-time.js';
import type {ScheduleDecision,ScheduleInterpreter} from '../src/schedule-model.js';
import {Router} from '../src/router.js';
import {Coordinator} from '../src/coordinator.js';
import {Approvals} from '../src/approvals.js';
import {TaskContracts} from '../src/task-contracts.js';

function fixture(file=':memory:') {
  const dir=mkdtempSync(join(tmpdir(),'ffd-schedule-test-'));
  const store=new Store(file==='disk'?join(dir,'state.sqlite'):file);
  store.set('whatsapp-owner','owner@s.whatsapp.net');
  store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:['codex'],taskContracts:false}));
  const secret=new MetaSecret(dir);secret.save('synthetic-secret-not-real-123');
  let now=Date.parse('2026-10-29T12:29:00Z');
  let decision:ScheduleDecision={kind:'create',action:'message',date:'2026-10-29',time:'18:00',zone:'Asia/Kolkata',repeat:'once',text:'call the bank',target:'',question:''};
  const interpret:ScheduleInterpreter=async()=>decision;
  const schedules=new Schedules(store,secret,interpret,()=>now);
  const contracts=new TaskContracts(store,secret,async()=>{throw Error('unused');});
  const router={store,contracts,stopped:false,coordinator:{enabled:()=>['codex'],registry:{entry:()=>undefined,identity:()=>({key:'test'})}},queue:(id:string,b:any,text:string)=>store.enqueue(id,b,text),pump:()=>{}} as unknown as Router;
  const send=(id:string,text:string)=>schedules.handle(router,{id:`wa:${id}`,text,ownerCommand:true},true);
  return {store,secret,schedules,router,send,dir,setNow:(n:number)=>now=n,setDecision:(d:Partial<ScheduleDecision>)=>decision={...decision,...d},close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('one-time reminder is durable, due on time, and queued locally only once',async()=>{
  const f=fixture('disk');try{
    assert.equal(await f.send('1','Remind me at 6 PM to call the bank'),true);
    await f.schedules.tick(f.router);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM schedule_occurrences").get()?.n,0);
    f.setNow(Date.parse('2026-10-29T12:30:00Z'));
    await f.schedules.tick(f.router);await f.schedules.tick(f.router);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM schedule_occurrences').get()?.n,1);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outbox WHERE body LIKE '%Reminder: call the bank%'").get()?.n,1);
    const path=join(f.dir,'state.sqlite');f.store.close();
    const reopened=new Store(path),again=new Schedules(reopened,f.secret,async()=>{throw Error('not called');},()=>Date.parse('2026-10-29T12:31:00Z'));
    const router={store:reopened,stopped:false,pump:()=>{}} as unknown as Router;
    await again.tick(router);
    assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM schedule_occurrences').get()?.n,1);
    assert.equal(reopened.db.prepare("SELECT count(*) AS n FROM outbox WHERE body LIKE '%Reminder: call the bank%'").get()?.n,1);
    reopened.close();rmSync(f.dir,{recursive:true,force:true});
  }catch(e){try{f.close();}catch{}throw e;}
});

test('repeated and missing DST local times are not silently guessed for one-time reminders',()=>{
  assert.equal(localInstants('2026-03-08','02:30','America/New_York').length,0);
  assert.equal(localInstants('2026-11-01','01:30','America/New_York').length,2);
  assert.throws(()=>nextOccurrence('2026-11-01','01:30','America/New_York','once',0),/occurs twice/);
  const next=nextOccurrence('2026-10-30','09:00','Asia/Kolkata','weekdays',Date.parse('2026-10-30T03:31:00Z'))!;
  assert.equal(new Date(next).toISOString(),'2026-11-02T03:30:00.000Z');
});

test('owner change while model runs cannot create a reminder',async()=>{
  const f=fixture();try{
    let resolve!:(x:ScheduleDecision)=>void;
    const delayed=new Schedules(f.store,f.secret,()=>new Promise(r=>resolve=r),()=>Date.parse('2026-10-29T12:29:00Z'));
    const pending=delayed.handle(f.router,{id:'wa:pending',text:'Remind me at 6 PM to call the bank',ownerCommand:true},true);
    f.store.set('whatsapp-owner','other@s.whatsapp.net');resolve({kind:'create',action:'message',date:'2026-10-29',time:'18:00',zone:'Asia/Kolkata',repeat:'once',text:'call the bank',target:'',question:''});
    await assert.rejects(pending,/changed/);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM schedules').get()?.n,0);
  }finally{f.close();}
});

test('re-pairing invalidates due reminders and prevents previously queued reminders from delivery',async()=>{
  const f=fixture();try{
    await f.send('1','Remind me at 6 PM to call the bank');f.setNow(Date.parse('2026-10-29T12:30:00Z'));await f.schedules.tick(f.router);
    const row=f.store.db.prepare("SELECT id FROM outbox WHERE body LIKE '%Reminder: call the bank%'").get() as {id:string};
    assert.equal(scheduleOwnerValid(f.store,'outbox',row.id),true);
    f.store.set('whatsapp-owner','other@s.whatsapp.net');assert.equal(scheduleOwnerValid(f.store,'outbox',row.id),false);
  }finally{f.close();}
});

test('list and cancel consume only the same owner fresh numbered snapshot',async()=>{
  const f=fixture();try{
    await f.send('1','Remind me at 6 PM to call the bank');await f.send('2','list my reminders');await f.send('3','cancel 1');
    assert.equal(f.store.db.prepare('SELECT status FROM schedules').get()?.status,'cancelled');
    f.setNow(Date.parse('2026-10-29T12:31:00Z'));await f.schedules.tick(f.router);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM schedule_occurrences').get()?.n,0);
  }finally{f.close();}
});

test('repeating missed reminders enqueue once and move directly to the next future weekday',async()=>{
  const f=fixture();try{
    f.setDecision({repeat:'weekdays',time:'18:00'});
    await f.send('1','Every weekday at 6 PM remind me to call the bank');
    f.setNow(Date.parse('2026-11-02T12:31:00Z'));await f.schedules.tick(f.router);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM schedule_occurrences').get()?.n,1);
    const row=f.store.db.prepare('SELECT next_at FROM schedules').get() as {next_at:number};
    assert.equal(new Date(row.next_at).toISOString(),'2026-11-03T12:30:00.000Z');
  }finally{f.close();}
});

test('group requests fail closed and do not create schedules',async()=>{
  const f=fixture();try{
    f.store.set('destination-jid','group@g.us');f.store.set('owned-group:group@g.us','true');
    assert.equal(await f.store.destinationContext.run('group@g.us',()=>f.send('1','Remind me at 6 PM to call the bank')),true);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM schedules').get()?.n,0);
  }finally{f.close();}
});

test('scheduled session is bound to exact explicit session and cannot dispatch after owner changes',async()=>{
  const f=fixture();try{
    const {binding}=f.store.register('site','codex','11111111-1111-4111-8111-111111111111','/tmp/example');
    f.setDecision({action:'session',text:'check PR 20',target:'site'});
    await f.send('1','At 6 PM ask site to check PR 20');f.setNow(Date.parse('2026-10-29T12:30:00Z'));await f.schedules.tick(f.router);
    const job=f.store.db.prepare('SELECT id,binding_id FROM inbox').get() as {id:string;binding_id:string};
    assert.equal(job.binding_id,binding.id);assert.equal(scheduleOwnerValid(f.store,'job',job.id),true);
    f.store.set('whatsapp-owner','other@s.whatsapp.net');assert.equal(scheduleOwnerValid(f.store,'job',job.id),false);
  }finally{f.close();}
});

test('scheduled session work accepts the name the owner sees',async()=>{
  const f=fixture();try{
    const {binding}=f.store.register('cloud-srv','codex','22222222-2222-4222-8222-222222222222','/tmp/cloud');f.store.set(`name:${binding.id}`,'FarFromDesk cloud server');
    f.setDecision({action:'session',text:'run the tests',target:'FarFromDesk cloud server'});
    await f.send('1','At 6 PM ask the FarFromDesk cloud server session to run the tests');
    assert.equal((f.store.db.prepare('SELECT text FROM schedules').get() as {text:string}|undefined)?.text,'run the tests');
    f.setDecision({action:'session',text:'run the build',target:'FarFromDesk cloud server'});
    await f.send('3','At 6 PM ask the FarFromDesk cloud server session to run the build and tell me the results');
    assert.ok(f.store.db.prepare("SELECT 1 FROM schedules WHERE text='run the build and tell me the results'").get(),'the owner words, not the model trim');
    f.setDecision({action:'session',text:'run the lint',target:'cloud server'});
    await f.send('2','At 6 PM ask the cloud server session to run the lint');
    assert.ok(f.store.db.prepare("SELECT 1 FROM schedules WHERE text='run the lint'").get());
  }finally{f.close();}
});

test('a revoked inbound context settles a scheduled action without sending its rejection notice',async()=>{
  const f=fixture();try{
    f.store.register('site','codex','11111111-1111-4111-8111-111111111111','/tmp/example');
    f.setDecision({action:'session',text:'check PR 20',target:'site'});
    await f.send('1','At 6 PM ask site to check PR 20');f.setNow(Date.parse('2026-10-29T12:30:00Z'));await f.schedules.tick(f.router);
    const job=f.store.db.prepare('SELECT id FROM inbox').get() as {id:string};
    const captured=f.store.captureIncomingOwner('owner@s.whatsapp.net','whatsapp')!;
    f.store.set('whatsapp-owner','other@s.whatsapp.net');f.store.set('whatsapp-owner','owner@s.whatsapp.net');
    f.store.incomingOwnerContext.run(captured,()=>failScheduledBeforeSubmission(f.router,job.id,'Nothing was sent.'));
    assert.equal(f.store.job(job.id)?.status,'failed');assert.equal(f.store.db.prepare('SELECT 1 FROM outbox WHERE source=?').get(`schedule-error:${job.id}:0`),undefined);
  }finally{f.close();}
});

test('scheduled coordinator requests support delegation and resolution only for the original owner',async()=>{
  const f=fixture();try{
    const {binding:master}=f.store.register('proxy','codex','22222222-2222-4222-8222-222222222222','/tmp/proxy');
    const {binding:worker}=f.store.register('worker','codex','44444444-4444-4444-8444-444444444444','/tmp/worker');
    f.store.set('master',master.id);f.store.set('selected',JSON.stringify([worker.id]));
    const coordinator=new Coordinator(f.store,{} as any,f.router);f.router.coordinator=coordinator;
    Object.setPrototypeOf(f.router,Router.prototype);(f.router as any).busy=new Set();(f.router as any).approvals={pending:new Map()};
    f.setDecision({action:'session',text:'check whether PR 20 is green and tell me',target:''});
    await f.send('1','At 6 PM check whether PR 20 is green and tell me');f.setNow(Date.parse('2026-10-29T12:30:00Z'));await f.schedules.tick(f.router);
    const job=f.store.db.prepare('SELECT id FROM inbox').get() as {id:string};
    assert.equal(coordinator.ownerRequest(job.id).id,job.id);
    const children=coordinator.dispatch(job.id,[worker.id],'Check the PR status only.','test-delegate');assert.equal(children.length,1);
    assert.equal(scheduleJobState(f.router,children[0]),'ready');
    coordinator.workerReply(worker,'Status update',children[0],false);
    const report=f.store.db.prepare("SELECT id FROM inbox WHERE id LIKE 'report:%'").get() as {id:string};assert.equal(scheduleJobState(f.router,report.id),'ready');
    f.store.db.prepare('UPDATE inbox SET body=? WHERE id=?').run('Modified action',children[0]);assert.equal(scheduleJobState(f.router,children[0]),'invalid');
    f.store.db.prepare('UPDATE inbox SET body=? WHERE id=?').run('Check the PR status only.',children[0]);
    f.store.db.prepare('UPDATE inbox SET destination=? WHERE id=?').run('other@s.whatsapp.net',children[0]);assert.equal(scheduleJobState(f.router,children[0]),'invalid');
    f.store.db.prepare('UPDATE inbox SET destination=? WHERE id=?').run('owner@s.whatsapp.net',children[0]);
    f.store.set('whatsapp-owner','other@s.whatsapp.net');
    assert.throws(()=>coordinator.ownerRequest(job.id),/closed or uncertain/);
    assert.equal(scheduleJobState(f.router,children[0]),'invalid');
    assert.equal(scheduleJobState(f.router,report.id),'invalid');
    coordinator.workerReply(worker,'Late update',children[0],false,'progress');assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM inbox WHERE id LIKE 'report:%'").get()?.n,1);
    assert.throws(()=>Router.prototype.resolveOwner.call(f.router,job.id,'done'),/original request/);
    f.store.set('whatsapp-owner','owner@s.whatsapp.net');f.store.jobState(children[0],'completed');f.store.jobState(report.id,'completed');
    Router.prototype.resolveOwner.call(f.router,job.id,'done');assert.equal(f.store.job(job.id)?.status,'completed');
  }finally{f.close();}
});

test('changing the active channel holds an owner reminder and resumes it when restored',async()=>{
  const f=fixture();try{
    await f.send('1','Remind me at 6 PM to call the bank');
    f.setNow(Date.parse('2026-10-29T12:30:00Z'));f.store.set('control-channel','telegram');f.store.set('telegram-owner','tg:1:2');
    await f.schedules.tick(f.router);assert.equal(f.store.db.prepare('SELECT status FROM schedules').get()?.status,'active');
    f.store.set('control-channel','whatsapp');await f.schedules.tick(f.router);
    const out=f.store.db.prepare("SELECT id FROM outbox WHERE body LIKE '%Reminder: call the bank%'").get() as {id:string};
    f.store.set('control-channel','telegram');assert.equal(scheduleDeliveryState(f.store,out.id),'hold');
    f.store.set('control-channel','whatsapp');assert.equal(scheduleDeliveryState(f.store,out.id),'ready');
  }finally{f.close();}
});

test('a held reminder does not block another reply on the original transport',async()=>{
  const f=fixture();try{
    await f.send('1','Remind me at 6 PM to call the bank');
    f.store.db.prepare("UPDATE outbox SET status='sent'").run();
    f.setNow(Date.parse('2026-10-29T12:30:00Z'));await f.schedules.tick(f.router);
    f.store.set('control-channel','telegram');f.store.set('telegram-owner','tg:1:2');
    f.store.output(undefined,'An ordinary reply','ordinary',f.store.get('whatsapp-owner'));
    assert.equal(f.store.routableOutbound('whatsapp')?.source,'ordinary:0');
    f.store.set('control-channel','whatsapp');
    assert.match(String(f.store.routableOutbound('whatsapp')?.body),/Reminder: call the bank/);
  }finally{f.close();}
});

test('queued scheduled session work rechecks connection identity and routing policy at dispatch',async()=>{
  const f=fixture();try{
    const {binding}=f.store.register('site','codex','11111111-1111-4111-8111-111111111111','/tmp/example');
    f.setDecision({action:'session',text:'check PR 20',target:'site'});await f.send('1','At 6 PM ask site to check PR 20');
    f.setNow(Date.parse('2026-10-29T12:30:00Z'));await f.schedules.tick(f.router);
    const job=f.store.db.prepare('SELECT id FROM inbox').get() as {id:string};
    assert.equal(scheduleJobState(f.router,job.id),'ready');
    f.store.set('control-channel','telegram');f.store.set('telegram-owner','tg:1:2');assert.equal(scheduleJobState(f.router,job.id),'hold');
    f.store.set('control-channel','whatsapp');f.store.set(`session-route:${binding.id}`,'changed');assert.equal(scheduleJobState(f.router,job.id),'invalid');
  }finally{f.close();}
});

test('a held scheduled desktop job does not block a later ordinary job to the same session',async()=>{
  const f=fixture();try{
    const {binding}=f.store.register('site','codex','11111111-1111-4111-8111-111111111111','/tmp/example');
    f.setDecision({action:'session',text:'check PR 20',target:'site'});await f.send('1','At 6 PM ask site to check PR 20');
    f.setNow(Date.parse('2026-10-29T12:30:00Z'));await f.schedules.tick(f.router);
    const scheduled=f.store.db.prepare('SELECT id FROM inbox').get() as {id:string};
    f.store.set('control-channel','telegram');f.store.set('telegram-owner','tg:1:2');
    f.store.enqueue('tg:1:2:88',binding,'normal owner request','tg:1:2');
    const calls:string[]=[];const r=Object.assign(Object.create(Router.prototype),{store:f.store,contracts:f.router.contracts,stopped:false,busy:new Set(),brain:{tick:()=>{}},native:{run:async(_b:any,_body:string,id:string)=>{calls.push(id);}},coordinator:undefined});
    r.pump();await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(calls,['tg:1:2:88']);assert.equal(f.store.job(scheduled.id)?.status,'queued');
  }finally{f.close();}
});

test('channel polling skips held work and refuses changed-owner scheduled jobs',async()=>{
  const f=fixture(),prior=process.env.WSB_STATE_DIR;process.env.WSB_STATE_DIR=f.dir;
  try{
    const {binding}=f.store.register('site','codex','11111111-1111-4111-8111-111111111111','/tmp/example','channel');
    f.setDecision({action:'session',text:'check PR 20',target:'site'});await f.send('1','At 6 PM ask site to check PR 20');
    f.setNow(Date.parse('2026-10-29T12:30:00Z'));await f.schedules.tick(f.router);
    const scheduled=f.store.db.prepare('SELECT id FROM inbox').get() as {id:string};
    f.store.set('control-channel','telegram');f.store.set('telegram-owner','tg:1:2');f.store.enqueue('tg:1:2:88',binding,'normal request','tg:1:2');
    const r=Object.assign(Object.create(Router.prototype),{store:f.store,contracts:f.router.contracts,channelClients:new Map(),attachments:{references:()=>[]},coordinator:f.router.coordinator});
    const result=r.channelPoll(binding,'client');assert.equal(result?.id,'tg:1:2:88');
    f.store.jobState('tg:1:2:88','completed');f.store.set('control-channel','whatsapp');f.store.set('whatsapp-owner','other@s.whatsapp.net');
    assert.equal(r.channelPoll(binding,'client'),null);assert.equal(f.store.job(scheduled.id)?.status,'failed');
  }finally{if(prior===undefined)delete process.env.WSB_STATE_DIR;else process.env.WSB_STATE_DIR=prior;f.close();}
});

test('model may not invent reminder contents, target, or timezone',async()=>{
  const f=fixture();try{
    f.setDecision({text:'send money'});await assert.rejects(f.send('1','Remind me at 6 PM to call the bank'),/exact reminder/);
    f.setDecision({text:'call the bank',zone:'America/New_York'});await assert.rejects(f.send('2','Remind me at 6 PM to call the bank'),/time zone explicitly/);
    f.setDecision({text:'call the bank',zone:'America/New_York'});await f.send('3','Remind me at 6 PM New York time to call the bank');assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM schedules').get()?.n,1);
    f.store.db.prepare('DELETE FROM schedules').run();
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM schedules').get()?.n,0);
  }finally{f.close();}
});

test('a model cannot turn an owner reminder into a session action',async()=>{
  const f=fixture();try{
    f.store.register('codex','codex','33333333-3333-4333-8333-333333333333','/tmp/codex');
    f.setDecision({action:'session',text:'deploy production',target:'codex'});
    await assert.rejects(f.send('1','Remind me at 6 PM to deploy production with codex'),/reminder alone/);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM schedules').get()?.n,0);
  }finally{f.close();}
});

test('a model cannot remove qualifiers from an explicitly authorized session action',async()=>{
  const f=fixture();try{
    f.store.register('codex','codex','33333333-3333-4333-8333-333333333333','/tmp/codex');
    // The model's shortened "deploy production" is ignored: the owner's full words are what runs.
    f.setDecision({action:'session',text:'deploy production',target:'codex'});
    await f.send('1','At 6 PM ask codex to check whether it is safe to deploy production');
    f.setNow(Date.parse('2026-10-29T12:30:00Z'));await f.schedules.tick(f.router);
    assert.equal(f.store.db.prepare('SELECT body FROM inbox').get()?.body,'check whether it is safe to deploy production');
  }finally{f.close();}
});

test('a model cannot remove qualifiers from reminder text',async()=>{
  const f=fixture();try{
    // The model's shortened "deploy production" is ignored: the owner's full words are what gets saved.
    f.setDecision({text:'deploy production'});
    await f.send('1','Remind me at 6 PM to check whether it is safe to deploy production');
    assert.equal(f.store.db.prepare('SELECT text FROM schedules').get()?.text,'check whether it is safe to deploy production');
  }finally{f.close();}
});

test('scheduled action is the exact owner text, preserving case and whitespace',async()=>{
  const f=fixture();try{
    f.store.register('codex','codex','33333333-3333-4333-8333-333333333333','/tmp/codex');
    f.setDecision({action:'session',text:'delete /tmp/test',target:'codex'});
    await f.send('1','At 6 PM ask codex to delete  /tmp/Test');
    f.setNow(Date.parse('2026-10-29T12:30:00Z'));await f.schedules.tick(f.router);
    assert.equal(f.store.db.prepare('SELECT body FROM inbox').get()?.body,'delete  /tmp/Test');
  }finally{f.close();}
});

test('a timezone named only in the action cannot alter the reminder zone',async()=>{
  const f=fixture();try{
    f.setDecision({text:'call America/New_York office',zone:'America/New_York'});
    await assert.rejects(f.send('1','Remind me at 6 PM to call America/New_York office'),/time zone explicitly/);
  }finally{f.close();}
});

test('time-only clarification replies are held instead of being sent to a session',async()=>{
  const f=fixture();try{
    f.setDecision({kind:'clarify',question:'What time?'});await f.send('1','Remind me to call the bank');
    assert.equal(f.schedules.shouldHandle(f.router,{id:'wa:2',text:'PM',ownerCommand:true},true),true);
    assert.equal(await f.send('2','PM'),true);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM inbox').get()?.n,0);
    assert.match(String((f.store.db.prepare("SELECT body FROM outbox WHERE source='schedule-reply:wa:2:0'").get() as {body:string}).body),/complete reminder/);
  }finally{f.close();}
});

test('past event reports remain ordinary, while an immediate need at a future time fails closed',async()=>{
  const f=fixture();try{
    for(const [i,text] of ['At 6 PM I saw a production error. Please investigate it.','At 6 PM the server crashed. Please investigate it.'].entries())
      assert.equal(f.schedules.shouldHandle(f.router,{id:`wa:past${i}`,text,ownerCommand:true},true),false);
    for(const [i,text] of ['At 6 PM I need codex to deploy production.','At 6 PM I scheduled codex to deploy production.','At 6 PM I saw an error. At 9 PM ask codex to deploy production.'].entries())
      assert.equal(f.schedules.shouldHandle(f.router,{id:`wa:future${i}`,text,ownerCommand:true},true),true);
  }finally{f.close();}
});

test('model not_schedule cannot send a schedule-shaped request immediately',async()=>{
  const f=fixture();try{
    const {binding}=f.store.register('codex','codex','33333333-3333-4333-8333-333333333333','/tmp/codex');f.store.set('active',binding.id);
    let runs=0;const approvals=new Approvals(f.store),router=new Router(f.store,{run:async()=>{runs++;},stop:()=>{}} as any,approvals);
    router.schedules=new Schedules(f.store,f.secret,async()=>({kind:'not_schedule',action:'none',date:'',time:'',zone:'Asia/Kolkata',repeat:'once',text:'',target:'',question:''}),()=>Date.parse('2026-10-29T12:29:00Z'));
    await router.receive({id:'wa:scheduled',text:'At 6 PM ask codex to deploy production',ownerCommand:true});
    await router.receive({id:'wa:scheduled2',text:'At 6 PM I saw an error. At 9 PM ask codex to deploy production.',ownerCommand:true});
    assert.equal(runs,0);assert.equal(f.store.jobs().length,0);assert.match(String(f.store.db.prepare("SELECT body FROM outbox WHERE source='schedule-reply:wa:scheduled:0'").get()?.body),/Nothing was sent/);
    approvals.cancel();
  }finally{f.close();}
});

test('quoted, forwarded and attachment scheduling requests never execute immediately',async()=>{
  const f=fixture();try{
    const {binding}=f.store.register('codex','codex','33333333-3333-4333-8333-333333333333','/tmp/codex');f.store.set('active',binding.id);
    let runs=0;const approvals=new Approvals(f.store),router=new Router(f.store,{run:async()=>{runs++;},stop:()=>{}} as any,approvals);
    router.schedules=new Schedules(f.store,f.secret,async()=>{throw Error('must not parse');},()=>Date.parse('2026-10-29T12:29:00Z'));
    const text='At 6 PM ask codex to deploy production';
    await router.receive({id:'wa:quoted',text,quotedId:'old-message',ownerCommand:false,ownerIntent:false});
    await router.receive({id:'wa:forwarded',text,ownerCommand:false,ownerIntent:false});
    assert.throws(()=>router.attachmentTarget({id:'wa:photo',text,ownerCommand:false}),/Attachments cannot schedule/);
    assert.equal(runs,0);assert.equal(f.store.jobs().length,0);approvals.cancel();
  }finally{f.close();}
});

test('an action body containing tomorrow does not alter its delivery date',async()=>{
  const f=fixture();try{
    f.setDecision({text:'call the bank tomorrow'});
    await f.send('1','Remind me at 6 PM to call the bank tomorrow');
    assert.equal(f.store.db.prepare('SELECT date FROM schedules').get()?.date,'2026-10-29');
  }finally{f.close();}
});

test('a negative or reminder-only brief request cannot send a brief',async()=>{
  const f=fixture();try{
    f.router.scheduledBrief=async()=>{throw Error('must not run');};f.setDecision({action:'brief',text:''});
    await assert.rejects(f.send('1','Remind me at 6 PM not to send the brief'),/explicitly ask/);
    await assert.rejects(f.send('2','At 6 PM do not send my brief'),/explicitly ask/);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM schedules').get()?.n,0);
  }finally{f.close();}
});

test('the approved weekday 9 morning-brief example means 9 AM',async()=>{
  const f=fixture();try{
    f.router.scheduledBrief=async()=> 'queued';f.setDecision({action:'brief',text:'',repeat:'weekdays',time:'09:00',date:'2026-10-30'});
    await f.send('1','Every weekday at 9 send my brief');
    const row=f.store.db.prepare('SELECT time,repeat,next_at FROM schedules').get();
    assert.equal(row?.time,'09:00');assert.equal(row?.repeat,'weekdays');assert.equal(new Date(Number(row?.next_at)).toISOString(),'2026-10-30T03:30:00.000Z');
  }finally{f.close();}
});

test('a model cannot change stated time, day or recurrence',async()=>{
  const f=fixture();try{
    f.setDecision({date:'2026-10-30',time:'06:00',repeat:'daily'});
    await assert.rejects(f.send('1','Remind me tomorrow at 6 PM to call the bank'),/confirm that time/);
    f.setDecision({time:'18:00',repeat:'daily'});
    await assert.rejects(f.send('2','Remind me tomorrow at 6 PM to call the bank'),/confirm how often/);
    f.setDecision({date:'2026-10-31',repeat:'once'});
    await assert.rejects(f.send('3','Remind me tomorrow at 6 PM to call the bank'),/confirm the date/);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM schedules').get()?.n,0);
  }finally{f.close();}
});

test('an explicit daily repeat cannot be silently changed to a one-off reminder',async()=>{
  const f=fixture();try{
    f.setDecision({repeat:'once'});
    await assert.rejects(f.send('1','Every day at 6 PM remind me to call the bank'),/confirm how often/);
  }finally{f.close();}
});

test('ambiguous and negated schedule times fail closed',async()=>{
  const f=fixture();try{
    await assert.rejects(f.send('1','Remind me at 6 to call the bank'),/AM or PM/);
    await assert.rejects(f.send('2','Do not remind me at 6 PM to call the bank'),/without negation/);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM schedules').get()?.n,0);
  }finally{f.close();}
});

test('brief schedules fail closed until the F1 hook exists',async()=>{
  const f=fixture();try{
    f.setDecision({action:'brief',text:''});await assert.rejects(f.send('1','At 6 PM send my brief'),/not available/);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM schedules').get()?.n,0);
  }finally{f.close();}
});

test('the explicit read-only PR-status example uses the exact configured proxy',async()=>{
  const f=fixture();try{
    const {binding}=f.store.register('proxy','codex','22222222-2222-4222-8222-222222222222','/tmp/proxy');
    (f.router.coordinator as any).master=()=>binding;
    f.setDecision({action:'session',text:'check whether PR 20 is green and tell me',target:''});
    await f.send('1','At 6 PM check whether PR 20 is green and tell me');
    f.setNow(Date.parse('2026-10-29T12:30:00Z'));await f.schedules.tick(f.router);
    const job=f.store.db.prepare('SELECT binding_id,body FROM inbox').get() as {binding_id:string;body:string};
    assert.equal(job.binding_id,binding.id);assert.equal(job.body,'check whether PR 20 is green and tell me');
    assert.match(String(f.store.db.prepare('SELECT body FROM outbox ORDER BY created_at LIMIT 1').get()?.body),/proxy/);
  }finally{f.close();}
});

test('a PR-status request with additional actions cannot silently use the default proxy',async()=>{
  const f=fixture();try{
    const {binding}=f.store.register('proxy','codex','22222222-2222-4222-8222-222222222222','/tmp/proxy');
    (f.router.coordinator as any).master=()=>binding;
    f.setDecision({action:'session',text:'check whether PR 20 is green and tell me and merge it',target:''});
    await assert.rejects(f.send('1','At 6 PM check whether PR 20 is green and tell me and merge it'),/Name the exact connected session/);
  }finally{f.close();}
});

test('ordinary mentions of tomorrow and expired numbered lists do not steal normal routing',async()=>{
  const f=fixture();try{
    const normal={id:'wa:ordinary',text:'Please finish the project tomorrow',ownerCommand:true};
    assert.equal(f.schedules.shouldHandle(f.router,normal,true),false);
    await f.send('1','Remind me at 6 PM to call the bank');await f.send('2','list my reminders');
    f.setNow(Date.parse('2026-10-29T12:40:00Z'));
    assert.equal(f.schedules.shouldHandle(f.router,{id:'wa:cancel',text:'cancel 1',ownerCommand:true},true),false);
    assert.equal(f.schedules.shouldHandle(f.router,{id:'wa:cancel-explicit',text:'cancel reminder 1',ownerCommand:true},true),true);
  }finally{f.close();}
});

test('cancellation during an in-flight brief prevents enqueue and never revives the schedule',async()=>{
  const f=fixture();try{
    let began!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>began=resolve),wait=new Promise<void>(resolve=>release=resolve);
    let delivered=false;
    f.router.scheduledBrief=async(_destination,_owner,_occurrence,canSend)=>{began();await wait;if(canSend?.())delivered=true;return delivered?'queued':'retry';};
    f.setDecision({action:'brief',text:''});await f.send('1','At 6 PM send my brief');
    f.setNow(Date.parse('2026-10-29T12:30:00Z'));const pending=f.schedules.tick(f.router);await started;
    await f.send('2','list my reminders');await f.send('3','cancel 1');release();await pending;
    assert.equal(delivered,false);assert.equal(f.store.db.prepare('SELECT status FROM schedules').get()?.status,'cancelled');
  }finally{f.close();}
});

test('brief retry after crash reuses occurrence ID and relies on the daily idempotency contract',async()=>{
  const f=fixture();try{
    const ids:string[]=[];f.router.scheduledBrief=async(_destination,_owner,occurrence)=>{ids.push(occurrence);return ids.length===1?'retry':'already-queued';};
    f.setDecision({action:'brief',text:''});await f.send('1','At 6 PM send my brief');f.setNow(Date.parse('2026-10-29T12:30:00Z'));
    await f.schedules.tick(f.router);await f.schedules.tick(f.router);await f.schedules.tick(f.router);
    assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);assert.equal(f.store.db.prepare('SELECT status FROM schedules').get()?.status,'done');
  }finally{f.close();}
});

test('a stuck brief hook times out, cannot enqueue late, and does not starve other reminders',async()=>{
  const f=fixture();try{
    let release!:()=>void;const wait=new Promise<void>(resolve=>release=resolve);let lateSend=false;
    f.router.scheduledBrief=async(_destination,_owner,_occurrence,canSend)=>{await wait;lateSend=!!canSend?.();return lateSend?'queued':'retry';};
    f.setDecision({action:'brief',text:''});await f.send('1','At 6 PM send my brief');
    f.setDecision({action:'message',text:'call the bank'});await f.send('2','Remind me at 6 PM to call the bank');
    f.setNow(Date.parse('2026-10-29T12:30:00Z'));
    const bounded=new Schedules(f.store,f.secret,async()=>{throw Error('not called');},()=>Date.parse('2026-10-29T12:30:00Z'),10);
    await bounded.tick(f.router);assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outbox WHERE body LIKE '%Reminder: call the bank%'").get()?.n,1);
    release();await new Promise(resolve=>setImmediate(resolve));assert.equal(lateSend,false);
  }finally{f.close();}
});

// Live, 4 November 2026: "Remind me tomorrow 10am for meta hackathon submission" was refused with
// "Please say remind me at TIME to". The owner's own wording, in any order, is a reminder.
test('natural reminder wording is accepted with the owner text kept exactly', async () => {
  const f = fixture(); try {
    f.setDecision({ text: 'meta hackathon submission', date: '2026-10-30', time: '10:00' });
    await f.send('1', 'Remind me tomorrow 10am for meta hackathon submission');
    f.setDecision({ text: 'call mom', date: '2026-10-30', time: '17:00' });
    await f.send('2', 'remind me to call mom at 5pm');
    const rows = f.store.db.prepare('SELECT text,date,time FROM schedules ORDER BY created_at').all() as { text: string; date: string; time: string }[];
    assert.deepEqual(rows.map(r => [r.text, r.date, r.time]), [['meta hackathon submission', '2026-10-30', '10:00'], ['call mom', '2026-10-30', '17:00']]);
    f.setDecision({ text: 'buy 2 milk', time: '02:00' });
    // With no time the fixed parser hands it to the brain, which asks for one; it never saves 2 o'clock.
    await f.send('3', 'remind me to buy 2 milk').catch(()=>{});
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM schedules WHERE text='buy 2 milk'").get()?.n, 0, 'a bare number inside the reminder is not a time');
    // Sim, 7 Nov 2026: no "to", and a trailing aside.
    f.setDecision({ text: 'school pickup', date: '2026-10-30', time: '15:15' });
    await f.send('4', 'Remind me school pickup tomorrow at 3:15pm pls, got to run 🏃');
    assert.equal((f.store.db.prepare("SELECT text FROM schedules WHERE time='15:15'").get() as { text: string } | undefined)?.text, 'school pickup');
    // Sim, 7 Nov 2026: a further request after the reminder is not part of its timing.
    f.setDecision({ text: 'pick up the kids from school', date: '2026-10-30', time: '15:20' });
    await f.send('5', 'Remind me at 3:20 PM tomorrow to pick up the kids from school. Then show me my reminders, please.');
    assert.equal((f.store.db.prepare("SELECT text FROM schedules WHERE time='15:20'").get() as { text: string } | undefined)?.text, 'pick up the kids from school');
  } finally { f.close(); }
});

// Live on build 2418: the model handed back the whole sentence as the reminder text.
test('a model that echoes the whole sentence still gets the owner action', async () => {
  const f = fixture(); try {
    f.setDecision({ text: 'Remind me tomorrow 10am for meta hackathon submission', date: '2026-10-30', time: '10:00' });
    await f.send('1', 'Remind me tomorrow 10am for meta hackathon submission');
    assert.equal((f.store.db.prepare('SELECT text FROM schedules').get() as { text: string }).text, 'meta hackathon submission');
  } finally { f.close(); }
});

// Live, 4 November 2026: "Add a reminder for tomorrow 10am for meta hackathon" was refused.
test('asking to add or set a reminder works like remind me', async () => {
  const f = fixture(); try {
    f.setDecision({ text: 'meta hackathon', date: '2026-10-30', time: '10:00' });
    await f.send('1', 'Add a reminder for tomorrow 10am for meta hackathon');
    f.setDecision({ text: 'Add a reminder for tomorrow 10am for meta hackathon', date: '2026-10-30', time: '10:00' });
    await f.send('2', 'Add a reminder for tomorrow 10am for meta hackathon');
    assert.deepEqual((f.store.db.prepare('SELECT text FROM schedules ORDER BY created_at').all() as { text: string }[]).map(r => r.text), ['meta hackathon', 'meta hackathon']);
  } finally { f.close(); }
});

// The brain decides that a message is a reminder and calls these tools; no pattern takes the
// message first ("Add a reminder for tomorrow 10am for meta hackathon" was refused, 4 Nov 2026).
test('brain reminder tools create, list, cancel, and fire like any reminder',async()=>{
  const f=fixture();try{
    const m={id:'wa:b1',text:'ping me tomorrow at 10 about the hackathon'} as any;
    assert.match(f.schedules.brainCreate(f.router,m,{text:'the hackathon',at:'2026-10-30 10:00'}),/^Saved\. I will remind you 30 Oct 2026, 10:00 am: the hackathon\./);
    assert.match(f.schedules.brainCreate(f.router,m,{text:'again',at:'2026-10-30 11:00'}),/already created/);
    assert.match(f.schedules.brainCreate(f.router,{id:'wa:b2'} as any,{text:'x',at:'2026-10-28 10:00'}),/has passed/);
    assert.match(f.schedules.brainCreate(f.router,{id:'wa:b3'} as any,{text:'x',at:'tomorrow'}),/YYYY-MM-DD/);
    const listed=JSON.parse(f.schedules.brainList());
    assert.equal(listed.length,1);assert.equal(listed[0].what,'the hackathon');
    f.setNow(Date.parse('2026-10-30T04:31:00Z'));await f.schedules.tick(f.router);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outbox WHERE body LIKE '%Reminder: the hackathon%'").get()?.n,1);
    assert.match(f.schedules.brainCreate(f.router,{id:'wa:b4'} as any,{text:'stand up',at:'2026-10-31 09:00',repeat:'weekdays'}),/Every weekday at 9:00 am, starting/);
    const id=JSON.parse(f.schedules.brainList())[0].id;
    assert.equal(f.schedules.brainCancel(id),'Cancelled.');
    assert.equal(f.schedules.brainList(),'No active reminders.');
  }finally{f.close();}
});

// "at 6pm ask site to check PR 20" from the brain: the brain picks the session and the time,
// this checks them, and with task reviews on nothing is saved until the owner approves a card.
test('brain-scheduled session work is checked, held for review when reviews are on, and dispatched',async()=>{
  const f=fixture();try{
    const {binding}=f.store.register('site','codex','11111111-1111-4111-8111-111111111111','/tmp/example');f.store.set(`name:${binding.id}`,'Site Repo');
    const m=(id:string)=>({id:`wa:${id}`,text:'at 6pm ask site to check PR 20'}) as any;
    assert.match(await f.schedules.brainScheduleSession(f.router,m('s0'),{sessionId:'nope',text:'check PR 20',at:'2026-10-29 18:00'}),/No session has that id/);
    // Reviews on: the card goes out and nothing is saved yet.
    const c=f.router.contracts as any,real={enabled:c.enabled,preflight:c.preflight,approvedSchedule:c.approvedSchedule};
    let reviewed:any;c.enabled=()=>true;c.preflight=async(_r:any,_m:any,_t:any,schedule:any)=>{reviewed=schedule;return {kind:'handled'};};
    assert.match(await f.schedules.brainScheduleSession(f.router,m('s1'),{sessionId:binding.id,text:'check PR 20',at:'2026-10-29 18:00'}),/review card/);
    assert.equal(reviewed.binding_id,binding.id);assert.equal(reviewed.text,'check PR 20');
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM schedules').get()?.n,0);
    Object.assign(c,real);
    // Reviews off: saved straight away, and the tick sends it to that exact session.
    assert.match(await f.schedules.brainScheduleSession(f.router,m('s2'),{sessionId:binding.id,text:'check PR 20',at:'2026-10-29 18:00'}),/^Saved\. 29 Oct 2026, 6:00 pm \(Asia\/Kolkata\) I will ask Site Repo to: check PR 20\./);
    assert.match(f.schedules.brainList(),/"session":true/);
    f.setNow(Date.parse('2026-10-29T12:30:00Z'));await f.schedules.tick(f.router);
    const job=f.store.db.prepare('SELECT binding_id,body FROM inbox').get() as {binding_id:string;body:string};
    assert.equal(job.binding_id,binding.id);assert.match(job.body,/check PR 20/);
  }finally{f.close();}
});

// Sim, 7 Nov 2026: "What reminders have I got?" was taken as a bad schedule.
test('owners can ask for their reminder list in their own words',async()=>{
  const f=fixture();try{
    for(const [i,t] of ['What reminders have I got?','what reminders do I have','show me my reminders','any reminders today?'].entries()){
      await f.send(`l${i}`,t);assert.doesNotMatch(String((f.store.db.prepare('SELECT body FROM outbox ORDER BY rowid DESC LIMIT 1').get() as {body:string}|undefined)?.body),/could not confirm|resend|^undefined$/i,t);
    }
  }finally{f.close();}
});

// Sim, 7 Nov 2026: a condition with no clock time got "resend the complete reminder".
test('a reminder on a condition with no time is left to the brain',async()=>{
  const f=fixture();try{
    assert.equal(f.schedules.shouldHandle(f.router,{id:'c1',text:'remind me to review #79 when Codex is back',ownerCommand:true} as any,true),false);
  }finally{f.close();}
});

// Sim, 7 Nov 2026: the time sent after a reminder that lacked one completes it.
test('a time sent after a reminder without one completes that reminder',async()=>{
  const f=fixture();try{
    f.setDecision({kind:'clarify'});
    await f.send('1','Remind me about school pickup please');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM schedules').get()?.n,0);
    assert.equal(f.schedules.shouldHandle(f.router,{id:'wa:2',text:'Tomorrow at 3:15 PM, please.',ownerCommand:true} as any,true),true);
    f.setDecision({kind:'create',text:'school pickup',date:'2026-10-30',time:'15:15'});
    await f.send('2','Tomorrow at 3:15 PM, please.');
    assert.equal((f.store.db.prepare('SELECT text FROM schedules').get() as {text:string}|undefined)?.text,'school pickup');
  }finally{f.close();}
});

// Sim, 7 Nov 2026: "at the moment" made a list question look like a new reminder.
test('a reminders question in any wording lists them, and list-plus-cancel goes to the brain',async()=>{
  const f=fixture();try{
    const ask=(t:string)=>f.schedules.shouldHandle(f.router,{id:'wa:9',text:t,ownerCommand:true} as any,true);
    assert.equal(ask('Thanks! What reminders have I got at the moment?'),true);
    assert.equal(ask('can you show me what reminders I have? And cancel the school pickup one at 3:15pm'),false);
    await f.send('1','Thanks! What reminders have I got at the moment?');
    assert.doesNotMatch(String(f.store.db.prepare("SELECT body FROM outbox ORDER BY rowid DESC").get()?.body),/could not confirm/);
  }finally{f.close();}
});
