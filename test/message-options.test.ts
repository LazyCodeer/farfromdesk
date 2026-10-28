import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Approvals } from '../src/approvals.js';
import { optionsMarkup, parseMessageOptions, selectOption } from '../src/message-options.js';
const options={choices:[{id:'a',label:'Inspect first'},{id:'b',label:'Continue'}],expiresInSeconds:60};
function fixture(channel='whatsapp'){
 const store=new Store(':memory:');store.set('control-channel',channel);
 const destination=channel==='telegram'?'tg:123456:777':'owner@s.whatsapp.net';store.set(channel==='telegram'?'telegram-owner':'whatsapp-owner',destination);
 const b=store.register('a','codex','11111111-1111-4111-8111-111111111111','/tmp','channel').binding;
 const other=store.register('b','codex','22222222-2222-4222-8222-222222222222','/tmp','channel').binding;store.set('active',other.id);
 const approvals=new Approvals(store);const router=new Router(store,{} as any,approvals);
 store.enqueue('original',b,'Check it',destination);
 router.channelReply(b,'Choose next','progress','original','offer',{options});
 const row=store.db.prepare('SELECT * FROM outbox WHERE request_id=?').get('original') as any;store.sent(row.id);
 const receive=(id:string,text:string,extra:any={})=>store.destinationContext.run(destination,()=>router.receive({id,text,quotedId:row.wa_id,...extra}));
 return {store,b,other,router,approvals,row,receive,destination,close:()=>{approvals.cancel();store.close();}};
}
test('numbered fallback targets offered session, consumes once and does not interpret commands',async()=>{
 const f=fixture();try{
 assert.match(f.row.body,/1. Inspect first/);assert.match(f.row.body,/Reply to this message/);
 await f.receive('one','1');assert.equal(f.store.job('one')?.binding_id,f.b.id);
 assert.match(f.store.job('one')!.body,/not a native permission grant/);
 await f.receive('two','1');assert.equal(f.store.job('two'),undefined);
 assert.equal((await f.receive('three','2')).status,'blocked');
 }finally{f.close();}
});
test('spoofed token, wrong owner/message and expired offers cannot queue',async()=>{
 const f=fixture('telegram');try{
 const token=optionsMarkup(f.store,f.row.id)!.inline_keyboard[0][0].callback_data;
 assert.equal((await f.receive('spoof','x',{optionToken:token.replace('opt:','opt:wrong')})).status,'blocked');
 assert.equal((await f.receive('wrongmsg','x',{optionToken:token,quotedId:'other'})).status,'blocked');
 await f.store.destinationContext.run('tg:123456:888',()=>f.router.receive({id:'wrongowner',text:'x',quotedId:f.row.wa_id,optionToken:token}));assert.equal(f.store.job('wrongowner'),undefined);
 f.store.db.prepare('UPDATE message_options SET expires_at=0').run();assert.equal((await f.receive('expired','x',{optionToken:token})).status,'blocked');assert.equal(f.store.job('expired'),undefined);
 }finally{f.close();}
});
test('delivery must be confirmed and request must remain eligible',async()=>{
 const f=fixture();try{
 f.store.db.prepare("UPDATE outbox SET status='uncertain' WHERE id=?").run(f.row.id);assert.equal((await f.receive('uncertain','1')).status,'blocked');
 f.store.sent(f.row.id);f.store.jobState('original','replaced');assert.equal((await f.receive('replaced','1')).status,'blocked');
 }finally{f.close();}
});
test('validation, reply idempotency and text-only compatibility',()=>{
 const f=fixture();try{
 assert.throws(()=>parseMessageOptions({choices:[{id:'a',label:'a'},{id:'a',label:'b'}]}));
 assert.throws(()=>parseMessageOptions({...options,expiresInSeconds:0}));
 assert.equal(f.router.channelReply(f.b,'Choose next','progress','original','offer',{options}).newlyQueued,false);
 assert.throws(()=>f.router.channelReply(f.b,'Choose next','progress','original','offer',{options:{...options,choices:[{id:'a',label:'Changed'},{id:'b',label:'Continue'}]}}));
 f.router.channelReply(f.b,'Plain text','progress','original','plain');
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM message_options').get()!.n,1);
 }finally{f.close();}
});
test('choice labels never invoke native approval',async()=>{
 const f=fixture();try{
 let calls=0;(f.approvals as any).naturalReply=()=>{calls++;return undefined;};
 f.store.db.prepare('UPDATE message_options SET choices=?').run(JSON.stringify([{id:'a',label:'/approve secret'},{id:'b',label:'Yes, allow it'}]));
 await f.receive('cmd','1');assert.equal(calls,0);assert.match(f.store.job('cmd')!.body,/\/approve secret/);
 }finally{f.close();}
});

test('failed queue rolls back consumption, restart retains choice identity and duplicate protection',()=>{
 const root=mkdtempSync(join(tmpdir(),'ffd-options-'));const file=join(root,'test.sqlite');let store=new Store(file);
 try{
 store.set('whatsapp-owner','owner');const b=store.register('a','codex','11111111-1111-4111-8111-111111111111','/tmp','channel').binding;
 store.enqueue('req',b,'Check','owner');store.output(b,'Choose','offer','owner',{requestId:'req',origin:'agent',kind:'progress',options});
 const row=store.db.prepare('SELECT * FROM outbox').get() as any;store.sent(row.id);
 const input={responseId:'answer',destination:'owner',messageId:row.wa_id,number:1};
 assert.throws(()=>selectOption(store,input,()=>{throw new Error('queue unavailable');}));
 assert.equal(store.db.prepare('SELECT selected_id FROM message_options').get()!.selected_id,null);
 store.close();store=new Store(file);
 selectOption(store,input,(id,text)=>store.enqueue(input.responseId,store.binding(id)!,text,'owner'));
 store.close();store=new Store(file);let queued=0;selectOption(store,{...input,responseId:'duplicate'},()=>{queued++;});assert.equal(queued,0);assert.equal(store.jobs().length,2);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('channel switches and owner changes invalidate saved choices',async()=>{
 const f=fixture();try{
 f.store.set('control-channel','telegram');assert.equal((await f.receive('switch','1')).status,'blocked');
 f.store.set('control-channel','whatsapp');f.store.set('whatsapp-owner','someone-else');assert.equal((await f.receive('changed-owner','1')).status,'blocked');
 }finally{f.close();}
});
test('owner-only WhatsApp group choices retain separate owner and destination',async()=>{
 const f=fixture();try{
 const group='private@g.us';f.store.set('destination-jid',group);f.store.set(`owned-group:${group}`,'true');
 f.store.enqueue('group-request',f.b,'Group task',group);f.router.channelReply(f.b,'Choose','progress','group-request','group-offer',{options});
 const row=f.store.db.prepare("SELECT * FROM outbox WHERE request_id='group-request'").get() as any;f.store.sent(row.id);
 await f.store.destinationContext.run(group,()=>f.router.receive({id:'group-answer',text:'1',quotedId:row.wa_id}));
 assert.equal(f.store.job('group-answer')?.destination,group);assert.equal(f.store.job('group-answer')?.binding_id,f.b.id);
 }finally{f.close();}
});


test('relay-only proxy replies reject choices instead of silently dropping their buttons',()=>{
 const f=fixture();try{
 f.router.coordinator={isCoordinator:()=>true,delegatedCoordinator:()=>true} as any;
 assert.throws(()=>f.router.channelReply(f.b,'Choose another step','progress','original','relay-options',{options}),/owner-facing proxy/);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM message_options').get()!.n,1);
 }finally{f.close();}
});


test('choices preserve the original item across both transports and later worker replies',async()=>{
 for(const channel of ['whatsapp','telegram']){
  const f=fixture(channel);try{
   f.store.linkItem('original',17);
   const extra=channel==='telegram'?{optionToken:optionsMarkup(f.store,f.row.id)!.inline_keyboard[0][0].callback_data}:{};
   await f.receive('item-choice',channel==='telegram'?'Selected message option':'1',extra);
   assert.equal(f.store.itemOf('item-choice'),17);
   assert.equal(f.store.get(`brain-topic:${f.destination}`),'item:17');
   f.router.channelReply(f.b,'Inspection complete','final','item-choice','choice-result');
   const result=f.store.db.prepare('SELECT body FROM outbox WHERE request_id=?').get('item-choice') as any;
   assert.match(result.body,/#17/);
  }finally{f.close();}
 }
});

test('failed choice queue rolls back its item link and leaves the offer reusable',()=>{
 const f=fixture();try{
  f.store.linkItem('original',17);
  const input={responseId:'item-retry',destination:f.destination,messageId:f.row.wa_id,number:1};
  assert.throws(()=>selectOption(f.store,input,()=>{throw Error('fixture queue failure');}),/fixture queue failure/);
  assert.equal(f.store.itemOf(input.responseId),undefined);
  assert.equal(f.store.db.prepare('SELECT selected_id FROM message_options').get()!.selected_id,null);
  selectOption(f.store,input,(id,text)=>f.store.enqueue(input.responseId,f.store.binding(id)!,text,f.destination));
  assert.equal(f.store.itemOf(input.responseId),17);
 }finally{f.close();}
});
