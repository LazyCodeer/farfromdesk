import './brain-fixture-isolation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,chmodSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store,hash} from '../src/store.js';
import {Router} from '../src/router.js';
import {Approvals} from '../src/approvals.js';
import {turnEnvelope,specialistDocument} from '../src/roles.js';
import {sessionSpecialty} from '../src/session-specialty.js';
import {sessionResearchRequest} from '../src/session-research.js';
import {SocialAssistant} from '../src/social-assistant.js';
import {saveSessionSocialDrafts} from '../src/social-session-drafts.js';
import {GuidedModes} from '../src/guided-modes.js';
import {dispatchDesktopSocial,socialImageProvider} from '../src/desktop-social.js';
import {DEFAULT_BRAIN} from '../src/meta-brain-config.js';
import {renderSessionSocialImage} from '../src/social-session-image.js';
import sharp from 'sharp';

function fixture(channel:'whatsapp'|'telegram',provider:'claude'|'codex') {
  const root=mkdtempSync(join(tmpdir(),'ffd-social-session-')),s=new Store(':memory:'),a=new Approvals(s);
  const r=new Router(s,{run:async()=>{},stop:()=>{},warmDesktop:()=>{}} as any,a);
  const owner=channel==='telegram'?'tg:123':'123@s.whatsapp.net';
  s.set('control-channel',channel);s.set(channel==='telegram'?'telegram-owner':'whatsapp-owner',owner);
  const b=s.register('social-test',provider,randomUUID(),root).binding;s.set('active',b.id);r.pump=()=>{};
  const id=(n:string)=>channel==='telegram'?`${owner}:${n}`:`wa:${n}`;
  const send=(n:string,text:string)=>s.destinationContext.run(owner,()=>r.receive({id:id(n),text,ownerCommand:true,ownerIntent:true}));
  const latest=()=>s.db.prepare('SELECT body FROM outbox ORDER BY rowid DESC LIMIT 1').get() as {body:string}|undefined;
  return {root,s,a,r,b,owner,id,send,latest,close(){a.cancel();s.close();rmSync(root,{recursive:true,force:true});}};
}

test('Social asks for a brief then queues the exact selected Claude or Codex session',async()=>{
  for(const channel of ['whatsapp','telegram'] as const)for(const provider of ['claude','codex'] as const){
    const f=fixture(channel,provider);try {
      assert.equal((await f.send('1','/social')).status,'handled');
      assert.match(f.latest()?.body??'',/posts about.*platforms/i);
      const text='Create Instagram and LinkedIn drafts about a new product';
      assert.equal((await f.send('2',text)).status,'queued');
      const id=f.id('2');assert.equal(f.s.job(id)?.body,text);assert.equal(f.s.job(id)?.binding_id,f.b.id);
      assert.equal(sessionSpecialty(f.s,id)?.kind,'social');
      const envelope=turnEnvelope(f.s,f.b,text,id,{},[],f.root,true).body;
      assert.match(envelope,/Agent: farfromdesk-social/);assert.match(envelope,/Mode Social/);assert.doesNotMatch(envelope,/Social content specialist/);
      const guide=readFileSync(specialistDocument(f.s,f.b,id,f.root).file,'utf8');assert.match(guide,/ask a short question/i);assert.match(guide,/never post, publish/i);assert.match(guide,/video scripts.*not finished media/i);
      assert.equal(f.s.get(`reach-owner-request:${id}`),undefined);
      await f.send('2',text);assert.equal(f.s.jobs().length,1);
    }finally{f.close();}
  }
});

test('Social preserves exact-session identity and refuses a changed selection',async()=>{
  const f=fixture('telegram','codex');try {
    const text='/social create LinkedIn drafts about developer tools';await f.send('1',text);const id=f.id('1');
    assert.equal(sessionSpecialty(f.s,id)?.kind,'social');
    f.s.set('active','changed');f.s.set('active',f.b.id);
    assert.equal(sessionSpecialty(f.s,id),undefined);
    assert.throws(()=>turnEnvelope(f.s,f.b,text,id,{},[],f.root,true),/changed/i);
  }finally{f.close();}
});

test('a Social follow-up never switches to another selected session',async()=>{
  const f=fixture('telegram','codex');try {
    assert.equal((await f.send('1','/social create Instagram drafts')).status,'queued');
    const other=f.s.register('other','claude',randomUUID(),f.root).binding;
    f.s.set('active',other.id);
    assert.equal((await f.send('2','The topic is developer tools')).status,'blocked');
    assert.equal(f.s.job(f.id('2')),undefined);
    assert.match(f.latest()?.body??'',/session changed/i);
  }finally{f.close();}
});

test('a Social clarification continues in the same session after mode reload',async()=>{
  const f=fixture('telegram','claude');try {
    assert.equal((await f.send('1','/social create posts')).status,'queued');
    f.r.guidedModes=new GuidedModes();
    assert.equal((await f.send('2','About developer tools for LinkedIn')).status,'queued');
    assert.equal(f.s.job(f.id('2'))?.binding_id,f.b.id);
    assert.equal(sessionSpecialty(f.s,f.id('2'))?.kind,'social');
  }finally{f.close();}
});

test('a saved Social mode survives closing and reopening the bridge database',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ffd-social-reopen-')),path=join(root,'state.sqlite'),owner='tg:123';
  let store=new Store(path),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
  try {
    store.set('control-channel','telegram');store.set('telegram-owner',owner);
    const binding=store.register('social-reopen','codex',randomUUID(),root).binding;store.set('active',binding.id);router.pump=()=>{};
    assert.equal((await store.destinationContext.run(owner,()=>router.receive({id:`${owner}:1`,text:'/social create posts',ownerCommand:true,ownerIntent:true}))).status,'queued');
    approvals.cancel();store.close();
    store=new Store(path);approvals=new Approvals(store);router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);router.pump=()=>{};
    assert.equal((await store.destinationContext.run(owner,()=>router.receive({id:`${owner}:2`,text:'For LinkedIn about developer tools',ownerCommand:true,ownerIntent:true}))).status,'queued');
    assert.equal(store.job(`${owner}:2`)?.binding_id,binding.id);
    assert.equal(sessionSpecialty(store,`${owner}:2`)?.kind,'social');
  }finally{approvals.cancel();store.close();rmSync(root,{recursive:true,force:true});}
});

test('a restored Social clarification refuses an intervening session change',async()=>{
  const f=fixture('telegram','claude');try {
    await f.send('1','/social create posts');
    const other=f.s.register('other','codex',randomUUID(),f.root).binding;
    f.s.set('active',other.id);f.r.guidedModes=new GuidedModes();
    assert.equal((await f.send('2','About developer tools for LinkedIn')).status,'blocked');
    assert.equal(f.s.job(f.id('2')),undefined);
  }finally{f.close();}
});

test('phone follow-up to a desktop request stays with the explicitly selected session',async()=>{
  const f=fixture('telegram','codex');try {
    const chosen=f.s.register('desktop-picked','claude',randomUUID(),f.root).binding;
    const request=dispatchDesktopSocial(f.s,f.r,{bindingId:chosen.id,prompt:'Create posts about developer tools',platforms:['LinkedIn'],eventId:randomUUID()});
    assert.equal(f.s.job(request.requestId)?.binding_id,chosen.id);
    assert.equal((await f.send('2','Use a friendly tone')).status,'queued');
    assert.equal(f.s.job(f.id('2'))?.binding_id,chosen.id);
    assert.equal(sessionSpecialty(f.s,f.id('2'))?.kind,'social');
  }finally{f.close();}
});

test('a quoted answer to a delivered Social question goes to the same session once',async()=>{
  const f=fixture('telegram','claude');try {
    await f.send('1','/social make posts');const id=f.id('1');f.s.jobState(id,'dispatched');
    f.r.channelReply(f.b,'What platforms should I use?','progress',id,'question');
    f.s.db.prepare("UPDATE outbox SET status='sent',wa_id='question-message' WHERE request_id=? AND reply_kind='progress'").run(id);
    const quoted=(n:string)=>f.s.destinationContext.run(f.owner,()=>f.r.receive({id:f.id(n),text:'LinkedIn and Instagram',quotedId:'question-message',ownerChoice:true,ownerCommand:false}));
    assert.equal((await quoted('2')).status,'queued');assert.equal(f.s.job(f.id('2'))?.binding_id,f.b.id);assert.equal(sessionSpecialty(f.s,f.id('2'))?.kind,'social');
    assert.equal((await quoted('3')).status,'blocked');assert.equal(f.s.job(f.id('3')),undefined);
  }finally{f.close();}
});

test('Social content requests and clarification replies do not need a Meta key when coding review is enabled',async()=>{
  const f=fixture('telegram','claude');try {
    f.s.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,taskContracts:true}));
    assert.equal(f.r.contracts.enabled(),true);
    assert.equal(f.r.brain.secret.present(),false);
    assert.equal((await f.send('1','/social')).status,'handled');
    assert.equal((await f.send('2','How LLMs work')).status,'queued');
    const id=f.id('2');f.s.jobState(id,'dispatched');
    f.r.channelReply(f.b,'Which platforms should I use?','progress',id,'question');
    f.s.db.prepare("UPDATE outbox SET status='sent',wa_id='question-message' WHERE request_id=? AND reply_kind='progress'").run(id);
    const reply=()=>f.s.destinationContext.run(f.owner,()=>f.r.receive({id:f.id('3'),text:'LinkedIn',quotedId:'question-message',ownerChoice:true,ownerCommand:false}));
    assert.equal((await reply()).status,'queued');
    assert.equal(f.s.job(f.id('3'))?.binding_id,f.b.id);
  }finally{f.close();}
});

test('only explicit owner public research enables the bounded research adapter',async()=>{
  const f=fixture('telegram','claude');try {
    const text='/social research Agent Reach documentation and create a LinkedIn post';
    assert.equal((await f.send('1',text)).status,'queued');const id=f.id('1');let calls=0;
    assert.ok(sessionSpecialty(f.s,id)?.researchCaptureHash);
    f.r.reach=async(command,current)=>{calls++;assert.equal(command,'/reach web search Agent Reach documentation');assert.ok(current());return 'Public research from Exa web search.\n\nExample\nhttps://example.com/\nSynthetic source';};
    assert.match(await sessionResearchRequest(f.s,f.r,f.b,id,sessionSpecialty),/https:\/\/example.com/);assert.equal(calls,1);
    await assert.rejects(()=>sessionResearchRequest(f.s,f.r,f.b,id,sessionSpecialty),/already used/i);
  }finally{f.close();}
});

test('a private social brief never becomes a public search query',async()=>{
  const f=fixture('telegram','claude');try {
    await f.send('1','/social research my private launch plans and create posts');const id=f.id('1');
    assert.equal(f.s.get(`reach-owner-request:${id}`),undefined);
    await assert.rejects(()=>sessionResearchRequest(f.s,f.r,f.b,id,sessionSpecialty),/no authorized public research/i);
  }finally{f.close();}
});

test('active Social sessions save platform drafts once and expose them in Local',async()=>{
  const f=fixture('telegram','codex');try {
    const social=new SocialAssistant(f.s.db,()=>undefined);
    await f.send('1','/social create LinkedIn and Instagram drafts');const id=f.id('1');
    f.s.jobState(id,'dispatched');
    const input=[{platform:'LinkedIn',format:'Post',title:'Example',caption:'Draft text',sources:[{title:'Example',url:'https://example.com/'}]},{platform:'Instagram',format:'Carousel',title:'Example',caption:'Copy-ready caption',creativeBrief:'Slide 1: a clear hook',imagePrompt:'Editorial graphic with a simple diagram'}];
    const first=saveSessionSocialDrafts(f.s,f.b,id,'event-12345',input);
    assert.equal(first.duplicate,false);assert.equal(first.draftIds.length,2);
    const duplicate=saveSessionSocialDrafts(f.s,f.b,id,'event-12345',input);
    assert.equal(duplicate.duplicate,true);assert.deepEqual(duplicate.draftIds,first.draftIds);
    assert.equal(social.list().drafts.length,2);
    assert.equal((social.get(first.draftIds[0]) as any).platform,'LinkedIn');
    const carousel=social.get(first.draftIds[1]) as any;
    assert.equal(carousel.caption,'Copy-ready caption');assert.equal(carousel.creativeBrief,'Slide 1: a clear hook');
    assert.equal(carousel.imagePrompt,'Editorial graphic with a simple diagram');assert.equal(carousel.image,undefined);
    const legacy=[{platform:'X',format:'Post',title:'Legacy',caption:'Existing',sources:[]}];
    saveSessionSocialDrafts(f.s,f.b,id,'event-legacy',legacy);
    const batch=f.s.db.prepare('SELECT content_hash FROM social_session_batches WHERE request_id=? AND event_id=?').get(id,'event-legacy') as {content_hash:string};
    assert.equal(batch.content_hash,hash(JSON.stringify(legacy)));
    assert.equal(saveSessionSocialDrafts(f.s,f.b,id,'event-legacy',legacy).duplicate,true);
    assert.throws(()=>saveSessionSocialDrafts(f.s,f.b,id,'event-12345',[{...input[0],caption:'changed'}]),/different content/i);
    assert.equal(social.list().drafts.length,3);
  }finally{f.close();}
});

test('draft saving refuses wrong sessions, stale requests, and unsafe sources',async()=>{
  const f=fixture('whatsapp','claude');try {
    const social=new SocialAssistant(f.s.db,()=>undefined);
    await f.send('1','/social create drafts');const id=f.id('1');f.s.jobState(id,'dispatched');
    const valid=[{platform:'X',format:'Post',title:'Test',caption:'Sample'}];
    const other=f.s.register('other','codex',randomUUID(),f.root).binding;
    assert.throws(()=>saveSessionSocialDrafts(f.s,other,id,'event-12345',valid),/no longer active/i);
    assert.throws(()=>saveSessionSocialDrafts(f.s,f.b,id,'event-12345',[{...valid[0],sources:[{title:'Internal',url:'http://127.0.0.1/'}]}]),/source URL/i);
    assert.throws(()=>saveSessionSocialDrafts(f.s,f.b,id,'event-12345',[{...valid[0],imagePrompt:'x'.repeat(4001)}]),/image prompt/i);
    f.s.jobState(id,'completed');
    assert.throws(()=>saveSessionSocialDrafts(f.s,f.b,id,'event-12345',valid),/no longer active/i);
    assert.equal(social.list().drafts.length,0);
  }finally{f.close();}
});

test('owner-requested Meta images are scoped, saved once, and never expose the key to the session',async()=>{
  const f=fixture('telegram','codex');try{
    const social=new SocialAssistant(f.s.db,()=>undefined);await f.send('1','/social create an Instagram carousel about LLMs using Meta API');const id=f.id('1');f.s.jobState(id,'dispatched');
    const drafts=saveSessionSocialDrafts(f.s,f.b,id,'image-test-123',[{platform:'Instagram',format:'Carousel',title:'LLMs',caption:'Caption',imagePrompt:'A simple editorial diagram'}]);
    const jpeg=(await sharp({create:{width:32,height:32,channels:3,background:'#425d77'}}).jpeg().toBuffer()).toString('base64');
    let calls=0;const transport=async(url:string,init:RequestInit)=>{calls++;assert.equal(url,'https://api.meta.ai/v1/images/generations');assert.equal(JSON.parse(String(init.body)).prompt,'A simple editorial diagram');return Response.json({output_format:'jpeg',data:[{b64_json:jpeg}]});};
    const other=f.s.register('other','claude',randomUUID(),f.root).binding;
    await assert.rejects(()=>renderSessionSocialImage(f.s,other,social,()=> 'synthetic-key',id,drafts.draftIds[0],transport),/no longer active/i);
    await assert.rejects(()=>renderSessionSocialImage(f.s,f.b,social,()=>undefined,id,drafts.draftIds[0],transport),/Meta Model API key/i);assert.equal(calls,0);
    const result=await renderSessionSocialImage(f.s,f.b,social,()=> 'synthetic-key',id,drafts.draftIds[0],transport);
    assert.equal(result.status,'generated');assert.doesNotMatch(JSON.stringify(result),/synthetic-key/);
    const stored=social.get(drafts.draftIds[0]) as any;assert.equal(stored.image.base64,jpeg);assert.ok(stored.image.thumbnail);const list=social.list().drafts as any[];assert.equal(list[0].thumbnail,stored.image.thumbnail);assert.notEqual(list[0].thumbnail,jpeg);assert.equal(calls,1);
    await assert.rejects(()=>renderSessionSocialImage(f.s,f.b,social,()=> 'synthetic-key',id,drafts.draftIds[0],transport),/eligible|already/i);assert.equal(calls,1);
    const more=saveSessionSocialDrafts(f.s,f.b,id,'image-test-456',Array.from({length:4},(_,i)=>({platform:'Instagram',format:'Carousel',title:`LLMs ${i}`,caption:'Caption',imagePrompt:'A simple editorial diagram'})));
    for(const draftId of more.draftIds.slice(0,3))await renderSessionSocialImage(f.s,f.b,social,()=> 'synthetic-key',id,draftId,transport);
    await assert.rejects(()=>renderSessionSocialImage(f.s,f.b,social,()=> 'synthetic-key',id,more.draftIds[3],transport),/limit reached/i);assert.equal(calls,4);
  }finally{f.close();}
});

test('image generation needs an explicit visual request and will not replay an unknown outcome',async()=>{
  const f=fixture('telegram','codex');try{
    const social=new SocialAssistant(f.s.db,()=>undefined);await f.send('1','/social write about LLMs using Meta API');const id=f.id('1');f.s.jobState(id,'dispatched');
    const d=saveSessionSocialDrafts(f.s,f.b,id,'image-test-123',[{platform:'Instagram',format:'Post',title:'LLMs',caption:'Caption',imagePrompt:'A diagram'}]).draftIds[0];let calls=0;
    await assert.rejects(()=>renderSessionSocialImage(f.s,f.b,social,()=> 'key',id,d,async()=>{calls++;return new Response();}),/request an image/i);assert.equal(calls,0);
    await f.send('2','/social generate an image of LLMs using Meta API');const id2=f.id('2');f.s.jobState(id2,'dispatched');
    const d2=saveSessionSocialDrafts(f.s,f.b,id2,'image-test-456',[{platform:'Instagram',format:'Post',title:'LLMs',caption:'Caption',imagePrompt:'A diagram'}]).draftIds[0];
    const fail=async()=>{calls++;throw Error('network failed');};await assert.rejects(()=>renderSessionSocialImage(f.s,f.b,social,()=> 'key',id2,d2,fail),/outcome may be unknown/i);
    await assert.rejects(()=>renderSessionSocialImage(f.s,f.b,social,()=> 'key',id2,d2,fail),/already requested|interrupted/i);assert.equal(calls,1);
  }finally{f.close();}
});

test('a changed owner cannot receive a delayed generated image',async()=>{
  const f=fixture('telegram','codex');try{
    const social=new SocialAssistant(f.s.db,()=>undefined);await f.send('1','/social create a visual about LLMs using Meta API');const id=f.id('1');f.s.jobState(id,'dispatched');
    const d=saveSessionSocialDrafts(f.s,f.b,id,'image-test-123',[{platform:'Instagram',format:'Post',title:'LLMs',caption:'Caption',imagePrompt:'A diagram'}]).draftIds[0];
    let release!:(r:Response)=>void,started!:()=>void;const ready=new Promise<void>(r=>{started=r;});
    const pending=renderSessionSocialImage(f.s,f.b,social,()=> 'key',id,d,async()=>{started();return new Promise(r=>{release=r;});});await ready;
    f.s.set('telegram-owner','tg:other');release(Response.json({output_format:'jpeg',data:[{b64_json:'/9j/2Q=='}]}));
    await assert.rejects(pending,/outcome may be unknown/i);assert.equal((social.get(d) as any).image,undefined);
  }finally{f.close();}
});

test('a simulated owner request researches, saves and returns drafts through its selected native session',async()=>{
  const f=fixture('telegram','codex');try {
    const social=new SocialAssistant(f.s.db,()=>undefined),id=f.id('1');
    f.r.reach=async(command,current)=>{assert.equal(command,'/reach web search Agent Reach');assert.ok(current());return 'Public research from Exa web search.\n\nExample\nhttps://example.com/\nSynthetic source';};
    let runs=0;
    (f.r.native as any).run=async(binding:any,body:string,requestId:string)=>{
      runs++;assert.equal(binding.id,f.b.id);assert.equal(requestId,id);
      assert.match(turnEnvelope(f.s,binding,body,requestId,{},[],f.root,true).body,/Agent: farfromdesk-social/);
      assert.match(await sessionResearchRequest(f.s,f.r,binding,requestId,sessionSpecialty),/https:\/\/example.com/);
      const saved=saveSessionSocialDrafts(f.s,binding,requestId,'event-full-123',[{platform:'LinkedIn',format:'Post',title:'Agent Reach',caption:'A synthetic post',sources:[{title:'Example',url:'https://example.com/'}]}]);
      assert.equal(saved.draftIds.length,1);
      f.r.channelReply(binding,'One LinkedIn draft is ready for your review.','final',requestId,'synthetic-reply');
    };
    assert.equal((await f.send('1','/social research Agent Reach and create a LinkedIn post')).status,'queued');
    Router.prototype.pump.call(f.r);await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(runs,1);assert.equal(f.s.job(id)?.status,'completed');assert.equal(social.list().drafts.length,1);
    const reply=f.s.db.prepare('SELECT destination,body FROM outbox WHERE request_id=? AND reply_kind=?').get(id,'final') as {destination:string;body:string};
    assert.equal(reply.destination,f.owner);assert.match(reply.body,/LinkedIn draft/i);
  }finally{f.close();}
});


test('desktop Local choice blocks Meta before credentials and persists through clarification',async()=>{
 const f=fixture('telegram','codex');try{
  const input={bindingId:f.b.id,prompt:'Create an image using Meta API',platforms:['Instagram'],eventId:randomUUID(),imageProvider:'local'};
  f.r.brain.secret.read=()=>{throw Error('Must not read a Meta key');};
  const req=dispatchDesktopSocial(f.s,f.r,input);f.s.jobState(req.requestId,'dispatched');
  assert.equal(socialImageProvider(f.s,req.requestId),'local');
  const social=new SocialAssistant(f.s.db,()=>undefined),draft=saveSessionSocialDrafts(f.s,f.b,req.requestId,'local-source-test',[{platform:'Instagram',format:'Post',title:'Example',caption:'Example',imagePrompt:'Example'}]).draftIds[0];
  await assert.rejects(()=>renderSessionSocialImage(f.s,f.b,social,()=>{throw Error('Key accessed');},req.requestId,draft,async()=>{throw Error('Network accessed');}),/Local SVG skill/);
  assert.throws(()=>dispatchDesktopSocial(f.s,f.r,{...input,imageProvider:'meta'}),/already used/);
  f.r.guidedModes=new GuidedModes();await f.send('2','Make the image for shop owners');assert.equal(socialImageProvider(f.s,f.id('2')),'local');
 }finally{f.close();}
});
test('desktop Meta choice requires configuration, persists after reload, and can switch back locally',async()=>{
 const f=fixture('telegram','claude');try{
  const input={bindingId:f.b.id,prompt:'Create a post about cart recovery',platforms:['Instagram'],eventId:randomUUID(),imageProvider:'meta'};
  assert.throws(()=>dispatchDesktopSocial(f.s,f.r,input),/Meta Model API key/);assert.equal(f.s.job('local:social:'+input.eventId),undefined);
  f.r.brain.view=()=>({configured:true}) as any;
  const req=dispatchDesktopSocial(f.s,f.r,input);assert.equal(socialImageProvider(f.s,req.requestId),'meta');
  f.s.jobState(req.requestId,'dispatched');
  const social=new SocialAssistant(f.s.db,()=>undefined);
  const draft=saveSessionSocialDrafts(f.s,f.b,req.requestId,'desktop-meta-choice',[{platform:'Instagram',format:'Post',title:'Cart recovery',caption:'A helpful follow-up',imagePrompt:'A lavender shopping bag'}]).draftIds[0];
  const jpeg=(await sharp({create:{width:32,height:32,channels:3,background:'#7868d7'}}).jpeg().toBuffer()).toString('base64');
  let calls=0;
  const rendered=await renderSessionSocialImage(f.s,f.b,social,()=> 'synthetic-key',req.requestId,draft,async()=>{calls++;return Response.json({output_format:'jpeg',data:[{b64_json:jpeg}]});});
  assert.equal(rendered.status,'generated');assert.equal(calls,1);
  f.r.guidedModes=new GuidedModes();await f.send('2','Use a calm tone');assert.equal(socialImageProvider(f.s,f.id('2')),'meta');
  await f.send('3','Use local SVG for the image');assert.equal(socialImageProvider(f.s,f.id('3')),'local');
  assert.throws(()=>dispatchDesktopSocial(f.s,f.r,{...input,eventId:randomUUID(),imageProvider:'other'}),/Choose Local/);
 }finally{f.close();}
});

for(const provider of ['claude','codex'] as const)test(`natural Social intent uses selected ${provider} and saved Meta preference`,async()=>{
 const f=fixture('telegram',provider);try{
  f.s.set('social-image-provider','meta');
  assert.equal((await f.send('301','Create a carousel about cart recovery')).status,'queued');
  assert.equal(f.s.job(f.id('301'))?.binding_id,f.b.id);
  assert.equal(sessionSpecialty(f.s,f.id('301'))?.imageProvider,'meta');
  const prompt=turnEnvelope(f.s,f.b,f.s.job(f.id('301'))!.body,f.id('301'),{},[],f.root).body;
  assert.match(prompt,/Agent: farfromdesk-social/);assert.match(prompt,/Images Meta API/);
  assert.doesNotMatch(prompt,/Social content specialist/);
 }finally{f.close();}
});
test('explicit /use retargets Social without changing its provider and old replies retain their label',async()=>{
 const f=fixture('telegram','codex');try{
  await f.send('302','/social Create a post using Meta API');
  const other=f.s.register('new-session','claude',randomUUID(),f.root).binding;
  await f.send('303','/use new-session');
  assert.match(f.latest()?.body??'',/Mode: Social.*Meta API/);
  assert.equal((await f.send('304','About cart recovery for Instagram')).status,'queued');
  assert.equal(f.s.job(f.id('304'))?.binding_id,other.id);
  assert.equal(sessionSpecialty(f.s,f.id('304'))?.imageProvider,'meta');
  f.s.output(f.b,'Original request stopped after session change.','old-label',f.owner,{requestId:f.id('302'),kind:'system',origin:'system'});
  assert.match(f.latest()?.body??'',/Mode: Social.*Meta API/);
 }finally{f.close();}
});
test('authenticated voice can activate Social but quoted/forwarded text cannot',async()=>{
 const f=fixture('telegram','codex');try{
  await f.s.destinationContext.run(f.owner,()=>f.r.receive({id:f.id('305'),text:'Create a post about cart recovery',source:'voice',ownerIntent:true,ownerCommand:false}));
  assert.equal(sessionSpecialty(f.s,f.id('305'))?.kind,'social');
 }finally{f.close();}
 for(const extra of [{ownerCommand:false,ownerIntent:false},{ownerCommand:false,ownerIntent:false,quotedId:'unknown'}]){
  const f=fixture('telegram','claude');try{
   await f.s.destinationContext.run(f.owner,()=>f.r.receive({id:f.id('306'),text:'Create a post about cart recovery',...extra}));
   assert.equal(sessionSpecialty(f.s,f.id('306')),undefined);
  }finally{f.close();}
 }
});

test('specialist instruction file is immutable and corruption blocks delivery',async()=>{
 const f=fixture('telegram','claude');try{
  await f.send('401','/social Create a post');const id=f.id('401');
  const doc=specialistDocument(f.s,f.b,id,f.root);assert.match(doc.file,/^\//);
  chmodSync(doc.file,0o600);writeFileSync(doc.file,'Changed instructions');
  assert.throws(()=>turnEnvelope(f.s,f.b,f.s.job(id)!.body,id,{},[],f.root),/integrity/);
 }finally{f.close();}
});
