import { readFileSync, writeFileSync, renameSync, rmSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { defaultStateDirectory } from './platform.js';
import type { Store } from './store.js';

// Verified against dev.meta.ai/docs/overview and /structured-output, 2026-10-27.
// No custom hosts or Contributor models: never redirect credentials or opt into data sharing.
export const META_ENDPOINT='https://api.meta.ai/v1/chat/completions';
export const META_MODELS=['muse-spark-1.3','muse-spark-1.2','muse-spark-1.1','muse-wonder-1.0'] as const;
/** Every coding platform the brain can route to. Adding a provider means adding it here. */
export const PROVIDERS=['codex','claude','muse','deepseek','cursor'] as const;
export type BrainProvider=(typeof PROVIDERS)[number];
export const BrainPolicy=z.object({enabled:z.boolean(),model:z.string().min(1).max(100).regex(/^[\w.:-]+$/),allowRouting:z.boolean(),allowStatus:z.boolean(),allowManagement:z.boolean().default(false),providers:z.array(z.enum(PROVIDERS)).max(PROVIDERS.length),failure:z.enum(['block','legacy']),notes:z.string().max(2000).default(''),learn:z.boolean().default(true),taskContracts:z.boolean().default(true)}).strict();
export type BrainPolicy=z.infer<typeof BrainPolicy>;
export const DEFAULT_BRAIN:BrainPolicy={enabled:false,model:'muse-wonder-1.0',allowRouting:false,allowStatus:true,allowManagement:false,providers:[],failure:'legacy',notes:'',learn:true,taskContracts:true};
/** Platforms the owner has set up. Provisioning a coordinator adds to this list (see masters.ts). */
function enabledProviders(store:Store):BrainProvider[] {
  try{const raw=JSON.parse(store.get('enabled-apps')??'[]');return Array.isArray(raw)?raw.filter((p):p is BrainProvider=>(PROVIDERS as readonly string[]).includes(p)):[];}
  catch{return [];}
}
export function brainPolicy(store:Store):BrainPolicy {
  try{
    const policy=BrainPolicy.parse(JSON.parse(store.get('meta-brain-policy')??'null'));
    // The allowlist is the platforms the owner set up, so it has to follow enabled-apps. It is seeded
    // when Brain routing is switched on, and that seed only ever named the platforms that existed at
    // the time: without this, every platform added later (Muse, DeepSeek Harness, Cursor) stayed
    // denied even though its coordinator was ready and the owner had used it.
    const added=enabledProviders(store).filter(p=>!policy.providers.includes(p));
    return added.length?{...policy,providers:[...policy.providers,...added]}:policy;
  }catch{return {...DEFAULT_BRAIN};}
}
const keyPath=(root:string)=>join(root,'meta-model-api-key');
export class MetaSecret {
  constructor(readonly root=process.env.WSB_STATE_DIR ?? defaultStateDirectory()) {}
  read():string|undefined {try{return readFileSync(keyPath(this.root),'utf8').trim()||undefined;}catch{return undefined;}}
  present(){return !!this.read();}
  save(value:unknown) {
    if(typeof value!=='string'||value.length<20||value.length>4096||/[^\x21-\x7e]/.test(value))throw new Error('Enter a valid Meta Model API key in desktop Settings.');
    const file=keyPath(this.root),partial=file+'.'+randomUUID();
    try{writeFileSync(partial,value,{mode:0o600,flag:'wx'});chmodSync(partial,0o600);renameSync(partial,file);}finally{rmSync(partial,{force:true});}
  }
  remove(){rmSync(keyPath(this.root),{force:true});}
}
export function brainView(store:Store,secret:MetaSecret) {const policy=brainPolicy(store);return {...policy,configured:secret.present(),state:!policy.enabled?'disabled':secret.present()?'configured':'missing-key',models:storedModels(store)};}
/** Models this key can use, as Meta lists them; the built-in list until a key is saved and checked. */
function storedModels(store:Store):string[] {try{const v=JSON.parse(store.get('meta-brain-models')??'null');return Array.isArray(v)&&v.length?v:[...META_MODELS];}catch{return [...META_MODELS];}}
export async function fetchMetaModels(store:Store,secret:MetaSecret,fetcher:typeof fetch=fetch) {
  const key=secret.read();if(!key)return;
  const res=await fetcher(META_ENDPOINT.replace(/chat\/completions$/,'models'),{headers:{authorization:'Bearer '+key},signal:AbortSignal.timeout(10000)});
  if(!res.ok)throw new Error('Meta did not list models ('+res.status+').');
  const ids=((await res.json())?.data??[]).map((m:{id?:unknown})=>m?.id).filter((id:unknown):id is string=>typeof id==='string'&&/^[\w.:-]{1,100}$/.test(id));
  if(ids.length)store.set('meta-brain-models',JSON.stringify(ids));
}
export function saveBrainConfig(store:Store,secret:MetaSecret,input:unknown) {
  const d=z.object({policy:BrainPolicy,key:z.string().optional(),removeKey:z.boolean().optional()}).strict().parse(input);
  // Older desktop clients omit the new setting; saving another preference must not re-enable it.
  const submitted=(input as {policy?:Record<string,unknown>})?.policy;
  if(submitted&&submitted.taskContracts===undefined)d.policy.taskContracts=brainPolicy(store).taskContracts;
  if(d.removeKey&&d.key)throw new Error('Choose save or remove key.');
  if(d.key)secret.save(d.key);
  if(d.removeKey){secret.remove();store.db.prepare("DELETE FROM settings WHERE key='meta-brain-models'").run();}
  store.set('meta-brain-policy',JSON.stringify(d.policy));
  store.audit('meta-brain-policy-updated');
  return brainView(store,secret);
}
