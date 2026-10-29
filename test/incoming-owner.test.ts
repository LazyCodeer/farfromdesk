import './brain-fixture-isolation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {Router} from '../src/router.js';
import {Approvals} from '../src/approvals.js';
import {WhatsApp} from '../src/whatsapp.js';
import {Telegram} from '../src/telegram.js';
import {MetaSecret,DEFAULT_BRAIN,saveBrainConfig} from '../src/meta-brain-config.js';
import {MetaBrain} from '../src/meta-brain.js';
import {MetaModel} from '../src/meta-model.js';
import {TaskContracts,contractDeliveryState} from '../src/task-contracts.js';
import {writeVoiceKey,removeVoiceKey,transcribeCloud} from '../src/voice-cloud.js';
import {transcribeAudio} from '../src/audio.js';

const owner='123@s.whatsapp.net',other='456@s.whatsapp.net',group='12345@g.us';
function fixture(persistent=false){
  const dir=mkdtempSync(join(tmpdir(),'ffd-origin-test-')),store=new Store(persistent?join(dir,'test.sqlite'):':memory:'),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
  store.set('whatsapp-owner',owner);const b=store.register('owner-test','codex',randomUUID(),dir).binding;store.set('active',b.id);router.pump=()=>{};
  const secret=new MetaSecret(dir);secret.save('synthetic-contract-test-key');saveBrainConfig(store,secret,{policy:{...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:['codex'],failure:'block'}});
  let calls=0;router.contracts=new TaskContracts(store,secret,async()=>{calls++;return {kind:'contract',goal:'Build',exclusions:[],checks:['Works','No regressions'],question:''};});
  const wa=new WhatsApp(store,router);wa.status='connected';wa.selfJid=owner;wa.owners=[owner];
  return {store,router,wa,dir,get calls(){return calls;},close(){wa.close();approvals.cancel();store.close();rmSync(dir,{recursive:true,force:true});}};
}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('group ingress cannot migrate to another owner during asynchronous verification',async()=>{
  for(const restore of [false,true]){const f=fixture();try{
    f.store.set('destination-jid',group);f.store.set(`owned-group:${group}`,'Owner group');
    let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});f.wa.verifyGroup=async()=>waiting;
    const pending=f.wa.receiveMessage({key:{id:'group',remoteJid:group,fromMe:true},message:{conversation:'Build the theme'}});await turn();
    f.store.set('whatsapp-owner',other);if(restore)f.store.set('whatsapp-owner',owner);release();await pending;
    assert.equal(f.calls,0);assert.equal(f.store.jobs().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_contracts').get()?.n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()?.n,0);
  }finally{f.close();}}
});
test('remote-control await retains the captured owner before contract interpretation',async()=>{
  for(const change of ['owner','channel'] as const){const f=fixture();try{
    let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});f.router.remoteControl=async()=>{await waiting;return undefined;};
    const pending=f.router.receive({id:'wa:remote-wait',text:'Build the theme',ownerCommand:true,ownerIntent:true});await turn();
    if(change==='owner'){f.store.set('whatsapp-owner',other);f.store.set('whatsapp-owner',owner);}else{f.store.set('control-channel','telegram');f.store.set('control-channel','whatsapp');}release();await pending;
    assert.equal(f.calls,0);assert.equal(f.store.jobs().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_contracts').get()?.n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()?.n,0);
  }finally{f.close();}}
});
test('owner changes while contract interpretation waits cannot produce a proposal or route work',async()=>{
  for(const change of ['owner','channel'] as const){const f=fixture();try{
    let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;}),secret=new MetaSecret(f.dir);
    f.router.contracts=new TaskContracts(f.store,secret,async()=>{await waiting;return {kind:'contract',goal:'Build',exclusions:[],checks:['Works'],question:''};});
    const pending=f.router.receive({id:'wa:contract-wait',text:'Build the theme',ownerCommand:true,ownerIntent:true});await turn();
    if(change==='owner'){f.store.set('whatsapp-owner',other);f.store.set('whatsapp-owner',owner);}else{f.store.set('control-channel','telegram');f.store.set('control-channel','whatsapp');}release();await pending;
    assert.equal(f.store.jobs().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_contracts').get()?.n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()?.n,0);
  }finally{f.close();}}
});
test('pausing and resuming background operation invalidates the in-flight owner request',async()=>{
  const f=fixture();try{
    f.store.set('background-enabled','true');let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});
    f.router.remoteControl=async()=>{await waiting;return undefined;};
    const pending=f.router.receive({id:'wa:pause-wait',text:'Build the theme',ownerCommand:true,ownerIntent:true});await turn();
    f.store.set('background-enabled','false');f.store.set('background-enabled','true');release();await pending;
    assert.equal(f.calls,0);assert.equal(f.store.jobs().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()?.n,0);
  }finally{f.close();}
});
test('outbox created under old owner scope is invalid even if the old owner is restored',()=>{
  const f=fixture();try{
    const origin=f.store.captureIncomingOwner(owner,'whatsapp')!;
    f.store.incomingOwnerContext.run(origin,()=>f.store.output(undefined,'Private response','scoped',owner));
    const row=f.store.db.prepare("SELECT id FROM outbox WHERE source='scoped:0'").get() as {id:string};assert.equal(f.store.incomingOwnerDelivery(row.id),true);
    f.store.set('whatsapp-owner',other);f.store.set('whatsapp-owner',owner);assert.equal(f.store.incomingOwnerDelivery(row.id),false);
  }finally{f.close();}
});
test('restart does not send an interrupted voice notice under a revoked owner',()=>{
  const f=fixture();try{
    const captured=f.store.captureIncomingOwner(owner,'whatsapp')!;
    f.store.incomingOwnerContext.run(captured,()=>{f.store.db.prepare("INSERT INTO audio_inbox VALUES(?,?,'processing',?)").run('wa:voice',owner,Date.now());f.store.recordIncomingInput('wa:voice');});
    f.store.set('whatsapp-owner',other);f.store.set('whatsapp-owner',owner);f.store.interruptAudio('Interrupted');
    assert.equal(f.store.db.prepare("SELECT status FROM audio_inbox WHERE id='wa:voice'").get()?.status,'interrupted');
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()?.n,0);
  }finally{f.close();}
});
test('normal service shutdown preserves an unchanged owner contract proposal across restart',async()=>{
  const f=fixture(true);let reopened:Store|undefined;let nextApprovals:Approvals|undefined;
  try{
    await f.router.receive({id:'wa:restart-proposal',text:'Build the theme',ownerCommand:true,ownerIntent:true});
    const row=f.store.db.prepare("SELECT id FROM outbox WHERE source LIKE 'task-contract:%'").get() as {id:string};assert.ok(row);assert.equal(f.store.incomingOwnerDelivery(row.id),true);
    f.router.stopped=true;f.wa.close();f.store.close();
    reopened=new Store(join(f.dir,'test.sqlite'));nextApprovals=new Approvals(reopened);const router=new Router(reopened,{run:async()=>{},stop:()=>{}} as any,nextApprovals);
    router.contracts=new TaskContracts(reopened,new MetaSecret(f.dir),async()=>({kind:'pass',goal:'',exclusions:[],checks:[],question:''}));
    assert.equal(reopened.incomingOwnerDelivery(row.id),true);assert.equal(contractDeliveryState(router,row.id),'ready');
  }finally{nextApprovals?.cancel();reopened?.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('explicit WhatsApp logout invalidates an in-flight owner request before its remote wait resolves',async()=>{
  const f=fixture();try{
    f.wa.sock={logout:async()=>{},end:()=>{}} as any;
    let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});f.router.remoteControl=async()=>{await waiting;return undefined;};
    const pending=f.wa.receiveMessage({key:{id:'logout',remoteJid:owner,fromMe:true},message:{conversation:'Build the theme'}});await turn();
    await f.wa.logout();release();await pending;assert.equal(f.calls,0);assert.equal(f.store.jobs().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()?.n,0);
  }finally{f.close();}
});
test('Telegram disconnect invalidates an in-flight request even after the same owner is paired again',async()=>{
  const f=fixture();const tg=new Telegram(f.store,f.router,f.dir);try{
    const destination='tg:123456:777';f.store.set('telegram-owner',destination);f.store.set('telegram-bot-id','123456');f.store.set('control-channel','telegram');
    (tg as any).bot={id:123456,username:'fake_bot'};tg.closed=false;
    let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});f.router.remoteControl=async()=>{await waiting;return undefined;};
    const pending=tg.receive({message:{message_id:11,date:Math.floor(Date.now()/1000),text:'Build the theme',chat:{id:777,type:'private'},from:{id:777,is_bot:false}}});await turn();
    tg.disconnect();f.store.set('telegram-bot-id','123456');f.store.set('telegram-owner',destination);release();await pending;
    assert.equal(f.calls,0);assert.equal(f.store.jobs().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()?.n,0);
  }finally{tg.close();f.close();}
});
test('voice downloaded under a revoked owner cannot reach cloud transcription',async()=>{
  const f=fixture();try{
    writeVoiceKey('deepgram','synthetic-voice-key-not-real');f.store.set('voice-engine','deepgram');
    let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});let disposed=false;
    const captured=f.store.captureIncomingOwner(owner,'whatsapp')!;
    const pending=f.store.incomingOwnerContext.run(captured,()=>transcribeAudio(f.store,{mimetype:'audio/ogg',seconds:1,fileLength:1},undefined,undefined,async()=>{await waiting;return {path:'unused',filename:'voice.bin',bytes:1,sha256:'a',mime:'audio/ogg',dispose:()=>{disposed=true;}};}));
    await turn();f.store.set('whatsapp-owner',other);f.store.set('whatsapp-owner',owner);release();await assert.rejects(pending,/owner connection changed/i);assert.equal(disposed,true);
  }finally{removeVoiceKey();f.close();}
});
test('a WhatsApp attachment download interrupted by an owner change queues no error or task',async()=>{
  const f=fixture();try{
    let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});
    f.wa.downloadFile=async()=>{await waiting;throw new Error('synthetic download failure');};
    const pending=f.wa.receiveMessage({key:{id:'file',remoteJid:owner,fromMe:true},message:{documentMessage:{mimetype:'text/plain',fileName:'note.txt',fileLength:8,caption:'Read this'}}});await turn();
    f.store.set('whatsapp-owner',other);f.store.set('whatsapp-owner',owner);release();await pending;
    assert.equal(f.store.jobs().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()?.n,0);
    assert.equal(f.store.db.prepare("SELECT status FROM media_inbox WHERE id='wa:file'").get()?.status,'interrupted');
  }finally{f.close();}
});
test('Telegram voice scope is invalidated by owner or channel changes during transcription',async()=>{
  for(const change of ['owner','channel'] as const){const f=fixture();const tg=new Telegram(f.store,f.router,f.dir);try{
    const destination='tg:123456:777';f.store.set('telegram-owner',destination);f.store.set('telegram-bot-id','123456');f.store.set('control-channel','telegram');
    (tg as any).bot={id:123456,username:'fake_bot'};tg.closed=false;
    let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});tg.transcribe=async()=>{await waiting;return 'Build the theme';};
    await tg.receive({message:{message_id:9,date:Math.floor(Date.now()/1000),chat:{id:777,type:'private'},from:{id:777,is_bot:false},voice:{file_id:'fake',file_size:1,duration:1,mime_type:'audio/ogg'}}});await turn();
    if(change==='owner'){f.store.set('telegram-owner','tg:123456:888');f.store.set('telegram-owner',destination);}else{f.store.set('control-channel','whatsapp');f.store.set('control-channel','telegram');}release();await turn();await turn();
    assert.equal(f.calls,0);assert.equal(f.store.jobs().length,0);
    assert.equal(f.store.db.prepare("SELECT status FROM audio_inbox WHERE id='tg:123456:777:9'").get()?.status,'interrupted');
    const rows=f.store.db.prepare('SELECT id FROM outbox').all() as {id:string}[];assert.ok(rows.every(row=>!f.store.incomingOwnerDelivery(row.id)));
  }finally{tg.close();f.close();}}
});
test('cloud transcription rechecks captured authority before each network request',async()=>{
  const f=fixture();try{
    const path=join(f.dir,'voice.ogg');writeFileSync(path,'synthetic');const captured=f.store.captureIncomingOwner(owner,'whatsapp')!;let calls=0;
    await assert.rejects(f.store.incomingOwnerContext.run(captured,()=>transcribeCloud('assemblyai','synthetic-key',path,'audio/ogg',undefined,{authorize:()=>f.store.assertIncomingOwner(),fetcher:async()=>{calls++;f.store.set('whatsapp-owner',other);return Response.json({upload_url:'https://example.test/upload'});}})));
    assert.equal(calls,1);
  }finally{f.close();}
});
test('Meta tool loop cannot read or send owner memory after revocation',async()=>{
  const f=fixture();try{
    const secret=new MetaSecret(f.dir);let calls=0;
    const response=new Response(JSON.stringify({id:'r',created:0,model:'muse-wonder-1.0',choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'call_1',type:'function',function:{name:'memory',arguments:JSON.stringify({command:'view',path:'/memories/private.md'})}}]}}]}),{headers:{'content-type':'application/json'}});
    const fake:typeof fetch=async()=>{calls++;f.store.set('whatsapp-owner',other);return response;};
    f.router.brain=new MetaBrain(f.store,secret,new MetaModel(fake));f.router.brain.owner.write('private.md','SYNTHETIC_PRIVATE_MARKER','synthetic');
    const captured=f.store.captureIncomingOwner(owner,'whatsapp')!;
    await f.store.incomingOwnerContext.run(captured,()=>f.router.brain.handle(f.router,{id:'wa:brain',text:'Tell me something interesting',ownerCommand:true,ownerIntent:true}));
    assert.equal(calls,1);assert.equal(f.router.brain.get('wa:brain')?.state,'blocked');assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()?.n,0);
  }finally{f.close();}
});
