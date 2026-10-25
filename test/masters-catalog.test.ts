import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Session } from '../src/session-catalog.js';

const dir=mkdtempSync(join(tmpdir(),'tether-master-catalog-'));
process.env.WSB_STATE_DIR=dir;
// --version checks run the current Node executable, never an installed agent.
process.env.WSB_CODEX_BIN=process.execPath;process.env.WSB_CLAUDE_BIN=process.execPath;
const { Store }=await import('../src/store.js');
const { Router }=await import('../src/router.js');
const { Approvals }=await import('../src/approvals.js');
const { Masters }=await import('../src/masters.js');
test.after(()=>rmSync(dir,{recursive:true,force:true}));

type Page={sessions:Session[];cursor:string|null};
type Catalog=(provider:'codex'|'claude',cursor?:string,options?:{fresh?:boolean})=>Promise<Page>;
const row=(n:number,provider:'codex'|'claude'='codex',executionMode:'desktop'|'cli'='cli'):Session=>({id:`33333333-3333-4333-a333-${String(n).padStart(12,'0')}`,name:`Fixture ${n}`,cwd:dir,provider,executionMode,status:'Fixture available',available:true,updatedAt:n});
function deferred<T>() {
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(yes=>{resolve=yes;});
  return {promise,resolve};
}
function fixture(catalog:Catalog=async provider=>({sessions:[row(provider==='codex'?1:2,provider)],cursor:null})) {
  const store=new Store(':memory:'),approvals=new Approvals(store);
  const native={catalog,validate:async()=>{},run:async()=>{},stop:()=>{}};
  const router=new Router(store,native as any,approvals);router.stopped=true;
  const masters=new Masters(store,router);
  return {store,native,router,masters,close(){masters.close();approvals.cancel();store.close();}};
}

test('legacy and unknown-revision master options include the full four-platform catalog',async()=>{
  const f=fixture();
  try {
    await f.masters.discover();
    const legacy=f.masters.options();
    assert.equal(legacy.catalogUnchanged,false);assert.equal(legacy.platforms.length,4);
    assert.ok(legacy.catalogRevision);assert.ok(legacy.prompt.length>0);
    assert.equal(legacy.platforms.find(p=>p.provider==='codex'&&p.executionMode==='desktop').sessions[0].id,row(1).id);
    const unknown=f.masters.options('unknown-client-revision');
    assert.equal(unknown.catalogUnchanged,false);assert.deepEqual(unknown.platforms,legacy.platforms);
    assert.equal(unknown.catalogRevision,legacy.catalogRevision);
  }finally{f.close();}
});

test('unchanged catalog omits rows while operation progress, safe errors and recoverable attempts stay current',async()=>{
  const f=fixture();
  try {
    await f.masters.discover();const revision=f.masters.options().catalogRevision;
    f.store.set('master-operation',JSON.stringify({id:'current-fixture',status:'creating',updatedAt:10}));
    const creating=f.masters.options(revision);
    assert.equal(creating.catalogUnchanged,true);assert.deepEqual(creating.platforms,[]);
    assert.equal(creating.operation.status,'creating');assert.ok(creating.prompt.length>0);
    f.store.set('master-operation',JSON.stringify({id:'current-fixture',status:'uncertain',error:'PRIVATE launch arguments --secret fixture',updatedAt:30}));
    f.store.set('master-attempt:old-fixture',JSON.stringify({id:'old-fixture',status:'set-aside',updatedAt:20}));
    const failed=f.masters.options(revision);
    assert.equal(failed.catalogRevision,revision);assert.equal(failed.catalogUnchanged,true);assert.deepEqual(failed.platforms,[]);
    assert.equal(failed.operation.status,'uncertain');assert.match(failed.operation.error,/recover|replacement/i);
    assert.doesNotMatch(failed.operation.error,/PRIVATE|secret/);
    assert.deepEqual(failed.attempts.map(a=>a.id),['old-fixture']);
    f.store.set('master-operation',JSON.stringify({id:'current-fixture',status:'ready',updatedAt:40}));
    assert.equal(f.masters.options(revision).operation.status,'ready');
  }finally{f.close();}
});

test('a restarted master service gives a new revision and sends its full catalog to an older client',async()=>{
  const f=fixture();let restarted:InstanceType<typeof Masters>|undefined;
  try {
    await f.masters.discover();const before=f.masters.options();
    restarted=new Masters(f.store,f.router);await restarted.discover();
    const after=restarted.options(before.catalogRevision);
    assert.notEqual(after.catalogRevision,before.catalogRevision);assert.equal(after.catalogUnchanged,false);
    assert.deepEqual(after.platforms,before.platforms);assert.equal(after.platforms.length,4);
  }finally{restarted?.close();f.close();}
});

test('warm master discovery honors 15-second TTL without refreshing the native catalogs or revision',async(t)=>{
  let now=1_000_000,calls=0;t.mock.method(Date,'now',()=>now);
  const f=fixture(async provider=>{calls++;return {sessions:[row(provider==='codex'?1:2,provider)],cursor:null};});
  try {
    await f.masters.discover();const firstRevision=f.masters.options().catalogRevision;assert.equal(calls,2);
    now+=14_999;await f.masters.discover();assert.equal(calls,2);
    assert.equal(f.masters.options().catalogRevision,firstRevision);
    now+=2;await f.masters.discover();assert.equal(calls,4);
    assert.equal(f.masters.options().catalogRevision,firstRevision);
    assert.equal(f.masters.options(firstRevision).catalogUnchanged,true);
    await f.masters.discover(true);assert.equal(calls,6);
    assert.equal(f.masters.options().catalogRevision,firstRevision);
  }finally{f.close();}
});

test('simultaneous forced refreshes bypass the warm catalog once and share the same fresh load',async()=>{
  const f=fixture(),started=deferred<void>(),gate=deferred<void>();let calls=0;
  const optionsSeen:(boolean|undefined)[]=[];
  try {
    await f.masters.discover();const old=f.masters.options();
    f.native.catalog=async(provider,_cursor,options)=>{
      calls++;optionsSeen.push(options?.fresh);if(calls===2)started.resolve();
      await gate.promise;return {sessions:[row(provider==='codex'?3:4,provider)],cursor:null};
    };
    const pending=Array.from({length:20},()=>f.masters.discover(true));await started.promise;
    assert.equal(calls,2);assert.deepEqual(optionsSeen,[true,true]);
    const warm=await f.masters.discover();assert.deepEqual(warm,old.platforms);assert.equal(calls,2);
    gate.resolve();const results=await Promise.all(pending);
    assert.equal(calls,2);assert.ok(results.every(r=>r.find(p=>p.provider==='codex').sessions[0].id===row(3).id));
    assert.notEqual(f.masters.options().catalogRevision,old.catalogRevision);
    assert.equal(f.masters.options(old.catalogRevision).catalogUnchanged,false);
  }finally{gate.resolve();f.close();}
});

test('failed refresh retains complete provider history with a visible error, then clears it on recovery',async()=>{
  const f=fixture(async provider=>({sessions:provider==='codex'?[row(1)]:[row(2,'claude','cli'),row(3,'claude','desktop')],cursor:null}));
  try {
    await f.masters.discover();const first=f.masters.options();
    f.native.catalog=async(provider,cursor)=>{
      if(provider==='codex')return {sessions:[row(1)],cursor:null};
      if(cursor==='late')throw new Error('Fixture timeout on later page');
      return {sessions:[row(9,'claude')],cursor:'late'};
    };
    await f.masters.discover(true);const failed=f.masters.options(first.catalogRevision);
    assert.equal(failed.catalogUnchanged,false);
    const claude=failed.platforms.filter(p=>p.provider==='claude');
    assert.deepEqual(claude.flatMap(p=>p.sessions.map((s:any)=>s.id)),[row(2).id,row(3).id]);
    assert.ok(claude.every(p=>/last saved list/.test(p.discoveryError)));
    assert.equal(failed.platforms.find(p=>p.provider==='codex').sessions[0].id,row(1).id);
    assert.ok(failed.platforms.filter(p=>p.provider==='codex').every(p=>!p.discoveryError));
    await f.masters.discover(true);
    assert.equal(f.masters.options().catalogRevision,failed.catalogRevision);
    f.native.catalog=async provider=>({sessions:provider==='codex'?[row(1)]:[row(2,'claude','cli'),row(3,'claude','desktop')],cursor:null});
    await f.masters.discover(true);
    assert.notEqual(f.masters.options().catalogRevision,failed.catalogRevision);
    assert.ok(f.masters.options().platforms.every(p=>!p.discoveryError));
  }finally{f.close();}
});


test('an empty startup failure recovers on a later scheduled discovery and invalidates the client revision',async(t)=>{
  let now=1_000_000;t.mock.method(Date,'now',()=>now);
  const f=fixture(async()=>{throw new Error('Fixture transient startup timeout');});
  try {
    await f.masters.discover();const failed=f.masters.options();
    assert.ok(failed.platforms.every(p=>p.sessions.length===0&&p.discoveryError));
    f.native.catalog=async provider=>({sessions:[row(provider==='codex'?1:2,provider)],cursor:null});
    now+=30_000;await f.masters.discover();const recovered=f.masters.options(failed.catalogRevision);
    assert.equal(recovered.catalogUnchanged,false);assert.notEqual(recovered.catalogRevision,failed.catalogRevision);
    assert.ok(recovered.platforms.every(p=>!p.discoveryError));
    assert.equal(recovered.platforms.find(p=>p.provider==='codex').sessions[0].id,row(1).id);
  }finally{f.close();}
});
