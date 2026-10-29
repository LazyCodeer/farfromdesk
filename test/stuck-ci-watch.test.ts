import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root=mkdtempSync(join(tmpdir(),'ffd-ci-test-'));process.env.WSB_STATE_DIR=root;process.env.FARFROMDESK_HOME=join(root,'home');
test.after(()=>rmSync(root,{recursive:true,force:true}));
const {Store}=await import('../src/store.js');
const {Router}=await import('../src/router.js');
const {Approvals}=await import('../src/approvals.js');
const {DEFAULT_BRAIN}=await import('../src/meta-brain-config.js');
const {StuckCiWatch}=await import('../src/stuck-ci-watch.js');
const {WhatsApp}=await import('../src/whatsapp.js');
const {parseCiPullRequest}=await import('../src/stuck-ci-observer.js');

const owner='owner@s.whatsapp.net',head='a'.repeat(40);
const reply=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
function fixture(){
  const store=new Store(':memory:');store.set('whatsapp-owner',owner);store.set('control-channel','whatsapp');
  store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true}));
  const approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
  const binding=store.register('worker','codex',randomUUID(),'/tmp').binding;
  store.recordOwnerOrigin('wa:root',owner,owner);store.destinationContext.run(owner,()=>store.enqueue('wa:root',binding,'synthetic',owner));
  const item=store.destinationContext.run(owner,()=>router.brain.memory.add('wa:root','Synthetic task'));
  let now=Date.now(),calls:string[]=[],failed=true,headSha=head,privateRepo=false,hook:(()=>void)|undefined;
  const fetcher:typeof fetch=async(url,init)=>{
    calls.push(String(url));assert.equal(init?.redirect,'error');assert.equal(new Headers(init?.headers).has('authorization'),false);hook?.();
    if(String(url).includes('/pulls/'))return reply({number:12,state:'open',merged_at:null,base:{repo:{full_name:'example/project',private:privateRepo}},head:{sha:headSha}});
    const run={id:19,name:'Synthetic checks',head_sha:head,status:'completed',conclusion:failed?'failure':'success',completed_at:new Date(now-1000).toISOString()};
    return reply(String(url).includes('/commits/')?{check_runs:[run]}:run);
  };
  const watch=new StuckCiWatch(store,router,fetcher,()=>now);router.stuckCiWatch=watch;
  const command=(text:string,extra:Record<string,unknown>={})=>watch.command({id:'wa:command',text,ownerCommand:true,...extra});
  const add=()=>command(`/stuck ci #${item.id} https://github.com/example/project/pull/12`);
  const out=()=>store.db.prepare("SELECT * FROM outbox WHERE source LIKE 'stuck-ci-alert:%'").all() as any[];
  const close=()=>{router.stopped=true;approvals.cancel();store.close();};
  return {store,router,binding,item,watch,command,add,out,close,calls,advance:(ms:number)=>{now+=ms;},
    setFailure:(v:boolean)=>{failed=v;},setHead:(v:string)=>{headSha=v;},setPrivate:(v:boolean)=>{privateRepo=v;},onFetch:(fn:(()=>void)|undefined)=>{hook=fn;}};
}

test('only an exact public PR link and a direct authenticated self-chat command can create a watch',()=>{
  const f=fixture();try{
    for(const value of ['https://github.com/example/project/pull/12?x=1','https://github.com/example/project/pull/12#x','https://github.com/../project/pull/12','https://evil.example/example/project/pull/12','https://github.com/example/project/pull/0'])assert.equal(parseCiPullRequest(value),undefined);
    assert.match(f.command(`/stuck ci #${f.item.id} https://github.com/example/project/pull/12`,{quotedId:'x'})!,/new text/);
    assert.match(f.command(`/stuck ci #${f.item.id} https://github.com/example/project/pull/12`,{ownerCommand:false})!,/new text/);
    assert.match(f.command('/stuck ci #999 https://github.com/example/project/pull/12')!,/not available/);
    assert.match(f.command('/stuck ci nonsense')!,/Use \/stuck ci/);
    assert.match(f.add()!,/Watching the public PR/);assert.equal(f.calls.length,0);
  }finally{f.close();}
});

test('a watch observes one failed check on the exact public head and revalidates before sending',async()=>{
  const f=fixture();try{
    f.add();await f.watch.tick();await f.watch.tick();assert.equal(f.out().length,1);
    const row=f.out()[0];assert.match(row.body,/observed failing at .*Z/);assert.match(row.body,/not overall CI or merge readiness/);
    assert.equal(await f.watch.revalidate(row,owner),'ready');
    assert.ok(f.calls.every(url=>url.startsWith('https://api.github.com/repos/example/project/')));
    assert.ok(f.calls.some(url=>url.includes(`/commits/${head}/check-runs?per_page=100`)));
  }finally{f.close();}
});

test('private PRs, changed heads, successful checks and revoked owner authority fail closed',async()=>{
  for(const mode of ['private','head','success','owner-returned','item','pause','policy','removed'] as const){
    const f=fixture();try{
      f.add();if(mode==='private'){f.setPrivate(true);await f.watch.tick();assert.equal(f.out().length,0);continue;}
      await f.watch.tick();const row=f.out()[0];assert.ok(row);
      if(mode==='head')f.setHead('b'.repeat(40));
      if(mode==='success')f.setFailure(false);
      if(mode==='owner-returned'){f.store.set('whatsapp-owner','other@s.whatsapp.net');f.store.set('whatsapp-owner',owner);}
      if(mode==='item')f.store.db.prepare("UPDATE items SET status='done' WHERE id=?").run(f.item.id);
      if(mode==='pause'){f.store.set('background-enabled','false');f.store.set('background-enabled','true');}
      if(mode==='policy'){f.store.set('meta-brain-policy','{}');f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true}));}
      if(mode==='removed')f.command(`/stuck ci remove #${f.item.id}`);
      assert.notEqual(await f.watch.revalidate(row,owner),'ready',mode);
    }finally{f.close();}
  }
});

test('revocation while the GitHub response is arriving prevents an observation and later delivery',async()=>{
  const f=fixture();try{
    f.add();f.onFetch(()=>{f.onFetch(undefined);f.store.set('whatsapp-owner','other@s.whatsapp.net');f.store.set('whatsapp-owner',owner);});
    await f.watch.tick();assert.equal(f.out().length,0);assert.equal(f.calls.length,1);
  }finally{f.close();}
});

test('a restart invalidates queued notices even if the watch itself remains',async()=>{
  const f=fixture();try{
    f.add();await f.watch.tick();const row=f.out()[0];assert.equal(f.watch.deliveryState(row,owner),'ready');
    const restarted=new StuckCiWatch(f.store,f.router,async()=>{throw Error('no network');});
    assert.equal(restarted.deliveryState(row,owner),'invalid');
  }finally{f.close();}
});

test('the hourly API budget prevents new network requests when nearly exhausted',async()=>{
  const f=fixture();try{
    f.add();const at=Date.now();for(let i=0;i<34;i++)f.store.db.prepare('INSERT INTO stuck_ci_api_reads(at) VALUES(?)').run(at);
    await f.watch.tick();assert.equal(f.calls.length,0);assert.equal(f.out().length,0);
    f.advance(61*60_000);await f.watch.tick();assert.equal(f.out().length,1);
  }finally{f.close();}
});

test('the last response cannot outrun revocation of the watched item',async()=>{
  const f=fixture();try{
    f.add();await f.watch.tick();const row=f.out()[0];let responses=0;
    f.onFetch(()=>{if(++responses===5)f.store.db.prepare("UPDATE items SET status='done' WHERE id=?").run(f.item.id);});
    assert.equal(await f.watch.revalidate(row,owner),'invalid');
  }finally{f.close();}
});

test('WhatsApp transport rechecks before sending, deduplicates, and does not retry an uncertain send',async()=>{
  for(const mode of ['ok','changed','uncertain'] as const){const f=fixture();try{
    const wa=new WhatsApp(f.store,f.router);wa.status='connected';wa.selfJid=owner;wa.owners=[owner];
    let calls=0;wa.sock={sendMessage:async()=>{calls++;if(mode==='uncertain')throw Error('network');return {};},end:()=>{}} as any;
    f.add();await f.watch.tick();const row=f.out()[0];if(mode==='changed')f.setHead('b'.repeat(40));
    await wa.flush();await wa.flush();assert.equal(calls,mode==='changed'?0:1);
    assert.equal(f.out()[0].status,mode==='ok'?'sent':mode==='changed'?'queued':'uncertain');wa.close();
  }finally{f.close();}}
});
