import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalMailService,type HostMailAuthority,type MailAccountInput,type MailOwner,type MailSecretStore,type SendApprovalScope} from '../src/local-email/service.js';
import {composeMail} from '../src/local-email/transport.js';

const config:MailAccountInput={label:'Synthetic',address:'owner@example.test',imap:{host:'imap.example.test',port:993,username:'synthetic-user'},smtp:{host:'smtp.example.test',port:465,username:'synthetic-user'}};
const passwords={imapPassword:'synthetic-imap-password',smtpPassword:'synthetic-smtp-password'};
const draft={to:['friend@example.test'],subject:'Synthetic subject',body:'Synthetic body'};
function gate(){let release!:()=>void,started!:()=>void;return {wait:new Promise<void>(r=>release=r),entered:new Promise<void>(r=>started=r),release:()=>release(),start:()=>started()};}
function fixture(path=':memory:'){
  const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=WAL');const values=new Map<string,string>();let owner:MailOwner={id:'123@s.whatsapp.net',generation:'one'},boot='boot-one';
  const approvals=new Map<string,SendApprovalScope>();let saves=0,removeFails=false;
  const secrets:MailSecretStore={kind:'macos-keychain',available:()=>true,read:async key=>values.get(key),save:async(key,value)=>{saves++;values.set(key,value);},remove:async key=>{if(removeFails)throw Error('synthetic secret-store failure');values.delete(key);}};
  const authority:HostMailAuthority={capture:()=>({...owner}),isCurrent:o=>o.id===owner.id&&o.generation===owner.generation,verifyExplicitSend:scope=>{const approved=approvals.get(scope.approvalRef);if(!approved||JSON.stringify(approved)!==JSON.stringify(scope))throw Error('not approved');return {eventId:scope.approvalRef};},approvalCurrent:(scope,eventId)=>eventId===scope.approvalRef&&JSON.stringify(approvals.get(eventId))===JSON.stringify(scope),assertExclusiveRecovery:()=>true,recoveryBootId:()=>boot};
  let sends=0;const transport:any={read:async(key:string,_endpoint:any,store:MailSecretStore,auth:any)=>{auth.assertCurrent();assert.equal(await store.read(key),passwords.imapPassword);auth.assertCurrent();return [{uid:1,raw:Buffer.from('synthetic inbox')}];},send:async(key:string,_endpoint:any,store:MailSecretStore,mail:any,auth:any)=>{const digest=composeMail(mail).digest;auth.assertCurrent(digest);assert.equal(await store.read(key),passwords.smtpPassword);await auth.claim(digest);auth.assertCurrent(digest);sends++;return {status:'sent',digest};}};
  const service=new LocalMailService(db,secrets,authority,transport);
  const approve=(ref:string,a:any,d:any)=>approvals.set(ref,{owner:{...owner},accountId:a.id,accountGeneration:a.generation,draftId:d.id,draftRevision:d.revision,digest:d.digest,approvalRef:ref});
  return {db,values,secrets,authority,transport,service,approve,revoke:(ref:string)=>approvals.delete(ref),get sends(){return sends;},get saves(){return saves;},setOwner:(o:MailOwner)=>{owner=o;},setRemoveFails:(x:boolean)=>{removeFails=x;},nextBoot:()=>{boot='boot-two';},close:()=>db.close()};
}
async function ready(f:ReturnType<typeof fixture>){return f.service.configureAccount(undefined,config,passwords);}

test('account setup stores only opaque secret keys, not passwords, in SQLite',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'mail-service-')),path=join(dir,'state.sqlite'),f=fixture(path);try{
    const account=await ready(f);assert.equal(account.status,'ready');assert.deepEqual(f.service.listAccounts(),[account]);assert.equal(f.values.size,2);
    const row=f.db.prepare('SELECT * FROM local_mail_accounts').get();assert.doesNotMatch(JSON.stringify(row),/synthetic-(imap|smtp)-password/);
    assert.notEqual(row?.imap_key,row?.smtp_key);assert.match(String(row?.imap_key),/^[a-f0-9]{32}$/);assert.match(String(row?.smtp_key),/^[a-f0-9]{32}$/);f.close();const disk=readFileSync(path);assert.equal(disk.includes(Buffer.from(passwords.smtpPassword)),false);assert.equal(disk.includes(Buffer.from(passwords.imapPassword)),false);
  }finally{try{f.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});
test('failed setup and removal keep cleanup durable without leaking secret-store errors',async()=>{
  const f=fixture();try{
    f.secrets.save=async(key,value)=>{f.values.set(key,value);throw Error('synthetic-private-secret');};
    await assert.rejects(ready(f),e=>e instanceof Error&&!e.message.includes('synthetic-private-secret'));
    assert.equal(f.service.listAccounts()[0].status,'setup_failed');assert.equal(f.service.cleanupPending(),2);
    f.setRemoveFails(true);const removed=await f.service.removeAccount(f.service.listAccounts()[0].id);assert.equal(removed.credentialsCleanupPending,true);assert.equal(f.service.listAccounts().length,0);
    f.setRemoveFails(false);assert.equal(f.service.recoveryRequired(),true);f.service.recover();await f.service.cleanupCredentials();assert.equal(f.service.cleanupPending(),2);f.nextBoot();f.service.recover();await f.service.cleanupCredentials();assert.equal(f.service.cleanupPending(),0);assert.equal(f.values.size,0);
  }finally{f.close();}
});
test('owner generation changes during credential setup fail closed and preserve cleanup',async()=>{
  const f=fixture(),g=gate();try{
    f.secrets.save=async(key,value)=>{f.values.set(key,value);g.start();await g.wait;};
    const pending=ready(f);await g.entered;f.setOwner({id:'123@s.whatsapp.net',generation:'two'});g.release();await assert.rejects(pending);
    assert.equal(f.service.listAccounts()[0].status,'setup_failed');assert.equal(f.service.cleanupPending(),2);f.nextBoot();f.service.recover();await f.service.cleanupCredentials();assert.equal(f.values.size,0);
  }finally{f.close();}
});
test('concurrent credential replacement cannot activate or delete a superseded secret',async()=>{
  const f=fixture(),g=gate();try{
    const original=await ready(f);let first=true;f.secrets.save=async(key,value)=>{f.values.set(key,value);if(first){first=false;g.start();await g.wait;}};
    const older=f.service.configureAccount(original.id,{...config,label:'Old'},passwords);await g.entered;
    const newer=await f.service.configureAccount(original.id,{...config,label:'New'},passwords);await f.service.cleanupCredentials();g.release();await assert.rejects(older);
    f.nextBoot();f.service.recover();await f.service.cleanupCredentials();assert.equal(f.service.listAccounts()[0].generation,newer.generation);assert.equal(f.service.listAccounts()[0].label,'New');assert.equal(f.values.size,2);
  }finally{f.close();}
});
test('owner-scoped draft lifecycle validates content and removes drafts on account deletion',async()=>{
  const f=fixture();try{const a=await ready(f),d=f.service.saveDraft(a.id,undefined,draft);assert.equal(d.from,config.address);assert.equal(f.service.getDraft(d.id).digest,d.digest);
    assert.throws(()=>f.service.saveDraft(a.id,d.id,{...draft,subject:'x\r\nBcc: bad'}));
    const edit=f.service.saveDraft(a.id,d.id,{...draft,body:'Changed'});assert.notEqual(edit.revision,d.revision);assert.notEqual(edit.digest,d.digest);
    f.setOwner({id:'other@s.whatsapp.net',generation:'two'});assert.deepEqual(f.service.listAccounts(),[]);assert.throws(()=>f.service.getDraft(d.id));
    f.setOwner({id:'123@s.whatsapp.net',generation:'three'});assert.equal(f.service.listDrafts(a.id).length,1);await f.service.removeAccount(a.id);assert.throws(()=>f.service.getDraft(d.id));
  }finally{f.close();}
});
test('explicit exact owner approval is consumed once for a draft revision',async()=>{
  const f=fixture();try{const a=await ready(f),d=f.service.saveDraft(a.id,undefined,draft);await assert.rejects(f.service.sendDraft(a.id,d.id,'wa:unapproved'));assert.equal(f.sends,0);
    f.approve('wa:approved',a,d);const sent=await f.service.sendDraft(a.id,d.id,'wa:approved');assert.equal(sent.status,'sent');assert.equal(f.sends,1);assert.deepEqual(f.service.sendStatus(sent.claimId),sent);
    await assert.rejects(f.service.sendDraft(a.id,d.id,'wa:approved'));const edit=f.service.saveDraft(a.id,d.id,{...draft,body:'New body'});f.approve('wa:approved',a,edit);
    await assert.rejects(f.service.sendDraft(a.id,edit.id,'wa:approved'));assert.equal(f.sends,1);
  }finally{f.close();}
});
test('credential rotation invalidates pending send even if endpoints are restored',async()=>{
  const f=fixture(),g=gate();try{
    const a=await ready(f),d=f.service.saveDraft(a.id,undefined,draft);f.approve('wa:rotate',a,d);let transmitted=0;
    f.transport.send=async(_key:any,_endpoint:any,_store:any,mail:any,auth:any)=>{const digest=composeMail(mail).digest;await auth.claim(digest);g.start();await g.wait;auth.assertCurrent(digest);transmitted++;return {status:'sent',digest};};
    const pending=f.service.sendDraft(a.id,d.id,'wa:rotate');await g.entered;await f.service.configureAccount(a.id,config,passwords);g.release();const result=await pending;
    assert.equal(result.status,'uncertain');assert.equal(transmitted,0);assert.equal(f.service.sendStatus(result.claimId).status,'uncertain');
  }finally{f.close();}
});
test('draft edits and owner generation changes prevent an in-flight send',async()=>{
  for(const change of ['draft','owner'] as const){const f=fixture(),g=gate();try{
    const a=await ready(f),d=f.service.saveDraft(a.id,undefined,draft);f.approve('wa:change',a,d);let transmitted=0;
    f.transport.send=async(_key:any,_endpoint:any,_store:any,mail:any,auth:any)=>{const digest=composeMail(mail).digest;await auth.claim(digest);g.start();await g.wait;auth.assertCurrent(digest);transmitted++;return {status:'sent',digest};};
    const pending=f.service.sendDraft(a.id,d.id,'wa:change');await g.entered;
    if(change==='draft')f.service.saveDraft(a.id,d.id,{...draft,body:'edited'});else f.setOwner({id:'123@s.whatsapp.net',generation:'changed'});
    g.release();if(change==='owner')await assert.rejects(pending);else assert.equal((await pending).status,'uncertain');assert.equal(transmitted,0);
  }finally{f.close();}}
});
test('recovery holds interrupted claims without automatically calling the transport',async()=>{
  const f=fixture(),g=gate();try{
    const a=await ready(f),d=f.service.saveDraft(a.id,undefined,draft);f.approve('wa:crash',a,d);let calls=0;
    f.transport.send=async(_key:any,_endpoint:any,_store:any,mail:any,auth:any)=>{calls++;const digest=composeMail(mail).digest;await auth.claim(digest);g.start();await g.wait;auth.assertCurrent(digest);return {status:'sent',digest};};
    const pending=f.service.sendDraft(a.id,d.id,'wa:crash');await g.entered;f.service.recover();g.release();const result=await pending;
    assert.equal(result.status,'uncertain');assert.equal(calls,1);await assert.rejects(f.service.sendDraft(a.id,d.id,'wa:crash'));assert.equal(calls,1);
  }finally{f.close();}
});
test('inbox results are withheld if owner authority changes during the read',async()=>{
  const f=fixture(),g=gate();try{const a=await ready(f);f.transport.read=async(_key:any,_endpoint:any,_store:any,auth:any)=>{auth.assertCurrent();g.start();await g.wait;return [{uid:1,raw:Buffer.from('synthetic-private-inbox')}];};
    const pending=f.service.inbox(a.id);await g.entered;f.setOwner({id:'123@s.whatsapp.net',generation:'new'});g.release();await assert.rejects(pending);
  }finally{f.close();}
});

test('a revoked approval prevents transmission at the final authority boundary',async()=>{
  const f=fixture(),g=gate();try{const a=await ready(f),d=f.service.saveDraft(a.id,undefined,draft);f.approve('wa:revoke',a,d);let transmitted=0;
    f.transport.send=async(_key:any,_endpoint:any,_store:any,mail:any,auth:any)=>{const digest=composeMail(mail).digest;await auth.claim(digest);g.start();await g.wait;auth.assertCurrent(digest);transmitted++;return {status:'sent',digest};};
    const pending=f.service.sendDraft(a.id,d.id,'wa:revoke');await g.entered;f.revoke('wa:revoke');g.release();assert.equal((await pending).status,'uncertain');assert.equal(transmitted,0);
  }finally{f.close();}
});
test('the service refuses an enclosing transaction before secrets or sends begin',async()=>{
  const f=fixture();try{const a=await ready(f),d=f.service.saveDraft(a.id,undefined,draft);f.approve('wa:nested',a,d);const before=f.saves;
    f.db.exec('BEGIN IMMEDIATE');await assert.rejects(f.service.configureAccount(a.id,config,passwords));await assert.rejects(f.service.sendDraft(a.id,d.id,'wa:nested'));assert.equal(f.saves,before);assert.equal(f.sends,0);f.db.exec('ROLLBACK');
    assert.equal(f.service.listAccounts()[0].generation,a.generation);
  }finally{f.close();}
});
test('an adapter cannot report sent without first consuming its durable claim',async()=>{
  const f=fixture();try{const a=await ready(f),d=f.service.saveDraft(a.id,undefined,draft);f.approve('wa:no-claim',a,d);
    f.transport.send=async(_key:any,_endpoint:any,_store:any,mail:any)=>({status:'sent',digest:composeMail(mail).digest});
    const result=await f.service.sendDraft(a.id,d.id,'wa:no-claim');assert.equal(result.status,'uncertain');
  }finally{f.close();}
});

test('status and UI configuration expose no passwords or provider errors',async()=>{
  const f=fixture();try{
    assert.deepEqual(f.service.status(),{available:true,state:'not_configured',credentialStorage:'macos-keychain',credentialsCleanupPending:false,credentialsRecoveryRequired:false,accounts:[]});
    const result=await f.service.configure({address:config.address,imap:{...config.imap,password:passwords.imapPassword},smtp:{...config.smtp,password:passwords.smtpPassword}});
    const status=f.service.status();assert.equal(status.state,'configured');assert.deepEqual(status.accounts,[{id:result.id,address:config.address,imap:config.imap,smtp:config.smtp,status:'configured',generation:result.generation,credentialsCleanupPending:false,credentialsRecoveryRequired:false}]);
    assert.doesNotMatch(JSON.stringify(status),/synthetic-(imap|smtp)-password/);assert.doesNotMatch(JSON.stringify(f.db.prepare('SELECT * FROM local_mail_accounts').get()),/synthetic-(imap|smtp)-password/);
    await f.service.disconnect(result.id);assert.equal(f.service.status().state,'not_configured');
    f.secrets.available=()=>{throw Error('sensitive-provider-output');};assert.deepEqual(f.service.status(),{available:false,state:'unavailable',credentialStorage:'unavailable',credentialsCleanupPending:false,credentialsRecoveryRequired:false,accounts:[]});
    await assert.rejects(f.service.configure({address:config.address,imap:{...config.imap,password:passwords.imapPassword},smtp:{...config.smtp,password:passwords.smtpPassword}}),e=>e instanceof Error&&!e.message.includes('sensitive-provider-output'));
  }finally{f.close();}
});

test('another service instance cannot clean credentials while their writes are staged',async()=>{
  const f=fixture(),g=gate();try{
    const other=new LocalMailService(f.db,f.secrets,f.authority,f.transport);let writes=0;
    f.secrets.save=async(key,value)=>{f.values.set(key,value);if(++writes===2){g.start();await g.wait;}};
    const pending=f.service.configureAccount(undefined,config,passwords);await g.entered;await other.cleanupCredentials();
    assert.equal(f.values.size,2);g.release();const account=await pending;assert.equal(account.status,'ready');assert.equal(f.values.size,2);
  }finally{f.close();}
});
test('secret cleanup status and deletion are scoped to the owner and account',async()=>{
  const f=fixture();try{const first=await ready(f);f.setRemoveFails(true);await f.service.removeAccount(first.id);assert.equal(f.service.cleanupPending(first.id),2);
    f.setOwner({id:'other@s.whatsapp.net',generation:'other'});assert.equal(f.service.cleanupPending(),0);assert.equal(f.service.listAccounts().length,0);
    await f.service.cleanupCredentials();assert.equal(f.values.size,2);
    f.setOwner({id:'123@s.whatsapp.net',generation:'new'});f.setRemoveFails(false);await f.service.cleanupCredentials();assert.equal(f.values.size,0);
  }finally{f.close();}
});

test('asynchronous or non-boolean authority callbacks fail closed',async()=>{
  const f=fixture();try{const a=await ready(f),d=f.service.saveDraft(a.id,undefined,draft);f.approve('wa:async',a,d);
    const current=f.authority.isCurrent;f.authority.isCurrent=(()=>Promise.resolve(true)) as any;assert.throws(()=>f.service.status());f.authority.isCurrent=current;
    f.authority.approvalCurrent=(()=>Promise.resolve(true)) as any;await assert.rejects(f.service.sendDraft(a.id,d.id,'wa:async'));assert.equal(f.sends,0);
  }finally{f.close();}
});

test('startup recovery requires a synchronous host-held exclusive process lock',async()=>{
  const f=fixture(),g=gate();try{
    f.secrets.save=async(key,value)=>{f.values.set(key,value);g.start();await g.wait;};
    const pending=ready(f);await g.entered;f.authority.assertExclusiveRecovery=()=>false;assert.throws(()=>f.service.recover());
    f.authority.assertExclusiveRecovery=(()=>Promise.resolve(true)) as any;assert.throws(()=>f.service.recover());
    g.release();assert.equal((await pending).status,'ready');
  }finally{f.close();}
});

test('a durable send claim survives database restart and is recovered without replay',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'mail-restart-')),path=join(dir,'state.sqlite'),f=fixture(path),g=gate();let reopened:DatabaseSync|undefined;
  try{
    const a=await ready(f),d=f.service.saveDraft(a.id,undefined,draft);f.approve('wa:restart',a,d);let calls=0;
    f.transport.send=async(_key:any,_endpoint:any,_store:any,mail:any,auth:any)=>{calls++;const digest=composeMail(mail).digest;await auth.claim(digest);g.start();await g.wait;auth.assertCurrent(digest);return {status:'sent',digest};};
    const pending=f.service.sendDraft(a.id,d.id,'wa:restart');const handled=pending.catch(()=>undefined);await g.entered;
    const claim=f.db.prepare('SELECT id,status FROM local_mail_claims').get() as {id:string;status:string};assert.equal(claim.status,'sending');f.close();
    reopened=new DatabaseSync(path);const restarted=new LocalMailService(reopened,f.secrets,f.authority,f.transport);restarted.recover();
    assert.equal(restarted.sendStatus(claim.id).status,'uncertain');await assert.rejects(restarted.sendDraft(a.id,d.id,'wa:restart'));assert.equal(calls,1);
    g.release();await handled;
  }finally{reopened?.close();try{f.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});

test('Keychain vault adapter uses opaque 32-character slots for separate credentials',async()=>{
  const {macKeychainStore}=await import('../src/local-email/keychain-adapter.js');const f=fixture();try{
    const slots=new Map<string,string>();const vault={read:async(k:string)=>slots.get(k),write:async(k:string,v:string)=>{assert.match(k,/^[a-f0-9]{32}$/);slots.set(k,v);},remove:async(k:string)=>{slots.delete(k);}};
    const s=new LocalMailService(f.db,macKeychainStore(vault,()=>true),f.authority,f.transport);const a=await s.configureAccount(undefined,config,passwords);
    assert.equal(a.status,'ready');assert.equal(slots.size,2);await s.disconnect(a.id);assert.equal(slots.size,0);
  }finally{f.close();}
});

test('unavailable Keychain prevents inbox and send before transport use',async()=>{
  const f=fixture();try{const a=await ready(f),d=f.service.saveDraft(a.id,undefined,draft);f.approve('wa:keychain',a,d);let reads=0;
    f.transport.read=async()=>{reads++;return [];};f.secrets.available=()=>false;
    await assert.rejects(f.service.inbox(a.id));await assert.rejects(f.service.sendDraft(a.id,d.id,'wa:keychain'));assert.equal(reads,0);assert.equal(f.sends,0);
  }finally{f.close();}
});

test('an ambiguous write remains staged during the same boot, even after recovery',async()=>{
  const f=fixture(),g=gate();try{let late:Promise<void>|undefined;
    f.secrets.save=async(key,value)=>{late=(async()=>{g.start();await g.wait;f.values.set(key,value);})();throw Error('synthetic timeout before helper exit');};
    await assert.rejects(ready(f));await g.entered;assert.equal(f.service.recoveryRequired(),true);
    await f.service.cleanupCredentials();assert.equal(f.service.cleanupPending(),2);
    g.release();await late;assert.equal(f.values.size,1);f.service.recover();await f.service.cleanupCredentials();assert.equal(f.values.size,1);assert.equal(f.service.cleanupPending(),2);f.nextBoot();f.service.recover();await f.service.cleanupCredentials();assert.equal(f.values.size,0);assert.equal(f.service.cleanupPending(),0);
  }finally{f.close();}
});

test('staged credentials are protected from cleanup through a separate database connection',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'mail-concurrent-')),path=join(dir,'state.sqlite'),f=fixture(path),g=gate();let otherDb:DatabaseSync|undefined;
  try{
    otherDb=new DatabaseSync(path);const other=new LocalMailService(otherDb,f.secrets,f.authority,f.transport);let writes=0;
    f.secrets.save=async(key,value)=>{f.values.set(key,value);if(++writes===2){g.start();await g.wait;}};
    const pending=ready(f);await g.entered;await other.cleanupCredentials();assert.equal(f.values.size,2);g.release();assert.equal((await pending).status,'ready');assert.equal(f.values.size,2);
  }finally{otherDb?.close();f.close();rmSync(dir,{recursive:true,force:true});}
});
test('ambiguous staged slots survive a same-boot database restart and old unrecorded stages stay protected',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mail-boot-recovery-')),path=join(dir,'mail.sqlite'),f=fixture(path);let reopened:DatabaseSync|undefined;
 try{
  f.secrets.save=async(key,value)=>{f.values.set(key,value);throw Error('ambiguous');};await assert.rejects(ready(f));
  const slots=f.db.prepare('SELECT secret_key FROM local_mail_secret_cleanup ORDER BY secret_key').all() as {secret_key:string}[];
  f.db.prepare('UPDATE local_mail_secret_cleanup SET boot_id=NULL WHERE secret_key=?').run(slots[0].secret_key);f.close();
  reopened=new DatabaseSync(path);const service=new LocalMailService(reopened,f.secrets,f.authority,f.transport);
  service.recover();await service.cleanupCredentials();assert.equal(service.cleanupPending(),2);
  f.nextBoot();service.recover();await service.cleanupCredentials();assert.equal(service.cleanupPending(),1);
  assert.equal((reopened.prepare('SELECT boot_id FROM local_mail_secret_cleanup').get() as {boot_id:string|null}).boot_id,null);assert.equal(service.recoveryRequired(),true);
 }finally{reopened?.close();try{f.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});
