import type { Store } from './store.js';
import type { MetaModel } from './meta-model.js';
import { brainPolicy,brainView,type MetaSecret } from './meta-brain-config.js';

/**
 * Wording for the companion notices.
 *
 * When the brain is configured the lead sentence is written by it, from a closed set of facts,
 * so the app talks about the actual sessions in the owner's own register. Everything that is a
 * commitment stays in the bridge's own words: what was held, which sessions are running, what
 * each button does, and when the choice expires. A model never decides those, and any answer
 * that fails validation is dropped for the plain template instead of being sent.
 */

export type NoticeFacts={
  state:'closed'|'escalated';
  app:string;session:string;folder?:string;
  running:string[];alternatives?:string[];held:boolean;
  options:string[];minutes?:number;expiresMinutes?:number;
  ownerWords?:string;
};

const NOTICE_PROMPT=`You write one owner-facing notice for a phone chat. The owner is away from their computer and asked a coding session (Codex or Claude) to do something.

You are given facts as JSON. Write at most two short sentences, then stop.

Rules
- Use only the given facts. Never invent a session, app, folder, time or result.
- Say what is true now: the app is closed, or the session has not started the work.
- Never say work was sent, started, finished or completed. You do not do that.
- If a session is listed in running, you may point out that it can take the message instead.
- Do not list the options, do not number anything and do not mention buttons. The app adds those.
- Plain words only: no markdown, no emoji, no asterisks, no long dashes (— or –), no links.
- Keep it under 240 characters.`;

const strip=(text:string)=>text.replace(/[*_~`#>]/g,'').replace(/[—–]/g,',').replace(/[ \t]+/g,' ').replace(/\n{2,}/g,'\n').trim();

/** House rules and the bridge's own guarantees, checked before any model wording is used. */
export function acceptableLead(text:string,facts:NoticeFacts):string|undefined {
  const clean=strip(text);
  if(clean.length<20||clean.length>320)return;
  if(clean.split('\n').length>3)return;
  if(/https?:\/\/|www\./i.test(clean))return;
  // An over-claim is worse than a plainer sentence.
  if(/has been sent|have been sent|is now running|already running|is working on|will be done|has finished|has completed|completed successfully/i.test(clean))return;
  const app=facts.app.split(' ')[0];
  if(app&&!clean.toLowerCase().includes(app.toLowerCase()))return;
  return clean;
}

/**
 * The lead sentence: the brain when it is enabled and configured, the caller's template line
 * otherwise. A brain failure is expected sometimes (no key, offline, timeout), so it is never
 * allowed to delay or block the choice itself.
 */
export async function composeNotice(o:{store:Store;secret:MetaSecret;model:MetaModel;facts:NoticeFacts;fallback:string;timeoutMs?:number}):Promise<{lead:string;source:'brain'|'template'}> {
  const policy=brainPolicy(o.store);
  if(!policy.enabled||!policy.allowStatus)return {lead:o.fallback,source:'template'};
  let key:string|undefined;
  try{key=o.secret.read()??undefined;}catch{key=undefined;}
  if(!key)return {lead:o.fallback,source:'template'};
  try{
    const text=await o.model.compose(key,policy,NOTICE_PROMPT,o.facts,o.timeoutMs??8000);
    const lead=acceptableLead(text,o.facts);
    return lead?{lead,source:'brain'}:{lead:o.fallback,source:'template'};
  }catch{
    return {lead:o.fallback,source:'template'};
  }
}

/** Used by the status view, so the app can say whether notices come from the brain. */
export function noticeVoice(store:Store,secret:MetaSecret) {const view=brainView(store,secret);return view.enabled&&view.allowStatus&&view.configured?'brain':'template';}

export const CLOSED_FALLBACK=(app:string,session:string)=>`📴 ${app} is closed, so I have not sent this to ${session} yet.`;
export const ESCALATED_FALLBACK=(app:string,minutes:number)=>`⚠️ ${app} still has not started this after ${minutes} min.`;