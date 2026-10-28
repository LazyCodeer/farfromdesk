import { randomBytes } from 'node:crypto';
import type { Store } from './store.js';
export type MessageOptions={choices:{id:string;label:string}[];expiresInSeconds:number};
export function parseMessageOptions(input:unknown):MessageOptions {
  const v=input as MessageOptions;
  if(!v||!Array.isArray(v.choices)||v.choices.length<2||v.choices.length>6)throw new Error('Offer two to six choices.');
  const choices=v.choices.map(c=>{
    if(!c||typeof c.id!=='string'||!/^[a-zA-Z0-9_-]{1,32}$/.test(c.id)||typeof c.label!=='string'||!c.label.trim()||c.label.length>80||/[\x00-\x1f\x7f]/.test(c.label))throw new Error('Choices need unique IDs and readable labels of up to 80 characters.');
    return {id:c.id,label:c.label.trim()};
  });
  if(new Set(choices.map(c=>c.id)).size!==choices.length)throw new Error('Choice IDs must be unique.');
  const expiresInSeconds=v.expiresInSeconds??900;
  if(!Number.isInteger(expiresInSeconds)||expiresInSeconds<30||expiresInSeconds>86400)throw new Error('Choices expire after 30 seconds to 24 hours.');
  return {choices,expiresInSeconds};
}
export function initializeOptions(store:Store){store.db.exec(`CREATE TABLE IF NOT EXISTS message_options(
 id TEXT PRIMARY KEY,outbox_id TEXT UNIQUE NOT NULL REFERENCES outbox(id) ON DELETE CASCADE,request_id TEXT NOT NULL,binding_id TEXT NOT NULL,
 destination TEXT NOT NULL,owner TEXT NOT NULL,choices TEXT NOT NULL,expires_at INTEGER NOT NULL,selected_id TEXT,response_id TEXT);
 CREATE UNIQUE INDEX IF NOT EXISTS message_options_response ON message_options(response_id) WHERE response_id IS NOT NULL;`);}
export function createOptions(store:Store,outboxId:string,requestId:string,bindingId:string,destination:string,options:MessageOptions){
  const id=randomBytes(18).toString('base64url');
  store.db.prepare('INSERT INTO message_options(id,outbox_id,request_id,binding_id,destination,owner,choices,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(id,outboxId,requestId,bindingId,destination,store.ownerFor(destination)??'',JSON.stringify(options.choices),Date.now()+options.expiresInSeconds*1000);
}
export function optionsMarkup(store:Store,outboxId:string){
  const row=store.db.prepare('SELECT * FROM message_options WHERE outbox_id=?').get(outboxId) as any;
  if(!row||row.selected_id||row.expires_at<=Date.now())return undefined;
  return {inline_keyboard:JSON.parse(row.choices).map((c:any,i:number)=>[{text:c.label,callback_data:`opt:${row.id}:${i+1}`}])};
}
/** Caller supplies an authenticated channel identity. Queueing and consumption are one transaction.
 * No approval handler or slash-command parser sees an option label. */
export function selectOption(store:Store,input:{responseId:string;destination:string;messageId:string;token?:string;number?:number},queue:(bindingId:string,text:string)=>void){
  const match=input.token?/^opt:([A-Za-z0-9_-]{24}):([1-6])$/.exec(input.token):undefined;
  if(input.token&&!match)throw new Error('Invalid choice.');
  const row=store.db.prepare(`SELECT o.*,b.wa_id,b.status FROM message_options o JOIN outbox b ON b.id=o.outbox_id WHERE b.wa_id=? AND o.destination=?`).get(input.messageId,input.destination) as any;
  if(!row){if(input.token)throw new Error('This choice does not belong to that message.');return false;}
  if(match&&row.id!==match[1])throw new Error('This choice does not belong to that message.');
  if(store.controlChannel()!==(input.destination.startsWith('tg:')?'telegram':'whatsapp')||(!row.owner||store.ownerFor(input.destination)!==row.owner||input.destination!==row.owner&&(store.get('destination-jid')!==input.destination||!store.get(`owned-group:${input.destination}`)))||row.status!=='sent'||row.expires_at<=Date.now())throw new Error('These choices expired or are unavailable. Ask for fresh choices.');
  const job=store.job(row.request_id);
  if(!job||job.binding_id!==row.binding_id||job.destination!==input.destination||!store.binding(row.binding_id)?.enabled||['replaced','cancelled','reviewed','auto_closed'].includes(job.status))throw new Error('The original request is no longer available.');
  const index=match?Number(match[2]):input.number;
  const choice=JSON.parse(row.choices)[Number(index)-1];
  if(!choice)throw new Error('Choose one of the offered numbers.');
  if(row.selected_id){if(row.selected_id===choice.id)return true;throw new Error('This question already has an answer.');}
  store.db.exec('SAVEPOINT choose_option');
  try{
    const changed=store.db.prepare('UPDATE message_options SET selected_id=?,response_id=? WHERE id=? AND selected_id IS NULL').run(choice.id,input.responseId,row.id);
    if(changed.changes){
      const item=store.itemOf(row.request_id);if(item)store.linkItem(input.responseId,item);
      queue(row.binding_id,`Owner selected an offered answer for request ${row.request_id}: ${JSON.stringify(choice)}. This is a message choice, not a native permission grant. Preserve the original task scope.`);
      store.remember(input.responseId);
    }
    store.db.exec('RELEASE choose_option');
  }catch(e){store.db.exec('ROLLBACK TO choose_option; RELEASE choose_option');throw e;}
  return true;
}
