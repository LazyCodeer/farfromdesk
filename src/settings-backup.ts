// FarFromDesk Pro settings backup. Sealed here with a key derived from the owner's passphrase,
// so the cloud only ever holds ciphertext. Losing the passphrase loses the backup.
import {createCipheriv,createDecipheriv,createHash,randomBytes,scryptSync} from 'node:crypto';
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

export const newKey=(passphrase:string)=>{const salt=randomBytes(16);return {salt:salt.toString('base64'),key:scryptSync(passphrase,salt,32,SCRYPT).toString('base64')};};
export const bundleHash=(b:Bundle)=>createHash('sha256').update(JSON.stringify(b)).digest('hex');

export function seal(b:Bundle,key:string,salt:string):string {
  const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',Buffer.from(key,'base64'),iv);
  const data=Buffer.concat([c.update(JSON.stringify(b),'utf8'),c.final()]);
  return JSON.stringify({v:1,salt,iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:data.toString('base64')});
}

/** Throws 'wrong passphrase' when the passphrase doesn't open this backup. */
export function unseal(blob:string,passphrase:string):{bundle:Bundle;key:string;salt:string} {
  const box=JSON.parse(blob),key=scryptSync(passphrase,Buffer.from(box.salt,'base64'),32,SCRYPT);
  try{
    const d=createDecipheriv('aes-256-gcm',key,Buffer.from(box.iv,'base64'));d.setAuthTag(Buffer.from(box.tag,'base64'));
    const bundle=JSON.parse(Buffer.concat([d.update(Buffer.from(box.data,'base64')),d.final()]).toString('utf8'));
    return {bundle,key:key.toString('base64'),salt:box.salt};
  }catch{throw new Error('wrong passphrase');}
}
