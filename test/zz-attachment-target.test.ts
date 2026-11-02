import './brain-fixture-isolation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,chmodSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {Router} from '../src/router.js';
import {Approvals} from '../src/approvals.js';
import {Attachments} from '../src/attachments.js';
import {Telegram,telegramDestination,telegramMessageId} from '../src/telegram.js';
import {WhatsApp} from '../src/whatsapp.js';
import {sessionSpecialty} from '../src/session-specialty.js';
import {startDirect} from '../src/owner-routing.js';
import {MetaSecret,DEFAULT_BRAIN,saveBrainConfig} from '../src/meta-brain-config.js';
import {TaskContracts} from '../src/task-contracts.js';
import {sessionResearchRequest} from '../src/session-research.js';

const pdf=Buffer.from('%PDF-1.4\n% synthetic test only\n');
const digest=createHash('sha256').update(pdf).digest('hex');
function fixture(channel:'telegram'|'whatsapp'){
 const root=mkdtempSync(join(tmpdir(),'ffd-continuity-')),s=new Store(':memory:'),approvals=new Approvals(s),r=new Router(s,{run:async()=>{},stop:()=>{},warmDesktop:()=>{}} as any,approvals);r.pump=()=>{};r.attachments=new Attachments(s,root);
 const b=s.register('target','codex',randomUUID(),root).binding,other=s.register('other','claude',randomUUID(),root).binding;s.set('active',b.id);
 const dest=channel==='telegram'?telegramDestination(123456,777):'123456789@s.whatsapp.net';s.set('control-channel',channel);s.set(channel==='telegram'?'telegram-owner':'whatsapp-owner',dest);
 let data=pdf,gate:Promise<void>|undefined,started:(()=>void)|undefined;const wait=async()=>{started?.();if(gate)await gate;};
 const fetcher:typeof fetch=async(url)=>{if(String(url).includes('/file/bot')){await wait();return new Response(data);}return Response.json({ok:true,result:{file_path:'documents/test.pdf'}});};
 const tg=new Telegram(s,r,root,fetcher);(tg as any).bot={id:123456,username:'test_bot'};(tg as any).token='synthetic';tg.closed=false;tg.status='connected';
 const wa=new WhatsApp(s,r,root);wa.status='connected';wa.selfJid=dest;wa.owners=[dest];wa.downloadFile=async()=>{await wait();return {kind:'document',filename:'resume.pdf',data,sha256:createHash('sha256').update(data).digest('hex')} as any;};
 const message=async(id:number,text:string,extra:any={})=>{
  if(channel==='telegram')return tg.receive({message:{message_id:id,date:Math.floor(Date.now()/1000),text,chat:{id:777,type:'private'},from:{id:777,is_bot:false},...extra}});
  return wa.receiveMessage({key:{id:String(id),fromMe:true,remoteJid:dest},message:extra.message??{conversation:text}});
 };
 const jobId=(id:number)=>channel==='telegram'?telegramMessageId(123456,777,id):`wa:${id}`;
 const answerId=channel==='telegram'?telegramMessageId(123456,777,70):'question-70';
 const publishAnswer=(requestId:string)=>{
  s.output(b,'Which location and work authorization should I use?','synthetic-question',dest,{requestId,kind:'progress',origin:'agent'});
  s.db.prepare("UPDATE outbox SET status='sent',wa_id=? WHERE source='synthetic-question:0'").run(answerId);
 };
 const settle=async()=>{for(let i=0;i<100&&tg.hasPendingIngress();i++)await new Promise(r=>setTimeout(r,2));};
 return {root,s,r,b,other,tg,wa,dest,message,jobId,answerId,publishAnswer,settle,setData(value:Buffer){data=value;},setGate(p:Promise<void>,onStart:()=>void){gate=p;started=onStart;},close(){tg.close();wa.close();approvals.cancel();s.close();rmSync(root,{recursive:true,force:true});}};
}

for(const channel of ['telegram','whatsapp'] as const){
 test(`${channel}: quoted résumé continuation preserves approved Jobs query and exact session`,async()=>{
  const f=fixture(channel);try{
   const secret=new MetaSecret(f.root);secret.save('synthetic-key-not-a-real-secret');saveBrainConfig(f.s,secret,{policy:{...DEFAULT_BRAIN,enabled:true,taskContracts:true}});
   f.r.contracts=new TaskContracts(f.s,secret,async()=>({kind:'contract',goal:'Find jobs',exclusions:['Do not apply'],checks:['Show sources','List roles'],question:''}));
   await f.message(1,'/codex');await f.message(2,'/jobs Ai engineer in yc startups');
   f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
   await f.message(3,'ok');const original=f.jobId(3);assert.ok(f.r.contracts.hasGuard(original));f.publishAnswer(original);
   if(channel==='telegram')await f.message(4,'',{document:{file_id:'synthetic',file_size:pdf.length,file_name:'resume.pdf'},reply_to_message:{message_id:70,from:{id:123456}}});
   else await f.message(4,'',{message:{documentMessage:{mimetype:'application/pdf',fileName:'resume.pdf',fileLength:pdf.length,contextInfo:{stanzaId:f.answerId}}}});
   await f.settle();const id=f.jobId(4),job=f.s.job(id)!;assert.ok(job);assert.equal(job.binding_id,f.b.id);assert.match(job.body,/Ai engineer in yc startups/);assert.match(job.body,/Do not apply/);
   assert.match(job.body,/Do not send the document or its contents to a search service/);assert.equal(sessionSpecialty(f.s,id)?.kind,'jobs');assert.ok(f.r.contracts.hasGuard(id));
   const [ref]=f.r.attachments.references(f.b,id,true);assert.equal(ref.sha256,digest);assert.throws(()=>f.r.attachments.references(f.other,id),/session/);
   let query='';f.r.reach=async(command)=>{query=command;return 'No usable public results were returned.';};
   await f.s.destinationContext.run(f.dest,()=>sessionResearchRequest(f.s,f.r,f.b,id,sessionSpecialty));assert.equal(query,'/reach web search Ai engineer in yc startups');
   await f.s.destinationContext.run(f.dest,()=>f.r.assertDispatchAllowed(id,f.b));
   if(channel==='telegram')await f.message(5,'',{document:{file_id:'synthetic',file_size:pdf.length,file_name:'resume.pdf'},reply_to_message:{message_id:70,from:{id:123456}}});
   else await f.message(5,'',{message:{documentMessage:{mimetype:'application/pdf',fileName:'resume.pdf',fileLength:pdf.length,contextInfo:{stanzaId:f.answerId}}}});
   await f.settle();assert.equal(f.s.job(f.jobId(5)),undefined);
   chmodSync(ref.path!,0o600);writeFileSync(ref.path!,'%PDF-1.4 synthetic tamper');assert.throws(()=>f.r.attachments.references(f.b,id),/integrity/);
  }finally{f.close();}
 });
}

for(const channel of ['telegram','whatsapp'] as const){
 test(`${channel}: a forwarded Jobs attachment cannot claim the owner's question`,async()=>{const f=fixture(channel);try{
  await f.message(1,'/codex');await f.message(2,'/jobs Ai engineer in yc startups');f.publishAnswer(f.jobId(2));
  if(channel==='telegram')await f.message(4,'',{document:{file_id:'synthetic',file_size:pdf.length,file_name:'resume.pdf'},forward_origin:{type:'user'},reply_to_message:{message_id:70,from:{id:123456}}});
  else await f.message(4,'',{message:{documentMessage:{mimetype:'application/pdf',fileName:'resume.pdf',fileLength:pdf.length,contextInfo:{stanzaId:f.answerId,isForwarded:true,forwardingScore:1}}}});
  await f.settle();assert.equal(f.s.job(f.jobId(4)),undefined);
 }finally{f.close();}});
 test(`${channel}: a stale Jobs question cannot authorize a file`,async()=>{const f=fixture(channel);try{
  await f.message(1,'/codex');await f.message(2,'/jobs Ai engineer in yc startups');f.publishAnswer(f.jobId(2));
  f.s.db.prepare("UPDATE outbox SET created_at=? WHERE source='synthetic-question:0'").run(Date.now()-11*60_000);
  if(channel==='telegram')await f.message(4,'',{document:{file_id:'synthetic',file_size:pdf.length,file_name:'resume.pdf'},reply_to_message:{message_id:70,from:{id:123456}}});
  else await f.message(4,'',{message:{documentMessage:{mimetype:'application/pdf',fileName:'resume.pdf',fileLength:pdf.length,contextInfo:{stanzaId:f.answerId}}}});
  await f.settle();assert.equal(f.s.job(f.jobId(4)),undefined);
 }finally{f.close();}});
 test(`${channel}: owner change during Jobs file download cancels the file`,async()=>{const f=fixture(channel);let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),begun=new Promise<void>(r=>started=r);try{
  await f.message(1,'/codex');await f.message(2,'/jobs Ai engineer in yc startups');f.publishAnswer(f.jobId(2));f.setGate(gate,started);
  const receive=channel==='telegram'?f.message(4,'',{document:{file_id:'synthetic',file_size:pdf.length,file_name:'resume.pdf'},reply_to_message:{message_id:70,from:{id:123456}}}):f.message(4,'',{message:{documentMessage:{mimetype:'application/pdf',fileName:'resume.pdf',fileLength:pdf.length,contextInfo:{stanzaId:f.answerId}}}});
  await begun;const key=channel==='telegram'?'telegram-owner':'whatsapp-owner';f.s.set(key,channel==='telegram'?'tg:123456:888':'999@s.whatsapp.net');f.s.set(key,f.dest);release();await receive;await f.settle();assert.equal(f.s.job(f.jobId(4)),undefined);
 }finally{release();f.close();}});
}

for(const channel of ['telegram','whatsapp'] as const){
 test(`${channel}: a PDF with a caption is rejected when task contracts are enabled`,async()=>{
  const f=fixture(channel);try{
   await f.message(1,'/codex');(f.r.contracts as any).enabled=()=>true;
   if(channel==='telegram')await f.message(2,'',{document:{file_id:'synthetic',file_size:pdf.length,file_name:'resume.pdf'},caption:'This is my resume'});
   else await f.message(2,'',{message:{documentMessage:{mimetype:'application/pdf',fileName:'resume.pdf',fileLength:pdf.length,caption:'This is my resume'}}});
   await f.settle();assert.equal(f.s.job(f.jobId(2)),undefined);
   assert.equal((f.s.db.prepare('SELECT status FROM media_inbox WHERE id=?').get(f.jobId(2)) as any).status,'failed');
   const notice=f.s.db.prepare('SELECT body FROM outbox WHERE source LIKE ?').get(channel==='telegram'?'telegram-media-error:%':'media-error:%') as {body:string};
   assert.match(notice.body,/Attachment task review is not available yet/);assert.doesNotMatch(notice.body,/20 MB|2,097,152,000/);
  }finally{f.close();}
 });
 test(`${channel}: invalid PDF signature is rejected`,async()=>{
  const f=fixture(channel);try{
   await f.message(1,'/codex');const invalid=Buffer.from('not a PDF');f.setData(invalid);
   if(channel==='telegram')await f.message(2,'',{document:{file_id:'synthetic',file_size:invalid.length,file_name:'resume.pdf'}});
   else await f.message(2,'',{message:{documentMessage:{mimetype:'application/pdf',fileName:'resume.pdf',fileLength:invalid.length}}});
   await f.settle();assert.equal(f.s.job(f.jobId(2)),undefined);
   assert.equal((f.s.db.prepare('SELECT status FROM media_inbox WHERE id=?').get(f.jobId(2)) as any).status,'failed');
  }finally{f.close();}
 });
}

test('Telegram rejects PDF declared above the 20,000,000 byte download ceiling',async()=>{
 const f=fixture('telegram');try{
  await f.message(1,'/codex');await f.message(2,'',{document:{file_id:'synthetic',file_size:20_000_001,file_name:'resume.pdf'}});await f.settle();
  assert.equal(f.s.job(f.jobId(2)),undefined);assert.equal((f.s.db.prepare('SELECT status FROM media_inbox WHERE id=?').get(f.jobId(2)) as any).status,'failed');
 }finally{f.close();}
});
test('WhatsApp rejects PDF declared above its 2,097,152,000 byte ceiling',async()=>{
 const f=fixture('whatsapp');try{
  await f.message(1,'/codex');await f.message(2,'',{message:{documentMessage:{mimetype:'application/pdf',fileName:'resume.pdf',fileLength:2_097_152_001}}});
  assert.equal(f.s.job(f.jobId(2)),undefined);assert.equal((f.s.db.prepare('SELECT status FROM media_inbox WHERE id=?').get(f.jobId(2)) as any).status,'failed');
 }finally{f.close();}
});
test('non-owner documents are rejected by both adapters',async()=>{
 const t=fixture('telegram'),w=fixture('whatsapp');try{
  await t.message(1,'/codex');await t.tg.receive({message:{message_id:2,date:Math.floor(Date.now()/1000),chat:{id:888,type:'private'},from:{id:888,is_bot:false},document:{file_id:'synthetic',file_size:pdf.length,file_name:'resume.pdf'}}});
  await w.message(1,'/codex');await w.wa.receiveMessage({key:{id:'2',fromMe:false,remoteJid:w.dest},message:{documentMessage:{mimetype:'application/pdf',fileName:'resume.pdf',fileLength:pdf.length}}});
  await t.settle();assert.equal(t.s.job(t.jobId(2)),undefined);assert.equal(w.s.job(w.jobId(2)),undefined);
 }finally{t.close();w.close();}
});

for(const channel of ['telegram','whatsapp'] as const){
 test(`${channel}: quoted reply and PDF follow-up use a separate session request`,async()=>{
  const f=fixture(channel);try{
   await f.message(1,'/codex');await f.message(2,'/jobs Ai engineer in yc startups');const original=f.jobId(2);assert.equal(f.s.job(original)?.binding_id,f.b.id);f.publishAnswer(original);
   if(channel==='telegram')await f.message(3,'Remote only',{reply_to_message:{message_id:70,from:{id:123456}}});
   else await f.message(3,'',{message:{extendedTextMessage:{text:'Remote only',contextInfo:{stanzaId:f.answerId}}}});
   const quoted=f.s.job(f.jobId(3));assert.equal(quoted?.binding_id,f.b.id);assert.match(quoted?.body??'',/Ai engineer in yc startups/);assert.match(quoted?.body??'',/Remote only/);assert.equal(sessionSpecialty(f.s,f.jobId(3))?.kind,'jobs');
   if(channel==='telegram')await f.message(4,'',{document:{file_id:'synthetic',file_size:pdf.length,file_name:'resume.pdf'},reply_to_message:{message_id:70,from:{id:123456}}});
   else await f.message(4,'',{message:{documentMessage:{mimetype:'application/pdf',fileName:'resume.pdf',fileLength:pdf.length,contextInfo:{stanzaId:f.answerId}}}});
   await f.settle();const fileId=f.jobId(4),fileJob=f.s.job(fileId);assert.equal(fileJob?.binding_id,f.b.id);assert.match(fileJob?.body??'',/without a caption/);assert.equal(f.r.attachments.references(f.b,fileId).length,1);assert.equal(sessionSpecialty(f.s,fileId)?.kind,'jobs');assert.equal(f.s.itemOf(fileId),undefined);
  }finally{f.close();}
 });
}

for(const channel of ['telegram','whatsapp'] as const){
 test(`${channel}: unquoted PDF follows the direct target even if a different session is active`,async()=>{
  const f=fixture(channel);try{
   f.s.destinationContext.run(f.dest,()=>startDirect(f.s,f.other));
   if(channel==='telegram')await f.message(5,'',{document:{file_id:'synthetic',file_size:pdf.length,file_name:'resume.pdf'}});
   else await f.message(5,'',{message:{documentMessage:{mimetype:'application/pdf',fileName:'resume.pdf',fileLength:pdf.length}}});
   await f.settle();assert.equal(f.s.job(f.jobId(5))?.binding_id,f.other.id);
  }finally{f.close();}
 });
 test(`${channel}: paused direct target fails closed`,async()=>{
  const f=fixture(channel);try{
   f.s.destinationContext.run(f.dest,()=>startDirect(f.s,f.other));f.s.enable(f.other.id,false);
   if(channel==='telegram')await f.message(5,'',{document:{file_id:'synthetic',file_size:pdf.length,file_name:'resume.pdf'}});
   else await f.message(5,'',{message:{documentMessage:{mimetype:'application/pdf',fileName:'resume.pdf',fileLength:pdf.length}}});
   await f.settle();assert.equal(f.s.job(f.jobId(5)),undefined);
  }finally{f.close();}
 });
 test(`${channel}: target changes away and back during PDF download fail closed`,async()=>{
  const f=fixture(channel);try{
   f.s.destinationContext.run(f.dest,()=>startDirect(f.s,f.other));let release!:()=>void,started!:()=>void;
   const gate=new Promise<void>(r=>release=r),begun=new Promise<void>(r=>started=r);f.setGate(gate,started);
   const receive=channel==='telegram'?f.message(5,'',{document:{file_id:'synthetic',file_size:pdf.length,file_name:'resume.pdf'}}):f.message(5,'',{message:{documentMessage:{mimetype:'application/pdf',fileName:'resume.pdf',fileLength:pdf.length}}});
   await begun;f.s.destinationContext.run(f.dest,()=>{startDirect(f.s,f.b);startDirect(f.s,f.other);});release();await receive;await f.settle();
   assert.equal(f.s.job(f.jobId(5)),undefined);
  }finally{f.close();}
 });
 test(`${channel}: pausing and restoring the target during PDF download fails closed`,async()=>{
  const f=fixture(channel);try{
   f.s.destinationContext.run(f.dest,()=>startDirect(f.s,f.other));let release!:()=>void,started!:()=>void;
   const gate=new Promise<void>(r=>release=r),begun=new Promise<void>(r=>started=r);f.setGate(gate,started);
   const receive=channel==='telegram'?f.message(5,'',{document:{file_id:'synthetic',file_size:pdf.length,file_name:'resume.pdf'}}):f.message(5,'',{message:{documentMessage:{mimetype:'application/pdf',fileName:'resume.pdf',fileLength:pdf.length}}});
   await begun;f.s.enable(f.other.id,false);f.s.enable(f.other.id,true);release();await receive;await f.settle();
   assert.equal(f.s.job(f.jobId(5)),undefined);
  }finally{f.close();}
 });
 test(`${channel}: Jobs attachment fails closed if the selected session changed`,async()=>{
  const f=fixture(channel);try{
   await f.message(1,'/codex');await f.message(2,'/jobs Ai engineer in yc startups');f.publishAnswer(f.jobId(2));
   f.s.destinationContext.run(f.dest,()=>startDirect(f.s,f.other));f.s.set(`owner-target:${f.dest}`,'null');
   if(channel==='telegram')await f.message(5,'',{document:{file_id:'synthetic',file_size:pdf.length,file_name:'resume.pdf'},reply_to_message:{message_id:70,from:{id:123456}}});
   else await f.message(5,'',{message:{documentMessage:{mimetype:'application/pdf',fileName:'resume.pdf',fileLength:pdf.length,contextInfo:{stanzaId:f.answerId}}}});
   await f.settle();assert.equal(f.s.job(f.jobId(5)),undefined);
  }finally{f.close();}
 });
 test(`${channel}: explicit /to alias still overrides the direct session for an attachment`,async()=>{
  const f=fixture(channel);try{
   f.s.destinationContext.run(f.dest,()=>startDirect(f.s,f.other));
   if(channel==='telegram')await f.message(5,'',{document:{file_id:'synthetic',file_size:pdf.length,file_name:'resume.pdf'},caption:'/to target Review my resume'});
   else await f.message(5,'',{message:{documentMessage:{mimetype:'application/pdf',fileName:'resume.pdf',fileLength:pdf.length,caption:'/to target Review my resume'}}});
   await f.settle();assert.equal(f.s.job(f.jobId(5))?.binding_id,f.b.id);assert.equal(f.s.job(f.jobId(5))?.body,'Review my resume');
  }finally{f.close();}
 });
 for(const route of ['quote','alias'] as const){
  test(`${channel}: ${route} target pause and restore during download is rejected`,async()=>{
   const f=fixture(channel);try{
    await f.message(1,'/codex');await f.message(2,'/jobs Ai engineer in yc startups');f.publishAnswer(f.jobId(2));
    let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),begun=new Promise<void>(r=>started=r);f.setGate(gate,started);
    const extra=channel==='telegram'?{document:{file_id:'synthetic',file_size:pdf.length,file_name:'resume.pdf'},...(route==='quote'?{reply_to_message:{message_id:70,from:{id:123456}}}:{caption:'/to target Review my resume'})}
      :{message:{documentMessage:{mimetype:'application/pdf',fileName:'resume.pdf',fileLength:pdf.length,...(route==='quote'?{contextInfo:{stanzaId:f.answerId}}:{caption:'/to target Review my resume'})}}};
    const receive=f.message(5,'',extra);await begun;f.s.enable(f.b.id,false);f.s.enable(f.b.id,true);release();await receive;await f.settle();
    assert.equal(f.s.job(f.jobId(5)),undefined);
   }finally{f.close();}
  });
  test(`${channel}: unrelated session changes do not redirect a ${route} attachment`,async()=>{
   const f=fixture(channel);try{
    await f.message(1,'/codex');await f.message(2,'/jobs Ai engineer in yc startups');f.publishAnswer(f.jobId(2));
    let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),begun=new Promise<void>(r=>started=r);f.setGate(gate,started);
    const extra=channel==='telegram'?{document:{file_id:'synthetic',file_size:pdf.length,file_name:'resume.pdf'},...(route==='quote'?{reply_to_message:{message_id:70,from:{id:123456}}}:{caption:'/to target Review my resume'})}
      :{message:{documentMessage:{mimetype:'application/pdf',fileName:'resume.pdf',fileLength:pdf.length,...(route==='quote'?{contextInfo:{stanzaId:f.answerId}}:{caption:'/to target Review my resume'})}}};
    const receive=f.message(5,'',extra);await begun;f.s.enable(f.other.id,false);f.s.enable(f.other.id,true);release();await receive;await f.settle();
    assert.equal(f.s.job(f.jobId(5))?.binding_id,route==='quote'?undefined:f.b.id);
   }finally{f.close();}
  });
 }
}
