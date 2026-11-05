import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Readable workspaces, plus the session folders macOS refused to let us read. */
export type ResolvedWorkspaces=Map<string,{sessionCwd:string;cwd:string}>&{denied?:string[]};
export const SCAN_TIMEOUT_MS=15000;
export const scanTimeoutMessage='Workspace discovery took longer than 15 seconds. A session folder may be on a slow or disconnected drive. Click Detect apps to try again.';

/** Short folder names for the owner: ~/Documents, iCloud Drive, /Volumes/USB. */
export function deniedFolders(paths:string[],home=homedir()) {
  const names=new Set<string>();
  for(const path of paths){
    if(path.startsWith(`${home}/Library/Mobile Documents`))names.add('iCloud Drive');
    else if(path.startsWith(`${home}/`))names.add(`~/${path.slice(home.length+1).split('/')[0]}`);
    else if(path.startsWith('/Volumes/'))names.add(path.split('/').slice(0,3).join('/'));
    else names.add(path);
  }
  return [...names];
}

export function deniedMessage(paths:string[],home=homedir()) {
  const names=deniedFolders(paths,home),shown=names.slice(0,3).join(', ')+(names.length>3?` and ${names.length-3} more`:'');
  return `FarFromDesk can't read ${shown}. Allow it in System Settings > Privacy & Security > Files and Folders > FarFromDesk, or Full Disk Access if FarFromDesk isn't listed. Then click Detect apps.`;
}

export function loadWorkspaces(paths:string[],args=[fileURLToPath(new URL('./workspace-scan.js',import.meta.url))],timeout=SCAN_TIMEOUT_MS):Promise<ResolvedWorkspaces> {
  return new Promise((resolve,reject)=>{
    const child=execFile(process.execPath,args,
      {timeout,killSignal:'SIGKILL',maxBuffer:4*1024*1024,windowsHide:true},(error,stdout)=>{
        if(error){reject(new Error((error as any).killed?scanTimeoutMessage:'Workspace discovery failed. Click Detect apps to try again.'));return;}
        try{const {resolved,denied}=JSON.parse(stdout);resolve(Object.assign(new Map(resolved),{denied}) as ResolvedWorkspaces);}
        catch{reject(new Error('Workspace discovery returned invalid data.'));}
      });
    child.stdin?.on('error',()=>{});
    child.stdin?.end(JSON.stringify(paths));
  });
}

/** Project metadata can block inside an OS permission prompt. Keep it off the
 * API process and stop automatic retries after a failed scan until the owner
 * clicks Detect apps. Denied folders are not a failure: the rest still shows. */
export class WorkspaceScanner {
  private pending?:Promise<ResolvedWorkspaces>;
  private blocked?:Error;
  constructor(private load:(paths:string[])=>Promise<ResolvedWorkspaces>=loadWorkspaces){}
  retry(){this.blocked=undefined;}
  scan(paths:string[]) {
    if(this.blocked)return Promise.reject(this.blocked);
    if(this.pending)return this.pending;
    if(!paths.length)return Promise.resolve(new Map() as ResolvedWorkspaces);
    const task=this.load([...new Set(paths)]).catch(error=>{
      this.blocked=error instanceof Error?error:new Error('Workspace discovery failed. Click Detect apps to try again.');
      throw this.blocked;
    }).finally(()=>{if(this.pending===task)this.pending=undefined;});
    this.pending=task;return task;
  }
}
