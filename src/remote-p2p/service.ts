import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {RemotePasswordAccess} from '../remote-desktop/access.js';
import {P2PHost} from './host.js';
import {NativeDesktopBackend} from './desktop.js';
import {SIGNAL_PREFIX,type Transcriber} from './protocol.js';
import {transcribeAudio} from '../audio.js';
import {voiceEngine} from '../voice-cloud.js';
import type {Store} from '../store.js';

const nativeRoot=fileURLToPath(new URL('../../native/',import.meta.url));
// Plain requests to take over the screen. Requests to do something in an app stay with the coordinator.
// After "give me screen access" only a fixed courtesy or "i will do it myself" may follow, never another request.
const command=/^(?:\/remote|(?:(?:i (?:want|need|would like) to|let me|can i|please|pls)\s+)?(?:take |get |have )?(?:control|access|open|share|remote(?: into)?)(?: of| to| into)? (?:my |the |this )?(?:screen|mac|macbook|computer|laptop|desktop|pc)(?: remotely)?|(?:give|send|share with) me (?:the |a )?(?:screen|remote|mac|desktop|computer|laptop) (?:access|control|link)(?:[,.!]?\s+(?:please|pls|now|thanks|thank you|i(?: will|'ll) (?:do|create|handle) it (?:my ?self|myself)))?|remote (?:control|desktop|access))[.!?]?$/i;
const answer=new RegExp('^'+SIGNAL_PREFIX.trim()+'\\s+([A-Za-z0-9_-]{20,4000})$');
const refused:Record<string,string>={OFFER_EXPIRED:'That link has expired. Send "control my screen" for a new one.',ANSWER_REFUSED:'That code does not match your latest link. Send "control my screen" for a new one.',INVALID_SIGNAL:'That code looks incomplete. Copy it again from the phone page and send it here.'};

/** The owner's own voice setup, the one WhatsApp voice notes use: local Whisper, or their provider key over HTTPS. */
export function voiceTranscriber(store:Store):Transcriber{
 return {
  get engine(){return voiceEngine(store)==='local'?'local' as const:'cloud' as const;},
  async transcribe(audio,mime,signal){
   const dir=mkdtempSync(join(tmpdir(),'ffd-voice-')),path=join(dir,'voice');writeFileSync(path,audio,{mode:0o600});
   const media={path,filename:'voice',bytes:audio.length,sha256:createHash('sha256').update(audio).digest('hex'),mime,dispose:()=>rmSync(dir,{recursive:true,force:true})};
   try{return await transcribeAudio(store,{mimetype:mime,fileLength:audio.length},signal,undefined,async()=>media,{kind:'remote'});}finally{media.dispose();}
  },
 };
}

/** Owner chat is the signaling path: the link goes out and the phone's code comes back here. */
export class RemoteControlService {
 private host?:P2PHost;
 constructor(private access:RemotePasswordAccess,private make=(access:RemotePasswordAccess,onReconnect?:(link:string,password:boolean)=>void)=>new P2PHost({access,onReconnect,backend:()=>new NativeDesktopBackend(join(nativeRoot,'session-state')),transcriber:this.transcriber}),private notify?:(text:string)=>void,private transcriber?:Transcriber){}
 /** Returns the reply for a remote-control chat message, or undefined for any other message. */
 async chat(text:string):Promise<string|undefined>{
  const code=answer.exec(text)?.[1];
  if(code){
   if(!this.host)return refused.ANSWER_REFUSED;
   try{await this.host.acceptAnswer(code);}catch(e){return refused[(e as Error).message]??'Could not connect with that code. Send "control my screen" for a new link.';}
   return 'Code received. Your phone is connecting. Enter your remote password there.';
  }
  if(!command.test(text))return;
  if(process.platform!=='darwin')return 'Screen control works on a Mac for now.';
  if(!this.access.status.passwordSet)return 'Set a remote password first. On your Mac, open FarFromDesk, then Settings > Remote control, and set your remote password.';
  // One host for the whole time, so a login kept after a dropped connection survives a new link.
  this.access.enable(true);this.host??=this.make(this.access,(link,password)=>this.notify?.(`Your phone lost the connection. Open this link in the next 5 minutes to continue, ${password?'then enter your remote password':'no password needed'}:\n${link}\n\nThen send back the code it shows.`));
  const offer=await this.host.createOffer();
  return `Open this link on your phone in the next 5 minutes:\n${offer.link}\n\nThe page gives you a code. Send that code back here, then enter your remote password on the phone.`;
 }
 get status(){return this.host?.status??{state:'idle' as const};}
 stop(){this.host?.stop('STOPPED');this.host=undefined;}
}
