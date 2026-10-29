import test from 'node:test';
import assert from 'node:assert/strict';
import {hypotheticalHandoffPermitted,type LifecycleFixture} from './fixtures/desktop-lifecycle-model.mjs';

function candidate():LifecycleFixture{return {
  expected:{session:'session-1',request:'request-1',attempt:'attempt-1',envelopeHash:'digest-1',owner:'owner-1',destination:'chat-1',contractHash:'contract-1',revision:1,bindingFingerprint:'binding-1',claimGeneration:1},
  current:{session:'session-1',request:'request-1',attempt:'attempt-1',owner:'owner-1',destination:'chat-1',contractHash:'contract-1',revision:1,bindingFingerprint:'binding-1',claimGeneration:1},
  prompt:{session:'session-1',promptId:'prompt-1',envelopeHash:'digest-1',originProof:true},
  stop:{session:'session-1',promptId:'prompt-1',invocation:'hypothetical-stop-1',backgroundTasks:[],sessionCrons:[]},
  telemetry:{session:'session-1',promptId:'prompt-1',invocation:'hypothetical-stop-1',blocking:0,cancelled:0,nonBlockingErrors:0,additionalContextChars:0,persistedOutputs:0},
  orderedCompleteStream:true,exclusiveProviderFence:true,uniquePromptMapping:true,interrupted:false,
};}

test('a hypothetical handoff needs trusted origin and a complete, fenced provider stream',()=>{
  assert.equal(hypotheticalHandoffPermitted(candidate()),true);
  for(const key of ['originProof','orderedCompleteStream','exclusiveProviderFence']){
    const f=candidate();if(key==='originProof')f.prompt.originProof=false;
    else if(key==='orderedCompleteStream')f.orderedCompleteStream=false;else f.exclusiveProviderFence=false;
    assert.equal(hypotheticalHandoffPermitted(f),false,key);
  }
});

test('missing, vetoed, continued or cancelled stop events cannot establish completion',()=>{
  const cases:((f:LifecycleFixture)=>void)[]=[
    f=>{f.telemetry=null;},f=>{f.telemetry!.blocking=1;},f=>{f.telemetry!.cancelled=1;},
    f=>{f.telemetry!.nonBlockingErrors=1;},f=>{f.telemetry!.additionalContextChars=2;},f=>{f.telemetry!.persistedOutputs=1;},
    f=>{f.interrupted=true;},f=>{f.uniquePromptMapping=false;},
    f=>{f.stop.backgroundTasks=['still-running'];},f=>{f.stop.backgroundTasks=null;},
    f=>{f.stop.sessionCrons=['wakeup'];},f=>{f.stop.sessionCrons=null;},
  ];
  for(const alter of cases){const f=candidate();alter(f);assert.equal(hypotheticalHandoffPermitted(f),false);}
});

test('stale or cross-session events and ambiguous stop invocations cannot transfer a claim',()=>{
  const cases:((f:LifecycleFixture)=>void)[]=[
    f=>{f.current.attempt='attempt-2';},f=>{f.current.session='session-2';},f=>{f.current.request='request-2';},
    f=>{f.current.owner='owner-2';},f=>{f.current.destination='chat-2';},f=>{f.current.contractHash='contract-2';},
    f=>{f.current.revision=2;},f=>{f.current.bindingFingerprint='binding-2';},f=>{f.current.claimGeneration=2;},
    f=>{f.prompt.session='session-2';},f=>{f.prompt.envelopeHash='digest-2';},
    f=>{f.stop.promptId='prompt-2';},f=>{f.stop.session='session-2';},
    f=>{f.telemetry!.session='session-2';},f=>{f.telemetry!.promptId='prompt-2';},
    f=>{f.telemetry!.invocation='another-stop';},
  ];
  for(const alter of cases){const f=candidate();alter(f);assert.equal(hypotheticalHandoffPermitted(f),false);}
});
