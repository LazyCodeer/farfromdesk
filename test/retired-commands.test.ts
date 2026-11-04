import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Router} from '../src/router.js';
import {Approvals} from '../src/approvals.js';
import {TELEGRAM_COMMANDS,isOwnerCommand} from '../src/owner-commands.js';

test('retired /checkrun, /reach, /research and /jobs are ordinary words routed like any message',async()=>{
 for(const c of ['checkrun','reach','research','jobs']){
  assert.equal(isOwnerCommand(`/${c} x`),false);assert.ok(!TELEGRAM_COMMANDS.some(t=>t.command===c));
 }
 const store=new Store(':memory:'),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);router.pump=()=>{};
 try{
  const b=store.register('target','codex','11111111-1111-4111-8111-111111111111','/synthetic').binding;
  const owner='123@s.whatsapp.net';store.set('whatsapp-owner',owner);store.set('active',b.id);
  for(const [id,text,body] of [['wa:1','/research Splice AI','research Splice AI'],['wa:2','/jobs AI engineer','jobs AI engineer'],['wa:3','research the jobs market','research the jobs market']]){
   const result=await store.destinationContext.run(owner,()=>router.receive({id,text,ownerCommand:true}));
   assert.equal(result.status,'queued');assert.equal(store.job(id)?.body,body);assert.equal(store.job(id)?.binding_id,b.id);
  }
 }finally{approvals.cancel();store.close();}
});
