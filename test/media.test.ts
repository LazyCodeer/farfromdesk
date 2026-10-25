import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Approvals } from '../src/approvals.js';
import { WhatsApp } from '../src/whatsapp.js';
import { Artifacts, validateArtifact, readLocalArtifact, MAX_ARTIFACT_BYTES } from '../src/artifacts.js';
import { audioFormat, downloadAudio, transcribeAudio,hasAudibleSamples } from '../src/audio.js';

const owner='123@s.whatsapp.net';
function fixture(){
  const store=new Store(':memory:');store.set('whatsapp-owner',owner);
  const a=store.register('agent-a','codex','11111111-1111-4111-a111-111111111111','/tmp').binding;
  const b=store.register('agent-b','claude','22222222-2222-4222-a222-222222222222','/tmp').binding;
  const approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals),wa=new WhatsApp(store,router);
  wa.status='connected';wa.selfJid=owner;wa.owners=[owner];store.set('active',a.id);
  return {store,a,b,router,wa,artifacts:new Artifacts(store),close:()=>{wa.close();approvals.cancel();store.close();}};
}
const note=(id='note',key:any={},audio:any={})=>({key:{id,fromMe:true,remoteJid:owner,...key},message:{audioMessage:{mimetype:'audio/ogg; codecs=opus',seconds:3,fileLength:100,...audio}}});
const html=Buffer.from('<!doctype html><html><body>Private review</body></html>');

test('documents validate names, signatures, bytes, UTF-8 and exact local files',()=>{
  for(const name of ['../a.html','/tmp/a.html','bad\n.html','secret.env','file.unknown','x..html'])assert.throws(()=>validateArtifact(name,html));
  assert.throws(()=>validateArtifact('a.pdf',html));assert.throws(()=>validateArtifact('a.png',html));assert.throws(()=>validateArtifact('a.jpg',html));
  assert.throws(()=>validateArtifact('a.html',Buffer.from('not html')));assert.throws(()=>validateArtifact('a.txt',Buffer.from([255])));
  assert.throws(()=>validateArtifact('a.txt',Buffer.alloc(MAX_ARTIFACT_BYTES+1)));assert.throws(()=>validateArtifact('a.txt',Buffer.alloc(0)));
  const dir=mkdtempSync(join(tmpdir(),'artifact-'));try {
    writeFileSync(join(dir,'review.html'),html);symlinkSync(join(dir,'review.html'),join(dir,'link.html'));
    assert.throws(()=>readLocalArtifact(join(dir,'link.html')));assert.throws(()=>readLocalArtifact(dir));
    // /tmp may be a system symlink on macOS; canonicalize the explicitly selected path.
    const {realpathSync}=requireFs();assert.equal(readLocalArtifact(realpathSync(join(dir,'review.html'))).bytes,html.length);
    linkSync(join(dir,'review.html'),join(dir,'hard.html'));assert.throws(()=>readLocalArtifact(realpathSync(join(dir,'hard.html'))));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
import * as fs from 'node:fs';
function requireFs(){return fs;}

test('prepared documents are scoped to exact request, stable bytes, and original destination',async()=>{
  const f=fixture();try {
    f.store.enqueue('req-a',f.a,'review');f.store.enqueue('req-b',f.b,'other');
    const p=f.artifacts.prepare(f.a,'req-a','review.html',html.toString('base64'));
    assert.equal(f.artifacts.prepare(f.a,'req-a','review.html',html.toString('base64')).artifactId,p.artifactId);
    assert.throws(()=>f.artifacts.prepare(f.a,'req-b','review.html',html.toString('base64')));
    assert.throws(()=>f.artifacts.reply(f.b,'req-b',p.artifactId,''));assert.throws(()=>f.artifacts.reply(f.a,'req-b',p.artifactId,''));
    f.store.set('destination-jid','another@g.us');
    const delivery=f.artifacts.reply(f.a,'req-a',p.artifactId,'Review') as any;
    assert.equal(f.artifacts.reply(f.a,'req-a',p.artifactId,'Review').id,delivery.id);
    assert.throws(()=>f.artifacts.reply(f.a,'req-a',p.artifactId,'Different'));
    assert.throws(()=>f.artifacts.status(f.b,delivery.id));
    assert.equal(f.store.job('req-a')?.status,'queued');
    const sends:any[]=[];f.wa.sock={end:()=>{},sendMessage:async(...args:any[])=>{sends.push(args);return {message:{documentMessage:{fileName:'review.html'}}};}} as any;
    await f.wa.flush();await f.wa.flush();assert.equal(sends.length,1);assert.equal(sends[0][0],owner);
    assert.deepEqual(sends[0][1].document,html);assert.equal(sends[0][1].mimetype,'text/html');
    assert.equal(f.artifacts.status(f.a,delivery.id).status,'sent');
  }finally{f.close();}
});

test('paused bindings and corrupt documents never send; retries keep the same WhatsApp ID',async()=>{
  const f=fixture();try {
    f.store.enqueue('r',f.a,'review');const p=f.artifacts.prepare(f.a,'r','review.html',html.toString('base64'));
    const d=f.artifacts.reply(f.a,'r',p.artifactId,'') as any;
    f.store.enable(f.a.id,false);let sends=0,ids:string[]=[];
    f.wa.sock={end:()=>{},sendMessage:async(_:any,__:any,o:any)=>{sends++;ids.push(o.messageId);if(sends===1)throw new Error('network');}} as any;
    await f.wa.flush();assert.equal(sends,0);f.store.enable(f.a.id,true);
    await f.wa.flush();assert.equal(f.artifacts.status(f.a,d.id).status,'queued');
    f.store.db.prepare('UPDATE outbox SET next_at=0').run();await f.wa.flush();assert.equal(sends,2);assert.equal(ids[0],ids[1]);
    f.store.db.prepare("UPDATE outbox SET status='queued',next_at=0").run();f.store.db.prepare("UPDATE artifacts SET sha256='bad'").run();
    await f.wa.flush();assert.equal(sends,2);assert.equal(f.artifacts.status(f.a,d.id).status,'failed');
  }finally{f.close();}
});

test('only local artifact preparation can freeze the linked self-chat as an alternate destination',()=>{
  const f=fixture();try {
    f.store.enqueue('group-request',f.a,'send to self','owner-only@g.us');
    assert.throws(()=>f.artifacts.prepare(f.a,'group-request','review.html',html.toString('base64'),'stranger@s.whatsapp.net'));
    const original=f.artifacts.prepare(f.a,'group-request','review.html',html.toString('base64'));
    const self=f.artifacts.prepare(f.a,'group-request','review.html',html.toString('base64'),'self');
    assert.notEqual(original.artifactId,self.artifactId);
    const first=f.artifacts.reply(f.a,'group-request',original.artifactId,'') as any;
    const second=f.artifacts.reply(f.a,'group-request',self.artifactId,'') as any;
    assert.equal(f.store.db.prepare('SELECT destination FROM outbox WHERE id=?').get(first.id)?.destination,'owner-only@g.us');
    assert.equal(f.store.db.prepare('SELECT destination FROM outbox WHERE id=?').get(second.id)?.destination,owner);
  }finally{f.close();}
});

test('voice notes reject strangers, incoming third parties, non-owner groups before transcription',async()=>{
  const f=fixture();let calls=0;f.wa.transcribe=async()=>{calls++;return 'hello';};
  try {
    await f.wa.receiveMessage(note('1',{fromMe:false}));await f.wa.receiveMessage(note('2',{remoteJid:'999@s.whatsapp.net'}));
    f.store.set('destination-jid','g@g.us');f.store.set('owned-group:g@g.us','Group');
    f.wa.sock={end:()=>{},groupMetadata:async()=>({participants:[{id:owner},{id:'999@s.whatsapp.net'}]})} as any;
    await assert.rejects(f.wa.receiveMessage(note('3',{remoteJid:'g@g.us'})));
    assert.equal(calls,0);assert.equal(f.store.jobs().length,0);
  }finally{f.close();}
});

test('concurrent and later duplicate voice notes dispatch once to quoted session',async()=>{
  const f=fixture();try {
    f.store.output(f.b,'quote me','quote');const quoted=f.store.outbound().wa_id;
    let calls=0;f.wa.transcribe=async()=>{calls++;await new Promise(r=>setTimeout(r,5));return 'Please give an update';};
    const m=note('dup',{}, {contextInfo:{stanzaId:quoted}});
    await Promise.all([f.wa.receiveMessage(m),f.wa.receiveMessage(m)]);await f.wa.receiveMessage(m);
    assert.equal(calls,1);assert.equal(f.store.jobs().length,1);assert.equal(f.store.job('wa:dup')?.binding_id,f.b.id);
    assert.equal(f.store.job('wa:dup')?.destination,owner);assert.equal(f.store.job('wa:dup')?.body,'Please give an update');
  }finally{f.close();}
});

test('voice failure, empty transcript and oversized input get one useful failure without dispatch',async()=>{
  for(const mode of ['throw','empty','size','format','permission']) {
    const f=fixture();try {
      let calls=0;f.wa.transcribe=async()=>{calls++;if(mode==='throw')throw new Error('secret private URL');return mode==='permission'?'/approve 123':'';};
      const m=note(mode,{},mode==='size'?{seconds:301}:mode==='format'?{mimetype:'text/html'}:{});
      await f.wa.receiveMessage(m);await f.wa.receiveMessage(m);
      assert.equal(f.store.jobs().length,0);assert.equal(calls,mode==='size'||mode==='format'?0:1);
      const failures=f.store.db.prepare("SELECT body FROM outbox WHERE source LIKE 'audio-error:%'").all();assert.equal(failures.length,1);assert.doesNotMatch(String(failures[0].body),/secret private URL/);
    }finally{f.close();}
  }
});

test('changing selections during transcription fails closed; restart reports interrupted audio once',async()=>{
  const f=fixture();try {
    f.wa.transcribe=async()=>{f.store.set('selected','["different"]');return 'do task';};
    await f.wa.receiveMessage(note('changed'));assert.equal(f.store.jobs().length,0);
    f.store.db.prepare("INSERT INTO audio_inbox VALUES('wa:interrupted',?,'processing',0)").run(owner);
    f.store.recover();f.store.recover();assert.equal(f.store.seen('wa:interrupted'),true);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE source='audio-error:wa:interrupted:0'").get()?.n,1);
  }finally{f.close();}
});

test('pausing cancels active transcription and queues one interruption reply for reconnection',async()=>{
  const f=fixture();try {
    let started!:()=>void;const ready=new Promise<void>(r=>started=r);
    f.wa.transcribe=async(_,signal)=>new Promise((_,reject)=>{signal!.addEventListener('abort',()=>reject(new Error('cancelled')));started();});
    const work=f.wa.receiveMessage(note('paused'));await ready;f.wa.close();await work;
    assert.equal(f.store.jobs().length,0);assert.equal(f.store.seen('wa:paused'),true);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE source='audio-error:wa:paused:0'").get()?.n,1);
    assert.equal(f.wa.audioBusy,0);
  }finally{f.close();}
});

test('audio provider missing and malicious media locations fail before network access',async()=>{
  const f=fixture();try {
    await assert.rejects(transcribeAudio(f.store,note().message.audioMessage),/not configured/);
    assert.equal(audioFormat({mimetype:'audio/ogg',fileLength:64*1024*1024}),'ogg');
    for(const path of ['https://127.0.0.1/private','//localhost/private','/\\localhost/','/bad\npath'])await assert.rejects(downloadAudio({mimetype:'audio/ogg',directPath:path,mediaKey:Buffer.alloc(32)}),/cannot be downloaded/);
  }finally{f.close();}
});

test('silent PCM and malformed WAV are rejected before speech recognition',()=>{
  const wav=Buffer.alloc(44+32000);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVE',8);wav.write('fmt ',12);wav.writeUInt32LE(16,16);wav.write('data',36);wav.writeUInt32LE(32000,40);
  assert.equal(hasAudibleSamples(wav),false);
  for(let i=44;i<wav.length;i+=2)wav.writeInt16LE(Math.round(Math.sin(i)*5000),i);
  assert.equal(hasAudibleSamples(wav),true);assert.equal(hasAudibleSamples(Buffer.from('garbage')),false);
});
