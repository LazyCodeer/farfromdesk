import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,connect,type TLSSocket} from 'node:tls';
import {composeMail,readInbox,sendMail,readAccountInbox,sendAccountMail,type MailDraft,type MailTransportDependencies} from '../src/local-email/transport.js';

const dir=mkdtempSync(join(tmpdir(),'ffd-mail-test-'));
execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
const key=readFileSync(join(dir,'key.pem')),cert=readFileSync(join(dir,'cert.pem'));
test.after(()=>rmSync(dir,{recursive:true,force:true}));
const deps:MailTransportDependencies={connectTls:opts=>connect({...opts,ca:cert}),timeoutMs:3000};
const creds={password:'synthetic-password'},draft:MailDraft={from:'sender@example.test',to:['recipient@example.test'],subject:'A synthetic note',body:'Hello\n.\nSynthetic data'};
const allow={claim:async(_digest:string)=>{},assertCurrent:(_digest:string)=>{}};
async function server(handler:(sock:TLSSocket)=>void){const s=createServer({key,cert},handler);await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const a=s.address();if(!a||typeof a==='string')throw Error('address');return {endpoint:{host:'localhost',port:a.port,username:'synthetic-user'},close:()=>new Promise<void>(r=>s.close(()=>r()))};}
function lines(sock:TLSSocket,onLine:(line:string)=>void){let buf='';sock.on('data',chunk=>{buf+=chunk.toString();for(;;){const i=buf.indexOf('\r\n');if(i<0)break;const line=buf.slice(0,i);buf=buf.slice(i+2);onLine(line);}});}

test('IMAPS reads bounded messages using EXAMINE and BODY.PEEK',async()=>{
  const commands:string[]=[];const raw=Buffer.from('From: demo@example.test\r\nSubject: Synthetic\r\n\r\nExample body\r\n');
  const s=await server(sock=>{sock.write('* OK synthetic\r\n');lines(sock,line=>{commands.push(line.split(' ')[1]);const tag=line.split(' ')[0];
    if(line.includes(' LOGIN '))sock.write(`${tag} OK login\r\n`);
    else if(line.includes(' EXAMINE '))sock.write(`* 1 EXISTS\r\n${tag} OK examined\r\n`);
    else if(line.includes(' SEARCH '))sock.write(`* SEARCH 9\r\n${tag} OK search\r\n`);
    else if(line.includes(' FETCH ')){sock.write(`* 1 FETCH (UID 9 BODY[] {${raw.length}}\r\n`);sock.write(raw);sock.write(`)\r\n${tag} OK fetched\r\n`);}
  });});
  try{const messages=await readInbox(s.endpoint,creds,{assertCurrent(){}},10,deps);assert.equal(messages.length,1);assert.equal(messages[0].uid,9);assert.deepEqual(messages[0].raw,raw);assert.deepEqual(commands,['LOGIN','EXAMINE','UID','UID']);}finally{await s.close();}
});
test('SMTP sends the exact approved synthetic draft only once over verified TLS',async()=>{
  let data=false,received='',connections=0;const s=await server(sock=>{connections++;sock.write('220 synthetic\r\n');lines(sock,line=>{
    if(data){if(line==='.')sock.write('250 accepted\r\n');else received+=line+'\r\n';return;}
    if(line.startsWith('EHLO'))sock.write('250-synthetic\r\n250 AUTH PLAIN\r\n');else if(line.startsWith('AUTH'))sock.write('235 ok\r\n');else if(line.startsWith('MAIL')||line.startsWith('RCPT'))sock.write('250 ok\r\n');else if(line==='DATA'){data=true;sock.write('354 go\r\n');}
  });});
  try{let claimed='';const result=await sendMail(s.endpoint,creds,draft,{claim:async d=>{claimed=d;},assertCurrent:d=>assert.equal(d,claimed)},deps);const composed=composeMail(draft);assert.equal(result.status,'sent');assert.equal(claimed,composed.digest);assert.equal(received,composed.message.toString());assert.equal(connections,1);}finally{await s.close();}
});
test('revocation immediately before DATA blocks message bytes; no implicit retry',async()=>{
  let revoked=false,bodyLines=0;const s=await server(sock=>{sock.write('220 synthetic\r\n');lines(sock,line=>{
    if(line.startsWith('EHLO'))sock.write('250-synthetic\r\n250 AUTH PLAIN\r\n');else if(line.startsWith('AUTH'))sock.write('235 ok\r\n');else if(line.startsWith('MAIL')||line.startsWith('RCPT'))sock.write('250 ok\r\n');else if(line==='DATA'){revoked=true;sock.write('354 go\r\n');}else bodyLines++;
  });});
  try{await assert.rejects(sendMail(s.endpoint,creds,draft,{claim:async()=>{},assertCurrent:()=>{if(revoked)throw Error('revoked');}},deps));assert.equal(bodyLines,0);}finally{await s.close();}
});
test('lost acceptance yields uncertain, not an automatic replay',async()=>{
  let data=false,connections=0;const s=await server(sock=>{connections++;sock.write('220 synthetic\r\n');lines(sock,line=>{
    if(data){if(line==='.')sock.destroy();return;}
    if(line.startsWith('EHLO'))sock.write('250-synthetic\r\n250 AUTH PLAIN\r\n');else if(line.startsWith('AUTH'))sock.write('235 ok\r\n');else if(line.startsWith('MAIL')||line.startsWith('RCPT'))sock.write('250 ok\r\n');else if(line==='DATA'){data=true;sock.write('354 go\r\n');}
  });});
  try{assert.equal((await sendMail(s.endpoint,creds,draft,allow,deps)).status,'uncertain');assert.equal(connections,1);}finally{await s.close();}
});
test('no authentication or delivery without certificate trust or explicit authorization',async()=>{
  let auth=false;const s=await server(sock=>{sock.write('220 synthetic\r\n');lines(sock,line=>{if(line.startsWith('AUTH'))auth=true;});});
  try{await assert.rejects(sendMail(s.endpoint,creds,draft,allow,{timeoutMs:3000}));assert.equal(auth,false);
    await assert.rejects(sendMail(s.endpoint,creds,draft,{claim:async()=>{throw Error('not approved');},assertCurrent(){}},deps));assert.equal(auth,false);
    assert.throws(()=>composeMail({...draft,to:['victim@example.test\r\nBcc:bad@example.test']}));
  }finally{await s.close();}
});
test('account access uses an injected secret reader and rejects unknown credentials',async()=>{
  let reads=0;const store={read:async(id:string)=>{reads++;assert.equal(id,'account_123');return undefined;}};
  await assert.rejects(readAccountInbox('account_123',{host:'localhost',port:1,username:'synthetic-user'},store,{assertCurrent(){}},1,deps));
  assert.equal(reads,1);
  await assert.rejects(readAccountInbox('bad\naccount',{host:'localhost',port:1,username:'synthetic-user'},store,{assertCurrent(){}},1,deps));assert.equal(reads,1);
});

test('account settings and approved content are snapshotted before secret lookup',async()=>{
  let received='',data=false;const s=await server(sock=>{sock.write('220 synthetic\r\n');lines(sock,line=>{
    if(data){if(line==='.')sock.write('250 accepted\r\n');return;}
    if(line.startsWith('EHLO'))sock.write('250-synthetic\r\n250 AUTH PLAIN\r\n');else if(line.startsWith('AUTH'))sock.write('235 ok\r\n');else if(line.startsWith('MAIL')||line.startsWith('RCPT')){received+=line+'\n';sock.write('250 ok\r\n');}else if(line==='DATA'){data=true;sock.write('354 go\r\n');}
  });});
  try{
    let release!:()=>void,started!:()=>void;const blocked=new Promise<void>(r=>release=r),reading=new Promise<void>(r=>started=r);
    const target={...s.endpoint},message={...draft,to:[...draft.to]},expected=composeMail(message).digest;
    const pending=sendAccountMail('account_123',target,{read:async()=>{started();await blocked;return creds.password;}},message,{claim:async digest=>assert.equal(digest,expected),assertCurrent:digest=>assert.equal(digest,expected)},deps);
    await reading;target.host='attacker.invalid';message.to[0]='attacker@example.test';release();assert.equal((await pending).status,'sent');
    assert.match(received,/recipient@example.test/);assert.doesNotMatch(received,/attacker/);
  }finally{await s.close();}
});
test('mail fields cannot inject headers or SMTP commands',()=>{
  assert.throws(()=>composeMail({...draft,subject:'hello\r\nBcc: bad@example.test'}));
  assert.throws(()=>composeMail({...draft,from:'sender@example.test\r\nDATA'}));
  const m=composeMail({...draft,subject:'文'.repeat(100),to:['one@example.test','two@example.test']});
  assert.ok(m.message.toString().split('\r\n').every(line=>line.length<=998));
  assert.match(m.message.toString(),/To: one@example.test,\r\n two@example.test/);
});

test('provider failures never echo credentials or untrusted server text',async()=>{
  const s=await server(sock=>{sock.write('* OK synthetic\r\n');lines(sock,line=>{const tag=line.split(' ')[0];sock.write(`${tag} NO synthetic-password attacker-server-text\r\n`);});});
  try{
    let error:unknown;try{await readInbox(s.endpoint,creds,{assertCurrent(){}},1,deps);}catch(e){error=e;}
    assert.ok(error instanceof Error);assert.doesNotMatch(error.message,/synthetic-password|attacker-server-text/);
  }finally{await s.close();}
});

test('SMTP revocation during authentication blocks sender and recipient commands',async()=>{
  let revoked=false;const envelope:string[]=[];const s=await server(sock=>{sock.write('220 synthetic\r\n');lines(sock,line=>{
    if(line.startsWith('EHLO'))sock.write('250-synthetic\r\n250 AUTH PLAIN\r\n');else if(line.startsWith('AUTH')){revoked=true;sock.write('235 ok\r\n');}else if(line.startsWith('MAIL')||line.startsWith('RCPT')){envelope.push(line);sock.write('250 ok\r\n');}
  });});
  try{await assert.rejects(sendMail(s.endpoint,creds,draft,{claim:async()=>{},assertCurrent:()=>{if(revoked)throw Error('revoked');}},deps));assert.deepEqual(envelope,[]);}finally{await s.close();}
});
test('IMAP ignores unrelated UID lines and never mislabels a different FETCH message',async()=>{
  const raw=Buffer.from('Subject: synthetic\r\n\r\nSynthetic body\r\n');
  const s=await server(sock=>{sock.write('* OK synthetic\r\n');lines(sock,line=>{const tag=line.split(' ')[0];
    if(line.includes(' LOGIN '))sock.write(`${tag} OK login\r\n`);else if(line.includes(' EXAMINE '))sock.write(`* 1 EXISTS\r\n${tag} OK examined\r\n`);else if(line.includes(' SEARCH '))sock.write(`* SEARCH 9\r\n${tag} OK search\r\n`);
    else if(line.includes(' FETCH ')){sock.write(`* 1 FETCH (UID 99 BODY[] {${raw.length}}\r\n`);sock.write(raw);sock.write(`)\r\n* OK UID 9 \r\n${tag} OK fetched\r\n`);}
  });});
  try{await assert.rejects(readInbox(s.endpoint,creds,{assertCurrent(){}},1,deps));}finally{await s.close();}
});
test('IMAP accepts the UID following the literal only inside its FETCH response',async()=>{
  const raw=Buffer.from('Subject: synthetic\r\n\r\nSynthetic body\r\n');
  const s=await server(sock=>{sock.write('* OK synthetic\r\n');lines(sock,line=>{const tag=line.split(' ')[0];
    if(line.includes(' LOGIN '))sock.write(`${tag} OK login\r\n`);else if(line.includes(' EXAMINE '))sock.write(`* 1 EXISTS\r\n${tag} OK examined\r\n`);else if(line.includes(' SEARCH '))sock.write(`* SEARCH 9\r\n${tag} OK search\r\n`);
    else if(line.includes(' FETCH ')){sock.write(`* 1 FETCH (BODY[] {${raw.length}}\r\n`);sock.write(raw);sock.write(` UID 9)\r\n${tag} OK fetched\r\n`);}
  });});
  try{const result=await readInbox(s.endpoint,creds,{assertCurrent(){}},1,deps);assert.equal(result[0].uid,9);assert.deepEqual(result[0].raw,raw);}finally{await s.close();}
});
