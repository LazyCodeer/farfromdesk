import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { inboxFeed, inboxSessions } from '../src/inbox-view.js';

function fixture() {
 const store=new Store(':memory:');store.set('whatsapp-owner','owner');
 const a=store.register('atlas','claude',randomUUID(),'/tmp/atlas').binding;
 const b=store.register('other','codex',randomUUID(),'/tmp/other').binding;
 store.set(`name:${a.id}`,'Atlas desk');store.set(`name:${b.id}`,'Other desk');
 return {store,a,b};
}

test('unified feed mixes owner, coordinator, brain and command rows in one chronologic stream',()=>{
 const {store,a}=fixture();try{
  store.enqueue('wa:ask',a,'first ask');
  store.db.prepare('INSERT INTO audio_inbox VALUES(?,?,?,?)').run('wa:ask','owner','processed',10);
  store.linkItem('wa:ask',7);
  store.output(a,'working','p','owner',{requestId:'wa:ask',kind:'progress'});
  store.output(a,'finished','f','owner',{requestId:'wa:ask',kind:'final'});
  store.enqueue('report:w',a,'Worker report body');
  store.output(undefined,'brain routing reply','brain:wa:ask','owner');
  store.output(undefined,'memory saved','brain-memory:m1','owner');
  store.output(undefined,'command answer','command:cmd1','owner',{plain:true});
  store.db.exec('UPDATE inbox SET created_at=100,updated_at=100; UPDATE outbox SET created_at=200');
  const feed=inboxFeed(store);
  const ats=feed.messages.map(m=>m.at);assert.deepEqual(ats,[...ats].sort((x,y)=>x-y));

  const owner=feed.messages.find(m=>m.source==='you')!;
  assert.equal(owner.kind,'voice');assert.deepEqual(owner.voice,{durationMs:null});
  assert.equal(owner.kindLabel,null);assert.equal(owner.provider,null);assert.equal(owner.itemRef,7);
  assert.equal(owner.channel,'whatsapp');assert.equal(owner.requestId,'wa:ask');assert.equal(owner.sessionName,'Atlas desk');
  assert.equal(feed.messages.filter(m=>m.source==='you').length,1);

  const progress=feed.messages.find(m=>m.kindLabel==='Progress')!;
  assert.equal(progress.source,'coordinator');assert.equal(progress.provider,'claude');assert.equal(progress.kind,'working');
  assert.equal(progress.requestId,'wa:ask');assert.equal(progress.itemRef,7);assert.equal(progress.delivery?.state,'queued');

  const final=feed.messages.find(m=>m.kindLabel==='Final')!;
  assert.equal(final.source,'coordinator');assert.equal(final.kind,'final');assert.equal(final.bindingId,a.id);

  const report=feed.messages.find(m=>m.kindLabel==='Worker report')!;
  assert.equal(report.source,'coordinator');assert.equal(report.provider,'claude');assert.equal(report.bindingId,a.id);
  assert.equal(report.sessionName,'Atlas desk');

  const brain=feed.messages.find(m=>m.kind==='routing')!;
  assert.equal(brain.source,'brain');assert.equal(brain.kindLabel,'Routing');assert.equal(brain.provider,null);
  assert.equal(brain.bindingId,null);assert.equal(brain.sessionName,null);assert.equal(brain.itemRef,null);
  const memory=feed.messages.find(m=>m.kind==='memory')!;
  assert.equal(memory.source,'brain');assert.equal(memory.kindLabel,'Memory');
  const command=feed.messages.find(m=>m.source==='command')!;
  assert.equal(command.kind,'command');assert.equal(command.kindLabel,null);assert.equal(command.bindingId,null);

  // Keys are the only identity the UI uses; they must not collide across sources.
  assert.equal(new Set(feed.messages.map(m=>m.key)).size,feed.messages.length);
  assert.equal(feed.stats.total,feed.messages.length);
  assert.equal(feed.next,null);
  assert.equal(inboxFeed(store).view.id,'all');
 }finally{store.db.close();}
});

test('feed follows the control channel destination and labels its channel',()=>{
 const {store,a}=fixture();try{
  store.set('control-channel','telegram');store.set('telegram-owner','tg:owner');
  store.enqueue('wa:tg',a,'telegram ask','tg:owner');
  store.output(a,'telegram reply','r','tg:owner',{requestId:'wa:tg',kind:'final'});
  const feed=inboxFeed(store);
  assert.equal(feed.messages.length,2);
  for(const message of feed.messages)assert.equal(message.channel,'telegram');
  store.enqueue('wa:wa',a,'whatsapp ask','owner');
  assert.equal(inboxFeed(store).messages.length,2);
 }finally{store.db.close();}
});

test('delivery state is read from the outbox row, including a failed send',()=>{
 const {store,a}=fixture();try{
  store.enqueue('wa:d',a,'ask');
  store.output(a,'sent reply','s','owner',{requestId:'wa:d',kind:'final'});
  store.output(a,'failed reply','u','owner',{requestId:'wa:d',kind:'final'});
  store.db.exec("UPDATE outbox SET status='sent',sent_at=1000 WHERE source='s:0'");
  store.db.exec("UPDATE outbox SET status='failed',error='send failed' WHERE source='u:0'");
  const feed=inboxFeed(store);
  const sent=feed.messages.find(m=>m.text.includes('sent reply'))!;
  assert.deepEqual(sent.delivery,{state:'sent',at:1000,error:null});
  const failed=feed.messages.find(m=>m.text.includes('failed reply'))!;
  assert.deepEqual(failed.delivery,{state:'failed',at:null,error:'send failed'});
  assert.equal(feed.messages.find(m=>m.source==='you')?.delivery,null);
  store.db.exec("UPDATE outbox SET delivered_at=2000 WHERE source='s:0'");
  assert.deepEqual(inboxFeed(store).messages.find(m=>m.text.includes('sent reply'))?.delivery,{state:'delivered',at:2000,error:null});
 }finally{store.db.close();}
});

test('views start with all and only list groups that actually have messages',()=>{
 const {store,a,b}=fixture();try{
  store.set(`execution-mode:${a.id}`,'desktop');
  store.enqueue('wa:v1',a,'ask one');
  store.output(a,'reply one','r1','owner',{requestId:'wa:v1',kind:'final'});
  store.db.exec("UPDATE outbox SET status='uncertain',error='Could not confirm delivery'");
  const only=inboxFeed(store);
  assert.equal(only.views[0].id,'all');assert.equal(only.views[0].name,'One conversation');assert.equal(only.views[0].kind,'all');
  assert.deepEqual(only.views.map(v=>v.id),['all',a.id,'attention']);
  const coordinator=only.views.find(v=>v.id===a.id)!;
  assert.equal(coordinator.kind,'coordinator');assert.equal(coordinator.name,'Atlas desk');assert.equal(coordinator.provider,'claude');
  assert.equal(coordinator.detail,'Claude · Desktop');
  // The request, its reply and the attention row it produced all belong to this session.
  assert.equal(coordinator.count,3);assert.equal(coordinator.needsYou,1);
  assert.equal(coordinator.preview.length<=160,true);
  assert.equal(only.views.some(v=>v.id==='brain'),false);
  assert.equal(only.views.some(v=>v.id==='commands'),false);
  assert.equal(only.views.some(v=>v.id===b.id),false);
  const attentionView=only.views.find(v=>v.id==='attention')!;
  assert.equal(attentionView.needsYou,1);
  assert.equal(only.stats.needsYou,inboxSessions(store).attention.length);
  assert.equal(only.stats.needsYou,1);
  assert.equal(only.stats.total,only.views[0].count);

  store.output(undefined,'brain brief text','morning-brief:abc','owner',{kind:'system'});
  store.output(undefined,'memory saved','brain-memory:m1','owner');
  store.output(undefined,'Asking desk','brain-ask:m2','owner');
  store.output(undefined,'command answer','command:cmd1','owner',{plain:true});
  const withGroups=inboxFeed(store);
  assert.deepEqual(withGroups.views.map(v=>v.id),['all',a.id,'brain','brain-brief','brain-memory','brain-ask','commands','attention']);
  assert.equal(withGroups.views.find(v=>v.id==='brain-brief')?.name,'Morning brief');
  assert.equal(withGroups.views.find(v=>v.id==='brain-memory')?.name,'Memory');
  assert.equal(withGroups.views.find(v=>v.id==='brain-ask')?.name,'Asks');
  assert.equal(withGroups.views.find(v=>v.id==='brain')?.count,3);
  assert.equal(withGroups.views.find(v=>v.id==='commands')?.count,1);
 }finally{store.db.close();}
});

test('view filtering narrows to one session, Brain, commands or Attention and rejects nonsense',()=>{
 const {store,a,b}=fixture();try{
  store.enqueue('wa:mine',a,'ask a');store.enqueue('wa:theirs',b,'ask b');
  store.output(a,'reply a','ra','owner',{requestId:'wa:mine',kind:'final'});
  store.output(b,'reply b','rb','owner',{requestId:'wa:theirs',kind:'final'});
  store.output(undefined,'brain routing reply','brain:wa:mine','owner');
  store.output(undefined,'memory saved','brain-memory:m1','owner');
  store.output(undefined,'command answer','command:cmd1','owner',{plain:true});
  const all=inboxFeed(store);assert.equal(all.messages.length,7);
  const bySession=inboxFeed(store,{view:a.id});
  assert.equal(bySession.view.id,a.id);
  assert.ok(bySession.messages.every(m=>m.bindingId===a.id));
  assert.ok(!bySession.messages.some(m=>m.text.includes('reply b')));
  assert.equal(bySession.messages.filter(m=>m.bindingId===b.id).length,0);
  assert.ok(bySession.messages.some(m=>m.text.includes('reply a')));
  const byOther=inboxFeed(store,{view:b.alias});
  assert.equal(byOther.view.id,b.id);
  const brain=inboxFeed(store,{view:'brain'});
  assert.ok(brain.messages.length===2);assert.ok(brain.messages.every(m=>m.source==='brain'));
  assert.equal(inboxFeed(store,{view:'brain-memory'}).messages.length,1);
  assert.equal(inboxFeed(store,{view:'brain-brief'}).messages.length,0);
  const commands=inboxFeed(store,{view:'commands'});
  assert.equal(commands.messages.length,1);assert.ok(commands.messages.every(m=>m.source==='command'));
  assert.equal(commands.view.name,'Commands');
  assert.throws(()=>inboxFeed(store,{view:'nonsense'}),/Unknown view\./);
  assert.equal(inboxFeed(store,{view:null}).messages.length,7);
  assert.equal(inboxFeed(store,{view:''}).messages.length,7);
  // Search matches message text and session names only.
  assert.equal(inboxFeed(store,{query:'reply b'}).messages.length,1);
  assert.equal(inboxFeed(store,{query:'Atlas desk'}).messages.length,2);
  assert.equal(inboxFeed(store,{query:'nothing matches this phrase'}).messages.length,0);
  assert.equal(inboxFeed(store,{query:'x'.repeat(400)}).messages.length,0);
  assert.equal(inboxFeed(store,{view:a.id,query:'reply a'}).messages.length,1);
 }finally{store.db.close();}
});

test('equal-timestamp pages are complete without repeats and reject a broken cursor',()=>{
 const {store,a}=fixture();try{
  for(let n=0;n<135;n++)store.enqueue('wa:'+String(n).padStart(3,'0'),a,'message '+n);
  store.db.exec('UPDATE inbox SET created_at=100,updated_at=100');
  const first=inboxFeed(store);
  assert.equal(first.messages.length,100);assert.ok(first.next);assert.equal(first.stats.total,135);
  assert.equal(first.view.count,135);
  const second=inboxFeed(store,{beforeAt:String(first.next.at),beforeKey:first.next.key});
  assert.equal(second.messages.length,35);assert.equal(second.next,null);
  assert.equal(new Set([...first.messages,...second.messages].map(m=>m.key)).size,135);
  assert.equal(first.messages.at(-1)!.at,100);
  assert.deepEqual(first.next,{at:100,key:first.messages[0].key});
  assert.throws(()=>inboxFeed(store,{beforeAt:'NaN',beforeKey:'x'}),/Invalid conversation cursor/);
  assert.throws(()=>inboxFeed(store,{beforeAt:-1}),/Invalid conversation cursor/);
  assert.throws(()=>inboxFeed(store,{beforeAt:100,beforeKey:'x'.repeat(2201)}),/Invalid conversation cursor/);
 }finally{store.db.close();}
});

test('the feed never carries another destination body or a credential column',()=>{
 const {store,a,b}=fixture();try{
  store.enqueue('wa:secret',b,'another owners private words','other-owner');
  store.output(b,'another owners private reply','leak','other-owner',{requestId:'wa:secret',kind:'system'});
  store.db.prepare('INSERT INTO audio_inbox VALUES(?,?,?,?)').run('wa:secret','other-owner','failed',5);
  store.enqueue('wa:mine',a,'my own words');
  store.output(a,'my reply','mine','owner',{requestId:'wa:mine',kind:'final'});
  const feed=inboxFeed(store);
  const json=JSON.stringify(feed);
  assert.equal(json.includes('another owners'),false);
  assert.equal(json.includes('token_hash'),false);
  assert.equal(json.includes('native_id'),false);
  assert.equal(json.includes(store.binding(a.id)!.token_hash),false);
  assert.equal(json.includes(store.binding(b.id)!.token_hash),false);
  assert.ok(json.includes('my own words'));
  assert.equal(feed.messages.length,2);
 }finally{store.db.close();}
});

test('Attention carries a failed delivery and an unrouted failed voice note',()=>{
 const {store,a}=fixture();try{
  store.enqueue('wa:d',a,'ask');
  store.output(a,'reply','r','owner',{requestId:'wa:d',kind:'final'});
  store.db.exec("UPDATE outbox SET status='failed',error='send failed'");
  store.db.prepare('INSERT INTO audio_inbox VALUES(?,?,?,?)').run('wa:orphan','owner','failed',100);
  store.output(undefined,'No speech found','audio-error:wa:orphan','owner');
  const attention=inboxFeed(store,{view:'attention'});
  assert.ok(attention.messages.some(m=>m.key.startsWith('2:attention:delivery:')&&m.text==='send failed'&&m.kind==='attention'&&m.source==='attention'));
  const voice=attention.messages.find(m=>m.key==='2:attention:voice:wa:orphan')!;
  assert.equal(voice.source,'attention');assert.equal(voice.kind,'attention');assert.equal(voice.bindingId,null);
  assert.equal(voice.requestId,'wa:orphan');assert.equal(voice.needsReview,true);
  assert.equal(voice.text,'Open the recorded timing and cause.');
  assert.equal(attention.messages.length,2);
  assert.equal(inboxFeed(store).stats.needsYou,inboxSessions(store).attention.length);
  assert.equal(inboxFeed(store).stats.needsYou,2);
  assert.equal(inboxFeed(store).views.find(v=>v.id==='attention')?.count,2);
 }finally{store.db.close();}
});

test('an app-claimed owner message is marked app and a transported one stays null',()=>{
 const {store,a}=fixture();try{
  // Exactly the record the composer route writes before it calls the router.
  store.claimAppOrigin('app:composed',store.destination()!,'whatsapp',store.get('incoming-owner-generation')??'');
  store.enqueue('app:composed',a,'typed in the app');
  store.enqueue('wa:transported',a,'typed in WhatsApp');
  const feed=inboxFeed(store);
  const app=feed.messages.find(m=>m.requestId==='app:composed')!;
  const transported=feed.messages.find(m=>m.requestId==='wa:transported')!;
  assert.equal(app.source,'you');assert.equal(app.origin,'app');
  assert.equal(transported.source,'you');assert.equal(transported.origin,null);
  assert.equal(feed.messages.filter(m=>m.source==='you').every(m=>m.origin==='app'||m.origin===null),true);
  // An unrelated request id is never marked by another request's claim.
  store.enqueue('wa:other',a,'typed in WhatsApp');
  assert.equal(inboxFeed(store).messages.find(m=>m.requestId==='wa:other')?.origin,null);
 }finally{store.db.close();}
});
test('the chip row is a fixed vocabulary with its own counts and working filters',()=>{
 const {store,a,b}=fixture();try{
  store.enqueue('wa:owner',a,'ask the session');
  store.output(a,'working on it','reply:p','owner',{requestId:'wa:owner',kind:'progress'});
  store.output(a,'done','reply:f','owner',{requestId:'wa:owner',kind:'final'});
  store.output(undefined,'Command answer','command:wa:owner','owner',{plain:true});
  const feed=inboxFeed(store,{});
  // Exactly the six chips, in the order the pane draws them, each with a real count.
  assert.deepEqual(feed.filters.map(f=>f.id),['all','you','coordinators','brain','commands','attention']);
  const byId=Object.fromEntries(feed.filters.map(f=>[f.id,f.count]));
  assert.equal(byId.all,feed.stats.total);
  assert.equal(byId.you,1);
  assert.equal(byId.coordinators,2);
  assert.equal(byId.brain,0);
  assert.equal(byId.commands,1);
  assert.equal(byId.attention,feed.stats.needsYou);
  // A count of zero is reported rather than hidden, because the chip is still drawn.
  assert.equal(feed.views.some(v=>v.id==='brain'),false);
  // Both chip ids filter instead of throwing, and each keeps only its own source.
  const you=inboxFeed(store,{view:'you'});
  assert.equal(you.view.name,'You');
  assert.equal(you.messages.length,1);
  assert.ok(you.messages.every(m=>m.source==='you'));
  const coords=inboxFeed(store,{view:'coordinators'});
  assert.equal(coords.view.name,'Coordinators');
  assert.ok(coords.messages.length>=2);
  assert.ok(coords.messages.every(m=>m.source==='coordinator'));
  assert.equal(coords.messages.some(m=>m.source==='command'),false);
  assert.throws(()=>inboxFeed(store,{view:'nope'}),/Unknown view/);
  void b;
 }finally{store.db.close();}
});
