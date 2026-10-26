import { jidNormalizedUser, type WASocket } from '@whiskeysockets/baileys';

export function isSelfMessage(key:{fromMe?:boolean|null;remoteJid?:string|null;remoteJidAlt?:string|null},owners:string[]) {
  if(key.fromMe!==true)return false;
  return [key.remoteJid,key.remoteJidAlt].some(j=>j&&owners.includes(jidNormalizedUser(j)));
}
export function ownerOnlyGroup(metadata:any,owners:string[]) {
  return Array.isArray(metadata?.participants)&&metadata.participants.length>0&&metadata.participants.every((p:any)=>
    [p.id,p.phoneNumber,p.lid].some(id=>typeof id==='string'&&owners.includes(jidNormalizedUser(id))));
}

export type ChatPolicy={owners:()=>string[];ownedGroup:(jid:string)=>boolean};
const EVENTS=['creds.update','connection.update','messages.upsert','messages.update','message-receipt.update'] as const;
type GuardedEvent=typeof EVENTS[number];
const CONTENT_KEYS=new Set(['text','document','fileName','mimetype','caption']);

/** The only WhatsApp surface the app gets. A linked device can read and send in every chat,
 * so this is the one place that limits FarFromDesk to the owner's own chat and the
 * owner-only groups it registered: other chats are dropped before any app code sees them,
 * and sends, relays and group lookups anywhere else throw. */
export class GuardedSocket {
  // A real private field: the raw socket cannot be reached even with `as any`.
  #raw:WASocket;#policy:ChatPolicy;
  constructor(raw:WASocket,policy:ChatPolicy){this.#raw=raw;this.#policy=policy;Object.freeze(this);}
  get user(){return this.#raw.user;}
  private selfChat(jid?:string|null){return !!jid&&!jid.endsWith('@g.us')&&this.#policy.owners().includes(jidNormalizedUser(jid));}
  allowedChat(jid?:string|null){return !!jid&&(this.selfChat(jid)||jid.endsWith('@g.us')&&this.#policy.ownedGroup(jid));}
  private allowedKey(key:any){return key?.fromMe===true&&(this.allowedChat(key.remoteJid)||this.selfChat(key.remoteJidAlt));}
  private target(jid:string){if(!this.allowedChat(jid))throw new Error('Blocked: FarFromDesk only sends to your own chat or your owner-only group.');return jid;}
  ev={on:<E extends GuardedEvent>(event:E,handler:(data:any)=>void)=>{
    if(!EVENTS.includes(event))throw new Error(`Blocked WhatsApp event: ${event}`);
    const filtered=event==='messages.upsert'?(e:any)=>{const messages=(e?.messages??[]).filter((m:any)=>this.allowedKey(m?.key));if(messages.length)handler({...e,messages});}
      :event==='messages.update'||event==='message-receipt.update'?(u:any[])=>{const kept=(u??[]).filter(x=>this.allowedKey(x?.key));if(kept.length)handler(kept);}
      :handler;
    this.#raw.ev.on(event,filtered as any);
  }};
  sendMessage(jid:string,content:Record<string,unknown>,options:{messageId:string}) {
    if(Object.keys(content).some(k=>!CONTENT_KEYS.has(k)))throw new Error('Blocked: only text and documents can be sent.');
    return this.#raw.sendMessage(this.target(jid),content as any,{messageId:options.messageId});
  }
  relayMessage(jid:string,message:Parameters<WASocket['relayMessage']>[1],options:{messageId:string}){return this.#raw.relayMessage(this.target(jid),message,{messageId:options.messageId});}
  groupMetadata(jid:string){if(!jid.endsWith('@g.us')||!this.#policy.ownedGroup(jid))throw new Error('Blocked: this group is not registered to FarFromDesk.');return this.#raw.groupMetadata(jid);}
  groupCreate(subject:string,participants:string[]){if(participants.length)throw new Error('Blocked: FarFromDesk only creates groups with just you in them.');return this.#raw.groupCreate(subject,[]);}
  // Other groups' names and members never leave this method.
  async groupFetchAllParticipating(){
    const all=await this.#raw.groupFetchAllParticipating(),owners=this.#policy.owners();
    return Object.fromEntries(Object.entries(all).filter(([,g])=>ownerOnlyGroup(g,owners)));
  }
  refreshMediaConn(force?:boolean){return this.#raw.refreshMediaConn(force);}
  logout(){return this.#raw.logout();}
  end(error?:Error){this.#raw.end(error);}
}
