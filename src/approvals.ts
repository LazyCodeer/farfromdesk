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
      this.store.output(binding,`${kind==='approval'?'Permission needed':'Answer needed'}\n${question}\n\n${kind==='approval'?`/approve ${code}\n/deny ${code}`:`/answer ${code} your answer`}\nExpires in 15 minutes.`, `permission:${code}`);
    });
  }
  answer(code:string,answer:string,kind:'approval'|'question') {
    const p=this.pending.get(code);if(!p || p.kind!==kind || Date.now()>p.expires)throw new Error('That request has expired, belongs to another action, or was already answered.');
    if(kind==='approval'&&!['approve','deny'].includes(answer))throw new Error('Choose approve or deny.');
    p.settle(answer);
  }
  cancel(bindingId?:string) {for(const p of this.pending.values())if(!bindingId||p.binding.id===bindingId)p.settle('deny');}
  view(){return [...this.pending.entries()].map(([code,p])=>({code,alias:p.binding.alias,question:p.question,kind:p.kind,expires:p.expires}));}
}
