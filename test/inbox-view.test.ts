import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { inboxSessions, inboxThread } from '../src/inbox-view.js';

function fixture() {
 const store=new Store(':memory:');store.set('whatsapp-owner','owner');
 const a=store.register('atlas','claude',randomUUID(),'/tmp/atlas').binding;
 const b=store.register('other','codex',randomUUID(),'/tmp/other').binding;
 store.set(`name:${a.id}`,'Same name');store.set(`name:${b.id}`,'Same name');
 return {store,a,b};
}
test('session summaries group exact identities and search older requests and replies',()=>{
 const {store,a,b}=fixture();try{
  store.enqueue('wa:a',a,'first ask');store.enqueue('report:second',a,'Worker report for owner request internal\n\nold report');store.enqueue('wa:b',b,'other chat');
  store.jobState('wa:a','uncertain','Check delivery');
  store.output(a,'rare reply phrase','reply:a','owner',{requestId:'wa:a',kind:'final'});
  const rows=inboxSessions(store).sessions;assert.equal(rows.length,2);assert.equal(rows.find(s=>s.id===a.id)?.requestCount,2);assert.equal(rows.find(s=>s.id===a.id)?.needsReview,1);
  assert.equal(inboxSessions(store,'rare reply phrase').sessions[0].id,a.id);
  assert.equal(inboxSessions(store,'old report').sessions[0].id,a.id);
  assert.equal(JSON.stringify(rows).includes('token_hash'),false);
 }finally{store.db.close();}
});
test('thread contains real owner, worker, progress and final messages only for the exact session and destination',()=>{
 const {store,a,b}=fixture();try{
  store.enqueue('wa:a',a,'full original text');store.enqueue('report:worker',a,'worker body');store.enqueue('wa:b',b,'private other session');
  store.output(a,'working','p','owner',{requestId:'wa:a',kind:'progress'});store.output(a,'finished','f','owner',{requestId:'wa:a',kind:'final'});
  store.output(a,'wrong destination','wrong','different',{requestId:'wa:a',kind:'system'});
  store.db.prepare("INSERT INTO audio_inbox VALUES(?,?,?,?)").run('wa:a','owner','done',Date.now());
  const result=inboxThread(store,a.id);assert.equal(result.messages.length,4);
  assert.equal(result.messages.find(m=>m.kind==='owner')?.voice,1);assert.ok(result.messages.some(m=>m.kind==='worker-report'));assert.ok(result.messages.some(m=>m.kind==='progress'));assert.ok(result.messages.some(m=>m.kind==='final'));
  assert.ok(!JSON.stringify(result).includes('private other'));assert.ok(!JSON.stringify(result).includes('wrong destination'));
  assert.throws(()=>inboxThread(store,'atlas'),/Unknown session/);
 }finally{store.db.close();}
});
test('equal-timestamp pages are complete without repeats and preserve request identities',()=>{
 const {store,a}=fixture();try{
  for(let n=0;n<135;n++)store.enqueue('wa:'+String(n).padStart(3,'0'),a,'message '+n);
  store.db.exec('UPDATE inbox SET created_at=100,updated_at=100');
  const first=inboxThread(store,a.id);assert.equal(first.messages.length,100);assert.ok(first.next);
  const second=inboxThread(store,a.id,String(first.next.at),first.next.id);assert.equal(second.messages.length,35);assert.equal(second.next,null);
  assert.equal(new Set([...first.messages,...second.messages].map(m=>m.key)).size,135);
  assert.throws(()=>inboxThread(store,a.id,'NaN','x'),/Invalid/);
 }finally{store.db.close();}
});
test('unrouted failed voice notes remain unassigned and delivery errors appear in Attention',()=>{
 const {store,a}=fixture();try{
  store.db.prepare('INSERT INTO audio_inbox VALUES(?,?,?,?)').run('wa:voice','owner','failed',100);
  store.output(undefined,'No speech found','audio-error:wa:voice','owner');
  const orphan=inboxThread(store,'unassigned-voice');assert.equal(orphan.messages.length,1);assert.equal(orphan.messages[0].kind,'voice-failed');assert.match(orphan.messages[0].text,/No speech found/);assert.equal(orphan.jobs.length,0);
  assert.equal(inboxThread(store,a.id).messages.length,0);
  store.enqueue('wa:a',a,'ask');store.output(a,'reply','response','owner',{requestId:'wa:a',kind:'final'});store.db.exec("UPDATE outbox SET status='failed',error='send failed' WHERE source='response:0'");
  assert.equal(inboxSessions(store).attention.length,1);
  assert.ok(inboxSessions(store).sessions.some(s=>s.id==='unassigned-voice'));
 }finally{store.db.close();}
});

test('session search never matches an unrelated destination reply and reviewed blocked jobs do not count as needs review',()=>{
 const {store,a}=fixture();try{
  store.enqueue('wa:a',a,'normal ask');store.jobState('wa:a','completed',null,'blocked');
  assert.equal(inboxSessions(store).sessions[0].needsReview,1);
  store.jobState('wa:a','reviewed');
  assert.equal(inboxSessions(store).sessions[0].needsReview,0);
  assert.equal(inboxSessions(store).sessions[0].closed,1);
  store.output(a,'wrong destination needle','wrong','other-chat',{requestId:'wa:a',kind:'system'});
  assert.equal(inboxSessions(store,'wrong destination needle').sessions.length,0);
 }finally{store.db.close();}
});
test('same-millisecond owner request precedes replies and summary chooses the final reply deterministically',()=>{
 const {store,a}=fixture();try{
  store.enqueue('wa:a',a,'owner ask');store.output(a,'answer','reply','owner',{requestId:'wa:a',kind:'final'});
  store.db.exec('UPDATE inbox SET created_at=100,updated_at=100; UPDATE outbox SET created_at=100');
  const result=inboxThread(store,a.id);
  assert.equal(result.messages[0].kind,'owner');assert.equal(result.messages[1].kind,'final');
  assert.match(inboxSessions(store).sessions[0].preview,/answer/);
 }finally{store.db.close();}
});
test('Telegram and route-failed audio responses are shown without guessing an unrecorded target',()=>{
 const {store,a}=fixture();try{
  store.db.prepare('INSERT INTO audio_inbox VALUES(?,?,?,?)').run('wa:orphan','owner','failed',100);
  store.output(undefined,'Telegram download failed','telegram-media-error:wa:orphan','owner');
  assert.match(inboxThread(store,'unassigned-voice').messages[0].text,/Telegram download failed/);
  assert.equal(inboxSessions(store,'Telegram download failed').sessions[0].id,'unassigned-voice');
  store.enqueue('wa:linked',a,'voice transcript');
  store.db.prepare('INSERT INTO audio_inbox VALUES(?,?,?,?)').run('wa:linked','owner','routing_blocked',100);
  store.output(undefined,'Routing could not finish','audio-route:wa:linked','owner');
  store.output(undefined,'Not this chat','audio-error:wa:linked','other-chat');
  const result=inboxThread(store,a.id);assert.equal(result.messages.length,2);
  assert.match(result.messages.find(m=>m.kind==='voice-failed')?.text,/Routing could not finish/);
  assert.equal(inboxSessions(store,'Routing could not finish').sessions[0].id,a.id);
  assert.equal(inboxThread(store,'unassigned-voice').messages.length,1);
  assert.ok(!JSON.stringify(result).includes('Not this chat'));
 }finally{store.db.close();}
});
test('replies without an exact request correlation do not get inferred from the session',()=>{
 const {store,a}=fixture();try{
  store.enqueue('wa:a',a,'original');store.output(a,'uncorrelated saved response','legacy','owner');
  assert.equal(inboxThread(store,a.id).messages.length,1);
 }finally{store.db.close();}
});

test('Attention retains more than 100 unresolved deliveries and drops reviewed or retired requests',()=>{
 const {store,a}=fixture();try{
  for(let n=0;n<105;n++) {
   const id='wa:delivery-'+n;
   store.enqueue(id,a,'request '+n);store.output(a,'reply '+n,'delivery-'+n,'owner',{requestId:id,kind:'final'});
  }
  store.db.exec("UPDATE outbox SET status='uncertain',error='Could not confirm delivery'");
  assert.equal(inboxSessions(store).attention.length,105);
  store.jobState('wa:delivery-0','reviewed');store.jobState('wa:delivery-1','replaced');store.jobState('wa:delivery-2','auto_closed');
  const attention=inboxSessions(store).attention as {requestId:string}[];
  assert.equal(attention.length,102);
  for(const n of [0,1,2])assert.equal(attention.some(r=>r.requestId==='wa:delivery-'+n),false);
 }finally{store.db.close();}
});
