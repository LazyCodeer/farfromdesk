import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {Router} from '../src/router.js';
import {Approvals} from '../src/approvals.js';
import {Coordinator} from '../src/coordinator.js';
import {Telegram,telegramMessageId} from '../src/telegram.js';
import {WhatsApp} from '../src/whatsapp.js';
import {ownerResearchRequest} from '../src/agent-reach-request.js';

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'reach-ingress-')),store=new Store(':memory:'),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
  const binding=store.register('proxy','codex','11111111-1111-4111-8111-111111111111',root,'channel').binding;
  store.set('master',binding.id);store.set('active',binding.id);const coordinator=new Coordinator(store,router.native,router,()=>{});router.coordinator=coordinator;coordinator.registry.register(binding);router.pump=()=>{};
  router.reach=async(command,current)=>{assert.ok(current());return `Untrusted result for ${command}`;};
  const read=(id:string)=>coordinator.scope.run(binding.id,()=>ownerResearchRequest(store,router,binding,id));
  return {root,store,approvals,router,read,close:()=>{approvals.cancel();store.close();rmSync(root,{recursive:true,force:true});}};
}

test('typed WhatsApp owner request reaches the exact scoped coordinator research tool',async()=>{
  const f=fixture(),owner='123@s.whatsapp.net',wa=new WhatsApp(f.store,f.router);f.store.set('whatsapp-owner',owner);wa.selfJid=owner;wa.owners=[owner];wa.status='connected';
  const text='Research: /reach github search farfromdesk\nDraft a summary.';
  try {
    await wa.receiveMessage({key:{id:'R1',fromMe:true,remoteJid:owner},message:{conversation:text}} as any);
    assert.ok(f.store.recordedIncomingInput('wa:R1'));assert.ok(f.store.job('wa:R1'));
    assert.equal(await f.read('wa:R1'),'Untrusted result for /reach github search farfromdesk');
    await wa.receiveMessage({key:{id:'F1',fromMe:true,remoteJid:owner},message:{extendedTextMessage:{text,contextInfo:{isForwarded:true,forwardingScore:1}}}} as any);
    assert.equal(f.store.get('reach-owner-request:wa:F1'),undefined);
  }finally{wa.close();f.close();}
});

test('typed Telegram owner request reaches the exact scoped coordinator research tool',async()=>{
  const f=fixture(),bot=123456,owner=777,token='123456:'+('x'.repeat(35));
  const fetcher:typeof fetch=async(url,init)=>{
    const method=String(url).split('/').at(-1);
    if(method==='getMe')return Response.json({ok:true,result:{id:bot,is_bot:true,username:'ffd_test_bot'}});
    if(method==='getWebhookInfo')return Response.json({ok:true,result:{url:''}});
    if(method==='getUpdates')return await new Promise<Response>((_,reject)=>{if(init?.signal?.aborted)reject(Error('aborted'));else init?.signal?.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});
    return Response.json({ok:true,result:{message_id:10,chat:{id:owner}}});
  };
  const tg=new Telegram(f.store,f.router,f.root,fetcher);
  const message=(id:number,text:string,extra:any={})=>({update_id:id,message:{message_id:id,date:Math.floor(Date.now()/1000),text,chat:{id:owner,type:'private'},from:{id:owner,is_bot:false},...extra}});
  try {
    await tg.connect(token);const secret=new URL(tg.view().pairingUrl!).searchParams.get('start');await tg.receive(message(1,`/start ${secret}`));tg.confirm(owner);f.store.set('control-channel','telegram');
    const text='Research: /reach web search public topic\nDraft an article.',id=telegramMessageId(bot,owner,2);
    await tg.receive(message(2,text));assert.ok(f.store.recordedIncomingInput(id));assert.ok(f.store.job(id));
    assert.equal(await f.read(id),'Untrusted result for /reach web search public topic');
    await tg.receive(message(3,text,{forward_date:1}));assert.equal(f.store.get(`reach-owner-request:${telegramMessageId(bot,owner,3)}`),undefined);
  }finally{tg.close();f.close();}
});
