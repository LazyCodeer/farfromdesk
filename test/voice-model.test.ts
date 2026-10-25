import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from '../src/store.js';
import {ensureVoiceModel,voiceModelProgress,prepareVoiceModel} from '../src/voice-model.js';
function fixture() {
  const store=new Store(':memory:'),root=mkdtempSync(join(tmpdir(),'ffd-model-'));
  const data=Buffer.from('small pinned model fixture');
  const model={url:'https://example.test/model',bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};
  let calls=0;
  const fetcher=(async()=>{calls++;const r=new Response(data);Object.defineProperty(r,'url',{value:model.url});return r;}) as typeof fetch;
  return {store,root,data,model,fetcher,calls:()=>calls,close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}
test('concurrent first notes share one verified download and later requests reuse cache',async()=>{
  const f=fixture();try {
    const options={root:f.root,fetcher:f.fetcher,model:f.model};
    const [a,b]=await Promise.all([ensureVoiceModel(f.store,options),ensureVoiceModel(f.store,options)]);
    assert.equal(a,b);assert.equal(f.calls(),1);assert.deepEqual(readFileSync(a),f.data);
    assert.equal(voiceModelProgress(f.store).state,'ready');
    await ensureVoiceModel(f.store,options);assert.equal(f.calls(),1);
    assert.equal(existsSync(join(f.root,'models/ggml-base.bin.partial')),false);
  }finally{f.close();}
});
test('failed integrity check removes partial data and can retry the same model',async()=>{
  const f=fixture();try {
    const bad=(async()=>{const r=new Response(Buffer.alloc(f.model.bytes));Object.defineProperty(r,'url',{value:f.model.url});return r;}) as typeof fetch;
    await assert.rejects(ensureVoiceModel(f.store,{root:f.root,fetcher:bad,model:f.model}),/download did not finish/);
    assert.equal(voiceModelProgress(f.store).state,'failed');
    assert.equal(existsSync(join(f.root,'models/ggml-base.bin')),false);
    assert.equal(existsSync(join(f.root,'models/ggml-base.bin.partial')),false);
    await ensureVoiceModel(f.store,{root:f.root,fetcher:f.fetcher,model:f.model});
    assert.equal(voiceModelProgress(f.store).state,'ready');
  }finally{f.close();}
});
test('streamed chunks append correctly and rejected headers cancel the response',async()=>{
  const f=fixture();try {
    let cancelled=false;
    const rejected=(async()=>{
      const r=new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-length':'1'}});
      Object.defineProperty(r,'url',{value:f.model.url});return r;
    }) as typeof fetch;
    await assert.rejects(ensureVoiceModel(f.store,{root:f.root,model:f.model,fetcher:rejected}));
    assert.equal(cancelled,true);
    const streamed=(async()=>{
      const r=new Response(new ReadableStream({start(c){c.enqueue(f.data.subarray(0,5));c.enqueue(f.data.subarray(5));c.close();}}));
      Object.defineProperty(r,'url',{value:f.model.url});return r;
    }) as typeof fetch;
    const file=await ensureVoiceModel(f.store,{root:f.root,model:f.model,fetcher:streamed});
    assert.deepEqual(readFileSync(file),f.data);
  }finally{f.close();}
});
test('offline and oversized responses never install an unusable model',async()=>{
  for(const oversize of [false,true]) {
    const f=fixture();try {
      const fetcher=(async()=>{if(!oversize)throw new Error('offline');const r=new Response(Buffer.alloc(f.model.bytes+1));Object.defineProperty(r,'url',{value:f.model.url});return r;}) as typeof fetch;
      await assert.rejects(ensureVoiceModel(f.store,{root:f.root,fetcher,model:f.model}));
      assert.equal(existsSync(join(f.root,'models/ggml-base.bin')),false);
    }finally{f.close();}
  }
});

test('preparing voice commits configuration only after verification and preserves a custom selection',async()=>{
 const f=fixture();try {
  f.store.set('audio-tools',JSON.stringify({ffmpeg:'/bundled/ffmpeg',whisper:'/bundled/whisper'}));
  await prepareVoiceModel(f.store,{root:f.root,model:f.model,fetcher:f.fetcher});
  assert.equal(JSON.parse(f.store.get('audio-config')!).model,join(f.root,'models/ggml-base.bin'));
  f.store.set('audio-config','custom selection');f.store.set('audio-origin','local');
  await prepareVoiceModel(f.store,{root:f.root,model:f.model,fetcher:f.fetcher});
  assert.equal(f.store.get('audio-config'),'custom selection');
 }finally{f.close();}
});
