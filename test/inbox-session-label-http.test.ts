import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';

test('status publishes the exact saved session execution mode without exposing connection secrets',async()=>{
 const temp=mkdtempSync(join(tmpdir(),'ffd-mode-'));
 const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=(probe.address() as any).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
 process.env.WSB_STATE_DIR=temp;process.env.WSB_PORT=String(port);
 const [{Store},{Router},{Approvals},{serve}]=await Promise.all([import('../src/store.js'),import('../src/router.js'),import('../src/approvals.js'),import('../src/server.js')]);
 const store=new Store(':memory:');const approvals=new Approvals(store);const routes=new Map<string,any>();
 const native={run:async()=>{},stop:()=>{},connections:{route:(b:any)=>routes.get(b.id)}} as any;
 const router=new Router(store,native,approvals);
 const desktop=store.register('desktop','claude',randomUUID(),'/tmp').binding;
 const cli=store.register('cli','codex',randomUUID(),'/tmp').binding;
 const unknown=store.register('unknown','claude',randomUUID(),'/tmp').binding;
 const routeOnly=store.register('route-only','codex',randomUUID(),'/tmp').binding;
 const conflict=store.register('conflict','claude',randomUUID(),'/tmp').binding;
 store.set(`execution-mode:${desktop.id}`,'desktop');store.set(`execution-mode:${cli.id}`,'cli');store.set(`execution-mode:${conflict.id}`,'desktop');
 routes.set(routeOnly.id,{provider:'codex',executionMode:'desktop',accountKey:'synthetic-private-account'});
 routes.set(conflict.id,{provider:'claude',executionMode:'cli',accountKey:'synthetic-private-account'});
 const server=serve(store,router,{status:'not paired'} as any,'synthetic-admin',{macControl:{view:()=>({}),stop:()=>{}},desktopControl:{view:()=>({}),stop:()=>{}},masters:{options:()=>({}),platformPreferences:()=>[]},power:{view:()=>({})}} as any);
 await new Promise<void>(resolve=>server.once('listening',resolve));
 try {
  const response=await fetch(`http://127.0.0.1:${port}/api/status`,{headers:{Authorization:'Bearer synthetic-admin'}});assert.equal(response.status,200);
  const result=await response.json();const modes=new Map(result.bindings.map((b:any)=>[b.id,b.executionMode]));
  assert.equal(modes.get(desktop.id),'desktop');assert.equal(modes.get(cli.id),'cli');assert.equal(modes.get(unknown.id),null);assert.equal(modes.get(routeOnly.id),'desktop');assert.equal(modes.get(conflict.id),null);
  assert.ok(result.bindings.every((b:any)=>!('token_hash' in b)));
  assert.doesNotMatch(JSON.stringify(result),/synthetic-private-account/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`)).status,401);
 }finally{router.stopped=true;approvals.cancel();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();rmSync(temp,{recursive:true,force:true});}
});
