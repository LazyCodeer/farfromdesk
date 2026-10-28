import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

// Findings from the 29 Oct broad review, each reproduced first on 16cea6a.
async function setup() {
  const root=mkdtempSync(join(tmpdir(),'ffd-brain-review-'));process.env.WSB_STATE_DIR=root;
  const [{Store},{MetaBrain},{MetaSecret,DEFAULT_BRAIN,saveBrainConfig}]=await Promise.all([import('../src/store.js'),import('../src/meta-brain.js'),import('../src/meta-brain-config.js')]);
  const store=new Store(':memory:');store.set('whatsapp-owner','synthetic-owner');
  const secret=new MetaSecret(root);secret.save('synthetic-review-key-not-real');
  const policy={...DEFAULT_BRAIN,enabled:true,learn:true};saveBrainConfig(store,secret,{policy});
  return {root,store,secret,policy,saveBrainConfig,MetaBrain,done:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}
const router=()=>({stopped:false,coordinator:undefined,native:{},approvals:{pending:new Map()}}) as any;

test('switching learning off while Meta is thinking stops its memory writes',async()=>{
  const t=await setup();
  try{
    let tool:any,started!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>started=r),pending=new Promise<void>(r=>release=r);
    const model={interpret:async(_k:any,_p:any,_i:any,m:any)=>{tool=m;started();await pending;return {intent:'chat',provider:'unspecified',normalized:'remember editor',taskIds:[],reply:'Saved.'};}};
    const brain=new t.MetaBrain(t.store,t.secret,model as any);
    const job=brain.handle(router(),{id:'local:review-memory',text:'Remember my preferred editor is Vim'} as any);
    await ready;t.saveBrainConfig(t.store,t.secret,{policy:{...t.policy,learn:false}});
    tool({command:'create',path:'preferences.md',file_text:'# Preferences\n- Editor: Vim\n'});
    release();await job;
    assert.doesNotMatch(brain.owner.read('preferences.md')??'',/Vim/);
  }finally{t.done();}
});

test('a broad status refresh reaches every active job, three at a time',async()=>{
  const t=await setup();
  try{
    const brain:any=new t.MetaBrain(t.store,t.secret,{interpret:async()=>{throw Error('unused');}} as any);
    const seen=new Set<string>(),r=router();r.native.requestStatus=async(j:any)=>{seen.add(j.id);};
    const items=[{jobs:[1,2,3,4].map(n=>({id:'job'+n,binding_id:'b',status:'submitted'}))}];
    for(let cycle=0;cycle<2;cycle++){
      for(let n=1;n<=4;n++)t.store.set('brain-native:job'+n,JSON.stringify({at:0})); // every cache entry expired
      await brain.refreshEvidence(r,items);
    }
    assert.deepEqual([...seen].sort(),['job1','job2','job3','job4']);
  }finally{t.done();}
});

test('an automatic block lifts on a late final, an owner block does not',async()=>{
  const t=await setup();
  try{
    const brain=new t.MetaBrain(t.store,t.secret,{interpret:async()=>{throw Error('unused');}} as any);
    const binding=t.store.register('review-worker','codex','11111111-1111-4111-8111-111111111111',t.root).binding;
    const run=(id:string,ownerBlocks:boolean)=>{
      t.store.enqueue(id,binding,'Synthetic test','synthetic-owner');
      const item=brain.memory.add(id,'Synthetic task '+id);brain.memory.items.setStatus(item.id,'in progress','Brain');
      t.store.jobState(id,'uncertain');brain.memory.synchronize();
      if(ownerBlocks)brain.memory.items.setStatus(item.id,'blocked','Owner');
      t.store.output(binding,'Completed synthetic test','final-'+id,'synthetic-owner',{requestId:id,kind:'final',origin:'agent',outcome:'done'});
      t.store.jobState(id,'completed',null,'done');brain.memory.synchronize();
      return brain.memory.board().find(i=>i.id===item.id)!.status;
    };
    assert.equal(run('local:late-final',false),'done');
    assert.equal(run('local:owner-blocked',true),'blocked');
  }finally{t.done();}
});

test('watches from another chat or for missing work do not hold back current ones',async()=>{
  const t=await setup();
  try{
    const brain=new t.MetaBrain(t.store,t.secret,{interpret:async()=>{throw Error('unused');}} as any);
    const binding=t.store.register('review-worker','codex','11111111-1111-4111-8111-111111111111',t.root).binding;
    t.store.enqueue('local:watched',binding,'Synthetic test','synthetic-owner');
    const item=brain.memory.add('local:watched','Synthetic task');brain.memory.items.setStatus(item.id,'in progress','Brain');
    t.store.output(binding,'Completed synthetic test','final-watched','synthetic-owner',{requestId:'local:watched',kind:'final',origin:'agent',outcome:'done'});
    t.store.jobState('local:watched','completed',null,'done');
    const insert=t.store.db.prepare('INSERT INTO brain_watches(request_id,destination,item_id,job_id,created_at) VALUES(?,?,?,?,?)');
    for(let n=0;n<100;n++)insert.run('other-'+n,'old-destination',item.id,'local:watched',n);
    for(let n=0;n<100;n++)insert.run('missing-'+n,'synthetic-owner',999,'missing',100+n);
    insert.run('watch-current','synthetic-owner',item.id,'local:watched',1000);
    brain.tick(router());
    const state=(id:string)=>(t.store.db.prepare('SELECT state FROM brain_watches WHERE request_id=?').get(id) as any).state;
    assert.notEqual(state('watch-current'),'waiting');
    assert.equal(state('missing-0'),'gone');assert.equal(state('other-0'),'waiting'); // another chat's watch is left for that chat
  }finally{t.done();}
});

test('a memory save from an editor opened before a newer change keeps the newer one',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ffd-memory-http-'));
  const probe=createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as any).port;await new Promise<void>(r=>probe.close(()=>r()));
  process.env.WSB_STATE_DIR=root;process.env.WSB_PORT=String(port);
  const [{Store},{Router},{Approvals},{serve}]=await Promise.all([import('../src/store.js'),import('../src/router.js'),import('../src/approvals.js'),import('../src/server.js')]);
  const store=new Store(':memory:'),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,new Approvals(store));
  const server=serve(store,router,{status:'not paired'} as any,'synthetic-admin',{macControl:{view:()=>({}),stop:()=>{}}} as any);await new Promise<void>(r=>server.once('listening',r));
  const post=(data:any)=>fetch(`http://127.0.0.1:${port}/api/memory`,{method:'POST',headers:{authorization:'Bearer synthetic-admin','content-type':'application/json'},body:JSON.stringify(data)});
  try{
    const m=router.brain.owner,opened=m.read('preferences.md')??'';
    m.write('preferences.md',opened+'- Learned later: tabs\n','brain:synthetic');
    const stale=await post({path:'preferences.md',content:opened+'- Typed in editor\n',expected:opened});
    assert.equal(stale.status,200);assert.match((await stale.json()).notice,/changed since you opened it/);
    assert.match(m.read('preferences.md')??'',/Learned later/);assert.doesNotMatch(m.read('preferences.md')??'',/Typed in editor/);
    const current=m.read('preferences.md')!;
    assert.equal((await post({path:'preferences.md',content:current+'- Typed in editor\n',expected:current})).status,200);
    assert.match(m.read('preferences.md')??'',/Learned later[\s\S]*Typed in editor/);
  }finally{await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(root,{recursive:true,force:true});}
});
