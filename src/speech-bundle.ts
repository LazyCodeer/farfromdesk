import { existsSync, readFileSync, statSync, accessSync, constants, lstatSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Store } from './store.js';
import { validateAudioConfig } from './audio.js';

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
export const defaultSpeechBundle=fileURLToPath(new URL('../../speech/',import.meta.url));
export function installBundledAudio(store:Store,directory=defaultSpeechBundle) {
  const prior=store.get('audio-config');
  if(prior&&store.get('audio-origin')!=='bundled') {
    try {validateAudioConfig(JSON.parse(prior));return {configured:true,preserved:true};}catch{}
  }
  // Revalidate bundled assets once each launch, including after relocation/update.
  if(store.get('audio-origin')==='bundled')store.set('audio-config','');
  const manifest=join(directory,'manifest.json');
  if(!existsSync(manifest))return {configured:false,preserved:false};
  const data=JSON.parse(readFileSync(manifest,'utf8'));
  if(data.schema!==1||data.architecture!==process.arch||data.ffmpeg!=='ffmpeg'||data.whisper!=='whisper-cli'||data.model!=='ggml-base.bin')throw new Error('Bundled voice assets have an unsupported manifest.');
  const config={ffmpeg:join(directory,'ffmpeg'),whisper:join(directory,'whisper-cli'),model:join(directory,'ggml-base.bin')};
  validateAudioConfig(config);
  for(const path of Object.values(config)) {
    if(!lstatSync(path).isFile())throw new Error('Bundled voice assets must be regular files.');
    const name=basename(path),expected=data.sha256?.[name];
    if(typeof expected!=='string'||speechAssetHash(path)!==expected)throw new Error('Bundled voice assets failed integrity validation. Reinstall the app.');
  }
  for(const tool of [config.ffmpeg,config.whisper])accessSync(tool,constants.X_OK);
  store.set('audio-config',JSON.stringify(config));store.set('audio-origin','bundled');
  return {configured:true,preserved:false};
}
export function audioReadiness(store:Store) {
  try {
    const config=validateAudioConfig(JSON.parse(store.get('audio-config')??'null'));
    for(const tool of [config.ffmpeg,config.whisper])accessSync(tool,constants.X_OK);
    if(!statSync(config.model).size)throw new Error('Empty model');
    return {ready:true,local:true,bundled:store.get('audio-origin')==='bundled'};
  }catch{return {ready:false,local:true,bundled:false};}
}
