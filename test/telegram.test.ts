import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Approvals } from '../src/approvals.js';
import { Telegram, telegramDestination, telegramMessageId, telegramHTML } from '../src/telegram.js';
import { Artifacts } from '../src/artifacts.js';
import { Coordinator } from '../src/coordinator.js';
import { queueCoordinatorUpdates, initializeCoordinatorUpdates, COORDINATOR_UPDATE_INTERVAL_MS } from '../src/coordinator-updates.js';
import { Attachments } from '../src/attachments.js';

const token='123456:'+('x'.repeat(35)),bot=123456,owner=777,other=888;
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'ffd-telegram-')),store=new Store(join(root,'test.sqlite')),approvals=new Approvals(store);
  const router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
  router.attachments=new Attachments(store,root);
  const binding=store.register('test','codex','11111111-1111-4111-8111-111111111111',root,'channel').binding;store.set('active',binding.id);store.set('control-channel','telegram');
  const calls:{method:string;body:any}[]=[];
  let queuedUpdates:any[]=[];let fileData=Buffer.from('A reviewed document');
  let fail=0,webhook='',botId=bot;let next=10;
  const fetcher:typeof fetch=async(url,init)=>{
    const method=String(url).split('/').at(-1)!;const body=init?.body instanceof FormData?init.body:JSON.parse(String(init?.body??'{}'));calls.push({method,body});
    if(String(url).includes('/file/bot'))return new Response(fileData);
    if(method==='getFile')return Response.json({ok:true,result:{file_path:'documents/file_1.txt'}});
    if(method==='getUpdates'&&queuedUpdates.length){const result=queuedUpdates;queuedUpdates=[];return Response.json({ok:true,result});}
    if(method==='getUpdates')return await new Promise<Response>((_,reject)=>{if(init?.signal?.aborted)reject(new Error('abort'));else init?.signal?.addEventListener('abort',()=>reject(new Error('abort')),{once:true});});
    if(method==='getMe')return Response.json({ok:true,result:{id:botId,is_bot:true,username:'ffd_test_bot'}});
    if(method==='getWebhookInfo')return Response.json({ok:true,result:{url:webhook}});
    if(fail===1)throw new Error(`network failure containing ${token}`);
    if(fail)return Response.json({ok:false,error_code:fail,parameters:{retry_after:3}},{status:fail});
    return Response.json({ok:true,result:{message_id:next++,chat:{id:owner}}});
  };
  const tg=new Telegram(store,router,root,fetcher);
  const message=(id:number,text:string,user=owner,extra:any={})=>({update_id:id,message:{message_id:id,date:Math.floor(Date.now()/1000),text,chat:{id:user,type:'private'},from:{id:user,first_name:'Owner',is_bot:false},...extra}});
  async function pair(){await tg.connect(token);const secret=new URL(tg.view().pairingUrl!).searchParams.get('start');await tg.receive(message(1,`/start ${secret}`));tg.confirm(String(owner));store.db.prepare('DELETE FROM outbox').run();}
  return {root,store,router,approvals,binding,tg,calls,message,pair,updates:(rows:any[])=>{queuedUpdates=rows;},file:(data:Buffer)=>{fileData=data;},fail:(n:number)=>{fail=n;},webhook:(s:string)=>{webhook=s;},botId:(n:number)=>{botId=n;},close:()=>{tg.close();approvals.cancel();store.close();rmSync(root,{recursive:true,force:true});}};
}

test('Telegram pairing is private, expires, and requires exact local account confirmation',async()=>{
  const f=fixture();try{
    await f.tg.connect(token);const secret=new URL(f.tg.view().pairingUrl!).searchParams.get('start');
    await f.tg.receive(f.message(1,`/start ${secret}`,owner,{chat:{id:owner,type:'group'}}));assert.equal(f.tg.view().candidate,undefined);
    await f.tg.receive(f.message(2,'/start wrong'));assert.equal(f.tg.view().candidate,undefined);
    await f.tg.receive(f.message(3,`/start ${secret}`));assert.equal(f.store.get('telegram-owner'),undefined);assert.equal(f.store.jobs().length,0);
    await f.tg.receive(f.message(4,`/start ${secret}`,other));assert.equal(f.tg.view().candidate?.id,owner);
    assert.throws(()=>f.tg.confirm(other),/expired|changed/);
    f.tg.confirm(owner);assert.equal(f.store.get('telegram-owner'),telegramDestination(bot,owner));assert.equal(f.tg.view().pairingUrl,undefined);
    assert.ok(!JSON.stringify(f.tg.view()).includes(token));
    assert.equal(readFileSync(join(f.root,'telegram-token'),'utf8'),token);
    if(process.platform!=='win32')assert.equal(statSync(join(f.root,'telegram-token')).mode&0o777,0o600);
  }finally{f.close();}
});
test('expired pairing never authorizes a sender',async()=>{
  const f=fixture();try{await f.tg.connect(token);const secret=new URL(f.tg.view().pairingUrl!).searchParams.get('start');(f.tg as any).pairing.expires=0;await f.tg.receive(f.message(1,`/start ${secret}`));assert.throws(()=>f.tg.confirm(owner));assert.equal(f.store.get('telegram-owner'),undefined);assert.equal(f.tg.view().status,'pairing expired');}finally{f.close();}
});
test('unknown senders, bots, groups and edited updates cannot dispatch; duplicates dispatch once',async()=>{
  const f=fixture();try{await f.pair();
    await f.tg.receive(f.message(2,'attack',other));await f.tg.receive(f.message(3,'attack',owner,{from:{id:owner,is_bot:true}}));await f.tg.receive({edited_message:f.message(4,'edit').message});
    await f.tg.receive(f.message(5,'old',owner,{date:1}));assert.equal(f.store.jobs().length,0);
    await f.tg.receive(f.message(6,'Check my project'));await f.tg.receive(f.message(6,'Check my project'));
    assert.equal(f.store.jobs().length,1);assert.equal(f.store.jobs()[0].destination,telegramDestination(bot,owner));
    f.store.set('control-channel','whatsapp');await f.tg.receive(f.message(7,'ignored'));assert.equal(f.store.jobs().length,1);
    f.store.set('control-channel','telegram');f.router.stopped=true;await f.tg.receive(f.message(8,'paused'));assert.equal(f.store.jobs().length,1);
  }finally{f.close();}
});
test('reply delivery and quoted follow-up stay in the exact bot chat, isolated from WhatsApp',async()=>{
  const f=fixture();try{await f.pair();const dest=telegramDestination(bot,owner);
    f.store.set('whatsapp-owner','wa@s.whatsapp.net');f.store.output(f.binding,'WA only','wa-out','wa@s.whatsapp.net');
    f.store.output(f.binding,'**Ready** <unsafe>','tg-out',dest);assert.equal(f.store.outbound().source,'wa-out:0');
    await f.tg.flush();const sent=f.store.db.prepare("SELECT * FROM outbox WHERE source='tg-out:0'").get() as any;
    assert.equal(sent.status,'sent');assert.equal(sent.wa_id,telegramMessageId(bot,owner,10));assert.equal(sent.delivered_at,null);assert.equal(sent.read_at,null);
    assert.equal(f.store.outbound('telegram'),undefined);assert.equal(f.store.outbound().source,'wa-out:0');
    await f.tg.receive(f.message(22,'continue',owner,{reply_to_message:{message_id:10,from:{id:bot}}}));assert.equal(f.store.jobs()[0].binding_id,f.binding.id);
  }finally{f.close();}
});
test('network-uncertain send is held, never replayed; errors never include the token',async()=>{
  const f=fixture();try{await f.pair();f.fail(1);f.store.output(f.binding,'answer','out',telegramDestination(bot,owner));await f.tg.flush();await f.tg.flush();
    const rows=f.store.db.prepare('SELECT * FROM outbox').all() as any[];assert.equal(rows[0].status,'uncertain');assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,1);assert.ok(!JSON.stringify([rows,f.tg.view()]).includes(token));
  }finally{f.close();}
});
test('only explicit rate rejection retries with backoff; blocked bot fails without retry',async()=>{
  const f=fixture();try{await f.pair();f.fail(429);f.store.output(f.binding,'answer','out',telegramDestination(bot,owner));await f.tg.flush();let row=f.store.outbound('telegram');assert.equal(row,undefined);
    const stored=f.store.db.prepare('SELECT * FROM outbox').get() as any;assert.equal(stored.status,'queued');assert.ok(stored.next_at>Date.now());
    f.store.db.prepare('UPDATE outbox SET next_at=0').run();f.fail(403);await f.tg.flush();assert.equal(f.store.db.prepare('SELECT status FROM outbox').get()?.status,'failed');
  }finally{f.close();}
});
test('restart holds in-flight Telegram delivery without changing WhatsApp queued rows',async()=>{
  const f=fixture();try{f.store.output(undefined,'a','a','tg:123:777');f.store.output(undefined,'b','b','owner@s.whatsapp.net');f.store.db.prepare("UPDATE outbox SET status='sending' WHERE destination LIKE 'tg:%'").run();f.store.recover();assert.equal(f.store.db.prepare("SELECT status FROM outbox WHERE source='a:0'").get()?.status,'uncertain');assert.equal(f.store.outbound().source,'b:0');}finally{f.close();}
});
test('disconnect removes token and owner; previous destination never migrates to a different owner',async()=>{
  const f=fixture();try{await f.pair();f.store.output(f.binding,'private','old',telegramDestination(bot,other));await f.tg.flush();assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,0);assert.equal(f.store.db.prepare('SELECT status FROM outbox').get()?.status,'failed');f.tg.disconnect();assert.equal(f.store.get('telegram-owner'),undefined);assert.throws(()=>readFileSync(join(f.root,'telegram-token')));}finally{f.close();}
});
test('webhook ownership and changing bots require explicit resolution without deleting webhooks',async()=>{
  const f=fixture();try{f.webhook('https://example.invalid/hook');await assert.rejects(f.tg.connect(token),/webhook/);assert.equal(f.store.get('telegram-bot-id'),undefined);f.webhook('');await f.pair();f.botId(987654);await assert.rejects(f.tg.connect(token),/Disconnect/);assert.ok(!f.calls.some(c=>c.method==='deleteWebhook'));}finally{f.close();}
});
test('token file cannot overwrite a symlink target',async()=>{
  if(process.platform==='win32')return;
  const f=fixture();try{const target=join(f.root,'other');writeFileSync(target,'keep');symlinkSync(target,join(f.root,'telegram-token'));await assert.rejects(f.tg.connect(token));assert.equal(readFileSync(target,'utf8'),'keep');}finally{f.close();}
});
test('permission responses are bound to the original chat and reject voice decisions',async()=>{
  const f=fixture();try{await f.pair();const dest=telegramDestination(bot,owner);const answer=f.store.destinationContext.run(dest,()=>f.approvals.ask(f.binding,'Write this file?'));await f.tg.flush();const row=f.store.db.prepare("SELECT wa_id FROM outbox WHERE source LIKE 'permission:%'").get() as any;
    f.store.destinationContext.run('someone@s.whatsapp.net',()=>assert.throws(()=>f.approvals.naturalReply('Yes, allow it',row.wa_id),/original chat/));
    f.store.destinationContext.run(dest,()=>assert.throws(()=>f.approvals.naturalReply('Yes, allow it',row.wa_id,'voice'),/type/));
    f.store.destinationContext.run(dest,()=>f.approvals.naturalReply('Yes, allow it',row.wa_id));assert.equal(await answer,'approve');
  }finally{f.close();}
});
test('Telegram artifacts retain request ownership across channel selection and reject oversized uploads',async()=>{
  const f=fixture();try{await f.pair();await f.tg.receive(f.message(2,'file'));const job=f.store.jobs()[0],a=new Artifacts(f.store,f.root);f.store.set('whatsapp-owner','wa@s.whatsapp.net');f.store.set('control-channel','whatsapp');
    const file=a.prepare(f.binding,job.id,'hello.txt',Buffer.from('hello').toString('base64'));a.reply(f.binding,job.id,file.artifactId,'Here');await f.tg.flush();const doc=f.calls.find(c=>c.method==='sendDocument');assert.ok(doc);assert.equal(doc.body.get('chat_id'),String(owner));
    assert.throws(()=>a.disk.reserve(f.binding,job.id,{filename:'large.txt',bytes:50_000_001,sha256:'a'.repeat(64)}),/50 MB/);
  }finally{f.close();}
});
test('Telegram HTML escapes markup and keeps simple emphasis',()=>{
  assert.equal(telegramHTML('*Ready* <script>&'),'<b>Ready</b> &lt;script&gt;&amp;');
});

async function mediaSettled(tg:Telegram){for(let i=0;i<200&&(tg as any).media.size;i++)await new Promise(r=>setTimeout(r,2));assert.equal((tg as any).media.size,0);}
test('Telegram file receipt stages validated bytes once and retains attachment ownership',async()=>{
 const f=fixture();try{await f.pair();const data=Buffer.from('Project status');f.file(data);
 const m=f.message(31,'',owner,{document:{file_id:'file1',file_size:data.length,file_name:'status.txt'},caption:'Summarize this'});
 await f.tg.receive(m);await mediaSettled(f.tg);await f.tg.receive(m);await mediaSettled(f.tg);
 const id=telegramMessageId(bot,owner,31);assert.equal(f.store.jobs().length,1);assert.equal(f.router.attachments.references(f.binding,id).length,1);assert.equal(f.calls.filter(c=>c.method==='getFile').length,1);
 }finally{f.close();}
});
test('oversized Telegram downloads fail before getFile without queuing work',async()=>{
 const f=fixture();try{await f.pair();await f.tg.receive(f.message(32,'',owner,{document:{file_id:'file1',file_size:20_000_001,file_name:'status.txt'}}));await mediaSettled(f.tg);assert.equal(f.store.jobs().length,0);assert.equal(f.calls.filter(c=>c.method==='getFile').length,0);assert.ok(f.store.db.prepare("SELECT 1 FROM outbox WHERE source LIKE 'telegram-media-error:%'").get());}finally{f.close();}
});
test('Telegram voice uses shared transcription without blocking text and never accepts a voice approval',async()=>{
 const f=fixture();try{await f.pair();let finish!:(s:string)=>void;
 f.tg.transcribe=async()=>await new Promise<string>(r=>{finish=r;});
 await f.tg.receive(f.message(40,'',owner,{voice:{file_id:'voice1',file_size:10,duration:2,mime_type:'audio/ogg'}}));
 await f.tg.receive(f.message(41,'Check the app'));assert.equal(f.store.jobs().length,1);
 finish('/approve deadbeef');await mediaSettled(f.tg);assert.equal(f.store.jobs().length,1);
 }finally{f.close();}
});
test('Telegram polling resumes from the durable update offset and does not replay a request',async()=>{
 const f=fixture();try{await f.pair();f.tg.close();f.updates([f.message(54,'Check progress')]);await f.tg.resume();
 for(let i=0;i<50&&!f.store.get('telegram-offset:'+bot);i++)await new Promise(r=>setTimeout(r,2));
 assert.equal(f.store.get('telegram-offset:'+bot),'55');assert.equal(f.store.jobs().length,1);
 f.tg.close();await f.tg.resume();assert.equal(f.calls.filter(c=>c.method==='getUpdates').at(-1)?.body.offset,55);assert.equal(f.store.jobs().length,1);
 }finally{f.close();}
});

test('Telegram coordinator requests support eligibility, reply correlation and final resolution',async()=>{
 const f=fixture();try{await f.pair();f.store.set('master',f.binding.id);f.router.coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});
 const dest=telegramDestination(bot,owner),id=telegramMessageId(bot,owner,61);
 f.store.enqueue(id,f.binding,'Check the project',dest);assert.equal(f.router.coordinator.ownerRequest(id).id,id);
 // Direct coordinator final must remain correlated to Telegram and resolve normally.
 const result=f.router.channelReply(f.binding,'Verified done','final',id,'telegram-final');assert.ok(result);assert.equal(f.store.job(id)?.status,'completed');
 const row=f.store.db.prepare("SELECT destination FROM outbox WHERE request_id=?").get(id) as any;assert.equal(row.destination,dest);
 assert.throws(()=>f.router.coordinator!.ownerRequest(id),/closed/);
 const second=telegramMessageId(bot,owner,63);f.store.enqueue(second,f.binding,'Another task',dest);f.router.resolveOwner(second,'done');assert.equal(f.store.job(second)?.outcome,'done');
 }finally{f.close();}
});
test('Telegram active-work summaries preserve the chat and suppress unchanged repeats',async()=>{
 const f=fixture();try{await f.pair();f.store.set('master',f.binding.id);f.router.coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});
 const now=Date.now();initializeCoordinatorUpdates(f.store,now-2*COORDINATOR_UPDATE_INTERVAL_MS);
 const dest=telegramDestination(bot,owner),id=telegramMessageId(bot,owner,62);f.store.enqueue(id,f.binding,'Check project',dest);
 f.store.db.prepare('UPDATE inbox SET created_at=?,updated_at=? WHERE id=?').run(now-COORDINATOR_UPDATE_INTERVAL_MS-100,now-COORDINATOR_UPDATE_INTERVAL_MS-100,id);
 assert.equal(queueCoordinatorUpdates(f.store,f.router,now),1);assert.equal(f.store.outbound('telegram').destination,dest);
 assert.equal(queueCoordinatorUpdates(f.store,f.router,now+2*COORDINATOR_UPDATE_INTERVAL_MS),0);
 }finally{f.close();}
});

test('long emoji replies stay within Telegram text limits without breaking surrogate pairs',()=>{
 const f=fixture();try{f.store.output(f.binding,'😀'.repeat(5000),'emoji',telegramDestination(bot,owner));
 const rows=f.store.db.prepare('SELECT body FROM outbox ORDER BY rowid').all() as {body:string}[];assert.ok(rows.length>1);
 for(const row of rows){assert.ok(row.body.length<=4096);assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(row.body));}
 }finally{f.close();}
});

test('inline keyboard callbacks bind owner, exact message and choice, and dispatch once',async()=>{
 const f=fixture();try{await f.pair();const dest=telegramDestination(bot,owner);
 f.store.enqueue('choice-request',f.binding,'Inspect',dest);
 f.router.channelReply(f.binding,'What next?','progress','choice-request','choices',{options:{choices:[{id:'a',label:'Inspect'},{id:'b',label:'Wait'}],expiresInSeconds:60}});
 await f.tg.flush();const send=f.calls.find(c=>c.method==='sendMessage')!;
 const data=send.body.reply_markup.inline_keyboard[0][0].callback_data;
 assert.ok(Buffer.byteLength(data)<=64);
 const callback=(id:string,user=owner,msg=10)=>({callback_query:{id,data,from:{id:user},message:{message_id:msg,chat:{type:'private',id:owner},from:{id:bot}}}});
 await f.tg.receive(callback('spoof',other));assert.equal(f.store.jobs().length,1);
 await f.tg.receive(callback('wrong-message',owner,900));assert.equal(f.store.jobs().length,1);
 await f.tg.receive(callback('tap'));await f.tg.receive(callback('tap-again'));
 assert.equal(f.store.jobs().length,2);assert.match(f.store.job(`tg-choice:${bot}:tap`)!.body,/Inspect/);
 assert.ok(f.calls.some(c=>c.method==='answerCallbackQuery'));
 }finally{f.close();}
});
