import type { Store } from './store.js';

// App-only read model. No dispatch, changes to requests, or credentials are exposed.
export function inboxSessions(store: Store, query = '') {
  const q = query.trim().toLowerCase().slice(0, 300);
  const rows = store.db.prepare(`SELECT binding_id, COUNT(*) AS requestCount,
    MAX(COALESCE(updated_at,created_at)) AS latestAt,
    SUM(CASE WHEN status IN ('failed','uncertain') OR (outcome='blocked' AND status NOT IN ('reviewed','replaced','auto_closed')) THEN 1 ELSE 0 END) AS needsReview,
    SUM(CASE WHEN status IN ('queued','dispatched','submitted') THEN 1 ELSE 0 END) AS waiting,
    SUM(CASE WHEN status='completed' AND COALESCE(outcome,'')!='blocked' THEN 1 ELSE 0 END) AS answered,
    SUM(CASE WHEN status IN ('reviewed','replaced','auto_closed') THEN 1 ELSE 0 END) AS closed
    FROM inbox GROUP BY binding_id`).all() as any[];
  const sessions = rows.flatMap(row => {
    const b = store.binding(row.binding_id); if (!b) return [];
    const name = store.get(`name:${b.id}`) ?? b.alias;
    if (q && !`${name} ${b.provider}`.toLowerCase().includes(q) && !store.db.prepare(`SELECT 1 FROM inbox i WHERE i.binding_id=? AND (instr(lower(i.body),?)>0 OR EXISTS (SELECT 1 FROM outbox o WHERE o.destination IS i.destination AND (o.request_id=i.id OR (o.request_id IS NULL AND o.source IN ('audio-error:'||i.id||':0','audio-route:'||i.id||':0','telegram-media-error:'||i.id||':0') AND EXISTS (SELECT 1 FROM audio_inbox a WHERE a.id=i.id AND a.destination IS i.destination))) AND instr(lower(o.body),?)>0)) LIMIT 1`).get(b.id,q,q)) return [];
    const last = store.db.prepare(`SELECT body,created_at FROM (
      SELECT body,created_at,'0:request:'||id AS key FROM inbox WHERE binding_id=?
      UNION ALL SELECT o.body,o.created_at,'1:reply:'||o.id AS key FROM outbox o JOIN inbox i ON i.id=o.request_id WHERE i.binding_id=? AND o.destination IS i.destination
      UNION ALL SELECT o.body,o.created_at,'1:reply:'||o.id AS key FROM inbox i JOIN audio_inbox a ON a.id=i.id AND a.destination IS i.destination JOIN outbox o ON o.source IN ('audio-error:'||i.id||':0','audio-route:'||i.id||':0','telegram-media-error:'||i.id||':0') AND o.destination IS i.destination WHERE i.binding_id=? AND o.request_id IS NULL
    ) ORDER BY created_at DESC,key DESC LIMIT 1`).get(b.id,b.id,b.id) as any;
    return [{...row,id:b.id,name,preview:last?.body?.slice(0,300)??'',latestAt:Math.max(row.latestAt,last?.created_at??0)}];
  });
  const orphan = store.db.prepare(`SELECT COUNT(*) AS count,MAX(created_at) AS at FROM audio_inbox a WHERE status IN ('failed','routing_blocked','interrupted') AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.id=a.id)`).get() as any;
  const orphanMatch=!q || 'unassigned voice notes'.includes(q) || store.db.prepare(`SELECT 1 FROM audio_inbox a JOIN outbox o ON o.source IN ('audio-error:'||a.id||':0','audio-route:'||a.id||':0','telegram-media-error:'||a.id||':0') AND o.destination=a.destination WHERE a.status IN ('failed','routing_blocked','interrupted') AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.id=a.id) AND instr(lower(o.body),?)>0 LIMIT 1`).get(q);
  if (orphan.count && orphanMatch) sessions.push({id:'unassigned-voice',binding_id:null,name:'Unassigned voice notes',preview:'Voice note not routed to a session',latestAt:orphan.at,requestCount:orphan.count,needsReview:orphan.count,waiting:0,answered:0,closed:0});
  const attention=store.db.prepare(`SELECT 'delivery:'||o.id AS id,o.request_id AS requestId,i.binding_id AS bindingId,
    'Reply delivery needs attention' AS title,COALESCE(o.error,'Delivery could not be confirmed.') AS text,o.created_at AS at
    FROM outbox o JOIN inbox i ON i.id=o.request_id WHERE o.status IN ('failed','uncertain') AND i.status NOT IN ('reviewed','replaced','auto_closed') AND o.destination IS i.destination ORDER BY o.created_at DESC,o.id DESC`).all();
  return {sessions,attention};
}

export function inboxThread(store: Store, bindingId: string, beforeAt?: string|null, beforeId?: string|null) {
  if (bindingId !== 'unassigned-voice' && !store.db.prepare('SELECT 1 FROM bindings WHERE id=?').get(bindingId)) throw new Error('Unknown session.');
  const before = beforeAt == null ? Number.MAX_SAFE_INTEGER : Number(beforeAt);
  if (!Number.isSafeInteger(before) || before < 0 || (beforeId?.length??0)>2200) throw new Error('Invalid conversation cursor.');
  const cursor = beforeId ?? '\uffff';
  const source = bindingId === 'unassigned-voice' ? `
    SELECT '0:voice:'||a.id AS key,a.id AS requestId,'voice-failed' AS kind,
      COALESCE((SELECT body FROM outbox o WHERE o.source IN ('audio-error:'||a.id||':0','audio-route:'||a.id||':0','telegram-media-error:'||a.id||':0') AND o.destination=a.destination ORDER BY o.created_at DESC,o.id DESC LIMIT 1),'Voice note was not routed. Open Details for the recorded cause.') AS text,
      a.created_at AS at,a.destination,1 AS voice,a.status AS delivery
    FROM audio_inbox a WHERE a.status IN ('failed','routing_blocked','interrupted') AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.id=a.id)
  ` : `
    SELECT '0:request:'||i.id AS key,i.id AS requestId,
      CASE WHEN i.id LIKE 'report:%' THEN 'worker-report' WHEN i.id LIKE 'master:%' THEN 'worker-task' ELSE 'owner' END AS kind,
      i.body AS text,i.created_at AS at,i.destination,EXISTS(SELECT 1 FROM audio_inbox a WHERE a.id=i.id) AS voice,NULL AS delivery
    FROM inbox i WHERE i.binding_id=?
    UNION ALL
    SELECT '1:reply:'||o.id AS key,o.request_id AS requestId,CASE WHEN o.source IN ('audio-error:'||i.id||':0','audio-route:'||i.id||':0','telegram-media-error:'||i.id||':0') THEN 'voice-failed' ELSE COALESCE(o.reply_kind,'reply') END AS kind,o.body AS text,o.created_at AS at,o.destination,0 AS voice,o.status AS delivery
    FROM outbox o JOIN inbox i ON i.id=o.request_id WHERE i.binding_id=? AND o.destination IS i.destination
    UNION ALL
    SELECT '1:reply:'||o.id AS key,i.id AS requestId,'voice-failed' AS kind,o.body AS text,o.created_at AS at,o.destination,1 AS voice,o.status AS delivery
    FROM inbox i JOIN audio_inbox a ON a.id=i.id AND a.destination IS i.destination
      JOIN outbox o ON o.source IN ('audio-error:'||i.id||':0','audio-route:'||i.id||':0','telegram-media-error:'||i.id||':0') AND o.destination IS i.destination
    WHERE i.binding_id=? AND o.request_id IS NULL
  `;
  const messages = store.db.prepare(`SELECT * FROM (${source}) WHERE at<? OR (at=? AND key<?) ORDER BY at DESC,key DESC LIMIT 101`).all(...(bindingId==='unassigned-voice'?[]:[bindingId,bindingId,bindingId]),before,before,cursor) as any[];
  const hasMore=messages.length>100;messages.length=Math.min(100,messages.length);
  const oldest=messages.at(-1);
  const latest=store.db.prepare('SELECT id FROM inbox WHERE binding_id=? ORDER BY COALESCE(updated_at,created_at) DESC,created_at DESC,id DESC LIMIT 1').get(bindingId) as any;
  const ids=new Set(messages.map(m=>m.requestId));if(latest)ids.add(latest.id);
  const jobs=[...ids].flatMap(id=>{const job=store.job(id);return job&&job.binding_id===bindingId?[job]:[];});
  return {messages:messages.reverse(),jobs,latestRequestId:latest?.id??null,next:hasMore?{at:oldest.at,id:oldest.key}:null};
}
