import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { windowsPowerShell } from './power.js';

/**
 * Desktop control on Windows and Linux, where the macOS driver does not run.
 *
 * Each call runs one bundled script with the operating system's own accessibility
 * layer: UI Automation through Windows PowerShell (native/desktop-windows.ps1), AT-SPI
 * through python3-gi on Linux (native/desktop-linux.py). Both answer one JSON object;
 * a refusal comes back as `CODE: sentence` and is thrown as that, so the brain's
 * refusal wording (brain-device.ts) applies unchanged.
 */
export type PortableWindow={app:string;title:string;pid:number;id:string;active:boolean;process?:string};
/** Linux answers list, read, click, type, key and screenshot; the rest are Windows only (desktop-windows.ps1). */
export type PortableAction='list'|'read'|'click'|'type'|'key'|'screenshot'|'act'|'pointer'|'pick'|'apps'|'launch'|'front';
export type PortableExec=(file:string,args:string[],options:{timeout:number;maxBuffer:number;signal?:AbortSignal;windowsHide:boolean})=>Promise<string>;

const execText:PortableExec=(file,args,options)=>new Promise((resolve,reject)=>{
  execFile(file,args,{...options,encoding:'utf8'},(error,stdout,stderr)=>{
    // A script that answered did so on stdout, even with a nonzero exit.
    if(String(stdout).trim())resolve(String(stdout));else reject(new Error(String(stderr||'').trim()||error?.message||'no answer'));
  });
});

const script=(name:string)=>fileURLToPath(new URL(`../native/${name}`,import.meta.url));

/** What each platform honestly cannot do, shown in Settings and returned by status. */
export function portableLimits(platform:NodeJS.Platform,env:NodeJS.ProcessEnv=process.env):string[]{
  if(platform==='win32')return [
    'Windows does not let FarFromDesk drive apps running as administrator.',
    'Store (packaged) apps may publish few controls to UI Automation.',
    'Clicks by pixel, drags, scrolls and keystrokes bring the window to the front and use the real pointer and keyboard; Windows has no background delivery for them.',
    'Nothing can be clicked or typed while the PC is locked.',
    'Browser tabs work in Chrome, Edge, Brave and Comet. Only the selected tab in each window shows its address, and an open tab cannot be sent to a new address (a new tab can). Firefox tabs are not supported.',
    'App tools use classic Outlook (calendar, mail, tasks), OneNote for Windows, your folders and the media controls.',
  ];
  if(platform!=='linux')return [];
  const wayland=env.XDG_SESSION_TYPE==='wayland'||(!!env.WAYLAND_DISPLAY&&!env.DISPLAY);
  return [
    'Needs AT-SPI: python3-gi and gir1.2-atspi-2.0 (present on most GNOME, KDE and Xfce desktops).',
    'Electron and Chromium apps publish controls only when started with --force-renderer-accessibility.',
    ...(wayland?['On Wayland, typing keystrokes and pointer clicks are not allowed; named buttons and fields still work, and each screenshot asks for approval.']:[]),
    'Browser tabs, app tools and pixel clicks are macOS only for now.',
  ];
}

export class PortableDesktop {
  constructor(private platform:NodeJS.Platform=process.platform,private exec:PortableExec=execText){}
  get available(){return this.platform==='win32'||this.platform==='linux';}
  get backend(){return this.platform==='win32'?'windows-uia':this.platform==='linux'?'linux-atspi':null;}

  async call(action:PortableAction,args:Record<string,unknown>={},signal?:AbortSignal):Promise<any>{
    if(!this.available)throw new Error('DESKTOP_PLATFORM_UNSUPPORTED: Desktop control is not available on this system.');
    const payload=Buffer.from(JSON.stringify(args)).toString('base64');
    const [file,argv]=this.platform==='win32'
      ?[windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script('desktop-windows.ps1'),action,payload]]
      :['python3',['-I',script('desktop-linux.py'),action,payload]];
    let raw:string;
    try{raw=await this.exec(file,argv,{timeout:action==='screenshot'?75000:action==='pick'||action==='apps'?30000:20000,maxBuffer:64*1024*1024,signal,windowsHide:true});}
    catch(e){
      if(signal?.aborted)throw new Error('DESKTOP_STOPPED');
      const message=String((e as Error)?.message??e);
      if(this.platform==='linux'&&/ENOENT/.test(message))throw new Error('ATSPI_UNAVAILABLE: Desktop control on Linux needs python3 with python3-gi and gir1.2-atspi-2.0.');
      throw new Error('DESKTOP_DRIVER_FAILED: '+message.slice(0,300));
    }
    let result:any;
    try{result=JSON.parse(raw);}catch{throw new Error('DESKTOP_DRIVER_FAILED: the desktop helper gave an unreadable answer.');}
    if(result?.ok!==true)throw new Error(String(result?.error??'DESKTOP_DRIVER_FAILED: no answer'));
    return result;
  }

  async windows(signal?:AbortSignal):Promise<PortableWindow[]>{
    return ((await this.call('list',{},signal)).windows??[]) as PortableWindow[];
  }
}
