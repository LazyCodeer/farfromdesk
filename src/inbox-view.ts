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
    if (q && !`${name} ${b.provider}`.toLowerCase().includes(q) && !store.db.prepare(`SELECT 1 FROM inbox i WHERE i.binding_id=? AND (instr(lower(i.body),?)>0 OR EXISTS (SELECT 1 FROM outbox o WHERE o.destination IS i.destination AND (o.request_id=i.id OR (o.request_id IS NULL AND o.source IN ('audio-error:'||i.id||':0','audio-route:'||i.id||':0','telegram-media-error:'||i.id||':0','command-error:'||i.id||':0') AND EXISTS (SELECT 1 FROM audio_inbox a WHERE a.id=i.id AND a.destination IS i.destination))) AND instr(lower(o.body),?)>0)) LIMIT 1`).get(b.id,q,q)) return [];
    const last = store.db.prepare(`SELECT body,created_at FROM (
      SELECT body,created_at,'0:request:'||id AS key FROM inbox WHERE binding_id=?
      UNION ALL SELECT o.body,o.created_at,'1:reply:'||o.id AS key FROM outbox o JOIN inbox i ON i.id=o.request_id WHERE i.binding_id=? AND o.destination IS i.destination
      UNION ALL SELECT o.body,o.created_at,'1:reply:'||o.id AS key FROM inbox i JOIN audio_inbox a ON a.id=i.id AND a.destination IS i.destination JOIN outbox o ON o.source IN ('audio-error:'||i.id||':0','audio-route:'||i.id||':0','telegram-media-error:'||i.id||':0','command-error:'||i.id||':0') AND o.destination IS i.destination WHERE i.binding_id=? AND o.request_id IS NULL
    ) ORDER BY created_at DESC,key DESC LIMIT 1`).get(b.id,b.id,b.id) as any;
    return [{...row,id:b.id,name,preview:last?.body?.slice(0,300)??'',latestAt:Math.max(row.latestAt,last?.created_at??0)}];
  });
  const orphan = store.db.prepare(`SELECT COUNT(*) AS count,MAX(created_at) AS at,SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM voice_attention_reviews r WHERE r.audio_id=a.id AND r.destination=a.destination) THEN 1 ELSE 0 END) AS needsReview FROM audio_inbox a WHERE status IN ('failed','routing_blocked','interrupted') AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.id=a.id AND i.destination IS a.destination)`).get() as any;
  const orphanMatch=!q || 'unassigned voice notes'.includes(q) || store.db.prepare(`SELECT 1 FROM audio_inbox a JOIN outbox o ON o.source IN ('audio-error:'||a.id||':0','audio-route:'||a.id||':0','telegram-media-error:'||a.id||':0','command-error:'||a.id||':0') AND o.destination=a.destination WHERE a.status IN ('failed','routing_blocked','interrupted') AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.id=a.id AND i.destination IS a.destination) AND instr(lower(o.body),?)>0 LIMIT 1`).get(q);
  if (orphan.count && orphanMatch) sessions.push({id:'unassigned-voice',binding_id:null,name:'Unassigned voice notes',preview:'Voice note not routed to a session',latestAt:orphan.at,requestCount:orphan.count,needsReview:orphan.needsReview,waiting:0,answered:0,closed:0});
  const deliveries=store.db.prepare(`SELECT 'delivery:'||o.id AS id,o.request_id AS requestId,i.binding_id AS bindingId,
    'Reply delivery needs attention' AS title,COALESCE(o.error,'Delivery could not be confirmed.') AS text,o.created_at AS at
    FROM outbox o JOIN inbox i ON i.id=o.request_id WHERE o.status IN ('failed','uncertain') AND i.status NOT IN ('reviewed','replaced','auto_closed') AND o.destination IS i.destination ORDER BY o.created_at DESC,o.id DESC`).all();
  // The status snapshot has only the latest 50 voice notes, including successes.
  // Read unresolved failures separately so later successful clips cannot hide them.
  const voices=store.db.prepare(`SELECT 'voice:'||a.id AS id,a.id AS requestId,a.destination,CASE WHEN i.id IS NULL THEN 1 ELSE 0 END AS canReviewOrphan,COALESCE(i.binding_id,'unassigned-voice') AS bindingId,
    CASE WHEN a.status='routing_blocked' THEN 'Voice note · routing blocked' ELSE 'Voice note failed' END AS title,
    'Open the recorded timing and cause.' AS text,a.created_at AS at
    FROM audio_inbox a LEFT JOIN inbox i ON i.id=a.id AND i.destination IS a.destination
    WHERE a.status IN ('failed','routing_blocked','interrupted')
      AND (i.id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM voice_attention_reviews r WHERE r.audio_id=a.id AND r.destination=a.destination))
      AND (i.id IS NULL OR (i.status NOT IN ('reviewed','replaced','auto_closed')
        AND (i.status!='completed' OR i.outcome='blocked')))
    ORDER BY a.created_at DESC,a.id DESC`).all();
  return {sessions,attention:[...deliveries,...voices]};
}

export function inboxThread(store: Store, bindingId: string, beforeAt?: string|null, beforeId?: string|null) {
  if (bindingId !== 'unassigned-voice' && !store.db.prepare('SELECT 1 FROM bindings WHERE id=?').get(bindingId)) throw new Error('Unknown session.');
  const before = beforeAt == null ? Number.MAX_SAFE_INTEGER : Number(beforeAt);
  if (!Number.isSafeInteger(before) || before < 0 || (beforeId?.length??0)>2200) throw new Error('Invalid conversation cursor.');
  const cursor = beforeId ?? '\uffff';
  const source = bindingId === 'unassigned-voice' ? `
    SELECT '0:voice:'||a.id AS key,a.id AS requestId,'voice-failed' AS kind,
      COALESCE((SELECT body FROM outbox o WHERE o.source IN ('audio-error:'||a.id||':0','audio-route:'||a.id||':0','telegram-media-error:'||a.id||':0','command-error:'||a.id||':0') AND o.destination=a.destination ORDER BY o.created_at DESC,o.id DESC LIMIT 1),'Voice note was not routed. The recorded cause is unavailable.') AS text,
      a.created_at AS at,a.destination,1 AS voice,a.status AS delivery
    FROM audio_inbox a WHERE a.status IN ('failed','routing_blocked','interrupted') AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.id=a.id AND i.destination IS a.destination)
  ` : `
    SELECT '0:request:'||i.id AS key,i.id AS requestId,
      CASE WHEN i.id LIKE 'report:%' THEN 'worker-report' WHEN i.id LIKE 'master:%' THEN 'worker-task' ELSE 'owner' END AS kind,
      i.body AS text,i.created_at AS at,i.destination,EXISTS(SELECT 1 FROM audio_inbox a WHERE a.id=i.id AND a.destination IS i.destination) AS voice,NULL AS delivery
    FROM inbox i WHERE i.binding_id=?
    UNION ALL
    SELECT '1:reply:'||o.id AS key,o.request_id AS requestId,CASE WHEN o.source IN ('audio-error:'||i.id||':0','audio-route:'||i.id||':0','telegram-media-error:'||i.id||':0') OR (o.source='command-error:'||i.id||':0' AND EXISTS (SELECT 1 FROM audio_inbox a WHERE a.id=i.id AND a.destination IS i.destination)) THEN 'voice-failed' ELSE COALESCE(o.reply_kind,'reply') END AS kind,o.body AS text,o.created_at AS at,o.destination,0 AS voice,o.status AS delivery
    FROM outbox o JOIN inbox i ON i.id=o.request_id WHERE i.binding_id=? AND o.destination IS i.destination
    UNION ALL
    SELECT '1:reply:'||o.id AS key,i.id AS requestId,'voice-failed' AS kind,o.body AS text,o.created_at AS at,o.destination,1 AS voice,o.status AS delivery
    FROM inbox i JOIN audio_inbox a ON a.id=i.id AND a.destination IS i.destination
      JOIN outbox o ON o.source IN ('audio-error:'||i.id||':0','audio-route:'||i.id||':0','telegram-media-error:'||i.id||':0','command-error:'||i.id||':0') AND o.destination IS i.destination
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

/* ---------------------------------------------------------------------------
 * Unified inbox feed. The rewritten Desktop Inbox shows one conversation for
 * every session instead of a thread per session, so this read model flattens
 * owner requests, coordinator replies, Brain output, owner-command answers and
 * the same Attention rows inboxSessions() computes into one time-ordered page.
 *
 * It is deliberately separate from inboxSessions()/inboxThread(): the current
 * UI keeps using those unchanged until the new Inbox ships.
 * ------------------------------------------------------------------------- */

export type InboxFeedSource = 'you' | 'coordinator' | 'brain' | 'command' | 'notice' | 'attention';
export type InboxFeedKind = 'voice' | 'text' | 'working' | 'update' | 'final' | 'routing' | 'memory' | 'brief' | 'command' | 'notice' | 'attention';
export type InboxFeedDeliveryState = 'queued' | 'sent' | 'delivered' | 'failed' | 'uncertain';
export type InboxFeedMessage = {
  key: string;
  at: number;
  source: InboxFeedSource;
  provider: 'codex' | 'claude' | 'muse' | 'deepseek' | null;
  bindingId: string | null;
  sessionName: string | null;
  requestId: string | null;
  // 'app' only for an owner request this bridge claimed for its own composer.
  origin: 'app' | null;
  itemRef: number | null;
  kind: InboxFeedKind;
  kindLabel: string | null;
  text: string;
  channel: 'whatsapp' | 'telegram' | null;
  voice: { durationMs: number | null } | null;
  delivery: { state: InboxFeedDeliveryState; at: number | null; error: string | null } | null;
  needsReview: boolean;
};
export type InboxFeedViewRow = { id: string; kind: 'all' | 'you' | 'coordinator' | 'brain' | 'command' | 'attention'; name: string; provider: string | null; detail: string | null; count: number; needsYou: number; latestAt: number | null; preview: string };
export type InboxFeedFilter = { id: string; label: string; count: number };
export type InboxFeed = {
  view: { id: string; kind: string; name: string; provider: string | null; count: number; firstAt: number | null; lastAt: number | null };
  views: InboxFeedViewRow[];
  filters: InboxFeedFilter[];
  messages: InboxFeedMessage[];
  next: { at: number; key: string } | null;
  stats: { total: number; firstAt: number | null; lastAt: number | null; needsYou: number };
};

// Same review-worthy predicate inboxSessions() aggregates over, for one job alias.
const needsReview = (a: string) => `${a}.status IN ('uncertain','failed') OR (${a}.outcome='blocked' AND ${a}.status NOT IN ('reviewed','replaced','auto_closed'))`;
// Brain groups. A brief is anything whose source or body marks a brief.
const IS_BRIEF = `(o.source LIKE 'morning-brief%' OR o.source LIKE 'brief-action%' OR instr(lower(o.body),'morning brief')>0)`;
const IS_MEMORY = `o.source LIKE 'brain-memory:%'`;
const IS_ASK = `o.source LIKE 'brain-ask:%'`;
const IS_ROUTING = `o.source LIKE 'brain:%'`;
// The composer's claim is the durable record that this request id came from the app.
const APP_ORIGIN = `CASE WHEN EXISTS(SELECT 1 FROM settings s WHERE s.key='app-origin:'||i.id) THEN 'app' ELSE NULL END`;

const BRAIN_GROUP = `CASE WHEN ${IS_BRIEF} THEN 'brain-brief' WHEN ${IS_MEMORY} THEN 'brain-memory' WHEN ${IS_ASK} THEN 'brain-ask' WHEN ${IS_ROUTING} THEN 'brain' ELSE NULL END`;

/** The one SQL source of the feed. Every branch is scoped to one destination. */
function feedSql() {
  return `
SELECT '0:request:'||i.id AS key,i.created_at AS at,
  CASE WHEN i.id LIKE 'report:%' OR i.id LIKE 'master:%' THEN 'coordinator' ELSE 'you' END AS source,
  CASE WHEN i.id LIKE 'report:%' OR i.id LIKE 'master:%' THEN (SELECT provider FROM bindings WHERE id=i.binding_id) ELSE NULL END AS provider,
  i.binding_id AS bindingId,i.id AS requestId,
  ${APP_ORIGIN} AS origin,
  CASE WHEN EXISTS(SELECT 1 FROM audio_inbox a WHERE a.id=i.id AND a.destination IS i.destination) THEN 'voice' ELSE 'text' END AS kind,
  CASE WHEN i.id LIKE 'report:%' THEN 'Worker report' WHEN i.id LIKE 'master:%' THEN 'Delegated task' ELSE NULL END AS kindLabel,
  i.body AS text,i.destination AS destination,
  CASE WHEN EXISTS(SELECT 1 FROM audio_inbox a WHERE a.id=i.id AND a.destination IS i.destination) THEN 1 ELSE 0 END AS isVoice,
  NULL AS delStatus,NULL AS delSentAt,NULL AS delDeliveredAt,NULL AS delError,
  CASE WHEN ${needsReview('i')} THEN 1 ELSE 0 END AS needsReview,
  NULL AS brainGroup
FROM inbox i WHERE i.destination IS ?
UNION ALL
SELECT '1:reply:'||o.id AS key,o.created_at AS at,'coordinator' AS source,
  (SELECT provider FROM bindings WHERE id=i.binding_id) AS provider,
  i.binding_id AS bindingId,o.request_id AS requestId,
  NULL AS origin,
  CASE o.reply_kind WHEN 'progress' THEN 'working' WHEN 'final' THEN 'final' ELSE 'update' END AS kind,
  CASE o.reply_kind WHEN 'progress' THEN 'Progress' WHEN 'final' THEN 'Final' WHEN 'system' THEN 'Update' ELSE 'Reply' END AS kindLabel,
  o.body AS text,o.destination AS destination,0 AS isVoice,
  o.status AS delStatus,o.sent_at AS delSentAt,o.delivered_at AS delDeliveredAt,o.error AS delError,
  CASE WHEN ${needsReview('i')} THEN 1 ELSE 0 END AS needsReview,
  NULL AS brainGroup
FROM outbox o JOIN inbox i ON i.id=o.request_id
WHERE o.destination IS ? AND o.destination IS i.destination AND o.binding_id IS NOT NULL
UNION ALL
SELECT '1:reply:'||o.id AS key,o.created_at AS at,
  CASE WHEN ${BRAIN_GROUP} IS NOT NULL THEN 'brain' WHEN o.source LIKE 'command:%' OR o.source LIKE 'command-error:%' THEN 'command' ELSE 'notice' END AS source,
  NULL AS provider,NULL AS bindingId,o.request_id AS requestId,
  NULL AS origin,
  CASE WHEN ${IS_BRIEF} THEN 'brief' WHEN ${IS_MEMORY} THEN 'memory' WHEN ${IS_ASK} OR ${IS_ROUTING} THEN 'routing' WHEN o.source LIKE 'command:%' OR o.source LIKE 'command-error:%' THEN 'command' ELSE 'notice' END AS kind,
  CASE WHEN ${IS_BRIEF} THEN 'Brief' WHEN ${IS_MEMORY} THEN 'Memory' WHEN ${IS_ASK} OR ${IS_ROUTING} THEN 'Routing' ELSE NULL END AS kindLabel,
  o.body AS text,o.destination AS destination,0 AS isVoice,
  o.status AS delStatus,o.sent_at AS delSentAt,o.delivered_at AS delDeliveredAt,o.error AS delError,
  CASE WHEN ${needsReview('i')} THEN 1 ELSE 0 END AS needsReview,
  ${BRAIN_GROUP} AS brainGroup
FROM outbox o LEFT JOIN inbox i ON i.id=o.request_id AND i.destination IS o.destination
WHERE o.destination IS ? AND o.binding_id IS NULL
UNION ALL
SELECT '2:attention:delivery:'||o.id AS key,o.created_at AS at,'attention' AS source,
  NULL AS provider,i.binding_id AS bindingId,o.request_id AS requestId,
  NULL AS origin,
  'attention' AS kind,NULL AS kindLabel,
  COALESCE(o.error,'Delivery could not be confirmed.') AS text,o.destination AS destination,0 AS isVoice,
  o.status AS delStatus,o.sent_at AS delSentAt,o.delivered_at AS delDeliveredAt,o.error AS delError,
  1 AS needsReview,NULL AS brainGroup
FROM outbox o JOIN inbox i ON i.id=o.request_id
WHERE o.destination IS ? AND o.destination IS i.destination AND o.status IN ('failed','uncertain') AND i.status NOT IN ('reviewed','replaced','auto_closed')
UNION ALL
SELECT '2:attention:voice:'||a.id AS key,a.created_at AS at,'attention' AS source,
  NULL AS provider,COALESCE(i.binding_id,'unassigned-voice') AS bindingId,a.id AS requestId,
  NULL AS origin,
  'attention' AS kind,NULL AS kindLabel,
  'Open the recorded timing and cause.' AS text,a.destination AS destination,0 AS isVoice,
  NULL AS delStatus,NULL AS delSentAt,NULL AS delDeliveredAt,NULL AS delError,
  1 AS needsReview,NULL AS brainGroup
FROM audio_inbox a LEFT JOIN inbox i ON i.id=a.id AND i.destination IS a.destination
WHERE a.destination IS ?
  AND a.status IN ('failed','routing_blocked','interrupted')
  AND (i.id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM voice_attention_reviews r WHERE r.audio_id=a.id AND r.destination=a.destination))
  AND (i.id IS NULL OR (i.status NOT IN ('reviewed','replaced','auto_closed') AND (i.status!='completed' OR i.outcome='blocked')))`;
}

const PROVIDER_LABEL: Record<string, string> = { codex: 'Codex', claude: 'Claude', muse: 'Muse', deepseek: 'DeepSeek' };
type FeedParam = string | number | null;
const BRAIN_SUBVIEWS: Record<string, string> = { 'brain-brief': 'Morning brief', 'brain-memory': 'Memory', 'brain-ask': 'Asks' };

function feedProvider(value: unknown): 'codex' | 'claude' | 'muse' | 'deepseek' | null {
  return value === 'codex' || value === 'claude' || value === 'muse' || value === 'deepseek' ? value : null;
}

function feedChannel(destination: unknown): 'whatsapp' | 'telegram' | null {
  if (destination == null) return null;
  return String(destination).startsWith('tg:') ? 'telegram' : 'whatsapp';
}

function feedDeliveryState(status: unknown, deliveredAt: unknown): InboxFeedDeliveryState {
  if (status === 'delivered' || deliveredAt != null) return 'delivered';
  if (status === 'sent') return 'sent';
  if (status === 'failed') return 'failed';
  if (status === 'uncertain') return 'uncertain';
  return 'queued';
}

/** Resolve the requested view id into its label and its row filter. */
function resolveFeedView(store: Store, requested: string | null | undefined) {
  const id = (requested ?? '').trim();
  if (!id || id === 'all') return { id: 'all', kind: 'all', name: 'One conversation', provider: null as string | null, detail: null as string | null, where: '', params: [] as FeedParam[] };
  // The pane's chip row draws these two as filters, and neither is a binding, so
  // without them a chip click answered "Unknown view." instead of filtering.
  if (id === 'you') return { id: 'you', kind: 'you', name: 'You', provider: null, detail: null, where: ` AND g.source='you'`, params: [] as FeedParam[] };
  if (id === 'coordinators') return { id: 'coordinators', kind: 'coordinator', name: 'Coordinators', provider: null, detail: null, where: ` AND g.source='coordinator'`, params: [] as FeedParam[] };
  if (id === 'commands') return { id: 'commands', kind: 'command', name: 'Commands', provider: null, detail: null, where: ` AND g.source='command'`, params: [] as FeedParam[] };
  if (id === 'attention') return { id: 'attention', kind: 'attention', name: 'Needs you', provider: null, detail: null, where: ` AND g.source='attention'`, params: [] as FeedParam[] };
  if (id === 'brain') return { id: 'brain', kind: 'brain', name: 'Brain', provider: null, detail: null, where: ` AND g.brainGroup IS NOT NULL`, params: [] as FeedParam[] };
  if (Object.hasOwn(BRAIN_SUBVIEWS, id)) return { id, kind: 'brain', name: BRAIN_SUBVIEWS[id], provider: null, detail: null, where: ` AND g.brainGroup=?`, params: [id] as FeedParam[] };
  const binding = store.binding(id);
  if (binding) return { id: binding.id, kind: 'coordinator', name: store.get(`name:${binding.id}`) ?? binding.alias, provider: binding.provider as string | null, detail: `${PROVIDER_LABEL[binding.provider] ?? binding.provider} · ${store.get(`execution-mode:${binding.id}`) === 'desktop' ? 'Desktop' : 'Terminal'}`, where: ` AND g.bindingId=?`, params: [binding.id] };
  throw new Error('Unknown view.');
}

export function inboxFeed(store: Store, options: { view?: string | null; beforeAt?: string | number | null; beforeKey?: string | null; query?: string | null } = {}): InboxFeed {
  // Mirror inboxThread's cursor rules exactly, including the error text.
  const before = options.beforeAt == null ? Number.MAX_SAFE_INTEGER : Number(options.beforeAt);
  if (!Number.isSafeInteger(before) || before < 0 || (options.beforeKey?.length ?? 0) > 2200) throw new Error('Invalid conversation cursor.');
  const cursor = options.beforeKey ?? '\uffff';
  const selected = resolveFeedView(store, options.view);
  const q = (options.query ?? '').trim().toLowerCase().slice(0, 300);

  const destination = store.destination();
  const scope = [destination, destination, destination, destination, destination];
  // Session names and binding aliases ride along so search and previews do not
  // need a second round trip per row.
  const feed = `SELECT f.*,COALESCE(s.value,b.alias) AS sessionName FROM (${feedSql()}) f
    LEFT JOIN bindings b ON b.id=f.bindingId LEFT JOIN settings s ON s.key='name:'||f.bindingId`;
  const qClause = q ? ` AND (instr(lower(g.text),?)>0 OR instr(lower(COALESCE(g.sessionName,'')),?)>0)` : '';
  const qParams: FeedParam[] = q ? [q, q] : [];

  const rows = store.db.prepare(`SELECT * FROM (${feed}) g WHERE (g.at<? OR (g.at=? AND g.key<?))${selected.where}${qClause} ORDER BY g.at DESC,g.key DESC LIMIT 101`).all(...scope, before, before, cursor, ...selected.params, ...qParams) as any[];
  const hasMore = rows.length > 100;
  if (rows.length > 100) rows.length = 100;
  const oldest = rows[rows.length - 1];
  const next = hasMore && oldest ? { at: Number(oldest.at), key: String(oldest.key) } : null;

  const messages = rows.slice().reverse().map((row): InboxFeedMessage => {
    const requestId = row.requestId == null ? null : String(row.requestId);
    const item = requestId == null ? undefined : store.itemOf(requestId);
    const bindingId = row.bindingId == null || row.bindingId === 'unassigned-voice' ? null : String(row.bindingId);
    const delivery: InboxFeedMessage['delivery'] = row.delStatus == null ? null : { state: feedDeliveryState(row.delStatus, row.delDeliveredAt), at: row.delDeliveredAt == null ? (row.delSentAt == null ? null : Number(row.delSentAt)) : Number(row.delDeliveredAt), error: row.delError == null ? null : String(row.delError) };
    return {
      key: String(row.key),
      at: Number(row.at),
      source: String(row.source) as InboxFeedSource,
      provider: row.source === 'coordinator' ? feedProvider(row.provider) : null,
      bindingId,
      sessionName: bindingId == null || row.sessionName == null ? null : String(row.sessionName),
      requestId,
      origin: row.origin === 'app' ? 'app' : null,
      itemRef: typeof item === 'number' ? item : null,
      kind: String(row.kind) as InboxFeedKind,
      kindLabel: row.kindLabel == null ? null : String(row.kindLabel),
      text: String(row.text),
      channel: feedChannel(row.destination),
      voice: row.isVoice ? { durationMs: null } : null,
      delivery,
      needsReview: !!row.needsReview,
    };
  });

  // Stats describe the whole feed, so they ignore the current view and search.
  const statsRow = store.db.prepare(`SELECT COUNT(*) AS total,MIN(g.at) AS firstAt,MAX(g.at) AS lastAt,SUM(CASE WHEN g.source='attention' THEN 1 ELSE 0 END) AS needsYou FROM (${feed}) g`).get(...scope) as any;
  const stats = { total: Number(statsRow?.total ?? 0), firstAt: statsRow?.firstAt == null ? null : Number(statsRow.firstAt), lastAt: statsRow?.lastAt == null ? null : Number(statsRow.lastAt), needsYou: Number(statsRow?.needsYou ?? 0) };

  const viewRow = store.db.prepare(`SELECT COUNT(*) AS count,MIN(g.at) AS firstAt,MAX(g.at) AS lastAt FROM (${feed}) g WHERE 1=1${selected.where}${qClause}`).get(...scope, ...selected.params, ...qParams) as any;
  const view = { id: selected.id, kind: selected.kind, name: selected.name, provider: selected.provider, count: Number(viewRow?.count ?? 0), firstAt: viewRow?.firstAt == null ? null : Number(viewRow.firstAt), lastAt: viewRow?.lastAt == null ? null : Number(viewRow.lastAt) };

  const summary = (where: string, params: FeedParam[]) => {
    const row = store.db.prepare(`SELECT COUNT(*) AS count,SUM(CASE WHEN g.source='attention' THEN 1 ELSE 0 END) AS needsYou,MAX(g.at) AS latestAt FROM (${feed}) g WHERE 1=1${where}`).get(...scope, ...params) as any;
    const count = Number(row?.count ?? 0);
    const last = count ? store.db.prepare(`SELECT g.text FROM (${feed}) g WHERE 1=1${where} ORDER BY g.at DESC,g.key DESC LIMIT 1`).get(...scope, ...params) as any : undefined;
    return { count, needsYou: Number(row?.needsYou ?? 0), latestAt: row?.latestAt == null ? null : Number(row.latestAt), preview: last?.text == null ? '' : String(last.text).slice(0, 160) };
  };

  // The chip row is a fixed set, so it is counted here rather than derived from the
  // list rows, which only carry the groups that actually have messages.
  const countOf = (where: string, params: FeedParam[] = []) => Number((store.db.prepare(`SELECT COUNT(*) AS count FROM (${feed}) g WHERE 1=1${where}`).get(...scope, ...params) as any)?.count ?? 0);
  const filters: InboxFeedFilter[] = [
    { id: 'all', label: 'All', count: countOf('') },
    { id: 'you', label: 'You', count: countOf(` AND g.source='you'`) },
    { id: 'coordinators', label: 'Coordinators', count: countOf(` AND g.source='coordinator'`) },
    { id: 'brain', label: 'Brain', count: countOf(` AND g.brainGroup IS NOT NULL`) },
    { id: 'commands', label: 'Commands', count: countOf(` AND g.source='command'`) },
    { id: 'attention', label: 'Needs you', count: countOf(` AND g.source='attention'`) },
  ];

  const views: InboxFeedViewRow[] = [{ id: 'all', kind: 'all', name: 'One conversation', provider: null, detail: null, ...summary('', []) }];
  const bindings = new Map(store.bindings().map(b => [b.id, b]));
  const present = (store.db.prepare(`SELECT DISTINCT g.bindingId AS bindingId FROM (${feed}) g WHERE g.bindingId IS NOT NULL`).all(...scope) as any[])
    .map(row => bindings.get(String(row.bindingId)))
    .filter((b): b is NonNullable<typeof b> => !!b);
  // Most recently active session first, so the left list mirrors the feed.
  const bindingRows = present.map(binding => ({
    id: binding.id,
    kind: 'coordinator' as const,
    name: store.get(`name:${binding.id}`) ?? binding.alias,
    provider: binding.provider as string | null,
    detail: `${PROVIDER_LABEL[binding.provider] ?? binding.provider} · ${store.get(`execution-mode:${binding.id}`) === 'desktop' ? 'Desktop' : 'Terminal'}`,
    ...summary(` AND g.bindingId=?`, [binding.id]),
  })).sort((x, y) => (y.latestAt ?? 0) - (x.latestAt ?? 0));
  views.push(...bindingRows);

  const brain = summary(` AND g.brainGroup IS NOT NULL`, []);
  if (brain.count) {
    views.push({ id: 'brain', kind: 'brain', name: 'Brain', provider: null, detail: null, ...brain });
    for (const [id, name] of Object.entries(BRAIN_SUBVIEWS)) {
      const sub = summary(` AND g.brainGroup=?`, [id]);
      if (sub.count) views.push({ id, kind: 'brain', name, provider: null, detail: null, ...sub });
    }
  }
  const commands = summary(` AND g.source='command'`, []);
  if (commands.count) views.push({ id: 'commands', kind: 'command', name: 'Commands', provider: null, detail: null, ...commands });
  const attention = summary(` AND g.source='attention'`, []);
  if (attention.count) views.push({ id: 'attention', kind: 'attention', name: 'Needs you', provider: null, detail: null, ...attention });

  return { view, views, filters, messages, next, stats };
}
