import {createHash} from 'node:crypto';
import type {Store,Binding} from './store.js';
import {Artifacts} from './artifacts.js';
import {sessionSpecialty} from './session-specialty.js';

export function prepareSocialPreviews(store:Store){
 store.db.exec(`CREATE TABLE IF NOT EXISTS social_preview_order(outbox_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,position INTEGER NOT NULL,UNIQUE(request_id,position));`);
}
/** Ordering only. All normal owner/channel/artifact guards still apply. */
export function socialPreviewDeliveryState(store:Store,id:string):'ready'|'hold'|'invalid'{
 const current=store.db.prepare('SELECT request_id,position FROM social_preview_order WHERE outbox_id=?').get(id) as any;
 if(!current)return 'ready';
 const prior=store.db.prepare('SELECT o.status FROM social_preview_order p JOIN outbox o ON o.id=p.outbox_id WHERE p.request_id=? AND p.position<?').all(current.request_id,current.position) as {status:string}[];
 if(prior.some(p=>['failed','uncertain','cancelled'].includes(p.status))){
  store.db.prepare("UPDATE outbox SET status='cancelled',error='An earlier post preview was not confirmed; inspect delivery before retrying.' WHERE id=? AND status='queued'").run(id);return 'invalid';
 }
 return prior.some(p=>p.status!=='sent')?'hold':'ready';
}
/** The preview already carries each draft's caption, so the final reply drops a verbatim copy
 * (the owner saw it twice, live 5 Nov 2026). Only an exact copy is replaced; anything else stays. */
export function withoutPreviewCaptions(store:Store,requestId:string,text:string):string{
 if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='social_drafts'").get())return text;
 let out=text;
 for(const row of store.db.prepare("SELECT json FROM social_drafts WHERE json_extract(json,'$.requestId')=?").all(requestId) as {json:string}[]){
  const caption=String(JSON.parse(row.json).caption??'').trim();
  if(caption.length>=40&&out.includes(caption))out=out.replace(caption,'The caption is with the image above, ready to copy.');
 }
 return out;
}
/** Called inside the final-reply transaction, only for the original owner route.
 * Existing drafts are never scanned or sent on startup. */
export function queueSocialPreviews(store:Store,b:Binding,requestId:string){
 const specialty=sessionSpecialty(store,requestId);if(specialty?.kind!=='social')return [];
 if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='social_drafts'").get())return [];
 const previous=store.db.prepare('SELECT o.id,o.status FROM social_preview_order p JOIN outbox o ON o.id=p.outbox_id WHERE p.request_id=? ORDER BY p.position').all(requestId);
 if(previous.length)return previous;
 const drafts=store.db.prepare("SELECT id,revision,json FROM social_drafts WHERE json_extract(json,'$.requestId')=? ORDER BY rowid").all(requestId) as {id:string;revision:number;json:string}[];
 const artifacts=new Artifacts(store),queued:{id:string;status:string}[]=[];
 const remember=(row:any)=>{store.db.prepare('INSERT OR IGNORE INTO incoming_owner_outbox VALUES(?,?,?,?,?)').run(row.id,specialty.owner,specialty.destination,specialty.destination.startsWith('tg:')?'telegram':'whatsapp',specialty.generation);store.db.prepare('INSERT INTO social_preview_order VALUES(?,?,?)').run(row.id,requestId,queued.length);queued.push({id:row.id,status:row.status});};
 for(const row of drafts){
  const d=JSON.parse(row.json),slides=d.carousel?.slides??(d.image?[d.image]:[]);
  if(!slides.length)continue;
  if(slides.length>8||drafts.length>12)throw Error('Too many Social previews for one request.');
  const platform=typeof d.platform==='string'?d.platform.slice(0,60):'Social';
  const caption=typeof d.caption==='string'?d.caption:'';
  const inline=(`${platform}\n\n${caption}`).length<=950;
  for(const [index,slide] of slides.entries()){
   const bytes=Buffer.from(slide.base64??'','base64');
   if(bytes.toString('base64')!==slide.base64||createHash('sha256').update(bytes).digest('hex')!==slide.sha256)throw Error('Saved Social preview failed its image integrity check.');
   const file=artifacts.prepare(b,requestId,`post-${row.id}-r${row.revision}-${index+1}.jpg`,slide.base64);
   const label=`${platform}${slides.length>1?` · ${index+1}/${slides.length}`:''}`;
   const text=index===0?(inline?`${label}\n\n${caption}`:`${label}\nFull caption follows after the images.`):label;
   remember(artifacts.reply(b,requestId,file.artifactId,text,'photo'));
  }
  if(!inline){
   const source=`social-caption:${requestId}:${row.id}:${row.revision}`;
   store.output(b,`${platform} · Caption\n\n${caption}`,source,specialty.destination,{requestId,kind:'progress',origin:'system',plain:true});
   for(const part of store.db.prepare('SELECT id,status FROM outbox WHERE source LIKE ? ORDER BY rowid').all(source+':%'))remember(part);
  }
 }
 return queued;
}
