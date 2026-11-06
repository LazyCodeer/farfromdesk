import {spawn,execFile,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/**
 * How a trusted, bundled mail helper is started. On macOS the helpers are compiled Swift
 * executables run with an empty environment. On Windows they are PowerShell scripts
 * (native/local-mail-*.ps1): Windows PowerShell 5.1 runs them hidden (windowsHide, so no
 * console flashes) with only the variables it needs to start and to compile its C# once.
 * No inherited variable, credential or mailbox data is passed.
 */
export type MailHelperCommand={file:string;args:string[];env:NodeJS.ProcessEnv;windowsHide:true};

const systemRoot=(env:NodeJS.ProcessEnv)=>env.SystemRoot??env.SYSTEMROOT??'C:\\Windows';
export const windowsPowerShellPath=(env:NodeJS.ProcessEnv=process.env)=>join(systemRoot(env),'System32','WindowsPowerShell','v1.0','powershell.exe');

export function mailHelperCommand(executable:string,args:string[],platform:NodeJS.Platform=process.platform,env:NodeJS.ProcessEnv=process.env):MailHelperCommand{
  if(platform==='win32'&&/\.ps1$/i.test(executable)){
    const root=systemRoot(env),temp=env.TEMP??env.TMP??tmpdir();
    // Add-Type compiles into TEMP; PowerShell itself needs SystemRoot to load .NET.
    return {file:windowsPowerShellPath(env),args:['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',executable,...args],env:{SystemRoot:root,windir:root,TEMP:temp,TMP:temp},windowsHide:true};
  }
  return {file:executable,args,env:{},windowsHide:true};
}

export function spawnMailHelper(executable:string,args:string[]):ChildProcessWithoutNullStreams{
  const c=mailHelperCommand(executable,args);
  return spawn(c.file,c.args,{stdio:['pipe','pipe','pipe'],env:c.env,windowsHide:c.windowsHide});
}

/**
 * Identifies the current OS boot, so staged credentials from an earlier boot can be cleaned up
 * once every helper of that boot is certainly gone. macOS has a boot session UUID. Windows
 * counts boots in the BootId registry value; a Fast Startup restart resumes the same kernel
 * session and keeps the same id, which only keeps staged slots protected for longer.
 */
export async function currentBootId(platform:NodeJS.Platform=process.platform,run:(file:string,args:string[])=>Promise<string>=runQuiet):Promise<string>{
  if(platform==='darwin'){
    const id=(await run('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'])).trim();
    if(!/^[a-fA-F0-9-]{36}$/.test(id))throw Error('boot id unavailable');return id;
  }
  if(platform==='win32'){
    const out=await run(join(systemRoot(process.env),'System32','reg.exe'),['query','HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters','/v','BootId']);
    const m=/^\s*BootId\s+REG_DWORD\s+0x([0-9a-fA-F]{1,8})\s*$/m.exec(out);if(!m)throw Error('boot id unavailable');
    return `windows-boot-${parseInt(m[1]!,16)}`;
  }
  throw Error('boot id unavailable');
}

function runQuiet(file:string,args:string[]){
  return new Promise<string>((resolve,reject)=>execFile(file,args,{encoding:'utf8',timeout:3000,env:{},windowsHide:true},(error,stdout)=>error?reject(error):resolve(stdout)));
}
