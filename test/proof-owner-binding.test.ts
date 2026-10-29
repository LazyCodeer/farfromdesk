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
import {ProofScopeFence,contractProofScope} from '../src/proof-contract-scope.js';
import {ProofOwnerBindings} from '../src/proof-owner-binding.js';
import {ProofChecks} from '../src/proof-check.js';

async function fixture(persistent=false){
  const dir=mkdtempSync(join(tmpdir(),'ffd-proof-binding-')),store=new Store(persistent?join(dir,'state.sqlite'):':memory:'),approvals=new Approvals(store);
  const router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);router.pump=()=>{};new ProofScopeFence(store);
  const owner='owner@s.whatsapp.net';store.set('whatsapp-owner',owner);
  const binding=store.register('synthetic','codex',randomUUID(),dir).binding;store.set('active',binding.id);
  const secret=new MetaSecret(dir);secret.save('synthetic-key-not-a-real-secret');
  router.brain=new MetaBrain(store,secret,{interpret:async()=>{throw Error('not called');}} as any);
  saveBrainConfig(store,secret,{policy:{...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:['codex'],failure:'block'}});
  router.contracts=new TaskContracts(store,secret,async()=>({kind:'contract',goal:'Change theme',exclusions:[],checks:['GitHub check Backend tests passed','Theme works'],question:''}));
  await router.receive({id:'wa:request',text:'Change theme',ownerIntent:true,ownerCommand:true});
  store.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
  const context=store.captureIncomingOwner(owner,'whatsapp')!;store.incomingOwnerContext.run(context,()=>store.recordIncomingInput('wa:approval'));
  await router.receive({id:'wa:approval',text:'ok',ownerIntent:true,ownerCommand:true});
  store.jobState('wa:approval','dispatched');router.channelReply(binding,'Done','final','wa:approval',undefined,{outcome:'done'});
  const bindings=new ProofOwnerBindings(router),id='wa:approval';
  const approve=(message:any={})=>store.incomingOwnerContext.run(store.captureIncomingOwner(owner,'whatsapp')!,()=>bindings.approve({id:'wa:bind',text:`/proof bind ${id} 1 example/project`,ownerCommand:true,...message}));
  return {store,router,binding,owner,bindings,id,dir,approve,close(){approvals.cancel();try{store.close();}catch{}rmSync(dir,{recursive:true,force:true});}};
}

test('only an exact approved contract check can receive an owner binding',async()=>{
  const f=await fixture();try{
    assert.ok(contractProofScope(f.router,f.id));
    const result=f.approve();assert.equal(result.repository,'example/project');assert.equal(result.checkName,'Backend tests');
    assert.equal(f.bindings.approved(f.id).length,1);assert.deepEqual(f.approve(),result);
    assert.throws(()=>f.approve({id:'wa:second',text:'/proof bind wa:approval 1 another/project'}),/already has/);
    const base=contractProofScope(f.router,f.id)!;assert.ok(base.checks.every(c=>!c.evidenceBindings));
    let observations=0;const engine=new ProofChecks(f.store);
    const run=await engine.evaluate(base.scope,base.checks,{[base.checks[0].id]:['check-run:19']},'binding-test',{
      current:()=>contractProofScope(f.router,f.id),observe:async()=>{observations++;throw Error('must not run');}});
    assert.equal(observations,0);assert.ok(run.checks.every(c=>c.verdict==='unverified'));
    assert.equal(engine.claimCorrection(run.id,base.scope,base.checks,()=>contractProofScope(f.router,f.id)),false);
  }finally{f.close();}
});

test('voice, quoted, forwarded, other-owner and mismatched checks cannot approve',async()=>{
  const f=await fixture();try{
    for(const message of [{ownerCommand:false},{source:'voice'},{quotedId:'other'},{id:'parent:unsafe'},
      {text:'/proof bind wa:approval 2 example/project'},{text:'/proof bind wa:approval 1 ../project'},
      {text:'/proof bind wa:approval 1 example/project\nextra'}])assert.throws(()=>f.approve(message));
    assert.equal(f.bindings.approved(f.id).length,0);
    const group='111@g.us';f.store.set('destination-jid',group);f.store.set(`owned-group:${group}`,'test');
    const groupContext=f.store.captureIncomingOwner(group,'whatsapp')!;
    assert.throws(()=>f.store.incomingOwnerContext.run(groupContext,()=>f.store.destinationContext.run(group,()=>f.bindings.approve({id:'wa:group',text:'/proof bind wa:approval 1 example/project',ownerCommand:true}))));
  }finally{f.close();}
});

test('owner, session or policy changes revoke the approved binding even if restored',async()=>{
  for(const change of ['owner','session','policy'] as const){
    const f=await fixture();try{
      f.approve();assert.equal(f.bindings.approved(f.id).length,1);
      if(change==='owner'){f.store.set('whatsapp-owner','other@s.whatsapp.net');f.store.set('whatsapp-owner',f.owner);}
      if(change==='session'){f.store.enable(f.binding.id,false);f.store.enable(f.binding.id,true);}
      if(change==='policy'){const old=f.store.get('meta-brain-policy')!;f.store.set('meta-brain-policy','{}');f.store.set('meta-brain-policy',old);}
      assert.equal(f.bindings.approved(f.id).length,0,change);
    }finally{f.close();}
  }
});

test('saved binding survives a restart but not a revoked owner generation',async()=>{
  const f=await fixture(true);let reopened:Store|undefined;try{
    f.approve();f.store.close();reopened=new Store(join(f.dir,'state.sqlite'));
    const approvals=new Approvals(reopened),router=new Router(reopened,{run:async()=>{},stop:()=>{}} as any,approvals),secret=new MetaSecret(f.dir);
    router.brain=new MetaBrain(reopened,secret,{interpret:async()=>{throw Error('not called');}} as any);router.contracts=new TaskContracts(reopened,secret);
    new ProofScopeFence(reopened);const bindings=new ProofOwnerBindings(router);
    assert.equal(bindings.approved(f.id).length,1);
    reopened.set('whatsapp-owner','other@s.whatsapp.net');reopened.set('whatsapp-owner',f.owner);
    assert.equal(bindings.approved(f.id).length,0);approvals.cancel();reopened.close();reopened=undefined;
  }finally{reopened?.close();f.close();}
});
