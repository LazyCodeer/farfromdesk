import { existsSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32, posix } from 'node:path';

export const portableAgents = process.platform !== 'darwin' || process.env.FFD_PORTABLE_AGENTS === '1';
export function defaultStateDirectory(platform = process.platform, home = homedir(), env = process.env) {
  // Preserve the established Mac installation's identity and pairing.
  if (platform === 'darwin') return posix.join(home, 'Library/Application Support/WhatsApp Session Bridge');
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'FarFromDesk');
  return posix.join(env.XDG_DATA_HOME || posix.join(home, '.local/share'), 'farfromdesk');
}
/** A program to spawn directly, and any variables it needs on top of the caller's environment. */
export type NativeCommand = { binary: string; args: string[]; env?: Record<string, string> };
export function nativeCommand(binary: string, args: string[], platform = process.platform, env = process.env,
  exists: (p: string) => boolean = p => { try { return statSync(p).isFile(); } catch { return false; } }, withEnv = false): NativeCommand {
  if (platform !== 'win32') {
    if(binary.includes('/'))return {binary,args};
    const home=env.HOME||homedir();
    const nvm=posix.join(home,'.nvm/versions/node');
    let versions:string[]=[];try{versions=readdirSync(nvm).filter(v=>/^v[0-9.]+$/.test(v)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})).map(v=>posix.join(nvm,v,'bin'));}catch{}
    for(const root of [...(env.PATH||'').split(':').filter(p=>posix.isAbsolute(p)),posix.join(home,'.local/bin'),'/opt/homebrew/bin','/usr/local/bin',...versions]) {
      const candidate=posix.join(root,binary);if(exists(candidate))return {binary:candidate,args};
    }
    if(platform==='darwin'&&binary==='codex')for(const folder of ['/Applications',posix.join(home,'Applications')])for(const app of ['Codex','ChatGPT'])for(const sub of ['codex','codex-cli/codex','codex-cli/CodexCLI.app/Contents/MacOS/codex']){
      const candidate=posix.join(folder,app+'.app','Contents/Resources',sub);if(exists(candidate))return {binary:candidate,args};
    }
    // The launcher commonly on PATH is a symlink into the mounted installer volume, so ejecting it
    // would otherwise make an installed DeepSeek Harness look missing. The app bundle carries the
    // same launcher and stays put.
    if(platform==='darwin'&&binary==='dsh')for(const folder of ['/Applications',posix.join(home,'Applications')]){
      const candidate=posix.join(folder,'DeepSeek Harness.app','Contents/Resources/runtime/cli/bin/dsh');if(exists(candidate))return {binary:candidate,args};
    }
    return {binary,args};
  }
  const absolute = win32.isAbsolute(binary);
  const home = env.USERPROFILE || homedir(), local = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), roaming = env.APPDATA || win32.join(home, 'AppData', 'Roaming');
  const name = win32.basename(binary).replace(/\.(?:exe|cmd)$/i, '');
  // The places per-user installers and package managers put a CLI, which a packaged backend's
  // narrow PATH can miss: the native installers' ~/.local/bin, npm's global folder, the per-user
  // WinGet's links, Scoop's shims and Bun's bin. Only CLI folders: an app folder such as
  // %LOCALAPPDATA%\Programs\<name> can hold a GUI executable of the same name.
  const fallbacks = [win32.join(home, '.local', 'bin'), win32.join(roaming, 'npm'), win32.join(local, 'Microsoft', 'WinGet', 'Links'), win32.join(home, 'scoop', 'shims'), win32.join(home, '.bun', 'bin')];
  const roots = absolute ? [''] : [...(env.PATH || env.Path || '').split(';').filter(Boolean), ...fallbacks];
  // DeepSeek Harness ships dsh as a cmd launcher that runs the app's own Electron as node. Only a
  // caller that passes the returned env may get it: without ELECTRON_RUN_AS_NODE the same call
  // opens the app's window instead.
  if (withEnv && name.toLowerCase() === 'dsh') {
    const launcher = absolute && /\.cmd$/i.test(binary) ? binary : win32.join(local, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
    const harness = deepSeekHarnessCommand(launcher, args, exists);
    if (harness && (!absolute || /\.cmd$/i.test(binary))) {
      // An explicit dsh.exe on PATH still wins over the app's launcher.
      if (!absolute) for (const root of roots) if (exists(win32.join(root, 'dsh.exe'))) return { binary: win32.join(root, 'dsh.exe'), args };
      return harness;
    }
  }
  for (const root of roots) {
    const candidate = absolute ? binary : win32.join(root, binary);
    for (const exe of /\.exe$/i.test(candidate) ? [candidate] : [candidate + '.exe']) if (exists(exe)) return { binary: exe, args };
    // npm's Windows launcher is a cmd file; never feed user arguments to cmd.exe.
    if (/codex(?:\.cmd)?$/i.test(candidate)) {
      const script = win32.join(win32.dirname(candidate), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (exists(script)) return { binary: process.execPath, args: [script, ...args] };
    }
  }
  throw new Error(`Native ${win32.basename(binary)} executable unavailable. Install its Windows CLI and sign in there, then restart FarFromDesk.`);
}
/**
 * DeepSeek Harness's Windows `dsh.cmd` sets ELECTRON_RUN_AS_NODE and runs the app executable on a
 * CLI inside app.asar. A cmd file must never receive user arguments, so the same call is made
 * directly; the caller adds `env` to the child's environment.
 */
export function deepSeekHarnessCommand(launcher: string, args: string[], exists: (p: string) => boolean = p => { try { return statSync(p).isFile(); } catch { return false; } }) {
  if (!exists(launcher)) return undefined;
  const install = win32.resolve(win32.dirname(launcher), '..', '..', '..', '..');
  const exe = win32.join(install, 'DeepSeek Harness.exe'), asar = win32.join(install, 'resources', 'app.asar');
  if (!exists(exe) || !exists(asar)) return undefined;
  return { binary: exe, args: ['--expose-internals', win32.join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'), ...args], env: { ELECTRON_RUN_AS_NODE: '1' } as Record<string, string> };
}
export function requirePortableCLI(mode: unknown) {
  if (portableAgents && mode === 'desktop') throw new Error('Desktop session delivery is not supported by this platform adapter. Choose an exact saved CLI session.');
}

/** What the owner calls this computer in messages and the app: Mac, PC, or computer elsewhere. */
export function computerName(platform: NodeJS.Platform = process.platform) {
  return platform === 'darwin' ? 'Mac' : platform === 'win32' ? 'PC' : 'computer';
}
