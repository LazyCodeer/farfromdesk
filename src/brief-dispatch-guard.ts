import { createHash } from 'node:crypto';
import { brainPolicy } from './meta-brain-config.js';
import { hash, type Binding, type Job, type Store } from './store.js';
import type { Router } from './router.js';

/** Known before-submission failures must never be reported as uncertain delivery. */
export class DispatchNotSubmittedError extends Error {}
export class BriefDispatchError extends DispatchNotSubmittedError {constructor(message='The request was not sent because the owner, item or session changed. Check the item before trying again.'){super(message);}}
type Guard={request_id:string;owner:string;destination:string;item_id:number;target_id:string;target_identity:string;item_identity:string;assignment_id:string|null;body_hash:string;owner_generation:string|null};
type GuardItem={id:number;title:string;status:string;binding_id:string|null;created_at:number};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function briefDestinationValid(store:Store,destination:string,owner:string){return store.controlChannel()==='whatsapp'&&!!owner&&store.ownerFor(destination)===owner&&
  (destination===owner||destination===store.get('destination-jid')&&!!store.get(`owned-group:${destination}`));}
function identityForBinding(store:Store,b:Binding){
  let entry:unknown;try{const rows=JSON.parse(store.get('coordinator-registry')??'[]');if(!Array.isArray(rows))return undefined;entry=rows.find((r:any)=>r?.bindingId===b.id)??null;}catch{return undefined;}
  return digest([b.id,b.provider,b.native_id,b.cwd,b.mode,b.created_at,b.token_hash,store.get(`execution-mode:${b.id}`),store.get(`session-route:${b.id}`),store.get(`role-kind:${b.id}`),store.get(`coordinator-retired:${b.id}`),entry]);
}
export function briefTargetIdentity(store:Store,id:string){const b=store.binding(id);return b?identityForBinding(store,b):undefined;}
const itemIdentity=(item:GuardItem)=>digest([item.id,item.title,item.created_at]);
export function recordBriefDispatch(router:Router,job:Job,itemId:number,targetId:string){
  const store=router.store,destination=job.destination,owner=store.ownerFor(destination),item=store.db.prepare('SELECT id,title,status,binding_id,created_at FROM items WHERE id=?').get(itemId) as GuardItem|undefined;
  const target=store.binding(targetId),identity=briefTargetIdentity(store,targetId);
  const captured=store.incomingOwnerContext.getStore();
  if(!destination||!owner||!item||!target||!identity||job.binding_id!==targetId||!briefDestinationValid(store,destination,owner)||!captured||captured.channel!=='whatsapp'||captured.owner!==owner||captured.destination!==destination||!captured.generation||!store.incomingOwnerCurrent())throw new BriefDispatchError();
  store.db.prepare('INSERT INTO brief_dispatch_guards(request_id,owner,destination,item_id,target_id,target_identity,item_identity,assignment_id,body_hash,owner_generation) VALUES(?,?,?,?,?,?,?,?,?,?)').run(job.id,owner,destination,itemId,targetId,identity,itemIdentity(item),item.binding_id,hash(job.body),captured.generation);
  if(!briefDispatchValid(router,job,target))throw new BriefDispatchError();
}
export function briefDispatchGuard(store:Store,id:string){return store.db.prepare('SELECT * FROM brief_dispatch_guards WHERE request_id=?').get(id) as Guard|undefined;}
/** No asynchronous gap may separate this check from the native or channel send. */
export function briefDispatchValid(router:Router,job:Job,passedBinding?:Binding){
  const store=router.store,g=briefDispatchGuard(store,job.id);if(!g)return true;
  const current=store.job(job.id),target=store.binding(g.target_id),item=store.db.prepare('SELECT id,title,status,binding_id,created_at FROM items WHERE id=?').get(g.item_id) as GuardItem|undefined;
  if(router.stopped||!current||!['queued','dispatched'].includes(current.status)||current.binding_id!==g.target_id||current.destination!==g.destination||hash(current.body)!==g.body_hash||store.itemOf(job.id)!==g.item_id||
     !g.owner_generation||g.owner_generation!==(store.get('incoming-owner-generation')??'')||
     !briefDestinationValid(store,g.destination,g.owner)||!target?.enabled||briefTargetIdentity(store,g.target_id)!==g.target_identity||
     passedBinding&&(passedBinding.id!==g.target_id||identityForBinding(store,passedBinding)!==g.target_identity)||
     !item||item.status==='done'||item.binding_id!==g.assignment_id||itemIdentity(item)!==g.item_identity||
     !store.db.prepare('SELECT 1 FROM item_owner_origins WHERE item_id=? AND destination=? AND owner=?').get(g.item_id,g.destination,g.owner))return false;
  const origin=store.db.prepare('SELECT owner,destination FROM owner_request_origins WHERE request_id=?').get(job.id) as {owner:string;destination:string}|undefined;
  const policy=brainPolicy(store),coordinator=router.coordinator;
  if(!origin||origin.owner!==g.owner||origin.destination!==g.destination||!policy.enabled||!policy.allowRouting||!policy.providers.includes(target.provider)||!coordinator)return false;
  try{
    if(!coordinator.enabled().includes(target.provider)||g.assignment_id===null&&store.get('master')!==g.target_id)return false;
    if(coordinator.isCoordinator(target.id)&&coordinator.registry.identity(target).key!==coordinator.registry.entry(target.id)?.key)return false;
  }catch{return false;}
  return true;
}
