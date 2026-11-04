import {simpleParser} from 'mailparser';
import {createHash} from 'node:crypto';
import type {LocalMailService, MailOwner, MailDraftView} from './service.js';

/** Mail is external, untrusted data; it is never an instruction or a tool request. */
export type InboxMessage={uid:number;sourceDigest:string;from:string;subject:string;date:string|null;text:string;attachments:number;plainTextAvailable:boolean};
export type AssistantRequest={task:'summary'|'reply';messages:InboxMessage[];ownerInstruction:string;tone:string};
export type MailWriter=(request:AssistantRequest,current:()=>boolean)=>Promise<string>;
export type AssistantAuthority={capture():MailOwner;isCurrent(owner:MailOwner):boolean};
const fail=()=>new Error('The email assistant could not complete this request.');
const clean=(s:string,limit:number)=>s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,limit);

/** Plain text only: never render HTML, load remote resources, or open attachments. */
export async function parseInboxMessage(uid:number,raw:Buffer):Promise<InboxMessage>{
  if(!Number.isSafeInteger(uid)||uid<1||raw.length>256_000)throw fail();
  try{
    const parsed=await simpleParser(raw,{skipHtmlToText:true,skipTextToHtml:true,skipImageLinks:true});
    const from=(parsed.from?.value??[]).map(x=>x.address??x.name??'').join(', ');
    const available=typeof parsed.text==='string'&&parsed.text.trim().length>0;
    return {uid,sourceDigest:createHash('sha256').update(raw).digest('hex'),from:clean(from,500),subject:clean(parsed.subject??'(no subject)',300),date:parsed.date&&!Number.isNaN(parsed.date.getTime())?parsed.date.toISOString():null,text:available?clean(parsed.text!,12_000):'',attachments:parsed.attachments.length,plainTextAvailable:available};
  }catch{throw fail();}
}

/** No model receives tools or send authority. The host must separately obtain consent before a cloud writer sees mail. */
export class MailAssistant {
  constructor(private readonly mail:LocalMailService,private readonly authority:AssistantAuthority,private readonly writer:MailWriter){}
  private guard(accountId:string){
    const owner=this.authority.capture(),account=this.mail.listAccounts().find(a=>a.id===accountId&&a.status==='ready');
    if(!owner?.id||!owner.generation||!account||this.authority.isCurrent(owner)!==true)throw fail();
    const snapshot={...owner},generation=account.generation;
    return ()=>{try{return this.authority.isCurrent(snapshot)===true&&this.mail.listAccounts().some(a=>a.id===accountId&&a.status==='ready'&&a.generation===generation);}catch{return false;}};
  }
  async inbox(accountId:string,limit=10):Promise<InboxMessage[]>{
    const current=this.guard(accountId),raw=await this.mail.inbox(accountId,limit);if(!current())throw fail();
    const result=await Promise.all(raw.map(m=>parseInboxMessage(m.uid,m.raw)));if(!current())throw fail();return result;
  }
  async summarize(accountId:string,limit=10):Promise<{messages:InboxMessage[];summary:string}>{
    const current=this.guard(accountId),messages=await this.inbox(accountId,limit);if(!current())throw fail();
    if(!messages.length)return {messages,summary:'The inbox is empty.'};
    const summary=await this.write({task:'summary',messages,ownerInstruction:'Summarize the inbox.',tone:''},current);return {messages,summary};
  }
  /** The owner supplies recipients and subject; the model supplies body text only. */
  async prepareReply(accountId:string,uid:number,input:{to:string[];subject:string;instruction:string;tone:string;sourceDigest:string}):Promise<MailDraftView>{
    if(!input||!Array.isArray(input.to)||typeof input.subject!=='string'||typeof input.instruction!=='string'||typeof input.tone!=='string'||typeof input.sourceDigest!=='string'||!/^[a-f0-9]{64}$/.test(input.sourceDigest)||input.instruction.length>2000||input.tone.length>2000)throw fail();
    const snapshot={...input,to:[...input.to]};
    const current=this.guard(accountId),messages=await this.inbox(accountId,20),message=messages.find(m=>m.uid===uid&&m.sourceDigest===snapshot.sourceDigest);if(!current()||!message||!message.plainTextAvailable)throw fail();
    const body=await this.write({task:'reply',messages:[message],ownerInstruction:clean(snapshot.instruction,2000),tone:clean(snapshot.tone,2000)},current);
    if(!current())throw fail();return this.mail.saveDraft(accountId,undefined,{to:snapshot.to,subject:snapshot.subject,body});
  }
  private async write(request:AssistantRequest,current:()=>boolean){
    if(!current())throw fail();let output:string;try{output=await this.writer(request,current);}catch{throw fail();}
    if(!current()||typeof output!=='string')throw fail();const value=clean(output,12001).trim();if(!value||value.length>12000)throw fail();return value;
  }
}
