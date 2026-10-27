import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Coordinator } from '../src/coordinator.js';
import { Approvals } from '../src/approvals.js';
import { namedItem, DIRECT_IDLE_MS } from '../src/owner-routing.js';
import { inProject } from '../src/masters.js';

function fixture() {
  const store=new Store(':memory:');store.set('whatsapp-owner','owner@s.whatsapp.net');
  const approvals=new Approvals(store),native={catalog:async()=>({sessions:[],cursor:null}),validate:async()=>{},run:async()=>{},stop:()=>{}};
  const router=new Router(store,native as any,approvals),c=new Coordinator(store,native as any,router,()=>{});router.coordinator=c;router.pump=()=>{};
  const proxy=store.register('proxy','codex',randomUUID(),'/tmp').binding;
  store.set(`execution-mode:${proxy.id}`,'desktop');store.set(`session-route:${proxy.id}`,JSON.stringify({provider:'codex',executionMode:'desktop',profileId:'codex:desktop',accountScope:'o',transport:'native-session'}));c.registry.register(proxy);
  const worker=store.register('billing','codex',randomUUID(),'/tmp/billing').binding;
  store.set(`name:${worker.id}`,'Billing API');store.set(`execution-mode:${worker.id}`,'desktop');store.set('selected',JSON.stringify([worker.id]));
  const outbox=()=>store.db.prepare('SELECT body,request_id FROM outbox ORDER BY rowid').all() as {body:string;request_id:string}[];
  return {store,router,c,proxy,worker,outbox,close(){router.stopped=true;approvals.cancel();store.close();}};
}

test('every hand-off lands on an item, worker results update it and replies lead with its number',async()=>{
  const f=fixture();try {
    await f.router.receive({id:'wa:1',text:'Fix the invoice export please'});
    assert.equal(f.store.job('wa:1')?.binding_id,f.proxy.id);
    const [child]=f.c.dispatch('wa:1',[f.worker.id],'Fix the invoice export.\nRun its tests.','e1');
    const item=f.c.items().get(1);
    assert.equal(item.title,'Fix the invoice export.');assert.equal(item.binding_id,f.worker.id);assert.equal(item.status,'in progress');
    assert.equal(f.store.itemOf(child),1);assert.equal(f.store.itemOf('wa:1'),1);
    // A second hand-off for the same request reuses the item.
    f.c.dispatch('wa:1',[f.worker.id],'Also check the CSV header.','e2');assert.equal(f.c.items().list().length,1);
    f.router.channelReply(f.worker,'✅ *Export fixed*\n- Tests pass.',"final",child);
    assert.match(f.c.items().show(1),/Billing API reported: Export fixed/);
    const reply=f.outbox().find(r=>r.request_id===child)!;
    assert.match(reply.body,/^\*#1 · Codex Desktop · Billing API\*/);
  }finally{f.close();}
});

test('a numbered follow-up goes to the item session, unknown or unowned items go to the proxy, paused owners are explained',async()=>{
  const f=fixture();try {
    await f.router.receive({id:'wa:1',text:'Fix the export'});f.c.dispatch('wa:1',[f.worker.id],'Fix the export','e1');
    await f.router.receive({id:'wa:2',text:'#1 also update the README'});
    assert.equal(f.store.job('wa:2')?.binding_id,f.worker.id);assert.equal(f.store.job('wa:2')?.body.includes('also update the README'),true);
    assert.equal(f.store.itemOf('wa:2'),1);assert.match(f.c.items().show(1),/went straight to Billing API/);
    await f.router.receive({id:'wa:3',text:'Item one, is it done?'});assert.equal(f.store.job('wa:3')?.binding_id,f.worker.id);
    await f.router.receive({id:'wa:4',text:'#9 what about this'});assert.equal(f.store.job('wa:4')?.binding_id,f.proxy.id);
    f.c.items().add('Plan the launch');
    await f.router.receive({id:'wa:5',text:'#2 start it'});assert.equal(f.store.job('wa:5')?.binding_id,f.proxy.id);assert.equal(f.store.itemOf('wa:5'),2);
    f.store.enable(f.worker.id,false);
    await f.router.receive({id:'wa:6',text:'#1 more'});assert.equal(f.store.job('wa:6'),undefined);
    // A paused owner is explained, not silently swapped for the proxy.
    assert.match(f.outbox().at(-1)!.body,/start #1 again/);
  }finally{f.close();}
});

test('direct mode hands the chat to one session until back or two quiet hours',async()=>{
  const f=fixture();try {
    await f.router.receive({id:'wa:1',text:'Let me talk to Billing API directly'});
    assert.deepEqual(f.c.direct('wa:1','Billing API'),{session:'Billing API',bindingId:f.worker.id});
    assert.match(f.outbox().at(-1)!.body,/Now talking to Billing API[\s\S]*say \*back\*/);
    await f.router.receive({id:'wa:2',text:'What are you working on?'});assert.equal(f.store.job('wa:2')?.binding_id,f.worker.id);
    await f.router.receive({id:'wa:3',text:'back'});assert.equal(f.store.job('wa:3'),undefined);assert.match(f.outbox().at(-1)!.body,/Back to your proxy/);
    await f.router.receive({id:'wa:4',text:'And now?'});assert.equal(f.store.job('wa:4')?.binding_id,f.proxy.id);
    // "back" with no direct session is an ordinary message for the proxy.
    await f.router.receive({id:'wa:5',text:'back'});assert.equal(f.store.job('wa:5')?.binding_id,f.proxy.id);
    f.c.direct('wa:4','billing');
    const key=f.store.db.prepare("SELECT key FROM settings WHERE key LIKE 'direct:%'").get() as {key:string};
    f.store.set(key.key,JSON.stringify({bindingId:f.worker.id,at:Date.now()-DIRECT_IDLE_MS-1}));
    await f.router.receive({id:'wa:6',text:'Still there?'});assert.equal(f.store.job('wa:6')?.binding_id,f.proxy.id);
    assert.throws(()=>f.c.direct('wa:6','Somebody else'),/not connected/);
    assert.throws(()=>f.router.talkDirect(f.proxy),/proxy/);
  }finally{f.close();}
});

test('item references parse digits and spoken numbers only at the start',()=>{
  assert.deepEqual(namedItem('#3 check it'),{id:3,rest:'check it'});
  assert.deepEqual(namedItem('item three: status?'),{id:3,rest:'status?'});
  assert.equal(namedItem('Give me item 3'),undefined);assert.equal(namedItem('item list please'),undefined);
});

test('a chat inside a git project cannot become a proxy',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-proj-'));
  try {
    mkdirSync(join(dir,'repo','.git'),{recursive:true});mkdirSync(join(dir,'repo','src'));
    assert.equal(inProject(join(dir,'repo','src')),true);assert.equal(inProject(dir),false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
