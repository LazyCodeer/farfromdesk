import {hash,type Binding,type Store} from './store.js';
import type {Router} from './router.js';
import {sessionSpecialty,prepareSpecialties,bindSessionSpecialty,specialtyEpoch,specialtyIdentity} from './session-specialty.js';
import {socialSpecialty} from './social-agent.js';
import {researchCommand} from './agent-reach-request.js';

export type SocialImageProvider='local'|'meta';
type DesktopSocial={imageProvider?:SocialImageProvider;bindingId:string;bodyHash:string;owner:string;destination:string;channel:'whatsapp'|'telegram';generation:string;identity:string;epoch:string};
const key=(id:string)=>`desktop-social:${id}`;

/** Checks the original desktop request, exact session and still-paired owner. */
export function desktopSocialProof(store:Store,id:string,binding?:Binding):DesktopSocial|undefined {
  if(!/^local:social:[0-9a-f-]{36}$/i.test(id))return;
  try{
    const proof=JSON.parse(store.get(key(id))??'null') as DesktopSocial|null,job=store.job(id),b=proof&&store.binding(proof.bindingId);
    if(!proof||!job||!b?.enabled||binding&&binding.id!==b.id||job.binding_id!==b.id||hash(job.body)!==proof.bodyHash||job.destination!==proof.destination||store.controlChannel()!==proof.channel||store.ownerFor(proof.destination)!==proof.owner||(store.get('incoming-owner-generation')??'')!==proof.generation||specialtyIdentity(store,b)!==proof.identity||specialtyEpoch(store)!==proof.epoch)return;
    return proof;
  }catch{return;}
}

/** The local desktop is a distinct origin, never a synthetic phone message. */
export function dispatchDesktopSocial(store:Store,router:Router,input:unknown) {
  if(router.stopped)throw Error('Start the bridge before generating Social drafts.');
  const d=input as any;
  if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(k=>!['bindingId','prompt','platforms','eventId','imageProvider'].includes(k)))throw Error('Choose a session and describe the Social request.');
  if(typeof d.eventId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(d.eventId))throw Error('A stable request ID is required.');
  if(typeof d.bindingId!=='string'||!d.bindingId||typeof d.prompt!=='string'||!d.prompt.trim()||d.prompt.length>2000)throw Error('Choose a session and enter a prompt.');
  if(!Array.isArray(d.platforms)||d.platforms.length<1||d.platforms.length>12||d.platforms.some((p:unknown)=>typeof p!=='string'||!p.trim()||p.length>60||/[\r\n]/.test(p)))throw Error('Choose one or more platforms.');
  if(d.imageProvider!==undefined&&!['local','meta'].includes(d.imageProvider))throw Error('Choose Local SVG skill or Meta API.');
  const imageProvider:SocialImageProvider=d.imageProvider??'local';
  const b=store.binding(d.bindingId);if(!b?.enabled)throw Error('That session is unavailable. Choose a connected session.');
  const channel=store.controlChannel(),destination=store.get(channel==='telegram'?'telegram-owner':'whatsapp-owner');
  if(!destination)throw Error('Connect your owner chat first so the session can ask questions and send the result.');
  const owner=store.captureIncomingOwner(destination,channel);if(!owner||owner.owner!==destination)throw Error('The owner chat is unavailable.');
  const id=`local:social:${d.eventId}`,body=`${d.prompt.trim()}\n\nRequested platforms: ${d.platforms.map((p:string)=>p.trim()).join(', ')}`;
  return store.incomingOwnerContext.run(owner,()=>store.destinationContext.run(destination,()=>{
    prepareSpecialties(store);
    const existing=store.job(id);
    if(existing){const proof=desktopSocialProof(store,id,b);if(!proof||existing.body!==body||(proof.imageProvider??'local')!==imageProvider)throw Error('This request ID was already used or its session changed.');return {requestId:id,status:existing.status,duplicate:true};}
    if(imageProvider==='meta'&&!router.brain.view().configured)throw Error('Add a Meta Model API key in Brain settings, or choose Local SVG skill.');
    store.db.exec('SAVEPOINT desktop_social_dispatch');
    try{
      store.enqueue(id,b,body,destination);store.recordIncomingInput(id);
      const proof:DesktopSocial={imageProvider,bindingId:b.id,bodyHash:hash(body),...owner,identity:specialtyIdentity(store,b),epoch:specialtyEpoch(store)};
      store.set(key(id),JSON.stringify(proof));
      // Only a public research request explicitly written by the owner is sent to the public provider.
      if(/^(?:research\b|search\s+(?:the\s+)?(?:web|internet)\s+for\b|look\s+up\b|research:\s*\/reach\s+)/i.test(d.prompt.trim())){
        const command=researchCommand(d.prompt.trim(),false);
        if(command)store.set(`reach-owner-request:${id}`,JSON.stringify({...owner,bodyHash:hash(body),command,kind:'social'}));
      }
      bindSessionSpecialty(store,id,b,'social',socialSpecialty(imageProvider),imageProvider);
      router.guidedModes.startDesktopSocial(router,b,imageProvider);
      store.db.exec('RELEASE desktop_social_dispatch');
    }catch(e){store.db.exec('ROLLBACK TO desktop_social_dispatch; RELEASE desktop_social_dispatch');throw e;}
    router.pump();return {requestId:id,status:'queued',duplicate:false};
  }));
}

/** Desktop choices are bound to the original request, never inferred from model output. */
export function socialImageProvider(store:Store,id:string):SocialImageProvider {
  if(id.startsWith('local:'))return desktopSocialProof(store,id)?.imageProvider??'local';
  return sessionSpecialty(store,id)?.imageProvider??'local';
}
