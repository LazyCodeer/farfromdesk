import {existsSync} from 'node:fs';
import {homedir,userInfo} from 'node:os';
import {join,win32} from 'node:path';

/**
 * DeepSeek Harness is installed and signed in by the owner in their own home. The Local app runs
 * its backend with an isolated HOME so its state stays separate, and that would otherwise hide the
 * owner's install behind an empty app-private home: the credential and the session log would look
 * missing and every DeepSeek session would read as signed out. When we are isolated, resolve the
 * owner's real home instead. An explicit DSH_HOME always wins, which is also how the CLI itself
 * decides where its profiles and sessions live.
 */
export function dshOwnerHome(env:NodeJS.ProcessEnv=process.env):string {
  if(env.FFD_ISOLATED_LOCAL!=='1')return env.HOME?.trim()||homedir();
  try{return userInfo().homedir;}catch{return homedir();}
}
export const dshHome=(env:NodeJS.ProcessEnv=process.env):string=>env.DSH_HOME?.trim()||join(dshOwnerHome(env),'.dsh');
export const dshSessionsDir=(env:NodeJS.ProcessEnv=process.env):string=>join(dshHome(env),'sessions');
export const dshCredentialsPath=(env:NodeJS.ProcessEnv=process.env):string=>join(dshHome(env),'.credentials.yaml');
/**
 * The launcher that boots a profile. DSH_BIN exists for tests and unusual installs.
 *
 * Relying on PATH alone was a real bug: the packaged Local backend is started by the desktop app
 * with `PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`, and the DeepSeek installer puts its
 * `dsh` symlink in `/usr/local/bin`. The spawn then failed with ENOENT and the owner was told
 * "DeepSeek Harness is not installed" on a machine where it was installed and signed in. Known
 * absolute locations are tried before the bare name, and `exists` is injectable so a test can say
 * what is installed. A broken symlink counts as missing, which is the honest answer.
 */
export const dshBinary=(env:NodeJS.ProcessEnv=process.env,exists:(path:string)=>boolean=existsSync,platform:NodeJS.Platform=process.platform):string=>{
  const configured=env.DSH_BIN?.trim()||env.WSB_DSH_BIN?.trim();
  if(configured)return configured;
  const home=dshOwnerHome(env);
  if(platform==='win32'){
    // The DeepSeek Harness installer is per-user under %LOCALAPPDATA%\Programs; its launcher is a
    // .cmd, which nativeCommand turns into a direct call before anything runs it.
    const local=env.LOCALAPPDATA?.trim()||win32.join(home,'AppData','Local'),roaming=env.APPDATA?.trim()||win32.join(home,'AppData','Roaming');
    const winRoots=[win32.join(home,'.local','bin'),win32.join(home,'.bun','bin'),win32.join(roaming,'npm'),win32.join(local,'Programs','DeepSeek Harness','resources','runtime','cli','bin')];
    for(const root of winRoots)for(const name of ['dsh.exe','dsh.cmd']){const candidate=win32.join(root,name);if(exists(candidate))return candidate;}
    return 'dsh';
  }
  const names=['dsh'];
  const roots=[
    join(home,'.local','bin'),
    join(home,'.bun','bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin',
    join(home,'Applications','DeepSeek Harness.app','Contents','Resources','runtime','cli','bin'),
  ];
  for(const root of roots)for(const name of names){const candidate=join(root,name);if(exists(candidate))return candidate;}
  return 'dsh';
};