/** Windows EXE upgrades. Runs with a copied Node runtime outside the installation. */
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {access,cp,lstat,mkdir,readFile,readdir,realpath,rename,rm,statfs,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join,resolve,win32} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checksum,download,releaseAsset,repository,small,type UpdateProgress} from './app-updater.js';

const exec=promisify(execFile);
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
export const uninstallKey='{DF168D57-418A-4924-B435-BF904833EF76}_is1';
export type WindowsUpdateRequest={app:string;state:string;port:number;current:string;version:string;uiPid:number};
type ProcessIdentity={pid:number;path:string;started:string};
type Inventory={installs:{path:string;version:string}[];processes:ProcessIdentity[]};
const samePath=(a:string,b:string)=>win32.resolve(a).toLowerCase()===win32.resolve(b).toLowerCase();
export function validateWindowsInstall(app:string,current:string,inventory:Inventory,uiPid:number) {
 if(!win32.isAbsolute(app)||app.startsWith('\\\\')||win32.parse(app).root===app)throw new Error('Updates require a local, per-user EXE installation.');
 if(inventory.installs.length!==1||!samePath(inventory.installs[0].path,app)||inventory.installs[0].version!==current)
  throw new Error('This app does not match the existing per-user EXE installation. Open the installed FarFromDesk before updating.');
 const windows=inventory.processes.filter(p=>samePath(p.path,win32.join(app,'farfromdesk.exe')));
 if(windows.length!==1||windows[0].pid!==uiPid||!windows[0].started)throw new Error('Close other FarFromDesk windows and retry from the installed app.');
 return windows[0];
}
export function installerArguments(app:string,log:string) {
 // No /FORCECLOSEAPPLICATIONS and no shell. Never kill unrelated Node processes.
 return ['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/NOCLOSEAPPLICATIONS','/NORESTARTAPPLICATIONS','/SP-',`/DIR=${app}`,`/LOG=${log}`];
}

// Fixed PowerShell source; paths are carried in environment data, never inserted as code.
export async function windowsInventory():Promise<Inventory> {
 const script=`$ErrorActionPreference='Stop'
$key='${uninstallKey}'
$entries=@()
foreach($prefix in @('Software','Software\\WOW6432Node')) {
 $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)
 try {$entry=$base.OpenSubKey($prefix+'\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+$key)
  if($null -ne $entry) {try {$entries+=@{path=$entry.GetValue('InstallLocation');version=$entry.GetValue('DisplayVersion')}} finally {$entry.Dispose()}}
 } finally {$base.Dispose()}
}
$processes=@(Get-CimInstance Win32_Process | Where-Object {$_.Name -in @('farfromdesk.exe','node.exe')} | ForEach-Object { if($_.ExecutablePath) {@{pid=[int]$_.ProcessId;path=$_.ExecutablePath;started=$_.CreationDate.ToUniversalTime().ToString('o')}} })
@{installs=$entries;processes=$processes}|ConvertTo-Json -Depth 4 -Compress`;
 const powershell=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const result=await exec(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:30000,maxBuffer:1024*1024});
 return JSON.parse(result.stdout.replace(/^\uFEFF/,''));
}
function alive(pid:number){try{process.kill(pid,0);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')return false;throw e;}}
async function waitExit(pid:number,label:string) {
 for(let i=0;i<150;i++){if(!alive(pid))return;await sleep(100);}
 throw new Error(`${label} did not exit. Nothing was replaced; close it and reopen FarFromDesk before retrying.`);
}
async function closeWindow(ui:ProcessIdentity) {
 const script=`$ErrorActionPreference='Stop'
$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:FFD_UPDATE_UI_PID)
if($null -eq $p){exit 0}
if($p.ExecutablePath -ne $env:FFD_UPDATE_UI_PATH -or $p.CreationDate.ToUniversalTime().ToString('o') -ne $env:FFD_UPDATE_UI_STARTED){throw 'The app process changed'}
$process=Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
if($null -ne $process -and !$process.CloseMainWindow()){throw 'Close the FarFromDesk window before retrying'}`;
 await exec(join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
  ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
  {windowsHide:true,timeout:30000,env:{...process.env,FFD_UPDATE_UI_PID:String(ui.pid),FFD_UPDATE_UI_PATH:ui.path,FFD_UPDATE_UI_STARTED:ui.started}});
}
async function noLinks(root:string):Promise<void> {
 if((await lstat(root)).isSymbolicLink())throw new Error('Linked installation folders are not supported by the updater.');
 for(const entry of await readdir(root,{withFileTypes:true})){
  const path=join(root,entry.name);
  if(entry.isSymbolicLink())throw new Error('Linked installation files are not supported by the updater.');
  if(entry.isDirectory())await noLinks(path);
 }
}
async function launch(app:string,request:WindowsUpdateRequest) {
 const child=spawn(join(app,'farfromdesk.exe'),[],{cwd:app,detached:true,stdio:'ignore',env:{...process.env,WSB_STATE_DIR:request.state,WSB_PORT:String(request.port)}});
 await new Promise<void>((r,j)=>{child.once('spawn',r);child.once('error',j);});child.unref();
}

/** The ordering is shared by production and failure-path tests. Never replay an uncertain installer. */
export async function installWindowsUpdate(steps:{
 preflight:()=>Promise<void>;shutdown:()=>Promise<void>;waitBackend:()=>Promise<void>;
 backup:()=>Promise<void>;closeUI:()=>Promise<void>;ensureStopped:()=>Promise<void>;
 install:()=>Promise<number>;verify:()=>Promise<void>;launch:()=>Promise<void>;health:()=>Promise<void>;
}) {
 await steps.preflight();await steps.shutdown();await steps.waitBackend();
 await steps.backup();await steps.closeUI();await steps.ensureStopped();
 const code=await steps.install();
 if(code!==0)throw new Error(code===3010?'Windows requires a restart to finish this update. Restart Windows, then open FarFromDesk.':`Windows installer stopped (code ${code}). The installer log and previous files are saved. Do not rerun it until the failure has been checked.`);
 await steps.verify();await steps.launch();await steps.health();
}

export async function runWindowsUpdate(requestFile:string,transport={small,download}) {
 if(process.platform!=='win32')throw new Error('The Windows updater can run only on Windows.');
 const request=JSON.parse(await readFile(requestFile,'utf8')) as WindowsUpdateRequest;
 if(!Number.isInteger(request.port)||request.port<1||request.port>65535||!Number.isInteger(request.uiPid)||request.uiPid<=1)throw new Error('Invalid running app identity.');
 const app=await realpath(request.app),state=await realpath(request.state),directory=join(state,'app-update'),attempt=await realpath(dirname(requestFile));
 if(!samePath(dirname(attempt),directory)||samePath(state,app)||state.toLowerCase().startsWith(app.toLowerCase()+'\\')||samePath(dirname(process.execPath),join(app,'backend','runtime')))
  throw new Error('The updater and saved state must be outside the installation.');
 const lock=join(directory,'lock'),output=join(directory,'status.json');
 await mkdir(lock); // A leftover lock is deliberately not treated as permission to replay.
 const report=async(p:UpdateProgress)=>{
  await writeFile(output+'.tmp',JSON.stringify({...p,pid:process.pid,version:request.version,attempt}));await rename(output+'.tmp',output);
 };
 const local=async(path:string,body?:object)=>{
  const token=(await readFile(join(state,'admin-token'),'utf8')).trim();
  const response=await fetch(`http://127.0.0.1:${request.port}${path}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(5000)});
  const data=await response.json() as any;if(!response.ok)throw new Error(data.error??'The app could not prepare for updating.');return data;
 };
 let shutdown=false,installerStarted=false,uiClosed=false,launched=false;
 try {
  await report({phase:'checking',message:'Checking your Windows installation…'});
  await noLinks(app);await access(app,constants.W_OK);
  const original=JSON.parse(await readFile(join(app,'backend','build.json'),'utf8'));
  if(original.buildId!==request.current)throw new Error('The installed version changed. Reopen FarFromDesk before updating.');
  const ui=validateWindowsInstall(app,request.current,await windowsInventory(),request.uiPid);
  const release=JSON.parse(await transport.small(`https://api.github.com/repos/${repository}/releases/tags/v${request.version}`,512*1024));
  const asset=releaseAsset(release,request.version,request.current,process.arch,'windows');
  for(const path of [app,attempt]){const disk=await statfs(path);if(disk.bavail*disk.bsize<asset.bytes*8+512*1024**2)throw new Error('Free more disk space before updating.');}
  const expected=checksum(await transport.small(asset.checksumUrl,4096),asset.name),setup=join(attempt,asset.name);
  const actual=await transport.download(asset.url,setup,asset.bytes,n=>report({phase:'downloading',message:'Downloading update…',received:n,total:asset.bytes}));
  if(actual!==expected)throw new Error('The update checksum did not match. Nothing was installed.');
  await report({phase:'verifying',message:'Download verified. Preparing to restart…'});
  let backend:{pid:number;sourceCommit:string;buildId:string},updated:{sourceCommit:string;buildId:string};
  await installWindowsUpdate({
   preflight:async()=>{
    const current=await windowsInventory();const currentUI=validateWindowsInstall(app,request.current,current,request.uiPid);
    if(currentUI.started!==ui.started)throw new Error('The app restarted during download. Check for updates again.');
    backend=await local('/api/health');
    const service=current.processes.find(p=>p.pid===backend.pid&&samePath(p.path,join(app,'backend','runtime','node.exe')));
    if(!service||backend.buildId!==request.current||backend.sourceCommit!==original.sourceCommit)throw new Error('Another backend is running. Reopen the installed app before updating.');
   },
   shutdown:async()=>{await local('/api/update-shutdown',{});shutdown=true;},
   waitBackend:()=>waitExit(backend.pid,'FarFromDesk background service'),
   backup:async()=>{
    await report({phase:'preparing',message:'Saving recovery files…'});
    await cp(join(state,'bridge.sqlite'),join(attempt,'before-update.sqlite'),{errorOnExist:true,force:false});
    await cp(app,join(attempt,'previous'),{recursive:true,errorOnExist:true,force:false});
   },
   closeUI:async()=>{
    // The initiating UI observes this helper's PID, then exits itself. No taskkill.
    await report({phase:'closing',message:'Restarting FarFromDesk to install the update…'});
    // WM_CLOSE also supports existing releases without the new progress observer.
    await closeWindow(ui);
    await waitExit(request.uiPid,'FarFromDesk window');uiClosed=true;
   },
   ensureStopped:async()=>{
    const processes=(await windowsInventory()).processes;
    if(processes.some(p=>samePath(p.path,join(app,'farfromdesk.exe'))||samePath(p.path,join(app,'backend','runtime','node.exe'))))throw new Error('FarFromDesk reopened before installation. Close it before retrying.');
   },
   install:async()=>{
    await report({phase:'installing',message:'Installing into your existing FarFromDesk folder…'});
    installerStarted=true;
    // No timeout: a timeout cannot establish that an installer stopped. Its exit is observed.
    const child=spawn(setup,installerArguments(app,join(attempt,'installer.log')),{cwd:attempt,windowsHide:true,stdio:'ignore'});
    return await new Promise<number>((r,j)=>{child.once('error',j);child.once('exit',(code)=>r(code??-1));});
   },
   verify:async()=>{
    updated=JSON.parse(await readFile(join(app,'backend','build.json'),'utf8'));
    if(updated.buildId!==request.version||!/^[a-f0-9]{40}$/.test(updated.sourceCommit))throw new Error('Installed build does not match the update. Recovery files are retained.');
    const installs=(await windowsInventory()).installs;
    if(installs.length!==1||!samePath(installs[0].path,app)||installs[0].version!==request.version)throw new Error('Windows installation registration could not be verified.');
   },
   launch:async()=>{await report({phase:'restarting',message:'Waiting for FarFromDesk to reconnect…'});await launch(app,request);launched=true;},
   health:async()=>{
    for(let i=0;i<90;i++){
     try{const h=await local('/api/health');if(h.app==='FarFromDesk'&&h.protocol===1&&h.pid!==backend.pid&&h.sourceCommit===updated.sourceCommit&&h.buildId===request.version)return;}catch{}
     await sleep(1000);
    }
    throw new Error('Update installed, but startup could not be confirmed. Reopen FarFromDesk. Recovery files are retained.');
   },
  });
  await report({phase:'complete',message:`FarFromDesk ${request.version} is installed and connected.`});
  await rm(setup,{force:true});
 }catch(e){
  await report({phase:'error',message:e instanceof Error?e.message:'Update failed. Recovery files are retained.'});
  // Before installer execution the original app is intact. Reopen only if its UI exited.
  // Once an installer has run, do not roll back data/registration or replay it blindly.
  if(shutdown&&!installerStarted&&uiClosed&&!launched)await launch(app,request).catch(()=>{});
 }finally{await rm(lock,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.argv[2]==='--run'){
 runWindowsUpdate(process.argv[3]).catch(e=>{console.error(e instanceof Error?e.message:'Update failed');process.exitCode=1;});
}
