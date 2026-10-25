import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { installBundledAudio,audioReadiness } from '../src/speech-bundle.js';

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'speech-bundle-')),store=new Store(':memory:');
  const manifest:any={schema:1,architecture:process.arch,ffmpeg:'ffmpeg',whisper:'whisper-cli',model:'ggml-base.bin',sha256:{}};
  for(const file of ['ffmpeg','whisper-cli','ggml-base.bin']){const data=Buffer.from('fixture '+file);writeFileSync(join(dir,file),data,{mode:0o700});manifest.sha256[file]=createHash('sha256').update(data).digest('hex');}
  writeFileSync(join(dir,'manifest.json'),JSON.stringify(manifest));
  return {dir,store,manifest,close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('fresh installation configures bundled files without downloads or processes',()=>{
  const f=fixture();try {
    assert.equal(audioReadiness(f.store).ready,false);
    assert.deepEqual(installBundledAudio(f.store,f.dir),{configured:true,preserved:false});
    assert.deepEqual(audioReadiness(f.store),{ready:true,local:true,bundled:true});
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
    const custom={ffmpeg:join(f.dir,'ffmpeg'),whisper:join(f.dir,'whisper-cli'),model:join(f.dir,'ggml-base.bin')};
    f.store.set('audio-config',JSON.stringify(custom));assert.equal(installBundledAudio(f.store,f.dir).preserved,true);assert.equal(f.store.get('audio-origin'),undefined);
    f.store.set('audio-config',JSON.stringify({...custom,model:'/missing-model'}));assert.equal(installBundledAudio(f.store,f.dir).preserved,false);
    assert.equal(audioReadiness(f.store).ready,true);
  }finally{f.close();}
});
