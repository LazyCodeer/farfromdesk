import type {Store} from './store.js';

/** Detect a destination being changed and restored while an attachment downloads. */
export function prepareAttachmentTargetEpochs(store:Store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS attachment_target_epochs(binding_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS attachment_target_binding_update AFTER UPDATE ON bindings
    WHEN OLD.enabled IS NOT NEW.enabled OR OLD.native_id IS NOT NEW.native_id OR OLD.cwd IS NOT NEW.cwd OR OLD.token_hash IS NOT NEW.token_hash OR OLD.provider IS NOT NEW.provider OR OLD.mode IS NOT NEW.mode
    BEGIN INSERT INTO attachment_target_epochs VALUES(NEW.id,1) ON CONFLICT(binding_id) DO UPDATE SET generation=generation+1; END;
    CREATE TRIGGER IF NOT EXISTS attachment_target_binding_delete AFTER DELETE ON bindings
    BEGIN INSERT INTO attachment_target_epochs VALUES(OLD.id,1) ON CONFLICT(binding_id) DO UPDATE SET generation=generation+1; END;
    CREATE TRIGGER IF NOT EXISTS attachment_target_route_insert AFTER INSERT ON settings
    WHEN NEW.key LIKE 'session-route:%' OR NEW.key LIKE 'execution-mode:%' OR NEW.key LIKE 'native-history-error:%'
    BEGIN INSERT INTO attachment_target_epochs VALUES(substr(NEW.key,instr(NEW.key,':')+1),1) ON CONFLICT(binding_id) DO UPDATE SET generation=generation+1; END;
    CREATE TRIGGER IF NOT EXISTS attachment_target_route_update AFTER UPDATE ON settings
    WHEN OLD.value IS NOT NEW.value AND (NEW.key LIKE 'session-route:%' OR NEW.key LIKE 'execution-mode:%' OR NEW.key LIKE 'native-history-error:%')
    BEGIN INSERT INTO attachment_target_epochs VALUES(substr(NEW.key,instr(NEW.key,':')+1),1) ON CONFLICT(binding_id) DO UPDATE SET generation=generation+1; END;
    CREATE TRIGGER IF NOT EXISTS attachment_target_route_delete AFTER DELETE ON settings
    WHEN OLD.key LIKE 'session-route:%' OR OLD.key LIKE 'execution-mode:%' OR OLD.key LIKE 'native-history-error:%'
    BEGIN INSERT INTO attachment_target_epochs VALUES(substr(OLD.key,instr(OLD.key,':')+1),1) ON CONFLICT(binding_id) DO UPDATE SET generation=generation+1; END;
  `);
}
export function attachmentTargetEpoch(store:Store,id:string):number {
  return (store.db.prepare('SELECT generation FROM attachment_target_epochs WHERE binding_id=?').get(id) as {generation:number}|undefined)?.generation??0;
}
