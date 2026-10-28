import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHmac, createHash, randomBytes } from 'node:crypto';
import { proto, BufferJSON } from '@whiskeysockets/baileys';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Coordinator } from '../src/coordinator.js';
import { Approvals } from '../src/approvals.js';
import { WhatsApp } from '../src/whatsapp.js';
import { GuardedSocket } from '../src/wa-guard.js';

const owner='123@s.whatsapp.net';
function fixture(){
 const store=new Store(':memory:'),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
 const binding=store.register('codex-poll','codex','11111111-1111-4111-8111-111111111111','/synthetic','channel').binding;
 store.set('whatsapp-owner',owner);store.set('active',binding.id);
 const sends:any[]=[];let fail=false;
 const sock=new GuardedSocket({sendMessage:async(jid:string,content:any)=>{sends.push({jid,content});return {message:{conversation:content.text}};},relayMessage:async(jid:string,message:any)=>{sends.push({jid,message});if(fail)throw Error('synthetic uncertain send');},end:()=>{}} as any,{owners:()=>[owner],ownedGroup:()=>false});
 const wa=new WhatsApp(store,router);wa.sock=sock;wa.status='connected';wa.selfJid=owner;wa.owners=[owner];
 const msg=(id:string,text:string,extra:any={})=>({key:{id,fromMe:true,remoteJid:owner},message:{conversation:text},...extra});
 const choices=async()=>{
  store.enqueue('wa:task',binding,'Choose an option',owner);
  store.output(binding,'Which option?', 'test-choice',owner,{requestId:'wa:task',kind:'final',origin:'agent',options:{choices:[{id:'safe',label:'Safe test'},{id:'command',label:'/screen'}],expiresInSeconds:900}});
  await wa.flush();return store.db.prepare('SELECT p.* FROM outbox p JOIN whatsapp_choice_polls l ON l.poll_id=p.id').get() as any;
 };
 const vote=(poll:any,id='VOTE1',index=0)=>{
  const message=JSON.parse(poll.wa_message,BufferJSON.reviver),secret=message.messageContextInfo.messageSecret;
  const key0=createHmac('sha256',Buffer.alloc(32)).update(secret).digest();
  const key=createHmac('sha256',key0).update(Buffer.concat([Buffer.from(poll.wa_id+owner+owner+'Poll Vote'),Buffer.from([1])])).digest();
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(poll.wa_id+'\0'+owner));
  const bytes=proto.Message.PollVoteMessage.encode({selectedOptions:[createHash('sha256').update(message.pollCreationMessageV3.options[index].optionName).digest()]}).finish();
  const encPayload=Buffer.concat([cipher.update(bytes),cipher.final(),cipher.getAuthTag()]);
  return {...msg(id,''),message:{pollUpdateMessage:{pollCreationMessageKey:{id:poll.wa_id,remoteJid:owner,fromMe:true},vote:{encPayload,encIv:iv}}}};
 };
 return {store,router,wa,approvals,binding,sends,msg,choices,vote,fail:()=>{fail=true;},close:()=>{wa.close();approvals.cancel();store.close();}};
}

test('WhatsApp typed commands use the owner chat and reject forwards, quotes and other people',async()=>{
 const f=fixture();try{
  await f.wa.receiveMessage(f.msg('cmd','/codex'));await f.wa.receiveMessage(f.msg('work','Check the task'));
  assert.equal(f.store.job('wa:work')?.binding_id,f.binding.id);assert.equal(f.store.job('wa:work')?.destination,owner);
  const target=f.store.get(`owner-target:${owner}`);
  await f.wa.receiveMessage(f.msg('forward','',{message:{extendedTextMessage:{text:'/back',contextInfo:{isForwarded:true,forwardingScore:1}}}}));
  await f.wa.receiveMessage(f.msg('quote','',{message:{extendedTextMessage:{text:'/back',contextInfo:{stanzaId:'old'}}}}));
  await f.wa.receiveMessage(f.msg('other','/back',{key:{id:'other',fromMe:false,remoteJid:owner}}));
  assert.equal(f.store.get(`owner-target:${owner}`),target);
  await f.wa.receiveMessage(f.msg('help','/help'));await f.wa.receiveMessage(f.msg('back','/back'));assert.equal(f.store.get(`owner-target:${owner}`),'null');
 }finally{f.close();}
});

test('polls are opt-in, retain numbered fallback and decrypt one exact owner choice without running its label',async()=>{
 const f=fixture();try{
  f.store.set('whatsapp-choice-polls','true');const poll=await f.choices();assert.ok(poll);assert.equal(f.sends.length,2);
  assert.match(f.sends[0].content.text,/Reply to this message with a number/);assert.equal(f.sends[1].message.pollCreationMessageV3.selectableOptionsCount,1);
  let screen=0;f.router.remoteControl=async()=>{screen++;return undefined;};
  const msg=f.vote(poll,'VOTE1',1);await f.wa.receiveMessage(msg);await f.wa.receiveMessage(msg);
  const job=f.store.job('wa:VOTE1');assert.ok(job);assert.equal(job.binding_id,f.binding.id);assert.equal(job.destination,owner);assert.match(job.body,/"id":"command"/);assert.equal(screen,0);
  assert.equal(f.store.db.prepare('SELECT selected_id FROM message_options').get()?.selected_id,'command');
 }finally{f.close();}
});

test('poll votes reject another sender, tampered ciphertext, expiration and changed answers',async()=>{
 const f=fixture();try{
  f.store.set('whatsapp-choice-polls','true');const poll=await f.choices();
  const other=f.vote(poll,'OTHER');other.key.fromMe=false;await f.wa.receiveMessage(other);assert.equal(f.store.job('wa:OTHER'),undefined);
  const bad=f.vote(poll,'BAD');bad.message.pollUpdateMessage.vote.encPayload[0]^=1;await f.wa.receiveMessage(bad);assert.equal(f.store.job('wa:BAD'),undefined);
  await f.wa.receiveMessage(f.vote(poll,'GOOD'));await f.wa.receiveMessage(f.vote(poll,'CHANGED',1));assert.ok(f.store.job('wa:GOOD'));assert.equal(f.store.job('wa:CHANGED'),undefined);
  f.store.db.prepare('UPDATE message_options SET expires_at=0').run();await f.wa.receiveMessage(f.vote(poll,'EXPIRED'));assert.equal(f.store.job('wa:EXPIRED'),undefined);
 }finally{f.close();}
});

test('unconfirmed poll sends are held and never replayed, while default choices remain text only',async()=>{
 const f=fixture();try{assert.equal(await f.choices(),undefined);assert.equal(f.sends.length,1);}finally{f.close();}
 const g=fixture();try{g.store.set('whatsapp-choice-polls','true');g.fail();const poll=await g.choices();assert.equal(poll.status,'uncertain');await g.wa.flush();assert.equal(g.sends.length,2);assert.equal(g.store.db.prepare("SELECT status FROM outbox WHERE source='test-choice:0'").get()?.status,'sent');}finally{g.close();}
});


test('turning polls off prevents a queued poll send and ignores its later vote',async()=>{
 const f=fixture();try{
  f.store.set('whatsapp-choice-polls','true');const poll=await f.choices();
  f.store.set('whatsapp-choice-polls','false');
  assert.throws(()=>f.wa.polls.message(poll.id),/disabled/);
  await f.wa.receiveMessage(f.vote(poll,'DISABLED'));assert.equal(f.store.job('wa:DISABLED'),undefined);
 }finally{f.close();}
});


test('quoted WhatsApp question accepts a slash-prefixed path exactly once',async()=>{
 const f=fixture();try{
  let result:string|undefined;
  void f.store.destinationContext.run(owner,()=>f.approvals.ask(f.binding,'Which folder?','question')).then(v=>{result=v;});
  f.store.db.prepare("UPDATE outbox SET status='sent',wa_id='QUESTION' WHERE source LIKE 'permission:%'").run();
  const m=f.msg('ANSWER','',{message:{extendedTextMessage:{text:'/Users/me/project',contextInfo:{stanzaId:'QUESTION'}}}});
  await f.wa.receiveMessage(m);await f.wa.receiveMessage(m);
  assert.equal(result,'/Users/me/project');assert.equal(f.approvals.pending.size,0);assert.equal(f.store.jobs().length,0);
 }finally{f.close();}
});

test('WhatsApp owner voice keeps screen, back, session browsing and selection intent',async()=>{
 const f=fixture();try{
  let text='',screens=0,lists=0,selected='',id=0;
  f.wa.transcribe=async()=>text;f.router.remoteControl=async t=>t==='control my screen'?(screens++,'Synthetic screen link'):undefined;
  const voice=async(value:string,contextInfo:any={})=>{text=value;await f.wa.receiveMessage(f.msg('VOICE'+id++,'',{message:{audioMessage:{mimetype:'audio/ogg; codecs=opus',seconds:2,fileLength:10,contextInfo}}}));};
  await voice('control my screen');assert.equal(screens,1);assert.equal(f.store.jobs().length,0);
  await f.wa.receiveMessage(f.msg('TALK','/talk codex-poll'));await voice('back');assert.equal(f.store.get(`direct:${owner}`),undefined);
  await f.wa.receiveMessage(f.msg('TARGET','/codex'));await voice('back');assert.equal(f.store.get(`owner-target:${owner}`),'null');
  const c=new Coordinator(f.store,f.router.native,f.router,()=>{});f.router.coordinator=c;
  c.list=async()=>{lists++;return '1. Synthetic session';};c.select=async value=>{selected=value;return 'Selected';};
  await voice('show my sessions');assert.equal(lists,1);
  f.store.set('selection-awaiting','true');await voice('1');assert.equal(selected,'1');assert.equal(f.store.jobs().length,0);
 }finally{f.close();}
});

test('WhatsApp forwarded or quoted voice cannot open screen control and spoken slash commands stay blocked',async()=>{
 const f=fixture();try{
  let text='control my screen',screens=0,id=0;f.wa.transcribe=async()=>text;f.router.remoteControl=async()=>{screens++;return 'Unexpected screen link';};
  const voice=async(contextInfo:any={})=>f.wa.receiveMessage(f.msg('VOICE'+id++,'',{message:{audioMessage:{mimetype:'audio/ogg; codecs=opus',seconds:2,fileLength:10,contextInfo}}}));
  await voice({isForwarded:true,forwardingScore:1});await voice({stanzaId:'unknown'});await voice({quotedMessage:{conversation:'quoted'}});
  text='/screen';await voice();assert.equal(screens,0);
 }finally{f.close();}
});


test('WhatsApp target list accepts a quoted number without running an agent task',async()=>{
 const f=fixture();try{
  const a=f.store.register('claude-a','claude','22222222-2222-4222-8222-222222222222','/synthetic','channel').binding,b=f.store.register('claude-b','claude','33333333-3333-4333-8333-333333333333','/synthetic','channel').binding;
  f.store.set('selected',JSON.stringify([a.id,b.id]));await f.wa.receiveMessage(f.msg('TARGETS','/claude list'));await f.wa.flush();
  const row=f.store.db.prepare('SELECT b.wa_id FROM outbox b JOIN message_options o ON o.outbox_id=b.id JOIN owner_target_options t ON t.option_id=o.id').get() as any;
  await f.wa.receiveMessage(f.msg('PICK','',{message:{extendedTextMessage:{text:'2',contextInfo:{stanzaId:row.wa_id}}}}));
  assert.equal(JSON.parse(f.store.get(`owner-target:${owner}`)!).id,b.id);assert.equal(f.store.jobs().length,0);
 }finally{f.close();}
});

test('bare /claude switches straight to the default Claude coordinator with one line and no list',async()=>{
 const f=fixture();try{
  const c=f.store.register('claude-coord','claude','44444444-4444-4444-8444-444444444444','/synthetic','channel').binding,w=f.store.register('claude-worker','claude','55555555-5555-4555-8555-555555555555','/synthetic','channel').binding;
  f.router.coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});f.router.coordinator.registry.register(c);f.store.set(`name:${c.id}`,'atlas Super Ai');
  f.store.set('selected',JSON.stringify([c.id,w.id]));
  await f.wa.receiveMessage(f.msg('C1','/claude'));
  assert.equal(JSON.parse(f.store.get(`owner-target:${owner}`)!).id,c.id);
  const bodies=()=>(f.store.db.prepare("SELECT body FROM outbox WHERE source LIKE 'command%' OR source LIKE 'owner-choice:%' ORDER BY rowid").all() as any[]).map(r=>r.body);
  assert.match(bodies().at(-1)!,/Now talking to atlas Super Ai\. \/back to leave\./);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM owner_target_options').get()!.n,0);assert.equal(f.store.jobs().length,0);
  await f.wa.receiveMessage(f.msg('C2','Check the build'));assert.equal(f.store.job('wa:C2')?.binding_id,c.id);
  // No Codex coordinator: one line pointing to the desktop app, and the Claude target stays.
  await f.wa.receiveMessage(f.msg('C3','/codex'));
  assert.match(bodies().at(-1)!,/No Codex coordinator is connected\. Connect one in the FarFromDesk desktop app/);
  assert.equal(JSON.parse(f.store.get(`owner-target:${owner}`)!).id,c.id);
  // A paused coordinator fails closed instead of picking another Claude session.
  await f.wa.receiveMessage(f.msg('C4','/back'));f.store.enable(c.id,false);await f.wa.receiveMessage(f.msg('C5','/claude'));
  assert.equal(f.store.get(`owner-target:${owner}`),'null');assert.equal(f.store.jobs().length,1);
  // The full list stays available behind /claude list.
  f.store.enable(c.id,true);await f.wa.receiveMessage(f.msg('C6','/claude list'));assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM owner_target_options').get()!.n,1);
 }finally{f.close();}
});

test('an expired or older-build session list is dropped so plain numbers and names route normally',async()=>{
 const f=fixture();try{
  const key=`owner-target-choice:${owner}`;
  f.store.set(key,JSON.stringify({provider:'claude',targets:[],expires:Date.now()-1,requestId:'wa:old',names:['claude-a']}));
  await f.wa.receiveMessage(f.msg('N1','1'));assert.equal(f.store.job('wa:N1')?.binding_id,f.binding.id);assert.equal(f.store.get(key),'null');
  f.store.set(key,JSON.stringify({provider:'claude',targets:[],expires:Date.now()+600000,names:['claude-a']}));
  await f.wa.receiveMessage(f.msg('N2','claude-a'));assert.equal(f.store.job('wa:N2')?.binding_id,f.binding.id);assert.equal(f.store.get(key),'null');
  assert.equal(f.store.commandTurns().length,0);
 }finally{f.close();}
});

test('WhatsApp session list polls are numbered once and the text never mentions buttons',async()=>{
 const f=fixture();try{
  f.store.set('whatsapp-choice-polls','true');
  const a=f.store.register('claude-a','claude','22222222-2222-4222-8222-222222222222','/synthetic','channel').binding,b=f.store.register('claude-b','claude','33333333-3333-4333-8333-333333333333','/synthetic','channel').binding;
  f.store.set('selected',JSON.stringify([a.id,b.id]));await f.wa.receiveMessage(f.msg('L1','/claude list'));await f.wa.flush();await f.wa.flush();
  const text=f.sends.find(s=>s.content?.text?.includes('Choose a connected Claude session'))!.content.text;assert.doesNotMatch(text,/button/i);
  const poll=f.sends.find(s=>s.message?.pollCreationMessageV3)!.message.pollCreationMessageV3;
  assert.deepEqual(poll.options.map((o:any)=>o.optionName),['1. claude-a','2. claude-b']);
 }finally{f.close();}
});
