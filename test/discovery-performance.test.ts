import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../src/session-catalog.js';

// A private transport config directory: discovery tests never inspect real apps or chats.
const dir=mkdtempSync(join(tmpdir(),'tether-discovery-regression-'));
process.env.WSB_STATE_DIR=dir;
const { Store }=await import('../src/store.js');
const { Approvals }=await import('../src/approvals.js');
const { NativeAgents }=await import('../src/native.js');
const { Coordinator }=await import('../src/coordinator.js');
const { Router }=await import('../src/router.js');
const { inboxesByPid,hasClaudeInboxes }=await import('../src/desktop-claude.js');
test.after(()=>rmSync(dir,{recursive:true,force:true}));

type Page={sessions:Session[];cursor:string|null};
const uuid=(n:number)=>`22222222-2222-4222-a222-${String(n).padStart(12,'0')}`;
const session=(n:number,provider:'codex'|'claude'='codex'):Session=>({id:uuid(n),provider,name:`Fixture ${n}`,cwd:`/tmp/fixture-${n}`,status:'existing chat',available:true,updatedAt:1700000000000+n});
function deferred<T>() {
  let resolve!:(value:T)=>void,reject!:(error:Error)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
function nativeFixture() {
  const store=new Store(':memory:'),approvals=new Approvals(store),native=new NativeAgents(store,approvals);
  return {store,native,close(){native.close();store.close();}};
}
function coordinatorFixture(catalog:(provider:string,cursor?:string)=>Promise<Page>) {
  const store=new Store(':memory:'),approvals=new Approvals(store);
  const native={catalog,validate:async()=>{},run:async()=>{},stop:()=>{}};
  const router=new Router(store,native as any,approvals);router.stopped=true;
  const c=new Coordinator(store,native as any,router,()=>{});
  const master=store.register('master','codex',uuid(999),dir).binding;store.set('master',master.id);
  store.enqueue('wa:fixture-owner',master,'Fixture request');
  return {store,c,native,close(){router.stopped=true;approvals.cancel();store.close();}};
}

test('a burst of identical native discovery calls shares one load and outcome',async()=>{
  const f=nativeFixture(),gate=deferred<Page>();let calls=0;
  try {
    (f.native as any).readCatalog=()=>{calls++;return gate.promise;};
    const pending=Array.from({length:25},()=>f.native.catalog('claude'));
    assert.equal(calls,1);
    gate.resolve({sessions:[session(1,'claude')],cursor:null});
    const pages=await Promise.all(pending);
    assert.ok(pages.every(page=>page.sessions[0].id===uuid(1)));
    assert.equal(calls,1);
  }finally{f.close();}
});

test('native discovery isolates providers and pagination cursors while coalescing each key',async()=>{
  const f=nativeFixture(),gates=new Map<string,ReturnType<typeof deferred<Page>>>(),calls:string[]=[];
  try {
    (f.native as any).readCatalog=(provider:string,cursor?:string)=>{
      const key=`${provider}:${cursor??''}`;calls.push(key);const gate=deferred<Page>();gates.set(key,gate);return gate.promise;
    };
    const pending=[f.native.catalog('codex'),f.native.catalog('codex','50'),f.native.catalog('claude'),f.native.catalog('codex','50')];
    assert.deepEqual(calls,['codex:','codex:50','claude:']);
    gates.get('codex:')!.resolve({sessions:[session(1)],cursor:'50'});
    gates.get('codex:50')!.resolve({sessions:[session(2)],cursor:null});
    gates.get('claude:')!.resolve({sessions:[session(3,'claude')],cursor:null});
    const pages=await Promise.all(pending);
    assert.deepEqual(pages.map(p=>p.sessions[0].id),[1,2,3,2].map(uuid));
    assert.equal(pages[0].cursor,'50');
  }finally{f.close();}
});

test('a rejected shared native load clears in-flight state and permits a later retry',async()=>{
  const f=nativeFixture(),gate=deferred<Page>();let calls=0;
  try {
    (f.native as any).readCatalog=()=>{calls++;return calls===1?gate.promise:Promise.resolve({sessions:[session(1)],cursor:null});};
    const outcomes=Promise.allSettled(Array.from({length:20},()=>f.native.catalog('codex')));
    gate.reject(new Error('Fixture discovery unavailable'));
    const results=await outcomes;
    assert.equal(calls,1);assert.ok(results.every(r=>r.status==='rejected'&&r.reason.message==='Fixture discovery unavailable'));
    assert.equal((await f.native.catalog('codex')).sessions[0].id,uuid(1));
    assert.equal(calls,2);
  }finally{f.close();}
});

test('overlapping coordinator refreshes traverse each provider page once and finish with one ordered snapshot',async()=>{
  const codex=deferred<Page>(),claude=deferred<Page>(),calls:string[]=[];
  const f=coordinatorFixture((provider,cursor)=>{
    calls.push(`${provider}:${cursor??''}`);
    if(cursor==='50')return Promise.resolve({sessions:[session(3)],cursor:null});
    return provider==='codex'?codex.promise:claude.promise;
  });
  try {
    const pending=Array.from({length:20},()=>f.c.refresh());
    assert.deepEqual(calls,['codex:','claude:']);
    codex.resolve({sessions:[session(1)],cursor:'50'});claude.resolve({sessions:[session(2,'claude')],cursor:null});
    await Promise.all(pending);
    assert.deepEqual(calls,['codex:','claude:','codex:50']);
    assert.deepEqual(f.c.sessions.map(s=>s.id),[3,2,1].map(uuid));
    assert.equal(f.c.refreshing,undefined);
  }finally{f.close();}
});

test('one provider discovery failure does not discard the healthy provider or silently hide the error',async()=>{
  const f=coordinatorFixture(async provider=>{
    if(provider==='claude')throw new Error('Fixture helper unavailable');
    return {sessions:[session(1)],cursor:null};
  });
  try {
    const listing=await f.c.list();
    assert.deepEqual(f.c.pageDetails().sessions.map(s=>s.id),[uuid(1)]);
    assert.match(listing,/claude: discovery was incomplete/);
    assert.equal(f.c.errors.claude,'Fixture helper unavailable');
  }finally{f.close();}
});

test('a frozen numbered selection revalidates its exact identity and cannot switch to a similarly named chat',async()=>{
  const original=session(1,'claude'),replacement={...session(2,'claude'),name:original.name,cwd:original.cwd};
  let data=[original],validated:{provider:string;id:string;cwd:string}[]=[];
  const f=coordinatorFixture(async provider=>({sessions:data.filter(s=>s.provider===provider),cursor:null}));
  try {
    await f.c.list();data=[replacement];
    f.native.validate=async(provider?:any,id?:string,cwd?:string)=>{
      validated.push({provider,id:id!,cwd:cwd!});
      if(!data.some(s=>s.provider===provider&&s.id===id&&s.cwd===cwd))throw new Error('Exact session no longer exists');
    };
    await assert.rejects(f.c.select('1'),/Exact session no longer exists/);
    assert.deepEqual(validated,[{provider:'claude',id:original.id,cwd:original.cwd}]);
    assert.equal(f.c.selected().length,0);assert.equal(f.store.bindings().length,1);
  }finally{f.close();}
});


test('completed native catalog stays fresh for 15 seconds and a fresh action check bypasses it',async(t)=>{
  const f=nativeFixture();let now=1_000_000,calls=0;
  t.mock.method(Date,'now',()=>now);
  try {
    (f.native as any).readCatalog=async()=>({sessions:[session(++calls)],cursor:null});
    assert.equal((await f.native.catalog('claude')).sessions[0].id,uuid(1));
    now+=14_999;
    assert.equal((await f.native.catalog('claude')).sessions[0].id,uuid(1));assert.equal(calls,1);
    now+=2;
    assert.equal((await f.native.catalog('claude')).sessions[0].id,uuid(2));assert.equal(calls,2);
    assert.equal((await f.native.catalog('claude',undefined,{fresh:true})).sessions[0].id,uuid(3));assert.equal(calls,3);
  }finally{f.close();}
});

test('callers cannot corrupt cached native rows or one another by changing results',async()=>{
  const f=nativeFixture(),gate=deferred<Page>();let calls=0;
  const source={sessions:[session(1)],cursor:null};
  try {
    (f.native as any).readCatalog=()=>{calls++;return gate.promise;};
    const one=f.native.catalog('codex'),two=f.native.catalog('codex');
    gate.resolve(source);
    const [first,second]=await Promise.all([one,two]);
    first.sessions[0].name='Mutated';first.sessions.push(session(2));
    assert.equal(second.sessions[0].name,'Fixture 1');assert.equal(second.sessions.length,1);
    assert.equal(source.sessions[0].name,'Fixture 1');assert.equal(source.sessions.length,1);
    const third=await f.native.catalog('codex');
    assert.equal(third.sessions[0].name,'Fixture 1');assert.equal(third.sessions.length,1);assert.equal(calls,1);
  }finally{f.close();}
});

test('completed catalog cache has a bounded 64-key working set',async()=>{
  const f=nativeFixture();let calls=0;
  try {
    (f.native as any).readCatalog=async(_provider:string,cursor?:string)=>{calls++;return {sessions:[session(Number(cursor)+1)],cursor:null};};
    for(let cursor=0;cursor<70;cursor++)await f.native.catalog('codex',String(cursor));
    assert.equal(calls,70);
    await f.native.catalog('codex','69');assert.equal(calls,70);
    await f.native.catalog('codex','0');assert.equal(calls,71);
  }finally{f.close();}
});

test('a provider page failure keeps its last complete snapshot and never publishes a partial replacement',async()=>{
  let refresh=0;
  const f=coordinatorFixture(async(provider,cursor)=>{
    if(provider==='claude')return {sessions:[session(refresh===0?2:4,'claude')],cursor:null};
    if(refresh===0)return {sessions:[session(1)],cursor:null};
    if(cursor==='next')throw new Error('Fixture second-page timeout');
    return {sessions:[session(3)],cursor:'next'};
  });
  try {
    await f.c.refresh();refresh++;
    await f.c.refresh();
    assert.deepEqual(f.c.sessions.map(s=>s.id),[4,1].map(uuid));
    assert.equal(f.c.errors.codex,'Fixture second-page timeout');
    assert.equal(f.c.errors.claude,undefined);
    assert.equal(f.c.sessions.some(s=>s.id===uuid(3)),false);
    f.native.catalog=async provider=>({sessions:[session(provider==='codex'?5:6,provider as 'codex'|'claude')],cursor:null});
    await f.c.refresh();
    assert.deepEqual(f.c.sessions.map(s=>s.id),[6,5].map(uuid));assert.deepEqual(f.c.errors,{});
  }finally{f.close();}
});


test('Claude identity validation forces discovery instead of accepting the warm display cache',async()=>{
  const f=nativeFixture();let present=true,calls=0;
  try {
    (f.native as any).readCatalog=async()=>{calls++;return {sessions:present?[session(1,'claude')]:[],cursor:null};};
    await f.native.catalog('claude');present=false;
    await assert.rejects(f.native.validateSessions([{provider:'claude',id:uuid(1),cwd:'/tmp/fixture-1'}]),/exact Claude session could not be found/);
    assert.equal(calls,2);
  }finally{f.close();}
});

test('a first-load late page failure publishes no incomplete rows for that provider',async()=>{
  const f=coordinatorFixture(async(provider,cursor)=>{
    if(provider==='claude')return {sessions:[session(2,'claude')],cursor:null};
    if(cursor==='next')throw new Error('Fixture second page unavailable');
    return {sessions:[session(1)],cursor:'next'};
  });
  try {
    await f.c.refresh();
    assert.deepEqual(f.c.sessions.map(s=>s.id),[uuid(2)]);
    assert.equal(f.c.errors.codex,'Fixture second page unavailable');
  }finally{f.close();}
});


test('discovery timeout bounds caller wait while retaining one in-flight load until it settles',async(t)=>{
  const f=nativeFixture(),gate=deferred<Page>();let calls=0;
  t.mock.timers.enable({apis:['setTimeout']});
  try {
    (f.native as any).readCatalog=()=>{calls++;return gate.promise;};
    const first=f.native.catalog('claude');
    const timedOut=assert.rejects(first,/timed out|timeout|taking too long/i);
    t.mock.timers.tick(12_001);
    await timedOut;
    await assert.rejects(f.native.catalog('claude'),/timed out|timeout|taking too long/i);assert.equal(calls,1);
    gate.resolve({sessions:[session(1,'claude')],cursor:null});
    await gate.promise;
    assert.equal((await f.native.catalog('claude')).sessions[0].id,uuid(1));
    assert.equal(calls,1);
  }finally{f.close();}
});


test('batch inbox parsing preserves exact requested PID ownership and rejects neighboring socket names',()=>{
  const parsed=inboxesByPid([
    'n/tmp/cc-socks-501/101.sock', // No process section: never attribute this socket.
    'p101','f4','n/tmp/cc-socks-501/101.sock','n/tmp/cc-socks-501/202.sock',
    'p999','f4','n/tmp/cc-socks-501/202.sock', // An unrequested process cannot lend its socket.
    'p202','f5','n/tmp/other/202.sock','n/tmp/cc-socks-501/202.sock.backup',
    'p303','f7','n/tmp/cc-socks-501/303.sock','n/tmp/cc-socks-502/303.sock',
  ].join('\n'),new Set([101,202,303]));
  assert.deepEqual([...parsed],[[101,['/tmp/cc-socks-501/101.sock']],[202,[]],[303,['/tmp/cc-socks-501/303.sock','/tmp/cc-socks-502/303.sock']]]);
  assert.equal(parsed.has(999),false);
  // An ambiguous pair remains two entries so readiness's exactly-one check fails closed.
  assert.equal(parsed.get(303)?.length,2);
});

test('batch inbox discovery rejects invalid PID inputs without spawning a process',async()=>{
  assert.deepEqual(await hasClaudeInboxes([undefined,null,'101',0,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1]),new Set());
});


test('discovery applies backpressure at 64 distinct in-flight keys and releases capacity after completion',async()=>{
  const f=nativeFixture(),gate=deferred<Page>();let calls=0;
  try {
    (f.native as any).readCatalog=()=>{calls++;return gate.promise;};
    const pending=Array.from({length:64},(_,i)=>f.native.catalog('codex',String(i)));
    await assert.rejects(f.native.catalog('codex','64'),/discovery is busy/);
    assert.equal(calls,64);
    gate.resolve({sessions:[session(1)],cursor:null});await Promise.all(pending);
    await f.native.catalog('codex','64');assert.equal(calls,65);
  }finally{gate.resolve({sessions:[],cursor:null});f.close();}
});


test('denied catalog access stays paused even for automatic fresh scans until the owner retries',async()=>{
 const f=nativeFixture();let calls=0;
 try {
  (f.native as any).readCatalog=async()=>{calls++;if(calls===1)throw Object.assign(new Error('permission denied'),{code:'EPERM'});return {sessions:[session(1,'claude')],cursor:null};};
  await assert.rejects(f.native.catalog('claude'),/permission denied/);
  await assert.rejects(f.native.catalog('claude',undefined,{fresh:true}),/File access was denied/);
  await assert.rejects(f.native.catalog('claude'),/File access was denied/);assert.equal(calls,1);
  f.native.retryDiscovery();assert.equal((await f.native.catalog('claude')).sessions.length,1);assert.equal(calls,2);
 }finally{f.close();}
});
