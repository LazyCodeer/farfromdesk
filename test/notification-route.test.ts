import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

test('fresh coordinator role and local HTTP replies suppress repeats without hiding new findings',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'ffd-notification-route-'));
  const probe=createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));
  const port=(probe.address() as any).port;await new Promise<void>(r=>probe.close(()=>r()));
  process.env.WSB_STATE_DIR=temp;process.env.WSB_PORT=String(port);
  const [{Store},{Router},{Coordinator},{Approvals},{serve},{runFfd}]=await Promise.all([
    import('../src/store.js'),import('../src/router.js'),import('../src/coordinator.js'),import('../src/approvals.js'),import('../src/server.js'),import('../src/ffd.js')]);
  const store=new Store(':memory:'),approvals=new Approvals(store);
  const native={run:async()=>{},stop:()=>{},catalog:async()=>({sessions:[],cursor:null})} as any;
  const router=new Router(store,native,approvals);router.pump=()=>{};
  const master=store.register('test-master','codex','11111111-1111-4111-a111-111111111111','/tmp','channel');
  const worker=store.register('test-worker','claude','22222222-2222-4222-a222-222222222222','/tmp','channel');
  store.set('master',master.binding.id);store.set('whatsapp-owner','owner@s.whatsapp.net');
  const coordinator=new Coordinator(store,native,router,()=>{});router.coordinator=coordinator;
  store.enqueue('tg:root',master.binding,'Check the notification fix','tg:owner');
  const fresh=router.channelPoll(master.binding,'test-client');
  assert.match(fresh!.body,/quiet acknowledgment, not a rewritten summary/);
  const server=serve(store,router,{status:'not paired'} as any,'test-admin',{masters:{options:()=>({}),platformPreferences:()=>[]} as any,power:{view:()=>({})} as any});
  await new Promise<void>(r=>server.once('listening',r));
  const call=(who:typeof master)=>async(path:string,data?:unknown)=>{
    const response=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{Authorization:`Bearer ${who.token}`,'X-Binding-Id':who.binding.id,'Content-Type':'application/json'},body:JSON.stringify(data)});
    const result=await response.json() as any;if(!response.ok)throw new Error(result.error);return result;
  };
  try {
    store.enqueue('master:child',worker.binding,'Verify the fix','tg:owner');store.set('parent:master:child','tg:root');
    const findings='✅ *Done*\n- Notification tests passed.\n- The app has not been launched.';
    await runFfd(['reply','master:child','final',findings],worker.binding,call(worker),()=>'');
    for(const row of store.db.prepare('SELECT id FROM outbox').all() as {id:string}[])store.sent(row.id);
    const count=()=>Number(store.db.prepare('SELECT COUNT(*) n FROM outbox').get()!.n);
    const before=count();
    const duplicate=await runFfd(['reply','tg:root','progress','📋 *Summary*\nNotification tests passed.\nThe app has not been launched.'],master.binding,call(master),()=>'');
    assert.match(duplicate,/No message queued/);assert.equal(count(),before);
    assert.notEqual(store.job('tg:root')!.status,'completed');
    assert.equal(store.events('tg:root').some((e:any)=>e.event==='duplicate_coordinator_suppressed'),true);
    const report='report:master:child';
    await assert.rejects(call(master)('/api/session/reply',{requestId:report,kind:'final',text:'Done',outcome:'done'}),/final marker/);
    assert.notEqual(store.job('tg:root')!.status,'completed');
    await runFfd(['reply','tg:root','progress',findings+'\nNew blocker: installer is unavailable.'],master.binding,call(master),()=>'');
    assert.equal(count(),before+1);
    const ack=await call(master)('/api/session/reply',{requestId:report,kind:'final',text:'Acknowledged'});
    assert.equal(ack.acknowledged,true);assert.equal(count(),before+1);
    await assert.rejects(runFfd(['reply','tg:root','final','✅ *Done*'],master.binding,call(master),()=>''),/final marker/);
    await runFfd(['reply','tg:root','final','Notification tests passed, and the installer blocker is recorded. Installation still needs verification.'],master.binding,call(master),()=>'');
    assert.equal(count(),before+2);assert.equal(store.job('tg:root')!.status,'completed');
  }finally{await new Promise<void>(r=>server.close(()=>r()));approvals.cancel();store.close();rmSync(temp,{recursive:true,force:true});}
});
