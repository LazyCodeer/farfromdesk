/**
 * Where the Claude and Codex desktop apps live and how to reach them, per OS.
 *
 * macOS keeps its established paths. On Windows both apps ship as MSIX packages (checked on a
 * real PC, November 2026): Claude is package family `Claude_pzs8sxrjxfjjc` (app id `Claude`,
 * protocol `claude:`), Codex is `OpenAI.Codex_2p2nqsd0c76g0` (app id `App`, the "ChatGPT" Start
 * entry, protocol `codex:`). Claude Desktop keeps its data unvirtualized in `%APPDATA%\Claude`
 * (or `%LOCALAPPDATA%\Claude-Data` when it relocated it) and runs Claude Code from
 * `<data>\claude-code\<version>\<hash>\claude.exe`. Claude Code on Windows exposes its peer
 * inbox as a named pipe `\\.\pipe\LOCAL\cc-msg-<32 hex>`, recorded in
 * `~/.claude/sessions/<pid>.json`, and accepts a connection only after an auth line carrying the
 * peer token published in `~/.claude/sessions/<pid>.<sha256 of the lowercased pipe>.key`.
 */
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

type Exists=(path:string)=>boolean;
type List=(path:string)=>string[];
const fileExists:Exists=path=>{try{return statSync(path).isFile();}catch{return false;}};
const listDir:List=path=>{try{return readdirSync(path);}catch{return [];}};

/** Windows has no POSIX owner IDs: a file in the owner's profile is the owner's. */
export function ownedByCurrentUser(stat:{uid:number},platform:NodeJS.Platform=process.platform) {
  return platform==='win32'||stat.uid===process.getuid?.();
}

/** Claude Desktop's own data folder (claude-code-sessions, bundled Claude Code). */
export function claudeDesktopDataDir(home=homedir(),platform:NodeJS.Platform=process.platform,env:NodeJS.ProcessEnv=process.env,exists:(path:string)=>boolean=existsSync) {
  if(platform==='darwin')return posix.join(home,'Library/Application Support/Claude');
  if(platform==='win32') {
    const roaming=env.APPDATA||win32.join(home,'AppData','Roaming'),local=env.LOCALAPPDATA||win32.join(home,'AppData','Local');
    // The app moves its data here when the roaming folder is redirected or packaged.
    const relocated=win32.join(local,'Claude-Data');
    return exists(win32.join(relocated,'claude-code-sessions'))?relocated:win32.join(roaming,'Claude');
  }
  return posix.join(env.XDG_CONFIG_HOME||posix.join(home,'.config'),'Claude');
}

/** The Claude Code configuration folder Desktop sessions publish their records in. */
export function claudeConfigHome(env:NodeJS.ProcessEnv=process.env,home=homedir()) {
  return env.CLAUDE_CONFIG_DIR||join(home,'.claude');
}

export type WindowsDesktopApp={aumid?:string;executable?:string};
function packageFamily(env:NodeJS.ProcessEnv,pattern:RegExp,list:List) {
  const local=env.LOCALAPPDATA||win32.join(env.USERPROFILE||homedir(),'AppData','Local');
  return list(win32.join(local,'Packages')).filter(name=>pattern.test(name)).sort()[0];
}
/** Claude Desktop on Windows: the Store/MSIX package, or the older per-user installer. */
export function windowsClaudeDesktop(env:NodeJS.ProcessEnv=process.env,list:List=listDir,exists:Exists=fileExists):WindowsDesktopApp|undefined {
  const family=packageFamily(env,/^Claude_[a-z0-9]{13}$/,list);
  if(family)return {aumid:`${family}!Claude`};
  const local=env.LOCALAPPDATA||win32.join(env.USERPROFILE||homedir(),'AppData','Local');
  const squirrel=win32.join(local,'AnthropicClaude','claude.exe');
  return exists(squirrel)?{executable:squirrel}:undefined;
}
/** Codex Desktop on Windows ships in the OpenAI.Codex package; its Start entry is named ChatGPT. */
export function windowsCodexDesktop(env:NodeJS.ProcessEnv=process.env,list:List=listDir):WindowsDesktopApp|undefined {
  const family=packageFamily(env,/^OpenAI\.Codex_[a-z0-9]{13}$/,list);
  return family?{aumid:`${family}!App`}:undefined;
}

/**
 * The Codex CLI that Codex Desktop itself runs on Windows. `codex queue` must reach the same local
 * daemon the app reads, and the app keeps its CLI per version under %LOCALAPPDATA%\OpenAI\Codex\bin.
 * Only a real .exe qualifies: an npm `codex.cmd` would pass the owner's message through cmd.exe.
 */
export function windowsCodexCli(env:NodeJS.ProcessEnv=process.env,list:List=listDir,exists:Exists=fileExists,mtime:(path:string)=>number=path=>{try{return statSync(path).mtimeMs;}catch{return 0;}}) {
  const local=env.LOCALAPPDATA||win32.join(env.USERPROFILE||homedir(),'AppData','Local');
  const root=win32.join(local,'OpenAI','Codex','bin');
  return list(root).map(name=>win32.join(root,name,'codex.exe')).filter(exists).sort((a,b)=>mtime(b)-mtime(a))[0];
}

/** Executable that owns a Claude Desktop process tree. */
export function isClaudeDesktopExecutable(path:string,platform:NodeJS.Platform=process.platform) {
  if(platform==='win32')return /\\WindowsApps\\Claude_[^\\]+\\app\\Claude\.exe$/i.test(path)||/\\AnthropicClaude\\app-[^\\]+\\claude\.exe$/i.test(path);
  return /\/Claude\.app\/Contents\/MacOS\/Claude$/.test(path)||/\/Claude\.app\/Contents\/Frameworks\/Claude Helper/.test(path);
}
/** Claude Code bundled by Claude Desktop, as distinct from a standalone CLI install. */
export function isBundledClaudeCode(path:string,dataDir:string,platform:NodeJS.Platform=process.platform) {
  if(platform==='win32') {
    const root=win32.join(dataDir,'claude-code').toLowerCase()+'\\';
    return path.toLowerCase().startsWith(root)&&/\\claude\.exe$/i.test(path);
  }
  return path.startsWith(posix.join(dataDir,'claude-code')+'/')&&path.endsWith('/claude.app/Contents/MacOS/claude');
}

export type ProcessRow={pid:number;ppid:number;path:string};
/** `pid<TAB>ppid<TAB>path` rows from the CIM listing; rows without a path are kept for ancestry. */
export function parseWindowsProcesses(stdout:string):ProcessRow[] {
  const rows:ProcessRow[]=[];
  for(const line of stdout.split(/\r?\n/)) {
    const m=line.match(/^(\d+)\t(\d+)\t(.*)$/);
    if(m)rows.push({pid:Number(m[1]),ppid:Number(m[2]),path:m[3].trim()});
  }
  return rows;
}
const powershell=()=>win32.join(process.env.SystemRoot||process.env.SYSTEMROOT||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
// Encoded, so no command-line quoting can change it; [char]9 is the tab between fields.
const CIM_SCRIPT="Get-CimInstance Win32_Process | ForEach-Object { '{0}{3}{1}{3}{2}' -f $_.ProcessId,$_.ParentProcessId,$_.ExecutablePath,[char]9 }";
export const CIM_ARGS=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(CIM_SCRIPT,'utf16le').toString('base64')];
let processCache:{at:number;rows:Promise<ProcessRow[]>}|undefined;
/** One CIM scan, shared briefly by the several checks a single discovery makes. */
export function windowsProcesses(run:(file:string,args:string[])=>Promise<string>=defaultRun):Promise<ProcessRow[]> {
  if(processCache&&Date.now()-processCache.at<2000)return processCache.rows;
  const rows=run(powershell(),CIM_ARGS).then(parseWindowsProcesses);
  processCache={at:Date.now(),rows};
  rows.catch(()=>{processCache=undefined;});
  return rows;
}
function defaultRun(file:string,args:string[]) {
  return new Promise<string>((resolve,reject)=>execFile(file,args,{timeout:8000,maxBuffer:8*1024*1024,windowsHide:true},(error,stdout)=>error?reject(error):resolve(String(stdout))));
}

/** Process IDs whose ancestry reaches the Claude Desktop app itself. */
export function desktopOwnedRows(rows:ProcessRow[],owner:(path:string)=>boolean) {
  const byPid=new Map(rows.map(r=>[r.pid,r]));
  return new Set(rows.map(r=>r.pid).filter(pid=>{
    const seen=new Set<number>();let current=pid;
    while(current>1&&!seen.has(current)) {
      seen.add(current);const r=byPid.get(current);if(!r)return false;
      if(owner(r.path))return true;
      current=r.ppid;
    }
    return false;
  }));
}

/** Rows of `tasklist /apps /fo csv /nh`: image, pid, memory, package full name. */
export function parseTasklistApps(stdout:string) {
  const rows:{image:string;pid:number;package:string}[]=[];
  for(const line of stdout.split(/\r?\n/)) {
    const cells=[...line.matchAll(/"((?:[^"]|"")*)"/g)].map(m=>m[1].replaceAll('""','"'));
    if(cells.length>=4&&/^\d+$/.test(cells[1]))rows.push({image:cells[0],pid:Number(cells[1]),package:cells[3]});
  }
  return rows;
}
/**
 * Which desktop apps are running, from their package identity. An app that is not installed as a
 * package cannot be judged this way and reads as running, so the bridge never claims a closed app
 * when it cannot tell (the same rule as the macOS probe).
 */
export function windowsAppsRunning(stdout:string,installed:{codex:boolean;claude:boolean}) {
  const packages=parseTasklistApps(stdout).map(r=>r.package);
  return {
    codex:!installed.codex||packages.some(p=>/^OpenAI\.Codex_/i.test(p)),
    claude:!installed.claude||packages.some(p=>/^Claude_/i.test(p)),
  };
}
const tasklist=()=>win32.join(process.env.SystemRoot||process.env.SYSTEMROOT||'C:\\Windows','System32','tasklist.exe');
/**
 * One filtered `tasklist /apps` per app image. Measured on a busy PC: an unfiltered `/apps`
 * listing took from 0.6 to 23 seconds, a filtered one about 0.25 seconds.
 */
export const TASKLIST_APPS_QUERIES=[['/apps','/fo','csv','/nh','/fi','IMAGENAME eq ChatGPT.exe'],['/apps','/fo','csv','/nh','/fi','IMAGENAME eq Claude.exe']];
function packagedApps(env:NodeJS.ProcessEnv=process.env) {
  return {codex:windowsCodexDesktop(env)!==undefined,claude:windowsClaudeDesktop(env)?.aumid!==undefined};
}
let lastApps:{at:number;value:{codex:boolean;claude:boolean}}|undefined;
let appsProbe:Promise<{codex:boolean;claude:boolean}>|undefined;
export async function probeWindowsApps(run:(file:string,args:string[])=>Promise<string>=defaultRun,installed=packagedApps()) {
  const outputs=await Promise.all(TASKLIST_APPS_QUERIES.map(args=>run(tasklist(),args)));
  const value=windowsAppsRunning(outputs.join('\n'),installed);
  lastApps={at:Date.now(),value};
  return value;
}
/**
 * The synchronous receipt-time answer. Spawning tasklist synchronously could freeze the bridge for
 * seconds on a loaded PC, so this returns the newest asynchronous answer and refreshes it in the
 * background; with no answer yet it reports both apps running, which never claims a closed app.
 */
export function probeWindowsAppsSync(refresh:()=>Promise<unknown>=()=>probeWindowsApps(),now=Date.now()) {
  if((!lastApps||now-lastApps.at>10_000)&&!appsProbe)appsProbe=refresh().catch(()=>{}).finally(()=>{appsProbe=undefined;}) as Promise<any>;
  return lastApps&&now-lastApps.at<5*60_000?{...lastApps.value}:{codex:true,claude:true};
}
export function resetWindowsAppsCache(){lastApps=undefined;appsProbe=undefined;}

/** Claude Code's Windows inbox pipe, as it validates it before connecting. */
export const CLAUDE_PIPE=/^\\\\\.\\pipe\\(?:(LOCAL)\\)?(cc-msg-[0-9a-f]{32})$/i;
export function canonicalClaudePipe(path:string) {
  const m=CLAUDE_PIPE.exec(path);if(!m)return undefined;
  return '\\\\.\\pipe\\'+(m[1]?`${m[1]}\\${m[2]}`:m[2]).toLowerCase();
}
export function claudeInboxKeyName(pid:number,pipe:string) {
  const canonical=canonicalClaudePipe(pipe);if(!canonical)return undefined;
  return `${pid}.${createHash('sha256').update(canonical).digest('hex')}.key`;
}
/**
 * Readiness only, never a credential read: the session record names a well-formed pipe and the
 * running session published the key a peer needs. desktop-sync checks the pipe's server process
 * against the session PID before it writes anything.
 */
export function windowsClaudeInbox(pid:number,configHome=claudeConfigHome(),read:(path:string)=>string=path=>readFileSync(path,'utf8'),exists:Exists=fileExists) {
  if(!Number.isSafeInteger(pid)||pid<=0)return undefined;
  try {
    const sessions=join(configHome,'sessions'),record=JSON.parse(read(join(sessions,`${pid}.json`)));
    if(record?.pid!==pid||typeof record.messagingSocketPath!=='string')return undefined;
    const key=claudeInboxKeyName(pid,record.messagingSocketPath);
    if(!key||!exists(join(sessions,key)))return undefined;
    return {pipe:record.messagingSocketPath as string,sessionId:typeof record.sessionId==='string'?record.sessionId as string:undefined};
  }catch{return undefined;}
}

/**
 * Hand a URL or a Start-menu app to Windows, the way /usr/bin/open does on macOS. explorer.exe
 * returns before the target app has started and reports exit code 1 even on success, so only a
 * failure to start explorer itself is an error.
 */
export function openWithShell(target:string,run:typeof spawn=spawn,env:NodeJS.ProcessEnv=process.env) {
  return new Promise<void>((resolve,reject)=>{
    const explorer=win32.join(env.SystemRoot||env.SYSTEMROOT||'C:\\Windows','explorer.exe');
    const child=run(explorer,[target],{windowsHide:true,detached:true,stdio:'ignore'});
    child.once('error',reject);
    child.once('spawn',()=>{child.unref();resolve();});
  });
}

/**
 * The Python that runs desktop_sync.py. /bin/sh and /usr/bin/python3 do not exist on Windows; the
 * Store's `python.exe` alias in Microsoft\WindowsApps only opens the Store, so it never counts.
 */
export function windowsPython(env:NodeJS.ProcessEnv=process.env,exists:Exists=fileExists):{binary:string;args:string[]}|undefined {
  if(env.FFD_PYTHON&&win32.isAbsolute(env.FFD_PYTHON)&&exists(env.FFD_PYTHON))return {binary:env.FFD_PYTHON,args:[]};
  const roots=(env.PATH||env.Path||'').split(';').filter(root=>root&&win32.isAbsolute(root)&&!/\\Microsoft\\WindowsApps\\?$/i.test(root));
  for(const name of ['python.exe','python3.exe'])for(const root of roots) {
    const candidate=win32.join(root,name);if(exists(candidate))return {binary:candidate,args:[]};
  }
  for(const root of roots){const launcher=win32.join(root,'py.exe');if(exists(launcher))return {binary:launcher,args:['-3']};}
  const windir=env.SystemRoot||env.SYSTEMROOT||'C:\\Windows',launcher=win32.join(windir,'py.exe');
  return exists(launcher)?{binary:launcher,args:['-3']}:undefined;
}
const bundledHelper=()=>fileURLToPath(new URL('../native/desktop-sync',import.meta.url));
/**
 * How to run the desktop-sync helper. On macOS it is the /bin/sh wrapper beside the backend; on
 * Windows the same desktop_sync.py runs under Python from PATH, with -E -s so no PYTHON*
 * variables or user site packages leak in (the wrapper's "no shell profiles" rule).
 */
export function desktopSyncCommand(args:string[],platform:NodeJS.Platform=process.platform,env:NodeJS.ProcessEnv=process.env,exists:Exists=fileExists) {
  const configured=env.WSB_DESKTOP_SYNC_BIN;
  if(platform!=='win32')return {binary:configured??bundledHelper(),args};
  if(configured&&!/\.py$/i.test(configured))return {binary:configured,args};
  const script=configured??bundledHelper().replace(/desktop-sync$/,'desktop_sync.py');
  const python=windowsPython(env,exists);
  if(!python)throw new Error('Desktop sessions on this PC need Python 3. Install it from python.org, then restart FarFromDesk.');
  return {binary:python.binary,args:[...python.args,'-E','-s',script,...args]};
}
