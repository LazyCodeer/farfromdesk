import type {Binding,Store} from './store.js';
import type {SocialAssistant} from './social-assistant.js';
import {sessionSpecialty} from './session-specialty.js';
import {desktopSocialProof,socialImageProvider} from './desktop-social.js';
import {generateMetaImage,type MetaImageTransport} from './social-meta-image.js';
import {safeSocialJpeg} from './social-jpeg.js';
import sharp from 'sharp';

/** Render only a saved draft from this active, owner-authorized request. */
export async function renderSessionSocialImage(store:Store,binding:Binding,social:SocialAssistant,key:()=>string|undefined,requestId:unknown,draftId:unknown,transport:MetaImageTransport=fetch){
  if(typeof requestId!=='string'||!(/^(?:wa:|tg:|local:social:)/.test(requestId))||typeof draftId!=='string'||!/^[0-9a-f-]{36}$/i.test(draftId))throw Error('Use the current Social request and saved draft.');
  const current=()=>{
    const s=sessionSpecialty(store,requestId),job=store.job(requestId);
    return !!s&&s.kind==='social'&&s.bindingId===binding.id&&binding.enabled&&!!job&&['dispatched','submitted'].includes(job.status)&&store.controlChannel()===(s.destination.startsWith('tg:')?'telegram':'whatsapp')&&(!requestId.startsWith('local:')||!!desktopSocialProof(store,requestId,binding));
  };
  if(!current())throw Error('The Social request or selected session is no longer active.');
  if(socialImageProvider(store,requestId)!=='meta')throw Error('Local SVG skill is selected for this request. Use social-render; Meta images are disabled.');
  const job=store.job(requestId)!;
  // A generated prompt or a web page cannot authorize a paid Meta request.
  if(desktopSocialProof(store,requestId,binding)?.imageProvider!=='meta'&&!/\b(?:image|images|visual|visuals|picture|pictures|graphic|graphics|artwork|illustration|illustrations|carousel|infographic)\b/i.test(job.body))throw Error('Ask the owner to request an image or carousel before generating media.');
  const draft=social.get(draftId) as any;
  if(draft.requestId!==requestId||!draft.imagePrompt||draft.image)throw Error('This request has no eligible saved image prompt.');
  const apiKey=key();if(!apiKey)throw Error('Add a Meta Model API key in Brain settings for image generation.');
  store.db.exec('CREATE TABLE IF NOT EXISTS social_image_claims (request_id TEXT NOT NULL, draft_id TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(request_id,draft_id))');
  store.db.exec('SAVEPOINT social_image_claim');
  try{
    const claim=store.db.prepare("INSERT OR IGNORE INTO social_image_claims(request_id,draft_id,status) VALUES (?,?,'started')").run(requestId,draftId);
    if(!claim.changes)throw Error('This image was already requested or interrupted. Do not retry automatically.');
    const count=store.db.prepare('SELECT COUNT(*) AS n FROM social_image_claims WHERE request_id=?').get(requestId) as {n:number};
    if(count.n>4||!current())throw Error('Image limit reached or the owner connection changed.');
    store.db.exec('RELEASE social_image_claim');
  }catch(e){store.db.exec('ROLLBACK TO social_image_claim; RELEASE social_image_claim');throw e;}
  let operationId:string|undefined;
  try{
    if(!current())throw Error('The owner connection changed.');
    const op=social.begin(draftId,draft.revision,'image');operationId=op.operationId;
    const image=await generateMetaImage({prompt:draft.imagePrompt,apiKey},transport);
    if(!safeSocialJpeg(image.bytes))throw Error('Meta returned an invalid image.');
    let thumbnail:string|undefined;
    try{const bytes=await sharp(image.bytes,{limitInputPixels:16_777_216}).resize(480,600,{fit:'inside',withoutEnlargement:true}).jpeg({quality:75}).toBuffer();if(bytes.length<=100_000)thumbnail=bytes.toString('base64');}catch{/* The original can still be saved if a preview cannot be made. */}
    if(!current())throw Error('The owner connection changed.');
    const saved=social.complete(draftId,operationId,{base64:Buffer.from(image.bytes).toString('base64'),...(thumbnail?{thumbnail}:{})});
    store.db.prepare("UPDATE social_image_claims SET status='completed' WHERE request_id=? AND draft_id=?").run(requestId,draftId);
    return {draftId,revision:saved.revision,status:'generated'};
  }catch{
    if(operationId)try{social.fail(draftId,operationId);}catch{}
    store.db.prepare("UPDATE social_image_claims SET status='uncertain' WHERE request_id=? AND draft_id=?").run(requestId,draftId);
    throw Error('Image generation did not complete locally. The outcome may be unknown; do not retry automatically.');
  }
}
