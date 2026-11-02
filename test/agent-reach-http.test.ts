import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {once} from 'node:events';
const root=realpathSync(mkdtempSync(join(tmpdir(),'ffd-reach-api-')));
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=(probe.address() as {port:number}).port;await new Promise<void>(r=>probe.close(()=>r()));
process.env.WSB_STATE_DIR=root;process.env.WSB_PORT=String(port);
const [{serve},{Store},{Router},{Coordinator},{Approvals},{captureResearchRequest}]=await Promise.all([import('../src/server.js'),import('../src/store.js'),import('../src/router.js'),import('../src/coordinator.js'),import('../src/approvals.js'),import('../src/agent-reach-request.js')]);

test('research API only serves the exact owner query to its authenticated coordinator',async()=>{
  const store=new Store(':memory:'),approvals=new Approvals(store),native={run:async()=>{},stop:()=>{}} as any,router=new Router(store,native,approvals);
  const master=store.register('master','codex','11111111-1111-4111-a111-111111111111',root,'channel'),worker=store.register('worker','codex','22222222-2222-4222-a222-222222222222',root,'channel');
  store.set('master',master.binding.id);store.set('telegram-owner','tg:123');store.set('control-channel','telegram');router.coordinator=new Coordinator(store,native,router,()=>{});
  const id='tg:123:5',text='Research: /reach web search public topic\nDraft a short article.';
  const context=store.captureIncomingOwner('tg:123','telegram')!;
  store.incomingOwnerContext.run(context,()=>store.destinationContext.run('tg:123',()=>{store.recordIncomingInput(id);captureResearchRequest(store,router,{id,text,ownerCommand:true});store.enqueue(id,master.binding,text);}));
  let calls=0;router.reach=async(command,current)=>{calls++;assert.equal(command,'/reach web search public topic');assert.equal(current(),true);return 'Untrusted excerpt';};
  const server=serve(store,router,{} as any,'admin');await once(server,'listening');
  const call=(token:string,binding:string,data:unknown)=>fetch(`http://127.0.0.1:${port}/api/master/reach`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'X-Binding-Id':binding,'Content-Type':'application/json'},body:JSON.stringify(data)});
  try {
    assert.equal((await call('bad',master.binding.id,{requestId:id})).status,401);
    assert.equal((await call(worker.token,worker.binding.id,{requestId:id})).status,403);
    assert.equal((await call(master.token,master.binding.id,{requestId:id,query:'malicious'})).status,400);
    assert.equal((await call(master.token,master.binding.id,{requestId:'tg:123:6'})).status,400);
    const response=await call(master.token,master.binding.id,{requestId:id});assert.equal(response.status,200);assert.deepEqual(await response.json(),{untrustedSourceText:true,result:'Untrusted excerpt'});assert.equal(calls,1);
    store.jobState(id,'completed');assert.equal((await call(master.token,master.binding.id,{requestId:id})).status,400);assert.equal(calls,1);
  }finally{await new Promise<void>(r=>server.close(()=>r()));approvals.cancel();store.close();rmSync(root,{recursive:true,force:true});}
});
