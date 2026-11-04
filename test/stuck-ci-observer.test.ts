import test from 'node:test';
import assert from 'node:assert/strict';
import {observeApprovedCiFailure,type ApprovedCiRun} from '../src/stuck-ci-observer.js';

const now=1_850_000_000_000,sha='a'.repeat(40);
const binding:ApprovedCiRun={owner:'synthetic-owner',destination:'synthetic-chat',ownerGeneration:'gen-a',rootRequestId:'wa:owner',itemId:1,
  repository:'example/project',prNumber:12,headSha:sha,checkRunId:19,checkName:'Synthetic checks'};
const pr=(extra:Record<string,unknown>={})=>({number:12,state:'open',merged_at:null,base:{repo:{full_name:'example/project',private:false}},head:{sha},...extra});
const check=(extra:Record<string,unknown>={})=>({id:19,name:'Synthetic checks',head_sha:sha,status:'completed',conclusion:'failure',completed_at:new Date(now-1000).toISOString(),...extra});
const response=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
function transport(prBody:unknown=pr(),checkBody:unknown=check()){
  const calls:{url:string;init:RequestInit|undefined}[]=[];
  const fetcher:typeof fetch=async(url,init)=>{calls.push({url:String(url),init});return response(String(url).includes('/pulls/')?prBody:checkBody);};
  return {calls,fetcher};
}

test('an explicitly authorized exact failed run is independently read from two fixed API paths',async()=>{
  const t=transport(),result=await observeApprovedCiFailure(binding,new AbortController().signal,()=>true,t.fetcher,()=>now);
  assert.equal(result?.kind,'approved-ci-run-failure-observed');assert.equal(result?.completedAt,now-1000);assert.equal(result?.observedAt,now);assert.equal(result?.checkRunId,19);
  assert.deepEqual(t.calls.map(c=>c.url),['https://api.github.com/repos/example/project/pulls/12','https://api.github.com/repos/example/project/check-runs/19','https://api.github.com/repos/example/project/pulls/12','https://api.github.com/repos/example/project/check-runs/19','https://api.github.com/repos/example/project/pulls/12']);
  for(const call of t.calls){assert.equal(call.init?.method,'GET');assert.equal(call.init?.redirect,'error');assert.equal(new Headers(call.init?.headers).has('authorization'),false);}
  assert.match(result!.incident,/^[a-f0-9]{64}$/);
});

test('a PR whose head changes while reading the exact failed run is rejected',async()=>{
  let calls=0;const fetcher:typeof fetch=async()=>response(++calls===1?pr():calls===2?check():pr({head:{sha:'b'.repeat(40)}}));
  assert.equal(await observeApprovedCiFailure(binding,new AbortController().signal,()=>true,fetcher,()=>now),undefined);assert.equal(calls,3);
});

test('a check run changed or rerun during the PR head recheck is not reported as failed',async()=>{
  for(const updated of [check({conclusion:'success'}),check({status:'in_progress'}),check({id:20}),check({completed_at:new Date(now-500).toISOString()})]){
    let calls=0;const fetcher:typeof fetch=async()=>response(++calls===1?pr():calls===2?check():calls===3?pr():updated);
    assert.equal(await observeApprovedCiFailure(binding,new AbortController().signal,()=>true,fetcher,()=>now),undefined);assert.equal(calls,4);
  }
});

test('a PR that changes during the second check read is rejected',async()=>{
  let calls=0;const fetcher:typeof fetch=async()=>response(++calls===1?pr():calls===2?check():calls===3?pr():calls===4?check():pr({state:'closed'}));
  assert.equal(await observeApprovedCiFailure(binding,new AbortController().signal,()=>true,fetcher,()=>now),undefined);assert.equal(calls,5);
});

test('without an exact owner binding or with hostile identifiers nothing is fetched',async()=>{
  const t=transport();
  assert.equal(await observeApprovedCiFailure(binding,new AbortController().signal,()=>false,t.fetcher,()=>now),undefined);
  for(const changed of [
    {repository:'example/project/../../other'}, {repository:'../project'}, {repository:'example/project?token=secret'},
    {headSha:'b'.repeat(39)}, {checkRunId:0}, {prNumber:1.5}, {ownerGeneration:''}, {checkName:'Check\nInjected'},
  ])assert.equal(await observeApprovedCiFailure({...binding,...changed},new AbortController().signal,()=>true,t.fetcher,()=>now),undefined);
  assert.equal(t.calls.length,0);
});

test('closed, changed, mismatched or successful observations cannot become failure alerts',async()=>{
  for(const [p,c] of [
    [pr({state:'closed'}),check()], [pr({merged_at:'2026-01-01T00:00:00Z'}),check()],
    [pr({head:{sha:'b'.repeat(40)}}),check()], [pr({base:{repo:{full_name:'other/repo'}}}),check()],
    [pr(),check({id:20})], [pr(),check({name:'Other'})], [pr(),check({head_sha:'b'.repeat(40)})],
    [pr(),check({conclusion:'success'})], [pr(),check({status:'in_progress'})],
    [pr(),check({completed_at:new Date(now-25*60*60_000).toISOString()})], [pr(),check({completed_at:new Date(now+1).toISOString()})],
  ]){
    const t=transport(p,c);assert.equal(await observeApprovedCiFailure(binding,new AbortController().signal,()=>true,t.fetcher,()=>now),undefined);
  }
});

test('owner generation revoked during a fake fetch prevents the second request and result',async()=>{
  let start!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>start=r),wait=new Promise<void>(r=>release=r);
  let generation='gen-a',calls=0;const fake:typeof fetch=async()=>{calls++;start();await wait;return response(pr());};
  const running=observeApprovedCiFailure(binding,new AbortController().signal,b=>b.ownerGeneration===generation,fake,()=>now);
  await entered;generation='gen-b';release();assert.equal(await running,undefined);assert.equal(calls,1);
  // A return to the same visible owner/chat with a new durable generation stays invalid.
  assert.equal(await observeApprovedCiFailure(binding,new AbortController().signal,b=>b.ownerGeneration===generation,fake,()=>now),undefined);
});

test('aborted, failed, oversized and non-JSON responses fail closed',async()=>{
  for(const fake of [async()=>new Response('bad',{status:503}),async()=>new Response('x'.repeat(512*1024+1),{headers:{'content-type':'application/json'}}),async()=>new Response('{}',{headers:{'content-type':'text/html'}})])
    assert.equal(await observeApprovedCiFailure(binding,new AbortController().signal,()=>true,fake,()=>now),undefined);
  const controller=new AbortController();controller.abort();const t=transport();
  assert.equal(await observeApprovedCiFailure(binding,controller.signal,()=>true,t.fetcher,()=>now),undefined);assert.equal(t.calls.length,0);
});
