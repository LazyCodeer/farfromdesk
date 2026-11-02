import type { Store, Binding } from './store.js';

/**
 * A transport receipt is one short status line, never a session answer.
 * It never claims work has started, because accepting a message into a native
 * queue proves nothing about whether a model turn will ever run.
 */
export const ownerReceiptText = '⏳ Queued. Waiting for the session to start.';

/** The app that owns the session is not running, so nothing can consume the queue yet. */
export function closedReceiptText(name:string) {
  return `📴 ${name||'The app'} is closed. Queued; it answers when the app opens.`;
}

/** The app closed after a receipt already said "queued", so correct it without resolving the request. */
export function closedAfterQueueText(name:string) {
  return `📴 ${name||'The app'} closed since. Your message stays queued and runs when the app reopens.`;
}

export function providerIcon(provider:string|undefined) { return provider==='claude'?'✳️':provider==='muse'?'🧠':'🤖'; }

/** Short label for notices: "Claude Desktop" rather than the full chat title. */
export function sessionShortName(store:Store,b?:Binding) {
  if(!b)return '';
  if(b.provider==='muse')return 'Muse Code';
  return `${b.provider==='claude'?'Claude':'Codex'} ${store.get(`execution-mode:${b.id}`)==='desktop'?'Desktop':'CLI'}`;
}

/** Provider and chat title used by the metadata tail of a normal reply. */
export function sessionMeta(store:Store,b:Binding) {
  // A chat title is owner-visible text from another app: strip control, bidi and markdown carriers.
  const clean=(value:unknown)=>String(value??'').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069*_~`]/g,' ').replace(/\s+/g,' ').trim();
  const name=clean(store.get(`name:${b.id}`)??b.alias).slice(0,40)||clean(b.alias)||'session';
  return {provider:sessionShortName(store,b),name,icon:providerIcon(b.provider)};
}

// A transport receipt is not an agent answer and never resolves a request.
export function queueOwnerReceipt(store:Store, requestId:string, binding?:Binding, browsing=false) {
  if(!/^(wa|tg):/.test(requestId))return false;
  if(store.db.prepare('SELECT 1 FROM reply_receipts WHERE source IN (?,?)').get(`owner-receipt:${requestId}`,`audio-progress:${requestId}`))return false;
  const job=store.job(requestId);
  const name=sessionShortName(store,binding);
  // Liveness is probed once a minute on the maintenance tick, so this stays synchronous and cheap.
  const closed=!!binding&&store.get(`app-running:${binding.provider}`)==='false';
  const text=browsing?'🔎 Checking your sessions…':closed?closedReceiptText(name):`⏳ Queued for ${name||'the session'}. Waiting for it to start.`;
  return store.output(binding,text,
    `owner-receipt:${requestId}`,job?.destination??store.destination(),
    {kind:'system',origin:'system',plain:true,...(job?{requestId}: {})});
}

export function receiptState(store:Store,requestId:string) {
  const row=store.db.prepare('SELECT status,delivered_at FROM outbox WHERE source IN (?,?) ORDER BY created_at LIMIT 1')
    .get(`owner-receipt:${requestId}:0`,`audio-progress:${requestId}:0`) as {status:string;delivered_at:number|null}|undefined;
  return row?{status:row.status,delivered:row.delivered_at!==null}:null;
}

export type MessageChrome = {
  /** Metadata tail printed under the answer; omitted when a chat already announced itself. */
  meta?: string[];
};

/**
 * Answer first, metadata last. No heading above the text and no product footer:
 * the message itself leads, and provenance is a small tail of one or two lines.
 */
export function formatWhatsAppMessage(text:string, _sender:string, _coordinator:boolean, part=1,total=1,kind?:'progress'|'final'|'hook'|'system',chrome:MessageChrome={}) {
  let body=text.trimEnd().replace(/\n\n— FarFromDesk(?: · [^\n]*)?$/u,'').trimEnd();
  // A progress note is not a result, so it keeps one marker; ordinary answers stay unlabelled.
  if(kind==='progress') {
    const prose=body.replace(/```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+/g,'');
    if(!/\p{Extended_Pictographic}/u.test(prose))body=`📝 ${body}`;
  }
  const meta=(chrome.meta??[]).filter(Boolean);
  return `${body}${meta.length?`\n\n${meta.join('\n')}`:''}${total>1?`\n\n(${part}/${total})`:''}`;
}
