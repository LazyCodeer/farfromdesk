import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {LocalMailHost} from '../src/local-email/host.js';
import {composeMail} from '../src/local-email/transport.js';
import type {MailSecretStore} from '../src/local-email/service.js';
import {isPublicMailAddress,publicMailConnector} from '../src/local-email/network-policy.js';

function fixture(){
  const db=new DatabaseSync(':memory:'),values=new Map<string,string>();let locked=true,approval=false,sends=0,writerCalls=0;
  let prompt:()=>Promise<boolean>=async()=>approval;
  const secrets:MailSecretStore={kind:'macos-keychain',available:()=>locked,read:async k=>values.get(k),save:async(k,v)=>{values.set(k,v);},remove:async k=>{values.delete(k);}};
  const transport:any={read:async(_key:any,_endpoint:any,_store:any,authority:any)=>{authority.assertCurrent();return [{uid:9,raw:Buffer.from('From: alex@example.test\r\nSubject: Demo\r\n\r\nSynthetic message')}];},send:async(_key:any,_endpoint:any,_store:any,draft:any,authority:any)=>{const digest=composeMail(draft).digest;await authority.claim(digest);authority.assertCurrent(digest);sends++;return {digest,status:'sent'};}};
  const host=new LocalMailHost(db,secrets,()=>locked,()=>prompt(),async(_req,current)=>{writerCalls++;assert.equal(current(),true);return 'Synthetic model text';},transport);
  return {db,host,setApproval:(v:boolean)=>approval=v,setPrompt:(p:()=>Promise<boolean>)=>prompt=p,setLocked:(v:boolean)=>locked=v,get sends(){return sends;},get writerCalls(){return writerCalls;},close:()=>{host.close();db.close();}};
}
async function account(f:ReturnType<typeof fixture>){return f.host.configure({label:'Synthetic',address:'sagar@example.test',imap:{host:'imap.example.test',port:993,username:'demo'},smtp:{host:'smtp.example.test',port:465,username:'demo'}},{imapPassword:'fake',smtpPassword:'fake'});}
test('native approval is required for the exact unchanged draft, and cannot be replayed',async()=>{
 const f=fixture();try{const a=await account(f),d=f.host.mail.saveDraft(a.id,undefined,{to:['alex@example.test'],subject:'Re',body:'Synthetic reply'});
  assert.equal((await f.host.send(a.id,d.id,d.revision,d.digest)).status,'cancelled');assert.equal(f.sends,0);
  f.setApproval(true);await assert.rejects(f.host.send(a.id,d.id,'wrong',d.digest));assert.equal(f.sends,0);
  assert.equal((await f.host.send(a.id,d.id,d.revision,d.digest)).status,'sent');assert.equal(f.sends,1);
  await assert.rejects(f.host.send(a.id,d.id,d.revision,d.digest));assert.equal(f.sends,1);
 }finally{f.close();}
});
test('draft edits or owner revocation during native review prevent transmission',async()=>{
 const f=fixture();try{const a=await account(f);let d=f.host.mail.saveDraft(a.id,undefined,{to:['alex@example.test'],subject:'Re',body:'First'});
  f.setPrompt(async()=>{f.host.mail.saveDraft(a.id,d.id,{to:['alex@example.test'],subject:'Re',body:'Changed'});return true;});await assert.rejects(f.host.send(a.id,d.id,d.revision,d.digest));assert.equal(f.sends,0);
  d=f.host.mail.getDraft(d.id);f.setPrompt(async()=>{f.host.revoke();return true;});await assert.rejects(f.host.send(a.id,d.id,d.revision,d.digest));assert.equal(f.sends,0);
 }finally{f.close();}
});
test('cloud writer requires explicit consent and fails closed on lost helper lock',async()=>{
 const f=fixture();try{const a=await account(f);await assert.rejects(f.host.assistant.summarize(a.id));assert.equal(f.writerCalls,0);f.host.setConsent(true);assert.equal((await f.host.assistant.summarize(a.id)).summary,'Synthetic model text');assert.equal(f.writerCalls,1);f.setLocked(false);assert.throws(()=>f.host.status());}finally{f.setLocked(true);f.close();}
});
test('network policy rejects special addresses, literal IPs and mixed DNS answers',async()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','169.254.1.2','100.64.0.1','192.0.0.7','::1','fc00::1','fe80::1','4000::1','2001:2::1','2002::1','3fff::1','::ffff:127.0.0.1'])assert.equal(isPublicMailAddress(ip),false,ip);
 for(const ip of ['8.8.8.8','2606:4700:4700::1111'])assert.equal(isPublicMailAddress(ip),true,ip);
 const connector=publicMailConnector(async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]);assert.throws(()=>connector({host:'127.0.0.1',port:443}));
 const socket=connector({host:'synthetic.invalid',port:443,servername:'synthetic.invalid'});const err=await new Promise<Error>(resolve=>socket.once('error',resolve));assert.match(err.message,/destination unavailable/i);
});
test('owner generation advances durably across revocation and host restart',()=>{
 const db=new DatabaseSync(':memory:'),secrets:MailSecretStore={kind:'macos-keychain',available:()=>true,read:async()=>undefined,save:async()=>{},remove:async()=>{}};
 const get=()=>Number((db.prepare("SELECT value FROM email_host_settings WHERE key='owner-generation'").get() as {value:string}).value);
 const first=new LocalMailHost(db,secrets,()=>true,async()=>false,async()=> '');const initial=get();first.revoke();assert.equal(get(),initial+1);first.close();const beforeRestart=get();
 const second=new LocalMailHost(db,secrets,()=>true,async()=>false,async()=> '');assert.equal(get(),beforeRestart+1);second.close();db.close();
});
