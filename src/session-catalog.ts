import { readdir, open, lstat } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { basename, join, isAbsolute } from 'node:path';
import type { Provider } from './store.js';
import { createHash } from 'node:crypto';

export type Session = {detached?:boolean;liveDiscoveryComplete?:boolean;activation?:'cli-resume'|'desktop-open';live?:boolean;desktopId?:string;accountScope?:string;executionMode?:'desktop'|'cli';id:string;provider:Provider;name:string;cwd:string;status:string;updatedAt?:number;available?:boolean};
export function sameProject(a:string,b:string) {
  if(a===b)return true;
  try{return realpathSync(a)===realpathSync(b);}catch{return false;}
}
export function activityTime(value:unknown):number|undefined {
  const n=typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN;
  return Number.isFinite(n)&&n>0?(n<1e12?n*1000:n):undefined;
}
function denied(error:any){if(error?.code==='EPERM'||error?.code==='EACCES')throw error;}
const metadataCache=new Map<string,{signature:string;session?:Session}>();
const signature=(s:{ino:number;size:number;mtimeMs:number;ctimeMs:number})=>`${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
/** Read only bounded metadata windows. Never retain or return message content. */
export async function claudeHistory(root:string):Promise<Session[]> {
  let projects;try{projects=await readdir(root,{withFileTypes:true});}catch(e:any){if(e.code==='ENOENT')return [];throw e;}
  const result:Session[]=[];
  // Reuse scan windows: thousands of histories must not allocate thousands of buffers.
  const head=Buffer.alloc(65536),tail=Buffer.alloc(65536);
  const seen=new Set<string>();
  for(const project of projects.filter(p=>p.isDirectory())) {
    const dir=join(root,project.name);
    let files;try{files=await readdir(dir,{withFileTypes:true});}catch(e){denied(e);continue;}
    const index=new Map<string,any>();
    let indexFile;
    try {
      indexFile=await open(join(dir,'sessions-index.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const stat=await indexFile.stat();
      if(stat.isFile()&&stat.size<=2*1024*1024) {
        const data=JSON.parse(await indexFile.readFile('utf8'));
        for(const entry of Array.isArray(data.entries)?data.entries:[])if(typeof entry.sessionId==='string')index.set(entry.sessionId,entry);
      }
    }catch(e){denied(e);/* Optional index: bounded transcript metadata remains the fallback. */}finally{await indexFile?.close();}
    const enrich=(session:Session)=>{
      const entry=index.get(session.id);if(!entry||(entry.projectPath&&entry.projectPath!==session.cwd))return {...session};
      const title=entry.customTitle||entry.summary;
      return {...session,...(typeof title==='string'&&title.trim()?{name:title.slice(0,160)}:{}),updatedAt:Math.max(session.updatedAt??0,activityTime(entry.modified)??0)};
    };
    for(const file of files) {
      if(!file.isFile()||!/^([0-9a-f-]{36})\.jsonl$/i.test(file.name))continue;
      const id=file.name.slice(0,-6);
      const path=join(dir,file.name);seen.add(path);
      let handle;
      try {
        const info=await lstat(path);if(!info.isFile())continue;
        const cached=metadataCache.get(path);
        if(cached?.signature===signature(info)){if(cached.session)result.push(enrich(cached.session));continue;}
        handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
        const stat=await handle.stat();if(!stat.isFile())continue;
        const size=Math.min(stat.size,head.length);
        const first=await handle.read(head,0,size,0);
        const windows=[head.subarray(0,first.bytesRead).toString('utf8')];
        if(stat.size>size){const last=await handle.read(tail,0,size,stat.size-size);windows.push(tail.subarray(0,last.bytesRead).toString('utf8'));}
        let cwd='',name='',updatedAt:number|undefined,sidechain=false;
        for(const line of windows.flatMap(w=>w.split('\n'))) {
          let row;try{row=JSON.parse(line);}catch{continue;}
          if(row.sessionId&&row.sessionId!==id)continue;
          if(row.isSidechain===true){sidechain=true;continue;}
          if(typeof row.cwd==='string'&&isAbsolute(row.cwd))cwd=row.cwd;
          if(row.type==='custom-title'&&typeof row.customTitle==='string')name=row.customTitle.slice(0,160);
          const time=activityTime(row.timestamp);if(time)updatedAt=Math.max(updatedAt??0,time);
        }
        const session:Session|undefined=cwd&&!sidechain?{id,provider:'claude',name:name||`${basename(cwd)} · ${id.slice(0,8)}`,cwd,executionMode:'cli',live:false,activation:'cli-resume',status:'Saved CLI session · resumes automatically after account verification',available:false,updatedAt:updatedAt??stat.mtimeMs}:undefined;
        metadataCache.set(path,{signature:signature(stat),session});if(session)result.push(enrich(session));
      } catch (e){denied(e);/* A removed/unreadable history file must not hide the other sessions. */}
      finally {await handle?.close();}
    }
  }
  for(const path of metadataCache.keys())if(path.startsWith(root+'/')&&!seen.has(path))metadataCache.delete(path);
  return result;
}

const desktopCache=new Map<string,{signature:string;session?:Session}>();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Desktop metadata only, across saved account/org folders. Never retain prompts or MCP configuration. */
export async function claudeDesktopHistory(root:string):Promise<Session[]> {
  const result:Session[]=[],seen=new Set<string>();
  async function dirs(path:string){try{return (await readdir(path,{withFileTypes:true})).filter(e=>e.isDirectory());}catch(e){denied(e);return [];}}
  for(const account of await dirs(root))for(const org of await dirs(join(root,account.name))) {
    const dir=join(root,account.name,org.name);let files;try{files=await readdir(dir,{withFileTypes:true});}catch(e){denied(e);continue;}
    for(const file of files) {
      if(!file.isFile()||!/^local_[0-9a-f-]{36}\.json$/i.test(file.name))continue;
      const path=join(dir,file.name);seen.add(path);let handle;
      try {
        const info=await lstat(path);if(!info.isFile())continue;
        const cached=desktopCache.get(path);
        if(cached?.signature===signature(info)){if(cached.session)result.push({...cached.session});continue;}
        handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        const st=await handle.stat();if(!st.isFile()||st.uid!==process.getuid?.()||st.size>2*1024*1024)continue;
        const row=JSON.parse(await handle.readFile('utf8'));
        if(row.sessionId!==file.name.slice(0,-5)||typeof row.cwd!=='string'||!isAbsolute(row.cwd))continue;
        const nativeId=typeof row.cliSessionId==='string'&&uuid.test(row.cliSessionId)?row.cliSessionId:undefined;
        const session:Session={id:nativeId??row.sessionId,desktopId:row.sessionId,detached:row.lineageDetached===true,provider:'claude',executionMode:'desktop',accountScope:createHash('sha256').update(account.name+'\0'+org.name).digest('hex').slice(0,20),
          name:typeof row.title==='string'&&row.title.trim()?row.title.slice(0,160):`${basename(row.cwd)} · ${row.sessionId.slice(-8)}`,
          cwd:typeof row.worktreePath==='string'&&row.worktreePath.startsWith('/')?row.worktreePath:row.cwd,
          live:false,activation:nativeId&&row.isArchived!==true?'desktop-open':undefined,available:false,status:row.isArchived===true?'Archived in Claude Desktop':nativeId?'Saved in Claude Desktop · open in its account to connect':'Not initialized in Claude Desktop',
          updatedAt:activityTime(row.lastActivityAt)??activityTime(row.createdAt)};
        desktopCache.set(path,{signature:signature(st),session});result.push({...session});
      }catch(e){denied(e);/* Unreadable records do not hide other sessions. */}finally{await handle?.close();}
    }
  }
  for(const path of desktopCache.keys())if(path.startsWith(root+'/')&&!seen.has(path))desktopCache.delete(path);
  return result.sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0)||a.id.localeCompare(b.id));
}
