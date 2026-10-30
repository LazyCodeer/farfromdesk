import {hash,type Store} from './store.js';
import type {Router,Incoming} from './router.js';
import type {Binding} from './store.js';
import {authenticatedOwner} from './owner-commands.js';
import {parseReach} from './agent-reach.js';

type Capture={owner:string;destination:string;channel:'whatsapp'|'telegram';generation:string;bodyHash:string;command:string};
const key=(id:string)=>`reach-owner-request:${id}`;

/** Capture only a direct, typed owner turn. Page contents and session reports cannot authorize a query. */
export function captureResearchRequest(store:Store,router:Router,m:Incoming):void {
  if(m.ownerCommand!==true||m.source==='voice'||m.quotedId||!authenticatedOwner(router,m))return;
  const context=store.incomingOwnerContext.getStore();
  if(!context||!store.incomingOwnerCurrent())return;
  const first=m.text.trim().split(/\r?\n/,1)[0],match=/^research:\s*(\/reach\s+.*)$/i.exec(first);if(!match)return;
  try{parseReach(match[1]);}catch{return;}
  // Typed messages do not use the media inbox, so capture their owner scope here.
  store.recordIncomingInput(m.id);
  const recorded=store.recordedIncomingInput(m.id);
  if(!recorded||context.owner!==recorded.owner||context.destination!==recorded.destination||context.channel!==recorded.channel||context.generation!==recorded.generation)return;
  const capture:Capture={...context,bodyHash:hash(m.text.trim()),command:match[1]};
  store.set(key(m.id),JSON.stringify(capture));
}

/** The only agent operation derives its exact query from a captured owner request. */
export async function ownerResearchRequest(store:Store,router:Router,binding:Binding,requestId:unknown):Promise<string> {
  if(typeof requestId!=='string'||!(/^(?:wa:|tg:)/.test(requestId))||requestId.length>300)throw new Error('Use an original open owner request.');
  const raw=store.get(key(requestId));let saved:Capture|undefined;
  try{saved=raw?JSON.parse(raw):undefined;}catch{}
  if(!saved)throw new Error('The owner must start a direct typed message with Research: /reach followed by the exact public query.');
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
