import {hash,type Store} from './store.js';
import type {ErrandScope} from './errand-missions.js';

/** Bridge-internal WhatsApp ordering proof. No caller-supplied timestamp is trusted. */
export class ErrandOrder {
  constructor(private store:Store){store.db.exec(`CREATE TABLE IF NOT EXISTS errand_transport_order(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,ref TEXT NOT NULL,owner TEXT NOT NULL,destination TEXT NOT NULL,body_hash TEXT,verified INTEGER NOT NULL DEFAULT 0,UNIQUE(kind,ref));`);}
  /** Capture before any group verification or asynchronous routing. */
  capture(requestId:string,owner:string,destination:string,body:string){
    const prior=this.store.db.prepare("SELECT owner,destination,body_hash FROM errand_transport_order WHERE kind='ingress' AND ref=?").get(requestId) as {owner:string;destination:string;body_hash:string}|undefined;
    if(prior&&(prior.owner!==owner||prior.destination!==destination||prior.body_hash!==hash(body)))throw new Error('Owner message identity changed.');
    this.store.db.prepare("INSERT OR IGNORE INTO errand_transport_order(kind,ref,owner,destination,body_hash) VALUES('ingress',?,?,?,?)").run(requestId,owner,destination,hash(body));
  }
  /** Call only after the authenticated owner and destination have been rechecked. */
  confirm(requestId:string,owner:string,destination:string,body:string){
    if(this.store.controlChannel()!=='whatsapp'||this.store.ownerFor(destination)!==owner)return false;
    return !!this.store.db.prepare("UPDATE errand_transport_order SET verified=1 WHERE kind='ingress' AND ref=? AND owner=? AND destination=? AND body_hash=?").run(requestId,owner,destination,hash(body)).changes;
  }
  /** Called in the same transaction as the trusted WhatsApp delivery receipt. */
  delivery(outboxId:string,destination:string){
    const owner=this.store.ownerFor(destination),row=this.store.db.prepare('SELECT status,destination,delivered_at FROM outbox WHERE id=?').get(outboxId) as {status:string;destination:string|null;delivered_at:number|null}|undefined;
    if(!owner||!row||row.destination!==destination||row.status!=='sent'||row.delivered_at===null)return false;
    // Do not retain receipt ordering for unrelated WhatsApp messages.
    if(!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='errand_shortlist_messages'").get()||
      !this.store.db.prepare('SELECT 1 FROM errand_shortlist_messages WHERE outbox_id=? AND owner=? AND destination=?').get(outboxId,owner,destination))return false;
    const prior=this.store.db.prepare("SELECT owner,destination FROM errand_transport_order WHERE kind='delivery' AND ref=?").get(outboxId) as {owner:string;destination:string}|undefined;
    if(prior&&(prior.owner!==owner||prior.destination!==destination))return false;
    this.store.db.prepare("INSERT OR IGNORE INTO errand_transport_order(kind,ref,owner,destination,verified) VALUES('delivery',?,?,?,1)").run(outboxId,owner,destination);
    return true;
  }
  after(scope:ErrandScope,outboxId:string){
    if(this.store.controlChannel()!=='whatsapp'||this.store.ownerFor(scope.destination)!==scope.owner)return false;
    const job=this.store.job(scope.requestId);if(!job||job.destination!==scope.destination||job.binding_id!==scope.bindingId)return false;
    const row=this.store.db.prepare(`SELECT 1 FROM errand_transport_order i JOIN errand_transport_order d
      ON d.kind='delivery' AND d.ref=? AND d.owner=i.owner AND d.destination=i.destination AND d.verified=1
      WHERE i.kind='ingress' AND i.ref=? AND i.owner=? AND i.destination=? AND i.body_hash=? AND i.verified=1 AND i.seq>d.seq`).get(outboxId,scope.requestId,scope.owner,scope.destination,hash(job.body));
    return !!row;
  }
}
