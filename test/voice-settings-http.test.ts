import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';

test('voice key validation cannot override a newer removal or provider choice',async t=>{
  const root=mkdtempSync(join(tmpdir(),'ffd-voice-http-')),probe=createServer();
  await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as any).port;
  await new Promise<void>(r=>probe.close(()=>r()));
  process.env.WSB_STATE_DIR=root;process.env.WSB_PORT=String(port);
  const [{Store},{Router},{Approvals},{serve},{readVoiceKey}]=await Promise.all([import('../src/store.js'),import('../src/router.js'),import('../src/approvals.js'),import('../src/server.js'),import('../src/voice-cloud.js')]);
  const store=new Store(':memory:'),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
  const server=serve(store,router,{status:'not paired'} as any,'synthetic-admin',{macControl:{view:()=>({}),stop:()=>{}}} as any);
  await new Promise<void>(r=>server.once('listening',r));
  const realFetch=globalThis.fetch;
  const post=async(data:unknown)=>{
    const response=await realFetch(`http://127.0.0.1:${port}/api/voice-engine`,{method:'POST',headers:{authorization:'Bearer synthetic-admin','content-type':'application/json'},body:JSON.stringify(data)});
    return {status:response.status,data:await response.json() as any};
  };
  try{
    for(const newer of ['remove','local','deepgram','failed-key','fallback'] as const)await t.test(newer,async()=>{
      await post({remove:true});
      let started!:()=>void,finish!:()=>void;
      const entered=new Promise<void>(r=>started=r),pending=new Promise<void>(r=>finish=r);
      globalThis.fetch=(async(url:any)=>{
        if(String(url)==='https://api.meta.ai/v1/models'){started();await pending;return new Response('{}');}
        if(String(url)==='https://api.deepgram.com/v1/projects')return new Response('{}',{status:newer==='failed-key'?401:200});
        throw new Error('No external network is allowed in this fixture.');
      }) as typeof fetch;
      const first=post({engine:'meta',key:'synthetic-meta-key-not-real'});
      await entered;
      try{
        const data=newer==='remove'?{remove:true}:newer==='local'?{engine:'local'}:newer==='fallback'?{fallback:false}:{engine:'deepgram',key:'synthetic-deepgram-key-not-real'};
        const latest=await post(data);assert.equal(latest.status,newer==='failed-key'?400:200);
      }finally{finish();}
      const stale=await first;
      assert.equal(stale.status,newer==='fallback'?200:400);
      if(newer!=='fallback')assert.match(stale.data.error,/older choice was not saved/);
      assert.equal(store.get('voice-engine'),newer==='deepgram'?'deepgram':newer==='fallback'?'meta':'local');
      assert.equal(readVoiceKey()?.provider,newer==='deepgram'?'deepgram':newer==='fallback'?'meta':undefined);
      if(newer==='fallback')assert.equal(store.get('voice-fallback'),'0');
    });
  }finally{globalThis.fetch=realFetch;approvals.cancel();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(root,{recursive:true,force:true});}
});
