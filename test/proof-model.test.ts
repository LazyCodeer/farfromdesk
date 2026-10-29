import test from 'node:test';
import assert from 'node:assert/strict';
import {wonderProofJudge} from '../src/proof-model.js';
import {META_ENDPOINT} from '../src/meta-brain-config.js';
import type {ProofJudgeInput} from '../src/proof-check.js';

const input:ProofJudgeInput[]=[{index:1,category:'test',signals:[{source:'independent-test',verdict:'pass'}]},{index:2,category:'visual',signals:[]}];
const response=(args:unknown)=>new Response(JSON.stringify({id:'r',created:0,model:'muse-wonder-1.0',choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'call-1',type:'function',function:{name:'assess',arguments:JSON.stringify(args)}}]}}]}),{headers:{'content-type':'application/json'}});

test('Wonder receives only bounded sanitized signal codes and returns advisory verdicts',async()=>{
  let calls=0;
  const judge=wonderProofJudge('synthetic-test-key',async(url,init)=>{
    calls++;assert.equal(url,META_ENDPOINT);assert.equal(init?.redirect,'error');
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic-test-key');
    const body=JSON.parse(init!.body as string);
    assert.equal(body.model,'muse-wonder-1.0');assert.equal(body.max_tokens,1024);
    assert.deepEqual(body.tools.map((entry:any)=>entry.function.name),['assess']);
    const user=body.messages.find((message:any)=>message.role==='user');
    assert.deepEqual(JSON.parse(user.content),{checks:input});
    return response({checks:[{index:1,verdict:'pass'},{index:2,verdict:'unverified'}]});
  });
  assert.deepEqual(await judge(input,new AbortController().signal),[{index:1,verdict:'pass'},{index:2,verdict:'unverified'}]);
  assert.equal(calls,1);
});

test('the judge rejects free text, owner identifiers and oversized inputs before any call',async()=>{
  let calls=0;const judge=wonderProofJudge('synthetic-test-key',async()=>{calls++;return response({checks:[]});});
  assert.equal(await judge([{...input[0],owner:'owner-private'}] as unknown as ProofJudgeInput[],new AbortController().signal),undefined);
  assert.equal(await judge([{...input[0],signals:Array(11).fill(input[0].signals[0])}],new AbortController().signal),undefined);
  assert.equal(calls,0);
});

test('missing tool call, provider errors, oversized response and abort fail closed',async()=>{
  const badResponses=[new Response('{}',{status:500}),new Response('x'.repeat(131073)),new Response(JSON.stringify({choices:[]} ),{headers:{'content-type':'application/json'}})];
  for(const fake of badResponses){
    const judge=wonderProofJudge('synthetic-test-key',async()=>fake);
    assert.equal(await judge(input,new AbortController().signal),undefined);
  }
  let calls=0;const aborted=new AbortController();aborted.abort();
  assert.equal(await wonderProofJudge('synthetic-test-key',async()=>{calls++;return response({});})(input,aborted.signal),undefined);
  assert.equal(calls,0);
});

test('the text judge returns after abort even if the fetcher ignores cancellation',async()=>{
  const abort=new AbortController();let started!:()=>void;
  const begun=new Promise<void>(resolve=>{started=resolve;});
  const judge=wonderProofJudge('synthetic-test-key',async()=>{started();return await new Promise<Response>(()=>{});});
  const result=judge(input,abort.signal);await begun;abort.abort();
  assert.equal(await Promise.race([result,new Promise(resolve=>setTimeout(()=>resolve('hung'),500))]),undefined);
});

test('the text judge cancels a stalled response body after abort',async()=>{
  const abort=new AbortController();let started!:()=>void,cancelled=false;
  const begun=new Promise<void>(resolve=>{started=resolve;});
  const stream=new ReadableStream<Uint8Array>({pull(){started();},cancel(){cancelled=true;}},{highWaterMark:0});
  const judge=wonderProofJudge('synthetic-test-key',async()=>new Response(stream,{headers:{'content-type':'application/json'}}));
  const result=judge(input,abort.signal);await begun;abort.abort();
  assert.equal(await Promise.race([result,new Promise(resolve=>setTimeout(()=>resolve('hung'),500))]),undefined);
  assert.equal(cancelled,true);
});
