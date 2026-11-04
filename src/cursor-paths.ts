import {homedir,userInfo} from 'node:os';
import {join} from 'node:path';
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
export const cursorSupportDir=(env:NodeJS.ProcessEnv=process.env):string=>
  env.CURSOR_SUPPORT_DIR?.trim()||join(cursorOwnerHome(env),'Library','Application Support','Cursor');
/** The chat list Cursor searches. It carries the titles; the transcripts carry the messages. */
export const cursorConversationDb=(env:NodeJS.ProcessEnv=process.env):string=>
  join(cursorSupportDir(env),'User','globalStorage','conversation-search.db');
export const cursorAppBinary=(env:NodeJS.ProcessEnv=process.env):string=>
  env.CURSOR_APP_BIN?.trim()||(process.platform==='darwin'?'/Applications/Cursor.app':join('usr','share','cursor'));
/** The separate Cursor CLI, which the owner installs and signs in on its own. */
export const cursorCliBinary=(env:NodeJS.ProcessEnv=process.env):string=>
  env.CURSOR_AGENT_BIN?.trim()||env.WSB_CURSOR_BIN?.trim()||'agent';

/**
 * Cursor names a project folder after its workspace path: the path without its leading separator and
 * with every separator turned into `-`. A long path is cut and gets a short hash suffix, so the
 * folder name is a lossy rendering of the path rather than a reversible encoding.
 */
export function cursorProjectSlug(path:string):string {
  return path.trim().replace(/^[/\\]+/,'').replace(/[/\\:]+/g,'-');
}

/** A folder name that ends in a short hex suffix after a mid-word cut is a truncated slug. */
const TRUNCATED=/^(.{16,})-([0-9a-f]{6,10})$/;

/**
 * Recover the workspace path a project folder stands for. A short slug is the path itself; a
 * truncated one is still a prefix of the real sanitized path, so walk the filesystem matching child
 * names against that prefix. Returns null when nothing matches (for example Cursor's `empty-window`,
 * which is a chat with no folder behind it).
 */
export function cursorProjectPath(slug:string,env:NodeJS.ProcessEnv=process.env):string|null {
  const name=slug.trim();
  if(!name)return null;
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