import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {VOICE_MODEL} from '../src/voice-model.js';
// Load configuration only after assigning a test-owned state directory.
// A fresh-install test must never depend on the developer's saved voice key.
const stateRoot=mkdtempSync(join(tmpdir(),'speech-bundle-state-'));
process.env.WSB_STATE_DIR=stateRoot;
test.after(()=>rmSync(stateRoot,{recursive:true,force:true}));
const {Store}=await import('../src/store.js');
const {installBundledAudio,audioReadiness,selectSpeechVariant}=await import('../src/speech-bundle.js');

const suffix=process.platform==='win32'?'.exe':'';
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'speech-bundle-')),store=new Store(':memory:');
  const manifest:any={schema:1,architecture:process.arch,ffmpeg:'ffmpeg'+suffix,whisper:'whisper-cli'+suffix,model:'ggml-base.bin',sha256:{}};
  for(const file of ['ffmpeg'+suffix,'whisper-cli'+suffix,'ggml-base.bin']){const data=Buffer.from('fixture '+file);writeFileSync(join(dir,file),data,{mode:0o700});manifest.sha256[file]=createHash('sha256').update(data).digest('hex');}
  writeFileSync(join(dir,'manifest.json'),JSON.stringify(manifest));
  return {dir,store,manifest,close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('fresh installation configures bundled files without downloads or processes',()=>{
  const f=fixture();try {
    assert.equal(audioReadiness(f.store).ready,false);
    assert.deepEqual(installBundledAudio(f.store,f.dir),{configured:true,preserved:false});
    assert.deepEqual(audioReadiness(f.store),{ready:true,local:true,localReady:true,bundled:true,engine:'local',fallback:true});
    assert.equal(JSON.parse(f.store.get('audio-config')!).model,join(f.dir,'ggml-base.bin'));
    assert.equal(installBundledAudio(f.store,f.dir).preserved,false);
    writeFileSync(join(f.dir,'ggml-base.bin'),'modified after installation');
    assert.throws(()=>installBundledAudio(f.store,f.dir));assert.equal(audioReadiness(f.store).ready,false);
  }finally{f.close();}
});
test('missing, corrupt, wrong-architecture and traversal manifests cannot enable voice',()=>{
  for(const defect of ['missing','corrupt','arch','traversal']) {
    const f=fixture();try {
      if(defect==='missing'){rmSync(join(f.dir,'manifest.json'));assert.equal(installBundledAudio(f.store,f.dir).configured,false);}
      else {
        if(defect==='corrupt')writeFileSync(join(f.dir,'ggml-base.bin'),'tampered');
        if(defect==='arch')f.manifest.architecture='wrong';
        if(defect==='traversal')f.manifest.model='../private';
        writeFileSync(join(f.dir,'manifest.json'),JSON.stringify(f.manifest));
        assert.throws(()=>installBundledAudio(f.store,f.dir));
      }
      assert.equal(f.store.get('audio-config'),undefined);
    }finally{f.close();}
  }
});
test('existing valid custom configuration is preserved; stale paths recover from the bundle',()=>{
  const f=fixture();try {
    const custom={ffmpeg:join(f.dir,'ffmpeg'+suffix),whisper:join(f.dir,'whisper-cli'+suffix),model:join(f.dir,'ggml-base.bin')};
    f.store.set('audio-config',JSON.stringify(custom));assert.equal(installBundledAudio(f.store,f.dir).preserved,true);assert.equal(f.store.get('audio-origin'),undefined);
    f.store.set('audio-config',JSON.stringify({...custom,model:'/missing-model'}));assert.equal(installBundledAudio(f.store,f.dir).preserved,false);
    assert.equal(audioReadiness(f.store).ready,true);
  }finally{f.close();}
});

test('CPU selection checks helper integrity before execution and keeps unsupported CPUs on baseline',()=>{
  const f=fixture();let calls=0;
  const ext=process.platform==='win32'?'.exe':'';
  try {
    for(const name of ['speech-cpu'+ext,'whisper-avx2'+ext]) {
      const bytes=Buffer.from('fixture '+name);writeFileSync(join(f.dir,name),bytes,{mode:0o700});
      f.manifest.sha256[name]=createHash('sha256').update(bytes).digest('hex');
    }
    f.manifest.cpuSelection={probe:'speech-cpu'+ext,avx2:'whisper-avx2'+ext};
    const probe=(result:string)=>(path:string)=>{calls++;assert.equal(path,join(f.dir,'speech-cpu'+ext));return result;};
    assert.equal(selectSpeechVariant(f.dir,f.manifest,'x64',probe('avx2')),join(f.dir,'whisper-avx2'+ext));
    for(const result of ['baseline','','unexpected'])assert.equal(selectSpeechVariant(f.dir,f.manifest,'x64',probe(result)),join(f.dir,'whisper-cli'+ext));
    assert.throws(()=>selectSpeechVariant(f.dir,f.manifest,'arm64',probe('avx2')));
    f.manifest.cpuSelection.probe='../private';assert.throws(()=>selectSpeechVariant(f.dir,f.manifest,'x64',probe('avx2')));
    f.manifest.cpuSelection.probe='speech-cpu'+ext;
    writeFileSync(join(f.dir,'whisper-avx2'+ext),'tampered');
    assert.throws(()=>selectSpeechVariant(f.dir,f.manifest,'x64',probe('avx2')));assert.equal(calls,4);
  }finally{f.close();}
});


test('first-use bundle validates tools and exposes download instead of claiming voice is ready',()=>{
  const f=fixture();try {
    rmSync(join(f.dir,'ggml-base.bin'));
    f.manifest.modelDelivery='first-use';f.manifest.sha256['ggml-base.bin']=VOICE_MODEL.sha256;
    writeFileSync(join(f.dir,'manifest.json'),JSON.stringify(f.manifest));
    installBundledAudio(f.store,f.dir,join(f.dir,'cache'));
    assert.ok(f.store.get('audio-tools'));
    const status=audioReadiness(f.store);
    assert.equal(status.ready,false);assert.equal(status.download?.state,'needed');
    f.manifest.sha256['ggml-base.bin']='0'.repeat(64);
    writeFileSync(join(f.dir,'manifest.json'),JSON.stringify(f.manifest));
    assert.throws(()=>installBundledAudio(f.store,f.dir),/Unsupported downloadable/);
  }finally{f.close();}
});
