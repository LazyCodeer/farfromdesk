import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import type {Store} from './store.js';

type SetupScope={store:Store;attempt:string};
const active=new AsyncLocalStorage<SetupScope>();

/** A durable reservation, not proof that a provider has stopped. */
export function ensureProviderSetupSchema(store:Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS collaboration_setup_barriers(
    attempt_id TEXT PRIMARY KEY,kind TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL)`);
}
export function hasUnresolvedProviderSetup(store:Store) {
  ensureProviderSetupSchema(store);
  if(store.db.prepare('SELECT 1 FROM collaboration_setup_barriers LIMIT 1').get())return true;
  // Old operation records have no trustworthy before-send or exact-end marker.
  return !!store.db.prepare(`SELECT 1 FROM settings WHERE (key LIKE 'worker-create:%' OR key LIKE 'master-attempt:%' OR key LIKE 'desktop-start:%' OR key='master-operation')
    AND trim(value)<>'null' LIMIT 1`).get();
}
function table(store:Store,name:string){return !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
function collaborationActive(store:Store) {
  const handoffs=table(store,'managed_collaboration_handoffs'),workflows=table(store,'collaboration_workflow_reservations');
  const hasApproval=handoffs&&store.db.prepare('PRAGMA table_info(managed_collaboration_handoffs)').all().some((c:any)=>c.name==='authority_revision');
  return workflows&&!!store.db.prepare('SELECT 1 FROM collaboration_workflow_reservations LIMIT 1').get()||
    // Older databases lack a durable workflow marker, even for a completed
    // plan whose coordinator report may still be running.
    handoffs&&!!store.db.prepare(workflows&&hasApproval?`SELECT 1 FROM managed_collaboration_handoffs h WHERE NOT EXISTS(
      SELECT 1 FROM collaboration_workflow_reservations w WHERE w.root_id=h.root_id AND w.item_id=h.item_id
      AND w.approval=COALESCE(h.authority_revision,'legacy:'||h.job_id)) LIMIT 1`:'SELECT 1 FROM managed_collaboration_handoffs LIMIT 1').get()||
    handoffs&&!!store.db.prepare("SELECT 1 FROM managed_collaboration_handoffs WHERE state IN ('waiting','claimed') LIMIT 1").get()||
    table(store,'collaboration_claims')&&!!store.db.prepare('SELECT 1 FROM collaboration_claims WHERE token IS NOT NULL LIMIT 1').get();
}
/** Nested calls share an exact reservation. The marker remains uncertain after
 * return, failure or restart: a READY message is not an end receipt. */
export function withProviderSetup<T>(store:Store,kind:string,run:()=>T):T {
  const inherited=active.getStore();
  if(inherited&&inherited.store===store){assertProviderSetup(store);return run();}
  ensureProviderSetupSchema(store);const attempt=randomUUID();
  store.db.exec('SAVEPOINT provider_setup_reserve');
  try {
    if(collaborationActive(store))throw new Error('Provider setup is held while a collaboration workflow or claim exists.');
    if(table(store,'managed_collaboration_handoffs')&&!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='collaboration_fence_setup_stage'").get())
      throw new Error('Collaboration setup fencing has not been migrated. Setup is held.');
    store.db.prepare("INSERT INTO collaboration_setup_barriers VALUES(?,?,'uncertain',?)").run(attempt,kind,Date.now());
    store.db.exec('RELEASE provider_setup_reserve');
  }catch(e){store.db.exec('ROLLBACK TO provider_setup_reserve; RELEASE provider_setup_reserve');throw e;}
  return active.run({store,attempt},run);
}
/** Called before provider-affecting operations after an await. */
export function assertProviderSetup(store:Store) {
  const scope=active.getStore();
  if(!scope||scope.store!==store||!store.db.prepare("SELECT 1 FROM collaboration_setup_barriers WHERE attempt_id=? AND state='uncertain'").get(scope.attempt))
    throw new Error('The provider setup reservation is unavailable. Nothing was sent.');
}
