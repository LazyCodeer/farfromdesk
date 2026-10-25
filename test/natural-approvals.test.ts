import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Approvals} from '../src/approvals.js';
import {Router} from '../src/router.js';

function fixture(t:any) {
  const store=new Store(':memory:');
  const b=store.register('fixture','codex','11111111-1111-4111-a111-111111111111','/tmp').binding;
  const approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
  t.after(()=>{router.stopped=true;approvals.cancel();store.close();});
  function ask(kind:'approval'|'question'='approval',sent=true) {
    const result=approvals.ask(b,'Fixture request',kind);
    const code=[...approvals.pending.keys()].at(-1)!;
    const row=store.db.prepare('SELECT * FROM outbox WHERE source=?').get(`permission:${code}:0`) as any;
    if(sent)store.sent(row.id);
    return {result,code,quote:row.wa_id};
  }
  return {store,b,approvals,router,ask};
}

test('typed quoted approval settles the exact permission once and duplicate events do not replay it',async t=>{
  const f=fixture(t),a=f.ask(),b=f.ask();
  assert.equal((await f.router.receive({id:'wa:decision',text:'Yes, allow it',quotedId:b.quote})).status,'handled');
  assert.equal(await b.result,'approve');assert.ok(f.approvals.pending.has(a.code));
  assert.equal((await f.router.receive({id:'wa:decision',text:'Yes, allow it',quotedId:b.quote})).status,'ignored');
  assert.throws(()=>f.approvals.naturalReply('Yes',b.quote),/expired|already answered/);
});

test('only a specific unquoted decision can answer one delivered permission',async t=>{
  const f=fixture(t),p=f.ask();
  assert.equal(f.approvals.naturalReply('yes'),undefined);
  assert.equal(f.approvals.naturalReply('no'),undefined);
  assert.equal(f.approvals.naturalReply('Yes, allow it')?.binding.id,f.b.id);
  assert.equal(await p.result,'approve');
});

test('ambiguous and unsent decisions remain pending',t=>{
  const f=fixture(t),a=f.ask('approval',false);
  assert.throws(()=>f.approvals.naturalReply('Yes, allow it'),/Wait for/);
  assert.throws(()=>f.approvals.naturalReply('Yes, allow it',a.quote),/Wait for/);
  f.ask();
  assert.throws(()=>f.approvals.naturalReply('Yes, allow it'),/specific permission/);
  assert.equal(f.approvals.pending.size,2);
});

test('ordinary quotes, voice decisions, expired and paused permissions cannot approve',async t=>{
  const f=fixture(t),p=f.ask();
  f.store.output(f.b,'Ordinary reply','normal');
  const row=f.store.db.prepare("SELECT wa_id FROM outbox WHERE source='normal:0'").get() as any;
  assert.equal(f.approvals.naturalReply('Yes, allow it',row.wa_id),undefined);
  assert.equal((await f.router.receive({id:'wa:voice',text:'Yes, allow it',quotedId:p.quote,source:'voice'})).status,'blocked');
  assert.ok(f.approvals.pending.has(p.code));
  f.store.enable(f.b.id,false);
  assert.throws(()=>f.approvals.naturalReply('Yes',p.quote),/paused/);
  f.store.enable(f.b.id,true);f.approvals.pending.get(p.code)!.expires=Date.now()-1;
  assert.throws(()=>f.approvals.naturalReply('Yes',p.quote),/expired/);
});

test('a quoted question accepts an answer without approving any permission',async t=>{
  const f=fixture(t),q=f.ask('question'),p=f.ask();
  assert.throws(()=>f.approvals.naturalReply('Yes, allow it'),/specific permission/);
  f.approvals.naturalReply('Use the staging workspace',q.quote);
  assert.equal(await q.result,'Use the staging workspace');
  assert.ok(f.approvals.pending.has(p.code));
  f.approvals.naturalReply('No, deny it',p.quote);assert.equal(await p.result,'deny');
});
