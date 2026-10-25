import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const speech=resolve('build/speech');
const ext=process.platform==='win32'?'.exe':'';
const result=spawnSync(process.execPath,['--import','tsx','--test','test/media-local.test.ts'],{
  stdio:'inherit',timeout:180000,env:{...process.env,
    WSB_AUDIO_TEST_FFMPEG:join(speech,'ffmpeg'+ext),
    WSB_AUDIO_TEST_WHISPER:join(speech,'whisper-cli'+ext),
    WSB_AUDIO_TEST_MODEL:join(speech,'ggml-base.bin')}});
if(result.error)throw result.error;
process.exit(result.status??1);
