import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync, existsSync, writeFileSync, linkSync, symlinkSync, chmodSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, PassThrough } from 'node:stream';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { Artifacts } from '../src/artifacts.js';
import { DiskArtifacts, PREPARATION_TIMEOUT_MS } from '../src/disk-artifacts.js';
import { FileDigest, inspectLocalArtifact } from '../src/large-file.js';
import { MAX_OUTGOING_DOCUMENT_BYTES } from '../src/file-types.js';
import { sendDiskDocument, boundedDocumentUpload } from '../src/document-delivery.js';
import { Attachments, downloadAttachment, disposeIncoming } from '../src/attachments.js';
import { streamHandle } from '../src/large-file.js';
import { uploadArtifact } from '../src/artifact-upload.js';

const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function fixture(t:any){
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'ffd-large-'))),store=new Store(':memory:'),artifacts=new Artifacts(store,dir);
  const {binding}=store.register('a','codex','11111111-1111-4111-a111-111111111111',dir);
  store.set('whatsapp-owner','123@s.whatsapp.net');store.enqueue('wa:a',binding,'build',undefined,'123@s.whatsapp.net');
  artifacts.disk=new DiskArtifacts(store,dir,()=>100*1024*1024*1024);
  t.after(()=>{artifacts.disk.abortAll();store.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,store,artifacts,binding,disk:artifacts.disk};
}
async function prepared(f:ReturnType<typeof fixture>,data=Buffer.from('PK\x03\x04payload')){
  const r=f.disk.reserve(f.binding,'wa:a',{filename:'build.zip',bytes:data.length,sha256:hash(data)});
  const p=await f.disk.receive(r.uploadId!,Readable.from([data]),data.length);
  return f.store.db.prepare('SELECT * FROM artifacts WHERE id=?').get(p.artifactId) as any;
}

test('streaming digest accepts exact 2000 MiB and rejects the next byte without large buffers',()=>{
  const digest=new FileDigest('build.bin'),chunk=Buffer.alloc(64*1024),sha=createHash('sha256');
  for(let i=0;i<MAX_OUTGOING_DOCUMENT_BYTES/chunk.length;i++){digest.add(chunk);sha.update(chunk);}
  assert.equal(digest.finish().sha256,sha.digest('hex'));
  assert.throws(()=>digest.add(Buffer.from([0])),/2,097,152,000/);
  const over=new FileDigest('build.bin',chunk.length);over.add(chunk);assert.throws(()=>over.add(Buffer.from([0])),/2,097,152,000/);
  const text=new FileDigest('notes.txt');text.add(Buffer.alloc(65536,65));assert.throws(()=>text.add(Buffer.from([0])),/Binary/);
  const utf=new FileDigest('notes.txt');utf.add(Buffer.from([0xc3]));assert.throws(()=>utf.finish(),/UTF-8/);
  const signature=new FileDigest('build.zip');signature.add(Buffer.from('wrong'));assert.throws(()=>signature.finish(),/ZIP/);
});

test('local review uses canonical single-link regular files and enforces max size before reading',async t=>{
  const f=fixture(t),path=join(f.dir,'build.bin');writeFileSync(path,'bytes');
  const reviewed=await inspectLocalArtifact(path);assert.equal(reviewed.sha256,hash(Buffer.from('bytes')));await reviewed.handle.close();
  symlinkSync(path,join(f.dir,'symbol.bin'));await assert.rejects(inspectLocalArtifact(join(f.dir,'symbol.bin')),/canonical/);
  linkSync(path,join(f.dir,'hard.bin'));await assert.rejects(inspectLocalArtifact(path),/regular/);
  const huge=await open(join(f.dir,'huge.bin'),'w');await huge.truncate(MAX_OUTGOING_DOCUMENT_BYTES+1);await huge.close();
  await assert.rejects(inspectLocalArtifact(join(f.dir,'huge.bin')),/2,097,152,000/);
});

test('disk preparation is scoped, idempotent, no BLOB, free of fixed storage quotas, cancellable and recoverable',async t=>{
  const f=fixture(t),data=Buffer.from('PK\x03\x04payload'),input={filename:'build.zip',bytes:data.length,sha256:hash(data)};
  assert.throws(()=>f.disk.reserve(f.binding,'wa:a',{...input,bytes:MAX_OUTGOING_DOCUMENT_BYTES+1}),/2,097,152,000/);
  const reservation=f.disk.reserve(f.binding,'wa:a',input);
  assert.throws(()=>f.disk.reserve(f.binding,'wa:a',input),/Another document/);
  await assert.rejects(f.disk.receive(reservation.uploadId!,Readable.from([data]),data.length+1),/size-mismatched/);
  const p=await f.disk.receive(reservation.uploadId!,Readable.from([data.subarray(0,3),data.subarray(3)]),data.length);
  assert.equal(f.disk.reserve(f.binding,'wa:a',input).artifactId,p.artifactId);
  const row=f.store.db.prepare('SELECT * FROM artifacts WHERE id=?').get(p.artifactId) as any;
  assert.equal(row.data.length,0);assert.equal(row.bytes,data.length);assert.equal(f.disk.usage(),data.length);
  const lease=await f.disk.openForDelivery(row);let result=Buffer.alloc(0);for await(const chunk of lease.stream)result=Buffer.concat([result,chunk]);await lease.close();assert.deepEqual(result,data);
  f.artifacts.cancel(f.binding,row.id);assert.equal(f.disk.status(row.id).state,'cancelled');assert.equal(f.disk.usage(),0);assert.equal(existsSync(join(f.dir,'artifact-files',row.id)),false);
  const stale=f.disk.reserve(f.binding,'wa:a',input);f.disk.recover();assert.equal(f.disk.status(stale.uploadId!).state,'interrupted');
  const old=f.disk.reserve(f.binding,'wa:a',input);f.store.db.prepare('UPDATE artifact_uploads SET created_at=? WHERE id=?').run(Date.now()-PREPARATION_TIMEOUT_MS-1,old.uploadId!);
  assert.ok(f.disk.reserve(f.binding,'wa:a',input).uploadId);f.disk.recover();
  const q=await prepared(f);f.store.db.prepare('UPDATE artifacts SET bytes=? WHERE id=?').run(3*1024*1024*1024,q.id);
  assert.ok(f.disk.reserve(f.binding,'wa:a',{...input,filename:'another.zip',bytes:MAX_OUTGOING_DOCUMENT_BYTES}).uploadId);f.disk.recover();
});

test('mismatched data, owner changes, low disk and stalled upload cancellation fail closed',async t=>{
  const f=fixture(t),data=Buffer.from('bytes'),input={filename:'build.bin',bytes:data.length,sha256:hash(data)};
  const bad=f.disk.reserve(f.binding,'wa:a',input);await assert.rejects(f.disk.receive(bad.uploadId!,Readable.from([Buffer.from('other')]),data.length),/integrity/);
  assert.equal(f.disk.usage(),0);assert.equal(existsSync(join(f.dir,'artifact-files',bad.uploadId!)),false);
  const stream=new PassThrough(),r=f.disk.reserve(f.binding,'wa:a',input),upload=f.disk.receive(r.uploadId!,stream,data.length);
  await new Promise(r=>setImmediate(r));f.disk.cancelUpload(r.uploadId!);await assert.rejects(upload,/cancelled/);assert.equal(f.disk.usage(),0);
  const r2=f.disk.reserve(f.binding,'wa:a',input);f.store.set('whatsapp-owner','999@s.whatsapp.net');
  await assert.rejects(f.disk.receive(r2.uploadId!,Readable.from([data]),data.length),/owner/);f.disk.cancelUpload(r2.uploadId!);f.store.set('whatsapp-owner','123@s.whatsapp.net');
  const low=new DiskArtifacts(f.store,f.dir,()=>0);assert.throws(()=>low.reserve(f.binding,'wa:a',input),/disk space/);
});

test('real Baileys encryption preserves exact document metadata, stable message ID and removes temp file',async t=>{
  const f=fixture(t),row=await prepared(f);let temp='',relayed=0;
  const socket={user:{id:'123@s.whatsapp.net'},relayMessage:async(dest:any,message:any,opts:any)=>{
    assert.equal(dest,row.destination);assert.equal(opts.messageId,'3EB0TEST');assert.equal(message.documentMessage.fileName,'build.zip');
    assert.equal(message.documentMessage.mimetype,'application/zip');assert.equal(Number(message.documentMessage.fileLength),row.bytes);
    assert.equal(Buffer.from(message.documentMessage.fileSha256).toString('hex'),row.sha256);relayed++;
  }} as any;
  await sendDiskDocument(socket,row.destination,row,'Build','3EB0TEST',f.disk,async()=>{},async path=>{temp=path;assert.ok((await stat(path)).size>row.bytes);return {mediaUrl:'https://mmg.whatsapp.net/test',directPath:'/test'};});
  assert.equal(relayed,1);assert.equal(existsSync(temp),false);
  await assert.rejects(sendDiskDocument(socket,row.destination,row,'Build','3EB0TEST',f.disk,async()=>{throw new Error('group changed');},async path=>{temp=path;return {mediaUrl:'https://mmg.whatsapp.net/test',directPath:'/test'};}),/group changed/);
  assert.equal(relayed,1);assert.equal(existsSync(temp),false);
  await assert.rejects(sendDiskDocument(socket,row.destination,row,'Build','3EB0TEST',f.disk,async()=>{},async path=>{temp=path;f.artifacts.cancel(f.binding,row.id);return {mediaUrl:'https://mmg.whatsapp.net/test',directPath:'/test'};}));
  assert.equal(relayed,1);assert.equal(existsSync(temp),false);
});

test('delivery detects changed prepared bytes before upload',async t=>{
  const f=fixture(t),row=await prepared(f),path=join(f.dir,'artifact-files',row.id,'data');chmodSync(path,0o600);writeFileSync(path,'PK\x03\x04changed');
  await assert.rejects(f.disk.openForDelivery(row),/integrity/);
});

test('local HTTP upload streams bytes, rejects redirects/oversize replies and aborts stalled response',async t=>{
  const f=fixture(t),data=Buffer.alloc(2*1024*1024,42),path=join(f.dir,'build.bin');writeFileSync(path,data);const file=await open(path,'r');
  let mode='ok',received=0;
  const server=createServer(async(req,res)=>{try{for await(const c of req)received+=c.length;}catch{return;}if(mode==='stall')return;if(mode==='large'){res.end('x'.repeat(65000));return;}res.writeHead(mode==='redirect'?302:200);res.end(JSON.stringify({bytes:received}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${(server.address() as any).port}/upload`;
  try{
    assert.equal((await uploadArtifact(url,'test',file,data.length)).bytes,data.length);
    mode='redirect';await assert.rejects(uploadArtifact(url,'test',file,data.length));
    mode='large';await assert.rejects(uploadArtifact(url,'test',file,data.length));
    mode='stall';const controller=new AbortController(),pending=uploadArtifact(url,'test',file,data.length,controller.signal);setTimeout(()=>controller.abort(),20);await assert.rejects(pending,/cancelled/);
  }finally{await file.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('bounded authenticated media uploader uses encrypted stream, stops on abort and refuses redirects',async t=>{
  const f=fixture(t),path=join(f.dir,'encrypted');writeFileSync(path,Buffer.alloc(1024*1024,1));let received=0,mode='ok';
  const server=createServer(async(req,res)=>{try{for await(const c of req)received+=c.length;}catch{return;}if(mode==='stall')return;res.writeHead(mode==='redirect'?302:200);res.end(JSON.stringify({url:'https://mmg.whatsapp.net/test',direct_path:'/test'}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const localRequest=((url:any,opts:any,callback:any)=>{assert.equal(url.protocol,'https:');assert.equal(url.hostname,'mmg.whatsapp.net');return httpRequest(`http://127.0.0.1:${(server.address() as any).port}`,opts,callback);}) as any;
  const sock={refreshMediaConn:async()=>({hosts:[{hostname:'mmg.whatsapp.net'}],auth:'test'})} as any,options={mediaType:'document',fileEncSha256B64:Buffer.alloc(32).toString('base64')} as any;
  try{
    assert.equal((await boundedDocumentUpload(sock,new AbortController().signal,localRequest)(path,options)).directPath,'/test');assert.equal(received,1024*1024);
    mode='redirect';await assert.rejects(boundedDocumentUpload(sock,new AbortController().signal,localRequest)(path,options),/not accepted/);
    mode='stall';const controller=new AbortController(),pending=boundedDocumentUpload(sock,controller.signal,localRequest)(path,options);setTimeout(()=>controller.abort(),20);await assert.rejects(pending);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('2000 MiB offline staging, encryption and loopback upload memory probe',{skip:process.env.FFD_LARGE_DOCUMENT_PROBE!=='1'},async t=>{
  const f=fixture(t),path=join(f.dir,'synthetic.bin'),bytes=MAX_OUTGOING_DOCUMENT_BYTES;
  const sparse=await open(path,'w');await sparse.truncate(bytes);await sparse.close();
  const baseline=process.memoryUsage().rss;let peak=baseline,encryptedBytes=0,encryptedPath='',relayed=0;
  const sample=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss);},10),started=Date.now();
  const reviewed=await inspectLocalArtifact(path),reservation=f.disk.reserve(f.binding,'wa:a',reviewed);
  const server=createServer(async(req,res)=>{try{
    if(req.method==='PUT'){const result=await f.disk.receive(reservation.uploadId!,req,Number(req.headers['content-length']));res.end(JSON.stringify(result));}
    else{for await(const chunk of req)encryptedBytes+=chunk.length;res.end(JSON.stringify({url:'https://mmg.whatsapp.net/offline',direct_path:'/offline'}));}
  }catch(e){res.statusCode=400;res.end(JSON.stringify({error:String(e)}));}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const localUrl=`http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const p=await uploadArtifact(localUrl,'test',reviewed.handle,bytes),row=f.store.db.prepare('SELECT * FROM artifacts WHERE id=?').get(p.artifactId) as any;
    assert.equal(row.bytes,bytes);assert.equal(row.data.length,0);assert.equal(row.sha256,reviewed.sha256);
    const socket={user:{id:row.owner},refreshMediaConn:async()=>({hosts:[{hostname:'mmg.whatsapp.net'}],auth:'offline'}),relayMessage:async(_d:any,m:any)=>{assert.equal(Number(m.documentMessage.fileLength),bytes);assert.equal(Buffer.from(m.documentMessage.fileSha256).toString('hex'),reviewed.sha256);relayed++;}} as any;
    const localRequest=((_url:any,opts:any,cb:any)=>httpRequest(localUrl,opts,cb)) as any;
    await sendDiskDocument(socket,row.destination,row,'Synthetic offline probe','3EB0PROBE',f.disk,async()=>{},async(path,opts)=>{encryptedPath=path;return boundedDocumentUpload(socket,new AbortController().signal,localRequest)(path,opts);});
    assert.equal(relayed,1);assert.equal(encryptedBytes,bytes+26);assert.equal(existsSync(encryptedPath),false);
    f.artifacts.cancel(f.binding,row.id);
    const incoming=new Attachments(f.store,f.dir);
    const received=await downloadAttachment({fileName:'incoming.bin',fileLength:bytes,fileSha256:Buffer.from(reviewed.sha256,'hex'),mediaKey:Buffer.alloc(32),directPath:'/offline'},'document',undefined,async()=>streamHandle(reviewed.handle,bytes),f.dir);
    try {const id=incoming.stage(f.binding,'wa:a',received);const ref=incoming.references(f.binding,'wa:a',true)[0];assert.equal(ref.bytes,bytes);assert.equal(ref.sha256,reviewed.sha256);assert.equal(f.store.db.prepare('SELECT data FROM incoming_files WHERE id=?').get(id)?.data,null);incoming.cancel(f.binding,'wa:a');}finally{disposeIncoming(received);}

    peak=Math.max(peak,process.memoryUsage().rss);
    t.diagnostic(JSON.stringify({bytes,encryptedBytes,baselineRSS:baseline,peakRSS:peak,rssGrowth:peak-baseline,elapsedMs:Date.now()-started,incomingBytes:bytes,network:'loopback only; synthetic incoming plaintext',realWhatsAppDelivery:false}));
    // Regression guard against accidentally buffering a 2000 MiB plaintext/base64 body.
    assert.ok(peak-baseline<256*1024*1024,`RSS grew ${peak-baseline} bytes`);
  }finally{clearInterval(sample);await reviewed.handle.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
