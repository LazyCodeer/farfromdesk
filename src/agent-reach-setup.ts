import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {accessSync,closeSync,constants,existsSync,lstatSync,mkdtempSync,mkdirSync,openSync,readFileSync,realpathSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter,dirname,join,relative,isAbsolute,sep} from 'node:path';
import {windowsPowerShell} from './power.js';

const PIN='14c213405669414492bda0f8d52cc6531d062c45';
const source=`git+https://github.com/Panniantong/Agent-Reach.git@${PIN}`;
const windows=process.platform==='win32';
const system32=()=>join(process.env.SystemRoot??'C:\\Windows','System32');

// Windows has no mode bits, so a private folder is one whose access list grants
// only this account and the operating system (SYSTEM). Setup creates the tool
// folder with exactly that list; every later use re-reads it from disk.
let userSid:string|undefined;
function currentUserSid(){
  if(userSid)return userSid;
  const out=execFileSync(join(system32(),'whoami.exe'),['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true,timeout:10_000});
  const sid=/"(S-1-[0-9-]+)"\s*$/.exec(out.trim())?.[1];if(!sid)throw Error('Could not identify this Windows account.');
  return userSid=sid;
}
/** SIDs that an SDDL access list allows in; undefined when it cannot be read. */
export function sddlAllowedSids(sddl:string):string[]|undefined {
  const dacl=/D:[A-Z]*((?:\([^()]*\))*)/.exec(sddl);
  // An entry this cannot read (such as a conditional one) fails closed.
  if(!dacl||sddl[dacl.index+dacl[0].length]==='(')return;
  const sids:string[]=[];
  for(const ace of dacl[1].match(/\([^()]*\)/g)??[]){
    const fields=ace.slice(1,-1).split(';');if(fields.length<6)return;
    // Deny entries only narrow access; every other entry type is counted as access.
    if(fields[0]!=='D')sids.push(fields[5]);
  }
  return sids;
}
function windowsPrivate(dir:string){
  const scratch=mkdtempSync(join(tmpdir(),'ffd-acl-'));
  try {
    execFileSync(join(system32(),'icacls.exe'),[dir,'/save',join(scratch,'acl'),'/q'],{stdio:'ignore',windowsHide:true,timeout:10_000});
    const sids=sddlAllowedSids(readFileSync(join(scratch,'acl')).toString('utf16le'));
    const owner=currentUserSid();
    return !!sids&&sids.length>0&&sids.every(sid=>sid===owner||sid==='SY'||sid==='S-1-5-18');
  }catch{return false;}finally{rmSync(scratch,{recursive:true,force:true});}
}
function lockWindowsDir(dir:string){
  execFileSync(join(system32(),'icacls.exe'),[dir,'/inheritance:r','/grant:r',`*${currentUserSid()}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F','/q'],{stdio:'ignore',windowsHide:true,timeout:10_000});
}
const privateDir=(dir:string)=>{
  const v=lstatSync(dir);
  if(!v.isDirectory()||v.isSymbolicLink()||(windows?!windowsPrivate(dir):(process.getuid&&v.uid!==process.getuid!()||(v.mode&0o077)!==0)))throw Error('Research tool folders must be private real directories.');
};
const below=(root:string,file:string)=>{const part=relative(root,file);return part!==''&&!isAbsolute(part)&&part!=='..'&&!part.startsWith(`..${sep}`);};
function executable(stage:string){
  privateDir(stage);const exe=join(stage,'bin',windows?'agent-reach.exe':'agent-reach'),resolved=realpathSync(exe);
  if(!below(realpathSync(stage),resolved))throw Error('Research executable is outside its installation.');
  // uv's Windows launcher is a small native program with the script appended.
  const stat=lstatSync(resolved);if(!stat.isFile()||stat.size>(windows?4:1)*1024*1024)throw Error('Research executable is invalid.');
  accessSync(exe,constants.X_OK);return {exe,digest:createHash('sha256').update(readFileSync(resolved)).digest('hex')};
}
/** An interrupted or unverified managed install must never shadow a trusted tool. */
export function managedAgentReach(stateRoot:string,allowSetupLock=false):string|undefined {
  const root=join(stateRoot,'agent-reach');try{lstatSync(root);}catch(e:any){if(e.code==='ENOENT')return;throw e;}
  try{
    privateDir(root);if(!allowSetupLock&&existsSync(join(root,'setup.lock')))throw Error('setup incomplete');
    const manifest=join(root,'manifest.json'),info=lstatSync(manifest);if(!info.isFile()||info.isSymbolicLink()||info.size>4096)throw Error('invalid manifest');
    const data=JSON.parse(readFileSync(manifest,'utf8'));
    if(data.pin!==PIN||typeof data.stage!=='string'||!/^install-[a-zA-Z0-9]+$/.test(data.stage)||typeof data.digest!=='string')throw Error('invalid manifest');
    const found=executable(join(root,data.stage));if(found.digest!==data.digest)throw Error('changed executable');return found.exe;
  }catch{throw Error('The managed research installation is incomplete or changed. Review its tool folder before trying again.');}
}

// The local supervisor owns the installer process group, a deadline, and a pipe
// whose other end is held by the caller. Caller death closes the pipe and kills
// the group, even if the caller was terminated without a cleanup handler.
const supervisor=`const net=require('node:net'),{spawn}=require('node:child_process');
const die=()=>{try{process.kill(-process.pid,'SIGKILL')}catch{process.exit(1)}};
const watch=new net.Socket({fd:3,readable:true,writable:true});watch.on('end',die);watch.on('error',die);watch.resume();
const child=spawn(process.argv[1],process.argv.slice(2),{stdio:'ignore'});
const timer=setTimeout(die,Number(process.env.FFD_SETUP_TIMEOUT));
child.on('error',die);child.on('exit',code=>{clearTimeout(timer);if(code===0)watch.write('ok',die);else die()});`;

// Windows has no process groups. This supervisor starts the installer suspended
// inside a Job Object that kills every process in it when the job ends, so
// nothing the installer starts can outlive it, even after its own parent exits.
// The caller holds the supervisor's stdin: when the caller dies the pipe closes
// and the job is ended. The supervisor is also in the caller's kill-on-close
// job (Node puts non-detached children there), so killing the caller ends the
// supervisor, which closes the installer's job. On success the supervisor
// writes "ok" and then ends the job, stopping anything left behind.
const windowsSupervisor=`$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
public static class FfdSetupJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A; public ulong B; public ulong C; public ulong D; public ulong E; public ulong F; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  static volatile bool callerGone;
  static void Watch() { try { Stream input = Console.OpenStandardInput(); byte[] b = new byte[64]; while (input.Read(b, 0, b.Length) > 0) { } } catch { } callerGone = true; }
  public static int Run(string application, string commandLine, string directory, int timeoutMs) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return 2;
    ExtendedLimit limit = new ExtendedLimit();
    limit.Basic.LimitFlags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref limit, Marshal.SizeOf(typeof(ExtendedLimit)))) return 2;
    StartupInfo startup = new StartupInfo();
    startup.cb = Marshal.SizeOf(typeof(StartupInfo));
    ProcessInfo info;
    // Suspended until it is in the job, with no window and none of this process's pipes.
    if (!CreateProcess(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, 0x08000004, IntPtr.Zero, directory, ref startup, out info)) return 2;
    if (!AssignProcessToJobObject(job, info.hProcess)) { TerminateProcess(info.hProcess, 1); return 2; }
    ResumeThread(info.hThread);
    Thread watcher = new Thread(Watch);
    watcher.IsBackground = true;
    watcher.Start();
    DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
    while (true) {
      if (WaitForSingleObject(info.hProcess, 100) == 0) {
        uint code;
        if (GetExitCodeProcess(info.hProcess, out code) && code == 0 && !callerGone) {
          Stream output = Console.OpenStandardOutput();
          output.Write(new byte[] { 111, 107 }, 0, 2);
          output.Flush();
          TerminateJobObject(job, 0);
          return 0;
        }
        TerminateJobObject(job, 1);
        return 1;
      }
      if (callerGone || DateTime.UtcNow > deadline) { TerminateJobObject(job, 1); return 1; }
    }
  }
}
'@
exit [FfdSetupJob]::Run($env:FFD_SETUP_APP, $env:FFD_SETUP_COMMAND, (Get-Location).ProviderPath, [int]$env:FFD_SETUP_TIMEOUT)
`;

/** One Windows command-line argument, quoted the way CommandLineToArgvW reads it back. */
export function windowsArgument(value:string){
  if(value&&!/[\s"]/.test(value))return value;
  return `"${value.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')}"`;
}
function onPath(name:string){
  for(const path of (process.env.PATH??process.env.Path??'').split(delimiter).filter(isAbsolute)){
    const file=join(path,name);try{accessSync(file,constants.X_OK);if(statSync(file).isFile())return file;}catch{}
  }
}

/** Install only after an explicit local CLI invocation. Never invokes upstream setup. */
export async function setupAgentReach(stateRoot:string,options:{uv?:string;git?:string;timeoutMs?:number}={}):Promise<string>{
  const state=lstatSync(stateRoot);if(!state.isDirectory()||state.isSymbolicLink())throw Error('Open FarFromDesk first; its state folder must be a real directory.');
  const root=join(realpathSync(stateRoot),'agent-reach');
  const uv=options.uv??onPath(windows?'uv.exe':'uv');
  const prerequisites=windows?'Install uv, Git and Python 3.10 or newer first, then retry this local command.':'Install uv and Python 3.10 or newer first, then retry this local command.';
  // Do not hide an existing separately installed tool if setup cannot start.
  if(!uv&&!existsSync(root))throw Error(prerequisites);
  let created=false;try{mkdirSync(root,{mode:0o700});created=true;}catch(e:any){if(e.code!=='EEXIST')throw e;}
  if(created&&windows)lockWindowsDir(root);
  privateDir(root);
  const lock=join(root,'setup.lock');let fd:number;
  try{fd=openSync(lock,'wx',0o600);}catch(e:any){if(e.code==='EEXIST')throw Error('Research setup is running or was interrupted. Review its tool folder before retrying.');throw e;}closeSync(fd);
  try {
    const manifest=join(root,'manifest.json');
    // Verify existing installs while holding the exclusive lock.
    if(existsSync(manifest)){
      managedAgentReach(stateRoot,true);return 'Research tool is already installed. No changes were made.';
    }
    if(!uv)throw Error(prerequisites);
    const stage=mkdtempSync(join(root,'install-'));for(const dir of ['tools','bin','home','cache'])mkdirSync(join(stage,dir),{mode:0o700});
    const timeout=String(options.timeoutMs??180_000);
    if(windows){
      // The same isolation as the Mac HOME: every per-user location uv, Git and
      // Python read or write is inside the stage, and no system or global Git
      // configuration (credential helpers included) is loaded.
      const home=join(stage,'home'),roaming=join(home,'AppData','Roaming'),local=join(home,'AppData','Local'),temp=join(local,'Temp');
      for(const dir of [roaming,temp])mkdirSync(dir,{recursive:true});
      const git=options.git??onPath('git.exe'),systemRoot=process.env.SystemRoot??'C:\\Windows';
      await new Promise<void>((resolve,reject)=>{
        const child=spawn(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(windowsSupervisor,'utf16le').toString('base64')],{cwd:stage,env:{
          HOME:home,USERPROFILE:home,APPDATA:roaming,LOCALAPPDATA:local,TEMP:temp,TMP:temp,SystemRoot:systemRoot,windir:systemRoot,ComSpec:join(system32(),'cmd.exe'),PATHEXT:'.COM;.EXE;.BAT;.CMD',
          PATH:[dirname(uv),...(git?[dirname(git)]:[]),system32(),systemRoot].join(';'),
          UV_TOOL_DIR:join(stage,'tools'),UV_TOOL_BIN_DIR:join(stage,'bin'),UV_CACHE_DIR:join(stage,'cache'),UV_NO_CONFIG:'1',UV_PYTHON_DOWNLOADS:'never',
          GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL',GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never',LANG:'C.UTF-8',
          FFD_SETUP_APP:uv,FFD_SETUP_COMMAND:[uv,'tool','install',source].map(windowsArgument).join(' '),FFD_SETUP_TIMEOUT:timeout,
        },stdio:['pipe','pipe','ignore'],windowsHide:true});
        let receipt='';child.stdout.on('data',chunk=>{receipt=(receipt+String(chunk)).slice(0,3);});
        child.stdin.on('error',()=>{});
        child.on('error',()=>reject(Error('Could not start the research installer.')));
        child.on('close',code=>{child.stdin.destroy();if(receipt==='ok'&&code===0)resolve();else reject(Error('Research setup failed or timed out. Check uv, Git and Python 3.10+, then retry.'));});
      });
    } else await new Promise<void>((resolve,reject)=>{
      const child=spawn(process.execPath,['-e',supervisor,uv,'tool','install',source],{cwd:stage,env:{HOME:join(stage,'home'),PATH:[dirname(uv),'/usr/bin','/bin','/usr/local/bin','/opt/homebrew/bin'].join(delimiter),UV_TOOL_DIR:join(stage,'tools'),UV_TOOL_BIN_DIR:join(stage,'bin'),UV_CACHE_DIR:join(stage,'cache'),UV_NO_CONFIG:'1',UV_PYTHON_DOWNLOADS:'never',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',LANG:'C.UTF-8',FFD_SETUP_TIMEOUT:timeout},stdio:['ignore','ignore','ignore','pipe'],detached:true});
      let receipt='';child.stdio[3]?.on('data',chunk=>{receipt+=String(chunk).slice(0,3);});
      child.on('error',()=>reject(Error('Could not start the research installer.')));
      child.on('close',(_code,signal)=>receipt==='ok'&&signal==='SIGKILL'?resolve():reject(Error('Research setup failed or timed out. Check uv and Python 3.10+, then retry.')));
    });
    const {digest}=executable(stage);
    writeFileSync(manifest,JSON.stringify({pin:PIN,stage:stage.slice(root.length+1),digest}),{flag:'wx',mode:0o600});
    return 'Public GitHub and Exa web research installed. No browser setup or login was performed.';
  } finally {rmSync(lock,{force:true});}
}
