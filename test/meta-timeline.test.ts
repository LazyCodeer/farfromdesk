import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Set the state before any app module import; tests must never see installed state.
const root=mkdtempSync(join(tmpdir(),'ffd-meta-timeline-'));
process.env.WSB_STATE_DIR=root;process.env.FARFROMDESK_HOME=join(root,'home');
test.after(()=>rmSync(root,{recursive:true,force:true}));
const {Store}=await import('../src/store.js');
const {metaObserver,metaTimeline,metaTimelineRevision}=await import('../src/meta-timeline.js');
const {MetaModel}=await import('../src/meta-model.js');
const {DEFAULT_BRAIN,MetaSecret}=await import('../src/meta-brain-config.js');
const {MetaBrain}=await import('../src/meta-brain.js');
const {interpretSchedule}=await import('../src/schedule-model.js');
const {interpretContract}=await import('../src/task-contract-model.js');
const {transcribeCloud}=await import('../src/voice-cloud.js');
const {writeVoiceKey}=await import('../src/voice-cloud.js');
const {transcribeAudio}=await import('../src/audio.js');
const {voiceTranscriber}=await import('../src/remote-p2p/service.js');
const {MorningBrief}=await import('../src/morning-brief.js');
const {Router}=await import('../src/router.js');
const {Approvals}=await import('../src/approvals.js');
const {WhatsApp}=await import('../src/whatsapp.js');

function fixture(){const store=new Store(':memory:');store.set('whatsapp-owner','owner@s.whatsapp.net');return store;}
const toolResponse=(name:string,args:unknown)=>new Response(JSON.stringify({id:'r',created:0,model:'muse-wonder-1.0',choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'call_1',type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]}),{headers:{'content-type':'application/json'}});
function syntheticVoice(s:InstanceType<typeof Store>) {
  // A local fake decoder copies valid synthetic PCM. No real audio or network.
  const decoder=join(root,'fake-ffmpeg');
  writeFileSync(decoder,`#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.copyFileSync(a[a.indexOf('-i')+1],a[a.length-1]);\n`);chmodSync(decoder,0o700);
  const n=3200,wav=Buffer.alloc(44+n*2);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(n*2,40);for(let i=0;i<n;i++)wav.writeInt16LE(Math.round(Math.sin(i*.2)*8000),44+i*2);
  const path=join(root,'input.wav');writeFileSync(path,wav);
  s.set('voice-engine','meta');s.set('audio-tools',JSON.stringify({ffmpeg:decoder}));writeVoiceKey('meta','synthetic-not-a-real-key');
  const download=async()=>({path,filename:'input.wav',bytes:wav.length,sha256:'unused',mime:'audio/wav',dispose:()=>{}});
  return {wav,download};
}

test('only fixed labels, status and duration are stored, scoped to the original owner and chat',async()=>{
  const s=fixture();try{
    const observe=metaObserver(s,'sorted','owner@s.whatsapp.net');await observe(async()=>new Response('SYNTHETIC_SECRET'));
    await assert.rejects(observe(async()=>{throw Error('SYNTHETIC_SECRET');}));
    const rows=metaTimeline(s) as any[];assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.status),['failed','completed']);
    assert.ok(rows.every(r=>r.stage==='sorted'&&r.durationMs>=0&&Number.isFinite(r.at)));
    assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT * FROM meta_timeline').all()),/SYNTHETIC_SECRET|owner@s/);
    s.set('whatsapp-owner','other@s.whatsapp.net');assert.deepEqual(metaTimeline(s),[]);
    s.set('whatsapp-owner','owner@s.whatsapp.net');assert.equal(metaTimeline(s).length,2);
    s.set('destination-jid','group@g.us');s.set('owned-group:group@g.us','Test group');assert.deepEqual(metaTimeline(s),[]);
    await metaObserver(s,'briefed','group@g.us','owner@s.whatsapp.net')(()=>Promise.resolve('ok'));assert.equal(metaTimeline(s).length,1);
    s.set('destination-jid','owner@s.whatsapp.net');assert.equal(metaTimeline(s).length,2);
  }finally{s.close();}
});

test('timeline is bounded and telemetry errors never break the actual call',async()=>{
  const s=fixture();const observe=metaObserver(s,'sorted','owner@s.whatsapp.net');
  try{for(let i=0;i<1010;i++)await observe(async()=>true);assert.equal(Number((s.db.prepare('SELECT COUNT(*) n FROM meta_timeline').get() as any).n),1000);assert.equal(metaTimeline(s).length,30);}finally{s.close();}
  assert.equal(await observe(async()=>42),42);
});

test('a call finishing after re-pairing is omitted',async()=>{
  const s=fixture();try{
    let release!:()=>void;const wait=new Promise<void>(r=>{release=r;});
    const call=metaObserver(s,'sorted','owner@s.whatsapp.net')(()=>wait);
    s.set('whatsapp-owner','other@s.whatsapp.net');release();await call;
    assert.deepEqual(metaTimeline(s),[]);
    s.set('whatsapp-owner','owner@s.whatsapp.net');assert.equal(metaTimeline(s).length,0);
  }finally{s.close();}
});

test('non-chat calls are not attributed to the selected chat',async()=>{
  const s=fixture();try{
    await metaObserver(s,'heard')(async()=>true);
    assert.deepEqual(metaTimeline(s),[]);
    await s.destinationContext.run('owner@s.whatsapp.net',()=>metaObserver(s,'heard')(async()=>true));
    assert.deepEqual(metaTimeline(s),[]);
  }finally{s.close();}
});

test('group text cannot move to a new owner during group verification',async()=>{
  const s=fixture(),approvals=new Approvals(s),router=new Router(s,{run:async()=>{},stop:()=>{}} as any,approvals);
  const wa=new WhatsApp(s,router),old='owner@s.whatsapp.net',next='other@s.whatsapp.net',group='group@g.us';
  try {
    s.set('destination-jid',group);s.set(`owned-group:${group}`,'Synthetic group');
    s.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:['codex']}));
    const secret=new MetaSecret(root);secret.save('synthetic-not-a-real-key');let calls=0;
    const fake:typeof fetch=async()=>{calls++;return toolResponse('decide',{intent:'chat',normalized:'A synthetic question',provider:'unspecified',taskIds:[],reply:'Hello'});};
    router.brain=new MetaBrain(s,secret,new MetaModel(fake));
    router.receive=async m=>{await router.brain.handle(router,m);return {status:'handled',requestId:m.id};};
    wa.status='connected';wa.selfJid=old;wa.owners=[old];
    let resume!:()=>void;const gate=new Promise<void>(r=>{resume=r;});let count=0;
    (wa as any).verifyGroup=async()=>{if(++count===1)await gate;};
    const message=(id:string)=>({key:{id,fromMe:true,remoteJid:group},message:{conversation:'A synthetic question'}});
    const task=wa.receiveMessage(message('synthetic-old'));
    s.set('whatsapp-owner',next);wa.selfJid=next;wa.owners=[next];resume();await task;
    assert.equal(calls,0);assert.deepEqual(metaTimeline(s),[]);
    s.set('whatsapp-owner',old);wa.selfJid=old;wa.owners=[old];assert.deepEqual(metaTimeline(s),[]);
    await wa.receiveMessage(message('synthetic-current'));
    assert.equal(calls,1);assert.equal((metaTimeline(s) as any[])[0].stage,'sorted');
  }finally{wa.close();approvals.cancel();s.close();}
});

test('remote voice cannot inherit chat attribution while explicit chat voice is recorded', {skip:process.platform==='win32'},async()=>{
  const s=fixture(),originalFetch=globalThis.fetch;
  try {
    const {wav,download}=syntheticVoice(s);
    globalThis.fetch=async()=>new Response(JSON.stringify({transcript:'hello'}),{headers:{'content-type':'application/json'}});
    const result=await s.destinationContext.run('owner@s.whatsapp.net',()=>new Promise<string>((resolve,reject)=>setTimeout(()=>voiceTranscriber(s).transcribe(wav,'audio/wav',new AbortController().signal).then(resolve,reject),0)));
    assert.equal(result,'hello');assert.deepEqual(metaTimeline(s),[]);
    await transcribeAudio(s,{mimetype:'audio/wav',fileLength:wav.length},undefined,undefined,download,{kind:'chat',destination:'owner@s.whatsapp.net',owner:'owner@s.whatsapp.net'});
    assert.equal((metaTimeline(s) as any[])[0].stage,'heard');
  }finally{globalThis.fetch=originalFetch;s.close();}
});

test('group voice cannot move to a new owner while group verification awaits', {skip:process.platform==='win32'},async()=>{
  const s=fixture(),originalFetch=globalThis.fetch,approvals=new Approvals(s);
  const router=new Router(s,{run:async()=>{},stop:()=>{}} as any,approvals);
  const wa=new WhatsApp(s,router),old='owner@s.whatsapp.net',next='other@s.whatsapp.net',group='group@g.us';
  try {
    const {wav,download}=syntheticVoice(s);
    s.set('destination-jid',group);s.set(`owned-group:${group}`,'Synthetic group');
    wa.status='connected';wa.selfJid=old;wa.owners=[old];
    globalThis.fetch=async()=>new Response(JSON.stringify({transcript:'hello'}),{headers:{'content-type':'application/json'}});
    let resume!:()=>void;const gate=new Promise<void>(r=>{resume=r;});let count=0,captured:unknown;
    (wa as any).verifyGroup=async()=>{if(++count===1)await gate;};
    wa.transcribe=(audio,signal,observe,origin)=>{captured=origin;return transcribeAudio(s,audio,signal,observe,download,origin);};
    (router as any).receive=async()=>({status:'handled'});
    const task=wa.receiveMessage({key:{id:'synthetic',fromMe:true,remoteJid:group},message:{audioMessage:{mimetype:'audio/wav',seconds:1,fileLength:wav.length}}});
    s.set('whatsapp-owner',next);wa.selfJid=next;wa.owners=[next];resume();await task;
    assert.equal(captured,undefined);assert.deepEqual(metaTimeline(s),[]);
    s.set('whatsapp-owner',old);assert.deepEqual(metaTimeline(s),[]);
  }finally{globalThis.fetch=originalFetch;wa.close();approvals.cancel();s.close();}
});

test('scope revisions change on owner and chat changes and are stable otherwise',()=>{
  const s=fixture();try{
    const a=metaTimelineRevision(s);assert.ok(a);assert.equal(metaTimelineRevision(s),a);
    s.set('whatsapp-owner','other@s.whatsapp.net');const b=metaTimelineRevision(s);assert.ok(b);assert.notEqual(b,a);
    s.set('whatsapp-owner','owner@s.whatsapp.net');assert.notEqual(metaTimelineRevision(s),a);
  }finally{s.close();}
});

test('scope lookup failure never prevents the underlying operation',async()=>{
  const s=fixture();try{
    s.ownerFor=()=>{throw new Error('synthetic lookup failure');};
    assert.equal(await metaObserver(s,'heard','owner@s.whatsapp.net')(async()=>42),42);
    assert.equal(metaTimelineRevision(s),null);
  }finally{s.close();}
});

test('a failed Meta HTTP call records failure without exposing provider details',async()=>{
  const s=fixture();try{
    const model=new MetaModel(async()=>new Response('SYNTHETIC_PRIVATE_PROVIDER_ERROR',{status:401}));
    await assert.rejects(model.interpret('synthetic-key',DEFAULT_BRAIN,{original:'Hello',source:'text',tasks:[]},undefined,undefined,metaObserver(s,'sorted','owner@s.whatsapp.net')));
    const rows=metaTimeline(s) as any[];assert.equal(rows.length,1);assert.equal(rows[0].status,'failed');
    assert.doesNotMatch(JSON.stringify(rows),/SYNTHETIC_PRIVATE_PROVIDER_ERROR|synthetic-key/);
  }finally{s.close();}
});

test('actual Brain, reminder and Meta voice requests each record a completed call',async()=>{
  const s=fixture(),originalFetch=globalThis.fetch;try{
    const model=new MetaModel(async()=>toolResponse('decide',{intent:'chat',normalized:'Hello',provider:'unspecified',taskIds:[],reply:'Hi'}));
    await model.interpret('synthetic-key',DEFAULT_BRAIN,{original:'Hello',source:'text',tasks:[]},undefined,undefined,metaObserver(s,'sorted','owner@s.whatsapp.net'));
    globalThis.fetch=async()=>toolResponse('decide',{kind:'create',action:'message',date:'2026-10-30',time:'18:00',zone:'Asia/Kolkata',repeat:'once',text:'call the bank',target:'',question:''});
    await interpretSchedule('Remind me tomorrow at 6 PM to call the bank',Date.parse('2026-10-29T02:00:00Z'),'Asia/Kolkata','synthetic-key',metaObserver(s,'scheduled','owner@s.whatsapp.net'));
    const wav=join(root,'synthetic.wav');writeFileSync(wav,Buffer.from('synthetic'));
    await transcribeCloud('meta','synthetic-key',wav,'audio/wav',undefined,{fetcher:async()=>new Response(JSON.stringify({transcript:'Hello'}),{headers:{'content-type':'application/json'}}),onMetaCall:metaObserver(s,'heard','owner@s.whatsapp.net')});
    assert.deepEqual((metaTimeline(s) as any[]).map(r=>r.stage),['heard','scheduled','sorted']);
  }finally{globalThis.fetch=originalFetch;s.close();}
});

test('a real brief writer records its Meta call without storing its prompt or reply',async()=>{
  const s=fixture(),originalFetch=globalThis.fetch,approvals=new Approvals(s);
  const router=new Router(s,{run:async()=>{},stop:()=>{}} as any,approvals);
  try{
    s.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true}));
    router.brain.secret.save('synthetic-not-a-real-secret');
    globalThis.fetch=async()=>new Response(JSON.stringify({id:'r',created:0,model:'muse-wonder-1.0',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'{"opening":"Good morning.","priorities":[]}'}}]}),{headers:{'content-type':'application/json'}});
    assert.equal(await new MorningBrief(s,router).request('owner@s.whatsapp.net','first-message'),true);
    const rows=metaTimeline(s) as any[];assert.equal(rows.length,1);assert.equal(rows[0].stage,'briefed');assert.equal(rows[0].status,'completed');
    assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT * FROM meta_timeline').all()),/Good morning|synthetic-not-a-real-secret/);
  }finally{globalThis.fetch=originalFetch;approvals.cancel();s.close();}
});


test('contract timeline records actual API calls without storing task content',async()=>{
  const s=fixture(),originalFetch=globalThis.fetch;try{
    globalThis.fetch=async()=>toolResponse('decide',{kind:'contract',goal:'Build a feature',exclusions:[],checks:['Check one','Check two'],question:''});
    await interpretContract('synthetic-key','PRIVATE TASK',[],metaObserver(s,'contracted','owner@s.whatsapp.net'));
    const rows=metaTimeline(s) as any[];assert.equal(rows.length,1);assert.equal(rows[0].stage,'contracted');assert.equal(rows[0].status,'completed');
    assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT * FROM meta_timeline').all()),/PRIVATE TASK|synthetic-key/);
    globalThis.fetch=async()=>new Response('PRIVATE ERROR',{status:503});
    await assert.rejects(interpretContract('synthetic-key','PRIVATE TASK',[],metaObserver(s,'contracted','owner@s.whatsapp.net')));
    assert.equal((metaTimeline(s) as any[])[0].status,'failed');
  }finally{globalThis.fetch=originalFetch;s.close();}
});


test('owner round trip during a Meta call omits the old activity',async()=>{
  const s=fixture();try{
    const owner='owner@s.whatsapp.net',captured=s.captureIncomingOwner(owner,'whatsapp')!;
    let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
    const call=s.incomingOwnerContext.run(captured,()=>metaObserver(s,'sorted',owner,owner)(()=>wait));
    s.set('whatsapp-owner','other@s.whatsapp.net');s.set('whatsapp-owner',owner);release();await call;
    assert.deepEqual(metaTimeline(s),[]);
  }finally{s.close();}
});


test('an owner scope lookup failure does not change the Meta call outcome',async()=>{
  const s=fixture();try{
    const owner='owner@s.whatsapp.net',captured=s.captureIncomingOwner(owner,'whatsapp')!;
    await s.incomingOwnerContext.run(captured,async()=>{
      const observe=metaObserver(s,'sorted',owner,owner);
      s.incomingOwnerCurrent=()=>{throw new Error('synthetic lookup failure');};
      assert.equal(await observe(async()=>42),42);
    });
  }finally{s.close();}
});
