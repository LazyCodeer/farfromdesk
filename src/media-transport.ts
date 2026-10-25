import { request as httpsRequest } from 'node:https';
import { createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { getMediaKeys, DEFAULT_ORIGIN, type MediaType } from '@whiskeysockets/baileys';
import { FILE_CHUNK_BYTES } from './large-file.js';

/** The pinned Baileys fetch helper drops signal/redirect options and does not
 * propagate destruction to its fetched stream. Use its key derivation with an
 * abortable HTTPS stream and the WhatsApp ciphertext HMAC instead. */
export async function boundedMediaDownload(media:{directPath?:string|null;mediaKey?:Uint8Array|null},kind:MediaType,options:any={},request=httpsRequest):Promise<Readable> {
  if(typeof media.directPath!=='string'||!/^\/[^/]/.test(media.directPath)||/[\\\x00-\x20]/.test(media.directPath)||!media.mediaKey)throw new Error('Attachment cannot be downloaded. Please resend it.');
  const signal=options.options?.signal as AbortSignal|undefined;signal?.throwIfAborted();
  const keys=await getMediaKeys(media.mediaKey,kind),macKey=keys.macKey;if(!macKey)throw new Error('Attachment media authentication key is unavailable.');signal?.throwIfAborted();
  const authenticationKey=Buffer.from(macKey);
  const url=new URL('https://mmg.whatsapp.net'+media.directPath);
  let req:ReturnType<typeof httpsRequest>;
  const response=await new Promise<import('node:http').IncomingMessage>((resolve,reject)=>{
    req=request(url,{method:'GET',headers:{Origin:DEFAULT_ORIGIN},signal,timeout:30_000},res=>{
      if(res.statusCode!==200){res.destroy();req.destroy();reject(new Error('Attachment download rejected by WhatsApp.'));return;}resolve(res);
    });
    req.on('timeout',()=>req.destroy(new Error('Attachment download stalled.')));
    req.on('error',()=>reject(new Error('Attachment download failed or was cancelled.')));req.end();
  });
  // Keep transport failures observed even before the consumer begins iterating.
  response.on('error',()=>{});
  async function* decrypt(){
    const aes=createDecipheriv('aes-256-cbc',keys.cipherKey,keys.iv),mac=createHmac('sha256',authenticationKey).update(keys.iv);
    let tail=Buffer.alloc(0);
    try{
      for await(const value of response){
        signal?.throwIfAborted();const data=Buffer.concat([tail,Buffer.from(value)]),length=Math.max(0,data.length-10);
        tail=Buffer.from(data.subarray(length));if(!length)continue;
        const ciphertext=data.subarray(0,length);mac.update(ciphertext);const plain=aes.update(ciphertext);if(plain.length)yield plain;
      }
      if(tail.length!==10||!timingSafeEqual(mac.digest().subarray(0,10),tail))throw new Error('Attachment encrypted integrity check failed.');
      const final=aes.final();if(final.length)yield final;signal?.throwIfAborted();
    }finally{aes.destroy();mac.destroy();response.destroy();req.destroy();}
  }
  const stream=Readable.from(decrypt(),{highWaterMark:FILE_CHUNK_BYTES,objectMode:false});
  stream.on('close',()=>{response.destroy();req.destroy();});return stream;
}
