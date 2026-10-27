import { hash, type Store } from './store.js';
import { toWhatsApp } from './whatsapp-format.js';

// Deliberately not semantic similarity: a changed fact, qualifier, decision or
// combined result must get through. Ignore only formatting and generic headings.
export function replyFindings(text:string) {
  return toWhatsApp(text).split('\n').map(line=>{
    const value=line.trim().replace(/^[-•]\s+/, '').replace(/^\*([^*]+)\*$/, '$1');
    const heading=value.replace(/^\p{Extended_Pictographic}[\uFE0F\u200D]*\s*/u, '').replace(/^\*([^*]+)\*$/, '$1');
    return /^(?:reply|update|progress|summary|result|done|all done|done successfully|complete|completed|finished|final|acknowledged|verified|success|successful|ok|okay)[.!:]?$/i.test(heading)?'':value;
  })
    .filter(line=>/[\p{L}\p{N}]/u.test(line))
    .join('\n');
}

/** Fingerprints only, linked to persisted replies and the exact request tree. */
export class OwnerReplyPolicy {
  constructor(private store:Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS owner_reply_fingerprints(
      source TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES inbox(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS owner_reply_fingerprint ON owner_reply_fingerprints(fingerprint);`);
  }
  recordWorker(requestId:string,source:string,text:string) {
    const findings=replyFindings(text);if(!findings)return;
    this.store.db.prepare('INSERT OR IGNORE INTO owner_reply_fingerprints VALUES(?,?,?)').run(source,requestId,hash(findings));
  }
  alreadySent(requestId:string,text:string) {
    const findings=replyFindings(text);if(!findings)return false;
    const root=requestId.startsWith('report:')?this.store.get(`report-parent:${requestId}`):requestId;
    if(!root)return false;
    const owner=this.store.job(root);if(!owner?.destination)return false;
    // UNION bounds cycles. Only descendants of this owner request qualify, and
    // every physical message part must be confirmed sent to the same destination.
    return !!this.store.db.prepare(`WITH RECURSIVE tree(id) AS (
      SELECT ? UNION SELECT i.id FROM inbox i JOIN settings s ON s.key='parent:'||i.id
      JOIN tree t ON s.value=t.id
    ) SELECT 1 FROM owner_reply_fingerprints f JOIN tree t ON t.id=f.request_id
      WHERE f.request_id<>? AND f.fingerprint=?
      AND EXISTS(SELECT 1 FROM outbox o WHERE o.source=f.source||':0' AND o.destination IS ?)
      AND NOT EXISTS(SELECT 1 FROM outbox o
        WHERE substr(o.source,1,length(f.source)+1)=f.source||':'
        AND (o.status<>'sent' OR o.destination IS NOT ?)) LIMIT 1`)
      .get(root,root,hash(findings),owner.destination,owner.destination);
  }
}
