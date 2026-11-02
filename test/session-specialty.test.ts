import './brain-fixture-isolation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {Router} from '../src/router.js';
import {Approvals} from '../src/approvals.js';
import {turnEnvelope,specialistDocument} from '../src/roles.js';
import {MetaSecret,DEFAULT_BRAIN,saveBrainConfig} from '../src/meta-brain-config.js';
import {TaskContracts} from '../src/task-contracts.js';
import {sessionSpecialty} from '../src/session-specialty.js';
import {GuidedModes} from '../src/guided-modes.js';
import {startDirect} from '../src/owner-routing.js';
import {sessionResearchRequest,sessionResearchRead} from '../src/session-research.js';

function fixture(channel:'whatsapp'|'telegram'='whatsapp',review=false,provider:'codex'|'claude'='codex') {
 const root=mkdtempSync(join(tmpdir(),'ffd-specialty-')),s=new Store(':memory:'),a=new Approvals(s),r=new Router(s,{run:async()=>{},stop:()=>{},warmDesktop:()=>{}} as any,a);
 const owner=channel==='telegram'?'tg:123':'123@s.whatsapp.net';s.set('control-channel',channel);s.set(channel==='telegram'?'telegram-owner':'whatsapp-owner',owner);
 const b=s.register('selected',provider,randomUUID(),root).binding;s.set('active',b.id);r.pump=()=>{};
 if(review){const secret=new MetaSecret(root);secret.save('synthetic-key-not-a-real-secret');saveBrainConfig(s,secret,{policy:{...DEFAULT_BRAIN,enabled:true,taskContracts:true}});r.contracts=new TaskContracts(s,secret,async()=>({kind:'contract',goal:'Search for jobs',exclusions:['Do not apply'],checks:['Show sources','List relevant roles'],question:''}));}
 const send=(id:string,text:string)=>s.destinationContext.run(owner,()=>r.receive({id:channel==='telegram'?`${owner}:${id}`:`wa:${id}`,text,ownerCommand:true,ownerIntent:true}));
 const jobId=(id:string)=>channel==='telegram'?`${owner}:${id}`:`wa:${id}`;
 const latest=()=>s.db.prepare('SELECT body FROM outbox ORDER BY rowid DESC LIMIT 1').get() as {body:string}|undefined;
 return {s,r,b,root,send,jobId,latest,close(){a.cancel();s.close();rmSync(root,{recursive:true,force:true});}};
}
test('both channels queue exact jobs request to the selected session with per-turn guidance',async()=>{
 for(const channel of ['whatsapp','telegram'] as const){const f=fixture(channel);try {
  await f.send('1','/research');await f.send('2','/jobs');
  assert.match(f.latest()?.body??'',/what kind of jobs/i);
  const text='Ai engineer in yc startups',result=await f.send('3',text),id=f.jobId('3');
  assert.equal(result.status,'queued');assert.equal(f.s.job(id)?.body,text);assert.equal(f.s.job(id)?.binding_id,f.b.id);
  const specialty=sessionSpecialty(f.s,id)!;assert.equal(specialty.kind,'jobs');
  const envelope=turnEnvelope(f.s,f.b,text,id,{},[],f.root,true);
  assert.match(envelope.body,/Agent: farfromdesk-jobs/);assert.match(envelope.body,/Ai engineer in yc startups/);
  assert.match(readFileSync(specialistDocument(f.s,f.b,id,f.root).file,'utf8'),/using the existing selected session/);
  await f.send('3',text);assert.equal(f.s.jobs().length,1);
  const delivered:string[]=[];(f.r.native as any).run=async(b:any,body:string,requestId:string)=>{delivered.push(turnEnvelope(f.s,b,body,requestId,{},[],f.root,true).body);};
  Router.prototype.pump.call(f.r);await new Promise<void>(r=>setImmediate(r));
  assert.equal(delivered.length,1);assert.match(delivered[0],/Agent: farfromdesk-jobs/);assert.equal(f.s.job(id)?.status,'submitted');
 }finally{f.close();}}
});
test('research guidance is request-scoped and a changed selection fails closed',async()=>{
 const f=fixture();try{
  const text='/research Splice AI in FMCG';await f.send('1',text);const id=f.jobId('1');
  assert.equal(f.s.job(id)?.body,text);assert.equal(sessionSpecialty(f.s,id)?.kind,'research');assert.ok(sessionSpecialty(f.s,id)?.researchCaptureHash);
  assert.match(turnEnvelope(f.s,f.b,text,id,{},[],f.root,true).body,/Agent: farfromdesk-research/);
  f.s.set('active','changed');f.s.set('active',f.b.id);
  assert.equal(sessionSpecialty(f.s,id),undefined);
  assert.throws(()=>turnEnvelope(f.s,f.b,text,id,{},[],f.root,true),/changed/);
  Router.prototype.pump.call(f.r);assert.equal(f.s.job(id)?.status,'failed');assert.match(f.latest()?.body??'',/nothing was sent/i);
 }finally{f.close();}
});
test('Claude research uses the selected session and its original request',async()=>{
 const f=fixture('telegram',false,'claude');try {
  const text='/research Splice AI';assert.equal((await f.send('1',text)).status,'queued');
  const id=f.jobId('1');assert.equal(f.s.job(id)?.binding_id,f.b.id);assert.equal(f.s.job(id)?.body,text);
  assert.match(turnEnvelope(f.s,f.b,text,id,{},[],f.root,true).body,/Agent: farfromdesk-research/);
 }finally{f.close();}
});
test('F3 reviews the original specialty request and approval dispatches it once',async()=>{
 const f=fixture('telegram',true);try {
  const text='/jobs Ai engineer in yc startups';await f.send('1',text);assert.equal(f.s.jobs().length,0);
  const pending=f.s.db.prepare("SELECT original,review_text FROM task_contracts WHERE state='pending'").get() as any;
  assert.ok(pending,f.latest()?.body);
  assert.equal(pending.original,text);assert.equal(pending.review_text,text);
  f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
  f.r.guidedModes=new GuidedModes(); // The durable approval survives mode loss or restart.
  assert.equal((await f.send('2','ok')).status,'queued',f.latest()?.body);
  const job=f.s.job(f.jobId('2'))!;assert.match(job.body,/Ai engineer in yc startups/);assert.match(job.body,/Owner-approved task contract/);
  assert.equal(sessionSpecialty(f.s,job.id)?.kind,'jobs');await f.send('2','ok');assert.equal(f.s.jobs().length,1);
 }finally{f.close();}
});
test('approved research retains its source capture through the F3 replay',async()=>{
 const f=fixture('telegram',true);try {
  await f.send('1','/research Splice AI in FMCG');
  f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
  assert.equal((await f.send('2','ok')).status,'queued');
  const id=f.jobId('2');assert.ok(sessionSpecialty(f.s,id)?.researchCaptureHash);assert.match(f.s.job(id)?.body??'',/Splice AI in FMCG/);
 }finally{f.close();}
});
test('a paused direct selection never falls back to the active session',async()=>{
 const f=fixture();try {
  const direct=f.s.register('direct','claude',randomUUID(),f.root).binding;
  f.s.destinationContext.run('123@s.whatsapp.net',()=>startDirect(f.s,direct));f.s.enable(direct.id,false);
  assert.equal((await f.send('1','/jobs Ai engineer in yc startups')).status,'blocked');
  assert.equal(f.s.job(f.jobId('1')),undefined);
 }finally{f.close();}
});
test('an enabled direct selection is used even when absent from the active list',async()=>{
 const f=fixture();try {
  const direct=f.s.register('direct','claude',randomUUID(),f.root).binding;
  f.s.destinationContext.run('123@s.whatsapp.net',()=>startDirect(f.s,direct));
  assert.equal((await f.send('1','/jobs Ai engineer in yc startups')).status,'queued');
  assert.equal(f.s.job(f.jobId('1'))?.binding_id,direct.id);
 }finally{f.close();}
});
test('refreshing the same direct session does not revoke another request',async()=>{
 const f=fixture();try {
  const direct=f.s.register('direct','claude',randomUUID(),f.root).binding;
  f.s.destinationContext.run('123@s.whatsapp.net',()=>startDirect(f.s,direct));
  await f.send('1','/research Splice AI');const id=f.jobId('1');assert.ok(sessionSpecialty(f.s,id));
  const key='direct:123@s.whatsapp.net',saved=JSON.parse(f.s.get(key)!);f.s.set(key,JSON.stringify({...saved,at:saved.at+1}));
  assert.ok(sessionSpecialty(f.s,id));
 }finally{f.close();}
});
test('expired direct selection returns to the active session',async()=>{
 const f=fixture();try {
  const direct=f.s.register('direct','claude',randomUUID(),f.root).binding;
  f.s.set('direct:123@s.whatsapp.net',JSON.stringify({bindingId:direct.id,at:Date.now()-3*60*60_000}));
  await f.send('1','/jobs Ai engineer in yc startups');
  assert.equal(f.s.job(f.jobId('1'))?.binding_id,f.b.id);assert.equal(f.s.get('direct:123@s.whatsapp.net'),undefined);
 }finally{f.close();}
});
test('changing and restoring direct selection before approval fails closed',async()=>{
 const f=fixture('telegram',true);try {
  const direct=f.s.register('direct','claude',randomUUID(),f.root).binding,other=f.s.register('other','codex',randomUUID(),f.root).binding;
  f.s.destinationContext.run('tg:123',()=>startDirect(f.s,direct));await f.send('1','/research Splice AI in FMCG');
  f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
  f.s.destinationContext.run('tg:123',()=>{startDirect(f.s,other);startDirect(f.s,direct);});
  await f.send('2','ok');assert.equal(f.s.job(f.jobId('2')),undefined);
 }finally{f.close();}
});
test('approved research runs the real request-bound adapter exactly once',async()=>{
 const f=fixture('telegram',true);try {
  await f.send('1','/research Splice AI in FMCG');f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
  assert.equal((await f.send('2','ok')).status,'queued');const id=f.jobId('2');let calls=0;
  f.r.reach=async(command,current)=>{calls++;assert.equal(command,'/reach web search Splice AI in FMCG');assert.ok(current());return 'Public research from Exa web search.\n\nExample\nhttps://example.com/\nSynthetic';};
  assert.match(await sessionResearchRequest(f.s,f.r,f.b,id,sessionSpecialty),/Public research/);assert.equal(calls,1);
 }finally{f.close();}
});
test('approved YC job request can use its own bounded search and source citations',async()=>{
 const f=fixture('telegram',true);try {
  await f.send('1','/jobs Ai engineer in yc startups');f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
  assert.equal((await f.send('2','ok')).status,'queued');const id=f.jobId('2');let calls=0;
  f.r.reach=async(command,current)=>{calls++;assert.equal(command,'/reach web search Ai engineer in yc startups');assert.ok(current());return 'Public research from Exa web search.\n\nSynthetic YC listing\nhttps://example.com/job/ai\nAI engineer role';};
  const search=await sessionResearchRequest(f.s,f.r,f.b,id,sessionSpecialty);assert.match(search,/https:\/\/example.com\/job\/ai/);
  const read=async(url:string,current:()=>boolean)=>{assert.equal(url,'https://example.com/job/ai');assert.ok(current());return {status:'ok' as const,channel:'web' as const,sources:[{title:'Synthetic YC listing',url,excerpt:'AI engineer role'}]};};
  assert.match(await sessionResearchRead(f.s,f.r,f.b,id,1,sessionSpecialty,read),/https:\/\/example.com\/job\/ai/);assert.equal(calls,1);
 }finally{f.close();}
});
