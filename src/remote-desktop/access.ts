import {randomBytes,scrypt as rawScrypt,timingSafeEqual} from 'node:crypto';
const scrypt=(password:string,salt:Buffer)=>new Promise<Buffer>((resolve,reject)=>rawScrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024},(error,key)=>error?reject(error):resolve(key)));
export type PasswordRecord={version:1;salt:string;hash:string};
export interface AccessStore{load():PasswordRecord|undefined;save(record:PasswordRecord):void;loadEnabled?():boolean;saveEnabled?(value:boolean):void;}
/** Persistent availability is separate from per-connection authentication.
 * Sessions have no wall-clock duration limit. Stop, lock, password changes and
 * disconnect revoke the connection; opening again always requires the password.
 */
export class RemotePasswordAccess {
 // Token -> the password hash it was issued against. Several instances can share one stored record
 // (local preview and P2P), so a password changed through any of them ends every token here too.
 private sessions=new Map<string,string>();private failures=0;private retryAt=0;private countedFor?:string;private busy=false;
 private enabled=false;private ready=false;private generation=0;
 constructor(private store:AccessStore,private now=Date.now){this.enabled=store.loadEnabled?.()===true&&!!store.load();}
 get status(){return {passwordSet:!!this.store.load(),enabled:this.enabled,ready:this.ready,connected:this.sessions.size>0,retryAfterMs:Math.max(0,this.retryAt-this.now()),durationLimitMinutes:null};}
 private revoke(){this.generation++;this.sessions.clear();}
 async setPassword(password:string){
  if(typeof password!=='string'||password.length<12||password.length>256)throw Error('USE_12_TO_256_CHARACTER_PASSWORD');
  if(this.busy)throw Error('WAIT_BEFORE_RETRY');
  this.busy=true;this.revoke();this.enabled=false;this.store.saveEnabled?.(false);
  try {const salt=randomBytes(32),hash=await scrypt(password,salt);
  this.store.save({version:1,salt:salt.toString('base64'),hash:hash.toString('base64')});
  this.failures=0;this.retryAt=0;}finally{this.busy=false;}
 }
 enable(value:boolean){if(value&&!this.store.load())throw Error('SET_PASSWORD_FIRST');this.enabled=value;this.store.saveEnabled?.(value);if(!value)this.revoke();}
 setReady(value:boolean){this.ready=value;if(!value)this.revoke();}
 stop(){this.enabled=false;this.store.saveEnabled?.(false);this.revoke();}
 disconnect(token:string){this.sessions.delete(token);}
 async authenticate(password:unknown){
  if(!this.enabled||!this.ready)throw Error('MAC_UNAVAILABLE');
  const record=this.store.load();if(!record)throw Error('MAC_UNAVAILABLE');
  // A new password, set through any instance sharing the record, starts the wrong-password count again.
  if(record.hash!==this.countedFor){this.countedFor=record.hash;this.failures=0;this.retryAt=0;}
  if(this.busy||this.now()<this.retryAt)throw Error('WAIT_BEFORE_RETRY');
  this.busy=true;const generation=this.generation;
  try{
   const validShape=typeof password==='string'&&password.length<=256;
   const candidate=await scrypt(validShape?password:'invalid',Buffer.from(record.salt,'base64'));
   if(generation!==this.generation||!this.ready||!this.enabled)throw Error('MAC_UNAVAILABLE');
   if(this.store.load()?.hash!==record.hash)throw Error('MAC_UNAVAILABLE'); // password changed while checking
   const hash=Buffer.from(record.hash,'base64');
   if(!validShape||hash.length!==candidate.length||!timingSafeEqual(hash,candidate)){
    this.failures++;if(this.failures>=5)this.retryAt=this.now()+Math.min(15*60_000,30_000*2**Math.min(this.failures-5,5));
    throw Error('INCORRECT_PASSWORD');
   }
   this.failures=0;this.retryAt=0;this.sessions.clear(); // One active owner connection.
   const token=randomBytes(32).toString('base64url');this.sessions.set(token,record.hash);return token;
  }finally{this.busy=false;}
 }
 authorize(token:string){
  const issued=this.sessions.get(token);
  if(!this.enabled||!this.ready||!issued||this.store.load()?.hash!==issued){this.sessions.delete(token);throw Error('ACCESS_ENDED');}
 }
}
