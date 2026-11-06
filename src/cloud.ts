// FarFromDesk Pro cloud: while the laptop sleeps the cloud answers the same Telegram bot,
// queues work that needs this computer and hands it back here when the laptop wakes.
import type { Store } from './store.js';
import type { Telegram } from './telegram.js';

export const CLOUD_URL=(process.env.FFD_CLOUD_URL??'https://cloud.farfromdesk.com').replace(/\/+$/,'');
type Status={fired?:string[];plan?:string;credits?:{messages?:number};mode?:string;queue?:{id:string;at:number;text:string;messageId:number}[];checkoutUrl?:string};

export class Cloud {
  private beating?:Promise<void>; private acked:string[]=[]; private sentMemory?:string; private pro=false;
  private sentReminders?:string; private fired=new Set<string>(); private lastOk=0;
  /** Upcoming plain reminders, set by main. */
  reminders:()=>{id:string;at:number;text:string}[]=()=>[];
  constructor(private store:Store,private telegram:Telegram,private memory:()=>string,private base=CLOUD_URL,private fetcher:typeof fetch=fetch) {}
  get registered(){return !!this.auth();}
  private auth(){const id=this.store.get('cloud-account'),key=this.store.get('cloud-key');return id&&key?`Bearer ${id}.${key}`:undefined;}
  private async post(path:string,body:unknown,auth?:string):Promise<{status:number;body:any}> {
    const r=await this.fetcher(this.base+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:auth}:{})},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15_000)});
    return {status:r.status,body:await r.json().catch(()=>({}))};
  }
  private async register() {
    const who=this.telegram.cloudIdentity();
    if(!who)throw new Error('connect Telegram first');
    const r=await this.post('/v1/accounts',who);
    if(r.status!==200||typeof r.body.accountId!=='string'||typeof r.body.deviceKey!=='string')throw new Error(r.body.error??`cloud ${r.status}`);
    this.store.set('cloud-account',r.body.accountId);this.store.set('cloud-key',r.body.deviceKey);this.sentMemory=undefined;
  }
  private apply(s:Status) {this.pro=s.plan==='pro';this.telegram.paused=s.mode==='cloud';if(Array.isArray(s.fired))this.fired=new Set(s.fired);}

  /** Should this laptop send a due plain reminder? The cloud sends them while it holds the bot. */
  reminder(occurrence:string,dueAt:number,now=Date.now()):'send'|'hold'|'fired' {
    if(this.fired.has(occurrence))return 'fired';
    if(!this.auth()||(!this.pro&&this.lastOk))return 'send';
    // Unsure who holds the bot (cloud mode, or no fresh heartbeat since waking): wait, but never past 10 minutes late.
    const unsure=this.telegram.paused||now-this.lastOk>90_000;
    return unsure&&now-dueAt<600_000?'hold':'send';
  }

  /** The owner sent /cloud (on) or /laptop (off) to this laptop. Returns the reply. */
  async command(on:boolean):Promise<string> {
    try {
      if(!this.auth()){if(!on)return 'Already answering from this laptop.';await this.register();}
      let r=await this.post('/v1/cloud',{on},this.auth());
      if(r.status===401){await this.register();r=await this.post('/v1/cloud',{on},this.auth());}
      if(r.status===402)return `Answering from the cloud needs FarFromDesk Pro ($10/month). It keeps your bot answering while your laptop sleeps.\n${r.body.checkoutUrl??'https://farfromdesk.com/#pricing'}`;
      if(r.status!==200)throw new Error(r.body.error??`cloud ${r.status}`);
      this.apply(r.body);
      if(on)void this.beat();
      return on?`Answering from the cloud now. ${r.body.credits?.messages??0} brain messages left this month. Send /laptop to switch back.`:'Answering from this laptop again.';
    }catch(e){return `The cloud could not be reached (${e instanceof Error?e.message:'unknown error'}). This laptop keeps answering.`;}
  }

  /** Every 30s once registered: keeps the cloud from taking over, picks up work saved while asleep. */
  beat():Promise<void> {
    // One heartbeat at a time; a caller during one waits for it.
    if(!this.beating)this.beating=this.beatOnce().finally(()=>{this.beating=undefined;});
    return this.beating;
  }
  private async beatOnce() {
    const auth=this.auth();if(!auth)return;
    try {
      const body:{ack:string[];memory?:string;reminders?:unknown[]}={ack:this.acked};
      // Memory only goes to the cloud for Pro, and only when it changed.
      const mem=this.pro?this.memory():undefined;
      if(mem!==undefined&&mem!==this.sentMemory)body.memory=mem;
      const rem=this.pro?this.reminders():undefined,remJson=rem&&JSON.stringify(rem);
      if(rem&&remJson!==this.sentReminders)body.reminders=rem;
      const r=await this.post('/v1/heartbeat',body,auth);
      if(r.status!==200)return;
      if(body.memory!==undefined)this.sentMemory=body.memory;
      if(body.reminders!==undefined)this.sentReminders=remJson;
      this.lastOk=Date.now();
      this.acked=this.acked.filter(id=>!body.ack.includes(id));
      this.apply(r.body);
      // Replay saved requests as the original Telegram messages, so dedup still holds. Acked on the next beat.
      if(this.telegram.closed)return;
      for(const q of r.body.queue??[]){
        if(this.acked.includes(q.id))continue;
        await this.telegram.replay(q).catch(()=>{});
        this.acked.push(q.id);
      }
    }catch{}
  }
}
