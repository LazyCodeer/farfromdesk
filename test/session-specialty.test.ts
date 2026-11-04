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
test('a paused direct selection never falls back to the active session',async()=>{
 const f=fixture();try {
  const direct=f.s.register('direct','claude',randomUUID(),f.root).binding;
  f.s.destinationContext.run('123@s.whatsapp.net',()=>startDirect(f.s,direct));f.s.enable(direct.id,false);
  assert.equal((await f.send('1','/social Ai engineer in yc startups')).status,'blocked');
  assert.equal(f.s.job(f.jobId('1')),undefined);
 }finally{f.close();}
});
test('an enabled direct selection is used even when absent from the active list',async()=>{
 const f=fixture();try {
  const direct=f.s.register('direct','claude',randomUUID(),f.root).binding;
  f.s.destinationContext.run('123@s.whatsapp.net',()=>startDirect(f.s,direct));
  assert.equal((await f.send('1','/social Ai engineer in yc startups')).status,'queued');
  assert.equal(f.s.job(f.jobId('1'))?.binding_id,direct.id);
 }finally{f.close();}
});
test('refreshing the same direct session does not revoke another request',async()=>{
 const f=fixture();try {
  const direct=f.s.register('direct','claude',randomUUID(),f.root).binding;
  f.s.destinationContext.run('123@s.whatsapp.net',()=>startDirect(f.s,direct));
  await f.send('1','/social Splice AI');const id=f.jobId('1');assert.ok(sessionSpecialty(f.s,id));
  const key='direct:123@s.whatsapp.net',saved=JSON.parse(f.s.get(key)!);f.s.set(key,JSON.stringify({...saved,at:saved.at+1}));
  assert.ok(sessionSpecialty(f.s,id));
 }finally{f.close();}
});
test('expired direct selection returns to the active session',async()=>{
 const f=fixture();try {
  const direct=f.s.register('direct','claude',randomUUID(),f.root).binding;
  f.s.set('direct:123@s.whatsapp.net',JSON.stringify({bindingId:direct.id,at:Date.now()-3*60*60_000}));
  await f.send('1','/social Ai engineer in yc startups');
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
