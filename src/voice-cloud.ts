import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDir } from './config.js';
import type { Store } from './store.js';

export type CloudProvider='deepgram'|'assemblyai'|'meta';
export const CLOUD_NAMES:Record<CloudProvider,string>={deepgram:'Deepgram',assemblyai:'AssemblyAI',meta:'Meta'};
export const isCloud=(v:unknown):v is CloudProvider=>v==='deepgram'||v==='assemblyai'||v==='meta';
// Verified against dev.meta.ai/docs/api-reference/voice/transcribe, 2026-10-28: mono 16 kHz WAV, at most 10 minutes and 32 MB.
export const META_VOICE_MODEL='muse-voice-transcribe-1.0';
export const needsWav=(p:CloudProvider)=>p==='meta';
type Fetch=typeof fetch;

// The key lives beside admin-token and the WhatsApp credentials: owner-only file in the
// private state folder, never in SQLite, logs or events.
const keyFile=(root=stateDir)=>join(root,'voice-api-key');
export function readVoiceKey(root=stateDir):{provider:CloudProvider;key:string}|undefined {
  try{const d=JSON.parse(readFileSync(keyFile(root),'utf8'));return isCloud(d.provider)&&typeof d.key==='string'&&d.key?d:undefined;}catch{return undefined;}
}
export function writeVoiceKey(provider:CloudProvider,key:string,root=stateDir) {
  const file=keyFile(root),partial=file+'.partial';
  writeFileSync(partial,JSON.stringify({provider,key}),{mode:0o600});renameSync(partial,file);
}
export function removeVoiceKey(root=stateDir){rmSync(keyFile(root),{force:true});}
export const hasVoiceKey=(root=stateDir)=>existsSync(keyFile(root));

export function cleanKey(raw:unknown) {
  const key=typeof raw==='string'?raw.trim():'';
  if(key.length<20||key.length>200||!/^[A-Za-z0-9._-]+$/.test(key))throw new Error('That doesn’t look like an API key. Copy the whole key and paste it again.');
  return key;
}

async function call(fetcher:Fetch,provider:CloudProvider,url:string,init:RequestInit,timeoutMs:number,signal?:AbortSignal) {
  const timeout=AbortSignal.timeout(timeoutMs),combined=signal?AbortSignal.any([signal,timeout]):timeout;
  let res:Response;
  try{res=await fetcher(url,{...init,signal:combined});}
  catch(e){if(signal?.aborted)throw e;throw new Error(timeout.aborted?`${CLOUD_NAMES[provider]} timed out. Check your internet connection.`:`Couldn’t reach ${CLOUD_NAMES[provider]}. Check your internet connection.`);}
  if(res.status===401||res.status===403)throw new Error(`${CLOUD_NAMES[provider]} rejected this API key. Check that you copied the whole key.`);
  if(res.status===402||res.status===429)throw new Error(`${CLOUD_NAMES[provider]} refused the request. Your free credit may be used up or the account is rate limited.`);
  if(!res.ok)throw new Error(`${CLOUD_NAMES[provider]} couldn’t transcribe this voice note (HTTP ${res.status}).`);
  return res.json() as Promise<any>;
}

// Free, read-only calls: they prove the key works without spending credit.
export async function testVoiceKey(provider:CloudProvider,key:string,fetcher:Fetch=fetch) {
  if(provider==='deepgram')await call(fetcher,provider,'https://api.deepgram.com/v1/projects',{headers:{authorization:`Token ${key}`}},15000);
  else if(provider==='meta')await call(fetcher,provider,'https://api.meta.ai/v1/models',{redirect:'error',headers:{authorization:`Bearer ${key}`}},15000);
  else await call(fetcher,provider,'https://api.assemblyai.com/v2/transcript?limit=1',{headers:{authorization:key}},15000);
}

// Muse Voice Transcribe repeats a word in roughly 4 of 10 clips (2026-10-28 trial, all rates and
// modes): "send me me the summary". Collapse back-to-back repeats of 1 to 3 words.
// ponytail: also collapses a deliberate "had had"; acceptable for spoken commands.
export function collapseRepeats(text:string) {
  let prev;do{prev=text;text=text.replace(/\b(\w+(?:\s+\w+){0,2})(?:\s+\1\b)+/gi,'$1');}while(text!==prev);
  return text;
}
const noSpeech=(text:unknown)=>{
  const t=typeof text==='string'?text.trim():'';
  if(!t||t.length>32000)throw new Error('No clear speech detected.');
  return t;
};

export async function transcribeCloud(provider:CloudProvider,key:string,path:string,mime:string,signal?:AbortSignal,options:{fetcher?:Fetch;pollMs?:number;authorize?:()=>void}={}) {
  const rawFetch=options.fetcher??fetch,fetcher:Fetch=(...args)=>{options.authorize?.();return rawFetch(...args);};
  options.authorize?.();const audio=await readFile(path);options.authorize?.();
  if(provider==='deepgram') {
    // nova-3 with language=multi handles English, Hindi and code-switched speech.
    const d=await call(fetcher,provider,'https://api.deepgram.com/v1/listen?model=nova-3&language=multi&smart_format=true',{method:'POST',headers:{authorization:`Token ${key}`,'content-type':mime},body:audio},120000,signal);
    return noSpeech(d?.results?.channels?.[0]?.alternatives?.[0]?.transcript);
  }
  if(provider==='meta') {
    // path is the 16 kHz mono WAV decoded by audio.ts; Meta accepts no other container.
    // No keywords: in a 2026-10-28 trial, biasing made Meta repeat words ("Codex Codex").
    const form=new FormData();
    form.append('request',new Blob([JSON.stringify({model:META_VOICE_MODEL,audioEncoding:'WAV',mode:'PUSH_TO_TALK'})],{type:'application/json'}));
    form.append('audio',new Blob([audio],{type:'audio/wav'}),'voice.wav');
    const d=await call(fetcher,provider,'https://api.meta.ai/v1/asr/transcribe',{method:'POST',redirect:'error',headers:{authorization:`Bearer ${key}`,accept:'application/json'},body:form},120000,signal);
    return noSpeech(collapseRepeats(String(d?.transcript??'')));
  }
  const auth={authorization:key};
  const up=await call(fetcher,provider,'https://api.assemblyai.com/v2/upload',{method:'POST',headers:{...auth,'content-type':'application/octet-stream'},body:audio},60000,signal);
  if(typeof up?.upload_url!=='string')throw new Error('AssemblyAI couldn’t transcribe this voice note.');
  const job=await call(fetcher,provider,'https://api.assemblyai.com/v2/transcript',{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({audio_url:up.upload_url,speech_models:['universal-3-5-pro','universal-2'],language_detection:true})},30000,signal);
  if(typeof job?.id!=='string'||!/^[\w-]+$/.test(job.id))throw new Error('AssemblyAI couldn’t transcribe this voice note.');
  const deadline=Date.now()+180000;
  for(;;) {
    const d=await call(fetcher,provider,`https://api.assemblyai.com/v2/transcript/${job.id}`,{headers:auth},30000,signal);
    if(d?.status==='completed')return noSpeech(d.text);
    if(d?.status==='error')throw new Error('AssemblyAI couldn’t transcribe this voice note.');
    if(Date.now()>deadline)throw new Error('AssemblyAI timed out. Check your internet connection.');
    await new Promise(r=>setTimeout(r,options.pollMs??1500));signal?.throwIfAborted();
  }
}

export function voiceEngine(store:Store):'local'|CloudProvider {
  const e=store.get('voice-engine');return isCloud(e)&&readVoiceKey()?.provider===e?e:'local';
}
export function cloudView(store:Store) {
  const k=readVoiceKey(),engine=voiceEngine(store);
  return {engine,...(k?{provider:k.provider,keyHint:k.key.slice(-4)}:{}),fallback:store.get('voice-fallback')!=='0'};
}
