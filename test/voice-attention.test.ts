import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';

async function fixture() {
 const [{Store},{inboxSessions,inboxThread},{reviewOrphanVoice}]=await Promise.all([import('../src/store.js'),import('../src/inbox-view.js'),import('../src/voice-attention.js')]);
 const store=new Store(':memory:');const binding=store.register('synthetic','claude',randomUUID(),'/tmp').binding;
 const audio=(id:string,destination:string,status='failed')=>store.db.prepare('INSERT INTO audio_inbox VALUES(?,?,?,?)').run(id,destination,status,100);
 return {store,binding,audio,inboxSessions,inboxThread,reviewOrphanVoice};
}
test('review clears only exact orphan attention while retaining error, voice, seen and thread history',async()=>{
 const f=await fixture();try {
  f.audio('wa:old','chat-a');f.audio('wa:other','chat-b');
  f.store.output(undefined,'Synthetic old voice error','audio-error:wa:old','chat-a');f.store.remember('wa:old');
  const before={audio:f.store.db.prepare('SELECT * FROM audio_inbox WHERE id=?').get('wa:old'),outbox:f.store.db.prepare('SELECT * FROM outbox WHERE source=?').get('audio-error:wa:old:0'),seen:f.store.seen('wa:old')};
  assert.equal(f.inboxSessions(f.store).attention.filter((r:any)=>r.id==='voice:wa:old').length,1);
  assert.deepEqual(f.reviewOrphanVoice(f.store,{audioId:'wa:old',destination:'chat-a',confirmed:true}),{ok:true,alreadyReviewed:false});
  assert.deepEqual(f.reviewOrphanVoice(f.store,{audioId:'wa:old',destination:'chat-a',confirmed:true}),{ok:true,alreadyReviewed:true});
  const after=f.inboxSessions(f.store);assert.equal(after.attention.filter((r:any)=>r.id==='voice:wa:old').length,0);assert.equal(after.attention.filter((r:any)=>r.id==='voice:wa:other').length,1);
  const unassigned=after.sessions.find((r:any)=>r.id==='unassigned-voice');assert.equal(unassigned?.requestCount,2);assert.equal(unassigned?.needsReview,1);
  assert.ok(f.inboxThread(f.store,'unassigned-voice').messages.some((m:any)=>m.requestId==='wa:old'&&m.text.includes('Synthetic old voice error')));
  assert.deepEqual(f.store.db.prepare('SELECT * FROM audio_inbox WHERE id=?').get('wa:old'),before.audio);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM outbox WHERE source=?').get('audio-error:wa:old:0'),before.outbox);assert.equal(f.store.seen('wa:old'),before.seen);
 }finally{f.store.close();}
});
test('review rejects wrong destination, missing confirmation, success and linked requests',async()=>{
 const f=await fixture();try {
  f.audio('wa:failed','chat-a');f.audio('wa:success','chat-a','done');f.audio('wa:linked','chat-a');f.store.enqueue('wa:linked',f.binding,'Bound task','chat-a');
  for(const input of [{audioId:'wa:failed',destination:'chat-b',confirmed:true},{audioId:'wa:failed',destination:'chat-a',confirmed:false},{audioId:'wa:success',destination:'chat-a',confirmed:true},{audioId:'wa:linked',destination:'chat-a',confirmed:true}])assert.throws(()=>f.reviewOrphanVoice(f.store,input));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM voice_attention_reviews').get()!.n,0);
 }finally{f.store.close();}
});
test('same id in another destination is unassigned and never links or reviews the unrelated request',async()=>{
 const f=await fixture();try {
  f.store.enqueue('wa:collision',f.binding,'Secret unrelated request','chat-a');f.audio('wa:collision','chat-b');
  f.store.output(undefined,'Correct voice error from chat B','audio-error:wa:collision','chat-b');
  const attention=f.inboxSessions(f.store).attention.find((r:any)=>r.id==='voice:wa:collision') as any;
  assert.equal(attention.bindingId,'unassigned-voice');assert.equal(attention.canReviewOrphan,1);assert.equal(attention.destination,'chat-b');
  const msg=f.inboxThread(f.store,'unassigned-voice').messages.find((m:any)=>m.requestId==='wa:collision');assert.equal(msg.text.includes('Correct voice error from chat B'),true);assert.equal(msg.text.includes('Secret unrelated'),false);
  assert.throws(()=>f.reviewOrphanVoice(f.store,{audioId:'wa:collision',destination:'chat-a',confirmed:true}));
  f.reviewOrphanVoice(f.store,{audioId:'wa:collision',destination:'chat-b',confirmed:true});assert.equal(f.store.job('wa:collision')?.status,'queued');
 }finally{f.store.close();}
});

test('review survives database reopen without deleting old voice history',async()=>{
 const temp=mkdtempSync(join(tmpdir(),'ffd-voice-persist-'));
 const [{Store},{inboxSessions,inboxThread},{reviewOrphanVoice}]=await Promise.all([import('../src/store.js'),import('../src/inbox-view.js'),import('../src/voice-attention.js')]);
 const file=join(temp,'history.sqlite');let store=new Store(file);
 try {
  store.db.prepare('INSERT INTO audio_inbox VALUES(?,?,?,?)').run('wa:old','chat-a','failed',1);
  reviewOrphanVoice(store,{audioId:'wa:old',destination:'chat-a',confirmed:true});store.close();
  store=new Store(file);assert.equal(inboxSessions(store).attention.length,0);
  assert.equal(inboxThread(store,'unassigned-voice').messages[0].requestId,'wa:old');
  assert.equal(reviewOrphanVoice(store,{audioId:'wa:old',destination:'chat-a',confirmed:true}).alreadyReviewed,true);
 }finally{store.close();rmSync(temp,{recursive:true,force:true});}
});

test('voice review endpoint requires local admin and explicit matching confirmation',async()=>{
 const temp=mkdtempSync(join(tmpdir(),'ffd-voice-review-'));
 const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=(probe.address() as any).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
 process.env.WSB_STATE_DIR=temp;process.env.WSB_PORT=String(port);
 const [{Store},{Router},{Approvals},{serve}]=await Promise.all([import('../src/store.js'),import('../src/router.js'),import('../src/approvals.js'),import('../src/server.js')]);
 const store=new Store(':memory:');const a=store.register('test','claude',randomUUID(),'/tmp');const approvals=new Approvals(store);const router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
 store.db.prepare('INSERT INTO audio_inbox VALUES(?,?,?,?)').run('wa:old','chat-a','failed',100);
 const server=serve(store,router,{status:'not paired'} as any,'synthetic-admin',{macControl:{view:()=>({}),stop:()=>{}},desktopControl:{view:()=>({}),stop:()=>{}},masters:{options:()=>({}),platformPreferences:()=>[]},power:{view:()=>({})}} as any);
 await new Promise<void>(resolve=>server.once('listening',resolve));
 try {
  const send=(body:any,token?:string,id?:string)=>fetch(`http://127.0.0.1:${port}/api/voice-attention-review`,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{}) ,...(id?{'X-Binding-Id':id}:{})},body:JSON.stringify(body)});
  const good={audioId:'wa:old',destination:'chat-a',confirmed:true};assert.equal((await send(good)).status,401);assert.equal((await send(good,a.token,a.binding.id)).status,403);
  assert.equal((await send({...good,confirmed:false},'synthetic-admin')).status,400);assert.equal((await send({...good,destination:'wrong'},'synthetic-admin')).status,400);
  const response=await send(good,'synthetic-admin');assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,alreadyReviewed:false});
  assert.deepEqual(await (await send(good,'synthetic-admin')).json(),{ok:true,alreadyReviewed:true});
 }finally{router.stopped=true;approvals.cancel();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();rmSync(temp,{recursive:true,force:true});}
});
