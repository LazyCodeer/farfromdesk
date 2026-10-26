import { existsSync, readFileSync, statSync, accessSync, constants, lstatSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Store } from './store.js';
import { stateDir } from './config.js';
import { VOICE_MODEL, voiceModelProgress } from './voice-model.js';
import { validateAudioConfig } from './audio.js';
import { cloudView } from './voice-cloud.js';

// Verify model integrity with a fixed 64 KiB window, never a model-sized allocation.
export function speechAssetHash(path:string) {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    if(!fstatSync(fd).isFile())throw new Error('Bundled voice assets must be regular files.');
    const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let size:number;
    while((size=readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,size));
    return hash.digest('hex');
  }finally{closeSync(fd);}
}
// Probe only integrity-checked bundled code; unsupported CPUs retain the baseline.
export function selectSpeechVariant(directory:string,data:any,arch:string=process.arch,
  probe:(path:string)=>string=(path)=>{const r=spawnSync(path,[],{encoding:'utf8',timeout:5000,maxBuffer:1024,windowsHide:true});return r.status===0?r.stdout.trim():'';}) {
  const ext=process.platform==='win32'?'.exe':'';
  if(!data.cpuSelection)return join(directory,'whisper-cli'+ext);
  if(arch!=='x64'||data.cpuSelection.probe!=='speech-cpu'+ext||data.cpuSelection.avx2!=='whisper-avx2'+ext)
    throw new Error('Unsupported bundled CPU selection.');
  for(const name of ['speech-cpu'+ext,'whisper-avx2'+ext]) {
    const path=join(directory,name);
    if(!lstatSync(path).isFile()||speechAssetHash(path)!==data.sha256?.[name])throw new Error('Bundled CPU tools failed integrity validation.');
    accessSync(path,constants.X_OK);
  }
  const result=probe(join(directory,'speech-cpu'+ext));
  return join(directory,(result==='avx2'?'whisper-avx2':'whisper-cli')+ext);
}
export const defaultSpeechBundle=fileURLToPath(new URL('../../speech/',import.meta.url));
export function installBundledAudio(store:Store,directory=defaultSpeechBundle,modelDirectory=join(stateDir,'models')) {
  const prior=store.get('audio-config');
  if(prior&&store.get('audio-origin')!=='bundled') {
    try {validateAudioConfig(JSON.parse(prior));return {configured:true,preserved:true};}catch{}
  }
  // Revalidate bundled assets once each launch, including after relocation/update.
  if(store.get('audio-origin')==='bundled')store.set('audio-config','');
  store.set('audio-tools','');
  const manifest=join(directory,'manifest.json');
  if(!existsSync(manifest))return {configured:false,preserved:false};
  const data=JSON.parse(readFileSync(manifest,'utf8'));
  const ext=process.platform==='win32'?'.exe':'';
  if(data.platform&&data.platform!==process.platform)throw new Error('Bundled voice assets target a different platform.');
  if(data.schema!==1||data.architecture!==process.arch||data.ffmpeg!=='ffmpeg'+ext||data.whisper!=='whisper-cli'+ext||data.model!=='ggml-base.bin')throw new Error('Bundled voice assets have an unsupported manifest.');
  const config={ffmpeg:join(directory,'ffmpeg'+ext),whisper:join(directory,'whisper-cli'+ext),model:join(directory,'ggml-base.bin')};
  const deferred=data.modelDelivery==='first-use';
  if(deferred&&data.sha256?.['ggml-base.bin']!==VOICE_MODEL.sha256)throw new Error('Unsupported downloadable voice model.');
  if(!deferred)validateAudioConfig(config);
  for(const path of (deferred?[config.ffmpeg,config.whisper]:Object.values(config))) {
    if(!lstatSync(path).isFile())throw new Error('Bundled voice assets must be regular files.');
    const name=basename(path),expected=data.sha256?.[name];
    if(typeof expected!=='string'||speechAssetHash(path)!==expected)throw new Error('Bundled voice assets failed integrity validation. Reinstall the app.');
  }
  for(const tool of [config.ffmpeg,config.whisper])accessSync(tool,constants.X_OK);
  config.whisper=selectSpeechVariant(directory,data);
  if(deferred) {
    const {model:unused,...tools}=config;store.set('audio-tools',JSON.stringify(tools));
    config.model=join(modelDirectory,'ggml-base.bin');
    if(!existsSync(config.model)||!lstatSync(config.model).isFile()||speechAssetHash(config.model)!==VOICE_MODEL.sha256) {
      store.set('audio-config','');store.set('audio-origin','bundled');return {configured:false,preserved:false};
    }
  }
  store.set('audio-config',JSON.stringify(config));store.set('audio-origin','bundled');
  return {configured:true,preserved:false};
}
export function audioReadiness(store:Store) {
  const cloud=cloudView(store),local=localReadiness(store);
  return cloud.engine==='local'?{...local,...cloud}:{...local,...cloud,ready:true,local:false};
}
function localReadiness(store:Store) {
  try {
    const config=validateAudioConfig(JSON.parse(store.get('audio-config')??'null'));
    for(const tool of [config.ffmpeg,config.whisper])accessSync(tool,constants.X_OK);
    if(!statSync(config.model).size)throw new Error('Empty model');
    return {ready:true,local:true,localReady:true,bundled:store.get('audio-origin')==='bundled'};
  }catch{return {ready:false,local:true,localReady:false,bundled:false,...(store.get('audio-tools')?{download:voiceModelProgress(store)}:{})};}
}
