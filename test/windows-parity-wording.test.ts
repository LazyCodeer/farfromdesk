import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, win32} from 'node:path';
import {cursorAppBinary, cursorProjectPath, cursorProjectSlug, cursorRunning, cursorSupportDir, cursorConversationDb} from '../src/cursor-paths.js';
import {cursorCliMissing, openInCursor} from '../src/cursor-desktop.js';
import {GrantHealth, NO_RESET} from '../src/grant-health.js';
import {deniedFolders, deniedMessage} from '../src/workspace-scanner.js';
import {deepSeekHarnessCommand, nativeCommand} from '../src/platform.js';
import {dshBinary} from '../src/dsh-paths.js';
import {deviceRefusal} from '../src/brain-device.js';

test('Cursor lives in AppData on Windows and keeps its macOS paths', () => {
  const env = {LOCALAPPDATA: 'C:\\Users\\o\\AppData\\Local', APPDATA: 'C:\\Users\\o\\AppData\\Roaming', HOME: 'C:\\Users\\o'} as NodeJS.ProcessEnv;
  assert.equal(cursorAppBinary(env, 'win32'), 'C:\\Users\\o\\AppData\\Local\\Programs\\cursor\\Cursor.exe');
  assert.equal(cursorSupportDir(env, 'win32'), 'C:\\Users\\o\\AppData\\Roaming\\Cursor');
  assert.equal(cursorAppBinary({} as NodeJS.ProcessEnv, 'darwin'), '/Applications/Cursor.app');
  assert.equal(cursorSupportDir({HOME: '/Users/o'} as NodeJS.ProcessEnv, 'darwin'), join('/Users/o', 'Library', 'Application Support', 'Cursor'));
  assert.equal(cursorAppBinary({CURSOR_APP_BIN: 'X:\\c.exe'} as NodeJS.ProcessEnv, 'win32'), 'X:\\c.exe');
  assert.match(cursorConversationDb({CURSOR_SUPPORT_DIR: 'S'} as NodeJS.ProcessEnv), /conversation-search\.db$/);
});

test('Cursor process check uses tasklist on Windows and pgrep on macOS', () => {
  const calls: string[][] = [];
  const running = (out: string) => (file: string, args: string[]) => { calls.push([file, ...args]); return out; };
  assert.equal(cursorRunning('win32', running('"Cursor.exe","1234","Console","1","200,000 K"\r\n')), true);
  assert.match(calls[0][0], /tasklist\.exe$/i);
  assert.deepEqual(calls[0].slice(1), ['/FI', 'IMAGENAME eq Cursor.exe', '/NH', '/FO', 'CSV']);
  assert.equal(cursorRunning('win32', running('INFO: No tasks are running which match the specified criteria.\r\n')), false);
  assert.equal(cursorRunning('win32', () => { throw new Error('no tasklist'); }), false);
  assert.equal(cursorRunning('darwin', running('')), true);
  assert.deepEqual(calls.at(-1), ['/usr/bin/pgrep', '-xq', 'Cursor']);
  assert.equal(cursorRunning('darwin', () => { throw new Error('exit 1'); }), false);
});

test('Cursor project folders map back to Windows paths', () => {
  // As seen on a real install: drive letter lower case, every non-alphanumeric run one dash.
  assert.equal(cursorProjectSlug('C:\\Users\\sam_\\Desktop\\CHART-AGENT', 'win32'), 'c-Users-sam-Desktop-CHART-AGENT');
  const tree: Record<string, string[]> = {
    'C:\\': ['Users', 'Windows'],
    'C:\\Users': ['sam_', 'Public'],
    'C:\\Users\\sam_': ['Desktop', 'Documents'],
    'C:\\Users\\sam_\\Desktop': ['CHART-AGENT', 'CHART'],
  };
  const list = (dir: string) => { const kids = tree[dir]; if (!kids) throw new Error('ENOENT'); return kids.map(name => ({name, dir: true})); };
  assert.equal(cursorProjectPath('c-Users-sam-Desktop-CHART-AGENT', {} as NodeJS.ProcessEnv, 'win32', list), 'C:\\Users\\sam_\\Desktop\\CHART-AGENT');
  assert.equal(cursorProjectPath('c-Users-sam-Desktop-CHART', {} as NodeJS.ProcessEnv, 'win32', list), 'C:\\Users\\sam_\\Desktop\\CHART');
  assert.equal(cursorProjectPath('c-Users-sam-Desktop-CHART-AG-a1b2c3d4', {} as NodeJS.ProcessEnv, 'win32', list), 'C:\\Users\\sam_\\Desktop\\CHART-AGENT');
  assert.equal(cursorProjectPath('empty-window', {} as NodeJS.ProcessEnv, 'win32', list), null);
  assert.equal(cursorProjectPath('c-Nowhere', {} as NodeJS.ProcessEnv, 'win32', list), null);
});

test('Cursor is launched first on Windows when it is closed, then given the prompt', async () => {
  const steps: string[] = [];
  let up = false;
  await openInCursor('cursor://anysphere.cursor-deeplink/prompt?text=hi', {platform: 'win32', testing: false, running: () => up, launch: async () => { steps.push('launch'); up = true; }, open: async url => { steps.push(`open ${url}`); }, wait: async () => {}});
  assert.deepEqual(steps, ['launch', 'open cursor://anysphere.cursor-deeplink/prompt?text=hi']);
  steps.length = 0;
  await openInCursor('cursor://x', {platform: 'win32', testing: false, running: () => true, launch: async () => { steps.push('launch'); }, open: async url => { steps.push(`open ${url}`); }, wait: async () => {}});
  assert.deepEqual(steps, ['open cursor://x']);
  assert.match(cursorCliMissing('win32'), /cursor-agent login in a terminal/);
  assert.doesNotMatch(cursorCliMissing('win32'), /curl|bash/);
  assert.match(cursorCliMissing('darwin'), /In Terminal run: curl/);
});

test('only macOS can reset a stale grant', async () => {
  const runs: string[][] = [];
  const health = new GrantHealth({get: () => undefined, set: () => {}} as any, async () => null, async (f: string, a: string[]) => { runs.push([f, ...a]); return {stdout: '', stderr: ''}; }, 'win32');
  await assert.rejects(() => health.reset(), (e: Error) => e.message === NO_RESET);
  assert.deepEqual(runs, []);
  assert.equal(await health.check(false), null);
});

test('denied folders are named the Windows way, OneDrive included', () => {
  const home = 'C:\\Users\\o';
  assert.deepEqual(deniedFolders(['C:\\Users\\o\\OneDrive\\proj', 'C:\\Users\\o\\OneDrive - Contoso\\x', 'C:\\Users\\o\\Documents\\a', 'c:\\users\\o\\documents\\b', 'D:\\Work\\y'], home, 'win32'),
    ['OneDrive', 'OneDrive - Contoso', '~\\Documents', '~\\documents', 'D:\\Work']);
  const message = deniedMessage(['C:\\Users\\o\\OneDrive\\proj'], home, 'win32');
  assert.match(message, /^FarFromDesk can't read OneDrive\./);
  assert.doesNotMatch(message, /System Settings|Full Disk Access/);
  assert.match(deniedMessage(['/Users/a/Library/Mobile Documents/x'], '/Users/a', 'darwin'), /iCloud Drive\. Allow it in System Settings/);
});

test('Windows CLI discovery looks in npm, WinGet and Scoop folders, never an app folder', () => {
  const env = {PATH: '', USERPROFILE: 'C:\\Users\\o', LOCALAPPDATA: 'C:\\Users\\o\\AppData\\Local', APPDATA: 'C:\\Users\\o\\AppData\\Roaming'} as NodeJS.ProcessEnv;
  const at = (...present: string[]) => (p: string) => present.includes(p);
  assert.deepEqual(nativeCommand('claude', ['-v'], 'win32', env, at('C:\\Users\\o\\.local\\bin\\claude.exe')), {binary: 'C:\\Users\\o\\.local\\bin\\claude.exe', args: ['-v']});
  assert.deepEqual(nativeCommand('agent', [], 'win32', env, at('C:\\Users\\o\\AppData\\Local\\Microsoft\\WinGet\\Links\\agent.exe')).binary, 'C:\\Users\\o\\AppData\\Local\\Microsoft\\WinGet\\Links\\agent.exe');
  assert.deepEqual(nativeCommand('tool', [], 'win32', env, at('C:\\Users\\o\\scoop\\shims\\tool.exe')).binary, 'C:\\Users\\o\\scoop\\shims\\tool.exe');
  const npmCodex = nativeCommand('codex', ['exec'], 'win32', env, at('C:\\Users\\o\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'));
  assert.deepEqual(npmCodex.args, ['C:\\Users\\o\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', 'exec']);
  assert.throws(() => nativeCommand('cursor', [], 'win32', env, at('C:\\Users\\o\\AppData\\Local\\Programs\\cursor\\cursor.exe')), /unavailable/);
});

test('DeepSeek Harness on Windows runs its own Electron as node, only for callers that pass the env', () => {
  const install = 'C:\\Users\\o\\AppData\\Local\\Programs\\DeepSeek Harness';
  const launcher = win32.join(install, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  const present = [launcher, win32.join(install, 'DeepSeek Harness.exe'), win32.join(install, 'resources', 'app.asar')];
  const exists = (p: string) => present.includes(p);
  const env = {PATH: '', USERPROFILE: 'C:\\Users\\o', LOCALAPPDATA: 'C:\\Users\\o\\AppData\\Local'} as NodeJS.ProcessEnv;
  assert.equal(dshBinary(env, exists, 'win32'), launcher);
  const command = nativeCommand(launcher, ['--version'], 'win32', env, exists, true);
  assert.deepEqual(command, deepSeekHarnessCommand(launcher, ['--version'], exists));
  assert.equal(command.binary, win32.join(install, 'DeepSeek Harness.exe'));
  assert.deepEqual(command.args.slice(-1), ['--version']);
  assert.match(command.args[1], /app\.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli\.js$/);
  assert.deepEqual(command.env, {ELECTRON_RUN_AS_NODE: '1'});
  assert.deepEqual(nativeCommand('dsh', ['--version'], 'win32', env, exists, true), command);
  // A caller that would drop the env would open the app's window instead, so it is not offered one.
  assert.throws(() => nativeCommand('dsh', ['--version'], 'win32', env, exists), /unavailable/);
  assert.equal(dshBinary({HOME: '/Users/o'} as NodeJS.ProcessEnv, () => false, 'darwin'), 'dsh');
});

test('device refusals name the PC on Windows and keep the Mac text on macOS', () => {
  assert.equal(deviceRefusal(new Error('DESKTOP_BUSY'), 'win32'), 'I am already doing something on your PC. Let that finish, then ask me again.');
  assert.equal(deviceRefusal(new Error('DESKTOP_BUSY'), 'darwin'), 'I am already doing something on your Mac. Let that finish, then ask me again.');
  assert.match(deviceRefusal(new Error('something odd'), 'win32'), /^I could not do that on your PC: /);
  assert.equal(deviceRefusal(new Error('DESKTOP_MACOS_ONLY'), 'darwin'), 'That works on macOS only for now.');
  assert.equal(deviceRefusal(new Error('DESKTOP_MACOS_ONLY'), 'win32'), 'That works on macOS only for now, so I cannot do it on this PC yet.');
  assert.equal(deviceRefusal(new Error('SENSITIVE_TARGET'), 'win32'), 'I am not allowed to drive Windows Settings, Credential Manager or password apps.');
});

// Opt-in and read-only: finds the real Cursor install and asks whether it is running.
test('live: Cursor on this PC', {skip: process.platform !== 'win32' || process.env.FFD_LIVE_DESKTOP !== '1'}, async () => {
  const {existsSync} = await import('node:fs');
  // The runner hands tests a throwaway home and no LOCALAPPDATA, so start from the real account home.
  const {userInfo} = await import('node:os');
  assert.ok(existsSync(cursorAppBinary({HOME: userInfo().homedir} as NodeJS.ProcessEnv)), 'Cursor.exe is where the per-user installer puts it');
  assert.equal(typeof cursorRunning(), 'boolean');
  const dir = mkdtempSync(join(tmpdir(), 'ffd-cursor-live-'));
  try {
    mkdirSync(join(dir, 'a_b', 'c'), {recursive: true});
    assert.equal(cursorProjectPath(cursorProjectSlug(join(dir, 'a_b', 'c'))), join(dir, 'a_b', 'c'));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
