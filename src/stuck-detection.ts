import {createHash,randomBytes} from 'node:crypto';
import {generateText} from 'ai';
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';
import {brainPolicy,META_ENDPOINT} from './meta-brain-config.js';
import {authenticatedOwner} from './owner-commands.js';
import {briefTargetIdentity} from './brief-dispatch-guard.js';
import type {Incoming,Router} from './router.js';
import type {Store} from './store.js';

type Kind='idle'|'approval'|'question'|'repeated-error';
type Signal={itemId:number;title:string;requestId:string;bindingId:string;identity:string;kind:Kind;incident:string};
type Alert={id:string;owner:string;destination:string;item_id:number;request_id:string;binding_id:string;identity:string;kind:Kind;incident:string;expires_at:number;state:string;outbox_id:string};
type Writer=(kinds:Kind[],key:string)=>Promise<string>;
const LIMIT=100,MAX_NOTICES_PER_TICK=3,IDLE_MS=10*60_000,OFFER_MS=10*60_000;
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const safeTitle=(v:string)=>v.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/[—–]/g,',').replace(/\s+/g,' ').trim().slice(0,100);
const openings=['A task needs your attention.','There is a task waiting for you.','One task may need your help.'];

/** Meta receives only fixed signal categories, never task text, identifiers or permission prompts. */
async function wonderOpening(kinds:Kind[],key:string):Promise<string> {
  const guarded:typeof fetch=async(url,init)=>{
    const response=await fetch(url,{...init,redirect:'error'});
    if(!response.ok||!response.body)throw new Error('Meta response unavailable.');
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel();throw new Error('Meta response too large.');}chunks.push(value);}
    return new Response(Buffer.concat(chunks),{status:response.status,headers:response.headers});
  };
  const meta=createOpenAICompatible({name:'meta',baseURL:META_ENDPOINT.replace(/\/chat\/completions$/,''),apiKey:key,
    fetch:guarded});
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Meta timeout'));},8000);});
    const call=generateText({model:meta('muse-wonder-1.0'),maxRetries:0,maxOutputTokens:128,abortSignal:controller.signal,
      providerOptions:{meta:{reasoningEffort:'low'}},system:'Select the most suitable one of the three exact openings. Return only 1, 2 or 3. Do not invent facts or instructions.',
      prompt:JSON.stringify({signalKinds:[...new Set(kinds)],choices:openings})});
    const result=await Promise.race([call,timeout]);
    const selected=Number(result.text.trim());return Number.isInteger(selected)&&selected>=1&&selected<=openings.length?openings[selected-1]:openings[0];
  }finally{if(timer)clearTimeout(timer);controller.abort();}
}

/** Initial coverage is deliberately restricted to the paired WhatsApp self-chat. */
export class StuckDetection {
  private ticking=false;
  constructor(private store:Store,private router:Router,private writer:Writer=wonderOpening,private clock=()=>Date.now()) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS stuck_alerts(
      id TEXT PRIMARY KEY,owner TEXT NOT NULL,destination TEXT NOT NULL,item_id INTEGER NOT NULL,request_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,identity TEXT NOT NULL,kind TEXT NOT NULL,incident TEXT NOT NULL,expires_at INTEGER NOT NULL,
      state TEXT NOT NULL,outbox_id TEXT NOT NULL UNIQUE,UNIQUE(owner,destination,item_id,kind,incident));`);
  }
  private context(owner:string,destination:string) {
    return !this.router.stopped&&this.store.controlChannel()==='whatsapp'&&!!owner&&destination===owner&&
      this.store.get('whatsapp-owner')===owner&&this.store.destination()===destination;
  }
  private identity(bindingId:string) {const b=this.store.binding(bindingId);if(b?.enabled)return briefTargetIdentity(this.store,bindingId);}
  private signal(itemId:number,owner:string,destination:string,now:number):Signal|undefined {
    if(!this.context(owner,destination))return;
    const item=this.store.db.prepare(`SELECT i.id,i.title,i.status FROM items i JOIN item_owner_origins o ON o.item_id=i.id
      WHERE i.id=? AND o.owner=? AND o.destination=? AND i.status<>'done'`).get(itemId,owner,destination) as {id:number;title:string;status:string}|undefined;
    if(!item)return;
    for(const [code,p] of this.router.approvals.pending) {
      if(!p.requestId||p.owner!==owner||p.destination!==destination||p.expires<=now||this.store.itemOf(p.requestId)!==itemId)continue;
      const job=this.store.job(p.requestId),origin=this.store.requestOwnerOrigin(p.requestId),identity=this.identity(p.binding.id);
      if(!job||job.binding_id!==p.binding.id||job.destination!==destination||!['dispatched','submitted'].includes(job.status)||!origin||origin.owner!==owner||origin.destination!==destination||!identity||p.targetIdentity!==identity)continue;
      const kind:Kind=p.kind==='approval'?'approval':'question';
      return {itemId,title:item.title,requestId:job.id,bindingId:job.binding_id,identity,kind,incident:digest([kind,job.id,code,p.expires,identity])};
    }
    // A newer completed child must not hide an older request still running.
    // Once no request is active, only the latest attempt may supply failures.
    const jobs=this.store.db.prepare(`SELECT j.* FROM inbox j JOIN item_requests r ON r.request_id=j.id
      WHERE r.item_id=? AND j.destination=? AND (j.status IN ('dispatched','submitted') OR j.id=(
        SELECT j2.id FROM inbox j2 JOIN item_requests r2 ON r2.request_id=j2.id WHERE r2.item_id=? AND j2.destination=? ORDER BY j2.created_at DESC,j2.rowid DESC LIMIT 1))
      ORDER BY CASE WHEN j.status IN ('dispatched','submitted') THEN 0 ELSE 1 END,COALESCE(j.updated_at,j.created_at),j.rowid LIMIT 100`).all(itemId,destination,itemId,destination) as {id:string;binding_id:string;status:string;updated_at:number|null;created_at:number;attempt_id:string|null}[];
    const found=jobs.map(job=>({job,origin:this.store.requestOwnerOrigin(job.id),identity:this.identity(job.binding_id)})).find(x=>x.origin?.owner===owner&&x.origin.destination===destination&&x.identity);
    if(!found?.identity)return;const {job,identity}=found;
    const errors=this.store.db.prepare(`SELECT id,event,details FROM request_events WHERE request_id=? AND event IN ('queued','dispatched','submitted','failed','uncertain','completed') ORDER BY id DESC LIMIT 2`).all(job.id) as {id:number;event:string;details:string}[];
    if(errors.length===2&&errors.every(e=>e.event==='failed'||e.event==='uncertain')) {
      let codes:string[]=[];try{codes=errors.map(e=>JSON.parse(e.details).code);}catch{}
      if(codes[0]&&codes[0]!=='unknown'&&codes[0]===codes[1])return {itemId,title:item.title,requestId:job.id,bindingId:job.binding_id,identity,kind:'repeated-error',incident:digest(['error',job.id,errors.map(e=>e.id),codes[0],identity])};
    }
    if(!['dispatched','submitted'].includes(job.status))return;
    const last=this.store.db.prepare('SELECT MAX(created_at) AS at FROM reply_receipts WHERE request_id=?').get(job.id) as {at:number|null};
    const progress=Math.max(job.created_at,job.updated_at??0,last.at??0);
    const configured=Number(this.store.get('stuck-idle-minutes')??10),threshold=Number.isInteger(configured)&&configured>=1&&configured<=1440?configured*60_000:IDLE_MS;
    if(now-progress<threshold)return;
    return {itemId,title:item.title,requestId:job.id,bindingId:job.binding_id,identity,kind:'idle',incident:digest(['idle',job.id,job.attempt_id,progress,identity])};
  }
  private message(signal:Signal,token:string,opening:string) {
    const reason:Record<Kind,string>={idle:'No recorded progress for the configured idle period.',approval:'A permission request is waiting for your decision.',question:'The session asked a question and is waiting for your answer.','repeated-error':'Two consecutive failures have the same recorded error category.'};
    return `${opening}\n#${signal.itemId} ${safeTitle(signal.title)}\n${reason[signal.kind]}\n\n1. To view your Mac, send control my screen.\n2. Reply to the original task or permission message.\n\nDismiss this notice with /stuck dismiss ${token}. It expires in 10 minutes.`;
  }
  /** A never-sent expired notice may be replaced; a sending, sent or uncertain one never is. */
  private rearmExpiredUnsent(owner:string,destination:string,signal:Signal,now:number) {
    const row=this.store.db.prepare(`SELECT a.id,a.expires_at,a.outbox_id,o.status,o.attempts,o.sent_at,o.wa_message,o.source
      FROM stuck_alerts a JOIN outbox o ON o.id=a.outbox_id WHERE a.owner=? AND a.destination=? AND a.item_id=? AND a.kind=? AND a.incident=?`).get(owner,destination,signal.itemId,signal.kind,signal.incident) as {id:string;expires_at:number;outbox_id:string;status:string;attempts:number;sent_at:number|null;wa_message:string|null;source:string}|undefined;
    if(!row||row.expires_at>now||!['queued','cancelled'].includes(row.status)||row.attempts!==0||row.sent_at||row.wa_message)return;
    this.store.db.exec('SAVEPOINT stuck_rearm');
    try{
      const removed=this.store.db.prepare("DELETE FROM outbox WHERE id=? AND status IN ('queued','cancelled') AND attempts=0 AND sent_at IS NULL AND wa_message IS NULL").run(row.outbox_id);
      if(removed.changes){this.store.db.prepare('DELETE FROM stuck_alerts WHERE id=?').run(row.id);this.store.db.prepare('DELETE FROM reply_receipts WHERE source=?').run(row.source.replace(/:0$/,''));}
      this.store.db.exec('RELEASE stuck_rearm');
    }catch(e){this.store.db.exec('ROLLBACK TO stuck_rearm; RELEASE stuck_rearm');throw e;}
  }
  /** Scans a rotating page so old or blocked tasks cannot permanently starve newer ones. */
  async tick():Promise<void> {
    if(this.ticking||this.router.stopped)return;
    const owner=this.store.get('whatsapp-owner'),destination=this.store.destination(),policy=brainPolicy(this.store);
    if(!owner||!destination||!this.context(owner,destination)||!policy.enabled||!policy.allowStatus)return;
    this.ticking=true;
    try {
      const cursorKey=`stuck-scan:${digest([owner,destination])}`,raw=Number(this.store.get(cursorKey)??0),cursor=Number.isSafeInteger(raw)&&raw>=0?raw:0;
      const rows=this.store.db.prepare(`SELECT i.id FROM items i JOIN item_owner_origins o ON o.item_id=i.id
        WHERE o.owner=? AND o.destination=? AND i.status<>'done' AND i.id>? ORDER BY i.id LIMIT ?`).all(owner,destination,cursor,LIMIT) as {id:number}[];
      const now=this.clock(),candidates:Signal[]=[];let examined=0;
      for(const row of rows){
        examined++;const signal=this.signal(row.id,owner,destination,now);if(!signal)continue;
        this.rearmExpiredUnsent(owner,destination,signal,now);
        const seen=this.store.db.prepare('SELECT 1 FROM stuck_alerts WHERE owner=? AND destination=? AND item_id=? AND kind=? AND incident=?').get(owner,destination,signal.itemId,signal.kind,signal.incident);
        if(!seen)candidates.push(signal);
        if(candidates.length>=MAX_NOTICES_PER_TICK)break;
      }
      const end=examined===rows.length&&rows.length<LIMIT;
      this.store.set(cursorKey,String(end?0:rows[examined-1]?.id??0));
      if(!candidates.length)return;
      const key=this.router.brain.secret.read();let opening=openings[0];
      if(key)try{const result=await this.writer(candidates.map(s=>s.kind),key);if(openings.includes(result))opening=result;}catch{}
      if(!this.context(owner,destination)||!brainPolicy(this.store).enabled||!brainPolicy(this.store).allowStatus||key&&this.router.brain.secret.read()!==key)return;
      for(const candidate of candidates){
        const fresh=this.signal(candidate.itemId,owner,destination,this.clock());
        if(!fresh||fresh.kind!==candidate.kind||fresh.incident!==candidate.incident)continue;
        const id=randomBytes(18).toString('base64url'),source=`stuck-alert:${digest([owner,destination,fresh.itemId,fresh.kind,fresh.incident])}`,expires=this.clock()+OFFER_MS;
        this.store.db.exec('SAVEPOINT stuck_enqueue');
        try {
          if(!this.context(owner,destination)){this.store.db.exec('RELEASE stuck_enqueue');break;}
          const queued=this.store.output(undefined,this.message(fresh,id,opening),source,destination,{kind:'system',origin:'system',plain:true});
          const out=this.store.db.prepare('SELECT id FROM outbox WHERE source=?').get(`${source}:0`) as {id:string}|undefined;
          if(!queued||!out)throw new Error('Stuck alert could not be queued.');
          this.store.db.prepare('INSERT INTO stuck_alerts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,owner,destination,fresh.itemId,fresh.requestId,fresh.bindingId,fresh.identity,fresh.kind,fresh.incident,expires,'open',out.id);
          this.store.db.exec('RELEASE stuck_enqueue');
        }catch(e){this.store.db.exec('ROLLBACK TO stuck_enqueue; RELEASE stuck_enqueue');throw e;}
      }
    }finally{this.ticking=false;}
  }
  /** Recheck the exact owner, live evidence and expiry before every network send. */
  deliveryState(row:{id:string;source:string;destination?:string|null},selfJid?:string):'ready'|'hold'|'invalid' {
    if(!row.source.startsWith('stuck-alert:'))return 'ready';
    const alert=this.store.db.prepare('SELECT * FROM stuck_alerts WHERE outbox_id=?').get(row.id) as Alert|undefined;
    if(!alert||row.destination!==alert.destination||row.source!==`stuck-alert:${digest([alert.owner,alert.destination,alert.item_id,alert.kind,alert.incident])}:0`||alert.state!=='open'||alert.expires_at<=this.clock()||!selfJid||selfJid!==alert.owner||this.store.get('whatsapp-owner')!==alert.owner)return 'invalid';
    if(this.store.controlChannel()!=='whatsapp'||this.store.destination()!==alert.destination||this.router.stopped||!brainPolicy(this.store).enabled||!brainPolicy(this.store).allowStatus)return 'hold';
    const fresh=this.signal(alert.item_id,alert.owner,alert.destination,this.clock());
    return fresh&&fresh.kind===alert.kind&&fresh.incident===alert.incident&&fresh.identity===alert.identity?'ready':'invalid';
  }
  /** Dismissals and idle-limit settings never approve or dispatch work. */
  dismiss(m:Incoming):string|undefined {
    const text=m.text.trim(),match=/^\/stuck\s+dismiss\s+([A-Za-z0-9_-]{24})$/i.exec(text),interval=/^\/stuck\s+interval\s+(\d{1,4})$/i.exec(text);if(!match&&!interval)return;
    if(m.quotedId||m.ownerCommand===false||m.source==='voice'||!authenticatedOwner(this.router,m))return 'Send this command as a new text message in your own WhatsApp chat.';
    const owner=this.store.get('whatsapp-owner'),destination=this.store.destination(),now=this.clock();
    if(!owner||!destination||!this.context(owner,destination))return 'This notice is unavailable in this chat.';
    if(interval){const minutes=Number(interval[1]);if(minutes<1||minutes>1440)return 'Choose an idle limit between 1 and 1440 minutes.';this.store.set('stuck-idle-minutes',String(minutes));return `Idle notices will use ${minutes} minutes. This does not change running work.`;}
    const alert=this.store.db.prepare(`SELECT a.* FROM stuck_alerts a JOIN outbox o ON o.id=a.outbox_id
      WHERE a.id=? AND a.owner=? AND a.destination=? AND o.status='sent'`).get(match![1],owner,destination) as Alert|undefined;
    if(!alert||alert.expires_at<=now)return 'This notice has expired or is unavailable.';
    if(alert.state!=='open')return 'This notice was already dismissed.';
    const changed=this.store.db.prepare("UPDATE stuck_alerts SET state='dismissed' WHERE id=? AND owner=? AND destination=? AND state='open' AND expires_at>?").run(alert.id,owner,destination,now);
    return changed.changes?'Notice dismissed. The task and its permissions were not changed.':'This notice has expired or is unavailable.';
  }
}
