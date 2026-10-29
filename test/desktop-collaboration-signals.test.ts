import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root=mkdtempSync(join(tmpdir(),'ffd-desktop-signal-'));
process.env.WSB_STATE_DIR=root;process.env.FARFROMDESK_HOME=join(root,'home');
test.after(()=>rmSync(root,{recursive:true,force:true}));
const {Store}=await import('../src/store.js');
const {NativeAgents}=await import('../src/native.js');
const {Router}=await import('../src/router.js');
const {Approvals}=await import('../src/approvals.js');
const {handleHook,drainHooks}=await import('../src/hooks.js');

test('native request observation provides no Claude Desktop completion status',async()=>{
  let lookedUp=0;
  const native={store:{binding:()=>{lookedUp++;return {enabled:1,provider:'claude'};}}};
  assert.equal(await NativeAgents.prototype.requestStatus.call(native as any,{id:'synthetic-request',binding_id:'synthetic-session'}),undefined);
  assert.equal(lookedUp,1);
});

test('Claude Stop hook without correlated turn stays unlinked and does not finish the job',async()=>{
  const store=new Store(':memory:');try{
    const {binding}=store.register('desktop','claude','11111111-1111-4111-a111-111111111111','/tmp');
    store.set('whatsapp-owner','owner@s.whatsapp.net');
    store.enqueue('wa:synthetic',binding,'A synthetic task','owner@s.whatsapp.net');store.jobState('wa:synthetic','submitted');
    mkdirSync(join(root,'bindings'),{recursive:true});
    writeFileSync(join(root,'bindings','desktop.json'),JSON.stringify({id:binding.id,provider:'claude',nativeId:binding.native_id}));
    await handleHook('claude',{session_id:binding.native_id,hook_event_name:'Stop',turn_id:'unrelated-turn',last_assistant_message:'Synthetic update'});
    drainHooks(store);
    assert.equal(store.unlinkedHooks().length,1);assert.equal(store.job('wa:synthetic')?.status,'submitted');
    // Even an explicitly linked hook is stored as output; it is not a
    // verified provider-terminated event for the claimed attempt.
    await handleHook('claude',{session_id:binding.native_id,hook_event_name:'Stop',turn_id:'other-turn',request_id:'wa:synthetic',last_assistant_message:'Linked synthetic update'});
    drainHooks(store);
    assert.equal(store.job('wa:synthetic')?.status,'submitted');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM reply_receipts WHERE request_id=? AND origin='hook'").get('wa:synthetic')?.n,1);
  }finally{store.close();}
});

test('a Desktop final reply updates the request but does not prove the provider turn ended',()=>{
  const store=new Store(':memory:'),approvals=new Approvals(store);try{
    const {binding}=store.register('desktop-final','claude','22222222-2222-4222-a222-222222222222','/tmp');
    store.set('whatsapp-owner','owner@s.whatsapp.net');
    store.enqueue('wa:final',binding,'Synthetic task','owner@s.whatsapp.net');store.jobState('wa:final','submitted');
    const router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
    router.channelReply(binding,'Synthetic final reply','final','wa:final');
    assert.equal(store.job('wa:final')?.status,'completed');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM request_events WHERE request_id=? AND event='provider_turn_completed'").get('wa:final')?.n,0);
  }finally{approvals.cancel();store.close();}
});
