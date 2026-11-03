import './brain-fixture-isolation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Coordinator } from '../src/coordinator.js';
import { Approvals } from '../src/approvals.js';
import { MetaBrain } from '../src/meta-brain.js';
import { MetaSecret, DEFAULT_BRAIN, saveBrainConfig, brainPolicy, PROVIDERS, type BrainProvider } from '../src/meta-brain-config.js';
import { TaskContracts } from '../src/task-contracts.js';
import type { Interpretation } from '../src/meta-model.js';

/** The owner names the platform in the message; the model stays neutral, as it does in production. */
const namedTask=(normalized:string):Interpretation=>({intent:'task',provider:'unspecified',normalized,taskIds:[]});

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'ffd-platform-route-'));
  const store=new Store(':memory:'),approvals=new Approvals(store),native={run:async()=>{},stop:()=>{},catalog:async()=>({sessions:[]})};
  store.set('whatsapp-owner','owner@s.whatsapp.net');
  const router=new Router(store,native as any,approvals),c=new Coordinator(store,native as any,router,()=>{});
  router.coordinator=c;router.pump=()=>{};
  const codex=store.register('codex-proxy','codex',randomUUID(),'/tmp').binding;
  c.registry.register(codex);
  const secret=new MetaSecret(dir);secret.save('synthetic-test-key-never-a-real-key');
  router.contracts=new TaskContracts(store,secret,async()=>({kind:'pass',goal:'',exclusions:[],checks:[],question:''}));
  // The allowlist a real install had saved before Cursor existed: two platforms, none of them cursor.
  const providers:BrainProvider[]=['codex','claude'];
  saveBrainConfig(store,secret,{policy:{...DEFAULT_BRAIN,taskContracts:false,enabled:true,allowRouting:true,failure:'block',providers}});
  const model={interpret:async()=>namedTask('Fix the export')};
  router.brain=new MetaBrain(store,secret,model);
  return {dir,store,router,c,codex,secret,model,close(){approvals.cancel();store.close();rmSync(dir,{recursive:true,force:true});}};
}

/** A Cursor coordinator set up by the owner, exactly as masters.ts leaves the store. */
function provisionCursor(f:ReturnType<typeof fixture>) {
  const cursor=f.store.register('cursor-bro','cursor',randomUUID(),'/tmp').binding;
  f.c.registry.register(cursor);
  f.store.set('enabled-apps',JSON.stringify(['codex','claude','cursor']));
  f.store.set('name:cursor-bro','Cursor Bro');
  return cursor;
}

test('the routing allowlist follows the platforms the owner set up, without dropping saved entries',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-policy-')),store=new Store(':memory:'),secret=new MetaSecret(dir);
  try{
    saveBrainConfig(store,secret,{policy:{...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:['codex','claude']}});
    assert.deepEqual(brainPolicy(store).providers,['codex','claude']);
    // Provisioning a coordinator adds its platform here; the saved policy predates it.
    store.set('enabled-apps',JSON.stringify(['codex','claude','muse','deepseek','cursor']));
    assert.deepEqual([...brainPolicy(store).providers].sort(),['claude','codex','cursor','deepseek','muse']);
    // A platform the owner has not set up stays denied.
    store.set('enabled-apps',JSON.stringify(['codex']));
    assert.deepEqual(brainPolicy(store).providers,['codex','claude']);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('every supported platform fits in the saved allowlist',()=>{
  // A forward guard rather than a regression test: the cap and the provider count are both 5 today, so
  // this also passes against the old literal. It fails the day a sixth platform (Antigravity, or a
  // Cursor CLI provider) is added while the cap is still a hard-coded number - the moment the bug would
  // otherwise ship, silently turning every brain-policy save into a validation error.
  const dir=mkdtempSync(join(tmpdir(),'ffd-policy-cap-')),store=new Store(':memory:'),secret=new MetaSecret(dir);
  try{
    store.set('enabled-apps',JSON.stringify([...PROVIDERS]));
    const policy={...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:[...PROVIDERS]};
    saveBrainConfig(store,secret,{policy});
    assert.deepEqual(brainPolicy(store).providers,[...PROVIDERS]);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('naming a platform the owner set up reaches that coordinator even when the saved allowlist predates it',async()=>{
  const f=fixture();try{
    const cursor=provisionCursor(f);
    await f.router.receive({id:'wa:cursor',text:'Cursor, fix teh export. Do NOT publish!'});
    assert.equal(f.store.job('wa:cursor')?.binding_id,cursor.id);
    const t=f.router.brain.get('wa:cursor')!;
    assert.equal(t.permission,'allowed');
    assert.equal(t.original,'Cursor, fix teh export. Do NOT publish!');
  }finally{f.close();}
});

test('a platform the owner has not set up is still refused, whatever the message names',async()=>{
  const f=fixture();try{
    // Registered but never provisioned: the owner has no Cursor coordinator on this Mac.
    const cursor=f.store.register('cursor-bro','cursor',randomUUID(),'/tmp').binding;
    f.c.registry.register(cursor);
    await f.router.receive({id:'wa:cursor',text:'Cursor, fix teh export'});
    assert.equal(f.store.jobs().length,0);
    assert.equal(f.router.brain.get('wa:cursor')?.permission,'denied');
  }finally{f.close();}
});