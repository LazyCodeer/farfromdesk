import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {installBundledAudio} from '../dist/speech-bundle.js';
import {Store} from '../dist/store.js';
const store=new Store(':memory:');
installBundledAudio(store,resolve('build/speech'));
const config=JSON.parse(store.get('audio-config'));store.close();
console.log('Testing bundled speech selection:',config.whisper.split(/[\\/]/).pop());
const result=spawnSync(process.execPath,['--import','tsx','--test','test/media-local.test.ts'],{
  stdio:'inherit',timeout:240000,env:{...process.env,
    WSB_AUDIO_TEST_FFMPEG:config.ffmpeg,
    WSB_AUDIO_TEST_WHISPER:config.whisper,
    WSB_AUDIO_TEST_MODEL:config.model}});
if(result.error)throw result.error;
process.exit(result.status??1);
