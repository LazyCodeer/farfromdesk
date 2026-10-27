import {RemotePasswordAccess,type AccessStore} from './access.js';
import {LiveKitRemoteRoom,type LiveKitConfig} from './livekit.js';
/** App-admin API only. Never mount on the agent binding API or expose the bridge. */
export class RemoteDesktopService {
 readonly access:RemotePasswordAccess;private room?:LiveKitRemoteRoom;
 constructor(store:AccessStore,private config?:LiveKitConfig){this.access=new RemotePasswordAccess(store);}
 get status(){return {...this.access.status,transportConfigured:!!this.config,mode:'view-only',networkScope:'local-test',message:this.config?'LiveKit available for a local streaming trial':'LiveKit service not configured. No remote access is active.'};}
 async command(d:Record<string,unknown>){
  if(d.action==='password'){await this.stop();await this.access.setPassword(d.password as string);return this.status;}
  if(d.action==='enable'){this.access.enable(d.enabled===true);if(d.enabled!==true)await this.stop();return this.status;}
  if(d.action==='stop'){await this.stop();return this.status;}
  if(d.action==='host-token'){
   if(!this.config)throw Error('LIVEKIT_SERVICE_NOT_CONFIGURED');
   if(!this.access.status.enabled)throw Error('ENABLE_REMOTE_DESKTOP_FIRST');
   this.room??=new LiveKitRemoteRoom(this.config);return this.room.token('host');
  }
  if(d.action==='host-ready'){if(d.ready===true)this.access.setReady(true);else await this.suspend();return this.status;}
  throw Error('UNKNOWN_REMOTE_DESKTOP_ACTION');
 }
 async connect(password:unknown){
  if(!this.room)throw Error('MAC_UNAVAILABLE');
  const session=await this.access.authenticate(password);
  try{return {session,...await this.room.token('viewer')};}catch(e){this.access.disconnect(session);throw e;}
 }
 async suspend(){this.access.setReady(false);const room=this.room;this.room=undefined;if(room)await room.stop();}
 async stop(){this.access.stop();await this.suspend();}
}
