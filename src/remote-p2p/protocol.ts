/** Shared contract for peer-to-peer Mac remote control. Runs in Node and the phone browser:
 * no Node imports here. Screen and input go Mac <-> phone directly over WebRTC (DTLS);
 * the only things that leave the devices are the two signal codes, carried through the
 * owner's own WhatsApp/Telegram chat, and STUN address lookups.
 */

/** Compact non-trickle signal: everything a data-channel-only SDP needs. */
export type Signal={
  v:1;
  s:string;            // session id, 16+ url-safe chars, same in offer and answer
  r:'offer'|'answer';
  u:string;            // ice-ufrag
  p:string;            // ice-pwd
  f:string;            // DTLS sha-256 fingerprint, uppercase hex with colons
  c:string[];          // ICE candidates, each the value after "a=candidate:"
  e?:number;           // offer only: expiry, ms since epoch
};
export const SIGNAL_PREFIX='FFD-ANSWER ';
/** Voice pieces stay under the control channel's 12000-character message limit; 2 MB is several minutes of speech. */
export const VOICE_CHUNK_CHARS=8000,MAX_VOICE_BYTES=2_000_000,VOICE_MIMES=['audio/webm','audio/mp4','audio/ogg','audio/aac','audio/mpeg','audio/wav'];
export type Transcriber={engine:'local'|'cloud';transcribe(audio:Buffer,mime:string,signal:AbortSignal):Promise<string>};
export const OFFER_TTL_MS=5*60_000;
/** A phone that connects must log in within 2 minutes. */
export const LOGIN_MS=2*60_000;
/** Idle lock: the phone warns after 30s untouched and closes 15s later; the Mac closes at 75s even if the page never does.
 * A paused session (phone screen off) waits up to PAUSE_MS for the password. */
export const IDLE_WARN_MS=30_000,IDLE_COUNTDOWN_MS=15_000,MAC_IDLE_MS=75_000,PAUSE_MS=10*60_000;
export const PAGE_URL='https://ffd.codecylabs.com/remote/';
export const STUN_URLS=['stun:stun.l.google.com:19302','stun:stun.cloudflare.com:3478'];

/** Data channels, both negotiated (pre-agreed ids), ordered and reliable. */
export const CONTROL_CHANNEL={label:'ffd-control',id:1};
export const FRAME_CHANNEL={label:'ffd-frames',id:2};

/** Frames are JPEG, sent on the frame channel as chunks:
 * [u32 frameId][u16 index][u16 count][u16 width][u16 height] + up to CHUNK_BYTES of JPEG.
 * Pull-based: the Mac sends the next frame only after {t:'ready'} for the previous one.
 */
export const FRAME_HEADER_BYTES=12;
export const CHUNK_BYTES=16_000;

export type InputKind='click'|'double'|'right'|'scroll'|'key'|'type'|'overview'|'desktop';
export type Input={
  t:'input';id:string;frameId:number;kind:InputKind;
  x?:number;y?:number;                       // normalized 0..1 on that frame
  direction?:'up'|'down'|'left'|'right';amount?:number;
  key?:string;modifiers?:string[];
  text?:string;
  index?:number;                             // desktop: 1-based desktop on the main display
};
export type PhoneMessage=
  |{t:'auth';password:string}
  |{t:'resume';secret:string}               // reclaim the login kept after a dropped connection
  |{t:'ready';frameId:number}                // rendered; send the next frame
  |{t:'desktops'}                            // list the main display's desktops
  |{t:'active'}                              // the owner touched the phone; sent at most every 5s
  |{t:'pause'}                               // the phone screen went off: log out, keep the connection; 'auth' carries on
  |{t:'voice';id:string;seq:number;mime:string;data:string;last:boolean} // a recording in base64 pieces, for the Mac to transcribe
  |Input
  |{t:'stop';idle?:true};                   // idle: the phone's countdown ran out
export type MacMessage=
  |{t:'auth-ok';width:number;height:number;resume:string;desktops?:true;voice?:'local'|'cloud';idle?:number;locked?:boolean} // idle: ms the Mac allows untouched; the phone may send 'active' // desktops: lists and switches them; voice: how recordings are transcribed
  |{t:'auth-fail';error:string}
  |{t:'locked';locked:boolean}  // sent when the Mac locks or unlocks during a session
  |{t:'voice-text';id:string;text:string}
  |{t:'voice-fail';id:string;error:string;message?:string}
  |{t:'resume-fail'}
  |{t:'ack';id:string;ok:true}
  |{t:'ack';id:string;ok:false;error:string}
  |{t:'desktops';count:number;current:number} // current 0: a full-screen app, not a desktop
  |{t:'ended';reason:string};

const KEYS=/^(return|tab|escape|delete|space|up|down|left|right|home|end|pageup|pagedown|[a-z0-9])$/;
const MODIFIERS=new Set(['cmd','shift','option','ctrl']);
const POINTER=new Set(['click','double','right','scroll']);

/** Returns an error code, or undefined when the input is safe to dispatch. */
export function inputError(a:any):string|undefined{
  if(!a||a.t!=='input'||typeof a.id!=='string'||!/^[A-Za-z0-9-]{8,64}$/.test(a.id)||!Number.isInteger(a.frameId))return 'INVALID_INPUT';
  if(POINTER.has(a.kind)){
    if(!Number.isFinite(a.x)||!Number.isFinite(a.y)||a.x<0||a.y<0||a.x>=1||a.y>=1)return 'INVALID_COORDINATES';
    if(a.kind==='scroll'&&(!['up','down','left','right'].includes(a.direction)||!Number.isInteger(a.amount)||a.amount<1||a.amount>20))return 'INVALID_SCROLL';
    return;
  }
  if(a.kind==='key'){
    const m=a.modifiers??[];
    if(typeof a.key!=='string'||!KEYS.test(a.key)||!Array.isArray(m)||m.length>3||m.some((x:unknown)=>!MODIFIERS.has(x as string)))return 'INVALID_KEY';
    return;
  }
  if(a.kind==='overview')return;
  if(a.kind==='desktop')return Number.isInteger(a.index)&&a.index>=1&&a.index<=16?undefined:'INVALID_DESKTOP';
  if(a.kind==='type'){
    if(typeof a.text!=='string'||!a.text.length||a.text.length>2000||/[\x00-\x1f\x7f]/.test(a.text))return 'INVALID_TEXT';
    return;
  }
  return 'INVALID_INPUT';
}

/** Split one JPEG into frame-channel messages. */
export function chunkFrame(frameId:number,width:number,height:number,jpeg:Uint8Array):Uint8Array[]{
  const count=Math.max(1,Math.ceil(jpeg.length/CHUNK_BYTES));
  if(count>65535||width>65535||height>65535)throw Error('FRAME_TOO_LARGE');
  const out:Uint8Array[]=[];
  for(let i=0;i<count;i++){
    const body=jpeg.subarray(i*CHUNK_BYTES,(i+1)*CHUNK_BYTES),msg=new Uint8Array(FRAME_HEADER_BYTES+body.length),v=new DataView(msg.buffer);
    v.setUint32(0,frameId>>>0);v.setUint16(4,i);v.setUint16(6,count);v.setUint16(8,width);v.setUint16(10,height);msg.set(body,FRAME_HEADER_BYTES);out.push(msg);
  }
  return out;
}
/** Reassembles chunks in order; a chunk from a newer frame drops the unfinished one. */
export class FrameAssembler{
  private id=-1;private parts:Uint8Array[]=[];
  push(data:ArrayBuffer|Uint8Array):{frameId:number;width:number;height:number;jpeg:Uint8Array}|undefined{
    const msg=data instanceof Uint8Array?data:new Uint8Array(data);
    if(msg.length<FRAME_HEADER_BYTES)return;
    const v=new DataView(msg.buffer,msg.byteOffset,msg.byteLength),id=v.getUint32(0),index=v.getUint16(4),count=v.getUint16(6);
    if(id!==this.id){if(index!==0)return;this.id=id;this.parts=[];}
    if(index!==this.parts.length)return;
    this.parts.push(msg.subarray(FRAME_HEADER_BYTES));
    if(this.parts.length<count)return;
    const size=this.parts.reduce((n,p)=>n+p.length,0),jpeg=new Uint8Array(size);let at=0;for(const p of this.parts){jpeg.set(p,at);at+=p.length;}
    this.parts=[];this.id=-1;
    return {frameId:id,width:v.getUint16(8),height:v.getUint16(10),jpeg};
  }
}

/** The Mac side the host drives. Implemented natively in desktop.ts, faked in tests. */
export type DesktopFrame={jpeg:Uint8Array;width:number;height:number;captureId:string};
export interface DesktopBackend{
  ready(fresh?:boolean):Promise<boolean|'locked'>; // fresh: skip the 1s cache, for checks that guard the password        // unlocked, permissions granted; 'locked' keeps the session on the lock screen
  capture(signal:AbortSignal):Promise<DesktopFrame>;
  act(frame:DesktopFrame,input:Input,signal:AbortSignal):Promise<void>;
  desktops?(signal:AbortSignal):Promise<{count:number;current:number}>;
  stop():void;
}
