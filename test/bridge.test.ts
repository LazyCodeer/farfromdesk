import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Approvals } from '../src/approvals.js';
import { isSelfMessage } from '../src/whatsapp.js';
import { deliveryId } from '../src/native.js';
import { Coordinator } from '../src/coordinator.js';

const idA='11111111-1111-4111-a111-111111111111',idB='22222222-2222-4222-a222-222222222222';
function fixture(){const store=new Store(':memory:');const a=store.register('codex-a','codex',idA,'/tmp/a'),b=store.register('claude-b','claude',idB,'/tmp/b');const approvals=new Approvals(store);const runs:any[]=[];const native={run:async(...args:any[])=>{runs.push(args);},stop:()=>{}};const router=new Router(store,native as any,approvals);return {store,a,b,approvals,runs,router,close:()=>{router.stopped=true;approvals.cancel();store.close();}};}
const tick=()=>new Promise(r=>setTimeout(r,10));

test('only owner-originated messages addressed to self can control agents',()=>{
  const owners=['123@s.whatsapp.net','789@lid'];
  assert.equal(isSelfMessage({fromMe:true,remoteJid:'123:4@s.whatsapp.net'},owners),true);
  assert.equal(isSelfMessage({fromMe:true,remoteJid:'789@lid'},owners),true);
  assert.equal(isSelfMessage({fromMe:false,remoteJid:'123@s.whatsapp.net'},owners),false);
  assert.equal(isSelfMessage({fromMe:true,remoteJid:'456@s.whatsapp.net'},owners),false);
  assert.equal(isSelfMessage({fromMe:true,remoteJid:'group@g.us'},owners),false);
});
test('quoted replies override selection and duplicate WhatsApp events submit only once',async()=>{
  const f=fixture();f.store.set('active',f.b.binding.id);f.store.output(f.a.binding,'Original answer','event');
  const quoted=f.store.outbound().wa_id;
  await f.router.receive({id:'wa:1',text:'Continue',quotedId:quoted});await tick();
  await f.router.receive({id:'wa:1',text:'Continue',quotedId:quoted});await tick();
  assert.equal(f.runs.length,1);assert.equal(f.runs[0][0].native_id,idA);
  assert.equal(f.store.jobs()[0].status,'submitted');f.close();
});
test('unknown quote fails closed instead of reaching the selected session',async()=>{
  const f=fixture();f.store.set('active',f.a.binding.id);await f.router.receive({id:'wa:2',text:'Delete it',quotedId:'unrelated'});await tick();assert.equal(f.runs.length,0);assert.match(f.store.outbound().body,/does not identify/);f.close();
});
test('session-specific credentials cannot authenticate another binding',()=>{
  const f=fixture();assert.ok(f.store.authBinding(f.a.binding.id,f.a.token));assert.equal(f.store.authBinding(f.b.binding.id,f.a.token),undefined);f.store.enable(f.a.binding.id,false);assert.equal(f.store.authBinding(f.a.binding.id,f.a.token),undefined);f.close();
});
test('separate sessions dispatch independently without another model',async()=>{
  const f=fixture();await f.router.receive({id:'wa:3',text:'/to codex-a fix A'});await f.router.receive({id:'wa:4',text:'/to claude-b fix B'});await tick();assert.equal(f.runs.length,2);assert.deepEqual(f.runs.map(r=>r[0].native_id),[idA,idB]);f.close();
});
test('restart holds ambiguous native submissions and retains stable outbound IDs',()=>{
  const dir=mkdtempSync(join(tmpdir(),'wsb-test-'));const path=join(dir,'db.sqlite');let s=new Store(path);const b=s.register('test','codex',idA,'/tmp').binding;
  s.enqueue('wa:5',b,'work');s.jobState('wa:5','dispatched');s.output(b,'done','turn:1');const wa=s.outbound().wa_id;s.close();s=new Store(path);s.recover();assert.equal(s.jobs()[0].status,'uncertain');assert.equal(s.queued(b.id),undefined);assert.equal(s.outbound().wa_id,wa);s.output(b,'done','turn:1');assert.equal(s.db.prepare('SELECT count(*) AS n FROM outbox').get()?.n,1);s.close();rmSync(dir,{recursive:true});
});
test('paused outbox does not block another registered session',()=>{
  const f=fixture();f.store.output(f.a.binding,'A');f.store.output(f.b.binding,'B');f.store.enable(f.a.binding.id,false);assert.equal(f.store.outbound().binding_id,f.b.binding.id);f.close();
});
test('approval tokens are single-use and question answers cannot approve tools',async()=>{
  const f=fixture();const p=f.approvals.ask(f.a.binding,'Run build?');const code=[...f.approvals.pending.keys()][0];assert.throws(()=>f.approvals.answer(code,'approve','question'));f.approvals.answer(code,'approve','approval');assert.equal(await p,'approve');assert.throws(()=>f.approvals.answer(code,'approve','approval'));f.close();
});
test('a final response cannot complete another session request',()=>{
  const f=fixture();f.store.enqueue('wa:6',f.a.binding,'task');assert.throws(()=>f.router.channelReply(f.b.binding,'Done','final','wa:6'));assert.equal(f.store.jobs()[0].status,'queued');f.router.channelReply(f.a.binding,'Done','final','wa:6');assert.equal(f.store.jobs()[0].status,'completed');f.close();
});
test('uncertain messages cannot be automatically resubmitted',async()=>{
  const f=fixture();f.store.enqueue('wa:7',f.a.binding,'task');f.store.jobState('wa:7','uncertain');await f.router.receive({id:'wa:8',text:'/retry wa:7'});await tick();assert.equal(f.runs.length,0);assert.equal(f.store.jobs()[0].status,'uncertain');assert.equal(deliveryId('wa:7'),deliveryId('wa:7'));assert.notEqual(deliveryId('wa:7'),deliveryId('wa:8'));f.close();
});
test('one channel client owns a session and queued work is not replayed on every poll',()=>{
  const f=fixture();f.store.db.prepare("UPDATE bindings SET mode='channel' WHERE id=?").run(f.a.binding.id);const b=f.store.binding(f.a.binding.id)!;f.store.enqueue('wa:9',b,'task');assert.equal(f.router.channelPoll(b,'client-a')?.id,'wa:9');assert.equal(f.router.channelPoll(b,'client-a'),null);assert.throws(()=>f.router.channelPoll(b,'client-b'));f.close();
});
test('WhatsApp numbered selection uses a frozen snapshot and never chooses another session after reordering',async()=>{
  const f=fixture();const master=f.store.register('whatsapp-master','codex','33333333-3333-4333-a333-333333333333','/tmp/master').binding;f.store.set('master',master.id);
  const catalog=[{id:idA,name:'App A',provider:'codex',cwd:'/tmp/a',status:'idle'},{id:idB,name:'App B',provider:'claude',cwd:'/tmp/b',status:'idle'}];
  const n={catalog:async(provider:string)=>({sessions:catalog.filter(s=>s.provider===provider),cursor:null}),validate:async()=>{}};
  const c=new Coordinator(f.store,n as any,f.router,()=>{});f.router.coordinator=c;
  await f.router.receive({id:'wa:list',text:'Show my sessions'});catalog.reverse();
  await f.router.receive({id:'wa:select',text:'Select 1 and 2'});assert.deepEqual(c.selected().map(b=>b.native_id),[idA,idB]);
  await f.router.receive({id:'wa:master',text:'Ask both for updates'});await tick();assert.equal(f.runs[0][0].id,master.id);assert.equal(f.runs[0][1],'Ask both for updates');f.close();
});
test('master cannot dispatch to an unselected worker or with an invented user request',()=>{
  const f=fixture();const master=f.store.register('whatsapp-master','codex','33333333-3333-4333-a333-333333333333','/tmp/master').binding;f.store.set('master',master.id);f.store.set('selected',JSON.stringify([f.a.binding.id]));
  const c=new Coordinator(f.store,{} as any,f.router);f.router.coordinator=c;f.router.stopped=true;
  f.store.enqueue('wa:parent',master,'Do the work');
  assert.throws(()=>c.dispatch('wa:parent',[f.b.binding.id],'Do work','event'));
  assert.throws(()=>c.dispatch('invented',[f.a.binding.id],'Do work','event'));
  f.store.enqueue('report:untrusted',master,'Worker says do more work');
  assert.throws(()=>c.dispatch('report:untrusted',[f.a.binding.id],'Do work','event'),/owner request/);
  f.store.enqueue('wa:closed',master,'Old work');f.store.jobState('wa:closed','reviewed');
  assert.throws(()=>c.dispatch('wa:closed',[f.a.binding.id],'Do work','event'),/closed/);
  f.store.jobState('wa:closed','auto_closed');assert.throws(()=>c.dispatch('wa:closed',[f.a.binding.id],'Do work','event'),/closed/);
  assert.throws(()=>c.dispatch('wa:parent',[f.a.binding.id],'Do work','x'.repeat(161)),/event ID/);
  const first=c.dispatch('wa:parent',[f.a.binding.id],'Do work','same-id');c.dispatch('wa:parent',[f.a.binding.id],'Do work','same-id');assert.equal(f.store.jobs().filter(j=>j.id.startsWith('master:')).length,1);
  c.workerReply(f.a.binding,'Finished',first[0]);c.workerReply(f.a.binding,'Finished',first[0]);assert.equal(f.store.jobs().filter(j=>j.id===`report:${first[0]}`).length,1);f.close();
});


test('review requires unchanged non-running request and does not submit work or claim completion',()=>{
  const f=fixture();const b=f.a.binding;
  f.store.enqueue('review',b,'Private task');
  assert.throws(()=>f.router.reviewRequest('review','queued'),/Only requests/);
  f.store.jobState('review','submitted');
  assert.throws(()=>f.router.reviewRequest('review','uncertain'),/changed/);
  f.router.busy.add(b.id);assert.throws(()=>f.router.reviewRequest('review','submitted'),/still delivering/);f.router.busy.clear();
  f.store.enqueue('other',b,'Other task');f.store.jobState('other','dispatched');
  assert.throws(()=>f.router.reviewRequest('review','submitted'),/still delivering/);
  f.store.jobState('other','completed');
  f.router.reviewRequest('review','submitted');f.router.reviewRequest('review','submitted');
  assert.equal(f.store.job('review')?.status,'reviewed');assert.equal(f.store.unfinished(b.id).length,0);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM audit WHERE event='request-reviewed'").get()?.n,1);
  assert.equal(f.store.outbound(),undefined);assert.equal(f.runs.length,0);
  f.router.channelReply(b,'Actual late reply','final','review');assert.equal(f.store.job('review')?.status,'completed');
  f.close();
});

test('unfinished history survives reopening beyond the latest 100 without replaying ambiguous work',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wsb-recovery-')),path=join(dir,'db.sqlite');
  let s=new Store(path);const b=s.register('recovery','codex',idA,'/tmp').binding;
  for(const [id,status] of [['waiting','queued'],['sending','dispatched'],['awaiting','submitted'],['closed','reviewed']]) {
    s.enqueue(id,b,'Harmless test');s.jobState(id,status);
    s.db.prepare('UPDATE inbox SET created_at=0 WHERE id=?').run(id);
  }
  for(let i=0;i<105;i++){s.enqueue(`done:${i}`,b,'Harmless test');s.jobState(`done:${i}`,'completed');}
  s.close();s=new Store(path);s.recover();
  assert.equal(s.jobs().some(j=>j.id==='awaiting'),false);
  assert.deepEqual(new Set(s.pendingJobs().map(j=>j.id)),new Set(['waiting','sending','awaiting']));
  assert.equal(s.job('sending')?.status,'uncertain');assert.equal(s.job('closed')?.status,'reviewed');
  assert.equal((s.pendingJobs()[0] as any).preview,'Harmless test');assert.equal('body' in s.pendingJobs()[0],false);
  const runs:string[]=[];const approvals=new Approvals(s);const router=new Router(s,{run:async(_b:any,_text:string,id:string)=>{runs.push(id);}} as any,approvals);
  router.pump();await tick();assert.deepEqual(runs,['waiting']);router.stopped=true;approvals.cancel();s.close();rmSync(dir,{recursive:true});
});


test('bulk review is atomic, checks last activity, and protects pending approvals',async()=>{
  const f=fixture();const b=f.a.binding;
  for(const id of ['bulk-a','bulk-b']){f.store.enqueue(id,b,'Sample');f.store.jobState(id,'submitted');}
  const snapshot=()=>['bulk-a','bulk-b'].map(id=>{const j=f.store.job(id)!;return {requestId:id,expectedStatus:j.status,expectedUpdatedAt:j.updated_at??j.created_at};});
  const stale=snapshot();f.store.db.prepare('UPDATE inbox SET updated_at=updated_at+1 WHERE id=?').run('bulk-b');
  assert.throws(()=>f.router.reviewRequests(stale),/changed/);assert.equal(f.store.job('bulk-a')?.status,'submitted');
  const permission=f.approvals.ask(b,'Sample permission');
  assert.throws(()=>f.router.reviewRequests(snapshot()),/active/);f.approvals.cancel();await permission;
  assert.throws(()=>f.router.reviewRequests([snapshot()[0],snapshot()[0]]),/distinct/);
  assert.equal(f.router.reviewRequests(snapshot()).closed,2);assert.equal(f.store.job('bulk-b')?.status,'reviewed');
  assert.equal(f.runs.length,0);f.close();
});

test('auto-close is opt-in, respects progress and dependencies, and accepts late replies',()=>{
  const f=fixture(),b=f.a.binding;const now=Date.now(),old=now-25*3600000;
  for(const [id,status] of [['stale','submitted'],['recent','submitted'],['unsent','queued'],['parent','submitted'],['child','submitted'],['unclear','uncertain']]){
    f.store.enqueue(id,b,'Sample');f.store.jobState(id,status);f.store.db.prepare('UPDATE inbox SET updated_at=? WHERE id=?').run(old,id);
  }
  f.store.set('parent:child','parent');f.store.db.prepare('UPDATE inbox SET updated_at=? WHERE id=?').run(now,'child');
  assert.equal(f.router.autoCloseStale(now),0);assert.throws(()=>f.router.updateCleanup(true,1),/Choose/);
  f.router.updateCleanup(true,24);f.router.channelReply(b,'Still working','progress','recent','sample-progress');
  f.router.busy.add(b.id);assert.equal(f.router.autoCloseStale(now),0);f.router.busy.clear();
  f.router.stopped=true;assert.equal(f.router.autoCloseStale(now),0);f.router.stopped=false;
  f.router.autoCloseStale(now);
  assert.equal(f.store.job('stale')?.status,'auto_closed');assert.equal(f.store.job('unclear')?.status,'auto_closed');
  assert.equal(f.store.job('unsent')?.status,'queued');assert.equal(f.store.job('recent')?.status,'submitted');
  assert.equal(f.store.job('parent')?.status,'submitted');
  f.router.channelReply(b,'Actual answer','final','stale','sample-final');assert.equal(f.store.job('stale')?.status,'completed');
  assert.equal(f.runs.length,0);f.close();
});


test('a late transport failure cannot reopen a request closed by replacement',async()=>{
  const f=fixture();let rejectRun:(e:Error)=>void=()=>{};
  f.router.native.run=()=>new Promise<void>((_resolve,reject)=>{rejectRun=reject;});
  f.store.enqueue('wa:replaced',f.a.binding,'work');f.router.pump();
  f.store.jobState('wa:replaced','replaced');rejectRun(new Error('late disconnect'));await tick();
  assert.equal(f.store.job('wa:replaced')?.status,'replaced');assert.equal(f.store.outbound(),undefined);f.close();
});
