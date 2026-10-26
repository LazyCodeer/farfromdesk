import { request as httpsRequest } from 'node:https';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { prepareWAMessageMedia, generateWAMessageFromContent, DEFAULT_ORIGIN, MEDIA_PATH_MAP, encodeBase64EncodedStringForUpload, type WASocket, type WAMediaUploadFunction } from '@whiskeysockets/baileys';
import type { DiskArtifacts } from './disk-artifacts.js';
import { streamHandle } from './large-file.js';
import { MAX_OUTGOING_DOCUMENT_BYTES } from './file-types.js';

export class MediaHostLimitError extends Error {}
export const DOCUMENT_UPLOAD_TIMEOUT_MS=60*60_000;
/** Baileys' upload callback, using its authenticated media connection and protocol.
 * Node HTTPS streams with backpressure, a wall deadline, abort and bounded response.
 * Redirects are not followed; only hosts returned by this socket are contacted.
 */
export function boundedDocumentUpload(sock:Pick<WASocket,'refreshMediaConn'>,signal:AbortSignal,request=httpsRequest):WAMediaUploadFunction {
  return async(filePath,options)=>{
    if(options.mediaType!=='document')throw new Error('This uploader only accepts documents.');
    const abort=AbortSignal.any([signal,AbortSignal.timeout(DOCUMENT_UPLOAD_TIMEOUT_MS)]);
    abort.throwIfAborted();const connection=await sock.refreshMediaConn(false);abort.throwIfAborted();
    const token=encodeBase64EncodedStringForUpload(options.fileEncSha256B64);
    let hostCeiling=0,attempted=false;
    for(const host of connection.hosts) {
      abort.throwIfAborted();
      if(!/^[a-z0-9.-]+$/i.test(host.hostname)||!host.hostname.includes('.'))continue;
      const url=new URL(`https://${host.hostname}${MEDIA_PATH_MAP.document}/${token}`);
      url.searchParams.set('auth',connection.auth);url.searchParams.set('token',decodeURIComponent(token));
      const file=await open(filePath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try {
        const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size<1||stat.size>MAX_OUTGOING_DOCUMENT_BYTES+64)throw new Error('Invalid encrypted document staging file.');
        if(Number.isFinite(host.maxContentLengthBytes)&&host.maxContentLengthBytes>0&&stat.size>host.maxContentLengthBytes){hostCeiling=Math.max(hostCeiling,host.maxContentLengthBytes);continue;}
        attempted=true;
        const result:any=await new Promise((resolve,reject)=>{
          const stream=streamHandle(file,stat.size);let done=false;
          const finish=(error?:Error,value?:unknown)=>{if(done)return;done=true;stream.destroy();error?reject(error):resolve(value);};
          const req=request(url,{method:'POST',headers:{'Content-Type':'application/octet-stream',Origin:DEFAULT_ORIGIN,'Content-Length':stat.size},signal:abort,timeout:30000},res=>{
            let body='';res.on('error',()=>finish(new Error('Document upload response failed.')));
            res.on('data',chunk=>{body+=chunk;if(body.length>64000){finish(new Error('Document upload response too large.'));res.destroy();req.destroy();}});
            res.on('end',()=>{if(res.statusCode!==200)return finish(new Error('Document upload rejected.'));try{finish(undefined,JSON.parse(body));}catch{finish(new Error('Invalid document upload response.'));}});
          });
          req.on('error',()=>finish(new Error('Document upload failed or was cancelled.')));req.on('timeout',()=>req.destroy(new Error('Document upload stalled.')));
          stream.on('error',()=>req.destroy(new Error('Encrypted document could not be read.')));stream.pipe(req);
        });
        if(typeof result?.direct_path==='string'&&typeof result?.url==='string')return {mediaUrl:result.url,directPath:result.direct_path,meta_hmac:result.meta_hmac,ts:result.ts,fbid:result.fbid};
      }catch{abort.throwIfAborted();}finally{await file.close();}
    }
    if(!attempted&&hostCeiling)throw new MediaHostLimitError(`WhatsApp media hosts currently limit this encrypted upload to ${hostCeiling} bytes; this file was not sent.`);
    throw new Error('Document upload was not accepted by the linked WhatsApp transport.');
  };
}

export async function sendDiskDocument(sock:Pick<WASocket,'refreshMediaConn'|'user'>&{relayMessage(jid:string,message:any,options:{messageId:string}):Promise<unknown>},destination:string,row:any,caption:string,messageId:string,disk:DiskArtifacts,beforeRelay:()=>Promise<void>,uploadOverride?:WAMediaUploadFunction) {
  const lease=await disk.openForDelivery(row);
  try {
    const media=await prepareWAMessageMedia({document:{stream:lease.stream},fileName:row.filename,mimetype:row.mime,caption},
      {upload:uploadOverride??boundedDocumentUpload(sock,lease.signal),mediaUploadTimeoutMs:DOCUMENT_UPLOAD_TIMEOUT_MS});
    lease.valid();await beforeRelay();lease.valid();
    if(!sock.user?.id)throw new Error('WhatsApp disconnected before document delivery.');
    const message=generateWAMessageFromContent(destination,media,{userJid:sock.user.id,messageId});
    await sock.relayMessage(destination,message.message!,{messageId});
    return message;
  }finally{await lease.close();}
}
