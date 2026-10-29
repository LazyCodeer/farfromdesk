import type {Store} from './store.js';

/** Install only with the opt-in collaboration adapter. Persistent triggers
 * keep other bridge connections from crossing a durable claim by accident. */
export function installCollaborationDispatchFence(store:Store) {
  const names=['collaboration_fence_dispatch','collaboration_fence_insert_dispatched','collaboration_fence_item_insert','collaboration_fence_item_update','collaboration_fence_item_delete',
    'collaboration_fence_ancestry_insert_new','collaboration_fence_ancestry_update_old','collaboration_fence_ancestry_update_new','collaboration_fence_ancestry_delete_old'];
  store.db.exec('SAVEPOINT collaboration_fence_install');
  try {
  // Replace only our own triggers atomically, so an older opt-in database
  // cannot silently keep a weaker fence after an upgrade.
  for(const name of names)store.db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  const ancestors=`WITH RECURSIVE ancestors(id) AS (
    SELECT NEW.id UNION SELECT s.value FROM ancestors a JOIN settings s
      ON s.key='parent:'||a.id OR s.key='report-parent:'||a.id
    ) SELECT item_id FROM item_requests WHERE request_id IN (SELECT id FROM ancestors)`;
  const relevant=`c.token IS NOT NULL AND (c.holder_id=NEW.binding_id OR c.item_id IN (${ancestors}))`;
  // The exact claim and freshly reserved attempt are written in the same
  // transaction as the guarded queued -> dispatched transition.
  store.db.exec(`CREATE TRIGGER IF NOT EXISTS collaboration_fence_dispatch BEFORE UPDATE OF status,attempt_id,binding_id ON inbox
    WHEN NEW.status='dispatched' AND (EXISTS(SELECT 1 FROM managed_collaboration_handoffs h WHERE h.state IN ('waiting','claimed') AND h.source_binding=NEW.binding_id AND h.source_id<>NEW.id)
    OR EXISTS(SELECT 1 FROM collaboration_claims c WHERE ${relevant} AND NOT EXISTS(
      SELECT 1 FROM managed_collaboration_handoffs h WHERE h.job_id=NEW.id AND h.state='claimed' AND h.submission_started=0
      AND h.target_binding=NEW.binding_id AND h.item_id=c.item_id AND h.claim_token=c.token AND h.generation=c.generation
      AND h.target_attempt=NEW.attempt_id AND c.holder_id=NEW.binding_id AND OLD.status='queued')))
    BEGIN SELECT RAISE(ABORT,'collaboration claim fence'); END;
    CREATE TRIGGER IF NOT EXISTS collaboration_fence_insert_dispatched BEFORE INSERT ON inbox
    WHEN NEW.status='dispatched' AND (EXISTS(SELECT 1 FROM managed_collaboration_handoffs h WHERE h.state IN ('waiting','claimed') AND h.source_binding=NEW.binding_id AND h.source_id<>NEW.id)
      OR EXISTS(SELECT 1 FROM collaboration_claims c WHERE ${relevant}))
    BEGIN SELECT RAISE(ABORT,'collaboration claim fence'); END;`);

  // Treat a completed attempt as potentially still running: a final reply is
  // not a provider-end receipt. This is intentionally conservative.
  const descendants=(id:string,attempted=false)=>`EXISTS(WITH RECURSIVE descendants(id) AS (
    SELECT ${id} UNION SELECT CASE WHEN s.key LIKE 'report-parent:%' THEN substr(s.key,15) ELSE substr(s.key,8) END
      FROM descendants d JOIN settings s ON s.value=d.id WHERE s.key LIKE 'parent:%' OR s.key LIKE 'report-parent:%'
    ) SELECT 1 FROM inbox i JOIN descendants d ON d.id=i.id ${attempted?'WHERE i.attempt_id IS NOT NULL':''})`;
  const anyClaim="EXISTS(SELECT 1 FROM collaboration_claims WHERE token IS NOT NULL)";
  store.db.exec(`CREATE TRIGGER IF NOT EXISTS collaboration_fence_item_insert BEFORE INSERT ON item_requests
    WHEN NOT EXISTS(SELECT 1 FROM item_requests WHERE request_id=NEW.request_id AND item_id=NEW.item_id)
      AND EXISTS(SELECT 1 FROM collaboration_claims WHERE item_id=NEW.item_id AND token IS NOT NULL) AND ${descendants('NEW.request_id',true)}
    BEGIN SELECT RAISE(ABORT,'collaboration link fence'); END;
    CREATE TRIGGER IF NOT EXISTS collaboration_fence_item_update BEFORE UPDATE ON item_requests
    WHEN (OLD.request_id IS NOT NEW.request_id OR OLD.item_id IS NOT NEW.item_id) AND ${anyClaim}
      AND (${descendants('OLD.request_id')} OR ${descendants('NEW.request_id')})
    BEGIN SELECT RAISE(ABORT,'collaboration link fence'); END;
    CREATE TRIGGER IF NOT EXISTS collaboration_fence_item_delete BEFORE DELETE ON item_requests
    WHEN ${anyClaim} AND ${descendants('OLD.request_id')}
    BEGIN SELECT RAISE(ABORT,'collaboration link fence'); END;`);
  for(const op of ['INSERT','UPDATE','DELETE'] as const){
    for(const side of op==='UPDATE'?['OLD','NEW']:[op==='DELETE'?'OLD':'NEW']){
      const key=`${side}.key`,id=`CASE WHEN ${key} LIKE 'report-parent:%' THEN substr(${key},15) ELSE substr(${key},8) END`;
      const changed=op==='UPDATE'?' AND (OLD.key IS NOT NEW.key OR OLD.value IS NOT NEW.value)':op==='INSERT'?` AND NOT EXISTS(SELECT 1 FROM settings WHERE key=NEW.key AND value=NEW.value)`:'';
      store.db.exec(`CREATE TRIGGER IF NOT EXISTS collaboration_fence_ancestry_${op.toLowerCase()}_${side.toLowerCase()} BEFORE ${op} ON settings
        WHEN (${key} LIKE 'parent:%' OR ${key} LIKE 'report-parent:%')${changed} AND ${anyClaim} AND ${descendants(id)}
        BEGIN SELECT RAISE(ABORT,'collaboration link fence'); END`);
    }
  }
  store.db.exec('RELEASE collaboration_fence_install');
  }catch(e){store.db.exec('ROLLBACK TO collaboration_fence_install; RELEASE collaboration_fence_install');throw e;}
}

export function isCollaborationFenceError(error:unknown) {
  return error instanceof Error&&/collaboration (?:claim|link) fence/.test(error.message);
}
