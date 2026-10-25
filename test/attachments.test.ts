import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Attachments, downloadAttachment, incomingMetadata, disposeIncoming } from '../src/attachments.js';
import { validateFile, MAX_FILE_BYTES } from '../src/file-types.js';
import { Router } from '../src/router.js';
import { Approvals } from '../src/approvals.js';
import { WhatsApp } from '../src/whatsapp.js';
import { Readable } from 'node:stream';
import { Coordinator } from '../src/coordinator.js';

function setup(){
  const root=mkdtempSync(join(tmpdir(),'ffd-media-')),store=new Store(join(root,'state.db'));
  store.set('whatsapp-owner','123@s.whatsapp.net');
  const a=store.register('a','codex','11111111-1111-4111-a111-111111111111',root).binding,b=store.register('b','claude','22222222-2222-4222-a222-222222222222',root).binding;
  store.enqueue('wa:parent',a,'caption');store.enqueue('master:child',b,'work');
  const attachments=new Attachments(store,root),data=Buffer.from('Review this document, never execute it.');
  const file={filename:'notes.txt',kind:'document' as const,data,sha256:createHash('sha256').update(data).digest('hex')};
  return {root,store,a,b,attachments,file,close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}
test('immutable staging is bound to request, owner and exact session; forwarding copies only explicit parent IDs',()=>{
  const f=setup();try {
    const id=f.attachments.stage(f.a,'wa:parent',f.file);
    const ref=f.attachments.references(f.a,'wa:parent',true)[0];
    assert.deepEqual(readFileSync(ref.path!),f.file.data);assert.equal(ref.id,id);
    assert.throws(()=>f.attachments.references(f.b,'wa:parent'),/another session/);
    assert.throws(()=>f.attachments.forward(f.a,'wa:parent',f.b,'master:child',['invented']),/original owner/);
    f.attachments.forward(f.a,'wa:parent',f.b,'master:child',[id]);
    const child=f.attachments.references(f.b,'master:child',true)[0];assert.notEqual(child.id,id);assert.notEqual(child.path,ref.path);
    assert.deepEqual(readFileSync(child.path!),f.file.data);
    f.store.set('whatsapp-owner','456@s.whatsapp.net');assert.throws(()=>f.attachments.references(f.a,'wa:parent'),/owner/);
    f.store.set('whatsapp-owner','123@s.whatsapp.net');
    assert.throws(()=>f.attachments.references({...f.a,native_id:f.b.native_id},'wa:parent'),/session/);
    chmodSync(ref.path!,0o600);writeFileSync(ref.path!,'tampered');assert.throws(()=>f.attachments.references(f.a,'wa:parent',true),/integrity/);
  }finally{f.close();}
});
test('restart preserves immutable data; cleanup waits for completion, cancellation removes files and fails closed',()=>{
  const f=setup();try {
    f.attachments.stage(f.a,'wa:parent',f.file);const ref=f.attachments.references(f.a,'wa:parent',true)[0];
    const reopened=new Store(join(f.root,'state.db'));
    try{assert.equal(new Attachments(reopened,f.root).references(f.a,'wa:parent')[0].sha256,f.file.sha256);}finally{reopened.close();}
    assert.equal(f.attachments.cleanup(Date.now()+48*3600000),0);
    f.store.jobState('wa:parent','completed');assert.equal(f.attachments.cleanup(Date.now()),0);
    assert.equal(f.attachments.cleanup(Date.now()+48*3600000),1);assert.equal(existsSync(ref.path!),false);
    assert.throws(()=>f.attachments.references(f.a,'wa:parent'),/unavailable/);
    f.attachments.stage(f.b,'master:child',f.file);f.attachments.cancel(f.b,'master:child');assert.throws(()=>f.attachments.references(f.b,'master:child'),/unavailable/);
  }finally{f.close();}
});
test('staging refuses symlink trees and unsafe names; real binary builds are typed honestly',()=>{
  const f=setup();try {
    symlinkSync(f.root,join(f.root,'incoming'));
    assert.throws(()=>f.attachments.stage(f.a,'wa:parent',f.file),/integrity/);
    for(const filename of ['../secret.txt','a\n.txt','CON.txt','LPT1.txt','NUL','payload.env','a..txt','file.txt '])assert.throws(()=>validateFile(filename,f.file.data));
    assert.equal(validateFile('app.exe',Buffer.from('MZ\0binary')).mime,'application/vnd.microsoft.portable-executable');
    assert.equal(validateFile('release.zip',Buffer.from([80,75,3,4,0,255])).mime,'application/zip');
    assert.throws(()=>validateFile('fake.txt',Buffer.from([80,75,3,4,0,255])),/UTF-8|Binary/);
    assert.throws(()=>validateFile('fake.zip',f.file.data),/signature/);
  }finally{f.close();}
});
test('invalid sizes and malicious URLs fail without network requests',async()=>{
  assert.equal(incomingMetadata({mimetype:'image/jpeg',fileLength:64*1024*1024},'image').size,64*1024*1024);
  assert.throws(()=>incomingMetadata({fileName:'a.txt',fileLength:MAX_FILE_BYTES+1},'document'),/limit/);
  for(const directPath of ['https://localhost/a','//localhost/a','/\\localhost/a','/bad\npath'])
    await assert.rejects(downloadAttachment({fileName:'a.txt',directPath,mediaKey:Buffer.alloc(32),fileSha256:Buffer.alloc(32)},'document'),/cannot be downloaded/);
});

function transportFixture(){
  const f=setup(),approvals=new Approvals(f.store),calls:any[]=[];
  f.store.jobState('wa:parent','completed');f.store.jobState('master:child','completed');
  const router=new Router(f.store,{run:async(...args:any[])=>{calls.push(args);},stop:()=>{}} as any,approvals);
  router.attachments=f.attachments;
  const wa=new WhatsApp(f.store,router);wa.status='connected';wa.selfJid='123@s.whatsapp.net';wa.owners=[wa.selfJid];
  f.store.set('active',f.a.id);wa.downloadFile=async()=>f.file;
  return {...f,wa,router,calls,close:()=>{wa.close();approvals.cancel();f.close();}};
}
const message=(id:string,caption='Review this',extra:any={})=>({key:{id,fromMe:true,remoteJid:'123@s.whatsapp.net'},message:{documentMessage:{fileName:'notes.txt',caption,...extra}}});

test('WhatsApp captions, quotes and duplicate events reach only the intended exact session once',async()=>{
  const f=transportFixture();try {
    f.store.output(f.b,'Quote this','quote');const quote=f.store.outbound().wa_id;
    let downloads=0;f.wa.downloadFile=async()=>{downloads++;await new Promise(r=>setTimeout(r,5));return f.file;};
    const m=message('quoted','Check this file',{contextInfo:{stanzaId:quote}});
    await Promise.all([f.wa.receiveMessage(m),f.wa.receiveMessage(m)]);await f.wa.receiveMessage(m);
    assert.equal(downloads,1);assert.equal(f.store.job('wa:quoted')?.binding_id,f.b.id);assert.equal(f.store.job('wa:quoted')?.body,'Check this file');
    assert.equal(f.attachments.references(f.b,'wa:quoted').length,1);assert.equal(f.calls.length,1);
    await f.wa.receiveMessage(message('target','/to b Fix the attached issue'));assert.equal(f.store.job('wa:target')?.binding_id,f.b.id);
    await f.wa.receiveMessage(message('empty',''));assert.match(f.store.job('wa:empty')!.body,/without a caption/);
    await new Promise(r=>setImmediate(r));
  }finally{f.close();}
});

test('incoming files fail closed for strangers, malicious captions, paused sessions and changed routes',async()=>{
  const f=transportFixture();try {
    let count=0;f.wa.downloadFile=async()=>{count++;return f.file;};
    await f.wa.receiveMessage({...message('stranger'),key:{id:'stranger',fromMe:false,remoteJid:'123@s.whatsapp.net'}});
    await f.wa.receiveMessage(message('approve','/approve CODE'));await f.wa.receiveMessage(message('quote','hello',{contextInfo:{stanzaId:'unknown'}}));
    assert.equal(count,0);
    f.store.enable(f.a.id,false);await f.wa.receiveMessage(message('paused'));assert.equal(count,0);f.store.enable(f.a.id,true);
    f.wa.downloadFile=async()=>{f.store.set('active',f.b.id);return f.file;};await f.wa.receiveMessage(message('changed'));
    assert.equal(f.store.job('wa:changed'),undefined);assert.equal(f.store.seen('wa:changed'),true);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM incoming_files').get()?.n,0);
  }finally{f.close();}
});

test('download cancellation, errors and restart produce one scoped failure without forwarding',async()=>{
  const f=transportFixture();try {
    let ready!:()=>void;const started=new Promise<void>(r=>ready=r);
    f.wa.downloadFile=async(_,__,signal)=>new Promise((_,reject)=>{signal!.addEventListener('abort',()=>reject(new Error('cancelled')));ready();});
    const work=f.wa.receiveMessage(message('cancelled'));await started;f.wa.close();await work;
    assert.equal(f.store.job('wa:cancelled'),undefined);assert.equal(f.wa.mediaControllers.size,0);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM outbox WHERE source='media-error:wa:cancelled:0'").get()?.n,1);
    f.attachments.interrupt('Again');assert.equal(f.store.db.prepare("SELECT count(*) n FROM outbox WHERE source='media-error:wa:cancelled:0'").get()?.n,1);
  }finally{f.close();}
});

test('owner-only group membership is checked before download and again before staging',async()=>{
  const f=transportFixture();try {
    const group='owner@g.us';f.store.set('destination-jid',group);f.store.set(`owned-group:${group}`,'Owner');
    let checks=0;f.wa.sock={end:()=>{},groupMetadata:async()=>({participants:++checks===1?[{id:'123@s.whatsapp.net'}]:[{id:'999@s.whatsapp.net'}]})} as any;
    const m=message('group');m.key.remoteJid=group;await f.wa.receiveMessage(m);
    assert.equal(checks,2);assert.equal(f.store.job('wa:group'),undefined);
    assert.equal(f.store.outbound().destination,group);
  }finally{f.close();}
});

test('download validates actual plaintext bytes, hash and count, never media-provided URL',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ffd-download-'));try{
  const data=Buffer.from('Verified incoming bytes'),fileSha256=createHash('sha256').update(data).digest();
  const media={fileName:'notes.txt',fileSha256,fileLength:data.length,directPath:'/v/t/file',mediaKey:Buffer.alloc(32),url:'http://127.0.0.1/private'};
  const downloader=(async(input:any,kind:any,options:any)=>{
    assert.equal(kind,'document');assert.equal(input.url,undefined);assert.equal(options.host,'mmg.whatsapp.net');assert.equal(options.options.redirect,'error');
    return Readable.from([data.subarray(0,4),data.subarray(4)]);
  }) as any;
  const received=await downloadAttachment(media,'document',undefined,downloader,root);assert.deepEqual(readFileSync(received.download!.path),data);disposeIncoming(received);
  await assert.rejects(downloadAttachment({...media,fileSha256:Buffer.alloc(32)},'document',undefined,downloader,root),/integrity/);
  await assert.rejects(downloadAttachment({...media,fileLength:data.length+1},'document',undefined,downloader,root),/integrity/);
  const abort=new AbortController();abort.abort();await assert.rejects(downloadAttachment(media,'document',abort.signal,downloader,root),/abort/i);
  const tooBig=(async()=>Readable.from([Buffer.alloc(data.length+1)])) as any;
  await assert.rejects(downloadAttachment(media,'document',undefined,tooBig,root),/declared size/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('master forwarding is explicit and atomic; retries preserve copies and changed IDs fail',()=>{
  const f=transportFixture();try {
    f.store.jobState('wa:parent','submitted');f.store.set('master',f.a.id);f.store.set('selected',JSON.stringify([f.b.id]));
    const coordinator=new Coordinator(f.store,f.router.native,f.router);f.router.coordinator=coordinator;
    f.router.pump=()=>{};
    const id=f.attachments.stage(f.a,'wa:parent',f.file);
    const [child]=coordinator.dispatch('wa:parent',[f.b.id],'Read the attached notes','event',[id]);
    const first=f.attachments.references(f.b,child);assert.equal(first.length,1);
    assert.deepEqual(coordinator.dispatch('wa:parent',[f.b.id],'Read the attached notes','event',[id]),[child]);assert.deepEqual(f.attachments.references(f.b,child),first);
    assert.throws(()=>coordinator.dispatch('wa:parent',[f.b.id],'Read the attached notes','event',[]),/different attachments/);
    assert.throws(()=>coordinator.dispatch('wa:parent',[f.b.id],'Read the attached notes','bad',['invented']),/original owner/);
    assert.equal(f.store.job(`master:wa:parent:bad:${f.b.id}`),undefined);
    assert.throws(()=>coordinator.dispatch('report:child',[f.b.id],'Read','bad-report',[id]),/owner request/);
  }finally{f.close();}
});
