import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {ProofChecks,proofScopeHash,type ProofScope,type ProofCheck,type ProofJudgeInput} from '../src/proof-check.js';
import {githubCheckBindingHash,observeGitHubCheck} from '../src/proof-github-check.js';

const now=1_850_000_000_000,sha='a'.repeat(40),binding={repository:'example/project',name:'Backend tests'};
const scope:ProofScope={contractId:'github-contract',revision:1,approvedHash:'b'.repeat(64),approvedAt:now-10000,
  owner:'owner',destination:'chat',rootRequestId:'wa:root',itemId:1,bindingId:'session',bindingHash:'c'.repeat(64),
  attemptId:'run-1',startedAt:now-8000,targetRepository:binding.repository,targetRevision:sha};
const checks:ProofCheck[]=[{id:'github-contract:1:1',text:'GitHub check Backend tests passed',
  evidenceBindings:[{source:'github-check',bindingHash:githubCheckBindingHash(binding)}]}];
const current=()=>({scope,checks}),confirm=async(input:ProofJudgeInput[])=>input.map(value=>({index:value.index,verdict:'pass' as const}));
const run=(changes:Record<string,unknown>={})=>({id:19,name:binding.name,head_sha:sha,status:'completed',conclusion:'success',completed_at:new Date(now-1000).toISOString(),...changes});
const response=(result:unknown)=>new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});
const authorizeRun=()=>true;

test('approved exact GitHub check can resolve trusted evidence for the exact target revision',async()=>{
  let requested='',options:RequestInit|undefined;
  const observed=await observeGitHubCheck(scope,checks,checks[0].id,binding,'check-run:19',new AbortController().signal,{
    authorizeRun,now:()=>now,fetcher:async(url,init)=>{requested=String(url);options=init;return response(run());},
  });
  const parsed=new URL(requested);assert.equal(parsed.origin,'https://api.github.com');
  assert.equal(parsed.pathname,'/repos/example/project/check-runs/19');assert.equal(options?.redirect,'error');
  assert.equal(new Headers(options?.headers).has('authorization'),false);
  assert.deepEqual({source:observed?.source,verdict:observed?.verdict,observedAt:observed?.observedAt,scopeHash:observed?.scopeHash},
    {source:'github-check',verdict:'pass',observedAt:now-1000,scopeHash:proofScopeHash(scope,checks)});
  const store=new Store(':memory:');try{
    const proof=new ProofChecks(store,()=>now);
    const result=await proof.evaluate(scope,checks,{[checks[0].id]:['github-check']},'eval-1',{
      current,judge:confirm,observe:async()=>observed,
    });
    assert.equal(result.checks[0].verdict,'pass');
  }finally{store.close();}
});

test('an unapproved binding or mismatched scope does not contact GitHub',async()=>{
  let calls=0;const options={authorizeRun,now:()=>now,fetcher:async()=>{calls++;return response(run());}};
  for(const variant of [
    {scope,checks:[{...checks[0],evidenceBindings:[]}],binding},
    {scope:{...scope,targetRepository:'another/project'},checks,binding},
    {scope:{...scope,targetRevision:null},checks,binding},
    {scope,checks,binding:{...binding,name:'Different check'}},
    {scope,checks,binding:{repository:'../project',name:binding.name}},
    {scope,checks:[{...checks[0],text:'Fix everything and pass'}],binding},
  ])assert.equal(await observeGitHubCheck(variant.scope,variant.checks,variant.checks[0].id,variant.binding,'check-run:19',new AbortController().signal,options),undefined);
  assert.equal(calls,0);
});

test('wrong, stale, incomplete or ambiguous checks remain unverified',async()=>{
  const variants=[
    response({}),response(run({id:20})),response(run({head_sha:'f'.repeat(40)})),response(run({name:'Other'})),
    response(run({status:'in_progress',conclusion:null})),response(run({conclusion:'neutral'})),
    response(run({completed_at:new Date(scope.startedAt-1).toISOString()})),response(run({completed_at:new Date(now+1).toISOString()})),
    new Response('bad',{status:503}),new Response('x'.repeat(512*1024+1)),
  ];
  for(const fake of variants){
    const observed=await observeGitHubCheck(scope,checks,checks[0].id,binding,'check-run:19',new AbortController().signal,{authorizeRun,now:()=>now,fetcher:async()=>fake});
    assert.equal(observed,undefined);
  }
});

test('only the independently authorized exact run is used',async()=>{
  const failed=await observeGitHubCheck(scope,checks,checks[0].id,binding,'check-run:19',new AbortController().signal,{authorizeRun,now:()=>now,fetcher:async()=>response(run({conclusion:'failure'}))});
  assert.equal(failed?.verdict,'fail');assert.equal(failed?.observedAt,now-1000);
  let calls=0;
  const unauthorized=await observeGitHubCheck(scope,checks,checks[0].id,binding,'check-run:19',new AbortController().signal,{authorizeRun:()=>false,now:()=>now,fetcher:async()=>{calls++;return response(run());}});
  assert.equal(unauthorized,undefined);assert.equal(calls,0);
  const changed=await observeGitHubCheck(scope,checks,checks[0].id,binding,'check-run:19',new AbortController().signal,{authorizeRun:(()=>{let n=0;return ()=>++n<3;})(),now:()=>now,fetcher:async()=>response(run())});
  assert.equal(changed,undefined);
});

test('aborted or stalled fetches fail closed, even when the transport ignores cancellation',async()=>{
  const controller=new AbortController();let started!:()=>void;
  const begun=new Promise<void>(resolve=>{started=resolve;});
  const pending=observeGitHubCheck(scope,checks,checks[0].id,binding,'check-run:19',controller.signal,{authorizeRun,now:()=>now,fetcher:async()=>{started();return await new Promise<Response>(()=>{});}});
  await begun;controller.abort();assert.equal(await Promise.race([pending,new Promise(resolve=>setTimeout(()=>resolve('hung'),500))]),undefined);
});

test('caller mutation during a fetch cannot change the target or evidence binding',async()=>{
  const mutableScope={...scope},mutableBinding={...binding},mutableChecks=checks.map(check=>({...check,evidenceBindings:check.evidenceBindings!.map(item=>({...item}))}));
  const result=await observeGitHubCheck(mutableScope,mutableChecks,checks[0].id,mutableBinding,'check-run:19',new AbortController().signal,{
    authorizeRun,now:()=>now,fetcher:async()=>{mutableScope.targetRevision='f'.repeat(40);mutableBinding.name='Other';mutableChecks[0].evidenceBindings[0].bindingHash='f'.repeat(64);return response(run());},
  });
  assert.equal(result?.scopeHash,proofScopeHash(scope,checks));assert.equal(result?.verdict,'pass');
});
