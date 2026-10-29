import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {ProofChecks,proofScopeHash,type ProofScope,type ProofCheck,type ProofObservation,type ProofJudgeInput} from '../src/proof-check.js';

const now=1_850_000_000_000;
const scope:ProofScope={contractId:'contract-1',revision:2,approvedHash:'a'.repeat(64),approvedAt:now-6000,
  owner:'owner-a',destination:'chat-a',rootRequestId:'wa:message-1',itemId:42,bindingId:'binding-a',bindingHash:'b'.repeat(64),
  attemptId:'attempt-1',startedAt:now-5000,targetRepository:'owner/repo',targetRevision:'c'.repeat(40)};
// Synthetic owner-approved evidence bindings. Production F3 currently has none.
const checks:ProofCheck[]=[
  {id:'contract-1:2:1',text:'Tests pass',evidenceBindings:[{source:'independent-test',bindingHash:'e'.repeat(64)}]},
  {id:'contract-1:2:2',text:'Screen matches the contract',evidenceBindings:[{source:'consented-screen',bindingHash:'f'.repeat(64)}]},
];
const current=()=>({scope:{...scope},checks:checks.map(c=>({...c}))});
const confirm=async(input:ProofJudgeInput[])=>input.map(c=>({index:c.index,verdict:'pass' as const}));
function fixture(){const store=new Store(':memory:');return {store,proof:new ProofChecks(store,()=>now)};}
function observation(checkId:string,verdict:'pass'|'fail'='pass',changes:Partial<ProofObservation>={}):ProofObservation {
  return {scopeHash:proofScopeHash(scope,checks),checkId,source:'independent-test',bindingHash:checkId===checks[1].id?'f'.repeat(64):'e'.repeat(64),verdict,observedAt:now-1000,digest:'d'.repeat(64),...changes};
}

test('a session report or URL alone cannot produce a pass or correction',async()=>{
  const f=fixture();try{
    const run=await f.proof.evaluate(scope,checks,{[checks[0].id]:['session-report']},'eval-1',{current});
    assert.deepEqual(run.checks.map(c=>c.verdict),['unverified','unverified']);
    assert.equal(await f.proof.claimCorrection(run.id,scope,checks,current),false);
    assert.equal(f.proof.get(run.id,{...scope,owner:'other-owner'},checks,current),undefined);
    assert.equal(f.proof.get(run.id,{...scope,destination:'other-chat'},checks,current),undefined);
    assert.equal(f.proof.get(run.id,scope,checks,()=>({scope:{...scope,owner:'other-owner'},checks})),undefined);
  }finally{f.store.close();}
});

test('only fresh independently resolved evidence for the exact run can pass or fail',async()=>{
  const f=fixture();try{
    const run=await f.proof.evaluate(scope,checks,{[checks[0].id]:['test-id'],[checks[1].id]:['screen-id']},'eval-1',{
      current,judge:confirm,observe:async(id,check)=>id==='test-id'?observation(check.id,'pass'):observation(check.id,'fail',{source:'consented-screen',digest:'e'.repeat(64)}),
    });
    assert.deepEqual(run.checks.map(c=>c.verdict),['pass','fail']);
    assert.deepEqual(run.checks[0].evidenceDigests,['d'.repeat(64)]);
    assert.equal(await f.proof.claimCorrection(run.id,scope,checks,current),true);
    assert.equal(await f.proof.claimCorrection(run.id,scope,checks,current),false);
  }finally{f.store.close();}
});

test('old, mismatched, future or malformed evidence remains unverified',async()=>{
  const f=fixture();try{
    const cases:Partial<ProofObservation>[]=[
      {scopeHash:'f'.repeat(64)}, {checkId:checks[1].id}, {observedAt:scope.startedAt-1},
      {observedAt:now+1}, {digest:'not-a-digest'}, {source:'session-report' as ProofObservation['source']}, {bindingHash:'f'.repeat(64)},
    ];
    for(const [i,changes] of cases.entries()){
      const run=await f.proof.evaluate(scope,checks,{[checks[0].id]:['observation']},`eval-${i}`,{
        current,observe:async()=>observation(checks[0].id,'pass',changes),
      });
      assert.equal(run.checks[0].verdict,'unverified');
    }
  }finally{f.store.close();}
});

test('natural-language checks without an approved evidence binding cannot pass',async()=>{
  const f=fixture();try{
    const unbound=checks.map(({id,text})=>({id,text}));
    let called=0;
    const run=await f.proof.evaluate(scope,unbound,{[unbound[0].id]:['independent']},'eval-1',{
      current:()=>({scope,checks:unbound}),judge:confirm,
      observe:async()=>{called++;return observation(unbound[0].id,'pass',{scopeHash:proofScopeHash(scope,unbound)});},
    });
    assert.equal(called,0);assert.equal(run.checks[0].verdict,'unverified');
  }finally{f.store.close();}
});

test('unconfirmed target revision never produces proof even from a resolver',async()=>{
  const f=fixture();try{
    let calls=0;const noHead={...scope,targetRevision:null};
    const run=await f.proof.evaluate(noHead,checks,{[checks[0].id]:['test-id']},'eval-1',{
      current:()=>({scope:noHead,checks}),observe:async()=>{calls++;return observation(checks[0].id);},
    });
    assert.equal(calls,0);assert.equal(run.checks[0].verdict,'unverified');
  }finally{f.store.close();}
});

test('owner, session, contract or checks changed while verifier awaits leaves no partial result',async()=>{
  for(const change of [
    {owner:'owner-b'}, {bindingHash:'f'.repeat(64)}, {attemptId:'attempt-2'},
    {targetRevision:'f'.repeat(40)}, {revision:3},
  ]){
    const f=fixture();try{
      let n=0;
      await assert.rejects(f.proof.evaluate(scope,checks,{[checks[0].id]:['test-id']},'eval-1',{
        current:()=>{const changed=n++>0;return {scope:changed?{...scope,...change}:scope,checks:changed&&change.revision?checks.map((c,i)=>({...c,id:`contract-1:3:${i+1}`})):checks};},
        observe:async()=>observation(checks[0].id),
      }),/changed/);
      assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM proof_runs').get() as {n:number}).n,0);
    }finally{f.store.close();}
  }
});

test('approved check text is part of the revalidated scope',async()=>{
  const f=fixture();try{
    await assert.rejects(f.proof.evaluate(scope,checks,{},'eval-1',{
      current:()=>({scope,checks:[{...checks[0],text:'Different check'},checks[1]]}),
    }),/changed/);
  }finally{f.store.close();}
});

test('owner revoked in the same database during evidence collection prevents persistence',async()=>{
  const f=fixture();try{
    f.store.set('test-owner',scope.owner);
    const ownerFromStore=()=>({scope:{...scope,owner:f.store.get('test-owner')!},checks});
    await assert.rejects(f.proof.evaluate(scope,checks,{[checks[0].id]:['independent']},'eval-1',{
      current:ownerFromStore,observe:async()=>{f.store.set('test-owner','new-owner');return observation(checks[0].id);},
    }),/changed/);
    assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM proof_runs').get() as {n:number}).n,0);
  }finally{f.store.close();}
});

test('caller cannot mutate the owner, checks or evidence references while verification awaits',async()=>{
  const f=fixture();try{
    const mutableScope={...scope},mutableChecks=checks.map(c=>({...c})),refs={[checks[0].id]:['independent']};
    const run=await f.proof.evaluate(mutableScope,mutableChecks,refs,'eval-1',{
      current,judge:confirm,observe:async()=>{mutableScope.owner='other-owner';mutableChecks[0].text='Different';refs[checks[0].id][0]='changed';return observation(checks[0].id);},
    });
    assert.equal(run.scope.owner,scope.owner);assert.equal(run.checks[0].verdict,'pass');
    assert.equal(f.proof.get(run.id,{...scope,owner:'other-owner'},checks,current),undefined);
  }finally{f.store.close();}
});

test('provider errors, malformed references and old observations cannot create proof',async()=>{
  const f=fixture();try{
    const run=await f.proof.evaluate(scope,checks,{[checks[0].id]:['independent']},'eval-1',{
      current,observe:async()=>{throw new Error('provider failed');},
    });
    assert.equal(run.checks[0].verdict,'unverified');
    await assert.rejects(f.proof.evaluate(scope,checks,{[checks[0].id]:['https://untrusted.test/path']},'eval-2',{current}),/references/);
    const longRun={...scope,startedAt:now-40*60_000,approvedAt:now-41*60_000};
    const old=await f.proof.evaluate(longRun,checks,{[checks[0].id]:['independent']},'eval-3',{
      current:()=>({scope:longRun,checks}),
      observe:async()=>observation(checks[0].id,'pass',{scopeHash:proofScopeHash(longRun,checks),observedAt:now-31*60_000}),
    });
    assert.equal(old.checks[0].verdict,'unverified');
  }finally{f.store.close();}
});

test('an evaluation is idempotent but can be explicitly rechecked when evidence arrives',async()=>{
  const f=fixture();try{
    const first=await f.proof.evaluate(scope,checks,{},'eval-1',{current});
    const repeat=await f.proof.evaluate(scope,checks,{},'eval-1',{current});
    assert.equal(first.id,repeat.id);
    await assert.rejects(f.proof.evaluate(scope,checks,{[checks[0].id]:['different']},'eval-1',{current}),/reused/);
    const later=await f.proof.evaluate(scope,checks,{[checks[0].id]:['independent']},'eval-2',{
      current,judge:confirm,observe:async()=>observation(checks[0].id),
    });
    assert.notEqual(first.id,later.id);assert.equal(later.checks[0].verdict,'pass');
  }finally{f.store.close();}
});

test('one correction per approved contract, even across distinct attempts',async()=>{
  const f=fixture();try{
    const run=await f.proof.evaluate(scope,checks,{[checks[0].id]:['independent']},'eval-1',{
      current,observe:async()=>observation(checks[0].id,'fail'),
    });
    assert.equal(await f.proof.claimCorrection(run.id,scope,checks,()=>({scope:{...scope,owner:'new-owner'},checks})),false);
    assert.equal(await f.proof.claimCorrection(run.id,scope,checks,current),true);
    const other={...scope,attemptId:'attempt-2'};
    const retry=await f.proof.evaluate(other,checks,{[checks[0].id]:['independent']},'eval-2',{
      current:()=>({scope:other,checks}),observe:async()=>observation(checks[0].id,'fail',{scopeHash:proofScopeHash(other,checks)}),
    });
    assert.equal(await f.proof.claimCorrection(retry.id,other,checks,()=>({scope:other,checks})),false);
  }finally{f.store.close();}
});

test('an old failure cannot trigger a correction after a later check passes',async()=>{
  const f=fixture();try{
    const failure=await f.proof.evaluate(scope,checks,{[checks[0].id]:['independent']},'eval-1',{
      current,observe:async()=>observation(checks[0].id,'fail'),
    });
    const success=await f.proof.evaluate(scope,checks,{[checks[0].id]:['independent']},'eval-2',{
      current,judge:confirm,observe:async()=>observation(checks[0].id,'pass',{observedAt:now-999}),
    });
    assert.equal(success.checks[0].verdict,'pass');
    assert.equal(f.proof.claimCorrection(failure.id,scope,checks,current),false);
  }finally{f.store.close();}
});

test('an earlier slow failed evaluation cannot supersede a later passing evaluation',async()=>{
  const f=fixture();try{
    let release!:()=>void,started!:()=>void;
    const blocked=new Promise<void>(done=>{release=done;}),begun=new Promise<void>(done=>{started=done;});
    const slow=f.proof.evaluate(scope,checks,{[checks[0].id]:['fail-ref']},'eval-old',{
      current,observe:async()=>{started();await blocked;return observation(checks[0].id,'fail');},
    });
    await begun;
    const fresh=await f.proof.evaluate(scope,checks,{[checks[0].id]:['pass-ref']},'eval-new',{
      current,judge:confirm,observe:async()=>observation(checks[0].id,'pass'),
    });
    release();await assert.rejects(slow,/superseded/);
    assert.equal(fresh.checks[0].verdict,'pass');assert.equal(f.proof.claimCorrection(fresh.id,scope,checks,current),false);
    // The superseded observer returned a conflicting same-time result after
    // completion; previously returned evidence is no longer current.
    assert.equal(f.proof.get(fresh.id,scope,checks,current)?.checks[0].verdict,'unverified');
    assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM proof_runs').get() as {n:number}).n,1);
  }finally{f.store.close();}
});

test('starting a newer evaluation makes an earlier failure non-actionable immediately',async()=>{
  const f=fixture();try{
    const old=await f.proof.evaluate(scope,checks,{[checks[0].id]:['fail-ref']},'eval-old',{
      current,observe:async()=>observation(checks[0].id,'fail'),
    });
    let release!:()=>void,started!:()=>void;
    const blocked=new Promise<void>(done=>{release=done;}),begun=new Promise<void>(done=>{started=done;});
    const newer=f.proof.evaluate(scope,checks,{[checks[0].id]:['pass-ref']},'eval-new',{
      current,judge:confirm,observe:async()=>{started();await blocked;return observation(checks[0].id,'pass',{observedAt:now-999});},
    });
    await begun;
    assert.equal(f.proof.get(old.id,scope,checks,current)?.checks[0].verdict,'unverified');
    assert.equal(f.proof.claimCorrection(old.id,scope,checks,current),false);
    release();assert.equal((await newer).checks[0].verdict,'pass');
  }finally{f.store.close();}
});

test('later evaluation cannot reuse older failing evidence after a newer pass',async()=>{
  const f=fixture();try{
    const pass=await f.proof.evaluate(scope,checks,{[checks[0].id]:['new-pass']},'eval-pass',{
      current,judge:confirm,observe:async()=>observation(checks[0].id,'pass',{observedAt:now-1000}),
    });
    assert.equal(pass.checks[0].verdict,'pass');
    const old=await f.proof.evaluate(scope,checks,{[checks[0].id]:['old-fail']},'eval-later',{
      current,observe:async()=>observation(checks[0].id,'fail',{observedAt:now-4000}),
    });
    assert.equal(old.checks[0].verdict,'unverified');assert.equal(f.proof.claimCorrection(old.id,scope,checks,current),false);
  }finally{f.store.close();}
});

test('newer trusted observation invalidates an earlier result even before its own evaluation completes',async()=>{
  const f=fixture();try{
    let release!:()=>void,started!:()=>void;
    const blocked=new Promise<void>(done=>{release=done;}),begun=new Promise<void>(done=>{started=done;});
    const newer=f.proof.evaluate(scope,checks,{[checks[0].id]:['new-pass']},'eval-first',{
      current,observe:async()=>observation(checks[0].id,'pass',{observedAt:now-1000}),
      judge:async(input)=>{started();await blocked;return confirm(input);},
    });
    await begun;
    const old=await f.proof.evaluate(scope,checks,{[checks[0].id]:['old-fail']},'eval-second',{
      current,observe:async()=>observation(checks[0].id,'fail',{observedAt:now-4000}),
    });
    assert.equal(old.checks[0].verdict,'unverified');assert.equal(f.proof.claimCorrection(old.id,scope,checks,current),false);
    release();await assert.rejects(newer,/superseded/);
  }finally{f.store.close();}
});

test('same-time conflicting evidence remains unverified until a newer observation',async()=>{
  const f=fixture();try{
    const first=await f.proof.evaluate(scope,checks,{[checks[0].id]:['fail']},'eval-1',{
      current,observe:async()=>observation(checks[0].id,'fail',{observedAt:now-1000}),
    });
    assert.equal(first.checks[0].verdict,'fail');
    const conflict=await f.proof.evaluate(scope,checks,{[checks[0].id]:['pass']},'eval-2',{
      current,judge:confirm,observe:async()=>observation(checks[0].id,'pass',{observedAt:now-1000}),
    });
    assert.equal(conflict.checks[0].verdict,'unverified');assert.equal(f.proof.claimCorrection(conflict.id,scope,checks,current),false);
    const newer=await f.proof.evaluate(scope,checks,{[checks[0].id]:['newer']},'eval-3',{
      current,judge:confirm,observe:async()=>observation(checks[0].id,'pass',{observedAt:now-999}),
    });
    assert.equal(newer.checks[0].verdict,'pass');
  }finally{f.store.close();}
});

test('different sources with conflicting conclusions require a new check',async()=>{
  const f=fixture();try{
    const twoChecks=[{...checks[0],evidenceBindings:[...checks[0].evidenceBindings!,{source:'github-check' as const,bindingHash:'7'.repeat(64)}]},checks[1]];
    const hash=proofScopeHash(scope,twoChecks),actual=()=>({scope,checks:twoChecks});
    const first=await f.proof.evaluate(scope,twoChecks,{[checks[0].id]:['test']},'eval-1',{
      current:actual,judge:confirm,observe:async()=>observation(checks[0].id,'pass',{scopeHash:hash,observedAt:now-1000}),
    });
    assert.equal(first.checks[0].verdict,'pass');
    const next=await f.proof.evaluate(scope,twoChecks,{[checks[0].id]:['github']},'eval-2',{
      current:actual,observe:async()=>observation(checks[0].id,'fail',{scopeHash:hash,source:'github-check',bindingHash:'7'.repeat(64),observedAt:now-500}),
    });
    assert.equal(next.checks[0].verdict,'unverified');assert.equal(f.proof.claimCorrection(next.id,scope,twoChecks,actual),false);
  }finally{f.store.close();}
});

test('contradictory observations from the same binding are unverified regardless of model output',async()=>{
  const f=fixture();try{
    const run=await f.proof.evaluate(scope,checks,{[checks[0].id]:['a','b']},'eval-1',{
      current,judge:confirm,observe:async(id)=>observation(checks[0].id,id==='a'?'fail':'pass',{observedAt:id==='a'?now-2000:now-1000}),
    });
    assert.equal(run.checks[0].verdict,'unverified');assert.match(run.checks[0].reason,/conflicting/i);
    assert.equal(f.proof.claimCorrection(run.id,scope,checks,current),false);
  }finally{f.store.close();}
});

test('model assessment cannot manufacture proof from session claims or absent evidence',async()=>{
  const f=fixture();try{
    let called=0;
    const result=await f.proof.evaluate(scope,checks,{[checks[0].id]:['session-report']},'eval-1',{
      current,judge:async(input)=>{called++;return confirm(input);},
    });
    assert.equal(called,0);assert.equal(result.checks[0].verdict,'unverified');
  }finally{f.store.close();}
});

test('model sees only sanitized categories and cannot turn verified pass into failure',async()=>{
  const f=fixture();try{
    let received='';
    const result=await f.proof.evaluate(scope,checks,{[checks[0].id]:['test-id']},'eval-1',{
      current,observe:async()=>observation(checks[0].id),judge:async(input)=>{
        received=JSON.stringify(input);return input.map(c=>({index:c.index,verdict:'fail'}));
      },
    });
    assert.equal(result.checks[0].verdict,'unverified');
    assert.ok(!received.includes(scope.owner));assert.ok(!received.includes(scope.destination));
    assert.ok(!received.includes(checks[0].text));assert.ok(!received.includes(scope.targetRevision!));
    assert.ok(!received.includes('test-id'));assert.ok(received.includes('independent-test'));
  }finally{f.store.close();}
});

test('missing or malformed model results cannot upgrade an observation',async()=>{
  const f=fixture();try{
    const deps={current,observe:async()=>observation(checks[0].id)};
    const missing=await f.proof.evaluate(scope,checks,{[checks[0].id]:['test-id']},'eval-1',deps);
    const duplicate=await f.proof.evaluate(scope,checks,{[checks[0].id]:['test-id']},'eval-2',{
      ...deps,judge:async()=>[{index:1,verdict:'pass' as const},{index:1,verdict:'pass' as const}],
    });
    assert.equal(missing.checks[0].verdict,'unverified');assert.equal(duplicate.checks[0].verdict,'unverified');
  }finally{f.store.close();}
});

test('expired evidence cannot remain a pass or trigger a correction',async()=>{
  const store=new Store(':memory:');let clock=now;const proof=new ProofChecks(store,()=>clock);
  try {
    const run=await proof.evaluate(scope,checks,{[checks[0].id]:['independent']},'eval-1',{
      current,observe:async()=>observation(checks[0].id,'fail'),
    });
    assert.equal(run.checks[0].verdict,'fail');
    clock+=30*60_000;
    assert.equal(proof.get(run.id,scope,checks,current)?.checks[0].verdict,'unverified');
    assert.equal(proof.claimCorrection(run.id,scope,checks,current),false);
    assert.equal((await proof.evaluate(scope,checks,{[checks[0].id]:['independent']},'eval-1',{current})).checks[0].verdict,'unverified');
  }finally{store.close();}
});
