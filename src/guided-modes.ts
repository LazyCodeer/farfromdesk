import type { Incoming, Router } from './router.js';
import { authenticatedOwner } from './owner-commands.js';
import {hash} from './store.js';
import {specialtyEpoch,specialtyIdentity} from './session-specialty.js';
import type {Binding} from './store.js';

export type GuidedKind = 'social';
type Session = { imageProvider?:'local'|'meta'; kind:GuidedKind; expires:number; busy:boolean; socialTarget?:{bindingId:string; identity:string; epoch:string} };
const socialKey=(key:string)=>`guided-social:${hash(key)}`;
/** Ephemeral mode selection is scoped to the paired owner and connection generation. */
export class GuidedModes {
  private sessions = new Map<string,Session>();
  constructor(private now=()=>Date.now(), private ttl=10*60_000) {}
  private key(r:Router,m:Incoming,voice=false):string|undefined {
    if(!authenticatedOwner(r,m)||!r.store.incomingOwnerCurrent()||m.quotedId)return;
    if(voice ? m.source!=='voice'||m.ownerIntent!==true : m.source==='voice'?m.ownerIntent!==true:m.ownerCommand!==true)return;
    const context=r.store.incomingOwnerContext.getStore();
    if(!context)return;
    return JSON.stringify([context.channel,context.destination,context.owner,context.generation]);
  }
  get(r:Router,m:Incoming):Session|undefined {
    const key=this.key(r,m);if(!key)return;
    let session=this.sessions.get(key);
    if(!session){
      try{const saved=JSON.parse(r.store.get(socialKey(key))??'null');
        if(saved?.kind==='social'&&Number.isFinite(saved.expires))session={kind:'social',expires:saved.expires,busy:false,...(['local','meta'].includes(saved.imageProvider)?{imageProvider:saved.imageProvider}:{}),...(saved.socialTarget?{socialTarget:saved.socialTarget}:{})};
      }catch{}
      if(session)this.sessions.set(key,session);
    }
    if(session&&session.expires<=this.now()){this.sessions.delete(key);if(session.kind==='social')r.store.set(socialKey(key),'null');return;}
    return session;
  }
  voice(r:Router,m:Incoming):Session|undefined {
    const key=this.key(r,m,true);if(!key)return;
    const session=this.get(r,m);
    if(session&&session.expires<=this.now()){this.sessions.delete(key);return;}
    return session;
  }
  start(r:Router,m:Incoming,kind:GuidedKind):boolean {
    const key=this.key(r,m);if(!key)return false;
    for(const [k,s] of this.sessions)if(s.expires<=this.now())this.sessions.delete(k);
    const session:Session={...(kind==='social'?{imageProvider:r.store.get('social-image-provider')==='meta'?'meta' as const:'local' as const}:{}),kind,expires:this.now()+(kind==='social'?24*60*60_000:this.ttl),busy:false};
    this.sessions.set(key,session);
    if(kind==='social')r.store.set(socialKey(key),JSON.stringify(session));else r.store.set(socialKey(key),'null');
    return true;
  }
  /** Called only by an authenticated native desktop Social dispatch. */
  startDesktopSocial(r:Router,b:Binding,imageProvider:'local'|'meta'='local'):void {
    const c=r.store.incomingOwnerContext.getStore();
    if(!c||!r.store.incomingOwnerCurrent())throw Error('The paired owner changed.');
    const key=JSON.stringify([c.channel,c.destination,c.owner,c.generation]);
    const session:Session={imageProvider,kind:'social',expires:this.now()+24*60*60_000,busy:false,socialTarget:{bindingId:b.id,identity:specialtyIdentity(r.store,b),epoch:specialtyEpoch(r.store)}};
    // Rehydrate after commit; a rolled-back dispatch must not leave a new in-memory mode.
    r.store.set(socialKey(key),JSON.stringify(session));this.sessions.delete(key);
  }
  /** Preserve task/provider selection after an explicit executor change. Old
   * requests retain their original identity; only future turns are retargeted. */
  retarget(r:Router):void {
    const c=r.store.incomingOwnerContext.getStore();
    if(!c||!r.store.incomingOwnerCurrent())return;
    const key=JSON.stringify([c.channel,c.destination,c.owner,c.generation]);
    let session=this.sessions.get(key);
    if(!session){try{const saved=JSON.parse(r.store.get(socialKey(key))??'null');if(saved?.kind==='social'&&saved.expires>this.now())session=saved;}catch{}}
    if(!session||session.expires<=this.now())return;
    delete session.socialTarget;session.busy=false;
    this.sessions.set(key,session);
    if(session.kind==='social')r.store.set(socialKey(key),JSON.stringify(session));
  }
  summary(r:Router,m:Incoming):string {
    const mode=this.get(r,m);
    return mode?`Mode: ${mode.kind[0].toUpperCase()+mode.kind.slice(1)}${mode.kind==='social'?` · Images: ${mode.imageProvider==='meta'?'Meta API':'Local SVG'}`:''}`:'Mode: General';
  }
  close(r:Router,m:Incoming):boolean {
    const key=this.key(r,m);if(!key)return false;
    r.store.set(socialKey(key),'null');return this.sessions.delete(key);
  }
  /** Only call after a channel-authenticated target choice was claimed. */
  closeForClaimedChoice(r:Router):boolean {
    const c=r.store.incomingOwnerContext.getStore();
    if(!c||!r.store.incomingOwnerCurrent())return false;
    const key=JSON.stringify([c.channel,c.destination,c.owner,c.generation]);
    r.store.set(socialKey(key),'null');return this.sessions.delete(key);
  }
  busyForContext(r:Router):boolean {
    const c=r.store.incomingOwnerContext.getStore();if(!c||!r.store.incomingOwnerCurrent())return false;
    const s=this.sessions.get(JSON.stringify([c.channel,c.destination,c.owner,c.generation]));
    return !!s&&s.expires>this.now()&&s.busy;
  }
  begin(r:Router,m:Incoming):Session|undefined {
    const session=this.get(r,m);if(!session||session.busy)return;
    session.busy=true;return session;
  }
  end(session:Session,r?:Router,m?:Incoming){
    session.busy=false;session.expires=this.now()+(session.kind==='social'?24*60*60_000:this.ttl);
    if(session.kind==='social'&&r&&m){const key=this.key(r,m);if(key&&this.sessions.get(key)===session)r.store.set(socialKey(key),JSON.stringify(session));}
  }
}
