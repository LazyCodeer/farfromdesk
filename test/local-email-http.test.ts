import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {LocalMailHost} from '../src/local-email/host.js';
import {composeMail} from '../src/local-email/transport.js';
import type {MailSecretStore} from '../src/local-email/service.js';
import { reservePort } from './test-port.js';

const root=mkdtempSync(join(tmpdir(),'ffd-email-http-'));
const port=await reservePort();
process.env.WSB_STATE_DIR=root;process.env.WSB_PORT=String(port);process.env.FFD_ISOLATED_LOCAL='1';
const [{serve},{Store},{Router},{Approvals}]=await Promise.all([import('../src/server.js'),import('../src/store.js'),import('../src/router.js'),import('../src/approvals.js')]);
test('Local email HTTP requires the native desktop token and a separate native send decision',async()=>{
 const store=new Store(':memory:'),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals),db=new DatabaseSync(':memory:'),values=new Map<string,string>();let approved=false,sends=0;
 const secret:MailSecretStore={kind:'macos-keychain',available:()=>true,read:async k=>values.get(k),save:async(k,v)=>{values.set(k,v);},remove:async k=>{values.delete(k);}};
 const transport:any={read:async()=>[{uid:1,raw:Buffer.from('From: alex@example.test\r\nSubject: Test\r\n\r\nHello')}],send:async(_k:any,_e:any,_s:any,d:any,a:any)=>{const digest=composeMail(d).digest;await a.claim(digest);a.assertCurrent(digest);sends++;return {digest,status:'sent'};}};
 const mail=new LocalMailHost(db,secret,()=>true,async()=>approved,async()=> 'Synthetic summary',transport);
 const binding=store.register('synthetic','codex',randomUUID(),root);
 const server=serve(store,router,{} as any,'synthetic-admin',{localMail:mail} as any);await once(server,'listening');
 const call=(token:string,body:any,extra:Record<string,string>={})=>fetch(`http://127.0.0.1:${port}/api/local-email`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...extra},body:JSON.stringify(body)});
 try{
   assert.equal((await call(binding.token,{action:'consent',enabled:true},{'x-binding-id':binding.binding.id})).status,403);
   assert.equal((await call('wrong',{action:'consent',enabled:true})).status,401);
   assert.equal((await call('synthetic-admin',{action:'consent',enabled:true},{origin:`http://localhost:${port}`})).status,403);
   const configured=await call('synthetic-admin',{action:'configure',account:{label:'Synthetic',address:'owner@example.test',imap:{host:'imap.example.test',port:993,username:'owner'},smtp:{host:'smtp.example.test',port:465,username:'owner'}},credentials:{imapPassword:'secret-synthetic',smtpPassword:'secret-synthetic'}});assert.equal(configured.status,200);const a=await configured.json() as any;assert.doesNotMatch(JSON.stringify(a),/secret-synthetic/);
   const response=await call('synthetic-admin',{action:'save',accountId:a.id,input:{to:['alex@example.test'],subject:'Reply',body:'Synthetic reply'}});const d=await response.json() as any;
   const body={action:'send',accountId:a.id,draftId:d.id,revision:d.revision,digest:d.digest,confirmed:true,approvalRef:'fake'};
   assert.equal((await (await call('synthetic-admin',body)).json() as any).status,'cancelled');assert.equal(sends,0);
   approved=true;assert.equal((await (await call('synthetic-admin',body)).json() as any).status,'sent');assert.equal(sends,1);
 }finally{await new Promise<void>(r=>server.close(()=>r()));mail.close();db.close();approvals.cancel();store.close();rmSync(root,{recursive:true,force:true});}
});
test('desktop HTTP reads, summarizes, drafts and approves a reply through synthetic TLS servers',async()=>{
 const {execFileSync}=await import('node:child_process'),{readFileSync}=await import('node:fs'),tls=await import('node:tls'),transport=await import('../src/local-email/transport.js');
 const certRoot=mkdtempSync(join(tmpdir(),'ffd-email-tls-'));execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(certRoot,'key.pem'),'-out',join(certRoot,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
 const key=readFileSync(join(certRoot,'key.pem')),cert=readFileSync(join(certRoot,'cert.pem'));
 const lines=(socket:import('node:tls').TLSSocket,handle:(line:string)=>void)=>{let pending='';socket.on('data',data=>{pending+=data.toString();for(;;){const at=pending.indexOf('\r\n');if(at<0)break;const line=pending.slice(0,at);pending=pending.slice(at+2);handle(line);}});};
 const server=async(handler:(socket:import('node:tls').TLSSocket)=>void)=>{const s=tls.createServer({key,cert},handler);s.listen(0,'127.0.0.1');await once(s,'listening');return {port:(s.address() as {port:number}).port,close:()=>new Promise<void>(r=>s.close(()=>r()))};};
 const raw=Buffer.from('From: alex@example.test\r\nSubject: Synthetic meeting\r\n\r\nCan we meet Tuesday?\r\n');let received='',smtpConnections=0;
 const imap=await server(sock=>{sock.write('* OK synthetic\r\n');lines(sock,line=>{const tag=line.split(' ')[0];if(line.includes(' LOGIN '))sock.write(`${tag} OK\r\n`);else if(line.includes(' EXAMINE '))sock.write(`* 1 EXISTS\r\n${tag} OK\r\n`);else if(line.includes(' SEARCH '))sock.write(`* SEARCH 9\r\n${tag} OK\r\n`);else if(line.includes(' FETCH ')){sock.write(`* 1 FETCH (UID 9 BODY[] {${raw.length}}\r\n`);sock.write(raw);sock.write(`)\r\n${tag} OK\r\n`);}});});
 const smtp=await server(sock=>{smtpConnections++;let data=false;sock.write('220 synthetic\r\n');lines(sock,line=>{if(data){if(line==='.')sock.write('250 accepted\r\n');else received+=line+'\r\n';}else if(line.startsWith('EHLO'))sock.write('250-synthetic\r\n250 AUTH PLAIN\r\n');else if(line.startsWith('AUTH'))sock.write('235 ok\r\n');else if(line.startsWith('MAIL')||line.startsWith('RCPT'))sock.write('250 ok\r\n');else if(line==='DATA'){data=true;sock.write('354 go\r\n');}});});
 const store=new Store(':memory:'),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals),db=new DatabaseSync(':memory:'),values=new Map<string,string>();let approved=false;
 const secret:MailSecretStore={kind:'macos-keychain',available:()=>true,read:async k=>values.get(k),save:async(k,v)=>{values.set(k,v);},remove:async k=>{values.delete(k);}};
 const deps={connectTls:(opts:any)=>tls.connect({...opts,ca:cert}),timeoutMs:3000};const syntheticTransport:any={read:(id:any,e:any,s:any,a:any,l:any)=>transport.readAccountInbox(id,e,s,a,l,deps),send:(id:any,e:any,s:any,d:any,a:any)=>transport.sendAccountMail(id,e,s,d,a,deps)};
 const mail=new LocalMailHost(db,secret,()=>true,async()=>approved,async(request,current)=>{assert.equal(current(),true);return request.task==='summary'?'Alex suggests Tuesday.':'Tuesday works. Thanks, Sagar.';},syntheticTransport);
 const http=serve(store,router,{} as any,'synthetic-admin',{localMail:mail} as any);await once(http,'listening');
 const post=async(body:any)=>{const response=await fetch(`http://127.0.0.1:${port}/api/local-email`,{method:'POST',headers:{authorization:'Bearer synthetic-admin','content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);return await response.json() as any;};
 try{
  const account=await post({action:'configure',account:{label:'Synthetic',address:'owner@example.test',imap:{host:'localhost',port:imap.port,username:'synthetic'},smtp:{host:'localhost',port:smtp.port,username:'synthetic'}},credentials:{imapPassword:'fake',smtpPassword:'fake'}});
  const inbox=await post({action:'inbox',accountId:account.id});assert.equal(inbox.messages[0].subject,'Synthetic meeting');await post({action:'consent',enabled:true});assert.equal((await post({action:'summary',accountId:account.id})).summary,'Alex suggests Tuesday.');
  const draft=await post({action:'prepare',accountId:account.id,uid:9,input:{to:['alex@example.test'],subject:'Re: Synthetic meeting',instruction:'Accept Tuesday',tone:'Short',sourceDigest:inbox.messages[0].sourceDigest}});
  const send={action:'send',accountId:account.id,draftId:draft.id,revision:draft.revision,digest:draft.digest};assert.equal((await post(send)).status,'cancelled');assert.equal(smtpConnections,0);approved=true;
  assert.equal((await post(send)).status,'sent');assert.equal(smtpConnections,1);assert.match(received,/To: alex@example.test/);assert.match(Buffer.from(received.split('\r\n\r\n')[1].trim(),'base64').toString(),/Tuesday works/);
 }finally{await new Promise<void>(r=>http.close(()=>r()));mail.close();db.close();approvals.cancel();store.close();await imap.close();await smtp.close();rmSync(certRoot,{recursive:true,force:true});}
});
