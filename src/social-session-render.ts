import type {Binding,Store} from './store.js';
import {hash} from './store.js';
import {sessionSpecialty} from './session-specialty.js';
import {desktopSocialProof,socialImageProvider} from './desktop-social.js';
import type {SocialAssistant} from './social-assistant.js';
import {parseSocialPlan,renderSocialPlan} from './social-renderer.js';
const busy=new WeakSet<Store>();
export function assertCreativeRequest(store:Store,binding:Binding,id:unknown):asserts id is string {
  if(typeof id!=='string'||id.length>300||!(/^(wa:|tg:|local:social:)/.test(id)))throw Error('Use the exact Social request.');
  const s=sessionSpecialty(store,id),job=store.job(id);
  if(!s||s.kind!=='social'||s.bindingId!==binding.id||!binding.enabled||!job||!['dispatched','submitted'].includes(job.status)||store.controlChannel()!==(s.destination.startsWith('tg:')?'telegram':'whatsapp')||id.startsWith('local:')&&!desktopSocialProof(store,id,binding))throw Error('The Social request or selected session is no longer active.');
}
export async function renderSessionSocialCarousel(store:Store,binding:Binding,social:SocialAssistant,id:unknown,draftId:unknown,revision:unknown,input:unknown){
  assertCreativeRequest(store,binding,id);
  if(typeof draftId!=='string'||!/^[0-9a-f-]{36}$/i.test(draftId)||!Number.isSafeInteger(revision)||Number(revision)<1)throw Error('Use the saved draft ID and revision.');
  const p=parseSocialPlan(input),d=social.get(draftId) as any;
  if(d.requestId!==id)throw Error('This draft belongs to another request.');
  if(p.mode==='svg'&&socialImageProvider(store,id)==='meta')throw Error('Meta API is selected. Generate Meta artwork and use hybrid mode, or ask the owner to select Local SVG.');
  if(p.mode==='hybrid'&&socialImageProvider(store,id)!=='meta')throw Error('Local SVG skill is selected. Use SVG mode for this request.');
  const renderHash=hash(JSON.stringify([p,p.mode==='hybrid'?d.image?.sha256??'':'']));
  if(d.carousel?.renderHash===renderHash&&d.carousel.sourceRevision===revision&&d.revision===Number(revision)+1)return {status:'rendered',duplicate:true,draftId,revision:d.revision,slideCount:d.carousel.slides.length,width:1080,height:1350};
  if(d.revision!==revision||d.operation||d.publication)throw Error('Draft changed or has a pending operation. Reload it.');
  if(busy.has(store))throw Error('A carousel is rendering. Try again when it finishes.');
  busy.add(store);
  try{
    const slides=await renderSocialPlan(p,p.mode==='hybrid'&&d.image?Buffer.from(d.image.base64,'base64'):undefined);
    assertCreativeRequest(store,binding,id);
    const saved=social.saveCarousel(draftId,Number(revision),{mode:p.mode,plan:p,renderHash,sourceRevision:Number(revision),width:1080,height:1350,slides});
    return {status:'rendered',duplicate:false,draftId,revision:saved.revision,slideCount:slides.length,width:1080,height:1350};
  }finally{busy.delete(store);}
}
