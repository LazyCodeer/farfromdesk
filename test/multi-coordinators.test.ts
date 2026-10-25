import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Coordinator } from '../src/coordinator.js';
import { Approvals } from '../src/approvals.js';
import { CoordinatorRegistry } from '../src/coordinator-registry.js';
import type { Session } from '../src/session-catalog.js';

function fixture() {
  const store=new Store(':memory:');store.set('whatsapp-owner','owner@s.whatsapp.net');
  const approvals=new Approvals(store),rows:Session[]=[];
  const native={catalog:async(provider:string)=>({sessions:rows.filter(s=>s.provider===provider),cursor:null}),validate:async()=>{},run:async()=>{},stop:()=>{}};
  const router=new Router(store,native as any,approvals),c=new Coordinator(store,native as any,router,()=>{});router.coordinator=c;router.pump=()=>{};
  function coordinator(provider:'codex'|'claude',mode='desktop',account='owner') {
    const b=store.register(`${provider}-${randomUUID().slice(0,16)}`,provider,randomUUID(),'/tmp').binding;
    store.set(`execution-mode:${b.id}`,mode);store.set(`session-route:${b.id}`,JSON.stringify({provider,executionMode:mode,profileId:`${provider}:${mode}`,accountScope:account,transport:'native-session'}));c.registry.register(b);return b;
  }
  const codex=coordinator('codex'),claude=coordinator('claude');
  return {store,approvals,router,c,rows,codex,claude,coordinator,close(){router.stopped=true;approvals.cancel();store.close();}};
}

test('explicit platform routes independently; changing default preserves existing ownership',async()=>{
  const f=fixture();try {
    await f.router.receive({id:'wa:codex',text:'Check my release'});
    await f.router.receive({id:'wa:claude',text:'Claude, review the payments session'});
    assert.equal(f.store.job('wa:codex')?.binding_id,f.codex.id);assert.equal(f.store.job('wa:claude')?.binding_id,f.claude.id);
    f.c.registry.setDefault(f.claude.id);
    await f.router.receive({id:'wa:new',text:'Continue the release'});
    assert.equal(f.store.job('wa:new')?.binding_id,f.claude.id);
    f.c.scope.run(f.codex.id,()=>f.router.resolveOwner('wa:codex','done'));
    assert.equal(f.store.job('wa:codex')?.status,'completed');assert.equal(f.store.job('wa:claude')?.status,'queued');
    assert.throws(()=>f.c.scope.run(f.codex.id,()=>f.c.ownerRequest('wa:claude')),/belonging/);
    assert.throws(()=>f.c.scope.run(f.codex.id,()=>f.router.resolveOwner('wa:claude','done')),/another coordinator/);
  }finally{f.close();}
});

test('offline explicit destination never falls back; ambiguous runtimes require a preference',async()=>{
  const f=fixture();try {
    f.store.enable(f.claude.id,false);
    const result=await f.router.receive({id:'wa:paused',text:'Claude: check project'});
    assert.equal(result.status,'blocked');assert.equal(f.store.job('wa:paused'),undefined);
    f.store.enable(f.claude.id,true);const cli=f.coordinator('claude','cli','other');
    assert.throws(()=>f.c.destination('Claude, check project'),/exact Desktop/);
    assert.equal(f.c.destination('Claude CLI, check project')?.id,cli.id);
    assert.equal(f.c.destination('Does Claude support this?')?.id,f.codex.id);
    f.store.set('platform-preference:claude',JSON.stringify({executionMode:'desktop'}));
    assert.equal(f.c.destination('Claude, check project')?.id,f.claude.id);
  }finally{f.close();}
});

test('delegation is correlated, idempotent, scope checked, and rejects loops',()=>{
  const f=fixture();try {
    f.router.queue('wa:root',f.codex,'Coordinate the review');
    const delegated=f.c.scope.run(f.codex.id,()=>f.c.delegate('wa:root',f.claude.id,'Review Claude work','review'));
    assert.equal(f.store.get(`parent:${delegated.requestId}`),'wa:root');
    assert.deepEqual(f.c.scope.run(f.codex.id,()=>f.c.delegate('wa:root',f.claude.id,'Review Claude work','review')),delegated);
    assert.throws(()=>f.c.scope.run(f.codex.id,()=>f.c.delegate('wa:root',f.claude.id,'Different task','review')),/cannot change/);
    f.c.scope.run(f.claude.id,()=>f.c.ownerRequest(delegated.requestId));
    assert.throws(()=>f.c.scope.run(f.claude.id,()=>f.c.delegate(delegated.requestId,f.codex.id,'Loop','loop')),/cycle/);
    assert.throws(()=>f.c.scope.run(f.codex.id,()=>f.router.resolveOwner('wa:root','done')),/delegated/);
    f.c.registry.setDefault(f.claude.id);
    f.router.channelReply(f.claude,'Review completed','final',delegated.requestId);
    const report=f.store.job(`report:${delegated.requestId}`)!;
    assert.equal(report.binding_id,f.codex.id);
    assert.throws(()=>f.c.scope.run(f.claude.id,()=>f.c.quiet(report.id)),/another coordinator/);
    f.c.scope.run(f.codex.id,()=>f.c.quiet(report.id,'done'));
    assert.equal(f.store.job('wa:root')?.outcome,'done');
  }finally{f.close();}
});

test('catalog snapshots and selected workers stay within the coordinator connection',async()=>{
  const f=fixture();try {
    f.rows.push(...Array.from({length:7},(_,i)=>({provider:'claude' as const,id:randomUUID(),name:`Desktop ${i}`,cwd:'/tmp',executionMode:'desktop' as const,accountScope:'owner',available:true,status:'running',updatedAt:i+1})),
      {provider:'codex',id:randomUUID(),name:'Codex work',cwd:'/tmp',executionMode:'desktop',accountScope:'owner',available:true,status:'running'});
    f.router.queue('wa:claude',f.claude,'Review');f.router.queue('wa:codex',f.codex,'Review');
    await Promise.all([f.c.scope.run(f.claude.id,()=>f.c.list()),f.c.scope.run(f.codex.id,()=>f.c.list())]);
    assert.equal(f.c.scope.run(f.claude.id,()=>f.c.pageDetails()).sessions.length,5);
    assert.equal(f.c.scope.run(f.codex.id,()=>f.c.pageDetails()).sessions.length,1);
    const codexTarget=`codex:desktop:${f.rows[7].id}`;
    await assert.rejects(f.c.scope.run(f.claude.id,()=>f.c.connect('wa:claude',[codexTarget])),/another connection/);
    const own=await f.c.scope.run(f.codex.id,()=>f.c.connect('wa:codex',[codexTarget]));assert.equal(own.length,1);
    assert.equal(f.c.scope.run(f.claude.id,()=>f.c.selected()).length,0);
  }finally{f.close();}
});

test('registry migration is additive and repeated startup preserves default and bindings',()=>{
  const store=new Store(':memory:');try {
    const b=store.register('legacy','codex',randomUUID(),'/tmp').binding;store.set('master',b.id);store.enqueue('wa:pending',b,'Keep this');
    const a=new CoordinatorRegistry(store);assert.equal(a.entries().length,1);assert.equal(store.get(`role-kind:${b.id}`),'master');
    new CoordinatorRegistry(store);assert.equal(a.entries().length,1);assert.equal(store.job('wa:pending')?.status,'queued');assert.equal(store.get('master'),b.id);
    store.set('coordinator-schema','99');assert.throws(()=>new CoordinatorRegistry(store),/newer/);
  }finally{store.close();}
});
