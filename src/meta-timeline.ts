import { createHash,randomUUID } from 'node:crypto';
import type { Store } from './store.js';

// The timeline never stores prompts, responses, paths, errors, or account IDs.
export type MetaStage='sorted'|'briefed'|'scheduled'|'heard'|'contracted';
export type MetaObserver=<T>(work:()=>Promise<T>)=>Promise<T>;
const stages=new Set<MetaStage>(['sorted','briefed','scheduled','heard','contracted']);
const revisions=new WeakMap<Store,{scope:string|undefined;token:string|null}>();

function scope(store:Store,destination?:string|null,expectedOwner?:string):string|undefined {
  const dest=destination??store.destination(),owner=dest?store.ownerFor(dest):undefined;
  if(!dest||!owner||expectedOwner&&owner!==expectedOwner)return;
  if(dest.startsWith('tg:')){if(dest!==store.get('telegram-owner'))return;}
  else if(owner!==store.get('whatsapp-owner')||(dest!==owner&&(dest!==store.get('destination-jid')||!store.get(`owned-group:${dest}`))))return;
  return createHash('sha256').update(JSON.stringify([owner,dest])).digest('hex');
}
function safeScope(store:Store,destination?:string|null,owner?:string) {
  try{return scope(store,destination,owner);}catch{return undefined;}
}
function safeGeneration(store:Store) {try{return store.get('incoming-owner-generation')??'';}catch{return undefined;}}

/** A fixed stage and opaque owner/chat scope are captured before a call starts. */
export function metaObserver(store:Store,stage:MetaStage,destination?:string|null,owner?:string):MetaObserver {
  // Only a captured chat origin is attributable; inherited async context is
  // not evidence of the source of a call.
  const origin=destination??undefined,key=origin?safeScope(store,origin,owner):undefined;
  const capturedOwner=store.incomingOwnerContext.getStore(),generation=safeGeneration(store);
  return async <T>(work:()=>Promise<T>):Promise<T>=>{
    const start=performance.now();
    const record=(status:'completed'|'failed')=>{
      try {
        if(!key||!origin||generation===undefined||safeGeneration(store)!==generation||!stages.has(stage)||safeScope(store,origin,owner)!==key||capturedOwner&&(origin!==capturedOwner.destination||owner&&owner!==capturedOwner.owner||!store.incomingOwnerContext.run(capturedOwner,()=>store.incomingOwnerCurrent())))return;
        const elapsed=Math.min(3600000,Math.max(0,Math.round(performance.now()-start)));
        store.db.prepare('INSERT INTO meta_timeline(scope,stage,status,duration_ms,at) VALUES(?,?,?,?,?)').run(key,stage,status,elapsed,Date.now());
        // A bounded global history keeps old owners and abandoned chats from accumulating.
        store.db.prepare('DELETE FROM meta_timeline WHERE id NOT IN (SELECT id FROM meta_timeline ORDER BY id DESC LIMIT 1000)').run();
      } catch { /* Instrumentation must never change the outcome of a Meta call. */ }
    };
    try{const result=await work();record(result instanceof Response&&!result.ok?'failed':'completed');return result;}catch(e){record('failed');throw e;}
  };
}

/** Opaque, process-local revision shared by status and timeline responses. */
function revisionFor(store:Store,current:string|undefined):string|null {
  const previous=revisions.get(store);
  if(!previous||previous.scope!==current){const next={scope:current,token:current?randomUUID():null};revisions.set(store,next);return next.token;}
  return previous.token;
}
export function metaTimelineRevision(store:Store):string|null {return revisionFor(store,safeScope(store));}

function eventsFor(store:Store,key:string|undefined) {
  if(!key)return [];
  return store.db.prepare('SELECT stage,status,duration_ms AS durationMs,at FROM meta_timeline WHERE scope=? ORDER BY id DESC LIMIT 30').all(key);
}

/** Return only fixed labels and timings for the currently paired owner and chat. */
export function metaTimeline(store:Store) {return eventsFor(store,safeScope(store));}
/** The token and events are derived from the same scope lookup. */
export function metaTimelineView(store:Store) {
  const key=safeScope(store);
  return {scope:revisionFor(store,key),events:eventsFor(store,key)};
}
