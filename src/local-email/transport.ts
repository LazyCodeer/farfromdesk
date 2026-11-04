import {createHash} from 'node:crypto';
import {connect, type ConnectionOptions, type TLSSocket} from 'node:tls';

/** Only implicit TLS is supported: IMAPS and SMTP over TLS. No plaintext fallback. */
export type MailEndpoint={host:string;port:number;username:string};
export type MailCredentials={password:string};
export type MailDraft={from:string;to:string[];subject:string;body:string};
export type ComposedMail={from:string;to:readonly string[];message:Buffer;digest:string};
/** The trusted host must durably reject replays and bind owner, account and exact digest. */
export type MailSendAuthority={claim:(digest:string)=>Promise<void>;assertCurrent:(digest:string)=>void};
export type MailReadAuthority={assertCurrent:()=>void};
type TlsFactory=(options:ConnectionOptions)=>TLSSocket;
export type MailTransportDependencies={connectTls?:TlsFactory;timeoutMs?:number};
const MAX_MESSAGE=256_000,MAX_RESPONSE=1_500_000;
const invalid=()=>new Error('Mail operation failed. Check the account settings and connection.');
function validateEndpoint(e:MailEndpoint,c:MailCredentials){
  if(!/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(e.host)||!Number.isInteger(e.port)||e.port<1||e.port>65535||!e.username||e.username.length>512||/[\x00-\x1f\x7f]/.test(e.username)||!c.password||c.password.length>4096||/[\x00-\x1f\x7f]/.test(c.password))throw invalid();
}
function address(v:string){if(v.length>254||!/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(v)||v.includes('..'))throw invalid();return v;}
export function composeMail(d:MailDraft):ComposedMail {
  const from=address(d.from),to=d.to.map(address);
  if(!to.length||to.length>20||new Set(to.map(x=>x.toLowerCase())).size!==to.length||d.subject.length>300||/[\r\n\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(d.subject)||Buffer.byteLength(d.body)>MAX_MESSAGE||d.body.includes('\0'))throw invalid();
  const chunks:string[]=[];let part='';for(const character of d.subject){if(Buffer.byteLength(part+character,'utf8')>36){chunks.push(part);part='';}part+=character;}if(part)chunks.push(part);
  const subject=chunks.map(x=>'=?UTF-8?B?'+Buffer.from(x,'utf8').toString('base64')+'?=').join('\r\n ');
  const body=Buffer.from(d.body,'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n')??'';
  const message=Buffer.from(`From: ${from}\r\nTo: ${to.join(',\r\n ')}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}\r\n`,'utf8');
  const digest=createHash('sha256').update(JSON.stringify([from,to])).update('\0').update(message).digest('hex');
  return {from,to,message,digest};
}
class Wire {
  private data=Buffer.alloc(0);private error:Error|undefined;private waiter:(()=>void)|undefined;private consumed=0;private readonly deadline:NodeJS.Timeout;
  constructor(readonly socket:TLSSocket,timeoutMs:number){
    this.deadline=setTimeout(()=>socket.destroy(invalid()),timeoutMs);this.deadline.unref();
    socket.setTimeout(timeoutMs,()=>socket.destroy(invalid()));
    socket.on('data',(chunk:Buffer)=>{this.data=Buffer.concat([this.data,chunk]);if(this.data.length>MAX_RESPONSE)socket.destroy(invalid());this.waiter?.();});
    socket.on('error',()=>{this.error=invalid();this.waiter?.();});socket.on('close',()=>{this.error=invalid();this.waiter?.();});
  }
  async take(n:number){if(n<0||n>MAX_RESPONSE)throw invalid();while(this.data.length<n){if(this.error)throw this.error;await new Promise<void>(r=>this.waiter=r);this.waiter=undefined;}this.consumed+=n;if(this.consumed>MAX_RESPONSE)throw invalid();const x=this.data.subarray(0,n);this.data=this.data.subarray(n);return x;}
  async line(){for(;;){const i=this.data.indexOf('\r\n');if(i>=0){if(i>65536)throw invalid();return (await this.take(i+2)).subarray(0,i).toString('utf8');}if(this.data.length>65536||this.error)throw invalid();await new Promise<void>(r=>this.waiter=r);this.waiter=undefined;}}
  write(s:string|Buffer){if(this.error||this.socket.destroyed)throw invalid();this.socket.write(s);}
  close(){clearTimeout(this.deadline);this.socket.destroy();}
}
async function open(e:MailEndpoint,c:MailCredentials,deps:MailTransportDependencies){
  validateEndpoint(e,c);const timeout=deps.timeoutMs??15000;if(!Number.isInteger(timeout)||timeout<1||timeout>60000)throw invalid();
  const sock=(deps.connectTls??connect)({host:e.host,port:e.port,servername:e.host,rejectUnauthorized:true,minVersion:'TLSv1.2'});const wire=new Wire(sock,timeout);
  try{await new Promise<void>((resolve,reject)=>{sock.once('secureConnect',()=>{if(!sock.authorized)reject(invalid());else resolve();});sock.once('error',()=>reject(invalid()));sock.once('close',()=>reject(invalid()));});return wire;}catch{wire.close();throw invalid();}
}
const quote=(s:string)=>'"'+s.replace(/[\\"]/g,'\\$&')+'"';
type ImapReply={lines:string[];literals:Buffer[];parts:(string|Buffer)[]};
async function imap(w:Wire,tag:string,command:string):Promise<ImapReply>{
  w.write(`${tag} ${command}\r\n`);const lines:string[]=[],literals:Buffer[]=[],parts:(string|Buffer)[]=[];
  for(let i=0;i<10000;i++){
    const line=await w.line();if(line.startsWith(tag+' ')){if(!new RegExp(`^${tag} OK(?: |$)`,'i').test(line))throw invalid();return {lines,literals,parts};}
    lines.push(line);parts.push(line);const m=/\{(\d+)\}$/.exec(line);if(m){const n=Number(m[1]);if(n>MAX_MESSAGE)throw invalid();const data=Buffer.from(await w.take(n));literals.push(data);parts.push(data);}
  }throw invalid();
}
/** Returns bounded, untrusted raw RFC 5322 messages; BODY.PEEK does not mark them read. */
export async function readInbox(endpoint:MailEndpoint,credentials:MailCredentials,authority:MailReadAuthority,limit=10,deps:MailTransportDependencies={}):Promise<{uid:number;raw:Buffer}[]> {
  if(!Number.isInteger(limit)||limit<1||limit>20)throw invalid();const target={...endpoint},secret={...credentials};try{authority.assertCurrent();}catch{throw invalid();}const w=await open(target,secret,deps);
  try{
    if(!/^\* OK(?: |$)/i.test(await w.line()))throw invalid();authority.assertCurrent();await imap(w,'a1',`LOGIN ${quote(target.username)} ${quote(secret.password)}`);
    authority.assertCurrent();await imap(w,'a2','EXAMINE INBOX');authority.assertCurrent();const search=await imap(w,'a3','UID SEARCH ALL');
    const matches=search.lines.filter(x=>/^\* SEARCH(?: |$)/i.test(x));if(matches.length!==1||!/^\* SEARCH(?: \d+)*$/i.test(matches[0]))throw invalid();
    const ids=matches[0].split(' ').slice(2).filter(Boolean).map(Number);if(ids.some(n=>!Number.isSafeInteger(n)||n<1)||new Set(ids).size!==ids.length)throw invalid();
    const out:{uid:number;raw:Buffer}[]=[];let tag=4;
    for(const uid of ids.slice(-limit).reverse()){
      authority.assertCurrent();const r=await imap(w,`a${tag++}`,`UID FETCH ${uid} (UID BODY.PEEK[])`);
      const fetches=r.lines.filter(l=>/^\* \d+ FETCH \(/i.test(l));const index=r.parts.findIndex(Buffer.isBuffer),before=r.parts[index-1],after=r.parts[index+1];
      if(r.literals.length!==1||fetches.length!==1||typeof before!=='string'||typeof after!=='string')throw invalid();
      const first=/^\* \d+ FETCH \(UID (\d+) BODY\[\] \{(\d+)\}$/i.exec(before);
      const reversed=/^\* \d+ FETCH \(BODY\[\] \{(\d+)\}$/i.exec(before),suffix=/^ UID (\d+)\)$/.exec(after);
      if(!(first&&Number(first[1])===uid&&Number(first[2])===r.literals[0].length&&after===')')&&!(reversed&&suffix&&Number(suffix[1])===uid&&Number(reversed[1])===r.literals[0].length))throw invalid();
      out.push({uid,raw:r.literals[0]});
    }
    authority.assertCurrent();return out;
  }catch{throw invalid();}finally{w.close();}
}
async function smtp(w:Wire,command?:string){
  if(command!==undefined)w.write(command+'\r\n');const lines:string[]=[];let code='';
  for(let i=0;i<100;i++){const line=await w.line(),m=/^(\d{3})([ -])(.*)$/.exec(line);if(!m||code&&code!==m[1])throw invalid();code=m[1];lines.push(m[3]);if(m[2]===' ')return {code:Number(code),lines};}throw invalid();
}
/** No retries. Once DATA bytes are written, connection loss returns uncertain. */
export async function sendMail(endpoint:MailEndpoint,credentials:MailCredentials,draft:MailDraft,authority:MailSendAuthority,deps:MailTransportDependencies={}):Promise<{status:'sent'|'uncertain';digest:string}> {
  const m=composeMail(draft),target={...endpoint},secret={...credentials};validateEndpoint(target,secret);try{await authority.claim(m.digest);authority.assertCurrent(m.digest);}catch{throw invalid();}const w=await open(target,secret,deps);let committed=false;
  try {
    if((await smtp(w)).code!==220)throw invalid();authority.assertCurrent(m.digest);const hello=await smtp(w,'EHLO localhost');if(hello.code!==250||!hello.lines.some(x=>/^AUTH(?:=|\s).*\bPLAIN\b/i.test(x)))throw invalid();
    authority.assertCurrent(m.digest);if((await smtp(w,'AUTH PLAIN '+Buffer.from(`\0${target.username}\0${secret.password}`).toString('base64'))).code!==235)throw invalid();
    authority.assertCurrent(m.digest);if((await smtp(w,`MAIL FROM:<${m.from}>`)).code!==250)throw invalid();
    for(const recipient of m.to){authority.assertCurrent(m.digest);const r=await smtp(w,`RCPT TO:<${recipient}>`);if(r.code!==250&&r.code!==251)throw invalid();}
    authority.assertCurrent(m.digest);if((await smtp(w,'DATA')).code!==354)throw invalid();authority.assertCurrent(m.digest);
    const wire=Buffer.from(m.message.toString('utf8').replace(/^\./gm,'..')+'.\r\n','utf8');committed=true;w.write(wire);
    if((await smtp(w)).code!==250)return {status:'uncertain',digest:m.digest};return {status:'sent',digest:m.digest};
  }catch{if(committed)return {status:'uncertain',digest:m.digest};throw invalid();}finally{w.close();}
}

/** Adapter for the shared OS credential store. accountId is an opaque host-owned ID. */
export type MailboxSecretReader={read:(accountId:string)=>Promise<string|undefined>};
async function secretFor(store:MailboxSecretReader,accountId:string){
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(accountId))throw invalid();
  try{const password=await store.read(accountId);if(!password)throw invalid();return {password};}catch{throw invalid();}
}
/** The host owns account configuration, trusted provider endpoints and access control. */
export async function readAccountInbox(accountId:string,endpoint:MailEndpoint,store:MailboxSecretReader,authority:MailReadAuthority,limit=10,deps:MailTransportDependencies={}){
  const target={...endpoint};try{authority.assertCurrent();}catch{throw invalid();}const credentials=await secretFor(store,accountId);return readInbox(target,credentials,authority,limit,deps);
}
export async function sendAccountMail(accountId:string,endpoint:MailEndpoint,store:MailboxSecretReader,draft:MailDraft,authority:MailSendAuthority,deps:MailTransportDependencies={}){
  const target={...endpoint},snapshot={...draft,to:[...draft.to]},digest=composeMail(snapshot).digest;try{authority.assertCurrent(digest);}catch{throw invalid();}
  const credentials=await secretFor(store,accountId);return sendMail(target,credentials,snapshot,authority,deps);
}
