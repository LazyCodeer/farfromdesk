import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcribeLocal } from '../src/audio.js';

test('installed local speech engine decodes Ogg/Opus and rejects silence/corruption, cleaning recordings', {skip:!process.env.WSB_AUDIO_TEST_MODEL},async()=>{
  const root=mkdtempSync(join(tmpdir(),'wsb-local-audio-'));
  const config={ffmpeg:process.env.WSB_AUDIO_TEST_FFMPEG!,whisper:process.env.WSB_AUDIO_TEST_WHISPER!,model:process.env.WSB_AUDIO_TEST_MODEL!};
  try {
    // The shipping FFmpeg deliberately only decodes. Use a fixed synthetic Ogg
    // fixture so testing doesn't require shipping an encoder or lavfi filters.
    const ogg=process.env.WSB_AUDIO_TEST_SAMPLE??fileURLToPath(new URL('./fixtures/local-english.ogg',import.meta.url));
    const started=performance.now();
    console.log('Local speech fixture: Ogg/Opus transcription started');
    const text=await transcribeLocal(readFileSync(ogg),'ogg',config,root);assert.match(text,/country/i);
    console.log(`Local speech fixture: plausible transcript in ${Math.round(performance.now()-started)} ms`);
    const silence=Buffer.alloc(44+16000*2*2);
    silence.write('RIFF');silence.writeUInt32LE(silence.length-8,4);silence.write('WAVEfmt ',8);
    silence.writeUInt32LE(16,16);silence.writeUInt16LE(1,20);silence.writeUInt16LE(1,22);
    silence.writeUInt32LE(16000,24);silence.writeUInt32LE(32000,28);silence.writeUInt16LE(2,32);silence.writeUInt16LE(16,34);
    silence.write('data',36);silence.writeUInt32LE(silence.length-44,40);
    await assert.rejects(transcribeLocal(silence,'wav',config,root),/No clear speech/);
    await assert.rejects(transcribeLocal(Buffer.from('invalid ogg'),'ogg',config,root));
    assert.deepEqual(readdirSync(join(root,'audio-tmp')),[]);
  }finally{rmSync(root,{recursive:true,force:true});}
});
