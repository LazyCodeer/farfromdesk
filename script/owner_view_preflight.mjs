import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve,sep} from 'node:path';
import {EmbeddedDesktopDriver} from '../dist/desktop-driver.js';

// Read-only readiness check. Never captures, posts input or requests a native grant.
const [probe,nativeDirectory,helperBundle]=process.argv.slice(2);
if(!probe||!nativeDirectory){console.error('Usage: node script/owner_view_preflight.mjs SESSION_PROBE NATIVE_DIRECTORY');process.exit(1);}
const result={checkedAt:new Date().toISOString(),session:'UNCONFIRMED',accessibility:null,screenRecording:null,hostBundleId:null,inputDispatched:false,screenshotCaptured:false,permissionRequested:false};
let driver;
try{
  const p=await promisify(execFile)(resolve(probe),[],{timeout:2000});
  const state=JSON.parse(p.stdout);
  result.session=typeof state.reason==='string'&&/^[A-Z_]+$/.test(state.reason)?state.reason:'UNCONFIRMED';
  if(state.unlocked!==true){process.exitCode=2;}
  else {
    driver=new EmbeddedDesktopDriver(resolve(nativeDirectory)+sep,helperBundle,helperBundle==='FarFromDesk Owner View Test.app');
    const permissions=await driver.call('check_permissions',{});
    result.accessibility=permissions.accessibility===true;
    result.screenRecording=permissions.screen_recording===true;
    const host=permissions.source?.host_bundle_id;
    result.hostBundleId=typeof host==='string'&&/^[a-zA-Z0-9.-]+$/.test(host)?host:null;
    if(!result.accessibility||!result.screenRecording)process.exitCode=2;
  }
}catch{result.session='PREFLIGHT_FAILED';process.exitCode=2;}
finally{driver?.stop();console.log(JSON.stringify(result,null,2));}
