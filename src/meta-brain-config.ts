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
export const BrainPolicy=z.object({enabled:z.boolean(),model:z.enum(META_MODELS),allowRouting:z.boolean(),allowStatus:z.boolean(),allowManagement:z.boolean().default(false),providers:z.array(z.enum(['codex','claude'])).max(2),failure:z.enum(['block','legacy']),notes:z.string().max(2000).default(''),learn:z.boolean().default(true)}).strict();
export type BrainPolicy=z.infer<typeof BrainPolicy>;
export const DEFAULT_BRAIN:BrainPolicy={enabled:false,model:'muse-wonder-1.0',allowRouting:false,allowStatus:true,allowManagement:false,providers:[],failure:'legacy',notes:'',learn:true};
export function brainPolicy(store:Store):BrainPolicy {try{return BrainPolicy.parse(JSON.parse(store.get('meta-brain-policy')??'null'));}catch{return {...DEFAULT_BRAIN};}}
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
export function brainView(store:Store,secret:MetaSecret) {const policy=brainPolicy(store);return {...policy,configured:secret.present(),state:!policy.enabled?'disabled':secret.present()?'configured':'missing-key',models:META_MODELS};}
export function saveBrainConfig(store:Store,secret:MetaSecret,input:unknown) {
  const d=z.object({policy:BrainPolicy,key:z.string().optional(),removeKey:z.boolean().optional()}).strict().parse(input);
  if(d.removeKey&&d.key)throw new Error('Choose save or remove key.');
  if(d.key)secret.save(d.key);
  if(d.removeKey)secret.remove();
  store.set('meta-brain-policy',JSON.stringify(d.policy));
  store.audit('meta-brain-policy-updated');
  return brainView(store,secret);
}
