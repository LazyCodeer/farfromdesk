import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';

export type Frame={png:string;mime?:string;width:number;height:number;captureId:string;controls:string;fields?:{id:string;label:string;token:string;fingerprint?:string}[]};
export type OwnerAction={id:string;frameId:string;kind:'click'|'double'|'right'|'scroll'|'key'|'type';x?:number;y?:number;text?:string;fieldId?:string;direction?:'up'|'down'|'left'|'right';amount?:number;key?:string;modifiers?:string[]};
const pointer=new Set(['click','double','right','scroll']),keys=/^(return|tab|escape|delete|space|up|down|left|right|home|end|pageup|pagedown|[a-z0-9])$/,modifiers=new Set(['cmd','shift','option','ctrl']);
export interface OwnerBackend {
  ready():Promise<boolean>;
  capture(signal:AbortSignal):Promise<Frame>;
  act(frame:Frame,action:OwnerAction,signal:AbortSignal):Promise<void>;
  stop():void;
}
const secret=()=>randomBytes(32).toString('base64url');
const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};

/** Owner-only channel. No agent credentials, model actions or durable bearer links. */
export class OwnerViewSession {
  readonly pairingCode=secret();
  readonly expiresAt:number;
  private credential=secret();
  private claimed=false;
  private revoked=false;
  private busy=false;
  private abort=new AbortController();
  private observation?:{id:string;at:number;frame:Frame};
  private attempts=new Set<string>();
  constructor(private backend:OwnerBackend,private now=Date.now,ttlMs=5*60_000){
    if(ttlMs!==Infinity&&(ttlMs<1000||ttlMs>10*60_000))throw Error('INVALID_TTL');
    this.expiresAt=now()+ttlMs;
  }
  claim(code:string){
    this.live();
    if(this.claimed||!equal(code,this.pairingCode))throw Error('PAIRING_REFUSED');
    this.claimed=true;return this.credential;
  }
  authenticate(token:string){this.live();if(!this.claimed||!equal(token,this.credential))throw Error('UNAUTHORIZED');}
  stop(){this.revoked=true;this.observation=undefined;this.abort.abort();this.backend.stop();}
  private live(){if(this.now()>=this.expiresAt&&!this.revoked)this.stop();if(this.revoked)throw Error('SESSION_ENDED');}
  private async ready(){this.live();if(!await this.backend.ready()){this.stop();throw Error('DESKTOP_UNAVAILABLE_OR_PERMISSION_REVOKED');}this.live();}
  async observe(token:string){
    this.authenticate(token);if(this.busy)throw Error('BUSY');this.busy=true;
    try{
      await this.ready();this.observation=undefined;
      const frame=await this.backend.capture(this.abort.signal);await this.ready();
      if(!frame.captureId||!Number.isInteger(frame.width)||!Number.isInteger(frame.height)||frame.width<1||frame.height<1||frame.width>16384||frame.height>16384||frame.png.length>16*1024*1024)throw Error('INVALID_FRAME');
      const id=randomUUID();this.observation={id,at:this.now(),frame};
      return {frameId:id,png:frame.png,mime:frame.mime??'image/png',width:frame.width,height:frame.height,fields:(frame.fields??[]).map(({id,label})=>({id,label})),expiresAt:this.expiresAt};
    }finally{this.busy=false;}
  }
  async act(token:string,a:OwnerAction){
    this.authenticate(token);if(this.busy)throw Error('BUSY');
    if(!/^[a-f0-9-]{36}$/i.test(a.id)||this.attempts.has(a.id))throw Error('ACTION_ALREADY_ATTEMPTED_OR_INVALID');
    const o=this.observation;
    if(!o||o.id!==a.frameId||this.now()-o.at>5000)throw Error('STALE_FRAME_REFRESH_FIRST');
    if(pointer.has(a.kind)){
      if(!Number.isFinite(a.x)||!Number.isFinite(a.y)||a.x!<0||a.y!<0||a.x!>=1||a.y!>=1)throw Error('INVALID_COORDINATES');
      if(a.kind==='scroll'&&(!['up','down','left','right'].includes(a.direction!)||!Number.isInteger(a.amount)||a.amount!<1||a.amount!>20))throw Error('INVALID_SCROLL');
    }else if(a.kind==='key'){
      if(typeof a.key!=='string'||!keys.test(a.key)||!Array.isArray(a.modifiers??[])||(a.modifiers??[]).length>3||(a.modifiers??[]).some(m=>!modifiers.has(m)))throw Error('INVALID_KEY');
    }else if(a.kind==='type'){
      if(typeof a.text!=='string'||!a.text.length||a.text.length>2000||/[\x00-\x1f\x7f]/.test(a.text))throw Error('INVALID_TEXT');
      // No fieldId types into the window's focused element, which the owner just tapped.
      if(a.fieldId!==undefined&&!o.frame.fields?.some(f=>f.id===a.fieldId))throw Error('CHOOSE_OBSERVED_TEXT_FIELD');
    }else throw Error('INVALID_ACTION');
    if(this.attempts.size>=5000){this.stop();throw Error('SESSION_ACTION_LIMIT');}
    this.busy=true;
    try{
      await this.ready();this.attempts.add(a.id);this.observation=undefined;
      try{await this.backend.act(o.frame,a,this.abort.signal);await this.ready();}
      catch{this.stop();throw Error('ACTION_OUTCOME_UNKNOWN_SESSION_STOPPED');}
      return {dispatched:true,verified:false,next:'Refresh and personally verify the result. Never repeat an uncertain action.'};
    }finally{this.busy=false;}
  }
  context(token:string,frameId:string){
    this.authenticate(token);const o=this.observation;
    if(!o||o.id!==frameId||this.now()-o.at>5000)throw Error('STALE_FRAME_REFRESH_FIRST');
    return o.frame.controls.slice(0,16000);
  }
}
