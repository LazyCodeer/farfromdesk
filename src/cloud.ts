// FarFromDesk Pro cloud: while the laptop sleeps the cloud answers the same Telegram bot,
// queues work that needs this computer and hands it back here when the laptop wakes.
import { hostname } from 'node:os';
export type IceServer={urls:string[];username?:string;credential?:string};
import type { Store } from './store.js';
import type { Telegram } from './telegram.js';
import { memoryHashes,mergeMemory,readMemory,writeMemory,type MemFiles } from './memory-sync.js';
import { openWith,sealWith,apply as applyBackup,bundleHash,collect,isRecoveryCode,newKeys,recoveryProof,seal,unseal,type Keys } from './settings-backup.js';

export const CLOUD_URL=(process.env.FFD_CLOUD_URL??'https://cloud.farfromdesk.com').replace(/\/+$/,'');
type Status={fired?:string[];plan?:string;credits?:{messages?:number};mode?:string;queue?:{id:string;at:number;text:string;messageId:number}[];checkoutUrl?:string;holder?:boolean;laptops?:{name:string;awake:boolean;holder:boolean;me?:boolean}[]};

export class Cloud {
  private beating?:Promise<void>; private acked:string[]=[]; private sentMemory?:string; private pro=false;
  private sentReminders?:string; private fired=new Set<string>(); private lastOk=0;
  /** Laptops on this bot, from the last heartbeat. */
  laptops:NonNullable<Status['laptops']>=[];
  /** Upcoming plain reminders, set by main. */
  reminders:()=>{id:string;at:number;text:string}[]=()=>[];
  /** The private state folder that settings backups read and restore. Set by main. */
  backupRoot?:string; private backupChecked=0;
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
    const r=await this.post('/v1/accounts',{...who,name:this.store.get('laptop-name')??hostname().replace(/\.local$/,'')});
    if(r.status!==200||typeof r.body.accountId!=='string'||typeof r.body.deviceKey!=='string')throw new Error(r.body.error??`cloud ${r.status}`);
    this.store.set('cloud-account',r.body.accountId);this.store.set('cloud-key',r.body.deviceKey);this.sentMemory=undefined;
  }
  private apply(s:Status) {this.pro=s.plan==='pro';this.telegram.paused=s.mode==='cloud'||s.holder===false;if(Array.isArray(s.laptops))this.laptops=s.laptops;if(Array.isArray(s.fired))this.fired=new Set(s.fired);}

  backupView(){const on=!!this.keys();return {enabled:on,lastBackupAt:Number(this.store.get('backup-at'))||undefined,needsPro:on&&this.lastOk>0&&!this.pro,authenticator:on&&this.store.get('backup-totp')==='on'};}
  private keys():Keys|undefined{try{const k=JSON.parse(this.store.get('backup-keys')||'null');return k?.key?k:undefined;}catch{return undefined;}}
  private keep(keys:Keys,proof=''){this.store.set('backup-keys',JSON.stringify(keys));if(proof)this.store.set('backup-proof',proof);this.store.set('backup-hash','');this.backupChecked=0;}
  /** Start backing up this computer's settings. Returns the recovery code once; it is never stored here. */
  enableBackup(passphrase:unknown){
    if(typeof passphrase!=='string'||passphrase.length<8)throw new Error('Use a passphrase of at least 8 characters.');
    const {recoveryCode,proof,...keys}=newKeys(passphrase);
    this.keep(keys,proof);this.store.set('backup-totp','');
    void this.beat();
    return {...this.backupView(),recoveryCode};
  }
  disableBackup(){for(const k of ['backup-keys','backup-proof','backup-hash','backup-totp'])this.store.set(k,'');return this.backupView();}
  /** Bring back the settings saved from another computer on the same bot, with the passphrase or the recovery code. */
  async restoreBackup(secret:unknown,code?:unknown){
    if(typeof secret!=='string'||!secret)throw new Error('Enter your backup passphrase or recovery code.');
    if(!this.backupRoot)throw new Error('Settings backup is not available here.');
    const ask={...(typeof code==='string'&&code.trim()?{code:code.trim()}:{}),...(isRecoveryCode(secret)?{recoveryProof:recoveryProof(secret)}:{})};
    const r=await this.authed('/v1/backup/get',ask);
    if(r.status===404)throw new Error('There is no settings backup for this Telegram bot yet.');
    if(r.status===403&&r.body.needs==='authenticator')throw Object.assign(new Error(r.body.error),{needsAuthenticator:true});
    if(r.status!==200||typeof r.body.blob!=='string')throw new Error(r.body.error??`cloud ${r.status}`);
    let opened;
    try{opened=unseal(r.body.blob,secret);}catch{throw new Error("That passphrase or recovery code doesn't open this backup.");}
    applyBackup(this.store,this.backupRoot,opened.bundle);
    // Keep backing up with the same keys from this computer. The proof is only known when the code was typed.
    this.keep(opened.keys,isRecoveryCode(secret)?recoveryProof(secret):'');
    this.store.set('backup-totp',typeof code==='string'&&code.trim()?'on':'');
    return this.backupView();
  }
  /** Posts with this computer's key, registering first or again when another computer took the bot over. */
  private async authed(path:string,body:object){
    if(!this.auth())await this.register();
    const r=await this.post(path,body,this.auth());
    if(r.status!==401)return r;
    await this.register();return this.post(path,body,this.auth());
  }
  /** Optional second lock: the cloud hands the sealed backup only to someone with this authenticator. */
  async authenticator(action:unknown,code?:unknown){
    if(action!=='setup'&&action!=='confirm'&&action!=='off')throw new Error('Choose setup, confirm or off.');
    if(!this.keys())throw new Error('Turn on settings backup first.');
    const r=await this.authed('/v1/backup/authenticator',{action,code});
    if(r.status===402)throw new Error('The authenticator lock is part of FarFromDesk Pro.');
    if(r.status!==200)throw new Error(r.body.error??`cloud ${r.status}`);
    if(action==='setup')return {secret:r.body.secret as string,uri:r.body.uri as string};
    this.store.set('backup-totp',action==='confirm'?'on':'');
    return this.backupView();
  }
  private async backupIfChanged(auth:string){
    const keys=this.keys();
    if(!this.pro||!keys||!this.backupRoot||Date.now()-this.backupChecked<5*60_000)return;
    this.backupChecked=Date.now();
    const bundle=collect(this.store,this.backupRoot),hash=bundleHash(bundle);
    if(hash===this.store.get('backup-hash'))return;
    const r=await this.post('/v1/backup',{blob:seal(bundle,keys),...(this.store.get('backup-proof')?{recoveryProof:this.store.get('backup-proof')}:{})},auth);
    if(r.status===200){this.store.set('backup-hash',hash);this.store.set('backup-at',String(r.body.at??Date.now()));}
  }

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

  private memorySynced=0;
  /** With 2+ laptops on Pro and settings backup on, memory files are merged through the cloud, sealed with the backup key. */
  async syncMemory(force=false) {
    const keys=this.keys(),root=this.backupRoot;
    if(!keys||!root||!this.pro||this.laptops.length<2||(!force&&Date.now()-this.memorySynced<60_000))return;
    this.memorySynced=Date.now();
    const base=JSON.parse(this.store.get('memory-sync-base')||'{"rev":0,"files":{}}') as {rev:number;files:Record<string,string>};
    const local=readMemory(root),localHash=JSON.stringify(memoryHashes(local));
    let r=await this.authed('/v1/memory/get',{});
    for(let i=0;i<3&&r.status===200;i++){
      const rev=Number(r.body.rev)||0;
      if(rev===base.rev&&localHash===JSON.stringify(base.files))return;
      const remote=(r.body.blob?openWith(r.body.blob,keys):{}) as MemFiles;
      const merged=mergeMemory(rev===0?{}:base.files,local,remote);
      const put=JSON.stringify(memoryHashes(merged))===JSON.stringify(memoryHashes(remote))?{status:200,body:{rev}}:await this.authed('/v1/memory/put',{base:rev,blob:sealWith(merged,keys)});
      if(put.status===409){r={status:200,body:put.body};continue;}
      if(put.status!==200)return;
      writeMemory(root,local,merged);
      this.store.set('memory-sync-base',JSON.stringify({rev:Number(put.body.rev)||rev,files:memoryHashes(merged)}));
      return;
    }
  }

  private turn?:{servers:IceServer[];until:number};
  /** Pro: short-lived Cloudflare TURN logins so the screen viewer works when a direct connection can't. Never throws. */
  async relay():Promise<IceServer[]> {
    if(!this.pro)return [];
    if(this.turn&&Date.now()<this.turn.until)return this.turn.servers;
    try{
      const r=await this.authed('/v1/turn',{});
      if(r.status!==200||!Array.isArray(r.body.iceServers))return [];
      this.turn={servers:r.body.iceServers,until:Date.now()+Math.max(0,(Number(r.body.ttl)||0)-600)*1000};
      return this.turn.servers;
    }catch{return [];}
  }

  /** /laptops: which laptops share this bot and which one answers. */
  laptopList():string {
    if(this.laptops.length<2)return 'Only this laptop is connected. Install FarFromDesk on another laptop with the same Telegram bot to add it (needs Pro).';
    return 'Your laptops:\n'+this.laptops.map(l=>`- ${l.name}${l.me?' (this one)':''}: ${l.holder?'answering':l.awake?'awake':'asleep'}`).join('\n')+'\nSend /on <name> <message> to pick one.';
  }

  /** /on <name> <text>: send a message to another laptop through the cloud. */
  async forward(name:string,text:string,messageId:number):Promise<string> {
    try {
      const r=await this.authed('/v1/forward',{to:name,text,messageId});
      if(r.status===404)return `No laptop called "${name}". Yours: ${(r.body.laptops??[]).map((l:any)=>l.name).join(', ')||'none'}.`;
      if(r.status===429)return "That laptop's queue is full.";
      if(r.status!==200)throw new Error(r.body.error??`cloud ${r.status}`);
      return r.body.awake?`Sent to ${r.body.name}.`:`${r.body.name} is asleep. It gets this when it wakes.`;
    }catch(e){return `The cloud could not be reached (${e instanceof Error?e.message:'unknown error'}).`;}
  }

  /** Every 30s once registered: keeps the cloud from taking over, picks up work saved while asleep. */
  beat(force=true):Promise<void> {
    // Main calls every 10s; with one laptop every 30s is enough.
    if(!force&&this.laptops.length<2&&Date.now()-this.lastOk<25_000)return Promise.resolve();
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
      // This laptop was dropped from the account (pruned or replaced): join again.
      if(r.status===401){await this.register();return;}
      if(r.status!==200)return;
      if(body.memory!==undefined)this.sentMemory=body.memory;
      if(body.reminders!==undefined)this.sentReminders=remJson;
      this.lastOk=Date.now();
      this.acked=this.acked.filter(id=>!body.ack.includes(id));
      this.apply(r.body);
      await this.backupIfChanged(auth).catch(()=>{});
      await this.syncMemory().catch(()=>{});
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
