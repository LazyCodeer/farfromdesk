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
  const attention=inboxSessions(store).attention as {id:string}[];
  assert.equal(attention.filter(r=>r.id.startsWith('delivery:')).length,1);
  assert.equal(attention.filter(r=>r.id==='voice:wa:voice').length,1);
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


test('Attention includes older failed voices past latest-50 cap and safely deduplicates current rows',()=>{
 const {store,a,b}=fixture();try {
  const insert=store.db.prepare('INSERT INTO audio_inbox VALUES(?,?,?,?)');
  insert.run('wa:old-unassigned','owner','failed',1);
  store.enqueue('wa:old-linked',a,'a voice transcript','owner');
  insert.run('wa:old-linked','owner','routing_blocked',2);
  store.enqueue('wa:reviewed',a,'already handled','owner');store.jobState('wa:reviewed','reviewed');
  insert.run('wa:reviewed','owner','failed',3);
  store.enqueue('wa:answered',a,'already answered','owner');store.jobState('wa:answered','completed',null,'done');
  insert.run('wa:answered','owner','interrupted',4);
  // Wrong-destination same-ID data is never attributed to the other session.
  store.enqueue('wa:different',b,'other chat','different-owner');
  insert.run('wa:different','owner','failed',5);
  for(let n=0;n<55;n++)insert.run('wa:ok-'+n,'owner','processed',100+n);
  insert.run('wa:recent','owner','interrupted',999);
  const current=(store.voiceRequests() as {id:string;status:string;created_at:number}[]).filter(v=>['failed','routing_blocked','interrupted'].includes(v.status));
  assert.deepEqual(current.map(v=>v.id),['wa:recent']); // old failures hidden by the status endpoint's 50-row window
  const result=inboxSessions(store).attention as {id:string;requestId:string;bindingId:string;at:number;text:string;title:string}[];
  const frontendRows=[...current.map(v=>({id:'voice:'+v.id})),...result];
  const deduped=new Map(frontendRows.map(row=>[row.id,row]));
  const voiceRows=[...deduped.values()].filter(v=>v.id.startsWith('voice:')) as typeof result;
  assert.deepEqual(voiceRows.map(v=>v.id).sort(),['voice:wa:different','voice:wa:old-linked','voice:wa:old-unassigned','voice:wa:recent']);
  const orphan=voiceRows.find(v=>v.id==='voice:wa:old-unassigned')!;
  assert.equal(orphan.bindingId,'unassigned-voice');assert.equal(orphan.requestId,'wa:old-unassigned');assert.equal(orphan.at,1);
  const linked=voiceRows.find(v=>v.id==='voice:wa:old-linked')!;
  assert.equal(linked.bindingId,a.id);assert.equal(linked.requestId,'wa:old-linked');assert.equal(linked.at,2);
  assert.equal(voiceRows.find(v=>v.id==='voice:wa:different')!.bindingId,'unassigned-voice');
  assert.ok(inboxThread(store,'unassigned-voice').messages.some(m=>m.requestId==='wa:different'));
  assert.ok(!inboxThread(store,b.id).messages.some(m=>m.kind==='voice-failed'));
  assert.equal(voiceRows.filter(v=>v.id==='voice:wa:recent').length,1);
  assert.match(linked.title,/routing blocked/i);assert.doesNotMatch(JSON.stringify(voiceRows),/a voice transcript|other chat/);
 }finally{store.db.close();}
});


test('different-destination same-ID voice remains unassigned without mislabelling or leaking the other request',()=>{
 const {store,b}=fixture();try {
  store.enqueue('wa:collision',b,'other account private request','other-owner');
  store.db.prepare('INSERT INTO audio_inbox VALUES(?,?,?,?)').run('wa:collision','owner','failed',111);
  store.output(undefined,'Voice could not be decoded','audio-error:wa:collision','owner');
  const summary=inboxSessions(store);
  assert.equal(summary.sessions.filter(s=>s.id==='unassigned-voice').length,1);
  assert.ok(inboxSessions(store,'Voice could not be decoded').sessions.some(s=>s.id==='unassigned-voice'));
  const row=(summary.attention as {id:string;bindingId:string}[]).find(r=>r.id==='voice:wa:collision');
  assert.equal(row?.bindingId,'unassigned-voice');
  const orphan=inboxThread(store,'unassigned-voice');assert.equal(orphan.messages.length,1);assert.match(orphan.messages[0].text,/Voice could not be decoded/);
  assert.equal(orphan.jobs.length,0);assert.ok(!JSON.stringify(orphan).includes('other account private request'));
  const other=inboxThread(store,b.id);assert.equal(other.messages.length,1);assert.equal(other.messages[0].voice,0);
  assert.ok(!JSON.stringify(other).includes('Voice could not be decoded'));
 }finally{store.db.close();}
});
