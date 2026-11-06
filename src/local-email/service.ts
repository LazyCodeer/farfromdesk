import {randomBytes,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {composeMail,readAccountInbox,sendAccountMail,type MailDraft,type MailEndpoint,type MailReadAuthority,type MailSendAuthority} from './transport.js';

/** All authority and storage adapters are supplied by trusted host code, not API input. */
export type MailOwner={id:string;generation:string};
export type SendApprovalScope={owner:MailOwner;accountId:string;accountGeneration:string;draftId:string;draftRevision:string;digest:string;approvalRef:string};
export type HostMailAuthority={capture():MailOwner;isCurrent(owner:MailOwner):boolean;verifyExplicitSend(scope:SendApprovalScope):{eventId:string};approvalCurrent(scope:SendApprovalScope,eventId:string):boolean;assertExclusiveRecovery():boolean;recoveryBootId?():string|undefined};
/** macOS Keychain, or Windows Credential Manager (per-user, this PC only). */
export type MailSecretStore={kind:'macos-keychain'|'windows-credential-manager';available():boolean;read(key:string):Promise<string|undefined>;save(key:string,password:string):Promise<void>;remove(key:string):Promise<void>};
export type MailConfigureInput={address:string;imap:MailEndpoint&{password:string};smtp:MailEndpoint&{password:string}};
export type MailAccountInput={label:string;address:string;imap:MailEndpoint;smtp:MailEndpoint};
export type MailAccountView={id:string;label:string;address:string;imap:MailEndpoint;smtp:MailEndpoint;status:'ready'|'updating'|'setup_failed';generation:string};
export type MailDraftInput={to:string[];subject:string;body:string};
export type MailDraftView=MailDraftInput&{id:string;accountId:string;revision:string;digest:string;from:string};
type AccountRow={id:string;owner:string;generation:string;status:string;label:string;address:string;imap_json:string;smtp_json:string;imap_key:string|null;smtp_key:string|null};
type DraftRow={id:string;account_id:string;owner:string;revision:string;digest:string;data_json:string};
type ClaimRow={id:string;owner:string;owner_generation:string;account_id:string;account_generation:string;draft_id:string;draft_revision:string;digest:string;status:string};
type Transport={read:typeof readAccountInbox;send:typeof sendAccountMail};
const failure=()=>new Error('The mailbox operation could not be completed.');
const uuid=()=>randomUUID();
const secretSlot=()=>randomBytes(16).toString('hex');
const isId=(id:string)=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(id);
function endpoint(value:MailEndpoint):MailEndpoint{
  if(!value||typeof value.host!=='string'||!/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value.host)||!Number.isInteger(value.port)||value.port<1||value.port>65535||typeof value.username!=='string'||!value.username||value.username.length>512||/[\x00-\x1f\x7f]/.test(value.username))throw failure();
  return {host:value.host,port:value.port,username:value.username};
}
function inputAccount(value:MailAccountInput):MailAccountInput{
  if(!value||typeof value.label!=='string'||!value.label.trim()||value.label.length>100||/[\x00-\x1f\x7f]/.test(value.label)||typeof value.address!=='string')throw failure();
  composeMail({from:value.address,to:[value.address],subject:'',body:''});
  return {label:value.label.trim(),address:value.address,imap:endpoint(value.imap),smtp:endpoint(value.smtp)};
}
function password(value:string){if(typeof value!=='string'||!value||value.length>4096||/[\x00-\x1f\x7f]/.test(value))throw failure();return value;}
const safeRef=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\x00-\x1f\x7f]/.test(value);
function validOwner(value:MailOwner){return !!value&&safeRef(value.id)&&safeRef(value.generation);}

/** Single host process owns this service/database. Call recover() only before serving work. */
export class LocalMailService {
  private readonly busySecrets=new Set<string>();
  private readonly transport:Transport;
  constructor(private readonly db:DatabaseSync,private readonly secrets:MailSecretStore,private readonly authority:HostMailAuthority,transport?:Transport){
    this.transport=transport??{read:readAccountInbox,send:sendAccountMail};
    db.exec('PRAGMA synchronous=FULL');
    db.exec(`CREATE TABLE IF NOT EXISTS local_mail_accounts(id TEXT PRIMARY KEY,owner TEXT NOT NULL,generation TEXT NOT NULL,status TEXT NOT NULL,label TEXT NOT NULL,address TEXT NOT NULL,imap_json TEXT NOT NULL,smtp_json TEXT NOT NULL,imap_key TEXT,smtp_key TEXT);
      CREATE TABLE IF NOT EXISTS local_mail_drafts(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,owner TEXT NOT NULL,revision TEXT NOT NULL,digest TEXT NOT NULL,data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_mail_claims(id TEXT PRIMARY KEY,approval_event TEXT UNIQUE NOT NULL,owner TEXT NOT NULL,owner_generation TEXT NOT NULL,account_id TEXT NOT NULL,account_generation TEXT NOT NULL,draft_id TEXT NOT NULL,draft_revision TEXT NOT NULL,digest TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS local_mail_claim_draft ON local_mail_claims(draft_id,draft_revision,status);
      CREATE TABLE IF NOT EXISTS local_mail_secret_cleanup(secret_key TEXT PRIMARY KEY,owner TEXT NOT NULL,account_id TEXT NOT NULL,staged INTEGER NOT NULL,boot_id TEXT);`);
    const columns=db.prepare('PRAGMA table_info(local_mail_secret_cleanup)').all() as {name:string}[];if(!columns.some(c=>c.name==='boot_id'))db.exec('ALTER TABLE local_mail_secret_cleanup ADD COLUMN boot_id TEXT');
  }
  private transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  private capture(){let owner:MailOwner;try{owner=this.authority.capture();if(!validOwner(owner)||this.authority.isCurrent(owner)!==true)throw failure();return {...owner};}catch{throw failure();}}
  private current(owner:MailOwner){try{if(!validOwner(owner)||this.authority.isCurrent(owner)!==true)throw failure();}catch{throw failure();}}
  private row(id:string):AccountRow|undefined{return this.db.prepare('SELECT * FROM local_mail_accounts WHERE id=?').get(id) as AccountRow|undefined;}
  private account(owner:MailOwner,id:string,ready=true){this.current(owner);if(!isId(id))throw failure();const a=this.row(id);if(!a||a.owner!==owner.id||a.status==='removed'||ready&&a.status!=='ready')throw failure();return a;}
  private accountCurrent(owner:MailOwner,id:string,generation:string){const a=this.account(owner,id);if(a.generation!==generation)throw failure();return a;}
  private view(a:AccountRow):MailAccountView{return {id:a.id,label:a.label,address:a.address,imap:JSON.parse(a.imap_json),smtp:JSON.parse(a.smtp_json),status:a.status as MailAccountView['status'],generation:a.generation};}
  listAccounts():MailAccountView[]{const owner=this.capture();return (this.db.prepare("SELECT * FROM local_mail_accounts WHERE owner=? AND status!='removed' ORDER BY id").all(owner.id) as AccountRow[]).map(a=>this.view(a));}
  private bootId(){try{const id=this.authority.recoveryBootId?.();return typeof id==='string'&&/^[A-Za-z0-9-]{1,100}$/.test(id)?id:undefined;}catch{return undefined;}}
  private queueKey(key:string|null|undefined,owner:string,accountId:string,staged=false){if(key)this.db.prepare('INSERT OR IGNORE INTO local_mail_secret_cleanup(secret_key,owner,account_id,staged,boot_id) VALUES(?,?,?,?,?)').run(key,owner,accountId,staged?1:0,staged?this.bootId()??null:null);}
  private storageAvailable(){try{return (this.secrets.kind==='macos-keychain'||this.secrets.kind==='windows-credential-manager')&&this.secrets.available()===true;}catch{return false;}}
  status(){
    const accounts=this.listAccounts(),available=this.storageAvailable();
    const state=!available?'unavailable':accounts.some(a=>a.status==='setup_failed')?'attention':accounts.some(a=>a.status==='updating')?'updating':accounts.some(a=>a.status==='ready')?'configured':'not_configured';
    return {available,state,credentialStorage:available?this.secrets.kind:'unavailable',credentialsCleanupPending:this.cleanupPending()>0,credentialsRecoveryRequired:this.recoveryRequired(),accounts:accounts.map(a=>({id:a.id,address:a.address,imap:a.imap,smtp:a.smtp,status:a.status==='ready'?'configured':a.status,generation:a.generation,credentialsCleanupPending:this.cleanupPending(a.id)>0,credentialsRecoveryRequired:this.recoveryRequired(a.id)}))};
  }
  async configure(input:MailConfigureInput,id?:string){if(!input||!input.imap||!input.smtp)throw failure();return this.configureAccount(id,{label:input.address,address:input.address,imap:input.imap,smtp:input.smtp},{imapPassword:input.imap.password,smtpPassword:input.smtp.password});}
  disconnect(id:string){return this.removeAccount(id);}
  private invalidateAccount(id:string){this.db.prepare("UPDATE local_mail_claims SET status='uncertain' WHERE account_id=? AND status IN ('claimed','sending')").run(id);}
  /** Both credentials are replaced as one generation; the account is disabled during the write. */
  async configureAccount(accountId:string|undefined,raw:MailAccountInput,credentials:{imapPassword:string;smtpPassword:string}):Promise<MailAccountView>{
    const owner=this.capture(),config=inputAccount(raw),imapPassword=password(credentials.imapPassword),smtpPassword=password(credentials.smtpPassword);if(!this.storageAvailable())throw failure();
    const id=accountId??uuid();if(!isId(id))throw failure();const generation=uuid(),imapKey=secretSlot(),smtpKey=secretSlot();
    this.transaction(()=>{
      this.current(owner);const old=this.row(id);if(old&&(old.owner!==owner.id||old.status==='removed'))throw failure();
      this.invalidateAccount(id);this.queueKey(old?.imap_key,owner.id,id);this.queueKey(old?.smtp_key,owner.id,id);this.queueKey(imapKey,owner.id,id,true);this.queueKey(smtpKey,owner.id,id,true);
      this.db.prepare(`INSERT INTO local_mail_accounts(id,owner,generation,status,label,address,imap_json,smtp_json,imap_key,smtp_key) VALUES(?,?,?,'updating',?,?,?,?,NULL,NULL)
        ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,status='updating',label=excluded.label,address=excluded.address,imap_json=excluded.imap_json,smtp_json=excluded.smtp_json,imap_key=NULL,smtp_key=NULL`).run(id,owner.id,generation,config.label,config.address,JSON.stringify(config.imap),JSON.stringify(config.smtp));
    });
    this.busySecrets.add(imapKey);this.busySecrets.add(smtpKey);let activated=false,writesSettled=false;
    try{
      await this.secrets.save(imapKey,imapPassword);this.current(owner);
      if(this.row(id)?.generation!==generation)throw failure();
      await this.secrets.save(smtpKey,smtpPassword);writesSettled=true;this.current(owner);
      await this.cleanupCredentials();
      this.transaction(()=>{
        this.current(owner);const current=this.row(id);if(!current||current.owner!==owner.id||current.generation!==generation||current.status!=='updating')throw failure();
        this.db.prepare("UPDATE local_mail_accounts SET status='ready',imap_key=?,smtp_key=? WHERE id=? AND generation=?").run(imapKey,smtpKey,id,generation);
        this.db.prepare('DELETE FROM local_mail_secret_cleanup WHERE secret_key IN (?,?)').run(imapKey,smtpKey);
      });activated=true;
      return this.view(this.accountCurrent(owner,id,generation));
    }catch{try{this.transaction(()=>this.db.prepare("UPDATE local_mail_accounts SET status='setup_failed' WHERE id=? AND generation=? AND status='updating'").run(id,generation));}catch{}throw failure();}
    finally{try{if(!activated&&writesSettled)this.transaction(()=>this.db.prepare('UPDATE local_mail_secret_cleanup SET staged=0 WHERE secret_key IN (?,?)').run(imapKey,smtpKey));}catch{/* Ambiguous stages remain protected until a later system boot. */}finally{this.busySecrets.delete(imapKey);this.busySecrets.delete(smtpKey);}}
  }
  /** Revokes before touching the OS store. Failed removals remain queued for cleanup. */
  async removeAccount(id:string):Promise<{credentialsCleanupPending:boolean}>{
    const owner=this.capture();this.transaction(()=>{const a=this.account(owner,id,false);this.invalidateAccount(id);this.queueKey(a.imap_key,owner.id,id);this.queueKey(a.smtp_key,owner.id,id);
      this.db.prepare("UPDATE local_mail_accounts SET status='removed',generation=?,imap_key=NULL,smtp_key=NULL,label='',address='',imap_json='{}',smtp_json='{}' WHERE id=?").run(uuid(),id);
      this.db.prepare('DELETE FROM local_mail_drafts WHERE account_id=? AND owner=?').run(id,owner.id);
    });
    await this.cleanupCredentials();this.current(owner);return {credentialsCleanupPending:this.cleanupPending(id)>0};
  }
  cleanupPending(accountId?:string){const owner=this.capture();if(accountId!==undefined&&!isId(accountId))throw failure();return Number((this.db.prepare('SELECT COUNT(*) AS n FROM local_mail_secret_cleanup WHERE owner=? AND (? IS NULL OR account_id=?)').get(owner.id,accountId??null,accountId??null) as {n:number}).n);}
  recoveryRequired(accountId?:string){const owner=this.capture();if(accountId!==undefined&&!isId(accountId))throw failure();return !!this.db.prepare("SELECT 1 FROM local_mail_secret_cleanup q LEFT JOIN local_mail_accounts a ON a.id=q.account_id WHERE q.owner=? AND q.staged=1 AND (a.id IS NULL OR a.status!='updating') AND (? IS NULL OR q.account_id=?) LIMIT 1").get(owner.id,accountId??null,accountId??null);}
  /** May run after setup or deletion; failures remain in the durable cleanup queue. */
  async cleanupCredentials(){
    const owner=this.capture(),keys=this.db.prepare('SELECT secret_key FROM local_mail_secret_cleanup WHERE owner=? AND staged=0').all(owner.id) as {secret_key:string}[];
    for(const {secret_key:key} of keys){this.current(owner);if(this.busySecrets.has(key))continue;try{await this.secrets.remove(key);this.transaction(()=>this.db.prepare('DELETE FROM local_mail_secret_cleanup WHERE secret_key=? AND owner=?').run(key,owner.id));}catch{/* Retry explicitly later. */}}
  }
  /** Run once at exclusive startup, before handling messages or background operations. */
  recover(){try{if(this.authority.assertExclusiveRecovery()!==true)throw failure();}catch{throw failure();}const boot=this.bootId();this.transaction(()=>{this.db.exec("UPDATE local_mail_claims SET status='uncertain' WHERE status IN ('claimed','sending'); UPDATE local_mail_accounts SET status='setup_failed' WHERE status='updating';");if(boot)this.db.prepare("UPDATE local_mail_secret_cleanup SET staged=0 WHERE staged=1 AND boot_id IS NOT NULL AND boot_id<>?").run(boot);});}
  private draft(owner:MailOwner,id:string):DraftRow{if(!isId(id))throw failure();const d=this.db.prepare('SELECT * FROM local_mail_drafts WHERE id=? AND owner=?').get(id,owner.id) as DraftRow|undefined;if(!d)throw failure();return d;}
  private draftView(row:DraftRow):MailDraftView{return {...JSON.parse(row.data_json),id:row.id,accountId:row.account_id,revision:row.revision,digest:row.digest};}
  saveDraft(accountId:string,draftId:string|undefined,input:MailDraftInput):MailDraftView {
    const owner=this.capture(),account=this.account(owner,accountId);if(!input||!Array.isArray(input.to)||typeof input.subject!=='string'||typeof input.body!=='string'||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(input.body))throw failure();
    const content:MailDraft={from:account.address,to:[...input.to],subject:input.subject,body:input.body},digest=composeMail(content).digest,id=draftId??uuid(),revision=uuid();if(!isId(id))throw failure();
    this.transaction(()=>{this.accountCurrent(owner,accountId,account.generation);const old=this.db.prepare('SELECT * FROM local_mail_drafts WHERE id=?').get(id) as DraftRow|undefined;
      if(old&&(old.owner!==owner.id||old.account_id!==accountId))throw failure();
      this.db.prepare("UPDATE local_mail_claims SET status='uncertain' WHERE draft_id=? AND status IN ('claimed','sending')").run(id);
      this.db.prepare(`INSERT INTO local_mail_drafts(id,account_id,owner,revision,digest,data_json) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,data_json=excluded.data_json`).run(id,accountId,owner.id,revision,digest,JSON.stringify(content));
    });return this.draftView(this.draft(owner,id));
  }
  getDraft(id:string):MailDraftView{const owner=this.capture(),d=this.draft(owner,id);this.account(owner,d.account_id);return this.draftView(d);}
  listDrafts(accountId:string):MailDraftView[]{const owner=this.capture();this.account(owner,accountId);return (this.db.prepare('SELECT * FROM local_mail_drafts WHERE account_id=? AND owner=? ORDER BY rowid DESC LIMIT 100').all(accountId,owner.id) as DraftRow[]).map(d=>this.draftView(d));}
  deleteDraft(id:string){const owner=this.capture(),d=this.draft(owner,id);this.account(owner,d.account_id);this.transaction(()=>{this.current(owner);this.db.prepare("UPDATE local_mail_claims SET status='uncertain' WHERE draft_id=? AND status IN ('claimed','sending')").run(id);this.db.prepare('DELETE FROM local_mail_drafts WHERE id=? AND owner=?').run(id,owner.id);});}
  async inbox(accountId:string,limit=10){const owner=this.capture(),account=this.account(owner,accountId);if(!this.storageAvailable()||!account.imap_key)throw failure();
    const readAuthority:MailReadAuthority={assertCurrent:()=>{this.accountCurrent(owner,accountId,account.generation);}};
    const result=await this.transport.read(account.imap_key,JSON.parse(account.imap_json),this.secrets,readAuthority,limit);readAuthority.assertCurrent();return result;
  }
  /** The host verifier must prove this exact action was explicitly authorized by the owner. */
  async sendDraft(accountId:string,draftId:string,approvalRef:string):Promise<{claimId:string;status:'sent'|'uncertain'}>{
    const owner=this.capture(),account=this.account(owner,accountId),draft=this.draft(owner,draftId);if(draft.account_id!==accountId||!this.storageAvailable()||!account.smtp_key||!safeRef(approvalRef))throw failure();
    const body=JSON.parse(draft.data_json) as MailDraft;if(composeMail(body).digest!==draft.digest||body.from!==account.address)throw failure();
    const claimId=uuid(),scope:SendApprovalScope=Object.freeze({owner:Object.freeze({...owner}),accountId,accountGeneration:account.generation,draftId,draftRevision:draft.revision,digest:draft.digest,approvalRef});let eventId='';try{this.transaction(()=>{
      this.accountCurrent(owner,accountId,account.generation);const current=this.draft(owner,draftId);if(current.revision!==draft.revision||current.digest!==draft.digest)throw failure();
      const existing=this.db.prepare("SELECT 1 FROM local_mail_claims WHERE draft_id=? AND draft_revision=? AND status IN ('claimed','sending','sent','uncertain')").get(draftId,draft.revision);if(existing)throw failure();
      let approval:{eventId:string};try{approval=this.authority.verifyExplicitSend(scope);}catch{throw failure();}
      if(!approval||!safeRef(approval.eventId))throw failure();eventId=approval.eventId;this.current(owner);if(this.authority.approvalCurrent(scope,eventId)!==true)throw failure();
      this.db.prepare("INSERT INTO local_mail_claims VALUES(?,?,?,?,?,?,?,?,?,'claimed',?)").run(claimId,approval.eventId,owner.id,owner.generation,accountId,account.generation,draftId,draft.revision,draft.digest,Date.now());
    });}catch{throw failure();}
    const assertCurrent=(digest:string)=>{this.accountCurrent(owner,accountId,account.generation);const d=this.draft(owner,draftId);const c=this.db.prepare('SELECT * FROM local_mail_claims WHERE id=?').get(claimId) as ClaimRow|undefined;
      if(this.authority.approvalCurrent(scope,eventId)!==true||!c||!['claimed','sending'].includes(c.status)||c.owner!==owner.id||c.owner_generation!==owner.generation||c.account_id!==accountId||c.draft_id!==draftId||c.account_generation!==account.generation||c.draft_revision!==draft.revision||c.digest!==digest||digest!==draft.digest||d.revision!==draft.revision||d.digest!==draft.digest||composeMail(JSON.parse(d.data_json)).digest!==draft.digest)throw failure();};
    const sendAuthority:MailSendAuthority={assertCurrent,claim:async digest=>{this.transaction(()=>{assertCurrent(digest);const r=this.db.prepare("UPDATE local_mail_claims SET status='sending' WHERE id=? AND status='claimed'").run(claimId);if(!r.changes)throw failure();});}};
    try{
      const result=await this.transport.send(account.smtp_key,JSON.parse(account.smtp_json),this.secrets,body,sendAuthority);
      let status:'sent'|'uncertain'='uncertain';try{assertCurrent(draft.digest);const active=this.db.prepare('SELECT status FROM local_mail_claims WHERE id=?').get(claimId) as {status:string}|undefined;if(active?.status==='sending'&&result.digest===draft.digest&&result.status==='sent')status='sent';}catch{}
      this.transaction(()=>this.db.prepare("UPDATE local_mail_claims SET status=? WHERE id=? AND status IN ('claimed','sending')").run(status,claimId));
    }catch{this.transaction(()=>this.db.prepare("UPDATE local_mail_claims SET status='uncertain' WHERE id=? AND status IN ('claimed','sending')").run(claimId));}
    const claim=this.db.prepare('SELECT status FROM local_mail_claims WHERE id=?').get(claimId) as {status:string}|undefined;
    this.current(owner);return {claimId,status:claim?.status==='sent'?'sent':'uncertain'};
  }
  sendStatus(claimId:string):{claimId:string;status:string}{const owner=this.capture();if(!isId(claimId))throw failure();const claim=this.db.prepare('SELECT status FROM local_mail_claims WHERE id=? AND owner=?').get(claimId,owner.id) as {status:string}|undefined;if(!claim)throw failure();return {claimId,status:claim.status};}
}
