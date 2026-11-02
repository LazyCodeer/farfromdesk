import { createHash } from 'node:crypto';
import type { Binding, Store } from './store.js';
import { sessionMeta } from './coordinator-experience.js';
import { hookTroubleLine, type ProviderHookReport } from './provider-hooks.js';

/**
 * Owner-facing companion copy and records.
 *
 * The bridge already learns about native permission prompts, but it says
 * "Permission needed" plus raw JSON and offers yes or no. Two things then break:
 * a question cannot be answered with yes or no, and an allow that does not move
 * the session leaves the owner with nothing to do. This module keeps the wording
 * and the handover records in one place, so a block card, a question card and a
 * takeover guide always describe the same session the same way.
 */

export type BlockKind='approval'|'question'|'unknown';
export type HandoverReason='owner-choice'|'allow-unmoved'|'unmoved'|'question'|'native';

/** A hook question is "<tool name>\n<JSON input>"; anything else is prose. */
export function toolNameOf(question:string) {
  return question.split('\n')[0]?.trim().slice(0,120)??'';
}
export function questionBodyOf(question:string) {
  const index=question.indexOf('\n');
  return index<0?'':question.slice(index+1).trim();
}
const clean=(value:unknown,max:number)=>String(value??'').replace(/[\p{Cc}\p{Cf}\u202a-\u202e\u2066-\u2069]/gu,' ').replace(/[—–]/g,',').replace(/\s+/g,' ').trim().slice(0,max);

/** Plain words for what the session is about to do, plus whether it is a question. */
export function describeTool(question:string):{kind:BlockKind;plain:string;detail:string} {
  const tool=toolNameOf(question),body=questionBodyOf(question);
  const detail=clean(body,180);
  const named:Record<string,string>={
    mcp__session_bridge__whatsapp_reply:'send a WhatsApp message on your behalf',
    mcp__session_bridge__session_social_image:'generate a Social image',
    mcp__session_bridge__session_social_save:'save Social drafts',
    Bash:'run a shell command',BashOutput:'read a background command',
    Write:'create or overwrite a file',Edit:'edit a file',MultiEdit:'edit several files',NotebookEdit:'edit a notebook',
    Read:'read a file',Glob:'list files',Grep:'search file contents',WebFetch:'fetch a web page',WebSearch:'search the web',
    TodoWrite:'update its task list',Task:'delegate part of the work to a subagent',KillShell:'stop a background command',
  };
  if(tool==='AskUserQuestion')return {kind:'question',plain:'asks you a question that has to be answered in the app',detail};
  const plain=named[tool]??(tool.startsWith('mcp__')?`use the ${clean(tool.split('__').filter(Boolean).at(-1),60)} tool`:`use ${clean(tool,60)||'a tool'}`);
  return {kind:'unknown',plain,detail};
}
export type QuestionChoice={header:string;question:string;options:string[];multi:boolean};
/** AskUserQuestion arrives as JSON; anything unparseable becomes no choices, never a guess. */
export function parseQuestionChoices(question:string):QuestionChoice[] {
  let parsed:any;try{parsed=JSON.parse(questionBodyOf(question));}catch{return [];}
  const rows=Array.isArray(parsed?.questions)?parsed.questions:[];
  return rows.slice(0,4).flatMap((row:any)=>{
    const text=clean(row?.question,200);if(!text)return [];
    const header=clean(row?.header,40)||'Question';
    const options=Array.isArray(row?.options)?row.options.slice(0,6).map((o:any)=>clean(o?.label,60)).filter(Boolean):[];
    return [{header,question:text,options,multi:row?.multiSelect===true}];
  });
}
export function appName(provider:string|undefined) {
  return provider==='claude'?'Claude':provider==='codex'?'Codex':provider==='muse'?'Muse Code':'the coding app';
}
function sessionLine(store:Store,binding:Binding) {
  const meta=sessionMeta(store,binding);
  const workspace=binding.cwd.split(/[\\/]/).filter(Boolean).at(-1);
  return {name:meta.name,label:`${appName(binding.provider)} ${store.get(`execution-mode:${binding.id}`)==='desktop'?'Desktop':'CLI'}`,where:clean(workspace,60)};
}

/**
 * The decision card. It always names the session, says in plain words what is
 * being asked for, and offers the three real options: allow, deny, or step in
 * on the Mac. Option 3 exists because the bridge cannot always finish the job.
 */
export function blockCard(o:{store:Store;binding:Binding;question:string;expiresMinutes:number}):{kind:BlockKind;text:string;choices:QuestionChoice[]} {
  const {store,binding}=o,described=describeTool(o.question),session=sessionLine(store,binding);
  const timing=`Reply to this message with 1, 2 or 3. Expires in ${o.expiresMinutes} minutes.`;
  if(described.kind==='question') {
    const choices=parseQuestionChoices(o.question);
    const lines=choices.map((choice,index)=>`${index+1}. ${choice.header}: ${choice.question}${choice.options.length?`\n   ${choice.options.join(' | ')}${choice.multi?' (pick more than one)':''}`:''}`);
    const text=[
      `⚠️ *${session.label} is asking you something*`,
      `- ${session.name} ${described.plain}${session.where?` in ${session.where}`:''}.`,
      '- I cannot answer this one from here, so it will stay open in the app.',
      ...(lines.length?['',...lines]:[]),
      '',
      `You: answer it in ${appName(binding.provider)} on the Mac, then send /done here and I will check. Send /screen to do it from your phone.`,
    ].join('\n');
    return {kind:'question',text:text.slice(0,1200),choices};
  }
  const text=[
    `⚠️ *${session.label} is waiting for your permission*`,
    `- ${session.name} wants to ${described.plain}${session.where?` in ${session.where}`:''}.`,
    ...(described.detail?[`- Asked for: ${described.detail}`]:[]),
    '',
    '1. Allow it',
    '2. Deny it',
    '3. I do it on the Mac myself',
    '',
    timing,
  ].join('\n');
  return {kind:'approval',text:text.slice(0,1200),choices:[]};
}

/** The exact per-reason wording of the handover, so nothing over-claims. */
const guideWhy:Record<HandoverReason,(name:string)=>string>={
  'owner-choice':()=>'You chose to do this one yourself, so nothing was approved from here.',
  'allow-unmoved':name=>`Your allow was delivered, but ${name} has still not moved, so this one has to be done in the app.`,
  'unmoved':name=>`${name} has not moved and I cannot see its own prompts from here.`,
  'question':name=>`${name} is waiting on a question only the app can collect.`,
  'native':name=>`${name} needs this answer inside the app.`,
};

/**
 * The takeover guide. It names the app, the chat and the folder, gives the one
 * action to take, and how to reach the Mac from the phone. `hookTrouble` is
 * appended only when the bridge really cannot see this provider's prompts.
 */
export function takeoverGuide(o:{store:Store;binding:Binding;reason:HandoverReason;hookReports?:ProviderHookReport[];deepLink?:string}):string {
  const {store,binding}=o,session=sessionLine(store,binding),app=appName(binding.provider);
  const lines=[
    '⚠️ *This one needs your Mac*',
    `- ${guideWhy[o.reason](session.name)}`,
  ];
  if(binding.provider!=='muse')lines.push(`- ${session.name} is in ${app}${session.where?`, folder ${session.where}`:''}.`);
  lines.push('',binding.provider==='muse'?'1. Open your terminal on the Mac.':`1. Open ${app} on the Mac.`,'2. Open the chat above and approve the request there.','3. Send /done here and I will check whether it moved.');
  if(o.deepLink)lines.push('',`Or open it directly: ${o.deepLink}`);
  lines.push('',`From your phone: send /screen to control the Mac, then do the same steps.`);
  const trouble=hookTroubleLine(o.hookReports);
  if(trouble)lines.push('',`Note: ${trouble}`);
  return lines.join('\n').slice(0,1500);
}

// ---- Handover records -------------------------------------------------------
// One record per chat. They only ever describe a block that was reported to the
// owner, and they are used to check state, never to resend work.
export type Handover={requestId?:string;bindingId:string;reason:HandoverReason;at:number};
const handoverKey=(store:Store,owner:string,destination:string)=>`handover:${createHash('sha256').update(`${owner}:${destination}`).digest('hex').slice(0,24)}`;
export function recordHandover(store:Store,o:{owner:string;destination:string}&Handover) {
  store.set(handoverKey(store,o.owner,o.destination),JSON.stringify({requestId:o.requestId,bindingId:o.bindingId,reason:o.reason,at:o.at}));
}
export function readHandover(store:Store,owner:string,destination:string):Handover|undefined {
  const raw=store.get(handoverKey(store,owner,destination));if(!raw)return;
  try{const parsed=JSON.parse(raw) as Handover;if(!parsed||typeof parsed.bindingId!=='string'||typeof parsed.at!=='number')return;return parsed;}catch{return;}
}
export function clearHandover(store:Store,owner:string,destination:string) {store.set(handoverKey(store,owner,destination),'');}

/** Durable evidence that a decision was delivered, for the "allow did not unblock" check. */
export function recordDecision(store:Store,o:{requestId:string;bindingId:string;code:string;answer:string;at:number}) {
  store.set(`decision:${o.requestId}`,JSON.stringify({bindingId:o.bindingId,code:o.code,answer:o.answer,at:o.at}));
}
export function readDecision(store:Store,requestId:string):{bindingId:string;code:string;answer:string;at:number}|undefined {
  const raw=store.get(`decision:${requestId}`);if(!raw)return;
  try{return JSON.parse(raw);}catch{return;}
}