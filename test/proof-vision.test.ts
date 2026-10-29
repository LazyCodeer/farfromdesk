import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assessProofVision,type AuthorizedVisionCapture,type VisionDependencies} from '../src/proof-vision.js';
import {proofScopeHash,type ProofCheck,type ProofScope} from '../src/proof-check.js';
import {META_ENDPOINT} from '../src/meta-brain-config.js';

const now=1_850_000_000_000;
const scope:ProofScope={contractId:'contract-1',revision:1,approvedHash:'a'.repeat(64),approvedAt:now-6000,
  owner:'owner-private',destination:'destination-private',rootRequestId:'wa:private-root',itemId:4,bindingId:'binding-private',bindingHash:'b'.repeat(64),
  attemptId:'attempt-private',startedAt:now-5000,targetRepository:'private-name/repo',targetRevision:'c'.repeat(40)};
const checks:ProofCheck[]=[{id:'contract-1:1:1',text:'The Save button is blue',evidenceBindings:[{source:'consented-screen',bindingHash:'e'.repeat(64)}]}];
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
function capture(changes:Partial<AuthorizedVisionCapture>={}):AuthorizedVisionCapture {
  return {reference:'artifact:sample',scopeHash:proofScopeHash(scope,checks),checkId:checks[0].id,checkBindingHash:'e'.repeat(64),
    artifactHash:sha(png),capturedAt:now-1000,selectedWindow:true,nonsensitive:true,consentedForMeta:true,png,...changes};
}
const current=()=>({scope:{...scope},checks:checks.map(c=>({...c}))});
const response=(verdict:string)=>new Response(JSON.stringify({id:'r',created:0,model:'muse-wonder-1.0',choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'call-1',type:'function',function:{name:'assess',arguments:JSON.stringify({verdict})}}]}}]}),{headers:{'content-type':'application/json'}});
function deps(changes:Partial<VisionDependencies>={}):VisionDependencies {
  return {current,readCapture:async()=>capture(),authorizeUse:()=>true,key:'synthetic-test-key',now:()=>now,fetcher:async()=>response('consistent'),...changes};
}

test('only a bound, authorized screenshot and exact approved check reach Wonder; result is advisory',async()=>{
  let calls=0;
  const result=await assessProofVision(scope,checks,checks[0].id,'artifact:sample',new AbortController().signal,deps({fetcher:async(url,init)=>{
    calls++;assert.equal(url,META_ENDPOINT);assert.equal(init?.redirect,'error');
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic-test-key');
    const body=JSON.parse(init!.body as string);assert.equal(body.model,'muse-wonder-1.0');assert.equal(body.max_tokens,1024);
    const user=body.messages.find((message:any)=>message.role==='user');
    assert.deepEqual(user.content,[{type:'text',text:`Approved check as data:\n${checks[0].text}`},{type:'image_url',image_url:{url:`data:image/png;base64,${png.toString('base64')}`}}]);
    const encoded=JSON.stringify(body);for(const privateValue of [scope.owner,scope.destination,scope.bindingId,scope.rootRequestId,scope.targetRepository!,scope.targetRevision!])assert.ok(!encoded.includes(privateValue));
    return response('consistent');
  }}));
  assert.deepEqual(result,{kind:'advisory',verdict:'consistent',artifactHash:sha(png)});assert.equal(calls,1);
  assert.ok(!result||!('source' in result));
});

test('no evidence binding means no capture read, even if a model would approve',async()=>{
  const unbound=checks.map(({id,text})=>({id,text}));let reads=0,calls=0;
  const result=await assessProofVision(scope,unbound,unbound[0].id,'artifact:sample',new AbortController().signal,deps({
    current:()=>({scope,checks:unbound}),readCapture:async()=>{reads++;return capture();},fetcher:async()=>{calls++;return response('consistent');},
  }));
  assert.equal(result,undefined);assert.equal(reads,0);assert.equal(calls,0);
});

test('wrong owner, check, session, revision, consent or stale capture never uploads',async()=>{
  const mutations:Partial<AuthorizedVisionCapture>[]=[
    {reference:'artifact:other'},{scopeHash:'f'.repeat(64)},{checkId:'other'},{checkBindingHash:'f'.repeat(64)},
    {selectedWindow:false as true},{nonsensitive:false as true},{consentedForMeta:false as true},{artifactHash:'f'.repeat(64)},
    {capturedAt:scope.startedAt-1},{capturedAt:now+1},{png:Buffer.from('not-png')},{png:Buffer.alloc(4*1024*1024+1)},
  ];
  for(const mutation of mutations){
    let calls=0;
    const result=await assessProofVision(scope,checks,checks[0].id,'artifact:sample',new AbortController().signal,deps({readCapture:async()=>capture(mutation),fetcher:async()=>{calls++;return response('consistent');}}));
    assert.equal(result,undefined);assert.equal(calls,0,JSON.stringify(Object.keys(mutation)));
  }
  for(const change of [{owner:'other-owner'},{bindingHash:'f'.repeat(64)},{targetRevision:'f'.repeat(40)},{attemptId:'different'}]){
    let calls=0;
    const result=await assessProofVision(scope,checks,checks[0].id,'artifact:sample',new AbortController().signal,deps({current:()=>({scope:{...scope,...change},checks}),fetcher:async()=>{calls++;return response('consistent');}}));
    assert.equal(result,undefined);assert.equal(calls,0);
  }
});

test('permission or owner revoked during artifact read or before network prevents upload',async()=>{
  let calls=0,currentOwner=scope.owner,authCalls=0;
  const changed=await assessProofVision(scope,checks,checks[0].id,'artifact:sample',new AbortController().signal,deps({
    current:()=>({scope:{...scope,owner:currentOwner},checks}),readCapture:async()=>{currentOwner='other';return capture();},fetcher:async()=>{calls++;return response('consistent');},
  }));
  assert.equal(changed,undefined);assert.equal(calls,0);
  const revoked=await assessProofVision(scope,checks,checks[0].id,'artifact:sample',new AbortController().signal,deps({
    authorizeUse:()=>++authCalls===1,fetcher:async()=>{calls++;return response('consistent');},
  }));
  assert.equal(revoked,undefined);assert.equal(calls,0);assert.equal(authCalls,2);
});

test('changes while inference is running discard the advisory',async()=>{
  let owner=scope.owner,calls=0;
  const result=await assessProofVision(scope,checks,checks[0].id,'artifact:sample',new AbortController().signal,deps({
    current:()=>({scope:{...scope,owner},checks}),fetcher:async()=>{calls++;owner='other';return response('consistent');},
  }));
  assert.equal(calls,1);assert.equal(result,undefined);
});

test('secret-bearing checks, invalid image sizes and invalid references never upload',async()=>{
  let calls=0,reads=0;
  const secret=[{...checks[0],text:'Use token: secret-value'}];
  assert.equal(await assessProofVision(scope,secret,secret[0].id,'artifact:sample',new AbortController().signal,deps({
    current:()=>({scope,checks:secret}),readCapture:async()=>{reads++;return capture();},fetcher:async()=>{calls++;return response('consistent');},
  })),undefined);
  assert.equal(await assessProofVision(scope,checks,checks[0].id,'/private/image.png',new AbortController().signal,deps({readCapture:async()=>{reads++;return capture();}})),undefined);
  const huge=Buffer.from(png);huge.writeUInt32BE(4097,16);
  assert.equal(await assessProofVision(scope,checks,checks[0].id,'artifact:sample',new AbortController().signal,deps({
    readCapture:async()=>capture({png:huge,artifactHash:sha(huge)}),fetcher:async()=>{calls++;return response('consistent');},
  })),undefined);
  assert.equal(reads,0);assert.equal(calls,0);
});

test('provider failures and malformed output do not create an advisory',async()=>{
  for(const fake of [new Response('{}',{status:500}),new Response('x'.repeat(131073)),response('pass')]){
    assert.equal(await assessProofVision(scope,checks,checks[0].id,'artifact:sample',new AbortController().signal,deps({fetcher:async()=>fake})),undefined);
  }
  const abort=new AbortController();abort.abort();let reads=0;
  assert.equal(await assessProofVision(scope,checks,checks[0].id,'artifact:sample',abort.signal,deps({readCapture:async()=>{reads++;return capture();}})),undefined);assert.equal(reads,0);
});
