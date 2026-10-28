import type { Store } from './store.js';

/** Review only an exact unrouted failed voice record. Original evidence stays intact. */
export function reviewOrphanVoice(store:Store,input:unknown) {
  if(!input||typeof input!=='object')throw new Error('Choose an exact voice note and confirm review.');
  const {audioId,destination,confirmed}=input as Record<string,unknown>;
  if(confirmed!==true||typeof audioId!=='string'||!audioId||audioId.length>1000||typeof destination!=='string'||!destination||destination.length>1000)throw new Error('Choose an exact voice note and confirm review.');
  // A single conditional write prevents a stale confirmation from reviewing a
  // different destination, a successful note, or a newly linked request.
  const result=store.db.prepare(`INSERT OR IGNORE INTO voice_attention_reviews(audio_id,destination,reviewed_at)
    SELECT a.id,a.destination,? FROM audio_inbox a
    WHERE a.id=? AND a.destination=? AND a.status IN ('failed','routing_blocked','interrupted')
      AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.id=a.id AND i.destination IS a.destination)`).run(Date.now(),audioId,destination);
  if(result.changes)return {ok:true,alreadyReviewed:false};
  const exists=store.db.prepare(`SELECT 1 FROM voice_attention_reviews r JOIN audio_inbox a ON a.id=r.audio_id AND a.destination=r.destination
    WHERE r.audio_id=? AND r.destination=? AND a.status IN ('failed','routing_blocked','interrupted')
      AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.id=a.id AND i.destination IS a.destination)`).get(audioId,destination);
  if(exists)return {ok:true,alreadyReviewed:true};
  throw new Error('Voice note is unavailable or has changed. Refresh Attention.');
}
