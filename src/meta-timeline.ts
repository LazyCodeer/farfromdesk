import { createHash } from 'node:crypto';
import type { Store } from './store.js';

// The timeline never stores prompts, responses, paths, errors, or account IDs.
export type MetaStage='sorted'|'briefed'|'scheduled'|'heard';
export type MetaObserver=<T>(work:()=>Promise<T>)=>Promise<T>;
const stages=new Set<MetaStage>(['sorted','briefed','scheduled','heard']);

function scope(store:Store,destination?:string|null,expectedOwner?:string):string|undefined {
  const dest=destination??store.destination(),owner=dest?store.ownerFor(dest):undefined;
  if(!dest||!owner||expectedOwner&&owner!==expectedOwner)return;
  if(dest.startsWith('tg:')){if(dest!==store.get('telegram-owner'))return;}
  else if(owner!==store.get('whatsapp-owner')||(dest!==owner&&(dest!==store.get('destination-jid')||!store.get(`owned-group:${dest}`))))return;
  return createHash('sha256').update(JSON.stringify([owner,dest])).digest('hex');
}

/** A fixed stage and opaque owner/chat scope are captured before a call starts. */
export function metaObserver(store:Store,stage:MetaStage,destination?:string|null,owner?:string):MetaObserver {
  const key=scope(store,destination,owner);
  return async <T>(work:()=>Promise<T>):Promise<T>=>{
    const start=performance.now();
    const record=(status:'completed'|'failed')=>{
      if(!key||!stages.has(stage))return;
      try {
        const elapsed=Math.min(3600000,Math.max(0,Math.round(performance.now()-start)));
        store.db.prepare('INSERT INTO meta_timeline(scope,stage,status,duration_ms,at) VALUES(?,?,?,?,?)').run(key,stage,status,elapsed,Date.now());
        // A bounded global history keeps old owners and abandoned chats from accumulating.
        store.db.prepare('DELETE FROM meta_timeline WHERE id NOT IN (SELECT id FROM meta_timeline ORDER BY id DESC LIMIT 1000)').run();
      } catch { /* Instrumentation must never change the outcome of a Meta call. */ }
    };
    try{const result=await work();record(result instanceof Response&&!result.ok?'failed':'completed');return result;}catch(e){record('failed');throw e;}
  };
}

/** Return only fixed labels and timings for the currently paired owner and chat. */
export function metaTimeline(store:Store) {
  const key=scope(store);if(!key)return [];
  return store.db.prepare('SELECT stage,status,duration_ms AS durationMs,at FROM meta_timeline WHERE scope=? ORDER BY id DESC LIMIT 30').all(key);
}
