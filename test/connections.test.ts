import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'ffd-connections-'));
process.env.WSB_STATE_DIR=join(dir,'state');
process.env.WSB_DESKTOP_SYNC_BIN=join(dir,'native-helper');
writeFileSync(process.env.WSB_DESKTOP_SYNC_BIN,`#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(join(dir,'sent'))},JSON.stringify(process.argv.slice(2).filter(x=>x==='send-codex'||x==='send-claude')));
process.stdout.write(JSON.stringify({status:'submitted'}));
`,{mode:0o700});
const { Connections,accountStatus }=await import('../src/connections.js');
const { Store }=await import('../src/store.js');
const { NativeAgents }=await import('../src/native.js');
const { Approvals }=await import('../src/approvals.js');
const { Coordinator }=await import('../src/coordinator.js');
const { Router }=await import('../src/router.js');
test.after(()=>rmSync(dir,{recursive:true,force:true}));
const sessionId='11111111-1111-4111-a111-111111111111';
function fixture(provider:'codex'|'claude'='codex') {
  const store=new Store(':memory:'),approvals=new Approvals(store),native=new NativeAgents(store,approvals);
  let account='one',calls=0;
  const connections=new Connections(store,async()=>{calls++;return {state:'verified',label:'Test CLI account',accountKey:account};});
  native.connections=connections;
  const b=store.register('target',provider,sessionId,dir).binding;
  return {store,native,connections,b,setAccount:(v:string)=>account=v,calls:()=>calls,close:()=>{native.close();store.close();}};
}

test('account status exposes only masked identity and an opaque fingerprint, never credentials',()=>{
  const raw={account:{type:'chatgpt',email:'owner@example.com',accessToken:'private-token',workspaceId:'org-a'}};
  const a=accountStatus('codex',raw,{}),b=accountStatus('codex',{account:{...raw.account,workspaceId:'org-b'}},{});
  assert.equal(a.state,'verified');assert.match(a.label,/o\*\*\*@example.com/);assert.notEqual(a.accountKey,b.accountKey);
  assert.doesNotMatch(JSON.stringify(a),/private-token|owner@example/);
  assert.equal(accountStatus('codex',{account:null},{}).state,'signed-out');
  assert.equal(accountStatus('claude',{loggedIn:false},{}).state,'signed-out');
  assert.equal(accountStatus('codex',{account:{type:'apiKey'}},{}).state,'unknown');
});
test('Desktop discovery never consults CLI authentication; concurrent CLI probes coalesce',async()=>{
  const f=fixture();try {
    const desktop=await f.connections.read('claude','desktop');assert.equal(desktop.state,'native');assert.equal(f.calls(),0);
    const [a,b]=await Promise.all([f.connections.read('codex','cli'),f.connections.read('codex','cli')]);
    assert.equal(a.revision,b.revision);assert.equal(f.calls(),1);
    await f.connections.read('codex','cli');assert.equal(f.calls(),1);
  }finally{f.close();}
});
test('managed CLI pins account and profile across restart; account switch cannot submit a turn',async()=>{
  const f=fixture();try {
    await f.connections.choose(f.b,'cli',true);let turns=0;f.native.managedRun=async()=>{turns++;};
    f.store.set(`managed-codex:${f.b.id}`,'true');
    await f.native.run(f.b,'harmless test','local:one');assert.equal(turns,1);
    f.setAccount('two');await assert.rejects(f.native.run(f.b,'do not send','local:two'),/account or provider changed/);assert.equal(turns,1);
    const restarted=new Connections(f.store,async()=>({state:'verified',label:'Other',accountKey:'two'}));
    await assert.rejects(restarted.assert(f.b),/account or provider changed/);
    assert.equal(f.connections.route(f.b)?.accountKey,'one');
    f.store.set(`execution-mode:${f.b.id}`,'desktop');await assert.rejects(f.connections.assert(f.b),/connection changed/);
  }finally{f.close();}
});
test('unknown CLI identity and stale selector revision cannot pin a managed session',async()=>{
  const f=fixture();try {
    const preview=await f.connections.read('codex','cli');f.setAccount('two');
    await assert.rejects(f.connections.choose(f.b,'cli',true,undefined,preview.revision),/changed since selection/);
    assert.equal(f.connections.route(f.b),undefined);
    const unavailable=new Connections(f.store,async()=>{throw new Error('secret diagnostic');});
    await assert.rejects(unavailable.choose(f.b,'cli',true),e=>e instanceof Error&&/unavailable/.test(e.message)&&!e.message.includes('secret diagnostic'));
    assert.equal(unavailable.route(f.b),undefined);
  }finally{f.close();}
});
test('desktop route uses the native queue even when stale managed flags exist; CLI account change is irrelevant',async()=>{
  const f=fixture();try {
    await f.connections.choose(f.b,'desktop',false);f.store.set(`managed-codex:${f.b.id}`,'true');f.setAccount('two');
    f.native.managedRun=async()=>{throw new Error('must not run CLI');};
    await f.native.run(f.b,'synthetic queue test','local:desktop');
    assert.deepEqual(JSON.parse(readFileSync(join(dir,'sent'),'utf8')),['send-codex']);assert.equal(f.calls(),0);
  }finally{f.close();}
});
test('Claude mode/account provenance changes stop native delivery before contacting a session',async()=>{
  const f=fixture('claude');try {
    await f.connections.choose(f.b,'desktop',false,'account-a');
    f.native.catalog=async()=>({sessions:[{id:sessionId,cwd:dir,provider:'claude',name:'Same name',status:'running',executionMode:'cli',accountScope:'account-a',available:true}],cursor:null});
    await assert.rejects(f.native.run(f.b,'not sent','local:mode'),/platform\/account changed/);
    f.native.catalog=async()=>({sessions:[{id:sessionId,cwd:dir,provider:'claude',name:'Same name',status:'running',executionMode:'desktop',accountScope:'account-b',available:true}],cursor:null});
    await assert.rejects(f.native.run(f.b,'not sent','local:account'),/platform\/account changed/);
  }finally{f.close();}
});
test('legacy managed connections require account review; exact native desktop route migrates without replay',async()=>{
  const f=fixture();try {
    f.store.set(`managed-codex:${f.b.id}`,'true');
    await assert.rejects(f.native.run(f.b,'not sent','local:legacy-cli'),/Review this existing CLI/);
    assert.equal(f.connections.route(f.b),undefined);
    f.store.set(`execution-mode:${f.b.id}`,'desktop');
    f.native.catalog=async()=>({sessions:[{id:sessionId,cwd:dir,provider:'codex',name:'Exact desktop',status:'existing',executionMode:'desktop',available:true}],cursor:null});
    await f.native.run(f.b,'synthetic native test','local:legacy-desktop');
    assert.equal(f.connections.route(f.b)?.transport,'native-session');
  }finally{f.close();}
});
test('coordinator persists discovered runtime, returns qualified targets and rejects later mode substitution',async()=>{
  const f=fixture('claude');try {
    const router=new Router(f.store,f.native,new Approvals(f.store));
    const c=new Coordinator(f.store,f.native,router,()=>{});router.coordinator=c;
    const s={id:sessionId,cwd:dir,provider:'claude' as const,name:'Selected desktop',status:'running',executionMode:'desktop' as const,accountScope:'a',available:true};
    f.native.catalog=async p=>({sessions:p==='claude'?[s]:[],cursor:null});f.native.validateSessions=async()=>{};
    await c.list();assert.equal(c.pageDetails().sessions[0].target,`claude:desktop:${sessionId}`);
    await c.connectSessions([s],false);assert.equal(f.connections.route(f.b)?.executionMode,'desktop');
    await assert.rejects(c.connectSessions([{...s,executionMode:'cli'}],false),/different platform/);
    assert.equal(f.connections.route(f.b)?.executionMode,'desktop');
  }finally{f.close();}
});

test('dormant Claude CLI connects to exact managed resume while live CLI retains its inbox',async()=>{
  for(const live of [false,true]) {
    const f=fixture('claude');try {
      const router=new Router(f.store,f.native,new Approvals(f.store));router.stopped=true;
      const c=new Coordinator(f.store,f.native,router,()=>{});router.coordinator=c;
      const s={id:sessionId,cwd:dir,provider:'claude' as const,name:'Exact CLI',status:'saved',executionMode:'cli' as const,available:true,live,activation:live?undefined:'cli-resume' as const};
      f.native.catalog=async()=>({sessions:[s],cursor:null});f.native.validateSessions=async()=>{};
      await c.connectSessions([s],false);
      assert.equal(f.connections.route(f.b)?.transport,live?'native-session':'managed-cli');
      if(!live) {
        let runs=0;f.native.managedRun=async b=>{assert.equal(b.native_id,sessionId);runs++;};
        await f.native.run(f.b,'bounded test','local:resume');assert.equal(runs,1);
        f.native.catalog=async()=>({sessions:[{...s,live:true}],cursor:null});
        await assert.rejects(f.native.run(f.b,'no duplicate','local:duplicate'),/already running/);assert.equal(runs,1);
      }
    }finally{f.close();}
  }
});
test('unavailable live-process discovery prevents managed Claude auto-resume',async()=>{
  const f=fixture('claude');try {
    await f.connections.choose(f.b,'cli',true);f.store.set(`managed-claude:${f.b.id}`,'true');
    f.native.catalog=async()=>({sessions:[{id:sessionId,cwd:dir,name:'Exact',provider:'claude',executionMode:'cli',status:'failed scan',liveDiscoveryComplete:false}],cursor:null});
    let runs=0;f.native.managedRun=async()=>{runs++;};
    await assert.rejects(f.native.run(f.b,'do not duplicate','local:scan'),/could not be checked/);assert.equal(runs,0);
  }finally{f.close();}
});
