import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHmac, createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { getMediaKeys } from '@whiskeysockets/baileys';
import { boundedMediaDownload } from '../src/media-transport.js';
import { boundedDocumentUpload, MediaHostLimitError } from '../src/document-delivery.js';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('HTTPS media downloader authenticates ciphertext, rejects redirects and cancels a stalled connection',async()=>{
  const mediaKey=Buffer.alloc(32,7),keys=await getMediaKeys(mediaKey,'document'),plain=Buffer.from('Authentic document'),cipher=createCipheriv('aes-256-cbc',keys.cipherKey,keys.iv);
  const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]),mac=createHmac('sha256',keys.macKey).update(keys.iv).update(ciphertext).digest().subarray(0,10),encrypted=Buffer.concat([ciphertext,mac]);
  let mode='ok',requests=0;
  const server=createServer((req,res)=>{requests++;if(mode==='stall')return;if(mode==='redirect'){res.writeHead(302,{Location:'http://127.0.0.1/elsewhere'});res.end();return;}const payload=Buffer.from(encrypted);if(mode==='corrupt')payload[payload.length-1]^=1;res.write(payload.subarray(0,5));res.end(payload.subarray(5));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const localRequest=((url:any,opts:any,cb:any)=>{assert.equal(url.protocol,'https:');assert.equal(url.hostname,'mmg.whatsapp.net');return request(`http://127.0.0.1:${(server.address() as any).port}`,opts,cb);}) as any;
  const media={mediaKey,directPath:'/v/t/media'};
  async function collect(){const stream=await boundedMediaDownload(media,'document',{},localRequest),parts=[];for await(const part of stream)parts.push(part);return Buffer.concat(parts);}
  try{
    assert.deepEqual(await collect(),plain);
    mode='corrupt';await assert.rejects(collect(),/integrity/);
    mode='redirect';const before=requests;await assert.rejects(collect(),/rejected/);assert.equal(requests,before+1);
    mode='stall';const controller=new AbortController(),pending=boundedMediaDownload(media,'document',{options:{signal:controller.signal}},localRequest);setTimeout(()=>controller.abort(),20);await assert.rejects(pending,/cancelled/);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('upload respects encrypted-byte host ceilings before any upload',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'ffd-host-limits-'))),path=join(root,'encrypted');writeFileSync(path,Buffer.alloc(256,1));
  const options={mediaType:'document',fileEncSha256B64:createHash('sha256').update('x').digest('base64')} as any;
  const narrow={refreshMediaConn:async()=>({hosts:[{hostname:'mmg.whatsapp.net',maxContentLengthBytes:255}],auth:'test'})} as any;
  let network=0;
  try{
    await assert.rejects(boundedDocumentUpload(narrow,new AbortController().signal,(()=>{network++;throw new Error('unexpected request');}) as any)(path,options),MediaHostLimitError);assert.equal(network,0);
  }finally{rmSync(root,{recursive:true,force:true});}
});
