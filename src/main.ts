import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { initializeState,stateDir,baseUrl } from './config.js';
import { Store } from './store.js';
import { Approvals } from './approvals.js';
import { NativeAgents } from './native.js';
import { Router } from './router.js';
import { WhatsApp } from './whatsapp.js';
import { serve } from './server.js';
import { drainHooks } from './hooks.js';
import { Coordinator } from './coordinator.js';
import { Masters } from './masters.js';
import { PowerPolicy } from './power.js';
import { installBundledAudio } from './speech-bundle.js';
import { Workers } from './workers.js';

const token=initializeState();
const store=new Store(join(stateDir,'bridge.sqlite'));
try {installBundledAudio(store);}catch{console.error('Bundled voice assets could not be initialized. Reinstall the app or configure local speech tools.');}
const approvals=new Approvals(store),native=new NativeAgents(store,approvals),router=new Router(store,native,approvals),wa=new WhatsApp(store,router);
const coordinator=new Coordinator(store,native,router);router.coordinator=coordinator;
const masters=new Masters(store,router),power=new PowerPolicy(store,router,wa);
const workers=new Workers(store,router,masters);router.hasPendingCreation=id=>workers.pending(id);
router.workspaceCommand=args=>{if(args==='revoke')return workers.revoke();if(args)throw new Error('Use /workspace or /workspace revoke.');return workers.workspace()?`Approved project workspace: ${workers.root}\n/workspace revoke pauses bridge-created workers and removes this approval.`:`No project workspace approved. Ask the master to create a project; approval will appear here for ${workers.root}.`;};
native.beforeRun=b=>{if(store.get(`managed-worker:${b.id}`)==='true')workers.ensureRun(b);};
native.managedRun=(b,message,jobId)=>{if(store.get(`managed-worker:${b.id}`)==='true')workers.ensureRun(b);return masters.run(b,message,jobId);};
const server=serve(store,router,wa,token,{masters,power,workers});
server.on('listening',()=>{
  // Remove only this service's private scratch recordings after a crash.
  rmSync(join(stateDir,'audio-tmp'),{recursive:true,force:true});
  store.recover();
  void coordinator.refresh();
  void masters.discover();power.apply();
  console.log(`WhatsApp Session Bridge listening at ${baseUrl}. Open Session Bridge.app to manage it.`);
  // Existing paired accounts reconnect; first-time pairing is an explicit UI action.
  if(power.enabled&&existsSync(join(stateDir,'whatsapp-auth','creds.json')))
    void wa.connect().catch(e=>{wa.error=(e as Error).message;});
});
server.on('error',e=>{console.error(`Bridge could not start: ${e.message}`);process.exit(1);});
const worker=setInterval(()=>{drainHooks(store);router.pump();},2000);
const discovery=setInterval(()=>{void coordinator.refresh();void masters.discover();},30000);
const maintenance=setInterval(()=>{power.apply();router.autoCloseStale();},60000);
let shutting=false;
function shutdown(){if(shutting)return;shutting=true;router.stopped=true;clearInterval(worker);clearInterval(discovery);clearInterval(maintenance);power.close();workers.close();masters.close();approvals.cancel();wa.close();native.close();server.close();setTimeout(()=>{store.close();process.exit(0);},1500).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
process.on('uncaughtException',e=>{console.error(`Bridge fatal error: ${e.message}`);shutdown();});
process.on('unhandledRejection',e=>{console.error(`Bridge promise failed: ${e instanceof Error?e.message:'unknown failure'}`);shutdown();});
