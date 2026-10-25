import { randomBytes } from 'node:crypto';
import type { Binding } from './store.js';
import { Store } from './store.js';

export class Approvals {
  pending = new Map<string,{binding:Binding; question:string; kind:'approval'|'question'; expires:number; settle:(answer:string)=>void; timer:NodeJS.Timeout}>();
  constructor(private store:Store) {}
  ask(binding:Binding, question:string, kind:'approval'|'question'='approval'):Promise<string> {
    const code=randomBytes(4).toString('hex'), expires=Date.now()+15*60_000;
    return new Promise(resolve=>{
      const settle=(answer:string)=>{const p=this.pending.get(code);if(!p)return;clearTimeout(p.timer);this.pending.delete(code);this.store.audit('permission-answer',binding.id,`${code}:${kind==='approval'?answer:'answered'}`);resolve(answer);};
      const timer=setTimeout(()=>settle('deny'),15*60_000);
      this.pending.set(code,{binding,question,kind,expires,settle,timer});
      this.store.output(binding,`${kind==='approval'?'Permission needed':'Answer needed'}\n${question}\n\n${kind==='approval'?'Reply to this message with “Yes, allow it” or “No, deny it”.':'Reply to this message with your answer.'}\nExpires in 15 minutes.`, `permission:${code}`);
    });
  }
  answer(code:string,answer:string,kind:'approval'|'question') {
    const p=this.pending.get(code);if(!p || p.kind!==kind || Date.now()>p.expires)throw new Error('That request has expired, belongs to another action, or was already answered.');
    if(kind==='approval'&&!['approve','deny'].includes(answer))throw new Error('Choose approve or deny.');
    p.settle(answer);
  }
  naturalReply(text:string,quotedId?:string,source:'text'|'voice'='text') {
    const decision=/^(?:yes(?:[, ]+allow it)?|allow it|approve(?: it)?|yes[, ]+go ahead)[.!]?$/i.test(text.trim())?'approve':/^(?:no(?:[, ]+(?:deny|don['’]t allow) it)?|deny(?: it)?|don['’]t allow it)[.!]?$/i.test(text.trim())?'deny':undefined;
    const quoted=quotedId?this.store.db.prepare('SELECT source,status FROM outbox WHERE wa_id=?').get(quotedId) as {source:string;status:string}|undefined:undefined;
    const code=quoted?.source.match(/^permission:([a-f0-9]{8}):\d+$/)?.[1];
    let pending=code?this.pending.get(code):undefined,selected=code;
    if(code&&!pending)throw new Error('That permission or question has expired or was already answered. Ask me to continue if you still need it.');
    if(!code&&(!decision||!this.pending.size))return;
    if(!code&&/^(yes|no)[.!]?$/i.test(text.trim()))return;
    if(!code&&quotedId)return; // A reply to ordinary work must never answer a different permission.
    if(!code){
      const approvals=[...this.pending.entries()].filter(([,p])=>p.kind==='approval'&&Date.now()<=p.expires);
      if(approvals.length!==1||this.pending.size!==1)throw new Error('Please reply to the specific permission message with “Yes, allow it” or “No, deny it”, so I know which action you mean.');
      [selected,pending]=approvals[0];
      const sent=this.store.db.prepare("SELECT 1 FROM outbox WHERE source LIKE ? AND status='sent'").get(`permission:${selected}:%`);
      if(!sent)throw new Error('Wait for the permission message, then reply to it with your decision.');
    }
    if(!pending||!selected)return;
    if(quoted&&quoted.status!=='sent')throw new Error('Wait for the permission message, then reply to it with your decision.');
    if(!this.store.binding(pending.binding.id)?.enabled)throw new Error('That session is paused. Resume it in the app before answering.');
    if(source==='voice')throw new Error('Please type your permission decision or answer; voice transcription may mishear it.');
    if(pending.kind==='approval'&&!decision)throw new Error('Reply “Yes, allow it” or “No, deny it” to this permission message.');
    this.answer(selected,pending.kind==='approval'?decision!:text.trim(),pending.kind);
    return {binding:pending.binding,message:pending.kind==='question'?'Your answer was sent.':decision==='approve'?'Allowed. I’ve sent your decision to the session.':'Denied. That action was not approved.'};
  }
  cancel(bindingId?:string) {for(const p of this.pending.values())if(!bindingId||p.binding.id===bindingId)p.settle('deny');}
  view(){return [...this.pending.entries()].map(([code,p])=>({code,alias:p.binding.alias,question:p.question,kind:p.kind,expires:p.expires}));}
}
