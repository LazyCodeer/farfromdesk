import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Coordinator } from '../src/coordinator.js';
import { Approvals } from '../src/approvals.js';

const uuid=(n:number)=>`22222222-2222-4222-a222-${String(n).padStart(12,'0')}`;
function fixture() {
  const store=new Store(':memory:'),approvals=new Approvals(store);
  const native={catalog:async()=>({sessions:[],cursor:null}),run:async()=>{},stop:()=>{}};
  const router=new Router(store,native as any,approvals),coordinator=new Coordinator(store,native as any,router,()=>{});
  router.coordinator=coordinator;
  router.livenessProbe=()=>({codex:true,claude:true});
  const master=store.register('master','codex',uuid(1),'/tmp/master','channel').binding;
  store.set('master',master.id);store.set('whatsapp-owner','owner@s.whatsapp.net');
  store.db.prepare("UPDATE bindings SET mode='desktop' WHERE id=?").run(master.id);
  return {store,router,native,master,close:()=>{router.stopped=true;approvals.cancel();store.close();}};
}
const outbox=(store:Store)=>(store.db.prepare('SELECT source,body,reply_kind FROM outbox ORDER BY created_at').all() as {source:string;body:string;reply_kind:string|null}[]);
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test('a request that is accepted but never answered is reported, not left as a promise',async()=>{
  const f=fixture();
  try {
    f.router.silenceNoticeMs=5;f.router.silenceEscalateMs=5;
    await f.router.receive({id:'wa:quiet',text:'Build the report'});
    await wait(40);
    const notices=outbox(f.store).filter(row=>row.source.startsWith('silence:'));
    assert.equal(notices.length,2);
    assert.match(notices[0].body,/has not started this yet/);
    assert.doesNotMatch(notices[0].body,/— FarFromDesk|Session:/);
    assert.match(notices[1].body,/Still no answer/);
    const events=(f.store.db.prepare("SELECT event FROM request_events WHERE event LIKE 'silence_%' ORDER BY id").all() as {event:string}[]).map(row=>row.event);
    assert.deepEqual(events,['silence_notice','silence_escalated']);
  }finally{f.close();}
});

test('an answered request sends no silence notice',async()=>{
  const f=fixture();
  try {
    f.router.silenceNoticeMs=60_000;
    await f.router.receive({id:'wa:answered',text:'Check the build'});
    f.store.output(f.master,'Build is green.','final:wa:answered','owner@s.whatsapp.net',{requestId:'wa:answered',kind:'final',origin:'agent',turnId:'turn-1'});
    await wait(20);
    assert.equal(outbox(f.store).filter(row=>row.source.startsWith('silence:')).length,0);
  }finally{f.close();}
});

test('repeating the same message while it is unanswered does not queue a second request',async()=>{
  const f=fixture();
  try {
    await f.router.receive({id:'wa:first',text:'Hi'});
    console.log('DEBUG rows',JSON.stringify(f.store.db.prepare("SELECT id,body,created_at,status FROM inbox WHERE binding_id=? AND created_at>? AND status IN ('queued','dispatched','submitted')").all(f.master.id,Date.now()-600000)));
    const second=await f.router.receive({id:'wa:second',text:'Hi'});
    assert.equal(second.status,'blocked');
    assert.equal(f.store.job('wa:second'),undefined);
    const notice=outbox(f.store).find(row=>row.source==='command-error:wa:second:0');
    assert.ok(notice);assert.match(notice!.body,/already waiting/);
    assert.doesNotMatch(notice!.body,/— FarFromDesk/);
  }finally{f.close();}
});

test('a request closed without an answer says so instead of vanishing',async()=>{
  const f=fixture();
  try {
    f.store.set('cleanup-enabled','true');f.store.set('cleanup-hours','24');
    await f.router.receive({id:'wa:stale',text:'Long running check'});
    f.store.db.prepare("UPDATE inbox SET status='submitted',updated_at=? WHERE id='wa:stale'").run(Date.now()-25*3600000);
    assert.equal(f.router.autoCloseStale(),1);
    const notice=outbox(f.store).find(row=>row.source==='auto-closed:wa:stale:0');
    assert.ok(notice);assert.match(notice!.body,/never answered this/);
    assert.doesNotMatch(notice!.body,/— FarFromDesk/);
  }finally{f.close();}
});
