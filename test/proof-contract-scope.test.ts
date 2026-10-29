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
import {MetaBrain} from '../src/meta-brain.js';
import {DEFAULT_BRAIN,MetaSecret,saveBrainConfig} from '../src/meta-brain-config.js';
import {TaskContracts} from '../src/task-contracts.js';
import {ProofChecks} from '../src/proof-check.js';
import {contractProofScope} from '../src/proof-contract-scope.js';

async function fixture(record=true) {
  const dir=mkdtempSync(join(tmpdir(),'ffd-proof-scope-')),store=new Store(':memory:'),approvals=new Approvals(store);
  const router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);router.pump=()=>{};
  const owner='owner@s.whatsapp.net';store.set('whatsapp-owner',owner);
  const binding=store.register('synthetic','codex',randomUUID(),dir).binding;store.set('active',binding.id);
  const secret=new MetaSecret(dir);secret.save('synthetic-key-not-a-real-secret');
  router.brain=new MetaBrain(store,secret,{interpret:async()=>{throw Error('not called');}} as any);
  saveBrainConfig(store,secret,{policy:{...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:['codex'],failure:'block'}});
  router.contracts=new TaskContracts(store,secret,async()=>({kind:'contract',goal:'Change theme',exclusions:[],checks:['Theme works','Previous mode works'],question:''}));
  await router.receive({id:'wa:request',text:'Change theme',ownerIntent:true,ownerCommand:true});
  store.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
  // Simulates the real bridge's durable authenticated-input capture. Main's
  // current plain-text approval path does not yet provide this automatically.
  if(record){const captured=store.captureIncomingOwner(owner,'whatsapp')!;store.incomingOwnerContext.run(captured,()=>store.recordIncomingInput('wa:approval'));}
  await router.receive({id:'wa:approval',text:'ok',ownerIntent:true,ownerCommand:true});
  store.jobState('wa:approval','dispatched');
  router.channelReply(binding,'Everything passed, see my PR','final','wa:approval',undefined,{outcome:'done'});
  return {store,router,binding,owner,id:'wa:approval',close(){approvals.cancel();store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('bridge scope binds a real F3 approval and attempt but self-reports cannot become evidence',async()=>{
  const f=await fixture();try{
    const actual=contractProofScope(f.router,f.id);assert.ok(actual);
    assert.equal(actual.scope.targetRepository,null);assert.equal(actual.scope.targetRevision,null);
    assert.equal(actual.scope.attemptId,f.store.job(f.id)?.attempt_id);
    assert.deepEqual(actual.checks.map(c=>c.text),['Theme works','Previous mode works']);
    assert.ok(actual.checks.every(c=>!c.evidenceBindings));
    let observations=0,judgments=0;
    const engine=new ProofChecks(f.store),deps={current:()=>contractProofScope(f.router,f.id),
      observe:async()=>{observations++;throw Error('must not execute');},judge:async()=>{judgments++;return undefined;}};
    const result=await engine.evaluate(actual.scope,actual.checks,{[actual.checks[0].id]:['check-run:123']},'synthetic-eval',deps);
    assert.deepEqual(result.checks.map(c=>c.verdict),['unverified','unverified']);
    assert.equal(observations,0);assert.equal(judgments,0);
    assert.equal(engine.claimCorrection(result.id,actual.scope,actual.checks,deps.current),false);
  }finally{f.close();}
});

test('missing durable approval provenance remains unverified',async()=>{
  const f=await fixture(false);try{assert.equal(contractProofScope(f.router,f.id),undefined);}finally{f.close();}
});

test('owner, channel, approval, item, session or attempt changes invalidate the scope',async()=>{
  for(const mode of ['owner','channel','approval','item','session','attempt','event','origin','parent']){
    const f=await fixture();try{
      assert.ok(contractProofScope(f.router,f.id));
      if(mode==='owner'){f.store.set('whatsapp-owner','other@s.whatsapp.net');f.store.set('whatsapp-owner',f.owner);}
      if(mode==='channel'){f.store.set('control-channel','telegram');f.store.set('control-channel','whatsapp');}
      if(mode==='approval')f.store.db.prepare("UPDATE task_contracts SET draft='{}' WHERE dispatch_id=?").run(f.id);
      if(mode==='item')f.store.db.prepare('DELETE FROM item_owner_origins').run();
      if(mode==='session')f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),f.binding.id);
      if(mode==='attempt')f.store.db.prepare('UPDATE inbox SET attempt_id=? WHERE id=?').run(randomUUID(),f.id);
      if(mode==='event')f.store.db.prepare("DELETE FROM request_events WHERE request_id=? AND event='dispatched'").run(f.id);
      if(mode==='origin')f.store.db.prepare('DELETE FROM incoming_owner_inputs WHERE id=?').run(f.id);
      if(mode==='parent')f.store.set(`parent:${f.id}`,'wa:another');
      assert.equal(contractProofScope(f.router,f.id),undefined,mode);
    }finally{f.close();}
  }
});

test('stale owner proof is not readable and cannot authorize a correction',async()=>{
  const f=await fixture();try{
    const actual=contractProofScope(f.router,f.id)!;const engine=new ProofChecks(f.store),current=()=>contractProofScope(f.router,f.id);
    const run=await engine.evaluate(actual.scope,actual.checks,{},'run', {current});
    f.store.set('whatsapp-owner','other@s.whatsapp.net');f.store.set('whatsapp-owner',f.owner);
    assert.equal(engine.get(run.id,actual.scope,actual.checks,current),undefined);
    assert.equal(engine.claimCorrection(run.id,actual.scope,actual.checks,current),false);
  }finally{f.close();}
});
