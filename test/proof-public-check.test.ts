import './brain-fixture-isolation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {Router} from '../src/router.js';
import {Approvals} from '../src/approvals.js';
import {parsePublicCheck,publicCheckObservation} from '../src/proof-public-check.js';

const owner='owner@s.whatsapp.net',revision='a'.repeat(40),args=`example/project 19 ${revision} Backend checks`;
const record=(overrides:Record<string,unknown>={})=>({id:19,name:'Backend checks',head_sha:revision,status:'completed',conclusion:'success',completed_at:'2026-10-29T10:00:00Z',...overrides});
const response=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
const fixture=(path=':memory:')=>{const store=new Store(path),approvals=new Approvals(store),router=new Router(store,{stop:()=>{},run:async()=>{throw Error('must not dispatch');}} as any,approvals);store.set('whatsapp-owner',owner);return {store,approvals,router,close(){approvals.cancel();store.close();}};};
const message=(id:string,text=`/checkrun ${args}`)=>({id,text,ownerCommand:true,source:'text' as const});

test('one explicit public run is observed from a fixed origin without task or merge claims',async()=>{
  const f=fixture();try{
    const calls:{url:string;init?:RequestInit}[]=[];
    f.router.publicCheckFetch=async(url,init)=>{calls.push({url:String(url),init});return response(record());};
    assert.equal((await f.router.receive(message('wa:check'))).status,'handled');
    assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.github.com/repos/example/project/check-runs/19');
    assert.equal(calls[0].init?.method,'GET');assert.equal(calls[0].init?.redirect,'error');assert.equal(new Headers(calls[0].init?.headers).has('authorization'),false);
    const out=f.store.db.prepare("SELECT id,body,destination FROM outbox WHERE source='command:wa:check:0'").get() as {id:string;body:string;destination:string};
    assert.equal(out.destination,owner);assert.match(out.body,/GitHub reported: completed with conclusion success/);assert.match(out.body,/This does not verify your task, its changes, or merge readiness/);
    assert.equal(f.store.incomingOwnerDelivery(out.id),true);assert.equal(f.store.job('wa:check'),undefined);
    assert.equal((await f.router.receive(message('wa:check'))).status,'ignored');assert.equal(calls.length,1);
  }finally{f.close();}
});

test('public check grammar rejects arbitrary URLs, unsafe IDs and unmatched fields before network',async()=>{
  for(const input of [`https://github.com/example/project 19 ${revision} Backend checks`,`../project 19 ${revision} Backend checks`,`example/project 0 ${revision} Backend checks`,`example/project 19 ${'a'.repeat(39)} Backend checks`,`example/project 19 ${revision} x\nInjected`])assert.throws(()=>parsePublicCheck(input));
  for(const overrides of [{id:20},{head_sha:'b'.repeat(40)},{name:'Other'},{status:'completed',conclusion:'banana'},{status:'completed',completed_at:null},{status:'in_progress',conclusion:'success'}]){
    await assert.rejects(publicCheckObservation(parsePublicCheck(args),()=>true,async()=>response(record(overrides)),()=>Date.parse('2026-10-30T00:00:00Z')));
  }
});

test('failure and pending are attributed to the exact historical run, not to a task',async()=>{
  for(const [r,expected] of [[record({conclusion:'failure'}),/completed with conclusion failure/],[record({status:'in_progress',conclusion:null,completed_at:null}),/in progress/]] as const){
    const text=await publicCheckObservation(parsePublicCheck(args),()=>true,async()=>response(r),()=>Date.parse('2026-10-30T00:00:00Z'));
    assert.match(text,expected);assert.match(text,/does not verify your task/);assert.match(text,/checked 2026-10-30T00:00:00.000Z/);
  }
});

test('redirects, failed, malformed and oversized responses are never reported as proof',async()=>{
  const request=parsePublicCheck(args);
  for(const fetcher of [async()=>new Response('',{status:302,headers:{location:'https://example.invalid'}}),async()=>new Response('',{status:403}),async()=>new Response('invalid',{headers:{'content-type':'application/json'}}),async()=>new Response('x'.repeat(512*1024+1),{headers:{'content-type':'application/json'}})])
    await assert.rejects(publicCheckObservation(request,()=>true,fetcher,()=>Date.parse('2026-10-30T00:00:00Z')));
});

test('unexpected fetch errors are not exposed to the owner',async()=>{
  const request=parsePublicCheck(args);
  const fetcher=(()=>{throw new Error('sensitive transport detail');}) as typeof fetch;
  await assert.rejects(publicCheckObservation(request,()=>true,fetcher),e=>e instanceof Error && e.message==='The public GitHub check could not be verified.');
});

test('a stalled response is abandoned without exposing stream errors',async()=>{
  const request=parsePublicCheck(args);let cancelled=false;
  const stream=new ReadableStream<Uint8Array>({pull(){return new Promise<void>(()=>{});},cancel(){cancelled=true;}});
  const timer=setTimeout(()=>{},7000);
  try{
    await assert.rejects(publicCheckObservation(request,()=>true,async()=>new Response(stream,{headers:{'content-type':'application/json'}})),/could not be verified/);
    assert.equal(cancelled,true);
  }finally{clearTimeout(timer);}
});

test('no more than two checks run concurrently',async()=>{
  const f=fixture();try{
    let release!:()=>void;let entered=0;let ready!:()=>void;
    const gate=new Promise<void>(r=>release=r),two=new Promise<void>(r=>ready=r);
    f.router.publicCheckFetch=async()=>{if(++entered===2)ready();await gate;return response(record());};
    const one=f.router.receive(message('wa:one')),second=f.router.receive(message('wa:two'));
    await two;
    await f.router.receive(message('wa:three'));
    assert.equal(entered,2);
    release();await Promise.all([one,second]);
  }finally{f.close();}
});

test('forwarded, quoted, voice, foreign and group requests cannot fetch a public run',async()=>{
  const f=fixture();try{
    let calls=0;f.router.publicCheckFetch=async()=>{calls++;return response(record());};
    for(const m of [{...message('wa:forward'),ownerCommand:false},{...message('wa:voice'),source:'voice' as const,ownerCommand:false},{...message('wa:quote'),quotedId:'unrelated',ownerCommand:false},{...message('parent:untrusted')}])await f.router.receive(m);
    const group='123@g.us';f.store.set(`owned-group:${group}`,'Synthetic group');f.store.set('destination-jid',group);
    await f.store.destinationContext.run(group,()=>f.router.receive(message('wa:group')));
    assert.equal(calls,0);
  }finally{f.close();}
});

test('owner change away and back during fetch discards the response and queues no owner reply',async()=>{
  const f=fixture();try{
    let enter!:()=>void,release!:()=>void;const begun=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
    f.router.publicCheckFetch=async()=>{enter();await gate;return response(record());};
    const pending=f.router.receive(message('wa:changed'));await begun;f.store.set('whatsapp-owner','other@s.whatsapp.net');f.store.set('whatsapp-owner',owner);release();
    assert.equal((await pending).status,'blocked');assert.equal(f.store.db.prepare("SELECT 1 FROM outbox WHERE source LIKE 'command%:wa:changed:%'").get(),undefined);
  }finally{f.close();}
});

test('a queued observation remains bound to the original owner across restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-checkrun-restart-')),path=join(dir,'state.sqlite');let f:ReturnType<typeof fixture>|undefined,reopened:Store|undefined;
  try{
    f=fixture(path);f.router.publicCheckFetch=async()=>response(record());await f.router.receive(message('wa:restart'));
    const id=(f.store.db.prepare("SELECT id FROM outbox WHERE source='command:wa:restart:0'").get() as {id:string}).id;
    f.close();f=undefined;reopened=new Store(path);assert.equal(reopened.incomingOwnerDelivery(id),true);
    reopened.set('whatsapp-owner','other@s.whatsapp.net');reopened.set('whatsapp-owner',owner);assert.equal(reopened.incomingOwnerDelivery(id),false);
  }finally{f?.close();reopened?.close();rmSync(dir,{recursive:true,force:true});}
});

test('a failed owner check cannot dispatch a correction or start an agent',async()=>{
  const f=fixture();try{
    f.router.publicCheckFetch=async()=>response(record({conclusion:'failure'}));
    assert.equal((await f.router.receive(message('wa:failure'))).status,'handled');
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM inbox').get()?.n,0);
    assert.equal(f.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='proof_corrections'").get(),undefined);
  }finally{f.close();}
});
