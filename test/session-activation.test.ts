import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,realpathSync,symlinkSync,mkdirSync,unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { SessionActivation,codexDesktopUrl,CLAUDE_DESKTOP_READY_TIMEOUT_MS,DesktopReadinessError } from '../src/session-activation.js';
import type { Session } from '../src/session-catalog.js';

test('Codex opening and queue wake target only the exact existing thread',()=>{
  const id='11111111-1111-4111-a111-111111111111';
  assert.equal(codexDesktopUrl(id),`codex://threads/${id}`);
  assert.equal(codexDesktopUrl(id,true),`codex://threads/wake/${id}`);
  for(const bad of ['new',`${id}?prompt=other`,'../new',''])assert.throws(()=>codexDesktopUrl(bad,true),/exact Codex/);
});

function fixture() {
  const cwd=realpathSync(mkdtempSync(join(tmpdir(),'ffd-activation-'))),store=new Store(':memory:');
  const saved:Session={id:'11111111-1111-4111-a111-111111111111',desktopId:'local_11111111-1111-4111-a111-111111111111',accountScope:'account',provider:'claude',executionMode:'desktop',cwd,name:'Exact test',status:'saved',activation:'desktop-open',available:true,live:false};
  return {cwd,store,saved,close:()=>{store.close();rmSync(cwd,{recursive:true,force:true});}};
}
test('desktop activation opens once and requires the same live identity before returning',async()=>{
  const f=fixture();try {
    let opens=0,live=false;
    const activation=new SessionActivation(f.store,async()=>[{...f.saved,...(live?{activation:undefined,live:true}:{})}],async s=>{assert.equal(s.id,f.saved.id);opens++;live=true;},0);
    const [a,b]=await Promise.all([activation.ready(f.saved),activation.ready(f.saved)]);
    assert.equal(opens,1);assert.equal(a.live,true);assert.equal(b.id,a.id);
    await activation.ready(f.saved);assert.equal(opens,1);
  }finally{f.close();}
});
test('desktop open receipt is not readiness and is not repeated after restart',async()=>{
  const f=fixture();try {
    let opens=0;const catalog=async()=>[f.saved],open=async()=>{opens++;};
    await assert.rejects(new SessionActivation(f.store,catalog,open,0).ready(f.saved),/inbox is not live/);
    await assert.rejects(new SessionActivation(f.store,catalog,open,0).ready(f.saved),/inbox is not live/);
    assert.equal(opens,1);
  }finally{f.close();}
});
test('wrong account or native identity cannot be activated or substituted',async()=>{
  const f=fixture();try {
    let opens=0;
    for(const row of [{...f.saved,accountScope:'other'},{...f.saved,id:'22222222-2222-4222-a222-222222222222'}])
      await assert.rejects(new SessionActivation(f.store,async()=>[row],async()=>{opens++;},0).ready(f.saved),/identity or account changed/);
    assert.equal(opens,0);
  }finally{f.close();}
});
test('rejected open command remains held and never falls back to CLI',async()=>{
  const f=fixture();try {
    let opens=0;const activation=new SessionActivation(f.store,async()=>[f.saved],async()=>{opens++;throw new Error('unsupported');},0);
    await assert.rejects(activation.ready(f.saved),/no CLI fallback/);
    await assert.rejects(activation.ready(f.saved),/inbox is not live/);assert.equal(opens,1);
  }finally{f.close();}
});


test('existing project aliases reopen correctly, but a retargeted alias stops activation',async()=>{
 const f=fixture();try {
  const project=join(f.cwd,'project'),alias=join(f.cwd,'alias'),other=join(f.cwd,'other');mkdirSync(project);mkdirSync(other);symlinkSync(project,alias);
  const saved={...f.saved,cwd:alias};let live=false,opens=0;
  const activation=new SessionActivation(f.store,async()=>[{...saved,cwd:project,...(live?{activation:undefined,live:true}:{})}],async()=>{opens++;live=true;},0);
  assert.equal((await activation.ready(saved)).cwd,project);assert.equal(opens,1);
  unlinkSync(alias);symlinkSync(other,alias);
  await assert.rejects(activation.ready(saved),/account or project changed/);assert.equal(opens,1);
 }finally{f.close();}
});


test('a slow Desktop inbox is still awaited past the old 20-second deadline without another open',async()=>{
 const f=fixture();try {
  let now=0,opens=0;
  const clock={now:()=>now,sleep:async(ms:number)=>{now+=ms;}};
  const activation=new SessionActivation(f.store,async()=>[{...f.saved,...(now>=45_000?{activation:undefined,live:true}:{})}],async()=>{opens++;},undefined,clock);
  const session=await activation.ready(f.saved);
  assert.equal(CLAUDE_DESKTOP_READY_TIMEOUT_MS,180_000);assert.equal(session.live,true);assert.equal(now,45_000);assert.equal(opens,1);
 }finally{f.close();}
});
test('readiness expires at the bounded window with a definitely-not-submitted error',async()=>{
 const f=fixture();try {
  let now=0,opens=0;
  const activation=new SessionActivation(f.store,async()=>[f.saved],async()=>{opens++;},undefined,{now:()=>now,sleep:async(ms:number)=>{now+=ms;}});
  await assert.rejects(activation.ready(f.saved),e=>e instanceof DesktopReadinessError&&e.notSubmitted&&/No task was sent/.test(e.message));
  assert.equal(now,180_000);assert.equal(opens,1);
 }finally{f.close();}
});
