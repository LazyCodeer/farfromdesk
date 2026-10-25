import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { stateDir } from './config.js';
import type { Store } from './store.js';

const exec=promisify(execFile);
export const MAX_AUDIO_BYTES=10*1024*1024,MAX_AUDIO_SECONDS=300;
export type AudioConfig={ffmpeg:string;whisper:string;model:string};
const formats:Record<string,string>={'audio/ogg':'ogg','audio/opus':'ogg','audio/mpeg':'mp3','audio/mp4':'mov','audio/aac':'aac','audio/wav':'wav','audio/x-wav':'wav','audio/flac':'flac','audio/webm':'matroska','audio/amr':'amr'};
export function validateAudioConfig(config:any):AudioConfig {
  for(const k of ['ffmpeg','whisper','model'])if(typeof config?.[k]!=='string'||!isAbsolute(config[k])||!existsSync(config[k])||!statSync(config[k]).isFile())throw new Error('Configure existing absolute paths for FFmpeg, whisper-cli and a local Whisper model.');
  return {ffmpeg:config.ffmpeg,whisper:config.whisper,model:config.model};
}
export function audioFormat(audio:any) {
  const mime=String(audio?.mimetype??'').split(';')[0].trim().toLowerCase(),format=formats[mime];
  if(!format)throw new Error('Unsupported voice-note format. Please resend as a WhatsApp voice note or type your message.');
  if(Number(audio.fileLength??0)>MAX_AUDIO_BYTES||Number(audio.seconds??0)>MAX_AUDIO_SECONDS)throw new Error('Voice notes must be at most 5 minutes and 10 MiB. Please send a shorter recording.');
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
export async function downloadAudio(audio:any,signal?:AbortSignal):Promise<Buffer> {
  audioFormat(audio);
  // Never trust media-provided URLs/hosts. Only WhatsApp's fixed media endpoint
  // and relative direct path may be fetched, with redirects disabled.
  if(typeof audio.directPath!=='string'||!/^\/[^/]/.test(audio.directPath)||/[\\\x00-\x20]/.test(audio.directPath)||!audio.mediaKey)throw new Error('Voice note cannot be downloaded. Please resend it.');
  const timeout=AbortSignal.timeout(30000);
  const stream=await downloadContentFromMessage({directPath:audio.directPath,mediaKey:audio.mediaKey},'audio',{host:'mmg.whatsapp.net',options:{signal:signal?AbortSignal.any([signal,timeout]):timeout,redirect:'error'}});
  const chunks:Buffer[]=[];let size=0;
  const timer=setTimeout(()=>stream.destroy(new Error('Audio download timed out')),30000);
  try {
    for await(const chunk of stream){size+=chunk.length;if(size>MAX_AUDIO_BYTES)throw new Error('Voice note exceeds 10 MiB.');chunks.push(Buffer.from(chunk));}
    const data=Buffer.concat(chunks);
    if(!data.length||!audio.fileSha256||!createHash('sha256').update(data).digest().equals(Buffer.from(audio.fileSha256)))throw new Error('Voice note integrity check failed.');
    return data;
  }finally{clearTimeout(timer);stream.destroy();}
}
export async function transcribeLocal(data:Buffer,format:string,config:AudioConfig,root=stateDir,signal?:AbortSignal):Promise<string> {
  if(!data.length||data.length>MAX_AUDIO_BYTES||!Object.values(formats).includes(format))throw new Error('Invalid audio input.');
  validateAudioConfig(config);
  const parent=join(root,'audio-tmp');await mkdir(parent,{recursive:true,mode:0o700});
  const dir=await mkdtemp(join(parent,'note-')),input=join(dir,'input'),wav=join(dir,'audio.wav'),output=join(dir,'transcript');
  try {
    await writeFile(input,data,{mode:0o600});
    await exec(config.ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-protocol_whitelist','file,pipe','-f',format,'-i',input,'-vn','-ac','1','-ar','16000','-t','301','-c:a','pcm_s16le',wav],{timeout:45000,killSignal:'SIGKILL',maxBuffer:64000,signal});
    const bytes=(await stat(wav)).size;
    if(bytes<=78||bytes>MAX_AUDIO_SECONDS*32000+78)throw new Error('Audio is empty or longer than five minutes.');
    const pcm=await readFile(wav);
    if(!hasAudibleSamples(pcm))throw new Error('No clear speech detected.');
    // Feed the already-validated PCM WAV through Whisper's memory decoder,
    // keeping the decoder input identical across platforms.
    // The pinned Windows GGML runtime stalls with four threads on the hosted
    // two-core runner; the same binary completes with one. Keep that safe mode.
    const transcription=exec(config.whisper,['-m',config.model,'-f','-','-l','auto','-otxt','-of',output,'-nt','-np','-t',process.platform==='win32'?'1':'4'],{timeout:180000,killSignal:'SIGKILL',maxBuffer:256000,signal});
    // An early decoder exit is reported by the process promise, not an unhandled
    // EPIPE from the input stream. end() also guarantees the decoder receives EOF.
    transcription.child.stdin?.on('error',()=>{});
    transcription.child.stdin?.end(pcm);
    await transcription;
    const text=(await readFile(output+'.txt','utf8')).trim();
    if(!text||text.length>32000||/^(?:\[[^\]]*\]|\([^)]*\)|[\s.])+$/.test(text))throw new Error('No clear speech detected.');
    return text;
  }finally{await rm(dir,{recursive:true,force:true});}
}
export async function transcribeAudio(store:Store,audio:any,signal?:AbortSignal) {
  const saved=store.get('audio-config');
  if(!saved)throw new Error('Voice transcription is not configured on this computer yet. Please type your message; configure local Whisper in the bridge CLI.');
  const config=validateAudioConfig(JSON.parse(saved)),format=audioFormat(audio);
  return transcribeLocal(await downloadAudio(audio,signal),format,config,stateDir,signal);
}
