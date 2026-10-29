import { queueCoordinatorUpdates, initializeCoordinatorUpdates } from './coordinator-updates.js';
import { AgentInstaller } from './agent-installer.js';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { initializeState,stateDir,baseUrl } from './config.js';
import { Store } from './store.js';
import { Approvals } from './approvals.js';
import { NativeAgents } from './native.js';
import { Router } from './router.js';
import { Telegram } from './telegram.js';
import { WhatsApp } from './whatsapp.js';
import { serve } from './server.js';
import { drainHooks } from './hooks.js';
import { Coordinator } from './coordinator.js';
import { Masters } from './masters.js';
import { PowerPolicy } from './power.js';
import { installBundledAudio } from './speech-bundle.js';
import { Workers } from './workers.js';
import { PortableNative } from './portable-native.js';
import { portableAgents } from './platform.js';
import { acquireServiceLock } from './service-lock.js';
import { MorningBrief } from './morning-brief.js';

const token=initializeState();
const releaseLock=acquireServiceLock(stateDir);process.on('exit',releaseLock);
const store=new Store(join(stateDir,'bridge.sqlite'));
const agentInstaller=new AgentInstaller(store);
initializeCoordinatorUpdates(store);
try {installBundledAudio(store);}catch{console.error('Bundled voice assets could not be initialized. Reinstall the app or configure local speech tools.');}
const approvals=new Approvals(store),native=portableAgents?new PortableNative(store,approvals):new NativeAgents(store,approvals),router=new Router(store,native,approvals),wa=new WhatsApp(store,router),telegram=new Telegram(store,router);
router.morningBrief=new MorningBrief(store,router);
const coordinator=new Coordinator(store,native,router);router.coordinator=coordinator;
const masters=new Masters(store,router),power=new PowerPolicy(store,router,wa,undefined,telegram);
const workers=new Workers(store,router,masters);router.hasPendingCreation=id=>workers.pending(id);
router.workspaceCommand=args=>{if(args==='revoke')return workers.revoke();if(args)throw new Error('Use /workspace or /workspace revoke.');return workers.workspaceSummary();};
native.beforeRun=b=>{if(store.get(`managed-worker:${b.id}`)==='true')workers.ensureRun(b);};
native.managedActive=b=>!!(masters.runtimes.get(b.id)?.alive||masters.claudeRuntimes.get(b.id)?.alive);
native.managedRun=(b,message,jobId)=>{if(store.get(`managed-worker:${b.id}`)==='true')workers.ensureRun(b);return masters.run(b,message,jobId);};
const server=serve(store,router,wa,token,{masters,power,workers,telegram});
server.on('listening',()=>{
  agentInstaller.start();
  // Remove only this service's private scratch recordings after a crash.
  rmSync(join(stateDir,'audio-tmp'),{recursive:true,force:true});
  store.recover();
  if(power.enabled){void coordinator.refresh();void masters.discover();}
  power.apply();
  console.log(`FarFromDesk listening at ${baseUrl}. Open FarFromDesk to manage it.`);
  if(power.enabled&&store.controlChannel()==='telegram')void telegram.resume().catch(()=>{});
  // Existing paired accounts reconnect; first-time pairing is an explicit UI action.
  if(power.enabled&&store.controlChannel()==='whatsapp'&&existsSync(join(stateDir,'whatsapp-auth','creds.json')))
    void wa.connect().catch(e=>{wa.error=(e as Error).message;});
});
server.on('error',e=>{console.error(`Bridge could not start: ${e.message}`);process.exit(1);});
const worker=setInterval(()=>{drainHooks(store);router.pump();},2000);
// A paused bridge must not keep touching protected provider folders.
const discovery=setInterval(()=>{if(power.enabled){void coordinator.refresh();void masters.discover();}},30000);
const setupRecovery=setInterval(()=>{if(power.enabled){void masters.reconcileDesktopSetup();workers.reconcileDesktop();}},5000);
const maintenance=setInterval(()=>{power.apply();router.autoCloseStale();if(power.enabled)router.morningBrief?.tick();if(wa.status==='connected'||telegram.status==='connected')queueCoordinatorUpdates(store,router);router.attachments.cleanup();wa.artifacts.cleanup();store.cleanupHooks();},60000);
let shutting=false;
function shutdown(){if(shutting)return;shutting=true;router.stopped=true;agentInstaller.close();clearInterval(worker);clearInterval(discovery);clearInterval(setupRecovery);clearInterval(maintenance);power.close();workers.close();masters.close();approvals.cancel();wa.close();telegram.close();native.close();server.close();setTimeout(()=>{store.close();process.exit(0);},1500).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
process.on('uncaughtException',e=>{console.error(`Bridge fatal error: ${e.message}`);shutdown();});
process.on('unhandledRejection',e=>{console.error(`Bridge promise failed: ${e instanceof Error?e.message:'unknown failure'}`);shutdown();});

server.on('ffd-shutdown',shutdown);
