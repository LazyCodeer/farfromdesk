import { createHash } from 'node:crypto';
import { mkdir, open, rename, rm, lstat, statfs } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './config.js';
import type { Store } from './store.js';

export const VOICE_MODEL = {
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  bytes: 147951465,
  sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
};
const pending = new WeakMap<Store, Promise<string>>();
const states = new WeakMap<Store, {state:string;bytes:number;total:number;error?:string}>();
export function voiceModelProgress(store:Store) {return states.get(store)??{state:'needed',bytes:0,total:VOICE_MODEL.bytes};}

// Streaming and atomic publication keep partial or corrupt models out of recognition.
export function ensureVoiceModel(store:Store, options:{root?:string;fetcher?:typeof fetch;model?:typeof VOICE_MODEL}={}) {
  const existing=pending.get(store);if(existing)return existing;
  const model=options.model??VOICE_MODEL,root=options.root??stateDir;
  const task=(async()=>{
    const directory=join(root,'models');
    const target=join(directory,'ggml-base.bin'),partial=join(directory,'ggml-base.bin.partial');
    try {
      await mkdir(directory,{recursive:true,mode:0o700});
      try {
        const st=await lstat(target);
        if(st.isFile()&&st.size===model.bytes) {
          const hash=createHash('sha256');for await(const part of createReadStream(target))hash.update(part);
          if(hash.digest('hex')===model.sha256){states.set(store,{state:'ready',bytes:model.bytes,total:model.bytes});return target;}
        }
      }catch(e:any){if(e.code!=='ENOENT')throw e;}
      const disk=await statfs(directory);
      if(disk.bavail*disk.bsize < model.bytes + 16*1024*1024)throw new Error('Insufficient disk space');
      states.set(store,{state:'downloading',bytes:0,total:model.bytes});
      const response=await (options.fetcher??fetch)(model.url,{signal:AbortSignal.timeout(15*60*1000)});
      try {
      if(!response.ok||!response.body||!response.url.startsWith('https://'))throw new Error('Download unavailable');
      const length=response.headers.get('content-length');
      if(length&&Number(length)!==model.bytes)throw new Error('Unexpected model size');
      // Clear only our own unfinished file from an interrupted earlier startup.
      await rm(partial,{force:true});
      const file=await open(partial,'wx',0o600),hash=createHash('sha256');let bytes=0;
      try {
        for await(const chunk of response.body as any as AsyncIterable<Uint8Array>) {
          bytes+=chunk.byteLength;if(bytes>model.bytes)throw new Error('Model exceeded expected size');
          hash.update(chunk);await file.writeFile(chunk);
          states.set(store,{state:'downloading',bytes,total:model.bytes});
        }
        if(bytes!==model.bytes||hash.digest('hex')!==model.sha256)throw new Error('Model checksum mismatch');
        await file.sync();
      }finally{await file.close();}
      }finally {
        // Rejected headers or local I/O failures must not leave a download streaming.
        if(response.body&&!response.body.locked)await response.body.cancel().catch(()=>{});
      }
      await rename(partial,target);
      states.set(store,{state:'ready',bytes:model.bytes,total:model.bytes});return target;
    }catch (cause) {
      await rm(partial,{force:true}).catch(()=>{});
      const error=cause instanceof Error&&cause.message==='Insufficient disk space'?'Voice model download did not finish. Free at least 160 MB of disk space, then retry.':'Voice model download did not finish. Check your internet connection, then retry in Settings or resend the voice note.';
      states.set(store,{state:'failed',bytes:0,total:model.bytes,error});throw new Error(error);
    }
  })();
  pending.set(store,task);void task.finally(()=>pending.delete(store)).catch(()=>{});return task;
}

export async function prepareVoiceModel(store:Store,options?:Parameters<typeof ensureVoiceModel>[1]) {
  const raw=store.get('audio-tools');if(!raw)throw new Error('Bundled voice tools are unavailable.');
  const tools=JSON.parse(raw),model=await ensureVoiceModel(store,options);
  // A manually selected configuration wins if it changed during the download.
  if(store.get('audio-tools')===raw&&(!store.get('audio-config')||store.get('audio-origin')==='bundled')) {
    store.set('audio-config',JSON.stringify({...tools,model}));store.set('audio-origin','bundled');
  }
}
