import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {Router} from '../src/router.js';
import {Coordinator} from '../src/coordinator.js';
import {Approvals} from '../src/approvals.js';
import {initializeCoordinatorUpdates,queueCoordinatorUpdates,COORDINATOR_UPDATE_INTERVAL_MS as interval} from '../src/coordinator-updates.js';
function fixture(file=':memory:') {
 const store=new Store(file),approvals=new Approvals(store),native={run:async()=>{},stop:()=>{}} as any,router=new Router(store,native,approvals);router.coordinator=new Coordinator(store,native,router,()=>{});
 const master=store.register('master','codex','11111111-1111-4111-a111-111111111111','/tmp/m','channel').binding;
 const worker=store.register('worker','claude','22222222-2222-4222-a222-222222222222','/tmp/w','channel').binding;
 store.set('master',master.id);store.set('name:'+master.id,'My assistant');store.set('name:'+worker.id,'Checkout review');store.set('whatsapp-owner','owner@s.whatsapp.net');
 const now=Date.now();initializeCoordinatorUpdates(store,now);
 const add=(id:string,destination='owner@s.whatsapp.net',child=false)=>{
  store.enqueue(id,master,'PRIVATE REQUEST CONTENT',destination);store.jobState(id,'submitted');store.db.prepare('UPDATE inbox SET created_at=?,updated_at=? WHERE id=?').run(now+1,now+1,id);
  if(child){store.enqueue('child:'+id,worker,'PRIVATE CHILD CONTENT',destination);store.set('parent:child:'+id,id);store.jobState('child:'+id,'submitted');store.db.prepare('UPDATE inbox SET created_at=?,updated_at=? WHERE id=?').run(now+1,now+1,'child:'+id);}
 };
 return {store,router,master,worker,now,add,close:()=>{approvals.cancel();store.close();}};
}
const markSent=(s:Store,row:any,time:number)=>{s.sent(row.id);assert.equal(s.db.prepare('UPDATE outbox SET sent_at=? WHERE id=?').run(time,row.id).changes,1);};
test('many requests produce one concise summary, preserve state and never repeat unchanged waiting',()=>{
 const f=fixture();try{
  for(let i=0;i<12;i++)f.add('wa:'+i,'owner@s.whatsapp.net',true);
  assert.equal(queueCoordinatorUpdates(f.store,f.router,f.now+interval-1),0);
  assert.equal(queueCoordinatorUpdates(f.store,f.router,f.now+interval+1),1);
  const out=f.store.outbound();assert.ok(out);assert.match(out.body,/Checkout review: 12 waiting for a reply/);assert.doesNotMatch(out.body,/PRIVATE|The user wrote|Request:/);assert.equal(out.reply_kind,'system');assert.equal(out.request_id,null);assert.equal(out.destination,'owner@s.whatsapp.net');
  assert.equal(f.store.job('wa:0')?.first_reply_at,null);assert.equal(f.store.job('wa:0')?.status,'submitted');
  assert.equal(queueCoordinatorUpdates(f.store,f.router,f.now+2*interval),0);markSent(f.store,out,f.now+interval+1);
  assert.equal(queueCoordinatorUpdates(f.store,f.router,f.now+10*interval),0);
 }finally{f.close();}
});
test('upgrade excludes old requests, completed/blocked children and uncertain stand-alone work',()=>{
 const f=fixture();try{
  f.add('wa:old');f.store.db.prepare('UPDATE inbox SET created_at=? WHERE id=?').run(f.now-10000,'wa:old');
  f.add('wa:finished','owner@s.whatsapp.net',true);f.store.jobState('child:wa:finished','completed');
  f.add('wa:failed','owner@s.whatsapp.net',true);f.store.jobState('child:wa:failed','uncertain');
  f.add('wa:uncertain');f.store.jobState('wa:uncertain','failed');
  assert.equal(queueCoordinatorUpdates(f.store,f.router,f.now+20*interval),0);assert.equal(f.store.jobs().length,6);
 }finally{f.close();}
});
test('one destination-wide interval covers new requests and newer real replies',()=>{
 const f=fixture();try{
  f.add('wa:one');queueCoordinatorUpdates(f.store,f.router,f.now+interval+1);const out=f.store.outbound();markSent(f.store,out,f.now+interval+1);
  f.add('wa:two');assert.equal(queueCoordinatorUpdates(f.store,f.router,f.now+interval+100),0);
  f.store.output(f.master,'A meaningful update','real-update','owner@s.whatsapp.net',{requestId:'wa:two',kind:'progress',origin:'agent'});const reply=f.store.outbound();markSent(f.store,reply,f.now+2*interval);
  assert.equal(queueCoordinatorUpdates(f.store,f.router,f.now+2*interval+100),0);
  assert.equal(queueCoordinatorUpdates(f.store,f.router,f.now+3*interval+1),1);
 }finally{f.close();}
});
test('completion, new replies, paused bindings and replaced master cancel unsent summaries',()=>{
 for(const mode of ['completed','reply','paused','replaced']){
  const f=fixture();try{
   f.add('wa:one');queueCoordinatorUpdates(f.store,f.router,f.now+interval+1);const out=f.store.outbound();
   if(mode==='completed')f.store.jobState('wa:one','completed');
   if(mode==='reply')f.store.output(f.master,'New findings','new-update','owner@s.whatsapp.net',{requestId:'wa:one',kind:'progress',origin:'agent'});
   if(mode==='paused')f.store.enable(f.master.id,false);
   if(mode==='replaced')f.store.set('master',f.worker.id);
   assert.notEqual(f.store.outbound()?.id,out.id);assert.equal(f.store.db.prepare('SELECT status FROM outbox WHERE id=?').get(out.id)?.status,'cancelled');
  }finally{f.close();}
 }
});
test('restart retains enrollment watermark and sent-state dedup without waking native work',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ffd-summary-')),file=join(dir,'db.sqlite'),f=fixture(file);let store:Store|undefined;
 try{
  f.add('wa:one');queueCoordinatorUpdates(f.store,f.router,f.now+interval+1);markSent(f.store,f.store.outbound(),f.now+interval+1);f.store.close();
  store=new Store(file);const router=new Router(store,{run:async()=>{throw new Error('Must not run');}} as any,f.router.approvals);router.coordinator=new Coordinator(store,{} as any,router,()=>{});initializeCoordinatorUpdates(store,f.now+3*interval);
  assert.equal(Number(store.get('coordinator-summary-since')),f.now);assert.equal(queueCoordinatorUpdates(store,router,f.now+4*interval),0);
 }finally{f.router.approvals.cancel();store?.close();rmSync(dir,{recursive:true,force:true});}
});
test('different destinations stay separate, pause holds and legacy reminder backlog is retired',()=>{
 const f=fixture();try{
  f.add('wa:self');f.add('wa:group','approved@g.us');f.store.output(f.master,'Obsolete','coordinator-progress:legacy','owner@s.whatsapp.net',{kind:'system'});
  initializeCoordinatorUpdates(f.store);assert.equal(f.store.outbound(),undefined);
  f.router.stopped=true;assert.equal(queueCoordinatorUpdates(f.store,f.router,f.now+interval+1),0);f.router.stopped=false;
  assert.equal(queueCoordinatorUpdates(f.store,f.router,f.now+interval+1),2);
  const rows=f.store.db.prepare("SELECT destination,body FROM outbox WHERE status='queued'").all();assert.equal(rows.length,2);assert.deepEqual(new Set(rows.map(r=>r.destination)),new Set(['owner@s.whatsapp.net','approved@g.us']));
  f.store.set('coordinator-updates-enabled','false');assert.equal(f.store.outbound(),undefined);
 }finally{f.close();}
});
test('worker progress is still reported immediately with no duplicate report',()=>{
 const f=fixture();try{
  f.add('wa:one','owner@s.whatsapp.net',true);
  f.router.channelReply(f.worker,'Testing the fix','progress','child:wa:one','event');f.router.channelReply(f.worker,'Testing the fix','progress','child:wa:one','event');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM inbox WHERE id LIKE 'report:%'").get()?.n,1);assert.match(f.store.outbound().body,/Testing the fix/);
 }finally{f.close();}
});
