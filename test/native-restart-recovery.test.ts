import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';

function fixture() {
 const store=new Store(':memory:');
 const b=store.register('test-session','claude',randomUUID(),'/tmp').binding;
 store.enqueue('tg:123:456',b,'Synthetic message','tg:owner:private');
 store.jobState('tg:123:456','dispatched');
 store.output(undefined,'Opening the session.', 'native-opening:tg:123:456','tg:owner:private',{requestId:'tg:123:456',kind:'system',origin:'system'});
 return {store,b};
}

test('restart during readiness queues one cautious notice to the original chat',()=>{
 const {store}=fixture();try {
  store.set('telegram-owner','tg:another-owner');
  store.recover();store.recover();
  assert.equal(store.job('tg:123:456')?.status,'uncertain');
  assert.equal(store.db.prepare("SELECT status FROM outbox WHERE source='native-opening:tg:123:456:0'").get()!.status,'cancelled');
  const rows=store.db.prepare("SELECT destination,request_id,body FROM outbox WHERE source='native-restart:tg:123:456:0'").all() as any[];
  assert.equal(rows.length,1);assert.equal(rows[0].destination,'tg:owner:private');assert.equal(rows[0].request_id,'tg:123:456');
  assert.match(rows[0].body,/delivery outcome was recorded/);assert.match(rows[0].body,/Check this exact session before sending/);
  assert.doesNotMatch(rows[0].body,/no task was sent|please resend/i);
 }finally{store.db.close();}
});

test('an opening receipt cannot prove the helper has not submitted',()=>{
 const {store,b}=fixture();try {
  // The helper may have delivered while the router still awaits completion;
  // neither the opening receipt nor an absent submitted_at resolves that gap.
  store.audit('native-submitted',b.id,'synthetic-delivery-id');
  assert.equal(store.job('tg:123:456')?.status,'dispatched');
  assert.equal(store.job('tg:123:456')?.submitted_at,null);
  store.recover();
  const row=store.db.prepare("SELECT body FROM outbox WHERE source='native-restart:tg:123:456:0'").get() as any;
  assert.match(row.body,/delivery outcome was recorded/);assert.doesNotMatch(row.body,/no task was sent|please resend/i);
 }finally{store.db.close();}
});

test('notice and uncertain transition roll back together on a recovery error',()=>{
 const {store}=fixture();try {
  const original=store.output.bind(store);
  store.output=((...args:Parameters<Store['output']>)=>{
   if(args[2]==='native-restart:tg:123:456')throw new Error('synthetic failure');
   return original(...args);
  }) as Store['output'];
  assert.throws(()=>store.recover(),/synthetic failure/);
  assert.equal(store.job('tg:123:456')?.status,'dispatched');
  assert.equal(store.db.prepare("SELECT status FROM outbox WHERE source='native-opening:tg:123:456:0'").get()!.status,'queued');
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM outbox WHERE source='native-restart:tg:123:456:0'").get()!.n,0);
  store.output=original;store.recover();
  assert.equal(store.job('tg:123:456')?.status,'uncertain');
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM outbox WHERE source='native-restart:tg:123:456:0'").get()!.n,1);
 }finally{store.db.close();}
});

test('other dispatched messages do not get an opening recovery notice',()=>{
 const {store,b}=fixture();try {
  store.enqueue('tg:other',b,'Other message','tg:owner:private');store.jobState('tg:other','dispatched');
  store.recover();
  assert.equal(store.job('tg:other')?.status,'uncertain');
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM outbox WHERE source='native-restart:tg:other:0'").get()!.n,0);
 }finally{store.db.close();}
});


test('already sent and interrupted opening notices are not rewritten',()=>{
 for(const initial of ['sent','uncertain']) {
  const {store}=fixture();try {
   store.db.prepare("UPDATE outbox SET status=? WHERE source='native-opening:tg:123:456:0'").run(initial);
   store.recover();
   assert.equal(store.db.prepare("SELECT status FROM outbox WHERE source='native-opening:tg:123:456:0'").get()!.status,initial);
   assert.equal(store.db.prepare("SELECT count(*) AS n FROM outbox WHERE source='native-restart:tg:123:456:0'").get()!.n,1);
  }finally{store.db.close();}
 }
});

test('completed requests do not get a restart notice or stale queued opening promise',()=>{
 const {store}=fixture();try {
  store.jobState('tg:123:456','completed');store.recover();store.recover();
  assert.equal(store.job('tg:123:456')?.status,'completed');
  assert.equal(store.db.prepare("SELECT status FROM outbox WHERE source='native-opening:tg:123:456:0'").get()!.status,'cancelled');
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM outbox WHERE source='native-restart:tg:123:456:0'").get()!.n,0);
 }finally{store.db.close();}
});
