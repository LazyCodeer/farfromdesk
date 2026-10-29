import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
test('Meta settings and verification are owner-admin only, reject browser input and never return keys',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ffd-meta-http-'));
  const probe=createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as any).port;await new Promise<void>(r=>probe.close(()=>r()));
  process.env.WSB_STATE_DIR=root;process.env.WSB_PORT=String(port);
  const [{Store},{Router},{Approvals},{serve},{DEFAULT_BRAIN}]=await Promise.all([import('../src/store.js'),import('../src/router.js'),import('../src/approvals.js'),import('../src/server.js'),import('../src/meta-brain-config.js')]);
  const store=new Store(':memory:'),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,new Approvals(store));
  const worker=store.register('worker','codex',randomUUID(),'/tmp');
  const server=serve(store,router,{status:'not paired'} as any,'synthetic-admin', {macControl:{view:()=>({}),stop:()=>{}}} as any);await new Promise<void>(r=>server.once('listening',r));
  const url=`http://127.0.0.1:${port}`,key='synthetic-api-key-not-a-real-secret';
  const post=(path:string,data:any,headers:Record<string,string>={})=>fetch(url+path,{method:'POST',headers:{authorization:'Bearer synthetic-admin','content-type':'application/json',...headers},body:JSON.stringify(data)});
  try{
    for(const path of ['/api/meta-brain','/api/meta-brain/verify'])assert.equal((await post(path,{}, {authorization:`Bearer ${worker.token}`,'x-binding-id':worker.binding.id})).status,403);
    assert.equal((await fetch(url+'/api/meta-brain/tasks',{headers:{authorization:`Bearer ${worker.token}`,'x-binding-id':worker.binding.id}})).status,403);
    assert.equal((await fetch(url+'/api/meta-timeline',{headers:{authorization:`Bearer ${worker.token}`,'x-binding-id':worker.binding.id}})).status,403);
    const timeline=await fetch(url+'/api/meta-timeline',{headers:{authorization:'Bearer synthetic-admin'}});assert.equal(timeline.status,200);assert.deepEqual(await timeline.json(),{scope:null,events:[]});
    const {metaObserver}=await import('../src/meta-timeline.js');store.set('whatsapp-owner','old-owner@s.whatsapp.net');
    await metaObserver(store,'sorted','old-owner@s.whatsapp.net')(async()=>true);
    const oldTimeline=await fetch(url+'/api/meta-timeline',{headers:{authorization:'Bearer synthetic-admin'}});const oldView=await oldTimeline.json() as any;assert.equal(oldView.events.length,1);assert.ok(oldView.scope);
    store.set('whatsapp-owner','new-owner@s.whatsapp.net');
    const newTimeline=await fetch(url+'/api/meta-timeline',{headers:{authorization:'Bearer synthetic-admin'}});const newView=await newTimeline.json() as any;assert.deepEqual(newView.events,[]);assert.ok(newView.scope);assert.notEqual(newView.scope,oldView.scope);
    assert.equal((await post('/api/meta-brain',{policy:DEFAULT_BRAIN,key},{origin:url})).status,400);
    assert.equal(router.brain.secret.present(),false);
    let refreshed=0;(router.brain as any).refresh=async()=>{refreshed++;};
    assert.equal((await fetch(url+'/api/meta-brain/tasks?fresh=1',{headers:{authorization:'Bearer synthetic-admin'}})).status,200);assert.equal(refreshed,1);
    const saved=await post('/api/meta-brain',{policy:DEFAULT_BRAIN,key});assert.equal(saved.status,200);const text=await saved.text();assert.ok(!text.includes(key));assert.match(text,/configured/);
    assert.equal((await post('/api/meta-brain/verify',{requestId:'wa:missing',confirmed:true})).status,400);
    const invalid=await post('/api/meta-brain',{policy:{...DEFAULT_BRAIN,model:'invented-model'},key});assert.equal(invalid.status,400);assert.ok(!(await invalid.text()).includes(key));
  }finally{await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(root,{recursive:true,force:true});}
});
