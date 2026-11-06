import {execFileSync,spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {win32} from 'node:path';

// The Windows side of the CLI's install / stop-service / open commands.
//
// Start at sign-in uses the same per-user Run entry that the desktop app's
// "Open at login" switch writes (launch_at_startup in native_gateway.dart):
// name "FarFromDesk", value the app's path, and an "enabled" StartupApproved
// entry. Writing that exact pair means the switch shows it as on, turning the
// switch off removes it, and there is never a second, competing autostart
// (such as a Scheduled Task) for the owner to find and remove.
export const RUN_KEY='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const APPROVED_KEY='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
export const STARTUP_NAME='FarFromDesk';
/** launch_at_startup's "enabled" marker: 12 bytes, first byte 2. */
export const STARTUP_APPROVED='020000000000000000000000';

export type Registry={
  read(key:string,name:string):string|undefined;
  writeString(key:string,name:string,value:string):void;
  writeBinary(key:string,name:string,hex:string):void;
  remove(key:string,name:string):void;
};
export type WindowsHost={
  registry:Registry;
  exists(path:string):boolean;
  /** Image names of running processes, lower case. */
  running():string[];
  /** Start a desktop app so that its window shows normally. */
  launch(exe:string):void;
  env:NodeJS.ProcessEnv;
};

const systemRoot=(env:NodeJS.ProcessEnv)=>env.SystemRoot??env.SYSTEMROOT??'C:\\Windows';
const tool=(env:NodeJS.ProcessEnv,name:string)=>win32.join(systemRoot(env),'System32',name);

/** The value of NAME in `reg query KEY /v NAME` output. */
export function regQueryValue(output:string,name:string):string|undefined {
  const prefix=`    ${name}    `;
  for(const line of output.split(/\r?\n/)){
    if(!line.startsWith(prefix))continue;
    const m=/^REG_[A-Z_]+ {4}(.*)$/.exec(line.slice(prefix.length));if(m)return m[1];
  }
}

type Exec=(file:string,args:string[],options:{encoding:'utf8';windowsHide:true;stdio:['ignore','pipe','ignore'];timeout:number})=>string;
const exec:Exec=(file,args,options)=>execFileSync(file,args,options);
export function systemHost(env=process.env,run:Exec=exec):WindowsHost {
  const options:Parameters<Exec>[2]={encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore'],timeout:15_000};
  const reg=(args:string[])=>run(tool(env,'reg.exe'),args,options);
  return {
    env,
    registry:{
      read(key,name){try{return regQueryValue(reg(['query',key,'/v',name]),name);}catch{return undefined;}},
      writeString(key,name,value){reg(['add',key,'/v',name,'/t','REG_SZ','/d',value,'/f']);},
      writeBinary(key,name,hex){reg(['add',key,'/v',name,'/t','REG_BINARY','/d',hex,'/f']);},
      remove(key,name){reg(['delete',key,'/v',name,'/f']);},
    },
    exists:existsSync,
    running(){
      const out=run(tool(env,'tasklist.exe'),['/FO','CSV','/NH'],options);
      return out.split(/\r?\n/).map(line=>/^"([^"]+)"/.exec(line)?.[1]?.toLowerCase()).filter((n):n is string=>!!n);
    },
    // Started directly with windowsHide, the app would receive SW_HIDE and its first
    // window would stay hidden. Explorer starts it the way a Start menu click does.
    launch(exe){const child=spawn(win32.join(systemRoot(env),'explorer.exe'),[exe],{detached:true,stdio:'ignore',windowsHide:true});child.on('error',()=>{});child.unref();},
  };
}

/** Where the Windows installer puts the app (per user, no admin rights). */
export function installedApp(env:NodeJS.ProcessEnv=process.env){
  const local=env.LOCALAPPDATA||win32.join(env.USERPROFILE||'C:\\Users\\Default','AppData','Local');
  return win32.join(local,'Programs','FarFromDesk','farfromdesk.exe');
}
/** The installed app first, then a local release build of this checkout. */
export function appCandidates(root:string,env:NodeJS.ProcessEnv=process.env){
  return [installedApp(env),win32.join(root,'desktop','build','windows','x64','runner','Release','farfromdesk.exe')];
}

/** CLI `open`: show the app, without starting a second copy of a running one. */
export function openWindowsApp(root:string,host:WindowsHost):string {
  const app=appCandidates(root,host.env).find(host.exists);
  if(!app)throw new Error('Install the FarFromDesk app for Windows first. The browser dashboard has been retired.');
  if(host.running().includes('farfromdesk.exe'))return 'FarFromDesk is already running. Open it from the system tray or the taskbar.';
  host.launch(app);return 'Opening FarFromDesk.';
}

/** CLI `install`: start the installed app at sign-in, then start it now. */
export function installWindowsStartup(host:WindowsHost):string {
  const app=installedApp(host.env);
  if(!host.exists(app))throw new Error('Install the FarFromDesk app for Windows first, then run install again to start it when you sign in.');
  const previous=host.registry.read(RUN_KEY,STARTUP_NAME);
  host.registry.writeString(RUN_KEY,STARTUP_NAME,app);
  host.registry.writeBinary(APPROVED_KEY,STARTUP_NAME,STARTUP_APPROVED);
  const replaced=previous!==undefined&&previous!==app?` It replaced the earlier entry that started ${previous}.`:'';
  const running=host.running().includes('farfromdesk.exe');
  if(!running)host.launch(app);
  return `FarFromDesk now starts when you sign in to this PC (the same setting as Open at login in FarFromDesk Settings).${replaced} ${running?'It is already running.':'Starting it now.'}`;
}

/**
 * CLI `stop-service`: ask the running backend to shut down, as quitting the app does.
 * Start at sign-in is left as it is, like the Mac service file.
 */
export async function stopWindowsService(shutdown:()=>Promise<unknown>):Promise<string> {
  try{await shutdown();}
  catch(e:any){
    if(e?.message==='fetch failed'||e?.cause?.code==='ECONNREFUSED')return 'FarFromDesk is not running on this PC. Nothing was stopped.';
    throw e;
  }
  return 'Stopped. Credentials and sessions are retained. FarFromDesk starts again when you open it, or at sign-in if Open at login is on.';
}

/** `where.exe NAME`: the first match, as the Mac CLI uses `which`. */
export function resolveWindowsBin(name:string,env:NodeJS.ProcessEnv=process.env,run:Exec=exec):string {
  if(win32.isAbsolute(name)||/[\\/]/.test(name))return name;
  let out:string;
  try{out=run(tool(env,'where.exe'),[name],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore'],timeout:15_000});}catch{throw new Error(`${name} was not found on PATH. Install it, or pass its full path.`);}
  const first=out.split(/\r?\n/).map(s=>s.trim()).find(Boolean);
  if(!first)throw new Error(`${name} was not found on PATH. Install it, or pass its full path.`);
  return first;
}
