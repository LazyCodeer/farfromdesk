import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connect,createServer,type TLSSocket} from 'node:tls';
import {MailAssistant,parseInboxMessage} from '../src/local-email/assistant.js';
import {LocalMailService,type HostMailAuthority,type MailSecretStore,type SendApprovalScope} from '../src/local-email/service.js';
import {readAccountInbox,sendAccountMail} from '../src/local-email/transport.js';

const dir=mkdtempSync(join(tmpdir(),'ffd-mail-assistant-'));
execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
const key=readFileSync(join(dir,'key.pem')),cert=readFileSync(join(dir,'cert.pem'));
test.after(()=>rmSync(dir,{recursive:true,force:true}));
function lines(socket:TLSSocket,handle:(line:string)=>void){let pending='';socket.on('data',data=>{pending+=data.toString();for(;;){const at=pending.indexOf('\r\n');if(at<0)break;const line=pending.slice(0,at);pending=pending.slice(at+2);handle(line);}});}
async function server(handler:(s:TLSSocket)=>void){const s=createServer({key,cert},handler);await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const address=s.address();if(!address||typeof address==='string')throw Error('address');return {port:address.port,close:()=>new Promise<void>(r=>s.close(()=>r()))};}
const raw=Buffer.from('From: Alex <alex@example.test>\r\nSubject: =?UTF-8?Q?Project_timeline?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nCan we meet Tuesday?\r\n');
test('synthetic inbox to summary, draft, explicit exact approval and SMTP acceptance',async()=>{
  let transmitted='',connections=0;
  const imap=await server(sock=>{sock.write('* OK synthetic\r\n');lines(sock,line=>{const tag=line.split(' ')[0];if(line.includes(' LOGIN '))sock.write(`${tag} OK login\r\n`);else if(line.includes(' EXAMINE '))sock.write(`* 1 EXISTS\r\n${tag} OK\r\n`);else if(line.includes(' SEARCH '))sock.write(`* SEARCH 9\r\n${tag} OK\r\n`);else if(line.includes(' FETCH ')){sock.write(`* 1 FETCH (UID 9 BODY[] {${raw.length}}\r\n`);sock.write(raw);sock.write(`)\r\n${tag} OK\r\n`);}});});
  const smtp=await server(sock=>{connections++;let data=false;sock.write('220 synthetic\r\n');lines(sock,line=>{if(data){if(line==='.')sock.write('250 accepted\r\n');else transmitted+=line+'\r\n';}else if(line.startsWith('EHLO'))sock.write('250-synthetic\r\n250 AUTH PLAIN\r\n');else if(line.startsWith('AUTH'))sock.write('235 ok\r\n');else if(line.startsWith('MAIL')||line.startsWith('RCPT'))sock.write('250 ok\r\n');else if(line==='DATA'){data=true;sock.write('354 go\r\n');}});});
  const db=new DatabaseSync(':memory:'),values=new Map<string,string>(),approvals=new Map<string,SendApprovalScope>();let owner={id:'synthetic-owner',generation:'1'};
  const secrets:MailSecretStore={kind:'macos-keychain',available:()=>true,read:async k=>values.get(k),save:async(k,v)=>{values.set(k,v);},remove:async k=>{values.delete(k);}};
  const authority:HostMailAuthority={capture:()=>({...owner}),isCurrent:o=>o.id===owner.id&&o.generation===owner.generation,verifyExplicitSend:s=>{if(JSON.stringify(approvals.get(s.approvalRef))!==JSON.stringify(s))throw Error('not approved');return {eventId:s.approvalRef};},approvalCurrent:(s,e)=>JSON.stringify(approvals.get(e))===JSON.stringify(s),assertExclusiveRecovery:()=>true};
  const deps={connectTls:(opts:any)=>connect({...opts,ca:cert}),timeoutMs:3000};
  const mail=new LocalMailService(db,secrets,authority,{read:(...args)=>readAccountInbox(...args,deps),send:(...args)=>sendAccountMail(...args,deps)});
  try{
    const account=await mail.configureAccount(undefined,{label:'Synthetic',address:'sagar@example.test',imap:{host:'localhost',port:imap.port,username:'demo'},smtp:{host:'localhost',port:smtp.port,username:'demo'}},{imapPassword:'fake',smtpPassword:'fake'});
    const assistant=new MailAssistant(mail,authority,async request=>request.task==='summary'?'Alex asks to meet Tuesday.':'Hi Alex, Tuesday works. Thanks, Sagar');
    const summary=await assistant.summarize(account.id);assert.equal(summary.messages[0].subject,'Project timeline');assert.match(summary.messages[0].text,/Tuesday/);assert.equal(summary.summary,'Alex asks to meet Tuesday.');
    const draft=await assistant.prepareReply(account.id,9,{to:['alex@example.test'],subject:'Re: Project timeline',instruction:'Say Tuesday works',tone:'Short and warm',sourceDigest:summary.messages[0].sourceDigest});
    await assert.rejects(mail.sendDraft(account.id,draft.id,'not-approved'));assert.equal(connections,0);
    const scope:SendApprovalScope={owner:{...owner},accountId:account.id,accountGeneration:account.generation,draftId:draft.id,draftRevision:draft.revision,digest:draft.digest,approvalRef:'approval-one'};approvals.set('approval-one',scope);
    const sent=await mail.sendDraft(account.id,draft.id,'approval-one');assert.equal(sent.status,'sent');assert.equal(connections,1);assert.match(transmitted,/To: alex@example.test/);assert.match(Buffer.from(transmitted.split('\r\n\r\n')[1].trim(),'base64').toString(),/Tuesday works/);
    await assert.rejects(mail.sendDraft(account.id,draft.id,'approval-one'));assert.equal(connections,1);
  }finally{db.close();await imap.close();await smtp.close();}
});
test('HTML-only and attachments are not converted into plain text or sent to the writer as content',async()=>{
  const m=await parseInboxMessage(1,Buffer.from('From: a@example.test\r\nContent-Type: text/html\r\n\r\n<img src="https://example.test/tracker">secret'));
  assert.equal(m.plainTextAvailable,false);assert.equal(m.text,'');
});
test('owner revocation while the writer runs prevents saving the draft',async()=>{
  const db=new DatabaseSync(':memory:');let generation='1',release!:()=>void,started!:()=>void;
  const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r),values=new Map<string,string>();
  const authority:HostMailAuthority={capture:()=>({id:'owner',generation}),isCurrent:o=>o.id==='owner'&&o.generation===generation,verifyExplicitSend:()=>{throw Error('no');},approvalCurrent:()=>false,assertExclusiveRecovery:()=>true};
  const secrets:MailSecretStore={kind:'macos-keychain',available:()=>true,read:async k=>values.get(k),save:async(k,v)=>{values.set(k,v);},remove:async k=>{values.delete(k);}};
  const transport:any={read:async()=>[{uid:9,raw}],send:async()=>{throw Error('must not send');}};const mail=new LocalMailService(db,secrets,authority,transport);
  try{const a=await mail.configureAccount(undefined,{label:'Synthetic',address:'sagar@example.test',imap:{host:'localhost',port:993,username:'test'},smtp:{host:'localhost',port:465,username:'test'}},{imapPassword:'fake',smtpPassword:'fake'});
    const assistant=new MailAssistant(mail,authority,async()=>{started();await gate;return 'reply';});const [source]=await assistant.inbox(a.id);const pending=assistant.prepareReply(a.id,9,{to:['alex@example.test'],subject:'Re',instruction:'',tone:'',sourceDigest:source.sourceDigest});await entered;generation='2';release();await assert.rejects(pending);assert.equal(mail.listDrafts(a.id).length,0);
  }finally{db.close();}
});
test('changed source content cannot be drafted from an old inbox selection',async()=>{
  const db=new DatabaseSync(':memory:'),values=new Map<string,string>();let currentRaw=raw,writes=0;
  const authority:HostMailAuthority={capture:()=>({id:'owner',generation:'1'}),isCurrent:o=>o.id==='owner'&&o.generation==='1',verifyExplicitSend:()=>{throw Error('no');},approvalCurrent:()=>false,assertExclusiveRecovery:()=>true};
  const secrets:MailSecretStore={kind:'macos-keychain',available:()=>true,read:async k=>values.get(k),save:async(k,v)=>{values.set(k,v);},remove:async k=>{values.delete(k);}};
  const transport:any={read:async()=>[{uid:9,raw:currentRaw}],send:async()=>{throw Error('must not send');}};const mail=new LocalMailService(db,secrets,authority,transport);
  try{const a=await mail.configureAccount(undefined,{label:'Synthetic',address:'sagar@example.test',imap:{host:'localhost',port:993,username:'test'},smtp:{host:'localhost',port:465,username:'test'}},{imapPassword:'fake',smtpPassword:'fake'});
    const assistant=new MailAssistant(mail,authority,async()=>{writes++;return 'reply';});const [source]=await assistant.inbox(a.id);currentRaw=Buffer.from('From: other@example.test\r\nSubject: Changed\r\n\r\nDifferent message');
    await assert.rejects(assistant.prepareReply(a.id,9,{to:['alex@example.test'],subject:'Re',instruction:'',tone:'',sourceDigest:source.sourceDigest}));assert.equal(writes,0);assert.equal(mail.listDrafts(a.id).length,0);
  }finally{db.close();}
});
