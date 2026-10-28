import { MetaBrain } from '../src/meta-brain.js';
import { MetaSecret, DEFAULT_BRAIN } from '../src/meta-brain-config.js';
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
    if(method==='setMyCommands')return Response.json({ok:true,result:true});
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
  return {root,store,router,approvals,binding,tg,calls,message,pair,fetcher,updates:(rows:any[])=>{queuedUpdates=rows;},file:(data:Buffer)=>{fileData=data;},fail:(n:number)=>{fail=n;},webhook:(s:string)=>{webhook=s;},botId:(n:number)=>{botId=n;},close:()=>{tg.close();approvals.cancel();store.close();rmSync(root,{recursive:true,force:true});}};
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

test('command menu and bot suffixes preserve existing commands and reject other bots',async()=>{
  const f=fixture();try{
    await f.pair();const menu=f.calls.find(c=>c.method==='setMyCommands')!.body;
    assert.deepEqual(menu.scope,{type:'all_private_chats'});
    assert.deepEqual(menu.commands.map((c:any)=>c.command),['claude','codex','brain','screen','back','help','sessions','status']);
    await f.tg.receive(f.message(90,'/codex@other_bot'));assert.equal(f.store.jobs().length,0);
    await f.tg.receive(f.message(91,'/codex@FFD_TEST_BOT'));
    await f.tg.receive(f.message(92,'hello exact session'));assert.equal(f.store.job(telegramMessageId(bot,owner,92))?.binding_id,f.binding.id);
    await f.tg.receive(f.message(93,'/help@ffd_test_bot'));
    assert.ok((f.store.db.prepare('SELECT body FROM outbox').all() as any[]).some(r=>r.body.includes('Current target: test (codex)')));
    const target=f.store.get(`owner-target:${telegramDestination(bot,owner)}`);
    await f.tg.receive(f.message(96,'/cloud'));assert.equal(f.store.get(`owner-target:${telegramDestination(bot,owner)}`),target);
    await f.tg.receive(f.message(94,'/back'));await f.tg.receive(f.message(95,'/status@ffd_test_bot'));
    assert.equal(f.store.get(`owner-target:${telegramDestination(bot,owner)}`),'null');
  }finally{f.close();}
});

test('only authenticated unquoted top-level commands switch routes or open the viewer',async()=>{
  const f=fixture();try{
    await f.pair();let screens=0;f.router.remoteControl=async text=>{if(text!=='/remote')return; screens++;return 'Viewer requires setup';};
    await f.tg.receive(f.message(90,'/screen',other));
    for(const [i,extra] of [{forward_origin:{type:'user'}},{reply_to_message:{message_id:88,from:{id:owner}}},{quote:{text:'/screen'}},{via_bot:{id:other}}].entries())await f.tg.receive(f.message(91+i,'/screen',owner,extra));
    assert.equal(screens,0);
    await f.tg.receive(f.message(99,'/screen'));await f.tg.receive(f.message(99,'/screen'));assert.equal(screens,1);
    const dest=telegramDestination(bot,owner);
    await f.store.destinationContext.run(dest,()=>f.router.receive({id:'report:spoof',text:'/codex',ownerCommand:true}));
    assert.equal(f.store.get(`owner-target:${dest}`),undefined);
  }finally{f.close();}
});

test('Claude aliases offer stable choices and never substitute paused or changed connections',async()=>{
  const f=fixture();try{
    await f.pair();const a=f.store.register('claude-app','claude','22222222-2222-4222-8222-222222222222',f.root,'channel').binding;
    const b=f.store.register('claude-cli','claude','33333333-3333-4333-8333-333333333333',f.root,'channel').binding;
    f.store.set('selected',JSON.stringify([a.id,b.id]));
    await f.tg.receive(f.message(90,'/claude'));assert.equal(f.store.jobs().length,0);
    await f.tg.receive(f.message(91,'/claude 2'));await f.tg.receive(f.message(92,'Check this task'));
    assert.equal(f.store.job(telegramMessageId(bot,owner,92))?.binding_id,b.id);
    assert.equal(f.store.job(telegramMessageId(bot,owner,92))?.destination,telegramDestination(bot,owner));
    f.store.enable(b.id,false);await f.tg.receive(f.message(93,'Do not fall back'));assert.equal(f.store.job(telegramMessageId(bot,owner,93)),undefined);
    f.store.enable(b.id,true);f.store.set(`execution-mode:${b.id}`,'desktop');await f.tg.receive(f.message(94,'Changed runtime'));assert.equal(f.store.job(telegramMessageId(bot,owner,94)),undefined);
    f.store.set('enabled-apps','["codex"]');await f.tg.receive(f.message(95,'/claude'));assert.equal(f.store.bindings().length,3);
    assert.ok((f.store.db.prepare('SELECT body FROM outbox').all() as any[]).some(r=>r.body.includes('Claude is disabled')));
    await f.tg.receive(f.message(96,'/back'));await f.tg.receive(f.message(97,'Normal again'));assert.equal(f.store.job(telegramMessageId(bot,owner,97))?.binding_id,f.binding.id);
  }finally{f.close();}
});

test('direct target replies remain request scoped and choices cannot cross owners',async()=>{
  const f=fixture();try{
    await f.pair();await f.tg.receive(f.message(90,'/codex'));await f.tg.receive(f.message(91,'Describe the result'));
    const id=telegramMessageId(bot,owner,91),dest=telegramDestination(bot,owner);
    f.router.channelReply(f.binding,'The requested result','final',id);
    const reply=f.store.db.prepare('SELECT destination FROM outbox WHERE request_id=?').get(id) as any;assert.equal(reply.destination,dest);
    f.store.set('telegram-owner',telegramDestination(bot,other));f.store.set('telegram-user-id',String(other));
    await f.tg.receive(f.message(92,'/codex 1',other));assert.equal(f.store.job(telegramMessageId(bot,other,92)),undefined);
    assert.equal(f.store.get(`owner-target:${telegramDestination(bot,other)}`),undefined);
  }finally{f.close();}
});

test('brain mode requires enabled configured Meta and blocks model failures even with legacy fallback',async()=>{
  const f=fixture();try{
    await f.pair();f.store.set('master',f.binding.id);
    f.router.coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});
    const secret=new MetaSecret(f.root);let interpretations=0;
    f.router.brain=new MetaBrain(f.store,secret,{interpret:async()=>{interpretations++;throw Error('Synthetic offline');}});
    await f.tg.receive(f.message(90,'/brain'));assert.equal(f.store.get(`owner-target:${telegramDestination(bot,owner)}`),undefined);
    f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:['codex'],failure:'legacy'}));
    await f.tg.receive(f.message(91,'/brain'));assert.equal(f.store.get(`owner-target:${telegramDestination(bot,owner)}`),undefined);
    secret.save('synthetic-meta-key-123456789');await f.tg.receive(f.message(92,'/brain'));
    await f.tg.receive(f.message(93,'Investigate the custom rendering bug'));assert.equal(interpretations,1);assert.equal(f.store.job(telegramMessageId(bot,owner,93)),undefined);
    assert.equal(f.router.brain.get(telegramMessageId(bot,owner,93))?.state,'blocked');
    secret.remove();await f.tg.receive(f.message(94,'Do not fall back when key removed'));assert.equal(f.store.job(telegramMessageId(bot,owner,94)),undefined);
    const rows=(f.store.db.prepare('SELECT body FROM outbox').all() as any[]).map(r=>r.body).join('\n');assert.match(rows,/disabled/);assert.match(rows,/needs an API key/);
  }finally{f.close();}
});

test('screen entry reports unavailable, setup, locked or authenticated viewer responses without changing routing',async()=>{
  const f=fixture();try{
    await f.pair();await f.tg.receive(f.message(90,'/codex'));const key=`owner-target:${telegramDestination(bot,owner)}`,target=f.store.get(key);
    await f.tg.receive(f.message(91,'/screen'));
    for(const [i,reply] of ['Set a remote password first.','Mac is locked. Unlock it first.','Native permissions are missing. Check Mac control.','Open https://viewer.example.invalid/#offer=test then enter your remote password.'].entries()){
      f.router.remoteControl=async text=>text==='/remote'?reply:undefined;
      await f.tg.receive(f.message(92+i,'/screen'));
      assert.ok((f.store.db.prepare('SELECT body FROM outbox').all() as any[]).some(r=>r.body.includes(reply)),JSON.stringify(f.store.db.prepare('SELECT body FROM outbox').all()));
    }
    assert.equal(f.store.get(key),target);assert.equal(f.store.jobs().length,0);
  }finally{f.close();}
});

test('selected target applies to files and mode changes invalidate an in-flight file target',async()=>{
  const f=fixture();try{
    await f.pair();const claude=f.store.register('claude-file','claude','22222222-2222-4222-8222-222222222222',f.root,'channel').binding;
    f.store.set('selected',JSON.stringify([claude.id]));await f.tg.receive(f.message(90,'/claude'));
    const destination=telegramDestination(bot,owner),m={id:telegramMessageId(bot,owner,91),text:'Review this file',ownerCommand:false};
    const target=f.store.destinationContext.run(destination,()=>f.router.attachmentTarget(m));assert.equal(target.binding.id,claude.id);
    await f.tg.receive(f.message(92,'/codex'));
    const changed=f.store.destinationContext.run(destination,()=>f.router.attachmentTarget(m));assert.notEqual(changed.identity,target.identity);assert.equal(changed.binding.id,f.binding.id);
  }finally{f.close();}
});


test('quoted Telegram question accepts a slash-prefixed path exactly once',async()=>{
 const f=fixture();try{
  await f.pair();const dest=telegramDestination(bot,owner);let result:string|undefined;
  void f.store.destinationContext.run(dest,()=>f.approvals.ask(f.binding,'Which folder?','question')).then(v=>{result=v;});
  f.store.db.prepare("UPDATE outbox SET status='sent',wa_id=? WHERE source LIKE 'permission:%'").run(telegramMessageId(bot,owner,400));
  const m=f.message(401,'/Users/me/project',owner,{reply_to_message:{message_id:400,from:{id:bot}}});
  await f.tg.receive(m);await f.tg.receive(m);
  assert.equal(result,'/Users/me/project');assert.equal(f.approvals.pending.size,0);assert.equal(f.store.jobs().length,0);
 }finally{f.close();}
});

test('Telegram owner voice keeps screen, back, session browsing and selection intent',async()=>{
 const f=fixture();try{
  await f.pair();let text='',screens=0,lists=0,selected='';
  f.tg.transcribe=async()=>text;f.router.remoteControl=async t=>t==='control my screen'?(screens++,'Synthetic screen link'):undefined;
  let id=500;const voice=async(value:string,extra:any={})=>{text=value;await f.tg.receive(f.message(id++,'',owner,{voice:{file_id:'voice',file_size:10,duration:2,mime_type:'audio/ogg'},...extra}));await mediaSettled(f.tg);};
  await voice('control my screen');assert.equal(screens,1);assert.equal(f.store.jobs().length,0);
  await f.tg.receive(f.message(600,'/talk test'));await voice('back');assert.equal(f.store.get(`direct:${telegramDestination(bot,owner)}`),undefined);
  await f.tg.receive(f.message(601,'/codex'));await voice('back');assert.equal(f.store.get(`owner-target:${telegramDestination(bot,owner)}`),'null');
  const c=new Coordinator(f.store,f.router.native,f.router,()=>{});f.router.coordinator=c;
  c.list=async()=>{lists++;return '1. Synthetic session';};c.select=async value=>{selected=value;return 'Selected';};
  await voice('show my sessions');assert.equal(lists,1);
  f.store.set('selection-awaiting','true');await voice('1');assert.equal(selected,'1');assert.equal(f.store.jobs().length,0);
 }finally{f.close();}
});

test('Telegram forwarded or quoted voice cannot open screen control and spoken slash commands stay blocked',async()=>{
 const f=fixture();try{
  await f.pair();let screens=0,text='control my screen';f.router.remoteControl=async()=>{screens++;return 'Unexpected screen link';};f.tg.transcribe=async()=>text;
  for(const [i,extra] of [{forward_origin:{type:'user'}},{reply_to_message:{message_id:77,from:{id:owner}}},{quote:{text:'quoted'}}].entries()){
   await f.tg.receive(f.message(700+i,'',owner,{voice:{file_id:'voice',file_size:10,duration:2,mime_type:'audio/ogg'},...extra}));await mediaSettled(f.tg);
  }
  text='/screen';await f.tg.receive(f.message(710,'',owner,{voice:{file_id:'voice',file_size:10,duration:2,mime_type:'audio/ogg'}}));await mediaSettled(f.tg);assert.equal(screens,0);
 }finally{f.close();}
});


test('pending Telegram link and candidate survive reconnect and a new client without extending expiry',async()=>{
 const f=fixture();let restarted:Telegram|undefined;try{
  await f.tg.connect(token);const first=f.tg.view();const secret=new URL(first.pairingUrl!).searchParams.get('start');
  await f.tg.connect();assert.equal(f.tg.view().pairingUrl,first.pairingUrl);assert.equal(f.tg.view().expiresAt,first.expiresAt);
  await f.tg.receive(f.message(801,`/start ${secret}`));assert.equal(f.tg.view().candidate?.id,owner);
  f.tg.close();restarted=new Telegram(f.store,f.router,f.root,f.fetcher);await restarted.resume();
  assert.equal(restarted.view().pairingUrl,first.pairingUrl);assert.equal(restarted.view().expiresAt,first.expiresAt);assert.equal(restarted.view().candidate?.id,owner);
  assert.equal(f.store.get('telegram-owner'),undefined);restarted.confirm(owner);assert.equal(f.store.get('telegram-pairing'),undefined);
 }finally{restarted?.close();f.close();}
});

test('unpaired Telegram gives safe feedback for stale and bare start without pairing or routing',async()=>{
 const f=fixture();try{
  await f.tg.connect(token);const first=f.tg.view().pairingUrl;f.calls.length=0;
  await f.tg.receive(f.message(810,'/start stale'));await f.tg.receive(f.message(810,'/start stale'));await f.tg.receive(f.message(811,'/start'));
  assert.deepEqual(f.calls.filter(c=>c.method==='sendMessage').map(c=>c.body.text),[
   'This pairing link is out of date. Open the newest link from the FarFromDesk app.',
   'Open the pairing link from the FarFromDesk app.',
  ]);
  assert.equal(f.tg.view().pairingUrl,first);assert.equal(f.tg.view().candidate,undefined);assert.equal(f.store.get('telegram-owner'),undefined);assert.equal(f.store.jobs().length,0);
  const secret=new URL(first!).searchParams.get('start');
  await f.tg.receive(f.message(812,`/start ${secret}`,owner,{forward_origin:{type:'user'}}));assert.equal(f.tg.view().candidate,undefined);
  await f.tg.receive(f.message(813,`/start ${secret}`));assert.equal(f.tg.view().candidate?.id,owner);
 }finally{f.close();}
});

test('expired, disconnected and foreign-bot pending links cannot be restored',async()=>{
 const f=fixture();try{
  await f.tg.connect(token);const first=f.tg.view().pairingUrl!;
  const saved=JSON.parse(f.store.get('telegram-pairing')!);saved.expires=0;f.store.set('telegram-pairing',JSON.stringify(saved));f.tg.close();
  const restarted=new Telegram(f.store,f.router,f.root,f.fetcher);
  try{
   await restarted.resume();assert.notEqual(restarted.view().pairingUrl,first);
   await restarted.receive(f.message(820,'/start '+new URL(first).searchParams.get('start')));assert.equal(restarted.view().candidate,undefined);
   const second=restarted.view().pairingUrl;restarted.disconnect();assert.equal(f.store.get('telegram-pairing'),undefined);
   await restarted.connect(token);assert.notEqual(restarted.view().pairingUrl,second);
   restarted.close();const record=JSON.parse(f.store.get('telegram-pairing')!);record.botId=other;f.store.set('telegram-pairing',JSON.stringify(record));
   const third=restarted.view().pairingUrl;await restarted.resume();assert.notEqual(restarted.view().pairingUrl,third);
  }finally{restarted.close();}
 }finally{f.close();}
});
