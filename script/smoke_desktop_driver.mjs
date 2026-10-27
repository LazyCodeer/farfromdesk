import { resolve,sep } from 'node:path';
import { EmbeddedDesktopDriver } from '../dist/desktop-driver.js';
if(process.platform!=='darwin'){console.log('Desktop driver: macOS-only, skipped.');process.exit(0);}
const driver=new EmbeddedDesktopDriver(resolve(process.argv[2]??'build/desktop-backend/native')+sep);
try{
  const apps=await driver.call('list_apps',{});
  if(!Array.isArray(apps.apps))throw new Error('Invalid app discovery response');
  const permissions=await driver.call('check_permissions',{});
  if(permissions.source?.attribution!=='host'||permissions.source?.embedded!==true)throw new Error('Driver is not attributed to native host');
  console.log(JSON.stringify({desktopDriver:'0.38.0',embedded:true,appCount:apps.apps.length,accessibility:permissions.accessibility,screenRecording:permissions.screen_recording,inputDispatched:false}));
}finally{driver.stop();}
