import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, copyFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { streamMediaDownload, isDownloadedMedia, requireDiskSpace, type DownloadedMedia } from './media-download.js';
import { digestFileSync } from './large-file.js';
import { stateDir } from './config.js';
import type { Store } from './store.js';
import { errorCode, type VoiceStage, type VoiceStageEvent } from './request-events.js';

export type AudioObserver=(event:VoiceStageEvent)=>void;
export async function measureVoiceStage<T>(stage:VoiceStage,operation:()=>Promise<T>,observe?:AudioObserver):Promise<T> {
  const started=performance.now();
  const notify=(event:VoiceStageEvent)=>{try{observe?.(event);}catch{/* Telemetry failure must not change recognition or delivery. */}};
  notify({stage,state:'started'});
  try {const result=await operation();notify({stage,state:'completed',durationMs:performance.now()-started});return result;}
  catch(error){notify({stage,state:'failed',durationMs:performance.now()-started,code:errorCode(error)});throw error;}
}

const exec=promisify(execFile);
export const MAX_AUDIO_SECONDS=300; // Local transcription budget, not a WhatsApp file-size limit.
export type AudioConfig={ffmpeg:string;whisper:string;model:string};
const formats:Record<string,string>={'audio/ogg':'ogg','audio/opus':'ogg','audio/mpeg':'mp3','audio/mp4':'mov','audio/aac':'aac','audio/wav':'wav','audio/x-wav':'wav','audio/flac':'flac','audio/webm':'matroska','audio/amr':'amr'};
export function validateAudioConfig(config:any):AudioConfig {
  for(const k of ['ffmpeg','whisper','model'])if(typeof config?.[k]!=='string'||!isAbsolute(config[k])||!existsSync(config[k])||!statSync(config[k]).isFile())throw new Error('Configure existing absolute paths for FFmpeg, whisper-cli and a local Whisper model.');
  return {ffmpeg:config.ffmpeg,whisper:config.whisper,model:config.model};
}
export function audioFormat(audio:any) {
  const mime=String(audio?.mimetype??'').split(';')[0].trim().toLowerCase(),format=formats[mime];
  if(!format)throw new Error('Unsupported voice-note format. Please resend as a WhatsApp voice note or type your message.');
  if(!Number.isSafeInteger(Number(audio.fileLength??0))||Number(audio.fileLength??0)<0)throw new Error('Invalid voice-note byte count.');
  if(Number(audio.seconds??0)>MAX_AUDIO_SECONDS)throw new Error('Voice notes must be at most 5 minutes for local transcription. Please send a shorter recording.');
  return format;
}
export function hasAudibleSamples(wav:Buffer) {
  // FFmpeg emits mono 16-bit PCM. Reject silence before Whisper, which can
  // hallucinate short words on a silent recording.
  if(wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE')return false;
  for(let offset=12;offset+8<=wav.length;) {
    const size=wav.readUInt32LE(offset+4),start=offset+8;
    if(start+size>wav.length)return false;
    if(wav.toString('ascii',offset,offset+4)==='data') {
      let energy=0,peak=0;
      for(let i=start;i+1<start+size;i+=2){const sample=wav.readInt16LE(i)/32768;energy+=sample*sample;peak=Math.max(peak,Math.abs(sample));}
      return size>0&&Math.sqrt(energy/(size/2))>0.0003&&peak>0.003;
    }
    offset=start+size+(size%2);
  }
  return false;
}
export async function downloadAudio(audio:any,signal?:AbortSignal):Promise<DownloadedMedia> {
  audioFormat(audio);
  return streamMediaDownload(audio,'audio','voice.bin',Number.MAX_SAFE_INTEGER,signal);
}
export async function transcribeLocal(data:Buffer|DownloadedMedia,format:string,config:AudioConfig,root=stateDir,signal?:AbortSignal,observe?:AudioObserver):Promise<string> {
  if((Buffer.isBuffer(data)?!data.length:!isDownloadedMedia(data))||!Object.values(formats).includes(format))throw new Error('Invalid audio input.');
  validateAudioConfig(config);
  const parent=join(root,'audio-tmp');await mkdir(parent,{recursive:true,mode:0o700});
  const dir=await mkdtemp(join(parent,'note-')),input=join(dir,'input'),wav=join(dir,'audio.wav'),output=join(dir,'transcript');
  try {
    if(Buffer.isBuffer(data))await writeFile(input,data,{mode:0o600});
    else {requireDiskSpace(dir,data.bytes);await copyFile(data.path,input);const check=digestFileSync(input,'voice.bin',Number.MAX_SAFE_INTEGER);if(check.bytes!==data.bytes||check.sha256!==data.sha256)throw new Error('Voice note integrity check failed.');}
    const pcm=await measureVoiceStage('decode',async()=>{
      await exec(config.ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-protocol_whitelist','file,pipe','-f',format,'-i',input,'-vn','-ac','1','-ar','16000','-t','301','-c:a','pcm_s16le',wav],{timeout:45000,killSignal:'SIGKILL',maxBuffer:64000,signal});
      const bytes=(await stat(wav)).size;
      if(bytes<=78||bytes>MAX_AUDIO_SECONDS*32000+78)throw new Error('Audio is empty or longer than five minutes.');
      const pcm=await readFile(wav);
      if(!hasAudibleSamples(pcm))throw new Error('No clear speech detected.');
      return pcm;
    },observe);
    // Feed the already-validated PCM WAV through Whisper's memory decoder,
    // keeping the decoder input identical across platforms.
    // The pinned Windows GGML runtime stalls with four threads on the hosted
    // two-core runner; the same binary completes with one. Keep that safe mode.
    return await measureVoiceStage('transcribe',async()=>{
    const transcription=exec(config.whisper,['-m',config.model,'-f','-','-l','auto','-otxt','-of',output,'-nt','-np','-t',process.platform==='win32'?'1':'4'],{timeout:180000,killSignal:'SIGKILL',maxBuffer:256000,signal});
    // An early decoder exit is reported by the process promise, not an unhandled
    // EPIPE from the input stream. end() also guarantees the decoder receives EOF.
    transcription.child.stdin?.on('error',()=>{});
    transcription.child.stdin?.end(pcm);
    await transcription;
    const text=(await readFile(output+'.txt','utf8')).trim();
    if(!text||text.length>32000||/^(?:\[[^\]]*\]|\([^)]*\)|[\s.])+$/.test(text))throw new Error('No clear speech detected.');
    return text;
    },observe);
  }finally{await rm(dir,{recursive:true,force:true});}
}
export async function transcribeAudio(store:Store,audio:any,signal?:AbortSignal,observe?:AudioObserver) {
  audioFormat(audio);
  if(!store.get('audio-config')&&store.get('audio-tools')) {
    const {prepareVoiceModel}=await import('./voice-model.js');await prepareVoiceModel(store);
    signal?.throwIfAborted();
  }
  const saved=store.get('audio-config');
  if(!saved)throw new Error('Voice transcription is not configured on this computer yet. Please type your message; configure local Whisper in the bridge CLI.');
  const config=validateAudioConfig(JSON.parse(saved)),format=audioFormat(audio);
  const data=await measureVoiceStage('download',()=>downloadAudio(audio,signal),observe);
  try{return await transcribeLocal(data,format,config,stateDir,signal,observe);}finally{data.dispose();}
}
