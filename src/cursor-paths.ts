import {homedir,userInfo} from 'node:os';
import {join,win32} from 'node:path';
import {execFileSync} from 'node:child_process';
import {readdirSync} from 'node:fs';

/**
 * Cursor keeps its agent state in the owner's home: `~/.cursor/projects/<project>/agent-transcripts`
 * holds one transcript per chat, and the app support directory holds the searchable chat list. The
 * Local app runs its backend with an isolated HOME so its own state stays separate, which would
 * otherwise hide the owner's Cursor behind an empty app-private home and make every chat look
 * missing. When we are isolated, resolve the owner's real home instead.
 */
export function cursorOwnerHome(env:NodeJS.ProcessEnv=process.env):string {
  if(env.FFD_ISOLATED_LOCAL!=='1')return env.HOME?.trim()||homedir();
  try{return userInfo().homedir;}catch{return homedir();}
}

export const cursorDataDir=(env:NodeJS.ProcessEnv=process.env):string=>
  env.CURSOR_DATA_DIR?.trim()||env.WSB_CURSOR_DATA_DIR?.trim()||join(cursorOwnerHome(env),'.cursor');
export const cursorProjectsDir=(env:NodeJS.ProcessEnv=process.env):string=>join(cursorDataDir(env),'projects');
/** Cursor's app data: Application Support on macOS, %APPDATA%\Cursor on Windows, ~/.config/Cursor on Linux. */
export const cursorSupportDir=(env:NodeJS.ProcessEnv=process.env,platform:NodeJS.Platform=process.platform):string=>
  env.CURSOR_SUPPORT_DIR?.trim()||(platform==='win32'?win32.join(env.APPDATA?.trim()||win32.join(cursorOwnerHome(env),'AppData','Roaming'),'Cursor')
    :platform==='darwin'?join(cursorOwnerHome(env),'Library','Application Support','Cursor'):join(cursorOwnerHome(env),'.config','Cursor'));
/** The chat list Cursor searches. It carries the titles; the transcripts carry the messages. */
export const cursorConversationDb=(env:NodeJS.ProcessEnv=process.env):string=>
  join(cursorSupportDir(env),'User','globalStorage','conversation-search.db');
/** The installed desktop app. On Windows the per-user installer puts it under %LOCALAPPDATA%\Programs\cursor. */
export const cursorAppBinary=(env:NodeJS.ProcessEnv=process.env,platform:NodeJS.Platform=process.platform):string=>
  env.CURSOR_APP_BIN?.trim()||(platform==='darwin'?'/Applications/Cursor.app'
    :platform==='win32'?win32.join(env.LOCALAPPDATA?.trim()||win32.join(cursorOwnerHome(env),'AppData','Local'),'Programs','cursor','Cursor.exe'):'/usr/share/cursor');

/**
 * Whether Cursor's app process is running. macOS asks pgrep for the exact process name; Windows asks
 * tasklist for Cursor.exe (hidden, since the backend has no console). Any failure reads as not running.
 */
export function cursorRunning(platform:NodeJS.Platform=process.platform,run:(file:string,args:string[])=>string=(file,args)=>execFileSync(file,args,{encoding:'utf8',timeout:5000,windowsHide:true,stdio:['ignore','pipe','ignore']})):boolean {
  try{
    if(platform==='win32')return /^"?Cursor\.exe"?,/im.test(run(win32.join(process.env.SystemRoot||'C:\\Windows','System32','tasklist.exe'),['/FI','IMAGENAME eq Cursor.exe','/NH','/FO','CSV']));
    run('/usr/bin/pgrep',['-xq','Cursor']);return true;
  }catch{return false;}
}
/** The separate Cursor CLI, which the owner installs and signs in on its own. */
export const cursorCliBinary=(env:NodeJS.ProcessEnv=process.env):string=>
  env.CURSOR_AGENT_BIN?.trim()||env.WSB_CURSOR_BIN?.trim()||'agent';

/**
 * Cursor names a project folder after its workspace path: the path without its leading separator and
 * with every separator turned into `-`. A long path is cut and gets a short hash suffix, so the
 * folder name is a lossy rendering of the path rather than a reversible encoding.
 */
export function cursorProjectSlug(path:string,platform:NodeJS.Platform=process.platform):string {
  if(platform==='win32')return windowsSlug(path);
  return path.trim().replace(/^[/\\]+/,'').replace(/[/\\:]+/g,'-');
}

/**
 * On Windows Cursor lowercases the drive letter and turns every run of characters that are not
 * letters or digits into one `-`: C:\Users\sam_\Desktop\app is `c-Users-sam-Desktop-app` (seen in
 * ~/.cursor/projects on a real install).
 */
function windowsSlug(path:string):string {
  return path.trim().replace(/^([A-Za-z]):/,(_,d:string)=>`${d.toLowerCase()}:`).replace(/[^A-Za-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
}

function listDirs(dir:string):{name:string;dir:boolean}[] {
  return readdirSync(dir,{withFileTypes:true}).map(entry=>({name:entry.name,dir:entry.isDirectory()||entry.isSymbolicLink()}));
}

/**
 * The Windows walk: the slug starts with the drive letter, and each child is compared by its whole
 * path rendered the way Cursor renders it, because one `-` can stand for several characters (`sam_\`
 * is a single `-`). Only a whole segment is descended into; a truncated slug may end mid-segment.
 */
function windowsProjectPath(name:string,list:(dir:string)=>{name:string;dir:boolean}[]):string|null {
  const drive=/^([a-z])-/i.exec(name);
  if(!drive)return null;
  const match=TRUNCATED.exec(name),truncated=match!==null,target=match?match[1]:name;
  let dir=`${drive[1].toUpperCase()}:\\`;
  for(;;){
    let entries;
    try{entries=list(dir);}catch{return null;}
    let exact:string|null=null,exactLength=0,descend:string|null=null;
    for(const entry of entries){
      if(!entry.dir)continue;
      const candidate=windowsSlug(win32.join(dir,entry.name));
      if(candidate===target){exact=entry.name;break;}
      if(truncated&&candidate.startsWith(target)&&(!exact||candidate.length<exactLength)){exact=entry.name;exactLength=candidate.length;}
      if(!descend&&target.startsWith(`${candidate}-`))descend=entry.name;
    }
    if(exact)return win32.join(dir,exact);
    if(!descend)return null;
    dir=win32.join(dir,descend);
  }
}

/** A folder name that ends in a short hex suffix after a mid-word cut is a truncated slug. */
const TRUNCATED=/^(.{16,})-([0-9a-f]{6,10})$/;

/**
 * Recover the workspace path a project folder stands for. A short slug is the path itself; a
 * truncated one is still a prefix of the real sanitized path, so walk the filesystem matching child
 * names against that prefix. Returns null when nothing matches (for example Cursor's `empty-window`,
 * which is a chat with no folder behind it).
 */
export function cursorProjectPath(slug:string,env:NodeJS.ProcessEnv=process.env,platform:NodeJS.Platform=process.platform,list:(dir:string)=>{name:string;dir:boolean}[]=listDirs):string|null {
  const name=slug.trim();
  if(!name)return null;
  if(platform==='win32')return windowsProjectPath(name,list);
  const match=TRUNCATED.exec(name);
  // Only a genuinely truncated slug may be matched as a prefix. A whole slug has to match exactly,
  // otherwise a sibling that merely starts with the same text wins by accident.
  const truncated=match!==null;
  const target=match?match[1]:name;
  let dir=process.platform==='win32'?'C:\\':'/';
  let acc='';
  for(;;){
    let entries;
    try{entries=readdirSync(dir,{withFileTypes:true});}catch{return null;}
    let exact:string|null=null,exactLength=0,descend:string|null=null;
    for(const entry of entries){
      // `/var` and `/tmp` are symlinks on macOS, and a path behind either still has to resolve.
      if(!entry.isDirectory()&&!entry.isSymbolicLink())continue;
      const candidate=acc?`${acc}-${entry.name}`:`${entry.name}`;
      if(candidate===target){exact=entry.name;break;}
      // The cut can land inside a segment, so a child that extends the truncated slug is the answer;
      // the shortest one is the likeliest cut point.
      if(truncated&&candidate.startsWith(target)&&(!exact||candidate.length<exactLength)){exact=entry.name;exactLength=candidate.length;}
      if(!descend&&target.startsWith(candidate))descend=entry.name;
    }
    if(exact)return join(dir,exact);
    if(!descend)return null;
    dir=join(dir,descend);
    acc=acc?`${acc}-${descend}`:descend;
  }
}