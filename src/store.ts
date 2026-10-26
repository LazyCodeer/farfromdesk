import { cancelObsoleteCoordinatorUpdates } from './coordinator-updates.js';
import { toWhatsApp } from './whatsapp-format.js';
import { formatWhatsAppMessage } from './coordinator-experience.js';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { safeEventDetails, errorCode, type ReplyContext, type RequestOutcome, type VoiceStageEvent } from './request-events.js';

const buildSource=(()=>{try{return JSON.parse(readFileSync(new URL('../build.json',import.meta.url),'utf8')).sourceCommit??null;}catch{return null;}})();

export type Provider = 'codex' | 'claude';
export type Binding = { id: string; alias: string; provider: Provider; native_id: string; cwd: string; enabled: number; mode: 'desktop' | 'channel'; token_hash: string; created_at: number };
export type Job = { id: string; binding_id: string; body: string; status: string; created_at: number; error: string | null; destination?:string|null; updated_at?:number; outcome?:RequestOutcome|null; received_at?:number|null; submitted_at?:number|null; first_reply_at?:number|null; final_reply_at?:number|null; last_error?:string|null; last_error_at?:number|null; attempt_id?:string|null };
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export class Store {
  db: DatabaseSync;
  destinationContext=new AsyncLocalStorage<string>();
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS bindings(id TEXT PRIMARY KEY, alias TEXT UNIQUE NOT NULL, provider TEXT NOT NULL, native_id TEXT NOT NULL, cwd TEXT NOT NULL, mode TEXT NOT NULL, token_hash TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, UNIQUE(provider,native_id));
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,binding_id TEXT NOT NULL REFERENCES bindings(id),body TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS seen(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,binding_id TEXT REFERENCES bindings(id),body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',source TEXT UNIQUE NOT NULL,wa_id TEXT UNIQUE NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,event TEXT NOT NULL,binding_id TEXT,detail TEXT);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,binding_id TEXT NOT NULL REFERENCES bindings(id),request_id TEXT NOT NULL REFERENCES inbox(id),filename TEXT NOT NULL,mime TEXT NOT NULL,sha256 TEXT NOT NULL,data BLOB NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audio_inbox(id TEXT PRIMARY KEY,destination TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS request_events(id INTEGER PRIMARY KEY,request_id TEXT NOT NULL,binding_id TEXT,event TEXT NOT NULL,at INTEGER NOT NULL,attempt_id TEXT,turn_id TEXT,source_commit TEXT,details TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS request_events_request ON request_events(request_id,id);
      CREATE TABLE IF NOT EXISTS reply_receipts(source TEXT PRIMARY KEY,request_id TEXT,binding_id TEXT,kind TEXT,origin TEXT,turn_id TEXT,text_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS reply_receipts_turn ON reply_receipts(binding_id,request_id,turn_id);
      CREATE TABLE IF NOT EXISTS hook_updates(id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,turn_id TEXT,at INTEGER NOT NULL,text TEXT NOT NULL);
    `);
    if(!this.db.prepare('PRAGMA table_info(inbox)').all().some((c:any)=>c.name==='updated_at')) {
      this.db.exec('ALTER TABLE inbox ADD COLUMN updated_at INTEGER');
      this.db.exec('UPDATE inbox SET updated_at=created_at WHERE updated_at IS NULL');
    }
    // Old records retain unknown stage timestamps. Never invent historical completions.
    for(const [table,columns] of Object.entries({inbox:{outcome:'TEXT',received_at:'INTEGER',submitted_at:'INTEGER',first_reply_at:'INTEGER',final_reply_at:'INTEGER',last_error:'TEXT',last_error_at:'INTEGER',attempt_id:'TEXT'},outbox:{request_id:'TEXT',reply_kind:'TEXT',turn_id:'TEXT',sent_at:'INTEGER',delivered_at:'INTEGER',read_at:'INTEGER'}})) {
      for(const [column,type] of Object.entries(columns))if(!this.db.prepare(`PRAGMA table_info(${table})`).all().some((c:any)=>c.name===column))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    for(const column of ['artifact_id','wa_message'])if(!this.db.prepare('PRAGMA table_info(outbox)').all().some((c:any)=>c.name===column))this.db.exec(`ALTER TABLE outbox ADD COLUMN ${column} TEXT`);
    if(!this.db.prepare('PRAGMA table_info(artifacts)').all().some((c:any)=>c.name==='destination'))this.db.exec('ALTER TABLE artifacts ADD COLUMN destination TEXT');
    for(const table of ['inbox','outbox']) {
      if(!this.db.prepare(`PRAGMA table_info(${table})`).all().some((c:any)=>c.name==='destination'))this.db.exec(`ALTER TABLE ${table} ADD COLUMN destination TEXT`);
      this.db.prepare(`UPDATE ${table} SET destination=? WHERE destination IS NULL`).run(this.get('whatsapp-owner')??null);
    }
  }
  get(key: string) { return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as any)?.value as string | undefined; }
  set(key: string, value: string) { this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  bindings() { return this.db.prepare('SELECT * FROM bindings ORDER BY created_at').all() as Binding[]; }
  binding(id: string) { return this.db.prepare('SELECT * FROM bindings WHERE id=? OR alias=?').get(id, id) as Binding | undefined; }
  register(alias: string, provider: Provider, nativeId: string, cwd: string, mode: Binding['mode'] = 'desktop') {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(alias)) throw new Error('Use a session name like codex-site or claude-api (40 characters maximum).');
    if (!/^[0-9a-f-]{36}$/i.test(nativeId)) throw new Error('An exact native session UUID is required.');
    const token = randomBytes(32).toString('hex'), id = randomUUID();
    this.db.prepare('INSERT INTO bindings(id,alias,provider,native_id,cwd,mode,token_hash,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, alias, provider, nativeId, cwd, mode, hash(token), Date.now());
    this.audit('registered', id, `${provider}:${nativeId}`);
    return { binding: this.binding(id)!, token };
  }
  authBinding(id: string, token: string) { const b = this.binding(id); return b?.enabled && b.token_hash === hash(token) ? b : undefined; }
  enable(id: string, enabled: boolean) { this.db.prepare('UPDATE bindings SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id); }
  seen(id: string) { return !!this.db.prepare('SELECT 1 FROM seen WHERE id=?').get(id); }
  remember(id: string) { this.db.prepare('INSERT OR IGNORE INTO seen VALUES(?,?)').run(id, Date.now()); }
  controlChannel(){return this.get('control-channel')==='telegram'?'telegram':'whatsapp';}
  ownerFor(destination?:string|null) {
    if(destination?.startsWith('tg:'))return destination===this.get('telegram-owner')?destination:undefined;
    return this.get('whatsapp-owner');
  }
  destination(){return this.destinationContext.getStore()??(this.controlChannel()==='telegram'?this.get('telegram-owner')??'tg:unpaired':this.get('destination-jid')??this.get('whatsapp-owner'))??null;}
  enqueue(id: string, b: Binding, body: string, destination:string|null=this.destination()) {
    const existing=this.job(id);if(existing&&(existing.binding_id!==b.id||existing.body!==body))throw new Error('A delivery ID cannot be reused for different content or another session.');
    const now=Date.now();
    const result=this.db.prepare("INSERT OR IGNORE INTO inbox(id,binding_id,body,status,created_at,error,destination,updated_at,received_at) VALUES(?,?,?,'queued',?,NULL,?,?,?)").run(id,b.id,body,now,destination,now,now);
    if(result.changes)this.event(id,'queued');
  }
  jobs() { return this.db.prepare('SELECT * FROM inbox ORDER BY created_at DESC LIMIT 100').all() as Job[]; }
  pendingJobs() { return this.db.prepare("SELECT id,binding_id,status,created_at,updated_at,error,outcome,received_at,submitted_at,first_reply_at,final_reply_at,last_error,last_error_at,attempt_id,substr(body,1,300) AS preview FROM inbox WHERE status IN ('queued','dispatched','submitted','uncertain','failed') ORDER BY created_at").all() as Omit<Job,'body'>[]; }
  job(id:string) { return this.db.prepare('SELECT * FROM inbox WHERE id=?').get(id) as Job|undefined; }
  unfinished(id:string) { return this.db.prepare("SELECT * FROM inbox WHERE binding_id=? AND status IN ('queued','dispatched','submitted') ORDER BY created_at").all(id) as Job[]; }
  hasDispatched(id:string) { return !!this.db.prepare("SELECT 1 FROM inbox WHERE binding_id=? AND status='dispatched'").get(id); }
  queued(id: string) { return this.db.prepare("SELECT * FROM inbox WHERE binding_id=? AND status='queued' ORDER BY created_at LIMIT 1").get(id) as Job | undefined; }
  jobState(id: string, status: string, error: string | null = null, outcome?:RequestOutcome) {
    const prior=this.job(id);if(!prior)return;
    const now=Date.now(),attempt=status==='dispatched'?randomUUID():prior.attempt_id??null;
    const resultOutcome=outcome??(['reviewed','auto_closed'].includes(status)?'reviewed':status==='replaced'?'cancelled':null);
    this.db.prepare('UPDATE inbox SET status=?,error=?,updated_at=?,attempt_id=?,outcome=COALESCE(?,outcome),last_error=CASE WHEN ? IS NOT NULL THEN ? ELSE last_error END,last_error_at=CASE WHEN ? IS NOT NULL THEN ? ELSE last_error_at END,submitted_at=CASE WHEN ?=\'submitted\' THEN COALESCE(submitted_at,?) ELSE submitted_at END WHERE id=?').run(status,error,now,attempt,resultOutcome,error,error,error,now,status,now,id);
    if(prior.status!==status||prior.error!==error)this.event(id,status,{...(error?{code:errorCode(error)}:{}),...(resultOutcome?{outcome:resultOutcome}:{})});
  }
  event(requestId:string,event:string,details:Record<string,unknown>={},turnId?:string) {
    if(!requestId||requestId.length>1000||!/^[a-z][a-z0-9_-]{0,50}$/.test(event))throw new Error('Invalid request event');
    if(turnId!==undefined&&(typeof turnId!=='string'||turnId.length>200||/[\x00-\x1f]/.test(turnId)))throw new Error('Invalid turn identity');
    const job=this.job(requestId);
    this.db.prepare('INSERT INTO request_events(request_id,binding_id,event,at,attempt_id,turn_id,source_commit,details) VALUES(?,?,?,?,?,?,?,?)').run(requestId,job?.binding_id??null,event,Date.now(),job?.attempt_id??null,turnId??null,buildSource,JSON.stringify(safeEventDetails(details)));
  }
  events(requestId:string) {return this.db.prepare('SELECT event,at,attempt_id,turn_id,source_commit,details FROM request_events WHERE request_id=? ORDER BY id LIMIT 1000').all(requestId);}
  deliveries(requestId:string){return this.db.prepare('SELECT status,reply_kind,turn_id,attempts,created_at,sent_at,delivered_at,read_at FROM outbox WHERE request_id=? ORDER BY created_at LIMIT 100').all(requestId);}
  voiceRequests(){return this.db.prepare('SELECT id,status,created_at FROM audio_inbox ORDER BY created_at DESC LIMIT 50').all();}
  voiceEvent(requestId:string,event:VoiceStageEvent) {this.event(requestId,`voice_${event.stage}_${event.state}`,event);}
  hookRequest(bindingId:string,turnId:string) {
    const rows=this.db.prepare('SELECT DISTINCT request_id FROM (SELECT request_id FROM reply_receipts WHERE binding_id=? AND turn_id=? AND request_id IS NOT NULL UNION SELECT request_id FROM request_events WHERE binding_id=? AND turn_id=?)').all(bindingId,turnId,bindingId,turnId) as any[];
    return rows.length===1?rows[0].request_id as string:undefined;
  }
  holdHook(id:string,bindingId:string,text:string,turnId?:string) {
    if(text.length>64000)throw new Error('Native update exceeds local review limit');
    this.db.prepare('INSERT OR IGNORE INTO hook_updates VALUES(?,?,?,?,?)').run(id,bindingId,turnId??null,Date.now(),text);
    this.db.prepare('DELETE FROM hook_updates WHERE at<? OR id NOT IN (SELECT id FROM hook_updates ORDER BY at DESC LIMIT 500)').run(Date.now()-7*86400000);
  }
  cleanupHooks(){this.db.prepare('DELETE FROM hook_updates WHERE at<?').run(Date.now()-7*86400000);}
  unlinkedHooks(){return this.db.prepare('SELECT id,binding_id,turn_id,at FROM hook_updates ORDER BY at DESC LIMIT 50').all();}
  hookUpdate(id:string){return this.db.prepare('SELECT text FROM hook_updates WHERE id=?').get(id);}
  recover() {
    this.db.prepare("UPDATE outbox SET status='uncertain',error='Telegram delivery was interrupted; check the bot before resending' WHERE status='sending' AND destination LIKE 'tg:%'").run();
    for(const row of this.db.prepare("SELECT id FROM inbox WHERE status='dispatched'").all() as any[])this.jobState(row.id,'uncertain','Bridge restarted during delivery. Check the native session before retrying.');
    this.interruptAudio('The bridge restarted while processing your voice note. Please resend it or type your message.');
  }
  interruptAudio(message:string) {
    for(const row of this.db.prepare("SELECT id,destination FROM audio_inbox WHERE status='processing'").all() as any[]) {
      if(!this.seen(row.id))this.output(undefined,message,`audio-error:${row.id}`,row.destination);
      this.remember(row.id);this.db.prepare("UPDATE audio_inbox SET status='interrupted' WHERE id=?").run(row.id);
    }
  }
  output(binding: Binding | undefined, text: string, source: string = randomUUID(), destination:string|null=this.destination(), context:ReplyContext={}) {
    if (!text.trim()) return;
    const request=context.requestId?this.job(context.requestId):undefined;
    if(context.requestId&&(!request||(binding&&request.binding_id!==binding.id)))throw new Error('Reply request does not belong to this session');
    if(context.turnId!==undefined&&(typeof context.turnId!=='string'||context.turnId.length>200||/[\x00-\x1f]/.test(context.turnId)))throw new Error('Invalid turn identity');
    if(context.kind&&!['progress','final','hook','system'].includes(context.kind))throw new Error('Invalid reply kind');
    if(context.outcome&&!['done','blocked','reviewed','cancelled'].includes(context.outcome))throw new Error('Invalid reply outcome');
    const existing=this.db.prepare('SELECT * FROM reply_receipts WHERE source=?').get(source) as any;
    if(existing){if(existing.text_hash!==hash(text)||existing.binding_id!==(binding?.id??null)||existing.request_id!==(context.requestId??null)||existing.turn_id!==(context.turnId??null)||existing.kind!==(context.kind??null))throw new Error('Reply event identity was reused for different content or another request');return false;}
    if(this.db.prepare('SELECT 1 FROM outbox WHERE source=?').get(`${source}:0`))return false;
    if(context.origin==='hook'&&context.requestId&&context.turnId&&this.db.prepare("SELECT 1 FROM reply_receipts WHERE binding_id=? AND request_id=? AND turn_id=? AND origin='agent' AND kind='final'").get(binding?.id??null,context.requestId,context.turnId)) {
      this.event(context.requestId,'duplicate_hook_suppressed',{},context.turnId);return false;
    }
    if(context.origin==='agent'&&context.kind==='final'&&context.requestId&&context.turnId&&this.db.prepare("SELECT 1 FROM reply_receipts WHERE binding_id=? AND request_id=? AND turn_id=? AND origin='hook'").get(binding?.id??null,context.requestId,context.turnId)) {
      // A native final already queued for this exact turn. Retain explicit outcome
      // tracking without sending another copy, regardless of arrival order.
      this.db.exec('SAVEPOINT reply_output');
      try {
        const now=Date.now();
        this.db.prepare('INSERT INTO reply_receipts VALUES(?,?,?,?,?,?,?,?)').run(source,context.requestId,binding?.id??null,context.kind,context.origin,context.turnId,hash(text),now);
        this.db.prepare('UPDATE inbox SET first_reply_at=COALESCE(first_reply_at,?),final_reply_at=COALESCE(final_reply_at,?) WHERE id=?').run(now,now,context.requestId);
        this.event(context.requestId,'duplicate_agent_suppressed',{},context.turnId);
        this.db.exec('RELEASE reply_output');return false;
      }catch(e){this.db.exec('ROLLBACK TO reply_output; RELEASE reply_output');throw e;}
    }
    // Stable message IDs are recorded before network I/O. Retries reuse them.
    const formatted=toWhatsApp(text);
    const chunks:string[]=[];let chunk='';
    // Bound UTF-16 length too: emoji occupy two units in Telegram entity offsets.
    for(const character of formatted){if(chunk.length+character.length>3500){chunks.push(chunk);chunk='';}chunk+=character;}
    if(chunk)chunks.push(chunk);
    const insert = this.db.prepare('INSERT OR IGNORE INTO outbox(id,binding_id,body,source,wa_id,created_at,destination,request_id,reply_kind,turn_id) VALUES(?,?,?,?,?,?,?,?,?,?)');
    const label=binding?`${binding.provider==='claude'?'Claude':'Codex'} ${this.get(`execution-mode:${binding.id}`)==='desktop'?'Desktop':'CLI'} · ${this.get(`name:${binding.id}`)??binding.alias}`.slice(0,130):'';
    const coordinator=!!binding&&(binding.id===this.get('master')||this.get(`role-kind:${binding.id}`)==='master');
    this.db.exec('SAVEPOINT reply_output');
    try {
      const now=Date.now();
      chunks.forEach((chunk,i) => insert.run(randomUUID(), binding?.id ?? null, formatWhatsAppMessage(chunk,label,coordinator,i+1,chunks.length,context.kind), `${source}:${i}`, `3EB0${randomBytes(16).toString('hex').toUpperCase()}`, now,destination,context.requestId??null,context.kind??null,context.turnId??null));
      this.db.prepare('INSERT INTO reply_receipts VALUES(?,?,?,?,?,?,?,?)').run(source,context.requestId??null,binding?.id??null,context.kind??null,context.origin??null,context.turnId??null,hash(text),now);
      if(request){
        if(context.kind==='progress'||context.kind==='final')this.db.prepare('UPDATE inbox SET first_reply_at=COALESCE(first_reply_at,?),final_reply_at=CASE WHEN ?=\'final\' THEN COALESCE(final_reply_at,?) ELSE final_reply_at END WHERE id=?').run(now,context.kind,now,request.id);
        this.event(request.id,'reply_queued',context.outcome?{outcome:context.outcome}:{},context.turnId);
      }
      this.db.exec('RELEASE reply_output');
      return true;
    } catch (e) { this.db.exec('ROLLBACK TO reply_output; RELEASE reply_output'); throw e; }
  }
  outbound(channel:'whatsapp'|'telegram'='whatsapp') { cancelObsoleteCoordinatorUpdates(this);return this.db.prepare("SELECT * FROM outbox WHERE status='queued' AND next_at<=? AND (CASE WHEN destination LIKE 'tg:%' THEN 'telegram' ELSE 'whatsapp' END)=? AND (binding_id IS NULL OR binding_id IN (SELECT id FROM bindings WHERE enabled=1)) ORDER BY created_at LIMIT 1").get(Date.now(),channel) as any; }
  sent(id: string) { const row=this.db.prepare('SELECT request_id,sent_at FROM outbox WHERE id=?').get(id) as any;this.db.prepare("UPDATE outbox SET status='sent',error=NULL,sent_at=COALESCE(sent_at,?) WHERE id=?").run(Date.now(),id);if(row?.request_id&&!row.sent_at)this.event(row.request_id,'reply_sent'); }
  deliveryReceipt(waId:string,destination:string,kind:'delivered'|'read') {
    const row=this.db.prepare('SELECT id,request_id,delivered_at,read_at FROM outbox WHERE wa_id=? AND destination=?').get(waId,destination) as any;
    if(!row)return false;const now=Date.now();
    this.db.prepare('UPDATE outbox SET delivered_at=COALESCE(delivered_at,?),read_at=CASE WHEN ?=\'read\' THEN COALESCE(read_at,?) ELSE read_at END WHERE id=?').run(now,kind,now,row.id);
    if(row.request_id&&!(kind==='read'?row.read_at:row.delivered_at))this.event(row.request_id,kind==='read'?'reply_read':'reply_delivered');return true;
  }
  sendFailed(id: string, attempts: number, error: string) { const row=this.db.prepare('SELECT request_id FROM outbox WHERE id=?').get(id) as any;if(row?.request_id)this.event(row.request_id,'reply_send_failed',{code:errorCode(error)});this.db.prepare('UPDATE outbox SET attempts=?,next_at=?,error=? WHERE id=?').run(attempts,Date.now()+Math.min(300000,2000*2**Math.min(attempts,8)),error,id); }
  isOurs(waId: string) { return !!this.db.prepare('SELECT 1 FROM outbox WHERE wa_id=?').get(waId); }
  quotedBinding(waId: string) { const row=this.db.prepare('SELECT binding_id FROM outbox WHERE wa_id=?').get(waId) as any; return row?.binding_id ? this.binding(row.binding_id) : undefined; }
  audit(event: string, bindingId?: string, detail?: string) { this.db.prepare('INSERT INTO audit(at,event,binding_id,detail) VALUES(?,?,?,?)').run(Date.now(),event,bindingId??null,detail??null); }
  close() { this.db.close(); }
}
