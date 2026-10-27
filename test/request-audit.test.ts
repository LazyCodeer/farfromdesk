import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Coordinator } from '../src/coordinator.js';
import { Approvals } from '../src/approvals.js';
import { WhatsApp } from '../src/whatsapp.js';
import { Workers } from '../src/workers.js';
import { safeEventDetails } from '../src/request-events.js';

function fixture(){
 const store=new Store(':memory:');store.set('whatsapp-owner','123@s.whatsapp.net');
 const a=store.register('master','codex','11111111-1111-4111-a111-111111111111','/tmp','channel').binding;
 const b=store.register('worker','claude','22222222-2222-4222-a222-222222222222','/tmp','channel').binding;
 const approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
 const coordinator=new Coordinator(store,router.native,router,()=>{});router.coordinator=coordinator;
 store.set('master',a.id);store.set('selected',JSON.stringify([b.id]));
 return {store,a,b,router,approvals,coordinator,close(){router.stopped=true;approvals.cancel();store.close();}};
}
const count=(s:Store)=>s.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n;

test('quiet acknowledgment keeps parent open until explicit guarded resolution; no duplicate summary',()=>{
 const f=fixture();try {
  f.store.enqueue('wa:p',f.a,'work');f.store.jobState('wa:p','submitted');
  const [child]=f.coordinator.dispatch('wa:p',[f.b.id],'work','one');
  assert.throws(()=>f.router.channelReply(f.a,'Done','final','wa:p'),/pending/);
  f.router.channelReply(f.b,'Finished','final',child,undefined,{outcome:'done'});
  const report=`report:${child}`,before=count(f.store);
  f.coordinator.quiet(report);assert.equal(f.store.job('wa:p')?.status,'submitted');
  f.router.resolveOwner('wa:p','done');assert.equal(f.store.job('wa:p')?.outcome,'done');
  f.router.resolveOwner('wa:p','done');assert.equal(count(f.store),before);
  assert.throws(()=>f.router.resolveOwner('wa:p','blocked'),/different/);
 }finally{f.close();}
});

test('quiet resolve is atomic and protects other workers, approvals, creation and reports',async()=>{
 const f=fixture();try {
  f.store.enqueue('wa:p',f.a,'work');
  const [one]=f.coordinator.dispatch('wa:p',[f.b.id],'one','one');
  const [two]=f.coordinator.dispatch('wa:p',[f.b.id],'two','two');
  f.router.channelReply(f.b,'One finished','final',one);
  assert.throws(()=>f.coordinator.quiet(`report:${one}`,'done'),/Finish/);
  assert.equal(f.store.job(`report:${one}`)?.status,'queued');
  f.router.channelReply(f.b,'Two finished','final',two);
  assert.throws(()=>f.coordinator.quiet(`report:${one}`,'done'),/Finish/);
  f.coordinator.quiet(`report:${two}`);
  f.router.hasPendingCreation=()=>true;assert.throws(()=>f.coordinator.quiet(`report:${one}`,'done'),/Finish/);
  f.router.hasPendingCreation=()=>false;
  const pending=f.approvals.ask(f.b,'Harmless permission fixture');
  assert.throws(()=>f.coordinator.quiet(`report:${one}`,'done'),/Finish/);
  f.approvals.cancel();await pending;
  f.coordinator.quiet(`report:${one}`,'done');
  assert.equal(f.store.job('wa:p')?.outcome,'done');
 }finally{f.close();}
});

test('quiet owner resolution cannot target foreign sessions or invent outcomes',()=>{
 const f=fixture();try{
  f.store.enqueue('wa:foreign',f.b,'other');assert.throws(()=>f.router.resolveOwner('wa:foreign','done'));
  f.store.enqueue('wa:p',f.a,'work');assert.throws(()=>f.router.resolveOwner('wa:p','success' as any));
  f.store.enqueue('report:foreign',f.b,'report');assert.throws(()=>f.coordinator.quiet('report:foreign','done'));
  f.store.enqueue('report:unknown',f.a,'report');assert.throws(()=>f.coordinator.quiet('report:unknown','done'),/verified/);
 }finally{f.close();}
});

test('new correlated progress clears stale failure without replay; later progress does not reopen final',()=>{
 const f=fixture();try {
  f.store.enqueue('wa:p',f.a,'work');f.store.jobState('wa:p','uncertain','Missing environment variable: SAMPLE_KEY');
  f.router.channelReply(f.a,'Continuing now','progress','wa:p','p1',{turnId:'turn-new'});
  const job=f.store.job('wa:p')!;assert.equal(job.status,'submitted');assert.equal(job.error,null);assert.match(job.last_error!,/SAMPLE_KEY/);
  f.router.channelReply(f.a,'Blocked here','final','wa:p','f1',{outcome:'blocked',turnId:'turn-new'});
  f.router.channelReply(f.a,'Late progress','progress','wa:p','p2',{turnId:'turn-new'});
  assert.equal(f.store.job('wa:p')?.status,'completed');assert.equal(f.store.job('wa:p')?.outcome,'blocked');
 }finally{f.close();}
});

test('reply identity cannot be reused across requests, turns, or changed content',()=>{
 const f=fixture();try {
  f.store.enqueue('wa:one',f.a,'one');f.store.enqueue('wa:two',f.a,'two');
  const ctx={requestId:'wa:one',kind:'progress' as const,turnId:'turn1',origin:'agent' as const};
  assert.equal(f.store.output(f.a,'working','event',undefined,ctx),true);
  assert.equal(f.store.output(f.a,'working','event',undefined,ctx),false);
  assert.throws(()=>f.store.output(f.a,'working','event',undefined,{...ctx,requestId:'wa:two'}));
  assert.throws(()=>f.store.output(f.a,'working','event',undefined,{...ctx,turnId:'turn2'}));
  assert.throws(()=>f.store.output(f.a,'changed','event',undefined,ctx));
  f.router.channelReply(f.a,'working','progress','wa:one','x',{turnId:'turn2'});
  f.router.channelReply(f.a,'working','progress','wa:one','x',{turnId:'turn3'});
  assert.equal(count(f.store),3);
 }finally{f.close();}
});

test('hook deduplication requires exact request and real turn; another request survives',()=>{
 const f=fixture();try {
  f.store.enqueue('wa:one',f.a,'one');f.store.enqueue('wa:two',f.a,'two');
  f.router.channelReply(f.a,'The requested check passed.','final','wa:one','direct',{turnId:'turn1'});
  assert.equal(f.store.output(f.a,'Longer native summary','h1',undefined,{requestId:'wa:one',kind:'hook',turnId:'turn1',origin:'hook'}),false);
  assert.equal(f.store.output(f.a,'Other result','h2',undefined,{requestId:'wa:two',kind:'hook',turnId:'turn2',origin:'hook'}),true);
  f.store.event('wa:two','provider_turn_started',{provider:'codex'},'native2');assert.equal(f.store.hookRequest(f.a.id,'native2'),'wa:two');
  assert.equal(f.store.hookRequest(f.b.id,'native2'),undefined);
  f.store.holdHook('unlinked',f.a.id,'Private local update');assert.equal(f.store.unlinkedHooks().length,1);assert.equal(count(f.store),2);
 }finally{f.close();}
});

test('voice transcription with paused session becomes routing_blocked instead of processed',async()=>{
 const f=fixture(),wa=new WhatsApp(f.store,f.router);try {
  wa.status='connected';wa.selfJid='123@s.whatsapp.net';wa.owners=[wa.selfJid];
  f.router.coordinator=undefined;f.store.set('active',f.a.id);f.store.enable(f.a.id,false);
  let calls=0;wa.transcribe=async(_,__,observe)=>{calls++;observe?.({stage:'transcribe',state:'completed',durationMs:2});return 'Harmless update';};
  const note={key:{id:'voice',fromMe:true,remoteJid:wa.selfJid},message:{audioMessage:{mimetype:'audio/ogg',seconds:10,fileLength:100}}};
  await wa.receiveMessage(note);await wa.receiveMessage(note);
  assert.equal(calls,1);assert.equal(f.store.job('wa:voice'),undefined);
  assert.equal(f.store.voiceRequests()[0].status,'routing_blocked');
  assert.ok(f.store.events('wa:voice').some(e=>e.event==='voice_route_failed'));
  assert.match(JSON.stringify(f.store.db.prepare('SELECT body FROM outbox').all()),/missing or paused/);
 }finally{wa.close();f.close();}
});

test('voice routes commands and tasks once, while failed configuration has safe diagnostics',async()=>{
 const f=fixture(),wa=new WhatsApp(f.store,f.router);try {
  wa.status='connected';wa.selfJid='123@s.whatsapp.net';wa.owners=[wa.selfJid];
  const note=(id:string)=>({key:{id,fromMe:true,remoteJid:wa.selfJid},message:{audioMessage:{mimetype:'audio/ogg',seconds:10,fileLength:100}}});
  wa.transcribe=async()=> 'Check the current task';await wa.receiveMessage(note('ok'));
  assert.equal(f.store.job('wa:ok')?.binding_id,f.a.id);assert.equal(f.store.voiceRequests().find(v=>v.id==='wa:ok')?.status,'processed');
  wa.transcribe=async()=>{throw new Error('Missing environment variable secret-value');};await wa.receiveMessage(note('bad'));
  const events=JSON.stringify(f.store.events('wa:bad'));assert.match(events,/configuration_missing/);assert.doesNotMatch(events,/secret-value/);
  assert.equal(f.store.voiceRequests().find(v=>v.id==='wa:bad')?.status,'failed');
 }finally{wa.close();f.close();}
});

test('receipts distinguish sent/delivered/read and reject strangers and unrelated IDs',()=>{
 const f=fixture(),wa=new WhatsApp(f.store,f.router);try {
  wa.status='connected';wa.selfJid='123@s.whatsapp.net';wa.owners=[wa.selfJid];
  f.store.enqueue('wa:p',f.a,'work');f.router.channelReply(f.a,'The requested check passed.','final','wa:p');
  const row=f.store.outbound();f.store.sent(row.id);
  assert.equal(f.store.deliveries('wa:p')[0].delivered_at,null);
  const key={id:row.wa_id,fromMe:true,remoteJid:wa.selfJid};
  assert.equal(wa.receiveReceipt(key,2),false); // SERVER_ACK
  assert.equal(wa.receiveReceipt({...key,remoteJid:'stranger@s.whatsapp.net'},4),false);
  assert.equal(wa.receiveReceipt({...key,fromMe:false},4),false);
  assert.equal(wa.receiveReceipt(key,3),true);
  const delivered=f.store.deliveries('wa:p')[0].delivered_at;assert.equal(wa.receiveReceipt(key,4),true);wa.receiveReceipt(key,4);
  assert.equal(f.store.deliveries('wa:p')[0].delivered_at,delivered);assert.ok(f.store.deliveries('wa:p')[0].read_at);
  assert.equal(f.store.events('wa:p').filter(e=>e.event==='reply_read').length,1);
 }finally{wa.close();f.close();}
});

test('telemetry is persisted with unknown historical timestamps; no private content in details',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ffd-audit-'));let s:Store|undefined;
 try {
  s=new Store(join(dir,'state.sqlite'));const b=s.register('test','codex','11111111-1111-4111-a111-111111111111','/tmp').binding;
  s.db.prepare("INSERT INTO inbox(id,binding_id,body,status,created_at,updated_at) VALUES('legacy',?,'old','completed',1,1)").run(b.id);
  s.enqueue('new',b,'task');s.jobState('new','dispatched');s.jobState('new','submitted');
  s.event('new','provider_usage',{inputTokens:10,outputTokens:20,text:'SECRET',path:'/private',error:'secret',code:'arbitrary'});
  s.close();s=new Store(join(dir,'state.sqlite'));
  assert.equal(s.job('legacy')?.final_reply_at,null);assert.equal(s.job('legacy')?.received_at,null);
  assert.ok(s.job('new')?.attempt_id);assert.ok(s.job('new')?.received_at);assert.ok(s.job('new')?.submitted_at);
  assert.doesNotMatch(JSON.stringify(s.events('new')),/SECRET|private|arbitrary/);
  assert.deepEqual(safeEventDetails({durationMs:-1,inputTokens:Infinity,code:'SECRET'}),{code:'unknown'});
 }finally{s?.close();rmSync(dir,{recursive:true,force:true});}
});

test('worker provisioning readiness exposes actual task failure and subsequent observed recovery',()=>{
 const f=fixture();try {
  const workers=new Workers(f.store,f.router,{} as any);
  workers.save({id:'op',requestId:'wa:p',masterId:f.a.id,provider:'claude',name:'Example',text:'task',eventId:'one',status:'ready',bindingId:f.b.id});
  const id=`master:wa:p:create-op:${f.b.id}`;f.store.enqueue(id,f.b,'task');f.store.jobState(id,'uncertain','Missing environment variable: KEY');
  let op=workers.view('op')[0];assert.equal(op.status,'ready');assert.equal(op.execution,'blocked');assert.match(op.currentError!,/KEY/);
  f.router.channelReply(f.b,'Resumed','progress',id,'progress');op=workers.view('op')[0];assert.equal(op.execution,'awaiting_reply');assert.equal(op.currentError,null);assert.match(op.lastError!,/KEY/);
 }finally{f.close();}
});


test('Codex preflight catches missing configured provider credentials before thread creation without exposing values',async()=>{
 const {checkCodexEnvironment}=await import('../src/provider-readiness.js');
 const methods:string[]=[];
 const runtime={request:async(method:string,params:any)=>{methods.push(method);assert.equal(params.cwd,'/tmp/project');return {config:{model_provider:'custom',model_providers:{custom:{env_key:'FIXTURE_PROVIDER_KEY'}}}};}};
 await assert.rejects(checkCodexEnvironment(runtime,'/tmp/project',{}),/Missing environment variable/);
 await checkCodexEnvironment(runtime,'/tmp/project',{FIXTURE_PROVIDER_KEY:'test-secret'});
 assert.deepEqual(methods,['config/read','config/read']);
 await assert.rejects(checkCodexEnvironment({request:async()=>({})},'/tmp/project'),/could not be checked/);
});

test('voice stage observers report safe failures and cannot break recognition',async()=>{
 const {measureVoiceStage}=await import('../src/audio.js');const events:any[]=[];
 const result=await measureVoiceStage('decode',async()=>42,()=>{throw new Error('diagnostic failure');});assert.equal(result,42);
 await assert.rejects(measureVoiceStage('transcribe',async()=>{throw new Error('timed out: secret argument');},e=>events.push(e)),/timed out/);
 assert.deepEqual(events.map(e=>e.state),['started','failed']);assert.equal(events[1].code,'timeout');assert.ok(events[1].durationMs>=0);assert.doesNotMatch(JSON.stringify(events),/secret/);
});


test('hook-first final is deduplicated but progress must not hide a later native final',()=>{
 const f=fixture();try {
  f.store.enqueue('wa:p',f.a,'work');
  f.router.channelReply(f.a,'Working','progress','wa:p','progress',{turnId:'turn1'});
  assert.equal(f.store.output(f.a,'Native final','hook',undefined,{requestId:'wa:p',kind:'hook',origin:'hook',turnId:'turn1'}),true);
  const before=count(f.store);f.router.channelReply(f.a,'Concise final','final','wa:p','final',{turnId:'turn1',outcome:'done'});
  assert.equal(count(f.store),before);assert.equal(f.store.job('wa:p')?.outcome,'done');assert.ok(f.store.job('wa:p')?.final_reply_at);
 }finally{f.close();}
});


test('legacy sibling reports still block owner resolution and pending native approvals block final',async()=>{
 const f=fixture();try {
  f.store.enqueue('wa:p',f.a,'work');f.store.enqueue('child',f.b,'work');f.store.set('parent:child','wa:p');f.store.jobState('child','completed');
  f.store.enqueue('report:child',f.a,'Legacy report without new metadata');
  assert.throws(()=>f.router.resolveOwner('wa:p','done'),/reports/);
  const pending=f.approvals.ask(f.a,'Harmless permission');
  assert.throws(()=>f.router.channelReply(f.a,'Done','final','wa:p'),/approval/);
  f.approvals.cancel();await pending;f.coordinator.quiet('report:child','done');assert.equal(f.store.job('wa:p')?.outcome,'done');
 }finally{f.close();}
});
