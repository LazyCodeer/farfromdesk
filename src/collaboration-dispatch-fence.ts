import type {Store} from './store.js';
import {ensureProviderSetupSchema} from './provider-setup-barrier.js';

/** Install only with the opt-in collaboration adapter. Persistent triggers
 * keep other bridge connections from crossing a durable claim by accident. */
export function installCollaborationDispatchFence(store:Store) {
  ensureProviderSetupSchema(store);
  const names=['collaboration_fence_dispatch','collaboration_fence_insert_dispatched','collaboration_fence_item_insert','collaboration_fence_item_update','collaboration_fence_item_delete',
    'collaboration_fence_ancestry_insert_new','collaboration_fence_ancestry_update_old','collaboration_fence_ancestry_update_new','collaboration_fence_ancestry_delete_old',
    'collaboration_fence_setup_reserve','collaboration_fence_setup_stage','collaboration_fence_setup_claim_insert','collaboration_fence_setup_claim_update',
    'collaboration_fence_setup_legacy_insert','collaboration_fence_setup_legacy_update_old','collaboration_fence_setup_legacy_update_new','collaboration_fence_setup_legacy_delete',
    'collaboration_fence_workflow_insert','collaboration_fence_workflow_update','collaboration_fence_workflow_delete',
    'collaboration_fence_setup_barrier_update','collaboration_fence_setup_barrier_delete',
    'collaboration_fence_workflow_claim_insert','collaboration_fence_workflow_claim_update'];
  store.db.exec('SAVEPOINT collaboration_fence_install');
  try {
  // Replace only our own triggers atomically, so an older opt-in database
  // cannot silently keep a weaker fence after an upgrade.
  for(const name of names)store.db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  const unresolved=`EXISTS(SELECT 1 FROM collaboration_setup_barriers) OR
    EXISTS(SELECT 1 FROM settings WHERE (key LIKE 'worker-create:%' OR key LIKE 'master-attempt:%' OR key LIKE 'desktop-start:%' OR key='master-operation') AND trim(value)<>'null')`;
  store.db.exec(`CREATE TRIGGER collaboration_fence_setup_reserve BEFORE INSERT ON collaboration_setup_barriers
    WHEN EXISTS(SELECT 1 FROM collaboration_workflow_reservations) OR EXISTS(SELECT 1 FROM managed_collaboration_handoffs WHERE state IN ('waiting','claimed')) OR EXISTS(SELECT 1 FROM collaboration_claims WHERE token IS NOT NULL)
    BEGIN SELECT RAISE(ABORT,'collaboration setup fence'); END;
    CREATE TRIGGER collaboration_fence_setup_barrier_update BEFORE UPDATE ON collaboration_setup_barriers
    BEGIN SELECT RAISE(ABORT,'provider setup remains unresolved'); END;
    CREATE TRIGGER collaboration_fence_setup_barrier_delete BEFORE DELETE ON collaboration_setup_barriers
    BEGIN SELECT RAISE(ABORT,'provider setup remains unresolved'); END;
    CREATE TRIGGER collaboration_fence_workflow_insert BEFORE INSERT ON collaboration_workflow_reservations
    WHEN ${unresolved} BEGIN SELECT RAISE(ABORT,'collaboration setup fence'); END;
    CREATE TRIGGER collaboration_fence_workflow_update BEFORE UPDATE ON collaboration_workflow_reservations
    BEGIN SELECT RAISE(ABORT,'collaboration workflow remains unresolved'); END;
    CREATE TRIGGER collaboration_fence_workflow_delete BEFORE DELETE ON collaboration_workflow_reservations
    BEGIN SELECT RAISE(ABORT,'collaboration workflow remains unresolved'); END;
    CREATE TRIGGER collaboration_fence_setup_stage BEFORE INSERT ON managed_collaboration_handoffs
    WHEN ${unresolved} BEGIN SELECT RAISE(ABORT,'collaboration setup fence'); END;
    CREATE TRIGGER collaboration_fence_setup_claim_insert BEFORE INSERT ON collaboration_claims
    WHEN NEW.token IS NOT NULL AND (${unresolved}) BEGIN SELECT RAISE(ABORT,'collaboration setup fence'); END;
    CREATE TRIGGER collaboration_fence_setup_claim_update BEFORE UPDATE OF token ON collaboration_claims
    WHEN NEW.token IS NOT NULL AND (${unresolved}) BEGIN SELECT RAISE(ABORT,'collaboration setup fence'); END;`);
  const workflowClaim=`EXISTS(SELECT 1 FROM collaboration_workflow_reservations w WHERE w.item_id=NEW.item_id AND NOT EXISTS(
    SELECT 1 FROM managed_collaboration_handoffs h WHERE h.root_id=w.root_id AND h.item_id=w.item_id AND h.authority_revision=w.approval
    AND h.root_id=NEW.root_request_id AND h.target_binding=NEW.holder_id AND h.state='waiting'))`;
  store.db.exec(`CREATE TRIGGER collaboration_fence_workflow_claim_insert BEFORE INSERT ON collaboration_claims
    WHEN NEW.token IS NOT NULL AND ${workflowClaim} BEGIN SELECT RAISE(ABORT,'collaboration claim fence'); END;
    CREATE TRIGGER collaboration_fence_workflow_claim_update BEFORE UPDATE OF token ON collaboration_claims
    WHEN NEW.token IS NOT NULL AND ${workflowClaim} BEGIN SELECT RAISE(ABORT,'collaboration claim fence'); END;`);
  for(const [name,op,side] of [['insert','INSERT','NEW'],['update_old','UPDATE','OLD'],['update_new','UPDATE','NEW'],['delete','DELETE','OLD']]){
    const key=`${side}.key`;
    store.db.exec(`CREATE TRIGGER collaboration_fence_setup_legacy_${name} BEFORE ${op} ON settings
      WHEN (${key} LIKE 'worker-create:%' OR ${key} LIKE 'master-attempt:%' OR ${key} LIKE 'desktop-start:%' OR ${key}='master-operation')
      AND (EXISTS(SELECT 1 FROM collaboration_workflow_reservations) OR EXISTS(SELECT 1 FROM managed_collaboration_handoffs WHERE state IN ('waiting','claimed')) OR EXISTS(SELECT 1 FROM collaboration_claims WHERE token IS NOT NULL))
      BEGIN SELECT RAISE(ABORT,'collaboration setup fence'); END`);
  }
  const ancestors=`WITH RECURSIVE ancestors(id) AS (
    SELECT NEW.id UNION SELECT s.value FROM ancestors a JOIN settings s
      ON s.key='parent:'||a.id OR s.key='report-parent:'||a.id
    ) SELECT item_id FROM item_requests WHERE request_id IN (SELECT id FROM ancestors)`;
  const relevant=`c.token IS NOT NULL AND (c.holder_id=NEW.binding_id OR c.item_id IN (${ancestors}))`;
  const workflowBlocked=(update:boolean)=>`EXISTS(SELECT 1 FROM collaboration_workflow_reservations w WHERE
    (w.item_id IN (${ancestors}) OR EXISTS(SELECT 1 FROM managed_collaboration_handoffs s WHERE s.root_id=w.root_id
      AND s.item_id=w.item_id AND s.authority_revision=w.approval AND s.source_binding=NEW.binding_id))
    AND NOT EXISTS(SELECT 1 FROM managed_collaboration_handoffs h JOIN task_contract_report_sources r ON r.source_id=h.job_id
      JOIN inbox prior ON prior.id=h.job_id JOIN collaboration_report_attempts a ON a.job_id=NEW.id
      WHERE ${update?'OLD.status=\'queued\' AND OLD.attempt_id IS NULL':'0'}
      AND h.root_id=w.root_id AND h.item_id=w.item_id AND h.authority_revision=w.approval AND h.source_binding=NEW.binding_id
      AND h.state='complete' AND h.finished=1 AND h.role_order_version=1 AND h.finished_event_id IS NOT NULL
      AND prior.status='completed' AND prior.binding_id=h.target_binding AND prior.attempt_id=h.target_attempt
      AND r.job_id=NEW.id AND NEW.id='report:'||h.job_id AND a.source_id=h.job_id AND a.root_id=w.root_id
      AND a.item_id=w.item_id AND a.approval=w.approval AND a.attempt_id=NEW.attempt_id AND a.exclusive_revision IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM request_events e WHERE e.request_id=h.job_id AND e.id>h.finished_event_id
        AND e.event IN ('queued','dispatched','uncertain','failed','cancelled','completed','reviewed','auto_closed','replaced')))
    AND NOT EXISTS(SELECT 1 FROM managed_collaboration_handoffs h JOIN collaboration_claims c ON c.item_id=h.item_id
      WHERE ${update?'OLD.status=\'queued\'':'0'} AND h.root_id=w.root_id AND h.item_id=w.item_id AND h.authority_revision=w.approval
      AND h.job_id=NEW.id AND h.target_binding=NEW.binding_id AND h.state='claimed' AND h.submission_started=0
      AND h.claim_token=c.token AND h.generation=c.generation AND c.holder_id=NEW.binding_id AND h.target_attempt=NEW.attempt_id))`;
  // Completion evidence is external to SQLite and may be revoked. Keep the
  // target session fenced across bridge connections until reconciliation.
  // Only an exact newly claimed handoff or reserved report may cross it.
  const completedTargetBlocked=(update:boolean)=>`EXISTS(SELECT 1 FROM managed_collaboration_handoffs h WHERE h.target_binding=NEW.binding_id AND h.state='complete')
    AND NOT EXISTS(SELECT 1 FROM managed_collaboration_handoffs h JOIN collaboration_claims c ON c.item_id=h.item_id
      WHERE ${update?'OLD.status=\'queued\'':'0'} AND h.job_id=NEW.id AND h.target_binding=NEW.binding_id AND h.state='claimed'
      AND h.submission_started=0 AND h.claim_token=c.token AND h.generation=c.generation AND c.holder_id=NEW.binding_id AND h.target_attempt=NEW.attempt_id)
    AND NOT EXISTS(SELECT 1 FROM collaboration_report_attempts a WHERE ${update?'OLD.status=\'queued\' AND OLD.attempt_id IS NULL':'0'}
      AND a.job_id=NEW.id AND a.attempt_id=NEW.attempt_id AND a.exclusive_revision IS NOT NULL)`;
  // The exact claim and freshly reserved attempt are written in the same
  // transaction as the guarded queued -> dispatched transition.
  store.db.exec(`CREATE TRIGGER IF NOT EXISTS collaboration_fence_dispatch BEFORE UPDATE OF status,attempt_id,binding_id ON inbox
    WHEN NEW.status='dispatched' AND (${workflowBlocked(true)} OR (${completedTargetBlocked(true)}) OR EXISTS(SELECT 1 FROM managed_collaboration_handoffs h WHERE h.state IN ('waiting','claimed') AND h.source_binding=NEW.binding_id AND h.source_id<>NEW.id)
    OR EXISTS(SELECT 1 FROM collaboration_claims c WHERE ${relevant} AND NOT EXISTS(
      SELECT 1 FROM managed_collaboration_handoffs h WHERE h.job_id=NEW.id AND h.state='claimed' AND h.submission_started=0
      AND h.target_binding=NEW.binding_id AND h.item_id=c.item_id AND h.claim_token=c.token AND h.generation=c.generation
      AND h.target_attempt=NEW.attempt_id AND c.holder_id=NEW.binding_id AND OLD.status='queued')))
    BEGIN SELECT RAISE(ABORT,'collaboration claim fence'); END;
    CREATE TRIGGER IF NOT EXISTS collaboration_fence_insert_dispatched BEFORE INSERT ON inbox
    WHEN NEW.status='dispatched' AND (${workflowBlocked(false)} OR (${completedTargetBlocked(false)}) OR EXISTS(SELECT 1 FROM managed_collaboration_handoffs h WHERE h.state IN ('waiting','claimed') AND h.source_binding=NEW.binding_id AND h.source_id<>NEW.id)
      OR EXISTS(SELECT 1 FROM collaboration_claims c WHERE ${relevant}))
    BEGIN SELECT RAISE(ABORT,'collaboration claim fence'); END;`);

  // Treat a completed attempt as potentially still running: a final reply is
  // not a provider-end receipt. This is intentionally conservative.
  const descendants=(id:string,attempted=false)=>`EXISTS(WITH RECURSIVE descendants(id) AS (
    SELECT ${id} UNION SELECT CASE WHEN s.key LIKE 'report-parent:%' THEN substr(s.key,15) ELSE substr(s.key,8) END
      FROM descendants d JOIN settings s ON s.value=d.id WHERE s.key LIKE 'parent:%' OR s.key LIKE 'report-parent:%'
    ) SELECT 1 FROM inbox i JOIN descendants d ON d.id=i.id ${attempted?'WHERE i.attempt_id IS NOT NULL':''})`;
  const anyClaim="(EXISTS(SELECT 1 FROM collaboration_claims WHERE token IS NOT NULL) OR EXISTS(SELECT 1 FROM collaboration_workflow_reservations))";
  store.db.exec(`CREATE TRIGGER IF NOT EXISTS collaboration_fence_item_insert BEFORE INSERT ON item_requests
    WHEN NOT EXISTS(SELECT 1 FROM item_requests WHERE request_id=NEW.request_id AND item_id=NEW.item_id)
      AND (EXISTS(SELECT 1 FROM collaboration_claims WHERE item_id=NEW.item_id AND token IS NOT NULL) OR EXISTS(SELECT 1 FROM collaboration_workflow_reservations WHERE item_id=NEW.item_id)) AND ${descendants('NEW.request_id',true)}
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
  return error instanceof Error&&/collaboration (?:claim|link|setup) fence/.test(error.message);
}
