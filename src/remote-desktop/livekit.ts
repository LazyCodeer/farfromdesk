import {AccessToken,RoomServiceClient} from 'livekit-server-sdk';
export type LiveKitConfig={url:string;apiKey:string;apiSecret:string};
export function validateLiveKitConfig(c:LiveKitConfig){
 const url=new URL(c.url);const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
 if(!(['wss:'].includes(url.protocol)||(local&&url.protocol==='ws:'))||url.username||url.password||url.search||url.hash)throw Error('SECURE_LIVEKIT_URL_REQUIRED');
 if(!c.apiKey||c.apiSecret.length<32)throw Error('LIVEKIT_CONFIGURATION_REQUIRED');
 return c;
}
/** Join tokens expire quickly; established rooms are not cut off at five minutes. */
export class LiveKitRemoteRoom {
 readonly room='ffd-'+crypto.randomUUID();
 constructor(private config:LiveKitConfig){validateLiveKitConfig(config);}
 async token(role:'host'|'viewer'){
  const token=new AccessToken(this.config.apiKey,this.config.apiSecret,{identity:role,ttl:60});
  token.addGrant({room:this.room,roomJoin:true,canPublish:role==='host',canSubscribe:role==='viewer',canPublishData:false,canUpdateOwnMetadata:false});
  return {url:this.config.url,token:await token.toJwt(),room:this.room,mode:'view-only' as const};
 }
 async stop(){
  const http=this.config.url.replace(/^ws/,'http');
  await new RoomServiceClient(http,this.config.apiKey,this.config.apiSecret).deleteRoom(this.room);
 }
}
