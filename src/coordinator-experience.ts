import type { Store, Binding } from './store.js';

export const ownerReceiptText = '💬 *Message received*\nGot your message. I’ll coordinate this and keep you updated.';

// A transport receipt is not an agent answer and never resolves a request.
export function queueOwnerReceipt(store:Store, requestId:string, binding?:Binding, browsing=false) {
  if(!/^(wa|tg):/.test(requestId))return false;
  if(store.db.prepare('SELECT 1 FROM reply_receipts WHERE source IN (?,?)').get(`owner-receipt:${requestId}`,`audio-progress:${requestId}`))return false;
  const job=store.job(requestId);
  return store.output(binding,browsing?'🔎 *Checking sessions*\nGot your message. I’m checking your sessions.':ownerReceiptText,
    `owner-receipt:${requestId}`,job?.destination??store.destination(),
    {kind:'system',origin:'system',...(job?{requestId}: {})});
}

export function receiptState(store:Store,requestId:string) {
  const row=store.db.prepare('SELECT status,delivered_at FROM outbox WHERE source IN (?,?) ORDER BY created_at LIMIT 1')
    .get(`owner-receipt:${requestId}:0`,`audio-progress:${requestId}:0`) as {status:string;delivered_at:number|null}|undefined;
  return row?{status:row.status,delivered:row.delivered_at!==null}:null;
}

export function formatWhatsAppMessage(text:string, sender:string, _coordinator:boolean, part=1,total=1,kind?:'progress'|'final'|'hook'|'system') {
  const name=sender.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069*_~`]/g,' ').replace(/\s+/g,' ').trim().slice(0,90);
  const footer='— FarFromDesk';
  // A reply that belongs to an item leads with its number so the owner can follow up by it.
  const heading=name?/^#\d+ · /.test(name)?`*${name}*\n\n`:`*Session: ${name}*\n\n`:'';
  let body=text.trimEnd().replace(/\n\n— FarFromDesk(?: · [^\n]*)?$/u,'').trimEnd();
  if(heading&&body.startsWith(heading))body=body.slice(heading.length);
  // Presentation must not depend on whether a model follows optional style advice.
  // Ignore emoji inside code/URLs and never infer success from a final reply.
  const prose=body.replace(/```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+/g,'');
  if(!/\p{Extended_Pictographic}/u.test(prose)) {
    const emoji=kind==='progress'?'📝':kind==='system'?'ℹ️':'💬';
    const stage=kind==='progress'?'Update':kind==='system'?'Notice':'Reply';
    body=/^\*[^*\n]+\*(?:\n|$)/u.test(body)?`${emoji} ${body}`:`${emoji} *${stage}*\n${body}`;
  }
  return `${heading}${body}${total>1?`\n\n(${part}/${total})`:''}\n\n${footer}`;
}
