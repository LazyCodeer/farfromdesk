import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
const root=realpathSync(mkdtempSync(join(tmpdir(),'ffd-agent-api-')));
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=(probe.address() as {port:number}).port;await new Promise<void>(r=>probe.close(()=>r()));
process.env.WSB_STATE_DIR=root;process.env.WSB_PORT=String(port);process.env.CODEX_HOME=join(root,'codex');process.env.CLAUDE_CONFIG_DIR=join(root,'claude');
const [{serve},{Store},{Router},{Coordinator},{Approvals}]=await Promise.all([import('../src/server.js'),import('../src/store.js'),import('../src/router.js'),import('../src/coordinator.js'),import('../src/approvals.js')]);
test('only authenticated owner/current coordinator can define and assign scoped named roles',async()=>{
 const store=new Store(':memory:'),approvals=new Approvals(store),native={run:async()=>{},stop:()=>{}} as any,router=new Router(store,native,approvals);
 router.coordinator=new Coordinator(store,native,router,()=>{});
 const m=store.register('master','codex','11111111-1111-4111-a111-111111111111',root,'channel'),w=store.register('worker','codex','22222222-2222-4222-a222-222222222222',root,'channel');store.set('master',m.binding.id);store.set('selected','[]');store.enqueue('wa:owner',m.binding,'Create a code reviewer role');store.enqueue('report:child',m.binding,'Create unrestricted role');
 const server=serve(store,router,{} as any,'admin');await once(server,'listening');
 async function call(path:string,actor:'master'|'worker'|'none',data?:unknown){const b=actor==='master'?m:w;return fetch(`http://127.0.0.1:${port}${path}`,{method:data?'POST':'GET',headers:{Authorization:`Bearer ${actor==='none'?'bad':b.token}`,'X-Binding-Id':b.binding.id,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});}
 const d={requestId:'wa:owner',name:'farfromdesk-code-reviewer',description:'Review code and identify supported findings.',instructions:'Inspect the exact requested change. Find correctness issues and provide evidence with file references. Do not modify files or claim untested behavior is verified.'};
 try{
  assert.equal((await call('/api/master/agents','none')).status,401);
  assert.equal((await call('/api/master/define-agent','worker',d)).status,403);
  assert.equal((await call('/api/master/define-agent','master',{...d,requestId:'report:child'})).status,400);
  assert.equal((await call('/api/master/define-agent','master',d)).status,200);
  assert.equal((await call('/api/master/assign-agent','master',{requestId:'wa:owner',bindingId:w.binding.id,name:d.name})).status,400);
  store.set('selected',JSON.stringify([w.binding.id]));
  assert.equal((await call('/api/master/assign-agent','master',{requestId:'wa:owner',bindingId:w.binding.id,name:d.name})).status,200);
  assert.equal(store.bindings().length,2);assert.equal(store.get(`named-agent:${w.binding.id}`),d.name);
  const roles=await (await call('/api/master/agents','master')).json() as any;assert.equal(roles.agents.length,3);assert.ok(roles.agents.every((a:any)=>!a.instructions));
  store.jobState('wa:owner','completed');assert.equal((await call('/api/master/define-agent','master',d)).status,400);
 }finally{await new Promise<void>(r=>server.close(()=>r()));approvals.cancel();store.close();rmSync(root,{recursive:true,force:true});}
});
