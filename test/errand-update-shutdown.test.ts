import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';

test('an update restart waits for incoming messages, transcription, review and active searches',async()=>{
  const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=(probe.address() as {port:number}).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  process.env.WSB_PORT=String(port);
  const [{Store},{Router},{Approvals},{WhatsApp},{Telegram},{ErrandWorkflow},{TaskContracts},{DEFAULT_BRAIN},{serve}]=await Promise.all([
    import('../src/store.js'),import('../src/router.js'),import('../src/approvals.js'),import('../src/whatsapp.js'),import('../src/telegram.js'),import('../src/errand-workflow.js'),import('../src/task-contracts.js'),import('../src/meta-brain-config.js'),import('../src/server.js'),
  ]);
  const owner='123@s.whatsapp.net',store=new Store(':memory:'),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
  store.set('whatsapp-owner',owner);const binding=store.register('test','codex',randomUUID(),'/tmp').binding;store.set('active',binding.id);router.pump=()=>{};
  let release!:()=>void,started!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
  router.errands=new ErrandWorkflow(router,async()=>{started();await waiting;return [];},async rows=>rows.map(row=>row.id));
  const wa=new WhatsApp(store,router);wa.status='connected';wa.selfJid=owner;wa.owners=[owner];
  const telegram=new Telegram(store,router),server=serve(store,router,wa,'synthetic-admin',{masters:{creating:false},telegram} as any);router.remoteControl=undefined;
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const post=()=>fetch(`http://127.0.0.1:${port}/api/update-shutdown`,{method:'POST',headers:{authorization:'Bearer synthetic-admin','content-type':'application/json'},body:'{}'});
  const blocked=async()=>{const response=await post();assert.equal(response.status,400);assert.match((await response.json() as {error:string}).error,/Finish the active request/);assert.equal(router.stopped,false);};
  const gate=()=>{let open!:()=>void,ready!:()=>void;const wait=new Promise<void>(resolve=>{open=resolve;}),entered=new Promise<void>(resolve=>{ready=resolve;});return {open,ready,wait,entered};};
  const gates:ReturnType<typeof gate>[]=[];let pending:Promise<unknown>|undefined;
  try{
    const group='owner-only@g.us';store.set('destination-jid',group);store.set(`owned-group:${group}`,'Owner only');
    const g=gate();gates.push(g);wa.verifyGroup=async()=>{g.ready();await g.wait;};
    const groupPending=wa.receiveMessage({key:{id:'group',fromMe:true,remoteJid:group},message:{conversation:'Hello'}});await g.entered;
    assert.equal(router.hasPendingIngress(),false);assert.equal(wa.hasPendingIngress(),true);await blocked();g.open();await groupPending;store.set('destination-jid',owner);

    router.brain.secret.save('synthetic-contract-key-not-real');store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,taskContracts:true}));
    const c=gate();gates.push(c);router.contracts=new TaskContracts(store,router.brain.secret,async()=>{c.ready();await c.wait;return {kind:'pass',goal:'',exclusions:[],checks:[],question:''};});
    const reviewPending=wa.receiveMessage({key:{id:'review',fromMe:true,remoteJid:owner},message:{conversation:'Build the theme'}});await c.entered;
    assert.equal(router.errands.hasActiveSearch(),false);assert.equal(router.hasPendingIngress(),true);await blocked();c.open();await reviewPending;
    store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:false}));

    const voice=gate();gates.push(voice);wa.transcribe=async()=>{voice.ready();await voice.wait;return 'Hello';};
    const voicePending=wa.receiveMessage({key:{id:'voice',fromMe:true,remoteJid:owner},message:{audioMessage:{mimetype:'audio/ogg',seconds:1,fileLength:1}}});await voice.entered;
    assert.equal(wa.hasPendingIngress(),true);await blocked();voice.open();await voicePending;
    const media=gate();gates.push(media);wa.downloadFile=async()=>{media.ready();await media.wait;throw new Error('Synthetic download failure');};
    const mediaPending=wa.receiveMessage({key:{id:'media',fromMe:true,remoteJid:owner},message:{documentMessage:{mimetype:'text/plain',fileName:'note.txt',fileLength:1,caption:'Read this'}}});await media.entered;
    assert.equal(wa.hasPendingIngress(),true);await blocked();media.open();await mediaPending;

    const tgOwner='tg:123456:777';store.set('telegram-owner',tgOwner);store.set('telegram-bot-id','123456');store.set('control-channel','telegram');
    (telegram as any).bot={id:123456,username:'fake_bot'};telegram.closed=false;
    const tgVoice=gate();gates.push(tgVoice);telegram.transcribe=async()=>{tgVoice.ready();await tgVoice.wait;return 'Hello';};
    await telegram.receive({message:{message_id:7,date:Math.floor(Date.now()/1000),chat:{id:777,type:'private'},from:{id:777,is_bot:false},voice:{file_id:'fake',file_size:1,duration:1,mime_type:'audio/ogg'}}});await tgVoice.entered;
    assert.equal(telegram.hasPendingIngress(),true);assert.equal(router.hasPendingIngress(),false);await blocked();tgVoice.open();
    while(telegram.hasPendingIngress())await new Promise<void>(resolve=>setImmediate(resolve));
    const tgMedia=gate();gates.push(tgMedia);(telegram as any).download=async()=>{tgMedia.ready();await tgMedia.wait;throw new Error('Synthetic download failure');};
    await telegram.receive({message:{message_id:8,date:Math.floor(Date.now()/1000),caption:'Read this',chat:{id:777,type:'private'},from:{id:777,is_bot:false},document:{file_id:'fake',file_size:1,file_name:'note.txt'}}});await tgMedia.entered;
    assert.equal(telegram.hasPendingIngress(),true);await blocked();tgMedia.open();
    while(telegram.hasPendingIngress())await new Promise<void>(resolve=>setImmediate(resolve));
    telegram.close();store.set('control-channel','whatsapp');

    pending=wa.receiveMessage({key:{id:'root',fromMe:true,remoteJid:owner},message:{conversation:'greenhouse jobs; board=example; role=Flutter; location=Bangalore'}});
    await entered;assert.equal(router.busy.size,0);assert.equal(router.errands.hasActiveSearch(),true);
    await blocked();
    release();await pending;assert.equal(router.errands.hasActiveSearch(),false);
    const allowed=await post();assert.equal(allowed.status,200);assert.equal(router.stopped,true);
  }finally{
    for(const g of gates)g.open();release();await pending;telegram.close();wa.close();approvals.cancel();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();
  }
});
