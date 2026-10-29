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

const owner='owner@s.whatsapp.net';
function fixture(){
  const store=new Store(':memory:'),approvals=new Approvals(store),native={run:async()=>{},stop:()=>{}};
  store.set('whatsapp-owner',owner);store.set('control-channel','whatsapp');
  store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true}));
  const router=new Router(store,native as any,approvals);router.brain.secret.save('synthetic-stuck-test-key-only');
  let now=Date.now(),inputs:unknown[]=[];
  const detector=new StuckDetection(store,router,async(kinds)=>{inputs.push(kinds);return 'A task needs your attention.';},()=>now);
  router.stuckDetection=detector;
  const binding=store.register('worker','codex',randomUUID(),'/tmp').binding;
  const add=(id:string,title:string)=>{
    store.recordOwnerOrigin(id,owner,owner);
    store.destinationContext.run(owner,()=>store.enqueue(id,binding,'Synthetic task',owner));
    const item=store.destinationContext.run(owner,()=>router.brain.memory.add(id,title));
    store.jobState(id,'submitted');return item;
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
  for(const change of ['owner','progress','policy','key']){
    const f=fixture();try{
      f.add('wa:one','Task');f.advance(10*60_000+10_000);let release!:()=>void,started!:()=>void;
      const pending=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r);
      const detector=new StuckDetection(f.store,f.router,async()=>{started();await pending;return 'A task needs your attention.';},f.now);
      const ticking=detector.tick();await entered;
      if(change==='owner')f.store.set('whatsapp-owner','new@s.whatsapp.net');
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
  for(const mode of ['owner','destination','progress','network','restart']){
    const f=fixture();try{
      f.add('wa:one','Task');f.advance(10*60_000+10_000);await f.detector.tick();
      const row=alertOut(f.store)[0],wa=new WhatsApp(f.store,f.router);wa.status='connected';wa.selfJid=owner;wa.owners=[owner];let calls=0;
      wa.sock={sendMessage:async()=>{calls++;if(mode==='network')throw Error('synthetic lost response');return {};},end:()=>{}} as any;
      if(mode==='owner')f.store.set('whatsapp-owner','new@s.whatsapp.net');
      if(mode==='destination')f.store.db.prepare('UPDATE outbox SET destination=? WHERE id=?').run('other@g.us',row.id);
      if(mode==='progress')f.store.db.prepare('UPDATE inbox SET updated_at=? WHERE id=?').run(f.now(),'wa:one');
      if(mode==='restart'){f.store.db.prepare("UPDATE outbox SET status='sending',attempts=1 WHERE id=?").run(row.id);f.store.recover();}
      await wa.flush();const state=(f.store.db.prepare('SELECT status FROM outbox WHERE id=?').get(row.id) as any).status;
      if(mode==='owner'||mode==='destination'||mode==='progress'){assert.equal(calls,0);assert.equal(state,'cancelled');}
      else {assert.equal(state,'uncertain');await wa.flush();assert.equal(calls,mode==='network'?1:0);}
      wa.close();
    }finally{f.close();}
  }
});

test('over a hundred held alerts and channel-held schedules do not block replies and resume safely',async()=>{
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
    assert.equal(alertOut(f.store).filter(row=>row.status==='queued').length,105);
    for(const id of schedules)assert.equal((f.store.db.prepare('SELECT status FROM outbox WHERE id=?').get(id) as any).status,'queued');
    f.store.set('control-channel','whatsapp');await wa.flush();
    for(const id of schedules)assert.equal((f.store.db.prepare('SELECT status FROM outbox WHERE id=?').get(id) as any).status,'sent');
    assert.equal(alertOut(f.store).filter(row=>row.status==='queued').length,105);
    f.store.set('destination-jid',owner);for(let i=0;i<21;i++)await wa.flush();
    assert.equal(sent.filter(destination=>destination===owner).length,108);
    assert.equal(alertOut(f.store).filter(row=>row.status==='sent').length,105);
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
