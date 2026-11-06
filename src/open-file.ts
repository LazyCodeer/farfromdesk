import {execFile} from 'node:child_process';
import {basename,posix,win32} from 'node:path';
import {promisify} from 'node:util';
import {windowsPowerShell} from './power.js';

/**
 * open_file for the brain: opens a file the owner already has, in its default app or in a named one.
 *
 * macOS hands both cases to `/usr/bin/open [-a App]`. Windows has no such command that is safe to
 * feed a path: `cmd /c start` would parse the path as cmd syntax. So a short hidden PowerShell does
 * it through ShellExecute (the same thing double-clicking does), and a named app is resolved the
 * way Windows itself finds programs: App Paths in the registry, then Start-menu shortcuts, then
 * PATH (which includes the app execution aliases such as notepad.exe). The path and the app name
 * reach PowerShell through environment variables, never through the command text.
 */

/** The owner's own folders the brain may read, write or open files in. Windows calls Movies "Videos". */
export function ownerFolders(platform:NodeJS.Platform=process.platform):string[] {
  return ['Downloads','Desktop','Documents','Pictures',platform==='win32'?'Videos':'Movies','Music'];
}
/** "Downloads, Desktop, ... or Music", for messages. */
export function ownerFolderList(platform:NodeJS.Platform=process.platform):string {
  const f=ownerFolders(platform);return `${f.slice(0,-1).join(', ')} or ${f[f.length-1]}`;
}
/** The owner folder `path` is inside, or undefined. Windows paths compare without case. */
export function ownerRoot(path:string,home:string,platform:NodeJS.Platform=process.platform):string|undefined {
  const p=platform==='win32'?win32:posix,fold=(s:string)=>platform==='win32'?s.toLowerCase():s;
  return ownerFolders(platform).map(d=>p.join(home,d)).find(r=>fold(path).startsWith(fold(r+p.sep)));
}
/** Whether `raw` names an absolute path: `/x` on macOS, `C:\x` (or `/x`) on Windows. */
export function absoluteOwnerPath(raw:string,platform:NodeJS.Platform=process.platform):boolean {
  return platform==='win32'?win32.isAbsolute(raw):raw.startsWith('/');
}
/**
 * The full path for a name the model gave: absolute, `~/...`, `Documents/...`, or a bare name in
 * `base`. Undefined when it is outside the owner's folders or passes through a hidden one.
 */
export function ownerFolderPath(raw:string,base:'Downloads'|'Documents',home:string,platform:NodeJS.Platform=process.platform):string|undefined {
  const p=platform==='win32'?win32:posix,folders=ownerFolders(platform);
  const asked=raw.trim().replace(platform==='win32'?/^~(?=[\\/]|$)/:/^~(?=\/|$)/,home);
  const named=new RegExp(`^(${folders.join('|')})${platform==='win32'?'[\\\\/]':'\\/'}`,platform==='win32'?'i':'');
  const path=absoluteOwnerPath(asked,platform)?(platform==='win32'?win32.normalize(asked):asked):named.test(asked)?p.join(home,asked):p.join(home,base,asked);
  const root=ownerRoot(path,home,platform);
  // After the root's own separator, so the first part is the file or folder, not an empty string (which refused every path).
  if(!root||path.slice(root.length+1).split(p.sep).some(part=>!part||part.startsWith('.')||part==='..'))return undefined;
  return path;
}

export type OpenRunner=(file:string,args:string[],options:{env:NodeJS.ProcessEnv;timeout:number;windowsHide:true})=>Promise<{stdout:string}>;
const execRunner:OpenRunner=(file,args,options)=>promisify(execFile)(file,args,options).then(r=>({stdout:String(r.stdout)}));

/** Mac apps a model may still name on a PC, and what to use there instead. */
const MAC_ONLY:Record<string,string>={numbers:'Excel',pages:'Word',keynote:'PowerPoint',textedit:'Notepad',preview:'Photos',finder:'File Explorer',safari:'Edge'};
const ALIASES:Record<string,string[]>={
  word:['winword.exe'],powerpoint:['powerpnt.exe'],excel:['excel.exe'],outlook:['outlook.exe'],onenote:['onenote.exe'],
  edge:['msedge.exe'],chrome:['chrome.exe'],brave:['brave.exe'],firefox:['firefox.exe'],paint:['mspaint.exe'],
  notepad:['notepad.exe'],'file explorer':['explorer.exe'],explorer:['explorer.exe'],
  'vs code':['code.exe'],'visual studio code':['code.exe'],code:['code.exe'],cursor:['cursor.exe'],
};

/** The lower-case name the owner or model used, without "Microsoft"/"Google" and without ".exe". */
export function windowsAppKey(app:string):string {
  return app.trim().toLowerCase().replace(/\.exe$/,'').replace(/^(microsoft|google|mozilla)\s+/,'').replace(/\s+/g,' ');
}
/** The executable names App Paths and PATH are searched for, best first. */
export function windowsExeNames(app:string):string[] {
  const key=windowsAppKey(app);
  const names=[...(ALIASES[key]??[]),`${key.replace(/\s+/g,'')}.exe`];
  return [...new Set(names)].filter(n=>/^[\w.-]+\.exe$/.test(n));
}

/** ASCII only: Windows PowerShell 5.1 decodes an encoded command fine, but keep it plain anyway. */
const SCRIPT=String.raw`
$ErrorActionPreference = 'Stop'
function Done($o) { [Console]::Out.Write(($o | ConvertTo-Json -Compress)); exit 0 }
$path = $env:FFD_OPEN_PATH; $app = $env:FFD_OPEN_APP
$names = @(([string]$env:FFD_OPEN_EXES).Split(';') | Where-Object { $_ })
$exe = $null
if ($app) {
  foreach ($n in $names) {
    if ($exe) { break }
    foreach ($root in @('HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths')) {
      try {
        $v = (Get-Item -LiteralPath (Join-Path $root $n)).GetValue('')
        if ($v) { $v = [Environment]::ExpandEnvironmentVariables(([string]$v).Trim().Trim('"')); if (Test-Path -LiteralPath $v -PathType Leaf) { $exe = $v; break } }
      } catch {}
    }
  }
  if (-not $exe) {
    $want = $env:FFD_OPEN_KEY; $best = $null
    try { $shell = New-Object -ComObject WScript.Shell } catch { $shell = $null }
    if ($shell) {
      foreach ($dir in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'))) {
        if ($exe -or -not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
        foreach ($lnk in (Get-ChildItem -LiteralPath $dir -Filter *.lnk -Recurse -ErrorAction SilentlyContinue)) {
          $b = $lnk.BaseName.ToLowerInvariant() -replace '^(microsoft|google|mozilla)\s+', ''
          if ($b -ne $want -and -not $b.StartsWith($want + ' ')) { continue }
          try { $t = $shell.CreateShortcut($lnk.FullName).TargetPath } catch { continue }
          if ($t -and $t -match '\.exe$' -and (Test-Path -LiteralPath $t -PathType Leaf)) { if ($b -eq $want) { $exe = $t; break }; if (-not $best) { $best = $t } }
        }
      }
    }
    if (-not $exe) { $exe = $best }
  }
  if (-not $exe) {
    foreach ($n in $names) { $c = Get-Command $n -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $exe = $c.Source; break } }
  }
  if (-not $exe) {
    $store = $null
    try { $store = Get-StartApps | Where-Object { ($_.Name.ToLowerInvariant() -replace '^(microsoft|google|mozilla)\s+', '') -eq $env:FFD_OPEN_KEY } | Select-Object -First 1 } catch {}
    if ($store) { Done @{ ok = $false; error = 'STORE_APP'; name = $store.Name } }
    Done @{ ok = $false; error = 'APP_NOT_FOUND' }
  }
}
if ($env:FFD_OPEN_RESOLVE_ONLY -eq '1') { Done @{ ok = $true; exe = $exe } }
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.UseShellExecute = $true
if ($exe) { $psi.FileName = $exe; $psi.Arguments = '"' + $path + '"' } else { $psi.FileName = $path }
try { [void][System.Diagnostics.Process]::Start($psi) } catch { Done @{ ok = $false; error = 'OPEN_FAILED'; detail = $_.Exception.Message } }
Done @{ ok = $true; exe = $exe }
`;

export function windowsOpenCommand(path:string,app:string|undefined,env:NodeJS.ProcessEnv=process.env,resolveOnly=false){
  const childEnv:NodeJS.ProcessEnv={...env,FFD_OPEN_PATH:path,FFD_OPEN_APP:app??'',FFD_OPEN_KEY:app?windowsAppKey(app):'',FFD_OPEN_EXES:app?windowsExeNames(app).join(';'):'',FFD_OPEN_RESOLVE_ONLY:resolveOnly?'1':''};
  return {file:windowsPowerShell(),args:['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(SCRIPT,'utf16le').toString('base64')],env:childEnv};
}

/** Which program a named app resolves to on this PC, without opening anything. */
export async function resolveWindowsApp(app:string,run:OpenRunner=execRunner):Promise<{ok:boolean;exe?:string;error?:string;name?:string}>{
  const c=windowsOpenCommand('',app,process.env,true);
  return JSON.parse((await run(c.file,c.args,{env:c.env,timeout:30000,windowsHide:true})).stdout||'{}');
}

/** Opens `real` (already checked to be in the owner's folders) and says what happened, for the model. */
export async function openOwnerFile(real:string,app?:string,deps:{platform?:NodeJS.Platform;run?:OpenRunner}={}):Promise<string>{
  const platform=deps.platform??process.platform,run=deps.run??execRunner,name=basename(real);
  if(platform==='darwin'){
    try{await run('/usr/bin/open',[...(app?['-a',app]:[]),real],{env:process.env,timeout:15000,windowsHide:true});return `Opened ${name}${app?` in ${app}`:''}. Read the window to check it.`;}
    catch{return app?`${app} could not open ${name}. Is ${app} installed?`:`${name} could not be opened.`;}
  }
  if(platform!=='win32')return 'Opening files works on macOS and Windows only.';
  if(app){
    const instead=MAC_ONLY[windowsAppKey(app)];
    if(instead)return `${app} is a Mac app and this is a Windows PC. Use ${instead} instead, or leave the app out to open ${name} in its default app.`;
  }
  let result:{ok?:boolean;error?:string;exe?:string;name?:string;detail?:string};
  try{const c=windowsOpenCommand(real,app);result=JSON.parse((await run(c.file,c.args,{env:c.env,timeout:30000,windowsHide:true})).stdout||'{}');}
  catch{return app?`${app} could not open ${name}.`:`${name} could not be opened.`;}
  if(result.ok)return `Opened ${name}${app?` in ${app}`:''}. Read the window to check it.`;
  if(result.error==='APP_NOT_FOUND')return `${app} is not installed on this PC, so ${name} was not opened. Check with find_app, or leave the app out to use the default app.`;
  if(result.error==='STORE_APP')return `${result.name??app} is a Microsoft Store app, and I can only hand it a file as the default app for that file type. Leave the app out to open ${name} in its default app.`;
  if(!app&&/associat/i.test(result.detail??''))return `No app on this PC is set to open ${name}. Name an app to open it in.`;
  return app?`${app} could not open ${name}.`:`${name} could not be opened.`;
}
