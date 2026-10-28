import { randomBytes, createHash } from 'node:crypto';
import { BufferJSON, decryptPollVote, jidNormalizedUser } from '@whiskeysockets/baileys';
import type { Store } from './store.js';

/** Experimental until a real linked-device self-chat vote has been verified. The text option message remains the fallback. */
export class WhatsAppPolls {
  constructor(private store:Store){
    store.db.exec('CREATE TABLE IF NOT EXISTS whatsapp_choice_polls(original_id TEXT PRIMARY KEY REFERENCES outbox(id) ON DELETE CASCADE,poll_id TEXT UNIQUE NOT NULL REFERENCES outbox(id) ON DELETE CASCADE);');
    store.db.exec("UPDATE outbox SET status='uncertain',error='Poll delivery interrupted; use the original numbered reply' WHERE status='sending' AND id IN (SELECT poll_id FROM whatsapp_choice_polls)");
  }
  queue(originalId:string) {
    if(this.store.get('whatsapp-choice-polls')!=='true')return;
    const row=this.store.db.prepare('SELECT b.*,o.choices,o.expires_at,o.selected_id FROM outbox b JOIN message_options o ON o.outbox_id=b.id WHERE b.id=?').get(originalId) as any;
    if(!row||row.destination?.startsWith('tg:')||row.status!=='sent'||row.selected_id||row.expires_at<=Date.now()||this.store.db.prepare('SELECT 1 FROM whatsapp_choice_polls WHERE original_id=?').get(originalId))return;
    this.store.db.exec('SAVEPOINT queue_poll');
    try{
      const source=`choice-poll:${originalId}`;
      this.store.output(undefined,'Choose one answer below. You can also reply with a number to the original message.',source,row.destination);
      const poll=this.store.db.prepare('SELECT id FROM outbox WHERE source=?').get(source+':0') as any;
      this.store.db.prepare('INSERT INTO whatsapp_choice_polls VALUES(?,?)').run(originalId,poll.id);
      // Session list labels already carry their list number; numbering them again would read "1. 7. name".
      // All or none: numbering only some could make two options identical, and a vote maps to the first match.
      const labels=(JSON.parse(row.choices) as {label:string}[]).map(c=>c.label),numbered=labels.every(l=>/^\d+\. /.test(l));
      const values=numbered?labels:labels.map((l,i)=>`${i+1}. ${l}`);
      const message={messageContextInfo:{messageSecret:randomBytes(32)},pollCreationMessageV3:{name:row.body.split('\n')[0].slice(0,180)+'\nOr reply by number to the original message.',options:values.map(optionName=>({optionName})),selectableOptionsCount:1}};
      this.store.db.prepare('UPDATE outbox SET wa_message=? WHERE id=?').run(JSON.stringify(message,BufferJSON.replacer),poll.id);
      this.store.db.exec('RELEASE queue_poll');
    }catch(e){this.store.db.exec('ROLLBACK TO queue_poll; RELEASE queue_poll');throw e;}
  }
  message(pollId:string) {
    const row=this.store.db.prepare('SELECT p.wa_message,o.selected_id,o.expires_at,b.status FROM whatsapp_choice_polls l JOIN outbox p ON p.id=l.poll_id JOIN outbox b ON b.id=l.original_id JOIN message_options o ON o.outbox_id=b.id WHERE p.id=?').get(pollId) as any;
    if(!row)return undefined;
    if(this.store.get('whatsapp-choice-polls')!=='true')throw Error('Polls are disabled; use the original numbered reply.');
    if(row.selected_id||row.expires_at<=Date.now()||row.status!=='sent')throw Error('Poll expired or already answered; use fresh choices.');
    return JSON.parse(row.wa_message,BufferJSON.reviver);
  }
  isPoll(id:string){return !!this.store.db.prepare('SELECT 1 FROM whatsapp_choice_polls WHERE poll_id=?').get(id);}
  /** Called only after the adapter authenticates the owner and the exact destination. No decrypted label becomes a command. */
  vote(message:any,destination:string,owners:string[]) {
    if(this.store.get('whatsapp-choice-polls')!=='true')return;
    const update=message.message?.pollUpdateMessage,key=update?.pollCreationMessageKey;
    if(!update?.vote?.encPayload||update.vote.encPayload.length>2048||update.vote.encIv?.length!==12)return;
    if(!key?.id||key.fromMe!==true||!update.vote||!message.key?.fromMe||!message.key.id)return;
    if(key.remoteJid!==destination&&!owners.includes(jidNormalizedUser(key.remoteJid??'')))return;
    const row=this.store.db.prepare('SELECT p.status,p.wa_message,b.wa_id,o.id,o.choices FROM whatsapp_choice_polls l JOIN outbox p ON p.id=l.poll_id JOIN outbox b ON b.id=l.original_id JOIN message_options o ON o.outbox_id=b.id WHERE p.wa_id=? AND p.destination=?').get(key.id,destination) as any;
    if(!row||row.status!=='sent')return;
    const poll=JSON.parse(row.wa_message,BufferJSON.reviver),encKey=poll.messageContextInfo.messageSecret;
    // PN and LID are both authenticated identifiers of the same owner. Never try another person's identity.
    for(const creator of owners)for(const voter of owners){
      let vote;try{vote=decryptPollVote(update.vote,{pollCreatorJid:creator,pollMsgId:key.id,pollEncKey:encKey,voterJid:voter});}catch{continue;}
      if(vote.selectedOptions?.length!==1)return;
      const values=poll.pollCreationMessageV3.options as {optionName:string}[];
      const selected=Buffer.from(vote.selectedOptions[0]);
      const index=values.findIndex(v=>createHash('sha256').update(v.optionName).digest().equals(selected));
      if(index<0)return;
      return {id:`wa:${message.key.id}`,text:'Selected poll option',quotedId:row.wa_id,optionToken:`opt:${row.id}:${index+1}`,ownerCommand:false};
    }
  }
}
