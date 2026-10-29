import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Set the state before any app module import; tests must never see installed state.
const root=mkdtempSync(join(tmpdir(),'ffd-meta-timeline-'));
process.env.WSB_STATE_DIR=root;process.env.FARFROMDESK_HOME=join(root,'home');
test.after(()=>rmSync(root,{recursive:true,force:true}));
const {Store}=await import('../src/store.js');
const {metaObserver,metaTimeline}=await import('../src/meta-timeline.js');
const {MetaModel}=await import('../src/meta-model.js');
const {DEFAULT_BRAIN}=await import('../src/meta-brain-config.js');
const {interpretSchedule}=await import('../src/schedule-model.js');
const {transcribeCloud}=await import('../src/voice-cloud.js');
const {MorningBrief}=await import('../src/morning-brief.js');
const {Router}=await import('../src/router.js');
const {Approvals}=await import('../src/approvals.js');

function fixture(){const store=new Store(':memory:');store.set('whatsapp-owner','owner@s.whatsapp.net');return store;}
const toolResponse=(name:string,args:unknown)=>new Response(JSON.stringify({id:'r',created:0,model:'muse-wonder-1.0',choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'call_1',type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]}),{headers:{'content-type':'application/json'}});

test('only fixed labels, status and duration are stored, scoped to the original owner and chat',async()=>{
  const s=fixture();try{
    const observe=metaObserver(s,'sorted');await observe(async()=>new Response('SYNTHETIC_SECRET'));
    await assert.rejects(observe(async()=>{throw Error('SYNTHETIC_SECRET');}));
    const rows=metaTimeline(s) as any[];assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.status),['failed','completed']);
    assert.ok(rows.every(r=>r.stage==='sorted'&&r.durationMs>=0&&Number.isFinite(r.at)));
    assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT * FROM meta_timeline').all()),/SYNTHETIC_SECRET|owner@s/);
    s.set('whatsapp-owner','other@s.whatsapp.net');assert.deepEqual(metaTimeline(s),[]);
    s.set('whatsapp-owner','owner@s.whatsapp.net');assert.equal(metaTimeline(s).length,2);
    s.set('destination-jid','group@g.us');s.set('owned-group:group@g.us','Test group');assert.deepEqual(metaTimeline(s),[]);
    await metaObserver(s,'briefed')(()=>Promise.resolve('ok'));assert.equal(metaTimeline(s).length,1);
    s.set('destination-jid','owner@s.whatsapp.net');assert.equal(metaTimeline(s).length,2);
  }finally{s.close();}
});

test('timeline is bounded and telemetry errors never break the actual call',async()=>{
  const s=fixture();const observe=metaObserver(s,'sorted');
  try{for(let i=0;i<1010;i++)await observe(async()=>true);assert.equal(Number((s.db.prepare('SELECT COUNT(*) n FROM meta_timeline').get() as any).n),1000);assert.equal(metaTimeline(s).length,30);}finally{s.close();}
  assert.equal(await observe(async()=>42),42);
});

test('a call finishing after re-pairing remains attributed to the original owner',async()=>{
  const s=fixture();try{
    let release!:()=>void;const wait=new Promise<void>(r=>{release=r;});
    const call=metaObserver(s,'sorted')(()=>wait);
    s.set('whatsapp-owner','other@s.whatsapp.net');release();await call;
    assert.deepEqual(metaTimeline(s),[]);
    s.set('whatsapp-owner','owner@s.whatsapp.net');assert.equal(metaTimeline(s).length,1);
  }finally{s.close();}
});

test('a failed Meta HTTP call records failure without exposing provider details',async()=>{
  const s=fixture();try{
    const model=new MetaModel(async()=>new Response('SYNTHETIC_PRIVATE_PROVIDER_ERROR',{status:401}));
    await assert.rejects(model.interpret('synthetic-key',DEFAULT_BRAIN,{original:'Hello',source:'text',tasks:[]},undefined,metaObserver(s,'sorted')));
    const rows=metaTimeline(s) as any[];assert.equal(rows.length,1);assert.equal(rows[0].status,'failed');
    assert.doesNotMatch(JSON.stringify(rows),/SYNTHETIC_PRIVATE_PROVIDER_ERROR|synthetic-key/);
  }finally{s.close();}
});

test('actual Brain, reminder and Meta voice requests each record a completed call',async()=>{
  const s=fixture(),originalFetch=globalThis.fetch;try{
    const model=new MetaModel(async()=>toolResponse('decide',{intent:'chat',normalized:'Hello',provider:'unspecified',taskIds:[],reply:'Hi'}));
    await model.interpret('synthetic-key',DEFAULT_BRAIN,{original:'Hello',source:'text',tasks:[]},undefined,metaObserver(s,'sorted'));
    globalThis.fetch=async()=>toolResponse('decide',{kind:'create',action:'message',date:'2026-10-30',time:'18:00',zone:'Asia/Kolkata',repeat:'once',text:'call the bank',target:'',question:''});
    await interpretSchedule('Remind me tomorrow at 6 PM to call the bank',Date.parse('2026-10-29T02:00:00Z'),'Asia/Kolkata','synthetic-key',metaObserver(s,'scheduled'));
    const wav=join(root,'synthetic.wav');writeFileSync(wav,Buffer.from('synthetic'));
    await transcribeCloud('meta','synthetic-key',wav,'audio/wav',undefined,{fetcher:async()=>new Response(JSON.stringify({transcript:'Hello'}),{headers:{'content-type':'application/json'}}),onMetaCall:metaObserver(s,'heard')});
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
