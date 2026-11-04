import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Coordinator } from '../src/coordinator.js';
import { Approvals } from '../src/approvals.js';
import { queueOwnerReceipt, receiptState, formatWhatsAppMessage, sessionMeta } from '../src/coordinator-experience.js';
import { turnEnvelope, roleConfig, coordinatorRoleStatus, updateRole } from '../src/roles.js';

const uuid=(n:number)=>`11111111-1111-4111-a111-${String(n).padStart(12,'0')}`;
function fixture(file=':memory:') {
  const store=new Store(file),approvals=new Approvals(store);
  const native={catalog:async()=>({sessions:[],cursor:null}),run:async()=>{},stop:()=>{}};
  const router=new Router(store,native as any,approvals),coordinator=new Coordinator(store,native as any,router,()=>{});
  router.coordinator=coordinator;
  // Receipts probe app liveness; pin it so the text does not depend on which apps are open.
  router.livenessProbe=()=>({codex:true,claude:true});
  const master=store.register('master','codex',uuid(1),'/tmp/master','channel').binding;
  store.set('master',master.id);store.set('whatsapp-owner','owner@s.whatsapp.net');
  return {store,router,native,master,close:()=>{router.stopped=true;approvals.cancel();store.close();}};
}

test('receipt is durable before dispatch, stays system-only and does not finish the request',async()=>{
  const f=fixture();
  try {
    f.store.db.prepare("UPDATE bindings SET mode='desktop' WHERE id=?").run(f.master.id);
    let called=false;
    f.native.run=async()=>{called=true;assert.equal(receiptState(f.store,'wa:hello')?.status,'queued');};
    assert.equal((await f.router.receive({id:'wa:hello',text:'Check my project'})).status,'queued');
    assert.equal(called,true);
    const j=f.store.job('wa:hello')!;
    assert.notEqual(j.status,'completed');assert.equal(j.first_reply_at,null);assert.equal(j.final_reply_at,null);
    const row=f.store.db.prepare('SELECT * FROM outbox').get() as any;
    assert.equal(row.request_id,j.id);assert.equal(row.destination,'owner@s.whatsapp.net');assert.equal(row.reply_kind,'system');
    // A receipt is one plain status line: no session heading, no footer, and no promise of work.
    assert.equal(row.body,'⏳ Queued for Codex CLI. Waiting for it to start.');
    assert.doesNotMatch(row.body,/— FarFromDesk|Session:|Got your message/);
    await f.router.receive({id:'wa:hello',text:'Check my project'});
    assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get() as any).n,1);
  }finally{f.close();}
});

test('receipt survives restart without replay and final answer remains independently deliverable',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-receipt-'));const f=fixture(join(dir,'state.db'));
  let reloaded:Store|undefined;
  try {
    await f.router.receive({id:'wa:restart',text:'Check the build'});
    const row=f.store.db.prepare('SELECT * FROM outbox').get() as any;f.store.sent(row.id);
    f.store.close();reloaded=new Store(join(dir,'state.db'));
    assert.equal(queueOwnerReceipt(reloaded,'wa:restart',f.master),false);
    assert.equal(receiptState(reloaded,'wa:restart')?.status,'sent');
    reloaded.output(f.master,'Build verified.','answer:restart','owner@s.whatsapp.net',{requestId:'wa:restart',kind:'final',origin:'agent',turnId:'real-turn'});
    assert.equal((reloaded.db.prepare('SELECT COUNT(*) n FROM outbox').get() as any).n,2);
    assert.ok(reloaded.job('wa:restart')!.final_reply_at);
  }finally{reloaded?.close();rmSync(dir,{recursive:true,force:true});}
});

test('no owner receipt for reports, delegated tasks, direct workers, invalid or paused routing',async()=>{
  const f=fixture();
  try {
    const worker=f.store.register('worker','claude',uuid(2),'/tmp/worker','channel').binding;
    for(const id of ['report:old','master:child','local:test'])f.router.queue(id,f.master,'Fixture');
    await f.router.receive({id:'wa:worker',text:'/to worker Work'});
    await f.router.receive({id:'wa:empty',text:' '});
    f.store.enable(f.master.id,false);
    assert.equal((await f.router.receive({id:'wa:paused',text:'Work'})).status,'blocked');
    assert.equal((f.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE source LIKE 'owner-receipt:%'").get() as any).n,0);
    assert.equal(f.store.job('wa:worker')?.binding_id,worker.id);
  }finally{f.close();}
});

test('slow discovery acknowledges before catalog completes and simultaneous duplicate does not browse twice',async()=>{
  const f=fixture();let release!:()=>void,calls=0;const hold=new Promise<void>(r=>release=r);
  try {
    f.store.set('enabled-apps','["codex"]');
    f.native.catalog=async()=>{calls++;await hold;return {sessions:[],cursor:null};};
    const work=f.router.receive({id:'wa:list',text:'/sessions'});
    assert.equal(receiptState(f.store,'wa:list')?.status,'queued');
    assert.equal((await f.router.receive({id:'wa:list',text:'/sessions'})).status,'ignored');
    release();await work;assert.equal(calls,1);
    assert.equal(f.store.job('wa:list'),undefined);
    assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get() as any).n,2);
  }finally{release();f.close();}
});

test('audio receipt is reused and incoming destination remains frozen',async()=>{
  const f=fixture();
  try {
    f.store.output(undefined,'Voice note received. Transcribing locally.','audio-progress:wa:voice','owner@s.whatsapp.net');
    await f.router.receive({id:'wa:voice',text:'Transcribed command'});
    assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get() as any).n,1);
    await f.store.destinationContext.run('approved@g.us',()=>f.router.receive({id:'wa:group',text:'Check current work'}));
    f.store.set('destination-jid','different@g.us');
    const row=f.store.db.prepare("SELECT destination FROM outbox WHERE source='owner-receipt:wa:group:0'").get() as any;
    assert.equal(row.destination,'approved@g.us');
  }finally{f.close();}
});

test('queue and receipt rollback together if receipt persistence fails',()=>{
  const f=fixture();
  try {
    f.store.output=()=>{throw new Error('simulated disk error');};
    assert.throws(()=>f.router.queue('wa:atomic',f.master,'Work'),/disk error/);
    assert.equal(f.store.job('wa:atomic'),undefined);
  }finally{f.close();}
});

test('coordinator role version sends once, keeps the receipt state and renews on revision or session change',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-role-exp-')),f=fixture();
  try {
    f.router.queue('wa:first',f.master,'Check work');
    assert.equal(coordinatorRoleStatus(f.store).state,'pending');
    const first=turnEnvelope(f.store,f.master,'Check work','wa:first',{},[],dir);
    assert.match(first.body,/# FarFromDesk Coordinator/);assert.doesNotMatch(first.body,/"receipt"/);
    first.acknowledge();assert.equal(coordinatorRoleStatus(f.store).state,'sent');
    const next=turnEnvelope(f.store,f.master,'Next','wa:next',{},[],dir);
    assert.doesNotMatch(next.body,/# FarFromDesk Coordinator/);assert.match(next.body,/reread if context was lost: \//);
    updateRole(f.store,f.master,'professional');assert.equal(coordinatorRoleStatus(f.store).state,'pending');
    assert.match(turnEnvelope(f.store,f.master,'Next','wa:changed',{},[],dir).body,/role updated to/);
    const changed={...f.master,native_id:uuid(3)};
    assert.match(turnEnvelope(f.store,changed,'New session','wa:new',{},[],dir).body,/role bootstrap/);
    // Sent once per session and version, then only referenced; message templates and examples make it long.
    assert.ok(roleConfig(f.store,f.master).instructions.length<24000);
  }finally{f.close();rmSync(dir,{recursive:true,force:true});}
});

test('the answer leads and the metadata tail names provider and chat',()=>{
  const meta=['✳️ Provider: Claude Desktop','💬 Session Name: billing fix'];
  assert.equal(formatWhatsAppMessage('Received.','master',true,1,1,'final',{meta}),'Received.\n\n✳️ Provider: Claude Desktop\n💬 Session Name: billing fix');
  // A continuation bubble carries no tail at all, so a run never repeats provenance.
  assert.equal(formatWhatsAppMessage('Result','Website redesign',false),'Result');
  assert.match(formatWhatsAppMessage('Details','Worker',false,2,3),/\(2\/3\)/);
  // A footer the model copied from an old template is stripped, never doubled.
  assert.equal(formatWhatsAppMessage('Done.\n\n— FarFromDesk · Coordinator','master',true),'Done.');
});

test('a chat title cannot inject markdown or bidi marks into the metadata tail',()=>{
  const store=new Store(':memory:');
  try {
    const b=store.register('master','claude','33333333-3333-4333-a333-000000000001','/tmp/master','channel').binding;
    store.set('name:'+b.id,'*Other*\n\u202eActor');
    const meta=sessionMeta(store,b);
    assert.doesNotMatch(meta.name,/[\u202e*\n]/);
    assert.equal(meta.provider,'Claude CLI');
    assert.equal(meta.icon,'✳️');
  } finally { store.close(); }
});

test('progress updates carry one marker and results carry none',()=>{
  assert.match(formatWhatsAppMessage('Checking the logs.','',false,1,1,'progress'),/^📝 Checking the logs\./);
  assert.equal(formatWhatsAppMessage('The tests have not run.','',false,1,1,'final'),'The tests have not run.');
  // An answer that already opens with its own emoji is left exactly as written.
  assert.equal(formatWhatsAppMessage('⚠️ *Sign-in required*\nUse the native app.','',false,1,1,'final'),'⚠️ *Sign-in required*\nUse the native app.');
});

test('outbox leads with the answer, tails with provenance, and still deduplicates retries',()=>{
 const f=fixture();try{
  f.store.set('execution-mode:'+f.master.id,'desktop');
  f.store.set('name:'+f.master.id,'Billing API');
  f.store.enqueue('wa:plain',f.master,'Please check this');
  const context={requestId:'wa:plain',kind:'final' as const,origin:'agent' as const};
  assert.equal(f.store.output(f.master,'Unable to proceed.','plain-event','owner@s.whatsapp.net',context),true);
  assert.equal(f.store.output(f.master,'Unable to proceed.','plain-event','owner@s.whatsapp.net',context),false);
  const out=f.store.outbound();
  assert.equal(out.body,'Unable to proceed.\n\n🤖 Provider: Codex Desktop\n💬 Session Name: Billing API');
  const next=f.store.output(f.master,'Second answer.','plain-event-2','owner@s.whatsapp.net',context);
  assert.equal(next,true);
  const rows=f.store.db.prepare('SELECT body FROM outbox ORDER BY created_at').all() as {body:string}[];
  assert.equal(rows[1].body,'Second answer.\n\n🤖 Codex Desktop');
 }finally{f.close();}
});
