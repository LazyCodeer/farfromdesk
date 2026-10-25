import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export type Provider = 'codex' | 'claude';
export type Binding = { id: string; alias: string; provider: Provider; native_id: string; cwd: string; enabled: number; mode: 'desktop' | 'channel'; token_hash: string; created_at: number };
export type Job = { id: string; binding_id: string; body: string; status: string; created_at: number; error: string | null; destination?:string|null; updated_at?:number };
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
    `);
    if(!this.db.prepare('PRAGMA table_info(inbox)').all().some((c:any)=>c.name==='updated_at')) {
      this.db.exec('ALTER TABLE inbox ADD COLUMN updated_at INTEGER');
      this.db.exec('UPDATE inbox SET updated_at=created_at WHERE updated_at IS NULL');
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
  destination(){return this.destinationContext.getStore()??this.get('destination-jid')??this.get('whatsapp-owner')??null;}
  enqueue(id: string, b: Binding, body: string, destination:string|null=this.destination()) {
    const existing=this.job(id);if(existing&&(existing.binding_id!==b.id||existing.body!==body))throw new Error('A delivery ID cannot be reused for different content or another session.');
    this.db.prepare("INSERT OR IGNORE INTO inbox(id,binding_id,body,status,created_at,error,destination) VALUES(?,?,?,'queued',?,NULL,?)").run(id,b.id,body,Date.now(),destination);
  }
  jobs() { return this.db.prepare('SELECT * FROM inbox ORDER BY created_at DESC LIMIT 100').all() as Job[]; }
  pendingJobs() { return this.db.prepare("SELECT id,binding_id,status,created_at,updated_at,error,substr(body,1,300) AS preview FROM inbox WHERE status IN ('queued','dispatched','submitted','uncertain','failed') ORDER BY created_at").all() as Omit<Job,'body'>[]; }
  job(id:string) { return this.db.prepare('SELECT * FROM inbox WHERE id=?').get(id) as Job|undefined; }
  unfinished(id:string) { return this.db.prepare("SELECT * FROM inbox WHERE binding_id=? AND status IN ('queued','dispatched','submitted') ORDER BY created_at").all(id) as Job[]; }
  hasDispatched(id:string) { return !!this.db.prepare("SELECT 1 FROM inbox WHERE binding_id=? AND status='dispatched'").get(id); }
  queued(id: string) { return this.db.prepare("SELECT * FROM inbox WHERE binding_id=? AND status='queued' ORDER BY created_at LIMIT 1").get(id) as Job | undefined; }
  jobState(id: string, status: string, error: string | null = null) { this.db.prepare('UPDATE inbox SET status=?,error=?,updated_at=? WHERE id=?').run(status,error,Date.now(),id); }
  recover() {
    this.db.prepare("UPDATE inbox SET status='uncertain',error='Bridge restarted during delivery. Check the native session before retrying.' WHERE status='dispatched'").run();
    this.interruptAudio('The bridge restarted while processing your voice note. Please resend it or type your message.');
  }
  interruptAudio(message:string) {
    for(const row of this.db.prepare("SELECT id,destination FROM audio_inbox WHERE status='processing'").all() as any[]) {
      if(!this.seen(row.id))this.output(undefined,message,`audio-error:${row.id}`,row.destination);
      this.remember(row.id);this.db.prepare("UPDATE audio_inbox SET status='interrupted' WHERE id=?").run(row.id);
    }
  }
  output(binding: Binding | undefined, text: string, source: string = randomUUID(), destination:string|null=this.destination()) {
    if (!text.trim()) return;
    // Stable message IDs are recorded before network I/O. Retries reuse them.
    const chunks = text.match(/[\s\S]{1,3500}/gu) ?? [];
    const insert = this.db.prepare('INSERT OR IGNORE INTO outbox(id,binding_id,body,source,wa_id,created_at,destination) VALUES(?,?,?,?,?,?,?)');
    const label=binding?(this.get(`name:${binding.id}`)??binding.alias).slice(0,90):'Session Bridge';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      chunks.forEach((chunk,i) => insert.run(randomUUID(), binding?.id ?? null, `[${label}]${chunks.length > 1 ? ` (${i+1}/${chunks.length})` : ''}\n${chunk}`, `${source}:${i}`, `3EB0${randomBytes(16).toString('hex').toUpperCase()}`, Date.now(),destination));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  outbound() { return this.db.prepare("SELECT * FROM outbox WHERE status='queued' AND next_at<=? AND (binding_id IS NULL OR binding_id IN (SELECT id FROM bindings WHERE enabled=1)) ORDER BY created_at LIMIT 1").get(Date.now()) as any; }
  sent(id: string) { this.db.prepare("UPDATE outbox SET status='sent',error=NULL WHERE id=?").run(id); }
  sendFailed(id: string, attempts: number, error: string) { this.db.prepare('UPDATE outbox SET attempts=?,next_at=?,error=? WHERE id=?').run(attempts,Date.now()+Math.min(300000,2000*2**Math.min(attempts,8)),error,id); }
  isOurs(waId: string) { return !!this.db.prepare('SELECT 1 FROM outbox WHERE wa_id=?').get(waId); }
  quotedBinding(waId: string) { const row=this.db.prepare('SELECT binding_id FROM outbox WHERE wa_id=?').get(waId) as any; return row?.binding_id ? this.binding(row.binding_id) : undefined; }
  audit(event: string, bindingId?: string, detail?: string) { this.db.prepare('INSERT INTO audit(at,event,binding_id,detail) VALUES(?,?,?,?)').run(Date.now(),event,bindingId??null,detail??null); }
  close() { this.db.close(); }
}
