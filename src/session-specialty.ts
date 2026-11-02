import {hash, type Binding, type Store} from './store.js';

export type SpecialtyKind='research'|'jobs'|'social';
export type SessionSpecialty={imageProvider?:'local'|'meta';kind:SpecialtyKind;bindingId:string;destination:string;bodyHash:string;identity:string;instructions:string;epoch:string;owner:string;generation:string;researchCaptureHash?:string};
export type PendingSpecialty=Omit<SessionSpecialty,'bodyHash'> & {originalHash:string};
const key=(id:string)=>`session-specialty:${id}`;
const pendingKey=(id:string)=>`session-specialty-pending:${id}`;
const epochKey='session-specialty-epoch';

/** Track changes even when a session or selection is changed and then restored. */
export function prepareSpecialties(store:Store) {
  store.db.exec(`INSERT OR IGNORE INTO settings(key,value) VALUES('${epochKey}',lower(hex(randomblob(16))));
    CREATE TRIGGER IF NOT EXISTS session_specialty_settings_insert AFTER INSERT ON settings
    WHEN NEW.key IN ('active','master','selected','enabled-apps','coordinator-registry','incoming-owner-generation') OR NEW.key LIKE 'owner-target:%' OR NEW.key LIKE 'direct:%' OR NEW.key LIKE 'session-route:%' OR NEW.key LIKE 'execution-mode:%'
    BEGIN UPDATE settings SET value=lower(hex(randomblob(16))) WHERE key='${epochKey}'; END;
    CREATE TRIGGER IF NOT EXISTS session_specialty_settings_update AFTER UPDATE ON settings
    WHEN OLD.value IS NOT NEW.value AND (NEW.key IN ('active','master','selected','enabled-apps','coordinator-registry','incoming-owner-generation') OR NEW.key LIKE 'owner-target:%' OR NEW.key LIKE 'direct:%' OR NEW.key LIKE 'session-route:%' OR NEW.key LIKE 'execution-mode:%')
      AND NOT (NEW.key LIKE 'direct:%' AND json_valid(OLD.value) AND json_valid(NEW.value) AND json_type(OLD.value,'$.bindingId')='text' AND json_type(NEW.value,'$.bindingId')='text' AND json_extract(OLD.value,'$.bindingId')=json_extract(NEW.value,'$.bindingId'))
    BEGIN UPDATE settings SET value=lower(hex(randomblob(16))) WHERE key='${epochKey}'; END;
    CREATE TRIGGER IF NOT EXISTS session_specialty_settings_delete AFTER DELETE ON settings
    WHEN OLD.key IN ('active','master','selected','enabled-apps','coordinator-registry','incoming-owner-generation') OR OLD.key LIKE 'owner-target:%' OR OLD.key LIKE 'direct:%' OR OLD.key LIKE 'session-route:%' OR OLD.key LIKE 'execution-mode:%'
    BEGIN UPDATE settings SET value=lower(hex(randomblob(16))) WHERE key='${epochKey}'; END;
    CREATE TRIGGER IF NOT EXISTS session_specialty_binding_update AFTER UPDATE ON bindings
    WHEN OLD.enabled IS NOT NEW.enabled OR OLD.native_id IS NOT NEW.native_id OR OLD.cwd IS NOT NEW.cwd OR OLD.token_hash IS NOT NEW.token_hash
    BEGIN UPDATE settings SET value=lower(hex(randomblob(16))) WHERE key='${epochKey}'; END;`);
}
export function specialtyIdentity(store:Store,b:Binding) {
  return hash(JSON.stringify([b.id,b.native_id,b.cwd,b.provider,b.mode,b.token_hash,store.get(`execution-mode:${b.id}`),store.get(`session-route:${b.id}`),store.get('coordinator-registry')]));
}
export function specialtyEpoch(store:Store){return store.get(epochKey)??'';}
export function markPendingSpecialty(store:Store,id:string,b:Binding,kind:SpecialtyKind,instructions:string,original:string,imageProvider?:'local'|'meta') {
  const context=store.incomingOwnerContext.getStore(),destination=store.destination();
  if(!context||!destination||context.destination!==destination||!store.incomingOwnerCurrent()||!b.enabled||!instructions.trim())throw Error('The selected session or owner changed. Nothing was sent.');
  const marker:PendingSpecialty={...(imageProvider?{imageProvider}:{}),kind,bindingId:b.id,destination,originalHash:hash(original),identity:specialtyIdentity(store,b),instructions,epoch:specialtyEpoch(store),owner:context.owner,generation:context.generation};
  if(!marker.epoch)throw Error('Session specialty is unavailable. Nothing was sent.');
  const raw=JSON.stringify(marker),previous=store.get(pendingKey(id));
  if(previous&&previous!==raw)throw Error('This request was already bound to a different session or specialty.');
  if(!previous)store.set(pendingKey(id),raw);
  return marker;
}
export function pendingSpecialty(store:Store,id:string,original:string):PendingSpecialty|undefined {
  const raw=store.get(pendingKey(id));if(!raw)return;
  try {
    const s=JSON.parse(raw) as PendingSpecialty,b=store.binding(s.bindingId);
    if(!['research','jobs','social'].includes(s.kind)||!s.instructions||!b?.enabled||hash(original)!==s.originalHash||specialtyIdentity(store,b)!==s.identity||specialtyEpoch(store)!==s.epoch||store.ownerFor(s.destination)!==s.owner||(store.get('incoming-owner-generation')??'')!==s.generation)return;
    return s;
  }catch{return;}
}
export function hasPendingSpecialty(store:Store,id:string){return !!store.get(pendingKey(id));}
export function bindSessionSpecialty(store:Store,id:string,b:Binding,kind:SpecialtyKind,instructions:string,imageProvider?:'local'|'meta') {
  const job=store.job(id),context=store.incomingOwnerContext.getStore(),destination=store.destination();
  if(!job||job.binding_id!==b.id||!context||!destination||job.destination!==destination||context.destination!==destination||!store.incomingOwnerCurrent()||!b.enabled||!instructions.trim())throw Error('The selected session or owner changed. Nothing was sent.');
  const capture=store.get(`reach-owner-request:${id}`);
  const value:SessionSpecialty={...(imageProvider?{imageProvider}:{}),kind,bindingId:b.id,destination,bodyHash:hash(job.body),identity:specialtyIdentity(store,b),instructions,epoch:specialtyEpoch(store),owner:context.owner,generation:context.generation,...(capture?{researchCaptureHash:hash(capture)}:{})};
  if(!value.epoch)throw Error('Session specialty is unavailable. Nothing was sent.');
  const raw=JSON.stringify(value),previous=store.get(key(id));
  if(previous&&previous!==raw)throw Error('This request was already bound to a different session or specialty.');
  if(!previous)store.set(key(id),raw);
}
export function hasSessionSpecialty(store:Store,id:string){return !!store.get(key(id));}
export function specialtyNoticeDestination(store:Store,id:string):string|undefined {
  try {
    const s=JSON.parse(store.get(key(id))??'null') as SessionSpecialty|null;
    if(!s||store.ownerFor(s.destination)!==s.owner||(store.get('incoming-owner-generation')??'')!==s.generation||store.controlChannel()!==(s.destination.startsWith('tg:')?'telegram':'whatsapp'))return;
    return s.destination;
  }catch{return;}
}
export function sessionSpecialty(store:Store,id:string):SessionSpecialty|undefined {
  const raw=store.get(key(id));if(!raw)return;
  try {
    const s=JSON.parse(raw) as SessionSpecialty,job=store.job(id),b=store.binding(s.bindingId);
    if(!['research','jobs','social'].includes(s.kind)||!s.instructions||!job||!b?.enabled||job.binding_id!==b.id||job.destination!==s.destination||hash(job.body)!==s.bodyHash||specialtyIdentity(store,b)!==s.identity||specialtyEpoch(store)!==s.epoch||store.ownerFor(s.destination)!==s.owner||(store.get('incoming-owner-generation')??'')!==s.generation)return;
    return s;
  }catch{return;}
}

/** Presentation only: retains the original mode after the owner selects another
 * executor. Never use this weaker historical lookup to authorize tools. */
export function specialtyPresentation(store:Store,id:string) {
  try {
    const job=store.job(id);if(!job)return;
    const s=JSON.parse(store.get(key(id))??store.get(pendingKey(id))??'null');
    if(!s||!['social','research','jobs'].includes(s.kind)||s.bindingId!==job.binding_id||s.destination!==job.destination||
      (s.bodyHash??s.originalHash)!==hash(job.body)||store.ownerFor(s.destination)!==s.owner||
      (store.get('incoming-owner-generation')??'')!==s.generation)return;
    return {kind:s.kind as SpecialtyKind,imageProvider:s.imageProvider==='meta'?'meta' as const:'local' as const};
  }catch{return;}
}
