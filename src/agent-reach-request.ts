import {hash,type Store} from './store.js';
import type {Router,Incoming} from './router.js';
import type {Binding} from './store.js';
import {authenticatedOwner} from './owner-commands.js';
import {parseReach} from './agent-reach.js';

type Capture={owner:string;destination:string;channel:'whatsapp'|'telegram';generation:string;bodyHash:string;command:string;kind?:'research'|'jobs'|'social'};
const key=(id:string)=>`reach-owner-request:${id}`;
const safeTopic=(topic:string)=>!!topic&&!/[\r\n]/.test(topic)&&!/\b(?:my|our|private|personal|confidential|proprietary)\b/i.test(topic)&&!/(?:\b(?:password|api[ _-]?key|token|secret)\s*[:=]|\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{16,}))/i.test(topic);

/** Derive one public query from the owner's own first line, never the agent's text. */
export function researchCommand(text:string,guided=false):string|undefined {
  let first=text.trim().split(/\r?\n/,1)[0].trim();
  if(guided&&/^\/research(?:\s|$)/i.test(first))first=first.replace(/^\/research\s*/i,'').trim();
  if(!first)return;
  const explicit=/^research:\s*(\/reach\s+.*)$/i.exec(first);
  if(explicit){try{const query=parseReach(explicit[1]);return !guided||safeTopic(query.value)?explicit[1]:undefined;}catch{return;}}
  const line=first.replace(/^(?:(?:please|hey)[, ]+|(?:can|could|would) you\s+|please\s+)+/i,'').replace(/^research:\s+/i,'research ');
  let command:string|undefined,match:RegExpExecArray|null;
  if((match=/^(?:read|inspect|look up|check)\s+(?:the\s+)?(?:github\s+)?(?:repo|repository)\s+([a-z0-9_.-]+\/[a-z0-9_.-]+)(?:[?.!]|\s+(?:and|then)\b.*)?$/i.exec(line)))
    command=`/reach github read ${match[1]}`;
  else {
    let backend='web';
    if((match=/^(?:search|look)\s+(?:on\s+)?github\s+(?:for|up)\s+(.+)$/i.exec(line))||
      (match=/^find\s+(?:github\s+)?(?:repos|repositories)\s+(?:for|about|on)\s+(.+)$/i.exec(line)))backend='github';
    else match=/^(?:research(?:\s+(?:online|on\s+the\s+web|on\s+the\s+internet))?(?:\s+(?:about|on|for))?|look\s+up|search\s+(?:the\s+)?(?:web|internet)\s+for|find\s+(?:online|on\s+the\s+web)\s+(?:information\s+)?(?:on|about))\s+(.+)$/i.exec(line);
    if(!match&&guided)match=/^(?:draft|write|prepare|create)\s+(?:a\s+)?(?:short\s+)?(?:article|post|summary|report|draft)\s+(?:about|on)\s+(.+)$/i.exec(line);
    if(!match&&guided&&!/^(?:\/|send\b|post\b|publish\b|share\b|email\b|message\b|delete\b|upload\b)/i.test(line))match=/^(.+)$/.exec(line);
    if(match){
      // Keep instructions following the research topic on the owner side.
      const topic=match[1].split(/(?:[,;.]\s*(?:(?:and\s+)?then\s+|and\s+)?|\s+(?:(?:and\s+)?then\s+|and\s+))(?:please\s+)?(?:draft|write|summari[sz]e|prepare|create|make|send|post|publish|share|email|message|tell|give|report)\b/i,1)[0].trim().replace(/[?.!]$/,'').trim();
      // Do not infer consent to send personal or confidential material to a public search provider.
      if(safeTopic(topic))command=`/reach ${backend} search ${topic}`;
    }
  }
  if(!command)return;
  try{parseReach(command);return command;}catch{return;}
}

/** Capture only a direct, typed owner turn. Page contents and session reports cannot authorize a query. */
export function captureResearchRequest(store:Store,router:Router,m:Incoming):void {
  if(m.ownerCommand!==true||m.source==='voice'||m.quotedId||!authenticatedOwner(router,m))return;
  const context=store.incomingOwnerContext.getStore();
  if(!context||!store.incomingOwnerCurrent())return;
  // Outside guided mode, retain only the original explicit command syntax.
  const first=m.text.trim().split(/\r?\n/,1)[0],match=/^research:\s*(\/reach\s+.*)$/i.exec(first);if(!match)return;
  let command:string;try{parseReach(match[1]);command=match[1];}catch{return;}
  // Typed messages do not use the media inbox, so capture their owner scope here.
  store.recordIncomingInput(m.id);
  const recorded=store.recordedIncomingInput(m.id);
  if(!recorded||context.owner!==recorded.owner||context.destination!==recorded.destination||context.channel!==recorded.channel||context.generation!==recorded.generation)return;
  const capture:Capture={...context,bodyHash:hash(m.text.trim()),command};
  store.set(key(m.id),JSON.stringify(capture));
}

/** Called only after the bridge has authenticated and consumed guided research mode. */
export function captureGuidedResearchRequest(store:Store,router:Router,m:Incoming,kind:'research'|'jobs'|'social'='research'):boolean {
  if(m.ownerCommand!==true||m.source==='voice'||m.quotedId||!authenticatedOwner(router,m)||store.seen(m.id)||store.job(m.id))return false;
  const context=store.incomingOwnerContext.getStore();
  if(!context||context.destination!==context.owner||!store.incomingOwnerCurrent())return false;
  const input=kind==='jobs'?m.text.trim().replace(/^\/jobs(?:\s+|$)/i,''):kind==='social'?m.text.trim().replace(/^\/social(?:\s+|$)/i,''):m.text;
  // Social briefs may contain private brand context. Only an explicit public research request can become a search.
  if(kind==='social'&&!/^(?:research\b|search\s+(?:the\s+)?(?:web|internet)\s+for\b|look\s+up\b|research:\s*\/reach\s+)/i.test(input))return false;
  const command=researchCommand(input,kind!=='social');if(!command)return false;
  const capture:Capture={...context,bodyHash:hash(m.text.trim()),command,kind},previous=store.get(key(m.id));
  if(previous)return previous===JSON.stringify(capture);
  store.db.exec('SAVEPOINT guided_research_capture');
  try{
    store.recordIncomingInput(m.id);
    const recorded=store.recordedIncomingInput(m.id);
    if(!recorded||recorded.owner!==context.owner||recorded.destination!==context.destination||recorded.channel!==context.channel||recorded.generation!==context.generation){store.db.exec('RELEASE guided_research_capture');return false;}
    store.set(key(m.id),JSON.stringify(capture));store.db.exec('RELEASE guided_research_capture');return true;
  }catch(e){store.db.exec('ROLLBACK TO guided_research_capture; RELEASE guided_research_capture');throw e;}
}

/** The only agent operation derives its exact query from a captured owner request. */
export async function ownerResearchRequest(store:Store,router:Router,binding:Binding,requestId:unknown):Promise<string> {
  if(typeof requestId!=='string'||!(/^(?:wa:|tg:)/.test(requestId))||requestId.length>300)throw new Error('Use an original open owner request.');
  const raw=store.get(key(requestId));let saved:Capture|undefined;
  try{saved=raw?JSON.parse(raw):undefined;}catch{}
  if(!saved)throw new Error('The owner must request public research in a new direct typed message.');
  const captured=saved;
  const bindingRevision=store.get(`reach-binding-generation:${binding.id}`)??'';
  const authorityRevision=store.get('reach-authority-generation')??'';
  const requestRevision=store.get(`reach-request-generation:${requestId}`)??'';
  const bindingFingerprint=hash(JSON.stringify([binding.id,binding.native_id,binding.cwd,binding.provider,binding.mode,binding.token_hash]));
  const current=()=>{
    try {
      const request=router.coordinator?.ownerRequest(requestId),origin=store.recordedIncomingInput(requestId),active=store.binding(binding.id);
      return !router.stopped&&!!active?.enabled&&!!router.coordinator?.enabled().includes(active.provider)&&
        (store.get(`reach-binding-generation:${binding.id}`)??'')===bindingRevision&&
        (store.get('reach-authority-generation')??'')===authorityRevision&&
        (store.get(`reach-request-generation:${requestId}`)??'')===requestRevision&&
        !store.get(`parent:${requestId}`)&&!store.get(`report-parent:${requestId}`)&&
        hash(JSON.stringify([active.id,active.native_id,active.cwd,active.provider,active.mode,active.token_hash]))===bindingFingerprint&&
        request?.binding_id===binding.id&&request.destination===captured.destination&&
        hash(request.body.trim())===captured.bodyHash&&store.get(key(requestId))===raw&&!!origin&&
        origin.owner===captured.owner&&origin.destination===captured.destination&&origin.channel===captured.channel&&origin.generation===captured.generation&&
        store.controlChannel()===captured.channel&&store.ownerFor(captured.destination)===captured.owner&&(store.get('incoming-owner-generation')??'')===captured.generation;
    }catch{return false;}
  };
  if(!current())throw new Error('The owner request, coordinator or channel changed. Nothing was researched.');
  // Claim before starting the child. A crash or uncertain result never causes
  // a second outbound read under the same owner authorization.
  const claim=`reach-claim:${requestId}`;
  const inserted=store.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(claim,'started');
  if(!inserted.changes)throw new Error('This owner research request was already used or interrupted. Send a new request to try again.');
  try {
    if(!current())throw new Error('The owner request, coordinator or channel changed. Nothing was researched.');
    const result=await router.reach(captured.command,current);
    if(!current())throw new Error('The owner request, coordinator or channel changed. Nothing was returned.');
    return result;
  } finally {try{store.set(claim,'finished');}catch{}}
}
