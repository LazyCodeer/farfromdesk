import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type ResolvedWorkspaces=Map<string,{sessionCwd:string;cwd:string}>;
function loadWorkspaces(paths:string[]):Promise<ResolvedWorkspaces> {
  return new Promise((resolve,reject)=>{
    const child=execFile(process.execPath,[fileURLToPath(new URL('./workspace-scan.js',import.meta.url))],
      {timeout:4000,killSignal:'SIGKILL',maxBuffer:4*1024*1024,windowsHide:true},(error,stdout)=>{
        if(error){reject(new Error('Workspace discovery needs file access. Review the native permission prompt, then click Check apps.'));return;}
        try{resolve(new Map(JSON.parse(stdout)));}catch{reject(new Error('Workspace discovery returned invalid data.'));}
      });
    child.stdin?.on('error',()=>{});
    child.stdin?.end(JSON.stringify(paths));
  });
}

/** Project metadata can block inside an OS permission prompt. Keep it off the
 * API process and stop automatic retries until the owner clicks Check apps. */
export class WorkspaceScanner {
  private pending?:Promise<ResolvedWorkspaces>;
  private blocked?:Error;
  constructor(private load=loadWorkspaces){}
  retry(){this.blocked=undefined;}
  scan(paths:string[]) {
    if(this.blocked)return Promise.reject(this.blocked);
    if(this.pending)return this.pending;
    if(!paths.length)return Promise.resolve(new Map());
    const task=this.load([...new Set(paths)]).catch(error=>{
      this.blocked=new Error('Workspace discovery needs file access. Review the native permission prompt, then click Check apps.');
      throw this.blocked;
    }).finally(()=>{if(this.pending===task)this.pending=undefined;});
    this.pending=task;return task;
  }
}
