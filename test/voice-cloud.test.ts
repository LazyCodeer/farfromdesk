import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,statSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'ffd-voice-cloud-'));
process.env.WSB_STATE_DIR=dir;
const {Store}=await import('../src/store.js');
const cloud=await import('../src/voice-cloud.js');
const {audioReadiness}=await import('../src/speech-bundle.js');
const KEY='dg_abcdefghijklmnopqrstuvwxyz0123a91f';
const note=join(dir,'note.ogg');writeFileSync(note,Buffer.from('fake opus bytes'));
function fake(routes:Record<string,(init:any)=>Response>) {
  const calls:{url:string;init:any}[]=[];
  const fetcher=(async(url:string,init:any)=>{calls.push({url,init});const hit=Object.keys(routes).find(k=>url.startsWith(k));if(!hit)throw new Error('unexpected '+url);return routes[hit](init);}) as any as typeof fetch;
  return {fetcher,calls};
}
const json=(body:any,status=200)=>new Response(JSON.stringify(body),{status});

test('the key is stored owner-only outside SQLite and only its last 4 characters are shown',()=>{
  const store=new Store(':memory:');
  try {
    assert.equal(cloud.voiceEngine(store),'local');
    cloud.writeVoiceKey('deepgram',KEY);store.set('voice-engine','deepgram');
    if(process.platform!=='win32')assert.equal(statSync(join(dir,'voice-api-key')).mode&0o777,0o600);
    const view=audioReadiness(store) as any;
    assert.equal(view.ready,true);assert.equal(view.engine,'deepgram');assert.equal(view.keyHint,'a91f');
    assert.equal(JSON.stringify(view).includes(KEY),false);
    assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM settings').all()).includes(KEY),false);
    cloud.removeVoiceKey();assert.equal(cloud.voiceEngine(store),'local');
  }finally{store.close();}
});

test('pasted keys are trimmed and obvious junk is refused before any network call',()=>{
  assert.equal(cloud.cleanKey(`  ${KEY}\n`),KEY);
  for(const bad of ['short','has spaces in the middle of it ok','x'.repeat(201),undefined])assert.throws(()=>cloud.cleanKey(bad),/doesn’t look like an API key/);
});

test('a rejected key gives a clear message and never echoes the provider response',async()=>{
  const f=fake({'https://api.deepgram.com/v1/projects':()=>json({err_msg:'secret detail'},401)});
  await assert.rejects(cloud.testVoiceKey('deepgram',KEY,f.fetcher),e=>/Deepgram rejected this API key/.test(e.message)&&!/secret detail/.test(e.message));
  assert.equal(f.calls[0].init.headers.authorization,`Token ${KEY}`);
  const q=fake({'https://api.assemblyai.com/v2/transcript':()=>json({},402)});
  await assert.rejects(cloud.testVoiceKey('assemblyai',KEY,q.fetcher),/free credit may be used up/);
});

test('Deepgram uses multilingual nova-3 and returns the transcript',async()=>{
  const f=fake({'https://api.deepgram.com/v1/listen':()=>json({results:{channels:[{alternatives:[{transcript:' PR merge kar do '}]}]}})});
  assert.equal(await cloud.transcribeCloud('deepgram',KEY,note,'audio/ogg',undefined,{fetcher:f.fetcher}),'PR merge kar do');
  assert.match(f.calls[0].url,/model=nova-3&language=multi/);
  assert.equal(f.calls[0].init.headers['content-type'],'audio/ogg');
  const empty=fake({'https://api.deepgram.com/v1/listen':()=>json({results:{channels:[{alternatives:[{transcript:''}]}]}})});
  await assert.rejects(cloud.transcribeCloud('deepgram',KEY,note,'audio/ogg',undefined,{fetcher:empty.fetcher}),/No clear speech/);
});

test('AssemblyAI uploads, requests language detection and polls until complete',async()=>{
  let polls=0;
  const f=fake({
    'https://api.assemblyai.com/v2/upload':()=>json({upload_url:'https://cdn.assemblyai.com/upload/1'}),
    'https://api.assemblyai.com/v2/transcript/t-1':()=>json(++polls<2?{status:'processing'}:{status:'completed',text:'Fix the build'}),
    'https://api.assemblyai.com/v2/transcript':()=>json({id:'t-1',status:'queued'}),
  });
  assert.equal(await cloud.transcribeCloud('assemblyai',KEY,note,'audio/ogg',undefined,{fetcher:f.fetcher,pollMs:1}),'Fix the build');
  const create=JSON.parse(f.calls[1].init.body);
  assert.equal(create.language_detection,true);assert.deepEqual(create.speech_models,['universal-3-5-pro','universal-2']);
  assert.equal(f.calls[0].init.headers.authorization,KEY);
  const failed=fake({'https://api.assemblyai.com/v2/upload':()=>json({upload_url:'u'}),'https://api.assemblyai.com/v2/transcript/t-2':()=>json({status:'error',error:'provider detail'}),'https://api.assemblyai.com/v2/transcript':()=>json({id:'t-2'})});
  await assert.rejects(cloud.transcribeCloud('assemblyai',KEY,note,'audio/ogg',undefined,{fetcher:failed.fetcher,pollMs:1}),e=>!/provider detail/.test(e.message));
});

test('network failures name the provider and point at the connection',async()=>{
  const f={fetcher:(async()=>{throw new TypeError('fetch failed');}) as any as typeof fetch};
  await assert.rejects(cloud.transcribeCloud('deepgram',KEY,note,'audio/ogg',undefined,f),/Couldn’t reach Deepgram/);
  assert.ok(readFileSync(note).length);
});

test('Meta checks the key read-only and sends a WAV clip to Muse Voice Transcribe',async()=>{
  const wav=join(dir,'note.wav');writeFileSync(wav,Buffer.from('RIFF fake wav'));
  const f=fake({'https://api.meta.ai/v1/models':()=>json({data:[]}),'https://api.meta.ai/v1/asr/transcribe':()=>json({transcript:' Ask Codex for an update ',turns:[]})});
  await cloud.testVoiceKey('meta',KEY,f.fetcher);
  assert.equal(f.calls[0].init.headers.authorization,`Bearer ${KEY}`);assert.equal(f.calls[0].init.redirect,'error');
  assert.equal(await cloud.transcribeCloud('meta',KEY,wav,'audio/wav',undefined,{fetcher:f.fetcher}),'Ask Codex for an update');
  const form=f.calls[1].init.body as FormData,request=JSON.parse(await (form.get('request') as Blob).text());
  assert.deepEqual(request,{model:'muse-voice-transcribe-1.0',audioEncoding:'WAV',mode:'PUSH_TO_TALK'});
  assert.equal((form.get('audio') as Blob).type,'audio/wav');assert.equal(cloud.needsWav('meta'),true);assert.equal(cloud.needsWav('deepgram'),false);
  const bad=fake({'https://api.meta.ai/v1/asr/transcribe':()=>json({error:{message:'secret detail'}},401)});
  await assert.rejects(cloud.transcribeCloud('meta',KEY,wav,'audio/wav',undefined,{fetcher:bad.fetcher}),e=>/Meta rejected this API key/.test(e.message)&&!/secret detail/.test(e.message));
});

test('repeated words from Meta are collapsed',()=>{
  for(const [raw,clean] of [['send me me the summary','send me the summary'],['Ask Codex Codex for for an update','Ask Codex for an update'],['Ask Codex for Codex for an update on on P1','Ask Codex for an update on P1'],['Telegram Reconnect reconnect tests','Telegram Reconnect tests'],['P1 and P2 are done','P1 and P2 are done'],['Codex वाला सेशन','Codex वाला सेशन']])assert.equal(cloud.collapseRepeats(raw),clean);
});
