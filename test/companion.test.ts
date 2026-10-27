import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Coordinator } from '../src/coordinator.js';
import { Approvals } from '../src/approvals.js';
import { MetaBrain } from '../src/meta-brain.js';
import { MetaSecret, DEFAULT_BRAIN, saveBrainConfig } from '../src/meta-brain-config.js';
import type { Interpretation } from '../src/meta-model.js';
import { mentionedItems } from '../src/owner-routing.js';

const task:Interpretation={intent:'task',provider:'unspecified',normalized:'n',taskIds:[]};
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'ffd-companion-'));
  const store=new Store(':memory:'),approvals=new Approvals(store),native={run:async()=>{},stop:()=>{},catalog:async()=>({sessions:[]})};
  store.set('whatsapp-owner','owner@s.whatsapp.net');
  const router=new Router(store,native as any,approvals),c=new Coordinator(store,native as any,router,()=>{});router.coordinator=c;router.pump=()=>{};
  const proxy=store.register('personal-bot','codex',randomUUID(),'/tmp').binding;store.set(`name:${proxy.id}`,'Personal Bot');c.registry.register(proxy);
  const worker=store.register('billing','codex',randomUUID(),'/tmp/billing').binding;store.set(`name:${worker.id}`,'Billing API');store.set('selected',JSON.stringify([worker.id]));
  const secret=new MetaSecret(dir);secret.save('synthetic-test-key-never-a-real-key');
  saveBrainConfig(store,secret,{policy:{...DEFAULT_BRAIN,enabled:true,allowRouting:true,allowStatus:true,allowManagement:true,failure:'block',providers:['codex','claude']}});
  let calls=0,next:Interpretation=task,seen:any;
  router.brain=new MetaBrain(store,secret,{interpret:async(_k:any,_p:any,input:any)=>{calls++;seen=input;return next;}});
  const last=()=>(store.db.prepare('SELECT body FROM outbox ORDER BY rowid DESC LIMIT 1').get() as {body:string}).body;
  const send=async(id:string,text:string,answer?:Interpretation)=>{if(answer)next=answer;await router.receive({id,text});};
  return {store,router,c,proxy,worker,last,send,get calls(){return calls;},get seen(){return seen;},jobs:()=>store.jobs(),close(){router.stopped=true;approvals.cancel();store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('the latest owner messages: a replaced proxy item is explained, never answered as in progress or silently reassigned',async()=>{
  const f=fixture();try {
    await f.send('tg:8','Fix the invoice export',task);
    assert.equal(f.store.job('tg:8')?.binding_id,f.proxy.id);
    // Personal Bot is replaced by atlas before it answers.
    f.store.jobState('tg:8','replaced');f.store.enable(f.proxy.id,false);
    const atlas=f.store.register('atlas','codex',randomUUID(),'/tmp/atlas').binding;f.store.set(`name:${atlas.id}`,'atlas');f.c.registry.register(atlas);f.store.set('master',atlas.id);
    const before=f.calls;
    await f.send('tg:23','Hey');
    assert.match(f.last(),/One item needs you: #1 Fix the invoice export/);
    await f.send('tg:25','Give me all items');
    assert.match(f.last(),/P1 ⚠️ Fix the invoice export · waiting on owner/);
    await f.send('tg:27','Give me updtar on P1');
    assert.match(f.last(),/Personal Bot was replaced before it finished\. Nothing was resent\. Say "start #1 again"/);
    assert.equal(f.calls,before,'greeting, list and coded status stay local');
    await f.send('tg:29',"I didn't get anythung from that session",{...task,intent:'status',taskIds:['item:1']});
    assert.match(f.last(),/replaced before it finished/);
    await f.send('tg:31','Ask update from codex');
    assert.match(f.last(),/replaced before it finished/);
    assert.equal(f.jobs().filter(j=>j.binding_id===atlas.id).length,0,'atlas never receives the old task on its own');
    // Only the owner's explicit choice sends the original request again, word for word, to the current proxy.
    await f.send('tg:33','start #1 again');
    assert.equal(f.store.job('tg:33')?.binding_id,atlas.id);assert.equal(f.store.job('tg:33')?.body,'Fix the invoice export');
    assert.match(f.c.items().show(1),/Owner started it again with atlas/);
  }finally{f.close();}
});

test('a fresh update asks the owning worker once, status only, and its reply is tracked on the item',async()=>{
  const f=fixture();try {
    await f.send('tg:1','Fix the invoice export',task);
    const [child]=f.c.dispatch('tg:1',[f.worker.id],'Fix the invoice export.','e1');
    await f.send('tg:2','Ask codex for an update');
    const ask=f.store.job('tg:2')!;
    assert.equal(ask.binding_id,f.worker.id);
    assert.match(ask.body,/^Status check from the owner for #1 /);assert.match(ask.body,/Do not resume, rerun or continue the task/);
    assert.match(f.last(),/Asking Billing API/);assert.equal(f.store.itemOf('tg:2'),1);
    // An uncertain status question never marks the work itself blocked, and is never resent.
    f.store.jobState('tg:2','uncertain','Native submission unconfirmed');f.router.brain.memory.synchronize();
    assert.equal(f.c.items().get(1).status,'in progress');
    f.store.jobState('tg:2','submitted');
    // The same owner event delivered twice never asks twice.
    f.store.db.prepare('DELETE FROM seen WHERE id=?').run('tg:2');await f.send('tg:2','Ask codex for an update');
    assert.equal(f.jobs().filter(j=>j.id==='tg:2').length,1);
    // A late reply lands on the item under its number.
    f.router.channelReply(f.worker,'✅ *Export fixed*\n- Tests pass.','final','tg:2');
    assert.match(f.c.items().show(1),/Billing API reported: Export fixed/);
    assert.match(f.last(),/^\*#1 · /);
    assert.ok(f.store.job(child));
    // Worker answers become part of the companion's working memory for the next message.
    await f.send('tg:9','so what is next',{...task,intent:'clarify'});
    assert.match(JSON.stringify(f.seen.conversation),/Export fixed/);
  }finally{f.close();}
});

test('a proxy that owns its item is asked; ambiguous, undispatched and unconnected items are explained',async()=>{
  const f=fixture();try {
    await f.send('tg:1','Plan the launch',task);
    await f.send('tg:2','ask for an update on #1');
    assert.equal(f.store.job('tg:2')?.binding_id,f.proxy.id,'the proven proxy owner answers its own item');
    await f.send('tg:3','Fix the export',task);f.c.dispatch('tg:3',[f.worker.id],'Fix the export','e3');
    await f.send('tg:4','Ask update from codex');
    assert.match(f.last(),/Which task do you mean\?/);assert.equal(f.store.job('tg:4'),undefined);
    await f.send('tg:5','1');
    assert.ok(f.store.job('tg:5'),'the numbered choice sends one status question');
    f.c.items().add('Write the release notes');
    f.store.db.prepare('INSERT INTO brain_item_routes VALUES(?,?)').run(3,f.store.destination());
    await f.send('tg:6','ask for an update on #3');
    assert.match(f.last(),/hasn't been sent to a session yet/);assert.equal(f.store.job('tg:6'),undefined);
    f.store.set('selected','[]');
    await f.send('tg:7','check with it for an update on #2');
    assert.match(f.last(),/isn't connected/);assert.equal(f.store.job('tg:7'),undefined);
  }finally{f.close();}
});

test('item codes resolve anywhere in a sentence from the list the owner last saw, and reach the model',async()=>{
  const codes={P1:4,D2:9};
  assert.deepEqual(mentionedItems('Give me update on P1',codes),[4]);
  assert.deepEqual(mentionedItems('how are #12 and item two doing',codes),[12,2]);
  assert.deepEqual(mentionedItems('compare P1 with D2 and P9',codes),[4,9]);
  assert.deepEqual(mentionedItems('MP3 files and HTTP2',codes),[]);
  const f=fixture();try {
    await f.send('tg:1','Fix the export',task);await f.send('tg:2','Give me all items');
    await f.send('tg:3','please look at P1 when you can',{...task,intent:'clarify'});
    assert.deepEqual(f.seen.itemCodes,{P1:'item:1'});
  }finally{f.close();}
});

test('status questions respect negation, quoted text, provider choice and disabled provider policy',async()=>{
 for(const mode of ['negated','quoted','provider','policy']){
  const f=fixture();try{
   await f.send('wa:work','Fix the invoice export',task);f.c.dispatch('wa:work',[f.worker.id],'Fix export','worker');
   if(mode==='policy'){
    const {brainPolicy}=await import('../src/meta-brain-config.js');
    f.store.set('meta-brain-policy',JSON.stringify({...brainPolicy(f.store),providers:['claude']}));
   }
   const text=mode==='negated'?"Don't ask codex for an update":mode==='quoted'?'The document says "ask codex for an update"':mode==='provider'?'Ask claude for an update on #1':'Ask codex for an update on #1';
   await f.send('wa:restricted',text,{...task,intent:'update',taskIds:['item:1']});
   assert.equal(f.store.job('wa:restricted'),undefined,mode);
  }finally{f.close();}
 }
});
test('memory retains brain answers while excluding unrelated destination replies',async()=>{
 const f=fixture();try{
  await f.send('wa:memory-work','Fix the invoice export',task);
  await f.send('wa:memory-status','Give me all items');
  f.store.output(f.proxy,'foreign destination content','foreign-memory-reply','other-owner',{requestId:'wa:memory-work',kind:'progress',origin:'agent'});
  await f.send('wa:memory-next','what should I do next',{...task,intent:'clarify'});
  const history=JSON.stringify(f.seen.conversation);
  assert.match(history,/In progress/);assert.doesNotMatch(history,/foreign destination content/);
 }finally{f.close();}
});

test('an explicitly restarted item uses the new attempt for ownership and completion without deleting history',async()=>{
 const f=fixture();try{
  await f.send('tg:old','Fix the export',task);
  const [child]=f.c.dispatch('tg:old',[f.worker.id],'Fix the export','old-child');
  f.store.jobState(child,'replaced');f.store.jobState('tg:old','replaced');
  f.store.enable(f.worker.id,false);f.store.enable(f.proxy.id,false);
  const atlas=f.store.register('atlas','codex',randomUUID(),'/tmp/atlas').binding;f.c.registry.register(atlas);f.store.set('master',atlas.id);
  await f.send('tg:restart','start #1 again');
  assert.equal(f.store.job('tg:restart')?.binding_id,atlas.id);
  await f.send('tg:ask-new','ask for an update on #1');
  assert.equal(f.store.job('tg:ask-new')?.binding_id,atlas.id);
  f.store.jobState('tg:restart','submitted');
  f.router.channelReply(atlas,'✅ *Export fixed*\nTests passed.','final','tg:restart',undefined,{outcome:'done'});
  f.router.brain.memory.synchronize();
  assert.equal(f.c.items().get(1).status,'done');
  assert.equal(f.store.job(child)?.status,'replaced','old evidence remains intact');
 }finally{f.close();}
});
test('a numbered update choice retains the original platform constraint',async()=>{
 const f=fixture();try{
  await f.send('tg:a','Fix the export',task);await f.send('tg:b','Plan launch',task);
  await f.send('tg:choose','Ask claude for an update');
  assert.match(f.last(),/Which task/);
  await f.send('tg:number','1');
  assert.equal(f.store.job('tg:number'),undefined);
  assert.match(f.last(),/another platform/);
 }finally{f.close();}
});

test('latest small talk and bare task reference answer locally with the replaced-owner context',async()=>{
 const f=fixture();try{
  await f.send('tg:work','List all my codex sessions',task);
  f.store.jobState('tg:work','replaced');f.store.enable(f.proxy.id,false);
  const calls=f.calls;
  await f.send('tg:greeting','How are you');assert.match(f.last(),/One item needs you/);
  await f.send('tg:reference','Task 1');assert.match(f.last(),/replaced before it finished/);
  assert.equal(f.calls,calls);assert.equal(f.store.job('tg:reference'),undefined);
 }finally{f.close();}
});
