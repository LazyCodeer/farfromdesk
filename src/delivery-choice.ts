import type { Binding,Store } from './store.js';
import { DispatchNotSubmittedError } from './brief-dispatch-guard.js';
import { sessionShortName } from './coordinator-experience.js';
import { appName } from './companion.js';
import { openCodexDesktop,openClaudeDesktop } from './session-activation.js';
import type { Session } from './session-catalog.js';

/**
 * A message aimed at a desktop app that is closed.
 *
 * Codex Desktop takes work through `codex queue`, which has no list and no cancel, so once a
 * message is inside that queue it cannot be moved anywhere else. Offering the owner a choice
 * after that point would run the task twice. So the message is held in the bridge before it is
 * submitted, the owner is asked where it should go, and exactly one of the answers is carried
 * out. If the owner does not answer, the hold expires into the old behaviour: send it to the
 * original session and let it wait for the app.
 */

/** A held message is not a failure. Nothing was submitted and the owner still has the choice. */
export class DeliveryChoiceHold extends DispatchNotSubmittedError {}

export const DELIVERY_CHOICE_MINUTES=15;
const TTL_MS=DELIVERY_CHOICE_MINUTES*60_000;
export const MAX_ALTERNATIVES=4;
const MAX_ANSWER_MS=10*60_000;

export type Alternative={bindingId:string;label:string;sameFolder:boolean;coordinator:boolean};
export type DeliveryHold={
  requestId:string;bindingId:string;provider:string;app:string;session:string;folder:string;
  body:string;destination:string;owner:string|null;channel:'whatsapp'|'telegram';
  alternatives:Alternative[];at:number;expiresAt:number;optionId?:string;
};

const holdKey=(requestId:string)=>`delivery-hold:${requestId}`;

export function readDeliveryHold(store:Store,requestId:string):DeliveryHold|undefined {
  const raw=store.get(holdKey(requestId));if(!raw)return;
  try{return JSON.parse(raw) as DeliveryHold;}catch{return;}
}
export function saveDeliveryHold(store:Store,hold:DeliveryHold) {store.set(holdKey(hold.requestId),JSON.stringify(hold));}
export function releaseDeliveryHold(store:Store,requestId:string) {store.set(holdKey(requestId),'');}
export function heldDelivery(store:Store,requestId:string) {return !!readDeliveryHold(store,requestId);}
/** Open holds, oldest first, for the maintenance tick. */
export function openHolds(store:Store):DeliveryHold[] {
  const rows=store.db.prepare("SELECT key FROM settings WHERE key LIKE 'delivery-hold:%' AND value NOT IN ('','null')").all() as {key:string}[];
  return rows.map(row=>readDeliveryHold(store,row.key.slice('delivery-hold:'.length))).filter((hold):hold is DeliveryHold=>!!hold).sort((a,b)=>a.at-b.at);
}

const folderOf=(path:string)=>path.split(/[\\/]/).filter(Boolean).at(-1)??'';
const cleanLabel=(text:string)=>text.replace(/[\x00-\x1f\x7f*_~`]/g,' ').replace(/\s+/g,' ').trim();

/**
 * Sessions that can take this message right now. A desktop app that is closed cannot, and a
 * channel-mode session is pulled by its own client, so neither is offered. The same folder
 * comes first because a coding instruction usually belongs to the folder the owner was in.
 */
export function deliveryAlternatives(store:Store,from:Binding,isCoordinator:(id:string)=>boolean,live:(provider:string)=>boolean):Alternative[] {
  return store.bindings()
    .filter(b=>b.enabled&&b.id!==from.id)
    // A channel-mode session is pulled by its own client, so the bridge cannot dispatch to it.
    .filter(b=>b.provider==='muse'||b.provider==='deepseek'||b.mode!=='channel')
    .filter(b=>b.provider==='muse'||b.provider==='deepseek'||live(b.provider)||store.get(`execution-mode:${b.id}`)!=='desktop')
    .map(b=>{
      const sameFolder=!!from.cwd&&b.cwd===from.cwd,coordinator=isCoordinator(b.id),where=folderOf(b.cwd);
      const label=cleanLabel(`${sessionShortName(store,b)}${where?` · ${where}`:''}${coordinator?' · coordinator':''}`).slice(0,72)||b.alias;
      return {bindingId:b.id,label,sameFolder,coordinator,score:(sameFolder?0:100)+(b.provider===from.provider?0:20)+(coordinator?0:1)};
    })
    .sort((a,b)=>a.score-b.score||a.label.localeCompare(b.label))
    .slice(0,MAX_ALTERNATIVES)
    .map(({bindingId,label,sameFolder,coordinator})=>({bindingId,label,sameFolder,coordinator}));
}

/** The app the owner has to open, and what the hold is for. */
export function holdTarget(store:Store,b:Binding):{provider:string;app:string;session:string;folder:string} {
  return {provider:b.provider,app:sessionShortName(store,b)||appName(b.provider),session:cleanLabel(store.get(`name:${b.id}`)??b.alias).slice(0,60)||b.alias,folder:folderOf(b.cwd)};
}

/** The running apps, named for a person, from the recorded liveness. */
export function runningApps(store:Store):string[] {
  const names:string[]=[];
  if(store.get('app-running:codex')==='true')names.push('Codex Desktop');
  if(store.get('app-running:claude')==='true')names.push('Claude Desktop');
  names.push('Muse Code');
  if(store.get('app-running:deepseek')==='true')names.push('DeepSeek Harness');
  return names;
}

export type DeliveryCard={text:string;choices:{id:string;label:string}[];optionId?:string};

/**
 * The card for a held message. The lead line is written by the brain when it is available, but
 * the facts, the options and the expiry are always the bridge's own words: a model must never
 * decide what a button does or how long the owner has.
 */
export function heldCard(o:{short:boolean;lead:string;hold:Omit<DeliveryHold,'optionId'|'body'|'owner'|'channel'>;running:string[]}):DeliveryCard {
  const {hold,running,short}=o;
  const choices=[
    {id:'open',label:`1. Open ${hold.app} and send it there`},
    ...hold.alternatives.map((a,index)=>({id:`switch${index+1}`,label:`${index+2}. Send it to ${a.label}`})),
    {id:'wait',label:`${hold.alternatives.length+2}. Keep it queued until ${hold.app} opens`},
  ].map(choice=>({id:choice.id,label:choice.label.slice(0,80)}));
  const facts=[
    `- Held for ${hold.session}${hold.folder?` in ${hold.folder}`:''}. Nothing has been sent to ${hold.app} yet.`,
    ...(running.length?[`- Running now: ${running.join(', ')}.`]:[]),
  ];
  const tail=`If I get no answer in ${DELIVERY_CHOICE_MINUTES} minutes I send it to ${hold.app} as usual, so nothing is lost.`;
  const text=short
    ?[o.lead,...facts,choices.map(c=>c.label).join('\n'),tail].join('\n')
    :[o.lead,...facts,'',choices.map(c=>c.label).join('\n'),'',`Reply with a number or tap a button. ${tail}`].join('\n');
  return {text:text.slice(0,1500),choices};
}

/** The escalation card for work already inside the app's own queue, so it cannot be moved. */
export function escalatedCard(o:{short:boolean;lead:string;app:string;session:string;minutes:number}):DeliveryCard {
  const choices=[{id:'open',label:`1. Open ${o.app} now`},{id:'wait',label:'2. Leave it queued'}];
  const facts=[`- ${o.session} has not started it. The message is already in ${o.app}'s own queue, so I can only open the app, not move it to another session.`];
  const text=o.short
    ?[o.lead,...facts,choices.map(c=>c.label).join('\n')].join('\n')
    :[o.lead,...facts,'',choices.map(c=>c.label).join('\n'),'','Reply with a number or tap a button.'].join('\n');
  return {text:text.slice(0,1500),choices};
}

/** The option ids these cards use, for the answer path. */
export function deliveryOptionIds(card:DeliveryCard) {return card.choices.map(c=>c.id);}

/** Open the app that owns this session, and prove it opened. */
export async function openTarget(b:Binding) {
  if(b.provider==='codex')return openCodexDesktop(b.native_id,false);
  if(b.provider==='claude')return openClaudeDesktop({desktopId:b.native_id} as Session);
  throw new Error(`${appName(b.provider)} has no desktop app to open.`);
}

export const ANSWER_WINDOW_MS=MAX_ANSWER_MS;