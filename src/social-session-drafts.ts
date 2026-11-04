import {randomUUID} from 'node:crypto';
import {hash,type Binding,type Store} from './store.js';
import {sessionSpecialty} from './session-specialty.js';
import {sourceUrl} from './agent-reach.js';
import {desktopSocialProof} from './desktop-social.js';

type SocialDraftInput={platform:string;format:string;title:string;caption:string;creativeBrief:string;imagePrompt:string;sources:{title:string;url:string}[]};
const text=(value:unknown,max:number,label:string)=>{
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`Invalid ${label}.`);
  return value.trim();
};

/** Save one exact request's generated drafts. Does not post, upload or send. */
export function saveSessionSocialDrafts(store:Store,binding:Binding,requestId:unknown,eventId:unknown,input:unknown) {
  if(typeof requestId!=='string'||requestId.length>300||!store.socialRequestId(requestId)||requestId.startsWith('local:')&&!desktopSocialProof(store,requestId,binding))throw new Error('Use the exact Social owner request.');
  if(typeof eventId!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(eventId))throw new Error('A stable draft event ID is required.');
  if(!Array.isArray(input)||input.length<1||input.length>12)throw new Error('Provide one to twelve generated drafts.');
  const drafts:SocialDraftInput[]=input.map((value:any)=>{
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['platform','format','title','caption','creativeBrief','imagePrompt','sources'].includes(k)))throw new Error('Invalid draft fields.');
    const sourceList=value.sources??[];
    if(!Array.isArray(sourceList)||sourceList.length>10)throw new Error('Invalid sources.');
    const sources=sourceList.map((source:any)=>{
      if(!source||typeof source!=='object'||Object.keys(source).some(k=>!['title','url'].includes(k)))throw new Error('Invalid source.');
      const url=sourceUrl(source.url,'web');if(!url)throw new Error('Invalid public source URL.');
      return {title:text(source.title,300,'source title'),url};
    });
    const optional=(v:unknown,max:number,label:string)=>v===undefined?'':text(v,max,label);
    return {platform:text(value.platform,60,'platform'),format:text(value.format,100,'format'),title:text(value.title,200,'title'),caption:text(value.caption,10000,'draft'),creativeBrief:optional(value.creativeBrief,10000,'creative brief'),imagePrompt:optional(value.imagePrompt,4000,'image prompt'),sources};
  });
  // Preserve the existing batch digest for older requests with no creative fields.
  const contentHash=hash(JSON.stringify(drafts.map(d=>({platform:d.platform,format:d.format,title:d.title,caption:d.caption,sources:d.sources,...(d.creativeBrief?{creativeBrief:d.creativeBrief}:{}),...(d.imagePrompt?{imagePrompt:d.imagePrompt}:{})}))));
  store.db.exec('SAVEPOINT social_session_save');
  try {
    const specialty=sessionSpecialty(store,requestId),job=store.job(requestId);
    if(!specialty||specialty.kind!=='social'||specialty.bindingId!==binding.id||!binding.enabled||!job||!['dispatched','submitted'].includes(job.status)||store.controlChannel()!==(specialty.destination.startsWith('tg:')?'telegram':'whatsapp'))throw new Error('The Social request or selected session is no longer active.');
    store.db.exec('CREATE TABLE IF NOT EXISTS social_session_batches(request_id TEXT NOT NULL,event_id TEXT NOT NULL,binding_id TEXT NOT NULL,content_hash TEXT NOT NULL,draft_ids TEXT NOT NULL,PRIMARY KEY(request_id,event_id))');
    const prior=store.db.prepare('SELECT binding_id,content_hash,draft_ids FROM social_session_batches WHERE request_id=? AND event_id=?').get(requestId,eventId) as {binding_id:string;content_hash:string;draft_ids:string}|undefined;
    if(prior){if(prior.binding_id!==binding.id||prior.content_hash!==contentHash)throw new Error('Draft event was reused with different content.');store.db.exec('RELEASE social_session_save');return {draftIds:JSON.parse(prior.draft_ids),duplicate:true};}
    const insert=store.db.prepare('INSERT INTO social_drafts (id,revision,json) VALUES (?,1,?)'),createdAt=new Date().toISOString();
    const ids=drafts.map(item=>{
      const id=randomUUID(),draft={id,revision:1,brief:item.title,caption:item.caption,creativeBrief:item.creativeBrief,imagePrompt:item.imagePrompt,imageUrl:'',aiGenerated:false,platform:item.platform,format:item.format,sources:item.sources,createdAt,updatedAt:createdAt,requestId};
      insert.run(id,JSON.stringify(draft));return id;
    });
    store.db.prepare('INSERT INTO social_session_batches(request_id,event_id,binding_id,content_hash,draft_ids) VALUES(?,?,?,?,?)').run(requestId,eventId,binding.id,contentHash,JSON.stringify(ids));
    store.db.exec('RELEASE social_session_save');return {draftIds:ids,duplicate:false};
  }catch(e){store.db.exec('ROLLBACK TO social_session_save; RELEASE social_session_save');throw e;}
}
