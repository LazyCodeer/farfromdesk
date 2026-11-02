import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

test('scratch: status body',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'wsb-scratch-'));
  const probe=createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as any).port;await new Promise<void>(r=>probe.close(()=>r()));
  process.env.WSB_STATE_DIR=temp;process.env.WSB_PORT=String(port);
  const [{Store},{Router},{Approvals},{serve}]=await Promise.all([import('../src/store.js'),import('../src/router.js'),import('../src/approvals.js'),import('../src/server.js')]);
  const store=new Store(':memory:'),approvals=new Approvals(store);
  const router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
  const services={masters:{options:()=>({}),platformPreferences:()=>[]},power:{view:()=>({}),update:async()=>{}}} as any;
  const server=serve(store,router,{status:'not paired'} as any,'test-admin-token',services);await new Promise<void>(r=>server.once('listening',r));
  const response=await fetch(`http://127.0.0.1:${port}/api/status`,{headers:{Authorization:'Bearer test-admin-token'}});
  console.error('STATUS',response.status,await response.text());
  server.close();
});