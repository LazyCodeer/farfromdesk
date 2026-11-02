import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {MailSecretStore,HostMailAuthority,MailOwner,SendApprovalScope,MailDraftView,MailAccountInput} from './service.js';
import {LocalMailService} from './service.js';
import {MailAssistant,type MailWriter} from './assistant.js';
import {readAccountInbox,sendAccountMail} from './transport.js';
import {publicMailConnector} from './network-policy.js';

type Transport={read:typeof readAccountInbox;send:typeof sendAccountMail};
type Approver=(draft:MailDraftView)=>Promise<boolean>;
const fail=()=>new Error('The email operation could not be completed.');
const exact=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** Only an authenticated Local desktop can reach this host. Never expose test dependencies via routes. */
export class LocalMailHost {
  readonly mail:LocalMailService;readonly assistant:MailAssistant;
  private generation='';private approving=false;private closed=false;private consentRevision=0;
  private authority:HostMailAuthority;
  constructor(private db:DatabaseSync,secrets:MailSecretStore,private locked:()=>boolean,private approve:Approver,writer:MailWriter,transport?:Transport,bootId?:string){
    if(locked()!==true)throw fail();
    db.exec(`CREATE TABLE IF NOT EXISTS email_host_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS email_host_approvals(id TEXT PRIMARY KEY,scope TEXT NOT NULL,active INTEGER NOT NULL);`);
    this.advanceGeneration();db.prepare('UPDATE email_host_approvals SET active=0').run();
    const capture=():MailOwner=>{if(this.closed||locked()!==true)throw fail();return {id:'local-desktop',generation:this.generation};};
    const isCurrent=(owner:MailOwner)=>!this.closed&&locked()===true&&owner.id==='local-desktop'&&owner.generation===this.generation;
    const approvalCurrent=(scope:SendApprovalScope,eventId:string)=>{const row=db.prepare('SELECT scope FROM email_host_approvals WHERE id=? AND active=1').get(eventId) as {scope:string}|undefined;return isCurrent(scope.owner)&&!!row&&row.scope===JSON.stringify(scope)&&eventId===scope.approvalRef;};
    this.authority={capture,isCurrent,approvalCurrent,verifyExplicitSend:scope=>{if(!approvalCurrent(scope,scope.approvalRef))throw fail();return {eventId:scope.approvalRef};},assertExclusiveRecovery:()=>locked()===true&&!this.closed,recoveryBootId:()=>bootId};
    const deps={connectTls:publicMailConnector()};
    this.mail=new LocalMailService(db,secrets,this.authority,transport??{read:(id,endpoint,store,authority,limit)=>readAccountInbox(id,endpoint,store,authority,limit,deps),send:(id,endpoint,store,draft,authority)=>sendAccountMail(id,endpoint,store,draft,authority,deps)});
    this.mail.recover();
    const guardedWriter:MailWriter=async(request,current)=>{const epoch=this.consentRevision;if(!this.consent())throw fail();return writer(request,()=>current()&&this.consent()&&this.consentRevision===epoch);};
    this.assistant=new MailAssistant(this.mail,this.authority,guardedWriter);
  }
  private advanceGeneration(){
    this.db.prepare("INSERT OR IGNORE INTO email_host_settings VALUES('owner-generation','0')").run();
    const row=this.db.prepare("UPDATE email_host_settings SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='owner-generation' AND CAST(value AS INTEGER)<9223372036854775807 RETURNING value").get() as {value:string}|undefined;
    if(!row||!/^\d+$/.test(row.value))throw fail();this.generation=row.value;
  }
  consent(){return !this.closed&&this.locked()===true&&(this.db.prepare("SELECT value FROM email_host_settings WHERE key='cloud-consent'").get() as {value:string}|undefined)?.value==='yes';}
  setConsent(allow:boolean){if(typeof allow!=='boolean'||this.closed||!this.locked())throw fail();this.consentRevision++;this.db.prepare("INSERT INTO email_host_settings VALUES('cloud-consent',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(allow?'yes':'no');}
  status(){return {...this.mail.status(),cloudConsent:this.consent()};}
  async configure(account:MailAccountInput,credentials:{imapPassword:string;smtpPassword:string},id?:string){return this.mail.configureAccount(id,account,credentials);}
  async send(accountId:string,draftId:string,revision:string,digest:string){
    if(this.approving)throw fail();const owner=this.authority.capture(),account=this.mail.listAccounts().find(a=>a.id===accountId&&a.status==='ready'),draft=this.mail.getDraft(draftId);
    if(!account||draft.accountId!==accountId||draft.revision!==revision||draft.digest!==digest)throw fail();
    this.approving=true;try{
      if(await this.approve({...draft,to:[...draft.to]})!==true)return {status:'cancelled' as const};
      if(!this.authority.isCurrent(owner))throw fail();const current=this.mail.getDraft(draftId),currentAccount=this.mail.listAccounts().find(a=>a.id===accountId);
      if(!currentAccount||currentAccount.generation!==account.generation||!exact(current,draft))throw fail();
      const ref=randomUUID(),scope:SendApprovalScope={owner,accountId,accountGeneration:account.generation,draftId,draftRevision:draft.revision,digest:draft.digest,approvalRef:ref};
      this.db.prepare('INSERT INTO email_host_approvals VALUES(?,?,1)').run(ref,JSON.stringify(scope));
      try{return await this.mail.sendDraft(accountId,draftId,ref);}finally{this.db.prepare('UPDATE email_host_approvals SET active=0 WHERE id=?').run(ref);}
    }finally{this.approving=false;}
  }
  revoke(){this.advanceGeneration();this.consentRevision++;this.db.prepare('UPDATE email_host_approvals SET active=0').run();}
  close(){this.revoke();this.closed=true;}
}
