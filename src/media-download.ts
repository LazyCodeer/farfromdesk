import { randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync, realpathSync, rmSync, statfsSync } from 'node:fs';
import { open, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { boundedMediaDownload } from './media-transport.js';
import { defaultStateDirectory } from './platform.js';
import { FileDigest } from './large-file.js';

export const MEDIA_IDLE_TIMEOUT_MS=30_000;
// Deadlines bound abandoned work, not the size of a healthy, progressing transfer.
export const MEDIA_TRANSFER_TIMEOUT_MS=60*60_000;
export const DISK_HEADROOM_BYTES=128*1024*1024;
export const privateMediaRoot=()=>process.env.WSB_STATE_DIR??defaultStateDirectory();
export function privateDirectory(root:string,parts:string[],create=false) {
  if(create)mkdirSync(root,{recursive:true,mode:0o700});
  let path=realpathSync(root);
  for(const part of parts){
    if(!/^[a-zA-Z0-9-]+$/.test(part))throw new Error('Invalid private storage identity.');
    path=join(path,part);if(create){try{mkdirSync(path,{mode:0o700});}catch(e:any){if(e.code!=='EEXIST')throw e;}}
    const s=lstatSync(path);if(s.isSymbolicLink()||!s.isDirectory())throw new Error('Attachment staging directory integrity check failed.');
  }
  return path;
}
export function requireDiskSpace(path:string,bytes:number){
  const s=statfsSync(path);if(s.bavail*s.bsize<bytes+DISK_HEADROOM_BYTES)throw new Error('Not enough free disk space to receive or stage this file.');
}
export type DownloadedMedia={path:string;filename:string;bytes:number;sha256:string;mime:string;dispose:()=>void};
const verifiedDownloads=new WeakSet<DownloadedMedia>();
export function isDownloadedMedia(value:DownloadedMedia){return verifiedDownloads.has(value);}
const active=new Set<string>();
export function recoverDownloads(root:string){
  // Only our private, UUID-named scratch directories are candidates.
  let parent:string;try{parent=privateDirectory(root,['media-downloads']);}catch(e:any){if(e.code==='ENOENT')return;throw e;}
  for(const entry of requireEntries(parent))if(/^[a-f0-9-]{36}$/.test(entry)&&!active.has(join(parent,entry)))rmSync(join(parent,entry),{recursive:true,force:true});
}
import { readdirSync as requireEntries } from 'node:fs';
export async function streamMediaDownload(media:any,kind:'image'|'document'|'audio',filename:string,max:number,signal?:AbortSignal,download=boundedMediaDownload,root=privateMediaRoot()):Promise<DownloadedMedia> {
  if(typeof media.directPath!=='string'||!/^\/[^/]/.test(media.directPath)||/[\\\x00-\x20]/.test(media.directPath)||!media.mediaKey||!media.fileSha256)
    throw new Error('Attachment cannot be downloaded. Please resend it.');
  const declared=Number(media.fileLength??0);
  if(!Number.isSafeInteger(declared)||declared<0||declared>max)throw new Error('Attachment exceeds the WhatsApp document limit or has an invalid declared size.');
  const abort=AbortSignal.any([AbortSignal.timeout(MEDIA_TRANSFER_TIMEOUT_MS),...(signal?[signal]:[])]);abort.throwIfAborted();
  const dir=privateDirectory(root,['media-downloads',randomUUID()],true),path=join(dir,'data');active.add(dir);
  const dispose=()=>{active.delete(dir);rmSync(dir,{recursive:true,force:true});};
  let handle:Awaited<ReturnType<typeof open>>|undefined,stream:Readable|undefined,idle:ReturnType<typeof setTimeout>|undefined;
  const cancel=()=>stream?.destroy(new Error('Attachment download cancelled or timed out.'));
  abort.addEventListener('abort',cancel,{once:true});
  try {
    requireDiskSpace(dir,declared);handle=await open(path,'wx',0o600);
    stream=await download({directPath:media.directPath,mediaKey:media.mediaKey},kind,{host:'mmg.whatsapp.net',options:{signal:abort,redirect:'error'}});
    stream.on('error',()=>{});abort.throwIfAborted();
    const reset=()=>{clearTimeout(idle);idle=setTimeout(()=>stream?.destroy(new Error('Attachment download stalled.')),MEDIA_IDLE_TIMEOUT_MS);};reset();
    const digest=new FileDigest(filename,max);let received=0,checkpoint=0;
    for await(const value of stream){
      abort.throwIfAborted();reset();const chunk=Buffer.from(value);received+=chunk.length;
      if(received>max||(declared&&received>declared))throw new Error('Attachment exceeds its declared size or WhatsApp document limit.');
      if(received>=checkpoint){requireDiskSpace(dir,Math.max(declared-received,chunk.length));checkpoint=received+8*1024*1024;}
      digest.add(chunk);await handle.writeFile(chunk);
    }
    const meta=digest.finish();abort.throwIfAborted();
    if((declared&&declared!==meta.bytes)||!Buffer.from(media.fileSha256).equals(Buffer.from(meta.sha256,'hex')))throw new Error('Attachment integrity check failed.');
    await handle.sync();await handle.close();handle=undefined;await chmod(path,0o400);
    const result={path,...meta,dispose};verifiedDownloads.add(result);return result;
  }catch(e){await handle?.close().catch(()=>{});dispose();throw e;}
  finally{clearTimeout(idle);abort.removeEventListener('abort',cancel);stream?.destroy();}
}

// Public HTTPS transports supply a bounded stream; validation and private staging
// stay shared with native attachment and voice processing.
export async function stageMediaStream(source:AsyncIterable<Uint8Array>,filename:string,declared:number,max:number,signal:AbortSignal,root=privateMediaRoot()):Promise<DownloadedMedia> {
  if(!Number.isSafeInteger(declared)||declared<1||declared>max)throw new Error('Invalid attachment size.');
  const dir=privateDirectory(root,['media-downloads',randomUUID()],true),path=join(dir,'data');active.add(dir);
  const dispose=()=>{active.delete(dir);rmSync(dir,{recursive:true,force:true});};
  let handle:Awaited<ReturnType<typeof open>>|undefined;
  try {
    requireDiskSpace(dir,declared);handle=await open(path,'wx',0o600);
    const digest=new FileDigest(filename,max);let size=0;
    for await(const chunk of source){signal.throwIfAborted();size+=chunk.length;if(size>declared)throw new Error('Attachment exceeds declared size.');digest.add(Buffer.from(chunk));await handle.writeFile(chunk);}
    signal.throwIfAborted();const meta=digest.finish();if(meta.bytes!==declared)throw new Error('Attachment size mismatch.');
    await handle.sync();await handle.close();handle=undefined;await chmod(path,0o400);
    const file={path,...meta,dispose};verifiedDownloads.add(file);return file;
  }catch(e){await handle?.close().catch(()=>{});dispose();throw e;}
}
