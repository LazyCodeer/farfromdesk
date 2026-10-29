import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Application modules cache their state root at import time.
const root=mkdtempSync(join(tmpdir(),'ffd-stuck-test-'));process.env.WSB_STATE_DIR=root;process.env.FARFROMDESK_HOME=join(root,'home');
test.after(()=>rmSync(root,{recursive:true,force:true}));
const {Store}=await import('../src/store.js');
const {Router}=await import('../src/router.js');
const {Approvals}=await import('../src/approvals.js');
const {DEFAULT_BRAIN}=await import('../src/meta-brain-config.js');
const {StuckDetection}=await import('../src/stuck-detection.js');
const {WhatsApp}=await import('../src/whatsapp.js');
const {selectOption}=await import('../src/message-options.js');
const {TaskContracts}=await import('../src/task-contracts.js');
const {metaTimeline}=await import('../src/meta-timeline.js');

const owner='owner@s.whatsapp.net';
function fixture(path=':memory:'){
  const store=new Store(path),approvals=new Approvals(store),native={run:async()=>{},stop:()=>{}};
  store.set('whatsapp-owner',owner);store.set('control-channel','whatsapp');
  store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true,taskContracts:false}));
  const router=new Router(store,native as any,approvals);router.brain.secret.save('synthetic-stuck-test-key-only');
  let now=Date.now(),inputs:unknown[]=[];
  const detector=new StuckDetection(store,router,async(kinds)=>{inputs.push(kinds);return 'A task needs your attention.';},()=>now);
  router.stuckDetection=detector;
  const binding=store.register('worker','codex',randomUUID(),'/tmp').binding;
  const add=(id:string,title:string)=>{
    store.recordOwnerOrigin(id,owner,owner);
    store.destinationContext.run(owner,()=>store.enqueue(id,binding,'Synthetic task',owner));
    const item=store.destinationContext.run(owner,()=>router.brain.memory.add(id,title));
    store.jobState(id,'dispatched');store.jobState(id,'submitted');return item;
  };
  return {store,approvals,router,binding,detector,add,inputs,now:()=>now,advance:(ms:number)=>{now+=ms;},close:()=>{router.stopped=true;approvals.cancel();store.close();}};
}
const alerts=(store:InstanceType<typeof Store>)=>store.db.prepare('SELECT * FROM stuck_alerts ORDER BY item_id').all() as any[];
const alertOut=(store:InstanceType<typeof Store>)=>store.db.prepare("SELECT * FROM outbox WHERE source LIKE 'stuck-alert:%' ORDER BY created_at").all() as any[];

test('idle alert is owner scoped, grounded, deduplicated and sends only categories to Meta',async()=>{
  const f=fixture();try{
    const item=f.add('wa:one','Synthetic confidential task');
    await f.detector.tick();assert.equal(alerts(f.store).length,0);
    f.advance(10*60_000+10_000);await f.detector.tick();await f.detector.tick();
    assert.equal(alerts(f.store).length,1);assert.equal(alertOut(f.store).length,1);
    assert.equal(alerts(f.store)[0].item_id,item.id);assert.match(alertOut(f.store)[0].body,/No recorded progress/);
    assert.deepEqual(f.inputs,[['idle']]);assert.doesNotMatch(JSON.stringify(f.inputs),/Synthetic confidential|wa:one|owner@/);
    f.store.set('whatsapp-owner','different@s.whatsapp.net');await f.detector.tick();assert.equal(alerts(f.store).length,1);
  }finally{f.close();}
});

test('only actual stuck-notice Meta requests appear in the scoped timeline',async()=>{
  const f=fixture(),originalFetch=globalThis.fetch;try{
    f.add('wa:one','Synthetic private task');f.advance(11*60_000);
    let calls=0,requestBody='';
    globalThis.fetch=async(_url,init)=>{calls++;requestBody=String(init?.body??'');return new Response(JSON.stringify({id:'r',created:0,model:'muse-wonder-1.0',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'1'}}]}),{headers:{'content-type':'application/json'}});};
    const detector=new StuckDetection(f.store,f.router,undefined,f.now);await detector.tick();
    assert.equal(calls,1);assert.equal(alerts(f.store).length,1);
    assert.deepEqual((metaTimeline(f.store) as any[]).map(row=>[row.stage,row.status]),[['stuck','completed']]);
    assert.doesNotMatch(requestBody,/Synthetic private task|wa:one/);
    assert.doesNotMatch(JSON.stringify(f.store.db.prepare('SELECT * FROM meta_timeline').all()),/Synthetic private task|wa:one|synthetic-stuck-test-key-only/);
    await detector.tick();assert.equal(calls,1);assert.equal(metaTimeline(f.store).length,1);
  }finally{globalThis.fetch=originalFetch;f.close();}
});

test('stuck Meta activity is discarded if the owner changes away and back mid-call',async()=>{
  const f=fixture(),originalFetch=globalThis.fetch;try{
    f.add('wa:one','Synthetic task');f.advance(11*60_000);
    let started!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>started=r),wait=new Promise<void>(r=>release=r);
    globalThis.fetch=async()=>{started();await wait;return new Response(JSON.stringify({id:'r',created:0,model:'muse-wonder-1.0',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'1'}}]}),{headers:{'content-type':'application/json'}});};
    const detector=new StuckDetection(f.store,f.router,undefined,f.now),call=detector.tick();await entered;
    f.store.set('whatsapp-owner','other@s.whatsapp.net');f.store.set('whatsapp-owner',owner);release();await call;
    assert.equal(metaTimeline(f.store).length,0);assert.equal(alerts(f.store).length,0);
  }finally{globalThis.fetch=originalFetch;f.close();}
});

test('stuck Meta failure and timeline write failure cannot prevent an alert',async()=>{
  for(const mode of ['provider','timeline'] as const){const f=fixture(),originalFetch=globalThis.fetch;try{
    f.add('wa:one','Synthetic task');f.advance(11*60_000);
    globalThis.fetch=async()=>mode==='provider'?new Response('Synthetic private error',{status:503}):new Response(JSON.stringify({id:'r',created:0,model:'muse-wonder-1.0',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'1'}}]}),{headers:{'content-type':'application/json'}});
    if(mode==='timeline')f.store.db.exec("CREATE TEMP TRIGGER fail_stuck_timeline BEFORE INSERT ON meta_timeline BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    const detector=new StuckDetection(f.store,f.router,undefined,f.now);await detector.tick();
    assert.equal(alerts(f.store).length,1);
    const rows=metaTimeline(f.store) as any[];
    assert.deepEqual(rows.map(row=>[row.stage,row.status]),mode==='provider'?[['stuck','failed']]:[]);
    assert.doesNotMatch(JSON.stringify(rows),/Synthetic private error/);
  }finally{globalThis.fetch=originalFetch;f.close();}}
});

test('a synthetic stuck writer does not create a Meta timeline entry',async()=>{
  const f=fixture();try{f.add('wa:one','Synthetic task');f.advance(11*60_000);await f.detector.tick();assert.equal(alerts(f.store).length,1);assert.equal(metaTimeline(f.store).length,0);}finally{f.close();}
});

test('a stuck notice without a Meta key uses its local opening without recording a call',async()=>{
  const f=fixture(),originalFetch=globalThis.fetch;try{
    f.add('wa:one','Synthetic task');f.advance(11*60_000);f.router.brain.secret.read=()=>undefined;
    globalThis.fetch=async()=>{throw new Error('No Meta call expected');};
    await new StuckDetection(f.store,f.router,undefined,f.now).tick();
    assert.equal(alerts(f.store).length,1);assert.equal(metaTimeline(f.store).length,0);
  }finally{globalThis.fetch=originalFetch;f.close();}
});

test('only an exact request-bound pending approval becomes an approval alert',async()=>{
  const f=fixture();try{
    const item=f.add('wa:approval','Review build');
    void f.store.destinationContext.run(owner,()=>f.approvals.ask(f.binding,'Synthetic secret prompt','approval','wa:approval'));
    await f.detector.tick();assert.equal(alerts(f.store).length,1);assert.equal(alerts(f.store)[0].kind,'approval');
    assert.equal(alerts(f.store)[0].item_id,item.id);assert.doesNotMatch(JSON.stringify(f.inputs),/secret|prompt/);
    assert.doesNotMatch(alertOut(f.store)[0].body,/Synthetic secret/);
    f.approvals.cancel();assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'invalid');
  }finally{f.close();}
});

test('an exact native question is reported only while its answer is pending',async()=>{
  const f=fixture();try{
    f.add('wa:question','Synthetic task');
    const answer=f.store.destinationContext.run(owner,()=>f.approvals.ask(f.binding,'Private question','question','wa:question'));
    await f.detector.tick();assert.equal(alerts(f.store)[0].kind,'question');assert.deepEqual(f.inputs,[['question']]);
    const [code]=f.approvals.pending.keys();f.approvals.answer(code,'A private answer','question');assert.equal(await answer,'A private answer');
    assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'invalid');
  }finally{f.close();}
});

test('a delivered, unanswered agent choice creates one scoped notice and selection invalidates it',async()=>{
  const f=fixture();try{
    const item=f.add('wa:choice','Synthetic task');
    f.store.output(f.binding,'Confidential choice text','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;
    await f.detector.tick();assert.equal(alerts(f.store).length,0,'queued is not delivered');
    f.store.sent(row.id);await f.detector.tick();await f.detector.tick();
    assert.equal(alerts(f.store).length,1);assert.equal(alerts(f.store)[0].kind,'choice');assert.equal(alerts(f.store)[0].item_id,item.id);
    assert.match(alertOut(f.store)[0].body,/unanswered session choice/);assert.match(alertOut(f.store)[0].body,/Confidential choice text/);assert.match(alertOut(f.store)[0].body,/1\. First/);assert.match(alertOut(f.store)[0].body,/2\. Second/);
    assert.deepEqual(f.inputs,[['choice']]);
    assert.equal(selectOption(f.store,{responseId:'wa:answer',destination:owner,messageId:row.wa_id,number:1},(bindingId,text)=>f.store.enqueue('wa:answer',f.store.binding(bindingId)!,text,owner)),true);
    assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'invalid');
    await f.detector.tick();assert.equal(alerts(f.store).length,1);
  }finally{f.close();}
});

test('replying to a delivered choice notice claims the exact original option once',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');f.router.pump=()=>{};
    f.store.output(f.binding,'Which approach?','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:600}});
    const original=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(original.id);await f.detector.tick();
    const notice=alertOut(f.store)[0];assert.match(notice.body,/Which approach\?/);assert.match(notice.body,/not a native permission approval/);f.store.sent(notice.id);
    const result=await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:choice-answer',text:'2',quotedId:notice.wa_id,ownerCommand:false,ownerChoice:true,source:'text'}));
    assert.equal(result.status,'queued');assert.equal((f.store.db.prepare('SELECT selected_id FROM message_options').get() as {selected_id:string}).selected_id,'b');
    assert.equal(f.store.job('wa:choice-answer')?.binding_id,f.binding.id);assert.equal(f.store.itemOf('wa:choice-answer'),f.store.itemOf('wa:choice'));
    const replay=await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:choice-repeat',text:'1',quotedId:notice.wa_id,ownerCommand:false,ownerChoice:true,source:'text'}));
    assert.equal(replay.status,'blocked');assert.equal(f.store.job('wa:choice-repeat'),undefined);assert.equal((f.store.db.prepare('SELECT selected_id FROM message_options').get() as {selected_id:string}).selected_id,'b');
    assert.doesNotMatch(JSON.stringify(f.inputs),/Which approach|First|Second/);
  }finally{f.close();}
});

test('choice notice answers fail closed when ownership, identity, expiry or input trust changes',async()=>{
  for(const change of ['expired','owner','session','attempt','forwarded','voice','unsent','dismissed','legacy'] as const){
    const f=fixture();try{
      f.add('wa:choice','Synthetic task');f.router.pump=()=>{};
      f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:600}});
      const original=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(original.id);await f.detector.tick();
      const notice=alertOut(f.store)[0];if(change!=='unsent')f.store.sent(notice.id);
      if(change==='expired')f.advance(601_000);
      if(change==='owner'){f.store.set('whatsapp-owner','other@s.whatsapp.net');f.store.set('whatsapp-owner',owner);}
      if(change==='session')f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),f.binding.id);
      if(change==='attempt')f.store.jobState('wa:choice','dispatched');
      if(change==='dismissed')f.store.db.prepare("UPDATE stuck_alerts SET state='dismissed'").run();
      if(change==='legacy')f.store.db.prepare('UPDATE stuck_alerts SET choice_id=NULL').run();
      const result=await f.store.destinationContext.run(owner,()=>f.router.receive({id:`wa:rejected-${change}`,text:'1',quotedId:notice.wa_id,ownerCommand:false,ownerChoice:change!=='forwarded',source:change==='voice'?'voice':'text'}));
      assert.equal(result.status,'blocked',change);assert.equal(f.store.job(`wa:rejected-${change}`),undefined,change);
      assert.equal((f.store.db.prepare('SELECT selected_id FROM message_options').get() as {selected_id:null}).selected_id,null,change);
    }finally{f.close();}
  }
});

test('a choice made from a notice uses the existing task-contract review rather than bypassing it',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');f.router.pump=()=>{};f.store.set('active',f.binding.id);
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:600}});
    const original=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(original.id);await f.detector.tick();const notice=alertOut(f.store)[0];f.store.sent(notice.id);
    f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true,taskContracts:true}));
    f.router.contracts=new TaskContracts(f.store,f.router.brain.secret,async()=>({kind:'contract',goal:'Synthetic project',exclusions:[],checks:['One','Two'],question:''}));
    const result=await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:notice-review',text:'1',quotedId:notice.wa_id,ownerCommand:false,ownerChoice:true,source:'text'}));
    assert.equal(result.status,'handled');assert.equal(f.store.job('wa:notice-review'),undefined);
    assert.ok(f.store.db.prepare("SELECT 1 FROM task_contracts WHERE origin_id=? AND state='pending'").get('wa:notice-review'));
    assert.equal((f.store.db.prepare('SELECT selected_id FROM message_options').get() as {selected_id:null}).selected_id,null);
  }finally{f.close();}
});

test('a direct WhatsApp quoted number answers only the original delivered session choice',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');f.router.pump=()=>{};
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:600}});
    const original=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(original.id);await f.detector.tick();const notice=alertOut(f.store)[0];f.store.sent(notice.id);
    const wa=new WhatsApp(f.store,f.router);wa.status='connected';wa.selfJid=owner;wa.owners=[owner];
    const message={key:{id:'quoted-choice',fromMe:true,remoteJid:owner},message:{extendedTextMessage:{text:'2',contextInfo:{stanzaId:notice.wa_id}}}};
    await wa.receiveMessage(message);await wa.receiveMessage(message);
    assert.equal((f.store.db.prepare('SELECT selected_id FROM message_options').get() as {selected_id:string}).selected_id,'b');
    assert.equal(f.store.job('wa:quoted-choice')?.binding_id,f.binding.id);wa.close();
  }finally{f.close();}
});

test('a long or direction-overridden original choice is never advertised as actionable',async()=>{
  for(const text of ['x'.repeat(3100),'Unclear \u202equestion']){const f=fixture();try{
    f.add('wa:choice','Synthetic task');f.router.pump=()=>{};
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:600}});
    const original=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.db.prepare('UPDATE outbox SET body=? WHERE id=?').run(text,original.id);f.store.sent(original.id);await f.detector.tick();
    const notice=alertOut(f.store)[0];f.store.sent(notice.id);assert.equal(alerts(f.store)[0].choice_id,null);
    const result=await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:unsafe',text:'1',quotedId:notice.wa_id,ownerChoice:true,source:'text'}));
    assert.equal(result.status,'blocked');assert.equal(f.store.job('wa:unsafe'),undefined);
  }finally{f.close();}}
});

test('a choice captured before dispatch has no verified attempt and cannot alert later',async()=>{
  const f=fixture();try{
    f.store.recordOwnerOrigin('wa:choice',owner,owner);f.store.enqueue('wa:choice',f.binding,'Synthetic task',owner);
    f.store.destinationContext.run(owner,()=>f.router.brain.memory.add('wa:choice','Synthetic task'));
    f.store.jobState('wa:choice','submitted');assert.equal(f.store.job('wa:choice')?.attempt_id,null);
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
    const option=f.store.db.prepare('SELECT stuck_identity,stuck_attempt FROM message_options').get() as {stuck_identity:string|null;stuck_attempt:string|null};
    assert.equal(option.stuck_identity,null);assert.equal(option.stuck_attempt,null);
    const row=f.store.db.prepare("SELECT id FROM outbox WHERE source='synthetic-choice:0'").get() as {id:string};f.store.sent(row.id);
    await f.detector.tick();assert.equal(alerts(f.store).length,0);
    f.store.jobState('wa:choice','dispatched');f.store.jobState('wa:choice','submitted');
    assert.ok(f.store.job('wa:choice')?.attempt_id);await f.detector.tick();assert.equal(alerts(f.store).length,0);
  }finally{f.close();}
});

test('owner resolution as cancelled, reviewed or done closes an outstanding choice',async()=>{
  for(const outcome of ['cancelled','reviewed','done'] as const){
    const f=fixture();try{
      f.add('wa:choice','Synthetic task');assert.ok(f.store.job('wa:choice')?.attempt_id);
      f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
      const row=f.store.db.prepare("SELECT id FROM outbox WHERE source='synthetic-choice:0'").get() as {id:string};f.store.sent(row.id);
      await f.detector.tick();assert.equal(alerts(f.store)[0].kind,'choice');
      f.router.coordinator={requestMaster:()=>f.binding,scope:{getStore:()=>undefined}} as any;
      f.router.resolveOwner('wa:choice',outcome);
      assert.equal(f.store.job('wa:choice')?.status,'completed');assert.equal(f.store.job('wa:choice')?.outcome,outcome);
      assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'invalid');
    }finally{f.close();}
  }
});

test('a choice notice fails closed on expiration, replaced session or task attempt',async()=>{
  for(const change of ['expired','native','route','attempt','owner','legacy','cancelled','target-choice','other-origin'] as const){
    const f=fixture();try{
      f.add('wa:choice','Synthetic task');
      f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
      const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);
      if(change==='expired')f.advance(61_000);
      if(change==='native')f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),f.binding.id);
      if(change==='route')f.store.set(`session-route:${f.binding.id}`,'changed');
      if(change==='attempt')f.store.jobState('wa:choice','dispatched');
      if(change==='owner')f.store.set('whatsapp-owner','other@s.whatsapp.net');
      if(change==='legacy')f.store.db.prepare('UPDATE message_options SET stuck_identity=NULL').run();
      if(change==='cancelled')f.store.jobState('wa:choice','cancelled');
      if(change==='target-choice')f.store.db.prepare('INSERT INTO owner_target_options SELECT id FROM message_options').run();
      if(change==='other-origin')f.store.db.prepare('UPDATE owner_request_origins SET owner=? WHERE request_id=?').run('other@s.whatsapp.net','wa:choice');
      await f.detector.tick();assert.equal(alerts(f.store).length,0,change);
    }finally{f.close();}
  }
});

test('a queued choice notice is invalidated when its question expires or its target changes',async()=>{
  for(const change of ['expired','native','route','attempt','attempt-null'] as const){
    const f=fixture();try{
      f.add('wa:choice','Synthetic task');
      f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
      const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);await f.detector.tick();
      assert.equal(alerts(f.store).length,1);
      if(change==='expired')f.advance(61_000);
      if(change==='native')f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),f.binding.id);
      if(change==='route')f.store.set(`session-route:${f.binding.id}`,'changed');
      if(change==='attempt')f.store.jobState('wa:choice','dispatched');
      if(change==='attempt-null')f.store.db.prepare('UPDATE inbox SET attempt_id=NULL WHERE id=?').run('wa:choice');
      assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'invalid',change);
    }finally{f.close();}
  }
});

test('pending choice identity and notice deduplication survive restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-stuck-restart-')),path=join(dir,'test.sqlite'),f=fixture(path);
  try{
    f.add('wa:choice','Synthetic task');
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);await f.detector.tick();
    assert.equal(alerts(f.store).length,1);const now=f.now();f.close();
    const store=new Store(path),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
    try{
      const detector=new StuckDetection(store,router,async()=>{throw new Error('Duplicate notice must not reach the writer');},()=>now);
      await detector.tick();assert.equal(alerts(store).length,1);
      assert.equal(selectOption(store,{responseId:'wa:answer',destination:owner,messageId:row.wa_id,number:1},(bindingId,text)=>store.enqueue('wa:answer',store.binding(bindingId)!,text,owner)),true);
      assert.equal(detector.deliveryState(alertOut(store)[0],owner),'invalid');
    }finally{approvals.cancel();store.close();}
  }finally{try{f.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});

test('a choice with unverifiable session identity still sends but cannot create a notice',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');f.store.set('coordinator-registry','not-json');
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);
    assert.equal((f.store.db.prepare('SELECT stuck_identity FROM message_options').get() as {stuck_identity:null}).stuck_identity,null);
    await f.detector.tick();assert.equal(alerts(f.store).length,0);
  }finally{f.close();}
});

test('a choice answered while composing a notice is not alerted',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);
    let release!:()=>void,started!:()=>void;const waiting=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r);
    const detector=new StuckDetection(f.store,f.router,async()=>{started();await waiting;return 'A task needs your attention.';},f.now);
    const tick=detector.tick();await entered;
    selectOption(f.store,{responseId:'wa:answer',destination:owner,messageId:row.wa_id,number:1},(bindingId,text)=>f.store.enqueue('wa:answer',f.store.binding(bindingId)!,text,owner));
    release();await tick;assert.equal(alerts(f.store).length,0);
  }finally{f.close();}
});

test('a new owner answer prevents an immediate idle notice for the same item',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:3600}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);
    f.advance(11*60_000);await f.detector.tick();assert.equal(alerts(f.store)[0].kind,'choice');
    f.store.recordOwnerOrigin('wa:answer',owner,owner);
    selectOption(f.store,{responseId:'wa:answer',destination:owner,messageId:row.wa_id,number:1},(bindingId,text)=>f.store.enqueue('wa:answer',f.store.binding(bindingId)!,text,owner));
    f.store.db.prepare('UPDATE inbox SET received_at=? WHERE id=?').run(f.now(),'wa:answer');
    await f.detector.tick();assert.equal(alerts(f.store).length,1,'the recent answer is progress, not a new idle incident');
  }finally{f.close();}
});

test('a quoted free-text follow-up suppresses only the exact choice it quotes',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');f.router.pump=()=>{};
    for(const name of ['first','second']){
      f.store.output(f.binding,`Question ${name}`,`choice-${name}`,owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
      const row=f.store.db.prepare('SELECT id FROM outbox WHERE source=?').get(`choice-${name}:0`) as {id:string};f.store.sent(row.id);
    }
    const first=f.store.db.prepare("SELECT * FROM outbox WHERE source='choice-first:0'").get() as any;
    const result=await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:answer',text:'Friday works for me',quotedId:first.wa_id,ownerCommand:false,ownerChoice:true}));
    assert.equal(result.status,'queued');
    assert.equal((f.store.db.prepare('SELECT outbox_id FROM stuck_quoted_replies WHERE response_id=?').get('wa:answer') as {outbox_id:string}).outbox_id,first.id);
    await f.detector.tick();assert.equal(alerts(f.store).length,1);assert.equal(alerts(f.store)[0].kind,'choice');
    // If the second choice is closed, no alert remains for the first one.
    f.store.db.prepare('UPDATE message_options SET selected_id=? WHERE outbox_id=(SELECT id FROM outbox WHERE source=?)').run('a','choice-second:0');
    assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'invalid');
  }finally{f.close();}
});

test('a quoted free-text answer intercepted by a pending task contract invalidates its choice notice',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');f.router.pump=()=>{};f.store.set('active',f.binding.id);
    f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true,taskContracts:true}));
    f.router.contracts=new TaskContracts(f.store,f.router.brain.secret,async()=>({kind:'contract',goal:'Synthetic project',exclusions:[],checks:['One','Two'],question:''}));
    const pending=await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:pending',text:'Build a synthetic project',ownerCommand:true}));
    assert.equal(pending.status,'handled');assert.ok(f.store.db.prepare("SELECT 1 FROM task_contracts WHERE state='pending'").get());
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);await f.detector.tick();
    assert.equal(alerts(f.store)[0]?.kind,'choice');
    const answer=await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:answer',text:'Friday works for me',quotedId:row.wa_id,ownerCommand:false,ownerChoice:true}));
    assert.equal(answer.status,'handled');assert.equal(f.store.job('wa:answer'),undefined,'F3 intercepted the reply before task dispatch');
    assert.equal((f.store.db.prepare('SELECT outbox_id FROM stuck_quoted_replies WHERE response_id=?').get('wa:answer') as {outbox_id:string}).outbox_id,row.id);
    assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'invalid');
    await f.detector.tick();assert.equal(alerts(f.store).length,1,'the stale alert is not recreated');
  }finally{f.close();}
});

test('an F3-intercepted quoted reply does not suppress a different choice',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');f.router.pump=()=>{};f.store.set('active',f.binding.id);
    f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true,taskContracts:true}));
    f.router.contracts=new TaskContracts(f.store,f.router.brain.secret,async()=>({kind:'contract',goal:'Synthetic project',exclusions:[],checks:['One','Two'],question:''}));
    await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:pending',text:'Build a synthetic project',ownerCommand:true}));
    for(const name of ['first','second']){
      f.store.output(f.binding,`Question ${name}`,`choice-${name}`,owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
      const out=f.store.db.prepare('SELECT id FROM outbox WHERE source=?').get(`choice-${name}:0`) as {id:string};f.store.sent(out.id);
    }
    const first=f.store.db.prepare("SELECT * FROM outbox WHERE source='choice-first:0'").get() as any;
    await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:answer',text:'Friday works',quotedId:first.wa_id,ownerCommand:false,ownerChoice:true}));
    assert.equal(f.store.job('wa:answer'),undefined);await f.detector.tick();assert.equal(alerts(f.store)[0]?.kind,'choice');
    f.store.db.prepare('UPDATE message_options SET selected_id=? WHERE outbox_id=(SELECT id FROM outbox WHERE source=?)').run('a','choice-second:0');
    assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'invalid');
  }finally{f.close();}
});

test('an unquoted answer intercepted by a pending task contract invalidates a potentially answered choice',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');f.router.pump=()=>{};f.store.set('active',f.binding.id);
    f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true,taskContracts:true}));
    f.router.contracts=new TaskContracts(f.store,f.router.brain.secret,async()=>({kind:'contract',goal:'Synthetic project',exclusions:[],checks:['One','Two'],question:''}));
    await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:pending',text:'Build a synthetic project',ownerCommand:true}));
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);await f.detector.tick();
    assert.equal(alerts(f.store)[0]?.kind,'choice');
    const answer=await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:answer',text:'Friday works for me',ownerCommand:true}));
    assert.equal(answer.status,'handled');assert.equal(f.store.job('wa:answer'),undefined,'F3 intercepted the reply');
    const evidence=f.store.db.prepare('SELECT * FROM stuck_ambiguous_choices WHERE response_id=?').all('wa:answer') as any[];
    assert.equal(evidence.length,1);assert.equal(evidence[0].option_id,(f.store.db.prepare('SELECT id FROM message_options WHERE outbox_id=?').get(row.id) as {id:string}).id);
    assert.doesNotMatch(JSON.stringify(evidence),/Friday/);
    assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'invalid');await f.detector.tick();assert.equal(alerts(f.store).length,1);
  }finally{f.close();}
});

test('an unquoted owner turn that starts a new F3 review makes existing matching choices ambiguous',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');f.router.pump=()=>{};f.store.set('active',f.binding.id);
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);await f.detector.tick();
    assert.equal(alerts(f.store)[0]?.kind,'choice');
    f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true,taskContracts:true}));
    f.router.contracts=new TaskContracts(f.store,f.router.brain.secret,async()=>({kind:'contract',goal:'Synthetic project',exclusions:[],checks:['One','Two'],question:''}));
    const turn=await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:answer',text:'Friday works for me',ownerCommand:true}));
    assert.equal(turn.status,'handled');assert.equal(f.store.job('wa:answer'),undefined);
    assert.ok(f.store.db.prepare('SELECT 1 FROM stuck_ambiguous_choices WHERE response_id=?').get('wa:answer'));
    assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'invalid');
  }finally{f.close();}
});

test('approving an unrelated pending task contract does not suppress a session choice',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');f.router.pump=()=>{};f.store.set('active',f.binding.id);
    f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true,taskContracts:true}));
    f.router.contracts=new TaskContracts(f.store,f.router.brain.secret,async()=>({kind:'contract',goal:'Synthetic project',exclusions:[],checks:['One','Two'],question:''}));
    await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:pending',text:'Build a synthetic project',ownerCommand:true}));
    f.store.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);await f.detector.tick();
    assert.equal(alerts(f.store)[0]?.kind,'choice');
    const approved=await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:approve',text:'ok',ownerCommand:true}));
    assert.equal(approved.status,'queued');assert.ok(f.store.job('wa:approve'));
    assert.ok(f.store.db.prepare('SELECT 1 FROM stuck_contract_controls WHERE response_id=?').get('wa:approve'));
    assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'ready');
  }finally{f.close();}
});

test('an unquoted F3 reply with an exact active session does not suppress another session choice',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');f.router.pump=()=>{};
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);await f.detector.tick();
    const other=f.store.register('other','codex',randomUUID(),'/tmp').binding;f.store.set('active',other.id);
    f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true,taskContracts:true}));
    f.router.contracts=new TaskContracts(f.store,f.router.brain.secret,async()=>({kind:'contract',goal:'Synthetic project',exclusions:[],checks:['One','Two'],question:''}));
    await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:pending',text:'Build a synthetic project',ownerCommand:true}));
    await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:answer',text:'Friday works',ownerCommand:true}));
    assert.equal(f.store.db.prepare('SELECT 1 FROM stuck_ambiguous_choices WHERE response_id=?').get('wa:answer'),undefined);
    assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'ready');
  }finally{f.close();}
});

test('unquoted F3 reply is not consumed if ambiguous-choice evidence cannot be saved',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');f.router.pump=()=>{};f.store.set('active',f.binding.id);
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);
    f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true,taskContracts:true}));
    f.router.contracts=new TaskContracts(f.store,f.router.brain.secret,async()=>({kind:'contract',goal:'Synthetic project',exclusions:[],checks:['One','Two'],question:''}));
    await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:pending',text:'Build a synthetic project',ownerCommand:true}));
    f.store.db.exec("CREATE TEMP TRIGGER fail_ambiguous_choice BEFORE INSERT ON stuck_ambiguous_choices BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    const answer=await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:answer',text:'Friday works',ownerCommand:true}));
    assert.equal(answer.status,'blocked');assert.equal(f.store.job('wa:answer'),undefined);
    const notice=f.store.db.prepare("SELECT body FROM outbox WHERE source='command-error:wa:answer:0'").get() as {body:string};assert.match(notice.body,/resend/i);
    assert.ok(f.store.db.prepare("SELECT 1 FROM task_contracts WHERE state='pending'").get());
  }finally{f.close();}
});

test('a quoted reply is not consumed when its association cannot be recorded',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');f.router.pump=()=>{};f.store.set('active',f.binding.id);
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);
    f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true,taskContracts:true}));
    f.router.contracts=new TaskContracts(f.store,f.router.brain.secret,async()=>({kind:'contract',goal:'Synthetic project',exclusions:[],checks:['One','Two'],question:''}));
    await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:pending',text:'Build a synthetic project',ownerCommand:true}));
    f.store.db.exec("CREATE TEMP TRIGGER fail_stuck_quote BEFORE INSERT ON stuck_quoted_replies BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    const answer=await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:answer',text:'Friday works',quotedId:row.wa_id,ownerCommand:false,ownerChoice:true}));
    assert.equal(answer.status,'blocked');assert.equal(f.store.job('wa:answer'),undefined);
    const notice=f.store.db.prepare("SELECT body FROM outbox WHERE source='stuck-reply-error:wa:answer:0'").get() as {body:string};assert.match(notice.body,/resend/i);
    assert.ok(f.store.db.prepare("SELECT 1 FROM task_contracts WHERE state='pending'").get());
  }finally{f.close();}
});

test('a rejected quoted option does not suppress its unanswered choice',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');f.router.pump=()=>{};
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);await f.detector.tick();
    const result=await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:bad',text:'99',quotedId:row.wa_id,ownerCommand:false,ownerChoice:true}));
    assert.equal(result.status,'blocked');assert.equal(f.store.db.prepare('SELECT 1 FROM stuck_quoted_replies WHERE response_id=?').get('wa:bad'),undefined);
    assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'ready');
  }finally{f.close();}
});

test('F3 rejects a numbered choice while another contract is pending without suppressing it',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');f.router.pump=()=>{};f.store.set('active',f.binding.id);
    f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true,taskContracts:true}));
    f.router.contracts=new TaskContracts(f.store,f.router.brain.secret,async()=>({kind:'contract',goal:'Synthetic project',exclusions:[],checks:['One','Two'],question:''}));
    await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:pending',text:'Build a synthetic project',ownerCommand:true}));
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);await f.detector.tick();
    const result=await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:answer',text:'1',quotedId:row.wa_id,ownerCommand:false,ownerChoice:true}));
    assert.equal(result.status,'handled');assert.equal(f.store.job('wa:answer'),undefined);
    assert.equal(f.store.db.prepare('SELECT 1 FROM stuck_quoted_replies WHERE response_id=?').get('wa:answer'),undefined);
    assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'ready');
  }finally{f.close();}
});

test('a numbered choice actually held for a new F3 review suppresses its notice',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');f.router.pump=()=>{};f.store.set('active',f.binding.id);
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);await f.detector.tick();
    f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true,taskContracts:true}));
    f.router.contracts=new TaskContracts(f.store,f.router.brain.secret,async()=>({kind:'contract',goal:'Synthetic project',exclusions:[],checks:['One','Two'],question:''}));
    const result=await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:answer',text:'1',quotedId:row.wa_id,ownerCommand:false,ownerChoice:true}));
    assert.equal(result.status,'handled');assert.ok(f.store.db.prepare("SELECT 1 FROM task_contracts WHERE origin_id=? AND state='pending'").get('wa:answer'));
    assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'invalid');
    f.store.db.prepare("UPDATE task_contracts SET state='cancelled' WHERE origin_id=?").run('wa:answer');
    assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'ready');
  }finally{f.close();}
});

test('a pending review holds the notice, and classifier failure restores it',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');f.router.pump=()=>{};f.store.set('active',f.binding.id);
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);await f.detector.tick();
    f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true,taskContracts:true}));
    let started!:()=>void,reject!:()=>void;const entered=new Promise<void>(r=>started=r),waiting=new Promise<void>(r=>reject=r);
    f.router.contracts=new TaskContracts(f.store,f.router.brain.secret,async()=>{started();await waiting;throw new Error('Synthetic classifier failure');});
    const reply=f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:answer',text:'Friday works',ownerCommand:true}));
    await entered;assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'hold');
    reject();assert.equal((await reply).status,'blocked');
    assert.equal(f.store.db.prepare('SELECT 1 FROM stuck_ambiguous_choices WHERE response_id=?').get('wa:answer'),undefined);
    assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'ready');
  }finally{f.close();}
});

test('startup reconciles interrupted inputs using durable outcomes',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:3600}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);
    for(const id of ['wa:lost','wa:accepted','wa:rejected'])f.store.recordOwnerOrigin(id,owner,owner);
    for(const id of ['wa:lost','wa:accepted','wa:rejected'])f.store.db.prepare("INSERT INTO stuck_quoted_replies(response_id,outbox_id,owner,destination,state,numbered) VALUES(?,?,?,?,'pending',?)").run(id,row.id,owner,owner,id==='wa:rejected'?1:0);
    f.store.output(undefined,'A reply','task-contract-reply:wa:accepted',owner,{plain:true});
    f.store.output(undefined,'Finish or cancel first','task-contract-reply:wa:rejected',owner,{plain:true});
    f.detector.recoverInputs();
    const evidence=f.store.db.prepare('SELECT response_id,state FROM stuck_quoted_replies ORDER BY response_id').all() as any[];
    assert.deepEqual(evidence.map(row=>({...row})),[{response_id:'wa:accepted',state:'accepted'}]);
  }finally{f.close();}
});

test('pending choice input does not hold an unrelated idle alert',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Choice');f.add('wa:idle','Other task');
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:3600}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);
    f.store.db.prepare("INSERT INTO stuck_quoted_replies(response_id,outbox_id,owner,destination,state) VALUES(?,?,?,?,'pending')").run('wa:processing',row.id,owner,owner);
    f.advance(11*60_000);await f.detector.tick();
    assert.deepEqual(alerts(f.store).map(a=>a.kind),['idle']);
    assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'ready');
  }finally{f.close();}
});

test('an expired contract control is not treated as an answer to another choice',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');f.router.pump=()=>{};f.store.set('active',f.binding.id);
    f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true,taskContracts:true}));
    f.router.contracts=new TaskContracts(f.store,f.router.brain.secret,async()=>({kind:'contract',goal:'Synthetic project',exclusions:[],checks:['One','Two'],question:''}));
    await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:pending',text:'Build a synthetic project',ownerCommand:true}));
    f.store.db.prepare('UPDATE task_contracts SET expires_at=1').run();
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);await f.detector.tick();
    const result=await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:ok',text:'ok',ownerCommand:true}));
    assert.equal(result.status,'handled');assert.equal(f.store.db.prepare('SELECT 1 FROM stuck_ambiguous_choices WHERE response_id=?').get('wa:ok'),undefined);
    assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'ready');
  }finally{f.close();}
});

test('a reviewed explicit session reply suppresses only that session choice',async()=>{
  for(const toOther of [false,true]){const f=fixture();try{
    f.add('wa:choice','Synthetic task');f.router.pump=()=>{};f.store.set('active',f.binding.id);
    const other=f.store.register('other','codex',randomUUID(),'/tmp').binding;
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);await f.detector.tick();
    f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true,taskContracts:true}));
    f.router.contracts=new TaskContracts(f.store,f.router.brain.secret,async()=>({kind:'contract',goal:'Synthetic project',exclusions:[],checks:['One','Two'],question:''}));
    const result=await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:answer',text:`/to ${toOther?other.alias:f.binding.alias} Friday works`,ownerCommand:true}));
    assert.equal(result.status,'handled');assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),toOther?'ready':'invalid');
    f.store.db.prepare("UPDATE task_contracts SET state='cancelled' WHERE origin_id=?").run('wa:answer');
    assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'ready');
  }finally{f.close();}}
});

test('an explicit target rejected by an existing F3 review leaves its choice unanswered',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');f.router.pump=()=>{};f.store.set('active',f.binding.id);
    f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true,taskContracts:true}));
    f.router.contracts=new TaskContracts(f.store,f.router.brain.secret,async()=>({kind:'contract',goal:'Synthetic project',exclusions:[],checks:['One','Two'],question:''}));
    await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:pending',text:'Build a synthetic project',ownerCommand:true}));
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);await f.detector.tick();
    await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:answer',text:`/to ${f.binding.alias} Friday works`,ownerCommand:true}));
    assert.equal(f.store.db.prepare('SELECT 1 FROM stuck_ambiguous_choices WHERE response_id=?').get('wa:answer'),undefined);
    assert.equal(f.detector.deliveryState(alertOut(f.store)[0],owner),'ready');
  }finally{f.close();}
});

test('a blank quoted message does not suppress a choice notice',async()=>{
  const f=fixture();try{
    f.add('wa:choice','Synthetic task');
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);
    const result=await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:blank',text:'   ',quotedId:row.wa_id,ownerCommand:false,ownerChoice:true}));
    assert.equal(result.status,'ignored');assert.equal(f.store.db.prepare('SELECT 1 FROM stuck_quoted_replies').get(),undefined);
    await f.detector.tick();assert.equal(alerts(f.store)[0]?.kind,'choice');
  }finally{f.close();}
});

test('an ambiguous same-task or unlinked follow-up fails closed, but another item or binding does not suppress a choice',async()=>{
  for(const which of ['same','unlinked','other-item','other-binding'] as const){
    const f=fixture();try{
      const item=f.add('wa:choice','Synthetic task');
      f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
      const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);
      const target=which==='other-binding'?f.store.register('other','codex',randomUUID(),'/tmp').binding:f.binding;
      f.store.recordOwnerOrigin('wa:followup',owner,owner);f.store.enqueue('wa:followup',target,'Free text',owner);
      const other=which==='other-item'?f.add('wa:other','Another task').id:item.id;if(which!=='unlinked')f.store.linkItem('wa:followup',other);
      f.store.db.prepare('UPDATE inbox SET received_at=? WHERE id=?').run(row.sent_at??Date.now(),'wa:followup');
      await f.detector.tick();assert.equal(alerts(f.store).filter(a=>a.kind==='choice').length,which==='same'||which==='unlinked'?0:1,which);
    }finally{f.close();}
  }
});

test('a quoted free-text reply remains suppressed after restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-stuck-quoted-')),path=join(dir,'test.sqlite'),f=fixture(path);
  try{
    f.add('wa:choice','Synthetic task');f.router.pump=()=>{};
    f.store.output(f.binding,'Choose','synthetic-choice',owner,{requestId:'wa:choice',kind:'progress',origin:'agent',options:{choices:[{id:'a',label:'First'},{id:'b',label:'Second'}],expiresInSeconds:60}});
    const row=f.store.db.prepare("SELECT * FROM outbox WHERE source='synthetic-choice:0'").get() as any;f.store.sent(row.id);
    await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:answer',text:'My own answer',quotedId:row.wa_id,ownerCommand:false,ownerChoice:true}));
    const now=f.now();f.close();
    const store=new Store(path),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
    try{const detector=new StuckDetection(store,router,async()=>{throw new Error('No notice expected');},()=>now);await detector.tick();assert.equal(alerts(store).length,0);}
    finally{approvals.cancel();store.close();}
  }finally{try{f.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});

test('an unbound prompt is never attributed to a task',async()=>{
  const f=fixture();try{f.add('wa:one','Task');void f.approvals.ask(f.binding,'An unbound prompt');await f.detector.tick();assert.equal(alerts(f.store).length,0);}finally{f.close();}
});

test('a pending approval is not attributed to a replaced session or changed route',async()=>{
  for(const change of ['native','route','registry']){
    const f=fixture();try{
      f.add('wa:one','Task');void f.store.destinationContext.run(owner,()=>f.approvals.ask(f.binding,'Permission?','approval','wa:one'));
      if(change==='native')f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),f.binding.id);
      if(change==='route')f.store.set(`session-route:${f.binding.id}`,JSON.stringify({transport:'different'}));
      if(change==='registry')f.store.set('coordinator-registry',JSON.stringify([{bindingId:f.binding.id,key:'different'}]));
      await f.detector.tick();assert.equal(alerts(f.store).length,0,change);
    }finally{f.close();}
  }
});

test('unverifiable optional alert identity never prevents a native prompt',async()=>{
  const f=fixture();try{
    f.add('wa:one','Task');f.store.set('coordinator-registry','not-json');
    const pending=f.store.destinationContext.run(owner,()=>f.approvals.ask(f.binding,'Permission?','approval','wa:one'));
    assert.equal(f.approvals.pending.size,1);await f.detector.tick();assert.equal(alerts(f.store).length,0);
    f.approvals.cancel();assert.equal(await pending,'deny');
  }finally{f.close();}
});

test('a completed child does not hide a still-running parent or its exact approval',async()=>{
  for(const pending of [false,true]){
    const f=fixture();try{
      const item=f.add('wa:parent','Task');f.store.set('parent:master:child','wa:parent');
      f.store.enqueue('master:child',f.binding,'Completed child',owner);f.store.linkItem('master:child',item.id);f.store.jobState('master:child','completed');
      if(pending)void f.store.destinationContext.run(owner,()=>f.approvals.ask(f.binding,'Permission?','approval','wa:parent'));
      f.advance(10*60_000+10_000);await f.detector.tick();
      assert.equal(alerts(f.store).length,1);assert.equal(alerts(f.store)[0].request_id,'wa:parent');assert.equal(alerts(f.store)[0].kind,pending?'approval':'idle');
    }finally{f.close();}
  }
});

test('owner or evidence changes during model inference prevent alert creation',async()=>{
  for(const change of ['owner','owner-returned','progress','policy','key']){
    const f=fixture();try{
      f.add('wa:one','Task');f.advance(10*60_000+10_000);let release!:()=>void,started!:()=>void;
      const pending=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r);
      const detector=new StuckDetection(f.store,f.router,async()=>{started();await pending;return 'A task needs your attention.';},f.now);
      const ticking=detector.tick();await entered;
      if(change==='owner')f.store.set('whatsapp-owner','new@s.whatsapp.net');
      if(change==='owner-returned'){f.store.set('whatsapp-owner','new@s.whatsapp.net');f.store.set('whatsapp-owner',owner);}
      if(change==='policy')f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:false}));
      if(change==='key')f.router.brain.secret.save('different-synthetic-stuck-key');
      if(change==='progress')f.store.db.prepare('UPDATE inbox SET updated_at=? WHERE id=?').run(f.now(),'wa:one');
      release();await ticking;assert.equal(alerts(f.store).length,0,change);
    }finally{f.close();}
  }
});

test('expired unsent alert can be replaced, but uncertain delivery never is',async()=>{
  for(const mode of ['queued','cancelled','uncertain','sent']){
    const f=fixture();try{
      f.add('wa:one','Task');f.advance(10*60_000+10_000);await f.detector.tick();
      const old=alertOut(f.store)[0],oldToken=alerts(f.store)[0].id;
      if(mode==='sent')f.store.sent(old.id);
      if(mode==='cancelled')f.store.db.prepare("UPDATE outbox SET status='cancelled' WHERE id=?").run(old.id);
      if(mode==='uncertain')f.store.db.prepare("UPDATE outbox SET status='uncertain',attempts=1 WHERE id=?").run(old.id);
      f.advance(10*60_000+10_000);await f.detector.tick();
      assert.equal(alerts(f.store).length,1);assert.equal(alertOut(f.store).length,1);
      if(mode==='queued'||mode==='cancelled'){assert.notEqual(alerts(f.store)[0].id,oldToken);assert.notEqual(alertOut(f.store)[0].id,old.id);}
      else{assert.equal(alerts(f.store)[0].id,oldToken);assert.equal(alertOut(f.store)[0].id,old.id);}
    }finally{f.close();}
  }
});

test('dismissal is owner bound, expires and never approves native work',async()=>{
  const f=fixture();try{
    f.add('wa:one','Task');f.advance(10*60_000+10_000);await f.detector.tick();
    const alert=alerts(f.store)[0],row=alertOut(f.store)[0],command=(id:string)=>({id,text:`/stuck dismiss ${alert.id}`,ownerCommand:true});
    assert.match(f.detector.dismiss(command('wa:first'))!,/unavailable|expired/i);
    f.store.sent(row.id);assert.match(f.detector.dismiss(command('wa:second'))!,/dismissed/i);
    assert.match(f.detector.dismiss(command('wa:third'))!,/already dismissed/i);
    assert.equal(f.store.job('wa:one')?.status,'submitted');
    assert.match(f.detector.dismiss({...command('wa:quoted'),quotedId:'some-other-message'})!,/new text message/i);
    f.advance(10*60_000+10_000);assert.match(f.detector.dismiss(command('wa:expired'))!,/expired/i);
  }finally{f.close();}
});

test('typed dismissal is handled once by the real Router without scheduling work',async()=>{
  const f=fixture();try{
    f.add('wa:one','Task');f.advance(10*60_000+10_000);await f.detector.tick();
    const alert=alerts(f.store)[0];f.store.sent(alertOut(f.store)[0].id);
    const input={id:'wa:dismiss',text:`/stuck dismiss ${alert.id}`,ownerCommand:true};
    const first=await f.store.destinationContext.run(owner,()=>f.router.receive(input));
    const replay=await f.store.destinationContext.run(owner,()=>f.router.receive(input));
    assert.equal(first.status,'handled');assert.equal(replay.status,'ignored');
    assert.equal(f.store.job('wa:dismiss'),undefined);assert.equal(alerts(f.store)[0].state,'dismissed');
  }finally{f.close();}
});

test('idle threshold is configurable only by a typed owner command',async()=>{
  const f=fixture();try{
    assert.match(f.detector.dismiss({id:'wa:config',text:'/stuck interval 20',ownerCommand:true})!,/20 minutes/);
    assert.match(f.detector.dismiss({id:'wa:voice',text:'/stuck interval 1',source:'voice',ownerCommand:false})!,/new text message/);
    assert.match(f.detector.dismiss({id:'wa:bad',text:'/stuck interval 0',ownerCommand:true})!,/between 1 and 1440/);
    f.add('wa:one','Task');f.advance(10*60_000+10_000);await f.detector.tick();assert.equal(alerts(f.store).length,0);
    f.advance(10*60_000);await f.detector.tick();assert.equal(alerts(f.store).length,1);
  }finally{f.close();}
});

test('repeated known errors are distinguished from unrelated or unknown failures',async()=>{
  const f=fixture();try{
    f.add('wa:one','Task');f.store.jobState('wa:one','failed','permission denied');
    f.store.jobState('wa:one','uncertain','permission denied again');await f.detector.tick();
    assert.equal(alerts(f.store)[0]?.kind,'repeated-error');assert.match(alertOut(f.store)[0].body,/same recorded error category/);
  }finally{f.close();}
});

test('WhatsApp cancels stale notices before send and never retries an uncertain send',async()=>{
  for(const mode of ['owner','owner-returned','destination','progress','network','restart']){
    const f=fixture();try{
      f.add('wa:one','Task');f.advance(10*60_000+10_000);await f.detector.tick();
      const row=alertOut(f.store)[0],wa=new WhatsApp(f.store,f.router);wa.status='connected';wa.selfJid=owner;wa.owners=[owner];let calls=0;
      wa.sock={sendMessage:async()=>{calls++;if(mode==='network')throw Error('synthetic lost response');return {};},end:()=>{}} as any;
      if(mode==='owner')f.store.set('whatsapp-owner','new@s.whatsapp.net');
      if(mode==='owner-returned'){f.store.set('whatsapp-owner','new@s.whatsapp.net');f.store.set('whatsapp-owner',owner);}
      if(mode==='destination')f.store.db.prepare('UPDATE outbox SET destination=? WHERE id=?').run('other@g.us',row.id);
      if(mode==='progress')f.store.db.prepare('UPDATE inbox SET updated_at=? WHERE id=?').run(f.now(),'wa:one');
      if(mode==='restart'){f.store.db.prepare("UPDATE outbox SET status='sending',attempts=1 WHERE id=?").run(row.id);f.store.recover();}
      await wa.flush();const state=(f.store.db.prepare('SELECT status FROM outbox WHERE id=?').get(row.id) as any).status;
      if(mode==='owner'||mode==='owner-returned'||mode==='destination'||mode==='progress'){assert.equal(calls,0);assert.equal(state,'cancelled');}
      else {assert.equal(state,'uncertain');await wa.flush();assert.equal(calls,mode==='network'?1:0);}
      wa.close();
    }finally{f.close();}
  }
});

test('over a hundred revoked alerts do not block replies or channel-held schedules',async()=>{
  const f=fixture();try{
    for(let i=0;i<105;i++)f.add(`wa:held-${i}`,`Task ${i}`);
    f.advance(10*60_000+10_000);for(let i=0;i<35;i++)await f.detector.tick();
    assert.equal(alertOut(f.store).length,105);
    const schedules:string[]=[];
    for(let i=0;i<3;i++){
      f.store.output(undefined,'Held schedule',`scheduled-held-${i}`,owner,{plain:true});
      const row=f.store.db.prepare('SELECT id FROM outbox WHERE source=?').get(`scheduled-held-${i}:0`) as {id:string};
      schedules.push(row.id);
      f.store.db.prepare('INSERT INTO schedule_outbox VALUES(?,?,?,?,?)').run(row.id,`synthetic-occurrence-${i}`,owner,owner,'whatsapp');
    }
    const group='owned@g.us';f.store.set('destination-jid',group);f.store.set(`owned-group:${group}`,'true');
    f.store.set('control-channel','telegram');
    f.store.output(undefined,'Ordinary reply','ordinary-group',group,{plain:true});
    const wa=new WhatsApp(f.store,f.router);wa.status='connected';wa.selfJid=owner;wa.owners=[owner];
    const sent:string[]=[];wa.verifyGroup=async()=>{};wa.sock={sendMessage:async(destination:string)=>{sent.push(destination);return {};},end:()=>{}} as any;
    await wa.flush();assert.deepEqual(sent,[group]);
    assert.equal(alertOut(f.store).filter(row=>row.status==='cancelled').length,105);
    for(const id of schedules)assert.equal((f.store.db.prepare('SELECT status FROM outbox WHERE id=?').get(id) as any).status,'queued');
    f.store.set('control-channel','whatsapp');await wa.flush();
    for(const id of schedules)assert.equal((f.store.db.prepare('SELECT status FROM outbox WHERE id=?').get(id) as any).status,'sent');
    assert.equal(alertOut(f.store).filter(row=>row.status==='cancelled').length,105);
    f.store.set('destination-jid',owner);for(let i=0;i<21;i++)await wa.flush();
    assert.equal(sent.filter(destination=>destination===owner).length,3);
    assert.equal(alertOut(f.store).filter(row=>row.status==='sent').length,0);
    wa.close();
  }finally{f.close();}
});

test('a hold detected on the final alert recheck does not block another message',async()=>{
  const f=fixture();try{
    f.add('wa:one','Task');f.advance(10*60_000+10_000);await f.detector.tick();
    f.store.output(undefined,'Another reply','ordinary-self',owner,{plain:true});
    const original=f.detector.deliveryState.bind(f.detector);let checks=0;
    f.detector.deliveryState=(row,self)=>++checks===2?'hold':original(row,self);
    const wa=new WhatsApp(f.store,f.router);wa.status='connected';wa.selfJid=owner;wa.owners=[owner];let sends=0;
    wa.sock={sendMessage:async()=>{sends++;return {};},end:()=>{}} as any;
    await wa.flush();assert.equal(sends,1);assert.equal(alertOut(f.store)[0].status,'queued');
    await wa.flush();assert.equal(sends,2);assert.equal(alertOut(f.store)[0].status,'sent');wa.close();
  }finally{f.close();}
});

test('rotating pages limit notification bursts, reach later items and deduplicate incidents',async()=>{
  const f=fixture();try{
    for(let i=0;i<101;i++)f.add(`wa:${i}`,`Task ${i}`);
    f.advance(10*60_000+10_000);await f.detector.tick();assert.equal(alerts(f.store).length,3);
    for(let i=0;i<33;i++)await f.detector.tick();assert.equal(alerts(f.store).length,101);
    await f.detector.tick();await f.detector.tick();assert.equal(alerts(f.store).length,101);
  }finally{f.close();}
});
