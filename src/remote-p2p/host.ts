import {randomBytes} from 'node:crypto';
import {RTCPeerConnection,type RTCDataChannel} from 'werift';
import type {RemotePasswordAccess} from '../remote-desktop/access.js';
import {CONTROL_CHANNEL,FRAME_CHANNEL,LOGIN_MS,MAC_IDLE_MS,PAUSE_MS,MAX_VOICE_BYTES,OFFER_TTL_MS,PAGE_URL,STUN_URLS,VOICE_CHUNK_CHARS,VOICE_MIMES,chunkFrame,inputError,type DesktopBackend,type DesktopFrame,type Input,type MacMessage,type Transcriber} from './protocol.js';
import {decodeSignal,encodeSignal,sdpToSignal,signalToSdp} from './signal-codec.js';

type State='idle'|'offered'|'connecting'|'connected'|'ended';
/** What a queued job runs against, fixed when it starts: a pause or new login replaces these on the session, not here. */
type Job={epoch:number;backend:DesktopBackend;signal:AbortSignal};
type Session={id:string;pc:RTCPeerConnection;control:RTCDataChannel;frames:RTCDataChannel;expiresAt:number;abort:AbortController;watch?:ReturnType<typeof setInterval>;
 token?:string;backend?:DesktopBackend;authing:boolean;locked:boolean;paused?:boolean;epoch:number;activeAt:number;loginBy?:number;transcribing?:boolean;voice?:{id:string;mime:string;chunks:Buffer[];bytes:number};attempts:number;misses:number;frameId:number;frame?:DesktopFrame;prev?:DesktopFrame;pulling:boolean;seen:Set<string>;queue:Promise<void>};
const MAX_BUFFERED=1<<20,MAX_ATTEMPTS=5,READY_MISSES=3,CAPTURE_TRIES=3,RESUME_MS=10*60_000;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

/** Mac side of phone remote control: one viewer over WebRTC data channels, password per connection.
 * Never logs passwords, signal codes or frame bytes.
 */
export class P2PHost{
 private session?:Session;private state:State='idle';private reason?:string;private detail?:string;
 /** After an authenticated phone drops, its access token is kept for a while so a fresh link reconnects without the password. */
 private resume?:{secret:string;token:string;until:number;timer:ReturnType<typeof setTimeout>;activeAt?:number};
 constructor(private opts:{access:RemotePasswordAccess;backend:()=>DesktopBackend;stun?:string[];now?:()=>number;rtc?:typeof RTCPeerConnection;onReconnect?:(link:string,password:boolean)=>void;transcriber?:Transcriber}){}
 private now(){return (this.opts.now??Date.now)();}
 get status(){return {state:this.state,session:this.session?.id,reason:this.reason,resumable:!!this.resume,...this.detail?{detail:this.detail}:{}};}

 async createOffer(){
  this.stop('REPLACED');
  const stun=this.opts.stun??STUN_URLS,RTC=this.opts.rtc??RTCPeerConnection;
  // werift deep-merges config, so [] would keep its default Google STUN; an empty urls list really disables it.
  const pc=new RTC({iceServers:[{urls:stun.length?stun:[]}],maxMessageSize:262144} as any);
  const control=pc.createDataChannel(CONTROL_CHANNEL.label,{negotiated:true,id:CONTROL_CHANNEL.id,ordered:true});
  const frames=pc.createDataChannel(FRAME_CHANNEL.label,{negotiated:true,id:FRAME_CHANNEL.id,ordered:true});
  const id=randomBytes(12).toString('base64url'),expiresAt=this.now()+OFFER_TTL_MS;
  const s:Session={id,pc,control,frames,expiresAt,abort:new AbortController(),authing:false,locked:false,epoch:0,activeAt:0,attempts:0,misses:0,frameId:0,pulling:false,seen:new Set(),queue:Promise.resolve()};
  this.session=s;this.state='offered';this.reason=undefined;this.detail=undefined;this.opts.access.setReady(true);
  pc.connectionStateChange.subscribe(st=>{if(st==='failed'||st==='closed')this.end(s,'CONNECTION_LOST');});
  control.stateChanged.subscribe(st=>{if(st==='open'&&this.session===s)this.state='connected';else if(st==='closed')this.end(s,'CONNECTION_LOST');});
  control.onMessage.subscribe(data=>void this.onControl(s,data));
  s.watch=setInterval(()=>void this.watch(s),2000);
  await pc.setLocalDescription(await pc.createOffer());
  const until=Date.now()+5000;while(pc.iceGatheringState!=='complete'&&Date.now()<until)await sleep(25);
  if(this.session!==s)throw Error('OFFER_REPLACED');
  const code=encodeSignal(sdpToSignal(pc.localDescription!.sdp,'offer',id,expiresAt));
  return {code,link:PAGE_URL+'#'+code,session:id,expiresAt};
 }
 async acceptAnswer(code:string){
  const s=this.session,a=decodeSignal(code);
  if(!s||this.state!=='offered'||a.r!=='answer'||a.s!==s.id)throw Error('ANSWER_REFUSED');
  if(this.now()>s.expiresAt){this.end(s,'OFFER_EXPIRED');throw Error('OFFER_EXPIRED');}
  this.state='connecting';s.loginBy=this.now()+LOGIN_MS;
  try{await s.pc.setRemoteDescription({type:'answer',sdp:signalToSdp(a)});}catch{this.end(s,'ANSWER_REFUSED');throw Error('ANSWER_REFUSED');}
 }
 stop(reason:string){
  if(reason!=='REPLACED')this.forget();
  if(this.session)this.end(this.session,reason);
 }
 private forget(){
  if(!this.resume)return;
  clearTimeout(this.resume.timer);this.opts.access.disconnect(this.resume.token);this.resume=undefined;
 }
 /** Keeps the access token alive for RESUME_MS and returns the one-time secret the phone uses to reclaim it. */
 private keep(token:string,secret=randomBytes(24).toString('base64url')){
  clearTimeout(this.resume?.timer);
  const timer=setTimeout(()=>{if(this.resume?.timer===timer&&this.session?.token!==token)this.forget();},RESUME_MS);timer.unref?.();
  this.resume={secret,token,until:this.now()+RESUME_MS,timer};return secret;
 }

 private end(s:Session,reason:string,detail?:string){
  if(this.session!==s)return;
  this.send(s,{t:'ended',reason});
  this.session=undefined;this.state='ended';this.reason=reason;this.detail=detail?.slice(0,300);
  clearInterval(s.watch);s.abort.abort();
  // A dropped connection is not a decision to stop: keep the login and send a fresh link through the owner's chat.
  const paused=reason==='CONNECTION_LOST'&&!!s.token&&this.resume?.token===s.token;
  if(paused){this.keep(s.token!,this.resume!.secret);this.resume!.activeAt=s.activeAt;if(this.opts.onReconnect)void this.reconnect(false);}
  // Dropped while paused: the login is already gone, so the new link needs the password.
  else if(reason==='CONNECTION_LOST'&&s.paused&&this.opts.onReconnect)void this.reconnect(true);
  else if(s.token){if(this.resume?.token===s.token)this.forget();this.opts.access.disconnect(s.token);}
  s.backend?.stop();
  setTimeout(()=>void s.pc.close().catch(()=>{}),100); // let 'ended' flush first
 }
 private send(s:Session,m:MacMessage){try{if(s.control.readyState==='open')s.control.send(JSON.stringify(m));}catch{}}
 private async watch(s:Session){
  if(this.session!==s)return;
  if(this.state==='offered'&&this.now()>s.expiresAt)return this.end(s,'OFFER_EXPIRED');
  if(!s.token&&s.loginBy&&this.now()>s.loginBy)return this.end(s,s.paused?'IDLE_TIMEOUT':'LOGIN_TIMEOUT');
  if(!s.token||!s.backend)return;
  try{this.opts.access.authorize(s.token);}catch{return this.end(s,'ACCESS_ENDED');}
  // Enforced here too: an unattended phone (its screen kept on by the page) must not stay in control.
  if(this.now()-s.activeAt>MAC_IDLE_MS)return this.end(s,'IDLE_TIMEOUT');
  // In the input queue: the driver drops its connection after any failed call, which would kill an input in flight.
  let r=false as boolean|'locked';const e=s.epoch;await this.serial(s,async j=>{r=await j.backend.ready().catch(()=>false);});
  if(this.session!==s||s.epoch!==e||!s.token)return;
  if((r==='locked')!==s.locked){s.locked=r==='locked';this.send(s,{t:'locked',locked:s.locked});}
  // One slow permission probe is not a loss; end only after several in a row.
  s.misses=r?0:s.misses+1;
  if(s.misses>=READY_MISSES)this.end(s,'DESKTOP_UNAVAILABLE');
 }
 private async reconnect(password:boolean){
  try{const offer=await this.createOffer();this.opts.onReconnect?.(offer.link,password);}catch{}
 }
 /** Phone screen off: log out but keep the connection, so the password brings the same session back. */
 private pause(s:Session){
  this.forget();this.opts.access.disconnect(s.token!);s.token=undefined;
  // A new epoch: nothing queued, captured or transcribed before the pause may act or send after it.
  s.epoch++;s.abort.abort();s.abort=new AbortController();s.pulling=false;
  s.backend?.stop();s.backend=undefined;s.voice=undefined;s.authing=false;s.paused=true;s.loginBy=this.now()+PAUSE_MS;
 }
 private async onControl(s:Session,data:string|Buffer){
  if(this.session!==s)return;
  let m:any;try{if(typeof data!=='string'||data.length>12000)throw 0;m=JSON.parse(data);}catch{return this.end(s,'INVALID_MESSAGE');}
  if(!s.token){
   if(s.paused&&m?.t==='stop')return this.end(s,'STOPPED_BY_PHONE');
   if(s.paused&&m?.t!=='auth'&&m?.t!=='resume')return; // frames or taps still in flight from before the pause
   if(m?.t==='resume'){
    if(s.authing)return; // a password check is already running; one login per connection
    // A phone left untouched before it dropped needs the password again, not a free resume.
    const r=this.resume,ok=!!r&&typeof m.secret==='string'&&m.secret===r.secret&&this.now()<r.until&&!(r.activeAt&&this.now()-r.activeAt>MAC_IDLE_MS);
    let valid=false;if(ok){try{this.opts.access.authorize(r!.token);valid=true;}catch{}}
    if(!valid){this.forget();return this.send(s,{t:'resume-fail'});}
    s.token=r!.token;return this.begin(s);
   }
   if(m?.t!=='auth')return this.end(s,'AUTH_REQUIRED');
   if(s.authing)return;
   s.authing=true;
   try{s.token=await this.opts.access.authenticate(m.password);}
   catch(e){
    const error=(e as Error).message;s.authing=false;if(this.session!==s)return;
    this.send(s,{t:'auth-fail',error});
    if(error!=='INCORRECT_PASSWORD'||++s.attempts>=MAX_ATTEMPTS)this.end(s,error==='INCORRECT_PASSWORD'?'TOO_MANY_ATTEMPTS':error);
    return;
   }
   if(this.session!==s){this.opts.access.disconnect(s.token);return;}
   this.forget();return this.begin(s);
  }
  if(m?.t==='stop')return this.end(s,m.idle===true?'IDLE_TIMEOUT':'STOPPED_BY_PHONE');
  if(m?.t==='pause')return this.pause(s);
  if(m?.t==='active'){s.activeAt=this.now();return;}
  if(m?.t==='input'||m?.t==='voice'||m?.t==='desktops')s.activeAt=this.now();
  if(m?.t==='desktops'){
   if(!s.backend?.desktops)return this.send(s,{t:'desktops',count:0,current:0});
   return this.serial(s,async j=>{let d={count:0,current:0};try{d=await j.backend.desktops!(j.signal);}catch{}if(this.live(s,j.epoch))this.send(s,{t:'desktops',...d});});
  }
  if(m?.t==='voice')return this.onVoice(s,m);
  if(m?.t==='ready'){
   if(m.frameId!==s.frameId||s.pulling)return;
   s.pulling=true;
   return this.serial(s,async j=>{try{await this.sendFrame(s,await this.capture(j),j.epoch);}finally{if(s.epoch===j.epoch)s.pulling=false;}});
  }
  if(m?.t==='input'){
   const id=typeof m.id==='string'?m.id.slice(0,64):'',error=inputError(m);
   if(error)return this.send(s,{t:'ack',id,ok:false,error});
   if(s.seen.has(id))return this.send(s,{t:'ack',id,ok:false,error:'DUPLICATE_INPUT'});
   s.seen.add(id);
   return this.serial(s,async j=>{
    // The phone is usually showing the frame before the newest one (the next is already in flight).
    // Both map the same way when the screen size is unchanged, so either is accepted.
    const frame=m.frameId===s.frameId?s.frame:m.frameId===s.frameId-1&&s.prev&&s.frame&&s.prev.width===s.frame.width&&s.prev.height===s.frame.height?s.prev:undefined;
    if(!frame)return this.send(s,{t:'ack',id,ok:false,error:'STALE_FRAME'});
    try{await j.backend.act(frame,m as Input,j.signal);}
    catch(e){
     if(this.session!==s||s.epoch!==j.epoch)return; // cancelled by a pause: the page already gave up on this tap
     const message=(e as Error).message??'';
     // The driver refused before sending anything, so the session can safely carry on.
     if(message.startsWith('DESKTOP_NATIVE_REFUSED'))return this.send(s,{t:'ack',id,ok:false,error:'ACTION_REFUSED'});
     this.send(s,{t:'ack',id,ok:false,error:'ACTION_FAILED'});return this.end(s,'ACTION_FAILED',message); // outcome unknown: never retry
    }
    if(s.epoch===j.epoch)this.send(s,{t:'ack',id,ok:true});
   });
  }
  return this.end(s,'INVALID_MESSAGE');
 }
 /** Voice typing. Refused while the Mac is locked, so a spoken Mac password never reaches a transcriber;
  * on the lock screen the password is only ever typed and goes straight into the Mac. Transcripts are never logged. */
 private async onVoice(s:Session,m:any){
  const t=this.opts.transcriber;if(!t)return this.end(s,'INVALID_MESSAGE');
  const e=s.epoch,id=typeof m.id==='string'?m.id.slice(0,64):'',fail=(error:string,message?:string)=>{if(s.epoch!==e)return;s.voice=undefined;if(this.session===s)this.send(s,{t:'voice-fail',id,error,...message?{message}:{}});};
  if(s.locked)return fail('MAC_LOCKED');
  // One at a time: each transcription is CPU on the Mac or a paid call on the owner's key.
  if(s.transcribing)return fail('VOICE_BUSY');
  if(m.seq===0)s.voice=VOICE_MIMES.includes(m.mime)?{id,mime:m.mime,chunks:[],bytes:0}:undefined;
  const v=s.voice;
  if(!v||v.id!==id||m.seq!==v.chunks.length||typeof m.data!=='string'||m.data.length>VOICE_CHUNK_CHARS||!/^[A-Za-z0-9+/=]*$/.test(m.data))return fail('INVALID_VOICE');
  const b=Buffer.from(m.data,'base64');v.bytes+=b.length;
  if(v.bytes>MAX_VOICE_BYTES)return fail('VOICE_TOO_LONG');
  v.chunks.push(b);
  if(m.last!==true)return;
  s.voice=undefined;s.transcribing=true;const signal=s.abort.signal;
  try{
   // Checked again now, uncached, in case the Mac locked while the phone was recording.
   // Only a positive unlocked answer counts: an unknown state could be the lock screen.
   let r=false as boolean|'locked';await this.serial(s,async j=>{r=await j.backend.ready(true).catch(()=>false);});
   if(!this.live(s,e))return;
   if(r!==true)return fail(r==='locked'?'MAC_LOCKED':'MAC_UNAVAILABLE');
   const text=await t.transcribe(Buffer.concat(v.chunks),v.mime,signal);if(this.live(s,e))this.send(s,{t:'voice-text',id,text:text.slice(0,2000)});
  }catch(err){fail('TRANSCRIBE_FAILED',String((err as Error).message??'').slice(0,200));}
  finally{s.transcribing=false;} // not reset by pause, so a cancelled clip still finishes before the next starts
 }
 /** Authenticated: start the backend, hand the phone its reconnect secret and the first frame. */
 private begin(s:Session){
  s.activeAt=this.now();s.paused=false;
  const secret=this.keep(s.token!);
  s.backend=this.opts.backend();
  s.epoch++;
  return this.serial(s,async j=>{
   // The phone needs the lock state before it shows the type field, not 2s later.
   const locked=await j.backend.ready(true).catch(()=>false)==='locked';
   const f=await this.capture(j);if(!this.live(s,j.epoch))return;s.locked=locked;this.send(s,{t:'auth-ok',locked:s.locked,width:f.width,height:f.height,resume:secret,...j.backend.desktops?{desktops:true as const}:{},...this.opts.transcriber?{voice:this.opts.transcriber.engine}:{},idle:MAC_IDLE_MS});await this.sendFrame(s,f,j.epoch);});
 }
 /** A single failed screenshot is usually transient; retry briefly before giving up. */
 private async capture(j:Job){
  for(let attempt=1;;attempt++){
   try{return await j.backend.capture(j.signal);}
   catch(e){if(attempt>=CAPTURE_TRIES||j.signal.aborted)throw e;await sleep(400);}
  }
 }
 /** Capture and act share one queue, so an input always runs against the frame its id names. */
 private serial(s:Session,job:(j:Job)=>Promise<void>){
  // Jobs belong to the epoch they were queued in; work queued before a pause or a new login is dropped,
  // and so is its failure: a capture cancelled by a pause must not end the session that follows.
  const e=s.epoch;
  s.queue=s.queue.then(async()=>{
   if(!s.backend||!this.live(s,e))return;
   try{await job({epoch:e,backend:s.backend,signal:s.abort.signal});}
   catch(err){if(this.session===s&&s.epoch===e)this.end(s,'DESKTOP_UNAVAILABLE',(err as Error).message);}
  });
  return s.queue;
 }
 /** Still the session and epoch this work belongs to, and the login still holds (checked now, not at the 2s watch). */
 private live(s:Session,epoch:number){
  if(this.session!==s||s.epoch!==epoch||!s.token)return false;
  try{this.opts.access.authorize(s.token);return true;}catch{this.end(s,'ACCESS_ENDED');return false;}
 }
 private async sendFrame(s:Session,f:DesktopFrame,epoch:number){
  if(!this.live(s,epoch))return;
  s.frameId++;s.prev=s.frame;s.frame=f;const chunks=chunkFrame(s.frameId,f.width,f.height,f.jpeg);
  for(const c of chunks){
   // ponytail: polls bufferedAmount; switch to bufferedAmountLow events if 20ms granularity ever matters.
   while(s.frames.bufferedAmount>MAX_BUFFERED){if(this.session!==s||s.epoch!==epoch)return;await sleep(20);}
   if(!this.live(s,epoch))return;
   s.frames.send(Buffer.from(c.buffer,c.byteOffset,c.byteLength));
  }
 }
}
