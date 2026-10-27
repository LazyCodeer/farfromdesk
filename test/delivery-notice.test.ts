import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Approvals } from '../src/approvals.js';

const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function fixture(noticeMs:number) {
  const store=new Store(':memory:'),approvals=new Approvals(store),b=store.register('codex-a','codex','11111111-1111-4111-a111-111111111111','/tmp/a').binding;
  store.set('whatsapp-owner','owner@s.whatsapp.net');
  const router=new Router(store,{run:async()=>{throw new Error('Command failed: timed out');},catalog:async()=>({sessions:[],cursor:null}),stop:()=>{}} as any,approvals);
  router.uncertainNoticeMs=noticeMs;
  const notices=()=>(store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE source LIKE 'error:%'").get() as {n:number}).n;
  return {store,router,b,notices,close:()=>{router.stopped=true;approvals.cancel();store.close();}};
}

test('a slow hand-off that the session later answers never warns the owner',async()=>{
  const f=fixture(40);
  try {
    f.store.enqueue('wa:slow',f.b,'Check the build');f.router.pump();await wait(5);
    assert.equal(f.store.job('wa:slow')?.status,'uncertain');
    f.router.channelReply(f.b,'Build is green.','final','wa:slow');
    await wait(60);assert.equal(f.notices(),0);
  }finally{f.close();}
});

test('an unanswered hand-off warns once after the wait; internal report deliveries never do',async()=>{
  const f=fixture(20);
  try {
    f.store.enqueue('wa:lost',f.b,'Check the build');f.store.enqueue('report:master:wa:x',f.b,'Worker report');f.router.pump();
    await wait(5);assert.equal(f.notices(),0);
    await wait(40);assert.equal(f.notices(),1);
    const warning=f.store.deliveries('wa:lost');
    assert.equal(warning.length,1);assert.equal(warning[0].reply_kind,'system');
    assert.equal(f.store.job('wa:lost')?.first_reply_at,null,'a warning is not an agent reply');
    assert.equal(f.store.deliveries('report:master:wa:x').length,0);
    assert.equal(f.store.job('report:master:wa:x')?.status,'uncertain');
  }finally{f.close();}
});
