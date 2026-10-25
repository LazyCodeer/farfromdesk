import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants, readFileSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, basename } from 'node:path';

const exec=promisify(execFile);
const executable=(path:string)=>{try{accessSync(path,constants.X_OK);return true;}catch{return false;}};
export function selectClaudeDiscovery(options:{override?:string;running:string[];configured?:string;launcher?:string;fallback:string},exists=executable) {
  if(options.override) {
    if(!isAbsolute(options.override)||!exists(options.override))throw new Error('Configured Claude desktop executable is unavailable.');
    return options.override;
  }
  for(const path of [...new Set(options.running)].sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})))if(exists(path))return path;
  for(const path of [options.configured,options.launcher])if(path&&isAbsolute(path)&&exists(path))return path;
  return options.fallback;
}
/** Discover executable paths only: never read process environments or credentials. */
export async function claudeDiscoveryBinary(fallback:string) {
  const root=join(homedir(),'Library/Application Support/Claude/claude-code')+'/';
  let running:string[]=[];
  try {
    const {stdout}=await exec('/bin/ps',['-axo','pid=,comm='],{timeout:5000,maxBuffer:2*1024*1024});
    running=stdout.split('\n').map(line=>line.trim().replace(/^\d+\s+/,''))
      .filter(path=>path.startsWith(root)&&path.endsWith('/claude.app/Contents/MacOS/claude'));
  }catch{/* Use the configured desktop helper if process listing is unavailable. */}
  let configured:string|undefined;
  try{const data=JSON.parse(readFileSync(join(homedir(),'.config/desktop-sync.json'),'utf8'));if(typeof data.claudeBinary==='string')configured=data.claudeBinary;}catch{}
  return selectClaudeDiscovery({override:process.env.WSB_CLAUDE_DESKTOP_BIN,running,configured,launcher:join(homedir(),'.local/bin/claude-desktop-latest'),fallback});
}
export function inboxPaths(output:string,pid:number) {
  return output.split('\n').filter(l=>l.startsWith('n/')&&l.endsWith('.sock')).map(l=>l.slice(1))
    .filter(path=>basename(path)===`${pid}.sock`&&basename(join(path,'..')).startsWith('cc-socks'));
}
/** Readiness only. desktop-sync independently validates ownership and identity before sending. */
export async function hasClaudeInbox(pid:unknown) {
  if(typeof pid!=='number'||!Number.isSafeInteger(pid)||pid<=0)return false;
  try {
    const {stdout}=await exec('/usr/sbin/lsof',['-a','-p',String(pid),'-U','-Fn'],{timeout:5000,maxBuffer:1024*1024});
    const paths=inboxPaths(stdout,pid);if(paths.length!==1)return false;
    const stat=lstatSync(paths[0]);return stat.isSocket()&&stat.uid===process.getuid?.();
  }catch{return false;}
}

/** One bounded lsof scan for the catalog, rather than one process per chat. */
export function inboxesByPid(output:string,requested:Set<number>) {
  const sections=new Map<number,string[]>();let pid:number|undefined;
  for(const line of output.split('\n')) {
    if(/^p[0-9]+$/.test(line)) {pid=Number(line.slice(1));if(requested.has(pid)&&!sections.has(pid))sections.set(pid,[]);}
    else if(pid!==undefined&&requested.has(pid))sections.get(pid)?.push(line);
  }
  return new Map([...sections].map(([pid,lines])=>[pid,inboxPaths(lines.join('\n'),pid)]));
}
export async function hasClaudeInboxes(values:unknown[]) {
  const pids=new Set(values.filter((pid):pid is number=>typeof pid==='number'&&Number.isSafeInteger(pid)&&pid>0).slice(0,4096));
  const ready=new Set<number>();if(!pids.size)return ready;
  try {
    const {stdout}=await exec('/usr/sbin/lsof',['-a','-p',[...pids].join(','),'-U','-Fpn'],{timeout:3000,maxBuffer:4*1024*1024});
    for(const [pid,paths] of inboxesByPid(stdout,pids))if(paths.length===1) {
      try {const stat=lstatSync(paths[0]);if(stat.isSocket()&&stat.uid===process.getuid?.())ready.add(pid);}catch{}
    }
  }catch{/* Discovery failure must not advertise unverified live connections. */}
  return ready;
}

/** A bundled binary alone is not proof of desktop ownership; require app ancestry. */
export function desktopOwnedPids(output:string) {
  const rows=new Map<number,{parent:number;path:string}>();
  for(const line of output.split('\n')) {
    const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if(m)rows.set(Number(m[1]),{parent:Number(m[2]),path:m[3]});
  }
  return new Set([...rows.keys()].filter(pid=>{
    const seen=new Set<number>();let current=pid;
    while(current>1&&!seen.has(current)) {
      seen.add(current);const r=rows.get(current);if(!r)return false;
      if(/\/Claude\.app\/Contents\/MacOS\/Claude$/.test(r.path)||/\/Claude\.app\/Contents\/Frameworks\/Claude Helper/.test(r.path))return true;
      current=r.parent;
    }return false;
  }));
}
export async function claudeDesktopProcesses() {
  const {stdout}=await exec('/bin/ps',['-axo','pid=,ppid=,comm='],{timeout:5000,maxBuffer:2*1024*1024});
  return desktopOwnedPids(stdout);
}
export type ExecutionMode='desktop'|'cli';
export function executionMode(provider:string,value:unknown):ExecutionMode {
  const mode=value??'cli';
  if(!['desktop','cli'].includes(String(mode))||(provider!=='claude'&&mode!=='cli'))throw new Error('Choose Desktop or CLI for Claude; Codex uses its native CLI adapter.');
  return mode as ExecutionMode;
}
