// FarFromDesk Pro settings backup. Sealed here with a key derived from the owner's passphrase,
// so the cloud only ever holds ciphertext. Losing both the passphrase and the recovery code loses the backup.
import {createCipheriv,createDecipheriv,createHash,createHmac,randomBytes,scryptSync} from 'node:crypto';
import {mkdirSync,readdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import type {Store} from './store.js';

// Private files beside the database: brain and voice keys, update choice. Device state (server mode, tokens) stays put.
const FILES=['meta-model-api-key','voice-api-key','update-preferences.json'];
const SETTINGS=['meta-brain-policy','meta-brain-models','voice-engine','voice-fallback','social-image-provider','server-mode-low-battery-ok'];
const SCRYPT={N:1<<15,r:8,p:1,maxmem:64*1024*1024};
const safePath=(p:string)=>FILES.includes(p)||/^memory\/(?:[\w .-]+\/)*[\w .-]+\.md$/.test(p)&&!p.split('/').includes('..');

type Bundle={v:1;files:Record<string,string>;settings:Record<string,string>;reminders:Record<string,unknown>[]};

export function collect(store:Store,root:string):Bundle {
  const files:Record<string,string>={};
  for(const f of FILES){try{files[f]=readFileSync(join(root,f),'utf8');}catch{}}
  try{for(const f of readdirSync(join(root,'memory'),{recursive:true}) as string[])if(safePath('memory/'+f))files['memory/'+f]=readFileSync(join(root,'memory',f),'utf8');}catch{}
  const settings:Record<string,string>={};
  for(const k of SETTINGS){const v=store.get(k);if(v!==undefined)settings[k]=v;}
  // Plain reminders only: session reminders name sessions that won't exist on another computer.
  let reminders:Record<string,unknown>[]=[];
  try{reminders=store.db.prepare("SELECT * FROM schedules WHERE action='message' AND status='active'").all() as Record<string,unknown>[];}catch{}
  return {v:1,files,settings,reminders};
}

export function apply(store:Store,root:string,b:Bundle) {
  for(const [p,text] of Object.entries(b.files??{})) {
    if(!safePath(p)||typeof text!=='string')continue;
    const file=join(root,p),partial=file+'.restore';
    mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileSync(partial,text,{mode:0o600});renameSync(partial,file);
  }
  for(const [k,v] of Object.entries(b.settings??{}))if(SETTINGS.includes(k)&&typeof v==='string')store.set(k,v);
  const cols=['id','origin_id','owner','destination','channel','action','text','binding_id','binding_identity','date','time','zone','repeat','next_at','status','created_at'];
  const insert=store.db.prepare(`INSERT OR IGNORE INTO schedules(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`);
  for(const r of b.reminders??[])if(r?.action==='message')try{insert.run(...cols.map(c=>(r as any)[c]??null));}catch{}
}

export const bundleHash=(b:Bundle)=>createHash('sha256').update(JSON.stringify(b)).digest('hex');

// The settings are sealed with a random data key. That key is wrapped twice: once by the
// passphrase and once by a recovery code shown to the owner once. Either one opens the backup.
type Box={iv:string;tag:string;data:string};
type Wrap=Box&{salt:string};
export type Keys={key:string;wraps:{pass:Wrap;code:Wrap}};
const B32='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const lock=(key:Buffer,plain:Buffer):Box=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([c.update(plain),c.final()]);return {iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:data.toString('base64')};};
const unlock=(key:Buffer,b:Box)=>{const d=createDecipheriv('aes-256-gcm',key,Buffer.from(b.iv,'base64'));d.setAuthTag(Buffer.from(b.tag,'base64'));return Buffer.concat([d.update(Buffer.from(b.data,'base64')),d.final()]);};
const wrap=(secret:string,key:Buffer):Wrap=>{const salt=randomBytes(16);return {salt:salt.toString('base64'),...lock(scryptSync(secret,salt,32,SCRYPT),key)};};
/** Recovery codes ignore case, spaces and dashes so a hand-typed copy still works. */
export const normalCode=(code:string)=>code.toUpperCase().replace(/[^A-Z0-9]/g,'');
export const isRecoveryCode=(text:string)=>{const n=normalCode(text);return n.length===24&&[...n].every(ch=>B32.includes(ch));};
/** What the cloud stores (hashed) so a recovery code can get past the authenticator lock. It can't open the backup. */
export const recoveryProof=(code:string)=>createHmac('sha256',normalCode(code)).update('ffd-recovery-proof').digest('hex');

export function newKeys(passphrase:string):Keys&{recoveryCode:string;proof:string} {
  const bytes=randomBytes(24),raw=[...bytes].map(x=>B32[x%32]).join('');
  const recoveryCode=raw.match(/.{4}/g)!.join('-'),key=randomBytes(32);
  return {key:key.toString('base64'),wraps:{pass:wrap(passphrase,key),code:wrap(raw,key)},recoveryCode,proof:recoveryProof(raw)};
}

export function seal(b:Bundle,keys:Keys):string {
  return JSON.stringify({v:2,wraps:keys.wraps,...lock(Buffer.from(keys.key,'base64'),Buffer.from(JSON.stringify(b),'utf8'))});
}

/** Opens with the passphrase or the recovery code. Throws 'wrong passphrase' when neither fits. */
export function unseal(blob:string,secret:string):{bundle:Bundle;keys:Keys} {
  const box=JSON.parse(blob),wraps=box.wraps;
  for(const [w,s] of [[wraps?.pass,secret],[wraps?.code,normalCode(secret)]] as const){
    if(!w||!s)continue;
    try{
      const key=unlock(scryptSync(s,Buffer.from(w.salt,'base64'),32,SCRYPT),w);
      return {bundle:JSON.parse(unlock(key,box).toString('utf8')),keys:{key:key.toString('base64'),wraps}};
    }catch{}
  }
  throw new Error('wrong passphrase');
}
