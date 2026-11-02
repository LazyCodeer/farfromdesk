import './brain-fixture-isolation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import sharp from 'sharp';
import {Store} from '../src/store.js';
import {Router} from '../src/router.js';
import {Approvals} from '../src/approvals.js';
import {SocialAssistant} from '../src/social-assistant.js';
import {saveSessionSocialDrafts} from '../src/social-session-drafts.js';
import {socialPreviewDeliveryState} from '../src/social-preview.js';
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'ffd-preview-')),s=new Store(':memory:'),a=new Approvals(s),r=new Router(s,{run:async()=>{},stop:()=>{}} as any,a);r.pump=()=>{};
 s.set('control-channel','telegram');s.set('telegram-owner','tg:123');const b=s.register('preview','codex',randomUUID(),root).binding;s.set('active',b.id);
 const id='tg:123:1';await s.destinationContext.run('tg:123',()=>r.receive({id,text:'/social Create Instagram and LinkedIn carousels',ownerCommand:true,ownerIntent:true}));s.jobState(id,'dispatched');
 const social=new SocialAssistant(s.db,()=>{throw Error('No key access');});
 const bytes=await sharp({create:{width:1080,height:1350,channels:3,background:'#8844aa'}}).jpeg().toBuffer();
 const image={base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
 const add=(caption='Full caption',platform='Instagram',count=2)=>{
  const draftId=saveSessionSocialDrafts(s,b,id,randomUUID(),[{platform,format:'Carousel',title:'Post',caption}]).draftIds[0];
  const d=JSON.parse(String(s.db.prepare('SELECT json FROM social_drafts WHERE id=?').get(draftId)!.json));d.carousel={slides:Array(count).fill(image)};
  s.db.prepare('UPDATE social_drafts SET json=? WHERE id=?').run(JSON.stringify(d),draftId);return draftId;
 };
 return {root,s,a,r,b,id,image,add,close(){a.cancel();s.close();rmSync(root,{recursive:true,force:true});}};
}
test('final reply queues each saved post as ordered photos with captions, once',async()=>{
 const f=await fixture();try{
  f.add();f.add('Professional caption','LinkedIn',1);
  f.r.channelReply(f.b,'Three slides are saved.','progress',f.id);
  assert.equal(f.s.db.prepare("SELECT count(*) n FROM outbox WHERE media_kind='photo'").get()!.n,0);
  f.r.channelReply(f.b,'Posts saved.','final',f.id);
  const photos=f.s.db.prepare("SELECT * FROM outbox WHERE media_kind='photo' ORDER BY rowid").all() as any[];
  assert.equal(photos.length,3);assert.equal(photos[0].body,'Instagram · 1/2\n\nFull caption');assert.equal(photos[1].body,'Instagram · 2/2');assert.equal(photos[2].body,'LinkedIn\n\nProfessional caption');
  assert.ok(photos.every(p=>p.destination==='tg:123'&&p.request_id===f.id));
  assert.equal(socialPreviewDeliveryState(f.s,photos[1].id),'hold');f.s.sent(photos[0].id);assert.equal(socialPreviewDeliveryState(f.s,photos[1].id),'ready');
  f.r.channelReply(f.b,'Posts saved.','final',f.id);assert.equal(f.s.db.prepare("SELECT count(*) n FROM outbox WHERE media_kind='photo'").get()!.n,3);
 }finally{f.close();}
});
test('long caption remains complete after images and failed earlier slides stop later previews',async()=>{
 const f=await fixture();try{
  const caption='Readable complete caption. '.repeat(70);f.add(caption);
  f.r.channelReply(f.b,'Saved.','final',f.id);
  const photos=f.s.db.prepare("SELECT * FROM outbox WHERE media_kind='photo' ORDER BY rowid").all() as any[];
  assert.ok(photos.every(p=>p.body.length<=1000));
  const texts=f.s.db.prepare("SELECT body FROM outbox WHERE source LIKE 'social-caption:%' ORDER BY rowid").all() as any[];assert.ok(texts.map(p=>p.body).join('').includes(caption.trim()));
  f.s.db.prepare("UPDATE outbox SET status='uncertain' WHERE id=?").run(photos[0].id);
  assert.equal(socialPreviewDeliveryState(f.s,photos[1].id),'invalid');assert.equal(f.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(photos[1].id)!.status,'cancelled');
 }finally{f.close();}
});
test('corrupt preview cannot finalize or partially queue a batch',async()=>{
 const f=await fixture();try{
  f.add();const id=f.add('Second');const d=JSON.parse(String(f.s.db.prepare('SELECT json FROM social_drafts WHERE id=?').get(id)!.json));d.carousel.slides[0].sha256='bad';f.s.db.prepare('UPDATE social_drafts SET json=? WHERE id=?').run(JSON.stringify(d),id);
  assert.throws(()=>f.r.channelReply(f.b,'Saved.','final',f.id),/integrity/);
  assert.equal(f.s.db.prepare("SELECT count(*) n FROM outbox WHERE media_kind='photo'").get()!.n,0);assert.equal(f.s.job(f.id)!.status,'dispatched');
 }finally{f.close();}
});
test('preview owner generation is pinned and interrupted sends are never replayed',async()=>{
 const f=await fixture();try{
  f.add();f.r.channelReply(f.b,'Saved.','final',f.id);
  const row=f.s.db.prepare("SELECT id FROM outbox WHERE media_kind='photo' ORDER BY rowid").get()!;
  assert.equal(f.s.incomingOwnerDelivery(String(row.id)),true);f.s.set('incoming-owner-generation',randomUUID());assert.equal(f.s.incomingOwnerDelivery(String(row.id)),false);
  f.s.db.prepare("UPDATE outbox SET status='sending' WHERE id=?").run(row.id);f.s.recover();assert.equal(f.s.db.prepare('SELECT status FROM outbox WHERE id=?').get(row.id)!.status,'uncertain');
 }finally{f.close();}
});
