import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32, posix } from 'node:path';

export const portableAgents = process.platform !== 'darwin' || process.env.FFD_PORTABLE_AGENTS === '1';
export function defaultStateDirectory(platform = process.platform, home = homedir(), env = process.env) {
  // Preserve the established Mac installation's identity and pairing.
  if (platform === 'darwin') return posix.join(home, 'Library/Application Support/WhatsApp Session Bridge');
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'FarFromDesk');
  return posix.join(env.XDG_DATA_HOME || posix.join(home, '.local/share'), 'farfromdesk');
}
export function nativeCommand(binary: string, args: string[], platform = process.platform, env = process.env,
  exists: (p: string) => boolean = p => { try { return statSync(p).isFile(); } catch { return false; } }) {
  if (platform !== 'win32') {
    if(binary.includes('/'))return {binary,args};
    const home=env.HOME||homedir();
    for(const root of [...(env.PATH||'').split(':').filter(Boolean),posix.join(home,'.local/bin'),'/opt/homebrew/bin','/usr/local/bin']) {
      const candidate=posix.join(root,binary);if(exists(candidate))return {binary:candidate,args};
    }
    return {binary,args};
  }
  const absolute = win32.isAbsolute(binary);
  const roots = absolute ? [''] : [...(env.PATH || env.Path || '').split(';').filter(Boolean), win32.join(env.USERPROFILE || homedir(), '.local', 'bin')];
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
export function requirePortableCLI(mode: unknown) {
  if (portableAgents && mode === 'desktop') throw new Error('Desktop session delivery is not supported by this platform adapter. Choose an exact saved CLI session.');
}
