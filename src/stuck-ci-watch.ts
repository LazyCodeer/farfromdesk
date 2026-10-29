import {createHash,randomUUID} from 'node:crypto';
import {authenticatedOwner} from './owner-commands.js';
import {brainPolicy} from './meta-brain-config.js';
import {briefTargetIdentity} from './brief-dispatch-guard.js';
import {discoverApprovedCiFailure,observeApprovedCiFailure,parseCiPullRequest,type ApprovedCiRun,type ApprovedCiWatch} from './stuck-ci-observer.js';
import type {Incoming,Router} from './router.js';
import type {Store} from './store.js';

type Watch={id:string;owner:string;destination:string;generation:string;item_id:number;request_id:string;binding_id:string;identity:string;item_identity:string;repository:string;pr_number:number;expires_at:number;last_checked:number};
type Alert={outbox_id:string;watch_id:string;incident:string;head_sha:string;check_run_id:number;check_name:string;completed_at:number;expires_at:number;boot_id:string};
type Row={id:string;source:string;destination?:string|null};
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const watchTime=24*60*60_000,checkInterval=5*60_000,alertTime=10*60_000;

/** Owner-authorized, public GitHub observations only; no task text or credentials leave the device. */
export class StuckCiWatch {
  private ticking=false;
  private retryAfter=new Map<string,number>();
  private readonly bootId=randomUUID();
  constructor(private store:Store,private router:Router,private fetcher:typeof fetch=fetch,private clock=()=>Date.now()){
    store.db.exec(`CREATE TABLE IF NOT EXISTS stuck_ci_watches(
      id TEXT PRIMARY KEY,owner TEXT NOT NULL,destination TEXT NOT NULL,generation TEXT NOT NULL,item_id INTEGER NOT NULL,
      request_id TEXT NOT NULL,binding_id TEXT NOT NULL,identity TEXT NOT NULL,item_identity TEXT NOT NULL,repository TEXT NOT NULL,
      pr_number INTEGER NOT NULL,expires_at INTEGER NOT NULL,last_checked INTEGER NOT NULL DEFAULT 0,UNIQUE(owner,destination,item_id));
      CREATE TABLE IF NOT EXISTS stuck_ci_alerts(outbox_id TEXT PRIMARY KEY,watch_id TEXT NOT NULL,incident TEXT NOT NULL,head_sha TEXT NOT NULL,
      check_run_id INTEGER NOT NULL,check_name TEXT NOT NULL,completed_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,boot_id TEXT NOT NULL,UNIQUE(watch_id,incident));
      CREATE TABLE IF NOT EXISTS stuck_ci_api_reads(id INTEGER PRIMARY KEY,at INTEGER NOT NULL);`);
    // A queued, never-attempted notice is not sent after restart. Remove it
    // and let a fresh observation recreate it; attempted sends stay deduped.
    const stale=store.db.prepare(`SELECT a.outbox_id,a.watch_id,o.source FROM stuck_ci_alerts a JOIN outbox o ON o.id=a.outbox_id
      WHERE o.status='queued' AND o.attempts=0 AND o.sent_at IS NULL AND o.wa_message IS NULL`).all() as {outbox_id:string;watch_id:string;source:string}[];
    store.db.exec('SAVEPOINT stuck_ci_restart');
    try{
      for(const row of stale){
        const removed=store.db.prepare("DELETE FROM outbox WHERE id=? AND status='queued' AND attempts=0 AND sent_at IS NULL AND wa_message IS NULL").run(row.outbox_id);
        if(removed.changes){store.db.prepare('DELETE FROM stuck_ci_alerts WHERE outbox_id=?').run(row.outbox_id);store.db.prepare('DELETE FROM reply_receipts WHERE source=?').run(row.source.replace(/:0$/,''));store.db.prepare('UPDATE stuck_ci_watches SET last_checked=0 WHERE id=?').run(row.watch_id);}
      }
      store.db.exec('RELEASE stuck_ci_restart');
    }catch(e){store.db.exec('ROLLBACK TO stuck_ci_restart; RELEASE stuck_ci_restart');throw e;}
    // Reverting a change must not revive an old approval or an in-flight read.
    // Watches are deliberately discarded when their authority changes.
    store.db.exec(`CREATE TRIGGER IF NOT EXISTS stuck_ci_item_update AFTER UPDATE ON items
      WHEN OLD.title IS NOT NEW.title OR OLD.binding_id IS NOT NEW.binding_id OR OLD.created_at IS NOT NEW.created_at OR NEW.status='done'
      BEGIN DELETE FROM stuck_ci_watches WHERE item_id=NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS stuck_ci_item_delete AFTER DELETE ON items BEGIN DELETE FROM stuck_ci_watches WHERE item_id=OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS stuck_ci_origin_delete AFTER DELETE ON item_owner_origins BEGIN DELETE FROM stuck_ci_watches WHERE item_id=OLD.item_id AND owner=OLD.owner AND destination=OLD.destination; END;
      CREATE TRIGGER IF NOT EXISTS stuck_ci_origin_update AFTER UPDATE ON item_owner_origins BEGIN DELETE FROM stuck_ci_watches WHERE item_id=OLD.item_id AND owner=OLD.owner AND destination=OLD.destination; END;
      CREATE TRIGGER IF NOT EXISTS stuck_ci_link_delete AFTER DELETE ON item_requests BEGIN DELETE FROM stuck_ci_watches WHERE request_id=OLD.request_id; END;
      CREATE TRIGGER IF NOT EXISTS stuck_ci_link_update AFTER UPDATE ON item_requests BEGIN DELETE FROM stuck_ci_watches WHERE request_id=OLD.request_id; END;
      CREATE TRIGGER IF NOT EXISTS stuck_ci_request_origin_delete AFTER DELETE ON owner_request_origins BEGIN DELETE FROM stuck_ci_watches WHERE request_id=OLD.request_id; END;
      CREATE TRIGGER IF NOT EXISTS stuck_ci_request_origin_update AFTER UPDATE ON owner_request_origins BEGIN DELETE FROM stuck_ci_watches WHERE request_id=OLD.request_id; END;
      CREATE TRIGGER IF NOT EXISTS stuck_ci_job_update AFTER UPDATE OF binding_id,destination ON inbox WHEN OLD.binding_id IS NOT NEW.binding_id OR OLD.destination IS NOT NEW.destination BEGIN DELETE FROM stuck_ci_watches WHERE request_id=OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS stuck_ci_job_delete AFTER DELETE ON inbox BEGIN DELETE FROM stuck_ci_watches WHERE request_id=OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS stuck_ci_binding_update AFTER UPDATE ON bindings BEGIN DELETE FROM stuck_ci_watches WHERE binding_id=OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS stuck_ci_binding_delete AFTER DELETE ON bindings BEGIN DELETE FROM stuck_ci_watches WHERE binding_id=OLD.id; END;`);
    for(const operation of ['INSERT','UPDATE','DELETE'] as const){
      const row=operation==='DELETE'?'OLD':'NEW',changed=operation==='UPDATE'?' AND OLD.value IS NOT NEW.value':'';
      store.db.exec(`CREATE TRIGGER IF NOT EXISTS stuck_ci_setting_${operation.toLowerCase()} AFTER ${operation} ON settings
        WHEN ${row}.key IN ('meta-brain-policy','coordinator-registry')${changed}
        BEGIN DELETE FROM stuck_ci_watches; END;
        CREATE TRIGGER IF NOT EXISTS stuck_ci_scoped_setting_${operation.toLowerCase()} AFTER ${operation} ON settings
        WHEN (${row}.key LIKE 'execution-mode:%' OR ${row}.key LIKE 'session-route:%' OR ${row}.key LIKE 'role-kind:%' OR ${row}.key LIKE 'coordinator-retired:%' OR ${row}.key LIKE 'parent:%' OR ${row}.key LIKE 'report-parent:%')${changed}
        BEGIN DELETE FROM stuck_ci_watches WHERE ${row}.key IN ('execution-mode:'||binding_id,'session-route:'||binding_id,'role-kind:'||binding_id,'coordinator-retired:'||binding_id,'parent:'||request_id,'report-parent:'||request_id); END`);
    }
  }
  private context(owner:string,destination:string,generation:string){
    const policy=brainPolicy(this.store);
    return !this.router.stopped&&policy.enabled&&policy.allowStatus&&!!generation&&this.store.controlChannel()==='whatsapp'&&
      owner===destination&&this.store.get('whatsapp-owner')===owner&&this.store.destination()===destination&&
      this.store.get('incoming-owner-generation')===generation;
  }
  private itemIdentity(id:number){
    const item=this.store.db.prepare('SELECT id,title,status,binding_id,created_at FROM items WHERE id=?').get(id) as any;
    if(!item||item.status==='done')return;
    return digest([item.id,item.title,item.binding_id,item.created_at]);
  }
  private valid(w:Watch){
    const current=this.store.db.prepare('SELECT * FROM stuck_ci_watches WHERE id=?').get(w.id) as Watch|undefined;
    if(!current||JSON.stringify({...current,last_checked:0})!==JSON.stringify({...w,last_checked:0})||w.expires_at<=this.clock()||!this.context(w.owner,w.destination,w.generation)||
      this.itemIdentity(w.item_id)!==w.item_identity||!this.store.db.prepare('SELECT 1 FROM item_owner_origins WHERE item_id=? AND owner=? AND destination=?').get(w.item_id,w.owner,w.destination))return false;
    const job=this.store.job(w.request_id),origin=this.store.requestOwnerOrigin(w.request_id),binding=this.store.binding(w.binding_id);
    return !!job&&job.destination===w.destination&&job.binding_id===w.binding_id&&this.store.itemOf(job.id)===w.item_id&&
      !!origin&&origin.owner===w.owner&&origin.destination===w.destination&&!!binding?.enabled&&briefTargetIdentity(this.store,w.binding_id)===w.identity;
  }
  private approved(w:Watch):ApprovedCiWatch{return {owner:w.owner,destination:w.destination,ownerGeneration:w.generation,rootRequestId:w.request_id,itemId:w.item_id,repository:w.repository,prNumber:w.pr_number};}
  private exact(w:Watch,b:Readonly<ApprovedCiRun>){return this.valid(w)&&JSON.stringify(this.approved(w))===JSON.stringify({owner:b.owner,destination:b.destination,ownerGeneration:b.ownerGeneration,rootRequestId:b.rootRequestId,itemId:b.itemId,repository:b.repository,prNumber:b.prNumber});}
  private budget(needed:number){
    const now=this.clock();this.store.db.prepare('DELETE FROM stuck_ci_api_reads WHERE at<=?').run(now-60*60_000);
    const count=this.store.db.prepare('SELECT COUNT(*) AS n FROM stuck_ci_api_reads').get() as {n:number};
    return count.n+needed<=45;
  }
  /** Stay below the unauthenticated GitHub IP limit, including retries and final checks. */
  private read:typeof fetch=async(input,init)=>{
    if(!this.budget(1))throw new Error('CI read budget exhausted');
    this.store.db.prepare('INSERT INTO stuck_ci_api_reads(at) VALUES(?)').run(this.clock());
    return this.fetcher(input,init);
  };
  command(m:Incoming):string|undefined {
    if(!/^\/stuck\s+ci(?:\s|$)/i.test(m.text.trim()))return;
    const match=/^\/stuck\s+ci\s+(?:#([1-9][0-9]{0,8})\s+(\S+)|remove\s+#([1-9][0-9]{0,8}))$/i.exec(m.text.trim());
    if(!m.ownerCommand||m.quotedId||m.source==='voice'||!authenticatedOwner(this.router,m)||!this.store.incomingOwnerCurrent())return 'Send this as a new text message in your own WhatsApp chat.';
    if(!match)return 'Use /stuck ci #ITEM https://github.com/owner/repo/pull/123, or /stuck ci remove #ITEM.';
    const owner=this.store.get('whatsapp-owner'),destination=this.store.destination(),generation=this.store.get('incoming-owner-generation');
    if(!owner||!destination||!generation||!this.context(owner,destination,generation))return 'CI notices are unavailable in this chat. Enable Brain status and background operation first.';
    const itemId=Number(match[1]??match[3]);
    if(match[3]){this.store.db.prepare('DELETE FROM stuck_ci_watches WHERE owner=? AND destination=? AND item_id=?').run(owner,destination,itemId);return `CI watch removed for #${itemId}.`;}
    const parsed=parseCiPullRequest(match[2]);if(!parsed)return 'Use a public GitHub pull request link, such as https://github.com/owner/repo/pull/123.';
    const itemIdentity=this.itemIdentity(itemId);
    if(!itemIdentity||!this.store.db.prepare('SELECT 1 FROM item_owner_origins WHERE item_id=? AND owner=? AND destination=?').get(itemId,owner,destination))return 'That open item is not available in your chat.';
    const roots=this.store.db.prepare(`SELECT j.id,j.binding_id FROM inbox j JOIN item_requests ir ON ir.request_id=j.id
      JOIN owner_request_origins o ON o.request_id=j.id WHERE ir.item_id=? AND j.destination=? AND o.owner=? AND o.destination=?
      ORDER BY j.created_at,j.rowid LIMIT 100`).all(itemId,destination,owner,destination) as {id:string;binding_id:string}[];
    const root=roots.find(r=>{const b=this.store.binding(r.binding_id),origin=this.store.requestOwnerOrigin(r.id);return !this.store.get(`parent:${r.id}`)&&!this.store.get(`report-parent:${r.id}`)&&!!b?.enabled&&!!briefTargetIdentity(this.store,r.binding_id)&&origin?.owner===owner&&origin.destination===destination;});
    if(!root)return 'That item has no available owner-linked session. Nothing was watched.';
    const identity=briefTargetIdentity(this.store,root.binding_id);if(!identity)return 'That item has no available owner-linked session. Nothing was watched.';
    const existing=this.store.db.prepare('SELECT id FROM stuck_ci_watches WHERE owner=? AND destination=? AND item_id=?').get(owner,destination,itemId);
    const count=this.store.db.prepare('SELECT COUNT(*) AS n FROM stuck_ci_watches WHERE owner=? AND destination=? AND expires_at>?').get(owner,destination,this.clock()) as {n:number};
    if(!existing&&count.n>=20)return 'Remove an existing CI watch before adding another (limit 20).';
    this.store.db.exec('SAVEPOINT stuck_ci_bind');
    try{
      this.store.db.prepare('DELETE FROM stuck_ci_watches WHERE owner=? AND destination=? AND item_id=?').run(owner,destination,itemId);
      this.store.db.prepare('INSERT INTO stuck_ci_watches VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),owner,destination,generation,itemId,root.id,root.binding_id,identity,itemIdentity,parsed.repository,parsed.prNumber,this.clock()+watchTime,0);
      this.store.db.exec('RELEASE stuck_ci_bind');
    }catch(e){this.store.db.exec('ROLLBACK TO stuck_ci_bind; RELEASE stuck_ci_bind');throw e;}
    return `Watching the public PR ${parsed.repository} #${parsed.prNumber} for item #${itemId} for 24 hours. I can report a failed check observed on its current head; this does not establish merge readiness.`;
  }
  async tick(){
    if(this.ticking)return;const owner=this.store.get('whatsapp-owner'),destination=this.store.destination(),generation=this.store.get('incoming-owner-generation');
    if(!owner||!destination||!generation||!this.context(owner,destination,generation))return;
    this.ticking=true;
    try{
      const now=this.clock();
      const rows=this.store.db.prepare('SELECT * FROM stuck_ci_watches WHERE owner=? AND destination=? AND generation=? AND expires_at>? AND last_checked<=? ORDER BY last_checked,id LIMIT 20').all(owner,destination,generation,now,now-checkInterval) as Watch[];
      // Keep enough reads for both discovery and one final delivery recheck.
      const w=rows.find(row=>this.valid(row));if(!w||!this.budget(12))return;
      this.store.db.prepare('UPDATE stuck_ci_watches SET last_checked=? WHERE id=?').run(now,w.id);w.last_checked=now;
      const result=await discoverApprovedCiFailure(this.approved(w),new AbortController().signal,()=>this.valid(w),this.read,this.clock);
      if(!result||!this.valid(w))return;
      const f=result.failure,source=`stuck-ci-alert:${digest([w.id,f.incident])}`;
      this.store.db.exec('SAVEPOINT stuck_ci_enqueue');
      try{
        if(!this.valid(w)){this.store.db.exec('RELEASE stuck_ci_enqueue');return;}
        const exists=this.store.db.prepare('SELECT 1 FROM stuck_ci_alerts WHERE watch_id=? AND incident=?').get(w.id,f.incident);
        if(exists){this.store.db.exec('RELEASE stuck_ci_enqueue');return;}
        const message=`CI check observed failing at ${new Date(f.observedAt).toISOString()}: ${f.checkName} for ${f.repository} PR #${f.prNumber}, head ${f.headSha.slice(0,12)}. https://github.com/${f.repository}/pull/${f.prNumber}\nThis is one historical check result, not overall CI or merge readiness.`;
        if(!this.store.output(undefined,message,source,w.destination,{kind:'system',origin:'system',plain:true}))throw new Error('CI notice could not be queued.');
        const out=this.store.db.prepare('SELECT id FROM outbox WHERE source=?').get(`${source}:0`) as {id:string}|undefined;if(!out)throw new Error('CI notice missing.');
        this.store.db.prepare('INSERT INTO stuck_ci_alerts VALUES(?,?,?,?,?,?,?,?,?)').run(out.id,w.id,f.incident,f.headSha,f.checkRunId,f.checkName,f.completedAt,this.clock()+alertTime,this.bootId);
        this.store.db.exec('RELEASE stuck_ci_enqueue');
      }catch(e){this.store.db.exec('ROLLBACK TO stuck_ci_enqueue; RELEASE stuck_ci_enqueue');throw e;}
    }finally{this.ticking=false;}
  }
  /** Check the saved watch synchronously immediately before a network send. */
  deliveryState(row:Row,selfJid?:string):'ready'|'invalid'{
    const a=this.store.db.prepare('SELECT * FROM stuck_ci_alerts WHERE outbox_id=?').get(row.id) as Alert|undefined;
    const w=a&&this.store.db.prepare('SELECT * FROM stuck_ci_watches WHERE id=?').get(a.watch_id) as Watch|undefined;
    if(!a||!w||a.boot_id!==this.bootId||!selfJid||selfJid!==w.owner||row.destination!==w.destination||a.expires_at<=this.clock()||row.source!==`stuck-ci-alert:${digest([w.id,a.incident])}:0`||!this.valid(w))return 'invalid';
    return 'ready';
  }
  /** Revalidate the exact head and check immediately before delivery; unavailable reads fail closed. */
  async revalidate(row:Row,selfJid?:string):Promise<'ready'|'hold'|'invalid'>{
    if(this.deliveryState(row,selfJid)==='invalid')return 'invalid';
    if((this.retryAfter.get(row.id)??0)>this.clock())return 'hold';
    const a=this.store.db.prepare('SELECT * FROM stuck_ci_alerts WHERE outbox_id=?').get(row.id) as Alert;
    const w=this.store.db.prepare('SELECT * FROM stuck_ci_watches WHERE id=?').get(a.watch_id) as Watch;
    const binding:ApprovedCiRun={...this.approved(w),headSha:a.head_sha,checkRunId:a.check_run_id,checkName:a.check_name};
    const result=await observeApprovedCiFailure(binding,new AbortController().signal,b=>this.exact(w,b)&&this.deliveryState(row,selfJid)==='ready',this.read,this.clock);
    if(this.deliveryState(row,selfJid)==='invalid')return 'invalid';
    if(!result||result.incident!==a.incident||result.completedAt!==a.completed_at){this.retryAfter.set(row.id,this.clock()+5*60_000);return 'hold';}
    this.retryAfter.delete(row.id);return 'ready';
  }
}
