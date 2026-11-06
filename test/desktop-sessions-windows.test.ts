import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import {
  claudeDesktopDataDir, windowsClaudeDesktop, windowsCodexDesktop, windowsCodexCli, isClaudeDesktopExecutable, isBundledClaudeCode,
  parseWindowsProcesses, desktopOwnedRows, parseTasklistApps, windowsAppsRunning, canonicalClaudePipe, claudeInboxKeyName,
  windowsClaudeInbox, windowsPython, desktopSyncCommand, openWithShell, ownedByCurrentUser, probeWindowsApps, probeWindowsAppsSync, resetWindowsAppsCache, TASKLIST_APPS_QUERIES, CIM_ARGS, windowsProcesses,
} from '../src/desktop-apps.js';
import { desktopOpenPlan } from '../src/session-activation.js';
import { desktopSessionsSupported } from '../src/platform.js';
import { appClosedFor } from '../src/coordinator-experience.js';
import { desktopClaudeRows } from '../src/portable-native.js';
import { transportCodexBinary } from '../src/native.js';
import { Store } from '../src/store.js';
import type { Session } from '../src/session-catalog.js';

// Everything here runs against fakes: fake package folders, process lists, session records and a
// fake Claude inbox pipe this test owns. No real Claude or Codex app or session is touched.
const W = 'C:\\Users\\owner\\AppData';
const env = { LOCALAPPDATA: `${W}\\Local`, APPDATA: `${W}\\Roaming`, USERPROFILE: 'C:\\Users\\owner', SystemRoot: 'C:\\Windows' };
const lister = (tree: Record<string, string[]>) => (path: string) => tree[path] ?? [];

test('Windows desktop apps are found by their MSIX package family, and Claude by its older installer too', () => {
  const packages = lister({ [`${W}\\Local\\Packages`]: ['Microsoft.WindowsCalculator_8wekyb3d8bbwe', 'Claude_pzs8sxrjxfjjc', 'OpenAI.Codex_2p2nqsd0c76g0'] });
  assert.deepEqual(windowsClaudeDesktop(env, packages, () => false), { aumid: 'Claude_pzs8sxrjxfjjc!Claude' });
  assert.deepEqual(windowsCodexDesktop(env, packages), { aumid: 'OpenAI.Codex_2p2nqsd0c76g0!App' });
  const none = lister({});
  assert.equal(windowsCodexDesktop(env, none), undefined);
  assert.equal(windowsClaudeDesktop(env, none, () => false), undefined);
  assert.deepEqual(windowsClaudeDesktop(env, none, p => p === `${W}\\Local\\AnthropicClaude\\claude.exe`), { executable: `${W}\\Local\\AnthropicClaude\\claude.exe` });
  // A look-alike folder is not the package.
  assert.equal(windowsCodexDesktop(env, lister({ [`${W}\\Local\\Packages`]: ['OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0'] })), undefined);
});

test('the Codex CLI that Codex Desktop runs is the newest real codex.exe it installed', () => {
  const root = `${W}\\Local\\OpenAI\\Codex\\bin`;
  const list = lister({ [root]: ['old', 'new', 'empty'] });
  const exists = (p: string) => p.endsWith('old\\codex.exe') || p.endsWith('new\\codex.exe');
  assert.equal(windowsCodexCli(env, list, exists, p => p.includes('new') ? 2 : 1), `${root}\\new\\codex.exe`);
  assert.equal(windowsCodexCli(env, lister({}), exists), undefined);
});

test('Claude Desktop data and process identity per OS', () => {
  assert.equal(claudeDesktopDataDir('/Users/o', 'darwin'), '/Users/o/Library/Application Support/Claude');
  assert.equal(claudeDesktopDataDir('C:\\Users\\owner', 'win32', env, () => false), `${W}\\Roaming\\Claude`);
  assert.equal(claudeDesktopDataDir('C:\\Users\\owner', 'win32', env, p => p === `${W}\\Local\\Claude-Data\\claude-code-sessions`), `${W}\\Local\\Claude-Data`);
  assert.ok(isClaudeDesktopExecutable('C:\\Program Files\\WindowsApps\\Claude_4.4212.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe', 'win32'));
  assert.ok(isClaudeDesktopExecutable(`${W}\\Local\\AnthropicClaude\\app-1.2.3\\claude.exe`, 'win32'));
  assert.ok(!isClaudeDesktopExecutable('C:\\Users\\owner\\.local\\bin\\claude.exe', 'win32'), 'the standalone CLI is not the app');
  assert.ok(isClaudeDesktopExecutable('/Applications/Claude.app/Contents/MacOS/Claude', 'darwin'));
  const data = `${W}\\Roaming\\Claude`;
  assert.ok(isBundledClaudeCode(`${data}\\claude-code\\2.1.309\\9078b9c1d466\\claude.exe`, data, 'win32'));
  assert.ok(!isBundledClaudeCode('C:\\Users\\owner\\.local\\bin\\claude.exe', data, 'win32'));
});

test('Desktop-owned Claude processes need app ancestry, read from a CIM listing', () => {
  const rows = parseWindowsProcesses([
    '4\t0\t',
    '100\t4\tC:\\Program Files\\WindowsApps\\Claude_4.4212.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe',
    '200\t100\tC:\\Program Files\\WindowsApps\\Claude_4.4212.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe',
    `300\t200\t${W}\\Roaming\\Claude\\claude-code\\2.1.309\\9078b9c1d466\\claude.exe`,
    '400\t50\tC:\\Users\\owner\\.local\\bin\\claude.exe',
    '500\t500\tC:\\loop.exe',
  ].join('\r\n'));
  assert.equal(rows.length, 6);
  const owned = desktopOwnedRows(rows, p => isClaudeDesktopExecutable(p, 'win32'));
  assert.ok(owned.has(300)); assert.ok(!owned.has(400)); assert.ok(!owned.has(500));
});

test('app liveness reads package identity, not image names, and never claims an unjudgeable app closed', async () => {
  // The real `tasklist /apps /fo csv /nh` shape, including Indian digit grouping in the memory column.
  const out = [
    '"ChatGPT.exe (App)","22232","2,47,708 K","OpenAI.Codex_26.1027.3384.0_x64__2p2nqsd0c76g0"',
    '"ClickToDo.exe (ClickToDoApp)","13344","94,568 K","MicrosoftWindows.Client.CoreAI_1000.26100.9711.0_x64__cw5n1h2txyewy"',
  ].join('\r\n');
  assert.deepEqual(parseTasklistApps(out)[0], { image: 'ChatGPT.exe (App)', pid: 22232, package: 'OpenAI.Codex_26.1027.3384.0_x64__2p2nqsd0c76g0' });
  assert.deepEqual(windowsAppsRunning(out, { codex: true, claude: true }), { codex: true, claude: false });
  assert.deepEqual(windowsAppsRunning('', { codex: true, claude: false }), { codex: false, claude: true });
  resetWindowsAppsCache();
  let refreshes = 0;
  // Before any probe the receipt-time answer never claims a closed app, and it starts one refresh.
  assert.deepEqual(probeWindowsAppsSync(async () => { refreshes++; }), { codex: true, claude: true });
  assert.equal(refreshes, 1);
  const calls: string[][] = [];
  const live = await probeWindowsApps(async (file, args) => { assert.match(file, /tasklist\.exe$/); calls.push(args); return args.at(-1)!.includes('ChatGPT') ? out : ''; }, { codex: true, claude: true });
  assert.deepEqual(calls, TASKLIST_APPS_QUERIES); assert.deepEqual(live, { codex: true, claude: false });
  // The receipt-time answer is the newest probe, with no blocking process spawn.
  assert.deepEqual(probeWindowsAppsSync(async () => { refreshes++; }), { codex: true, claude: false });
  assert.deepEqual(probeWindowsAppsSync(async () => { refreshes++; }, Date.now() + 6 * 60_000), { codex: true, claude: true }, 'too old to trust');
  resetWindowsAppsCache();
});

test('the Windows Claude inbox is the recorded pipe plus the key Claude Code publishes for it', () => {
  // Observed on a real PC: Claude Code 2.1.318 names this key file for this pipe (lowercased, then SHA-256).
  const pipe = '\\\\.\\pipe\\LOCAL\\cc-msg-0e5d6b1a19dc3b63daec93471582e183';
  assert.equal(canonicalClaudePipe(pipe), '\\\\.\\pipe\\local\\cc-msg-0e5d6b1a19dc3b63daec93471582e183');
  assert.equal(claudeInboxKeyName(20492, pipe), '20492.5851dec1474ee21d96b4dc2b7fa352ece3f78a7aa6452f9bc86f0abed29b0edc.key');
  for (const bad of ['\\\\.\\pipe\\cc-msg-xyz', '\\\\server\\pipe\\cc-msg-0e5d6b1a19dc3b63daec93471582e183', '/tmp/cc-socks-501/1.sock', '\\\\.\\pipe\\LOCAL\\other\\cc-msg-0e5d6b1a19dc3b63daec93471582e183'])
    assert.equal(canonicalClaudePipe(bad), undefined, bad);
  const files: Record<string, string> = { [join('cfg', 'sessions', '7.json')]: JSON.stringify({ pid: 7, sessionId: 's', messagingSocketPath: pipe }) };
  const read = (p: string) => { if (!(p in files)) throw new Error('missing'); return files[p]; };
  assert.equal(windowsClaudeInbox(7, 'cfg', read, () => false), undefined, 'no published key, no inbox');
  assert.deepEqual(windowsClaudeInbox(7, 'cfg', read, p => p === join('cfg', 'sessions', claudeInboxKeyName(7, pipe)!)), { pipe, sessionId: 's' });
  assert.equal(windowsClaudeInbox(8, 'cfg', read, () => true), undefined);
  files[join('cfg', 'sessions', '9.json')] = JSON.stringify({ pid: 10, messagingSocketPath: pipe });
  assert.equal(windowsClaudeInbox(9, 'cfg', read, () => true), undefined, 'a record for another PID is refused');
});

test('desktop-sync runs under Python on Windows, never the Store alias, and stays the sh wrapper on macOS', () => {
  const pathEnv = { ...env, PATH: `C:\\Users\\owner\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Python312;C:\\Windows` };
  const exists = (p: string) => ['C:\\Users\\owner\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe', 'C:\\Python312\\python.exe'].includes(p);
  assert.deepEqual(windowsPython(pathEnv, exists), { binary: 'C:\\Python312\\python.exe', args: [] });
  assert.deepEqual(windowsPython({ ...env, PATH: 'C:\\Users\\owner\\AppData\\Local\\Microsoft\\WindowsApps' }, p => p.endsWith('WindowsApps\\python.exe') || p === 'C:\\Windows\\py.exe'), { binary: 'C:\\Windows\\py.exe', args: ['-3'] });
  assert.equal(windowsPython({ PATH: '' }, () => false), undefined);
  const win = desktopSyncCommand(['list-claude'], 'win32', { ...pathEnv, WSB_DESKTOP_SYNC_BIN: 'D:\\app\\native\\desktop_sync.py' }, exists);
  assert.deepEqual(win, { binary: 'C:\\Python312\\python.exe', args: ['-E', '-s', 'D:\\app\\native\\desktop_sync.py', 'list-claude'] });
  const bundled = desktopSyncCommand(['inbox'], 'win32', pathEnv, exists);
  assert.match(bundled.args[2], /native[\\/]desktop_sync\.py$/);
  assert.ok(existsSync(bundled.args[2]) || process.platform !== 'win32', 'the bundled script exists beside the source');
  assert.deepEqual(desktopSyncCommand(['inbox'], 'darwin', { WSB_DESKTOP_SYNC_BIN: '/app/native/desktop-sync' }), { binary: '/app/native/desktop-sync', args: ['inbox'] });
  assert.match(desktopSyncCommand(['inbox'], 'darwin', {}).binary, /native[\\/]desktop-sync$/);
  assert.throws(() => desktopSyncCommand(['inbox'], 'win32', { PATH: '' }, () => false), /need Python 3/);
});

test('opening the apps: macOS arguments are unchanged, Windows uses the URL or Start entry, elsewhere refuses plainly', () => {
  const url = 'codex://threads/wake/11111111-1111-4111-a111-111111111111';
  assert.deepEqual(desktopOpenPlan('codex', url, 'darwin', {}, true), { kind: 'mac', args: ['-g', '-b', 'com.openai.codex', url] });
  assert.deepEqual(desktopOpenPlan('codex', url, 'darwin', {}, false), { kind: 'mac', args: ['-b', 'com.openai.codex', url] });
  assert.deepEqual(desktopOpenPlan('claude', 'claude://claude.ai/epitaxy/local_x', 'darwin', {}), { kind: 'mac', args: ['-b', 'com.anthropic.claudefordesktop', 'claude://claude.ai/epitaxy/local_x'] });
  assert.deepEqual(desktopOpenPlan('claude', undefined, 'darwin', {}), { kind: 'mac', args: ['-b', 'com.anthropic.claudefordesktop'] });
  const apps = { claude: { aumid: 'Claude_pzs8sxrjxfjjc!Claude' }, codex: { aumid: 'OpenAI.Codex_2p2nqsd0c76g0!App' } };
  assert.deepEqual(desktopOpenPlan('codex', url, 'win32', apps), { kind: 'shell', target: url });
  assert.deepEqual(desktopOpenPlan('claude', undefined, 'win32', apps), { kind: 'shell', target: 'shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude' });
  assert.deepEqual(desktopOpenPlan('claude', undefined, 'win32', { claude: { executable: 'C:\\a\\claude.exe' } }), { kind: 'shell', target: 'C:\\a\\claude.exe' });
  assert.throws(() => desktopOpenPlan('claude', 'claude://code/new', 'win32', {}), /Claude Desktop is not installed on this PC/);
  assert.throws(() => desktopOpenPlan('codex', url, 'win32', {}), /listed as ChatGPT/);
  assert.throws(() => desktopOpenPlan('claude', undefined, 'linux', apps), /macOS and Windows only.*computer/);
});

test('the shell opener hides its window and only fails when explorer itself cannot start', async () => {
  const calls: any[] = [];
  const fake = ((file: string, args: string[], options: any) => {
    calls.push({ file, args, options });
    const child = new EventEmitter() as any; child.unref = () => { calls.push('unref'); };
    setImmediate(() => child.emit(file.includes('missing') ? 'error' : 'spawn', new Error('ENOENT')));
    return child;
  }) as any;
  await openWithShell('codex://threads/x', fake, { SystemRoot: 'C:\\Windows' });
  assert.equal(calls[0].file, 'C:\\Windows\\explorer.exe');
  assert.deepEqual(calls[0].args, ['codex://threads/x']);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[1], 'unref');
  await assert.rejects(openWithShell('x', fake, { SystemRoot: 'C:\\missing' }), /ENOENT/);
});

test('desktop sessions are on for macOS and Windows; Linux and a forced portable Mac keep them off', () => {
  assert.equal(desktopSessionsSupported('darwin', {}), true);
  assert.equal(desktopSessionsSupported('darwin', { FFD_PORTABLE_AGENTS: '1' }), false);
  assert.equal(desktopSessionsSupported('win32', { FFD_PORTABLE_AGENTS: '1' }), true);
  assert.equal(desktopSessionsSupported('win32', { FFD_DESKTOP_SESSIONS: '0' }), false);
  assert.equal(desktopSessionsSupported('linux', {}), false);
  assert.equal(ownedByCurrentUser({ uid: 0 }, 'win32'), true);
});

test('a closed desktop app reads as closed only for connections that wait on it off macOS', () => {
  const store = new Store(':memory:');
  try {
    const cli = store.register('cli-one', 'codex', '11111111-1111-4111-a111-111111111111', tmpdir()).binding;
    const desk = store.register('desk-one', 'codex', '22222222-2222-4222-a222-222222222222', tmpdir()).binding;
    store.set(`execution-mode:${cli.id}`, 'cli'); store.set(`execution-mode:${desk.id}`, 'desktop');
    store.set('app-running:codex', 'false');
    assert.equal(appClosedFor(store, cli, 'win32'), false, 'the CLI runs without Codex Desktop');
    assert.equal(appClosedFor(store, desk, 'win32'), true);
    assert.equal(appClosedFor(store, cli, 'darwin'), true, 'macOS keeps its established rule');
    store.set('app-running:codex', 'true');
    assert.equal(appClosedFor(store, desk, 'win32'), false);
  } finally { store.close(); }
});

test('Claude Desktop rows merge saved chats with live app-owned sessions only', () => {
  const saved: Session = { id: '33333333-3333-4333-a333-333333333333', desktopId: 'local_33333333-3333-4333-a333-333333333333', accountScope: 'acct', provider: 'claude', executionMode: 'desktop', cwd: 'C:\\p', name: 'Saved', status: 'saved', activation: 'desktop-open', available: false, live: false };
  const live = [
    { pid: 300, sessionId: '44444444-4444-4444-a444-444444444444', cwd: 'C:\\q', name: 'Live desktop' },
    { pid: 400, sessionId: '55555555-5555-4555-a555-555555555555', cwd: 'C:\\r', name: 'A CLI terminal' },
  ];
  const rows = desktopClaudeRows([saved], live, new Set([300]), new Set([300]), true);
  assert.deepEqual(rows.map(r => r.id).sort(), [saved.id, live[0].sessionId].sort(), 'the CLI terminal is not a Desktop chat');
  const running = rows.find(r => r.id === live[0].sessionId)!;
  assert.equal(running.available, true); assert.equal(running.executionMode, 'desktop');
  const reopen = rows.find(r => r.id === saved.id)!;
  assert.equal(reopen.available, true); assert.equal(reopen.activation, 'desktop-open');
  const held = desktopClaudeRows([saved], [], new Set(), new Set(), false)[0];
  assert.equal(held.available, false); assert.equal(held.activation, undefined); assert.match(held.status, /discovery failed/);
  const noInbox = desktopClaudeRows([], live, new Set([300]), new Set(), true)[0];
  assert.equal(noInbox.available, false);
});

test('desktop-sync gets a real codex.exe on Windows or none at all', () => {
  assert.equal(transportCodexBinary('darwin', '/x/codex'), '/x/codex');
  assert.equal(transportCodexBinary('win32', join(tmpdir(), 'definitely-missing', 'codex.exe')), undefined);
});

// ---- desktop_sync.py against a fake Claude inbox pipe owned by this test (Windows only) ----
const repo = fileURLToPath(new URL('..', import.meta.url));
const script = join(repo, 'native', 'desktop_sync.py');
const python = process.platform === 'win32' ? windowsPython(process.env) : undefined;
const onWindows = { skip: process.platform !== 'win32' ? 'named-pipe inbox is Windows only' : !python ? 'Python 3 is not installed' : false };

function fixture(agentsPid: number) {
  const root = mkdtempSync(join(tmpdir(), 'ffd-desktop-sync-'));
  const config = join(root, 'claude'), sessions = join(config, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const name = `cc-msg-${randomBytes(16).toString('hex')}`, pipe = `\\\\.\\pipe\\LOCAL\\${name}`, token = randomBytes(16).toString('hex');
  const sessionId = '66666666-6666-4666-a666-666666666666';
  writeFileSync(join(sessions, `${agentsPid}.json`), JSON.stringify({ pid: agentsPid, sessionId, messagingSocketPath: pipe }));
  writeFileSync(join(sessions, claudeInboxKeyName(agentsPid, pipe)!), JSON.stringify({ peerToken: token }));
  // A fixed listing, like `claude agents --json`. The .cmd never receives message text.
  const fakeClaude = join(root, 'fake-claude.cmd');
  writeFileSync(fakeClaude, `@echo off\r\necho [{"pid":${agentsPid},"sessionId":"${sessionId}","name":"Fake chat","cwd":"C:\\\\p"}]\r\n`);
  const cfg = join(root, 'desktop-sync.json');
  writeFileSync(cfg, JSON.stringify({ claudeBinary: fakeClaude, coordinationDirectory: join(root, 'coord') }));
  const message = join(root, 'message.txt');
  writeFileSync(message, 'Héllo from the test ✓\nsecond line', 'utf8');
  return { root, config, pipe, token, sessionId, cfg, message };
}
function runSync(args: string[], claudeConfig: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(python!.binary, [...python!.args, '-E', '-s', script, ...args], { windowsHide: true, env: { ...process.env, CLAUDE_CONFIG_DIR: claudeConfig, PYTHONIOENCODING: 'utf-8' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
function pipeServer(path: string) {
  const lines: string[] = [];
  const server = createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => { buffer += chunk; });
    socket.on('end', () => { lines.push(...buffer.split('\n').filter(Boolean)); socket.end(); });
  });
  return new Promise<{ lines: string[]; close: () => Promise<void> }>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve({ lines, close: () => new Promise(r => server.close(() => r())) }));
  });
}

test('send-claude authenticates to the exact session pipe, then delivers one user frame', onWindows, async () => {
  const f = fixture(process.pid);
  const server = await pipeServer(f.pipe);
  try {
    const result = await runSync(['--config', f.cfg, 'send-claude', '--session', f.sessionId, '--sender', 'FarFromDesk test', '--file', f.message], f.config);
    assert.equal(result.code, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.status, 'submitted'); assert.equal(receipt.deliveryConfirmed, false); assert.equal(receipt.targetName, 'Fake chat');
    await new Promise(r => setTimeout(r, 100));
    assert.equal(server.lines.length, 2);
    assert.deepEqual(JSON.parse(server.lines[0]), { type: 'auth', token: f.token });
    const frame = JSON.parse(server.lines[1]);
    assert.equal(frame.type, 'user'); assert.equal(frame.session_id, f.sessionId); assert.equal(frame.from_name, 'FarFromDesk test');
    assert.equal(frame.message.content, 'Héllo from the test ✓\nsecond line', 'UTF-8 text survives Windows code pages');
    assert.equal(frame.msg_id, receipt.messageId);
  } finally { await server.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('send-claude refuses a pipe served by any process other than the listed session', onWindows, async () => {
  // The listing names another PID whose record points at this test's pipe: the pipe server check must refuse.
  const other = process.pid + 1;
  const f = fixture(other);
  const server = await pipeServer(f.pipe);
  try {
    const result = await runSync(['--config', f.cfg, 'send-claude', '--session', f.sessionId, '--text', 'must not arrive'], f.config);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /different process/);
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(server.lines, [], 'nothing was written');
  } finally { await server.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('send-claude refuses when the session published no inbox key', onWindows, async () => {
  const f = fixture(process.pid);
  rmSync(join(f.config, 'sessions', claudeInboxKeyName(process.pid, f.pipe)!));
  const server = await pipeServer(f.pipe);
  try {
    const result = await runSync(['--config', f.cfg, 'send-claude', '--session', f.sessionId, '--text', 'x'], f.config);
    assert.notEqual(result.code, 0);
    assert.deepEqual(server.lines, []);
  } finally { await server.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('send-codex on Windows keeps the message in the file inbox when only a codex.cmd exists, and locks work', onWindows, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ffd-desktop-sync-codex-'));
  try {
    const coord = join(root, 'coord'); mkdirSync(coord);
    const cmd = join(root, 'codex.cmd'); writeFileSync(cmd, '@echo off\r\necho Queued message 77777777-7777-4777-a777-777777777777 for thread 88888888-8888-4888-a888-888888888888.\r\n');
    const cfg = join(root, 'desktop-sync.json');
    writeFileSync(cfg, JSON.stringify({ codexBinary: cmd, coordinationDirectory: coord, codexThreadId: '88888888-8888-4888-a888-888888888888' }));
    const id = '99999999-9999-4999-a999-999999999999';
    const first = await runSync(['--config', cfg, 'send-codex', '--target', '88888888-8888-4888-a888-888888888888', '--id', id, '--sender', 'test', '--text', 'Grüße'], join(root, 'claude'));
    assert.equal(first.code, 2, 'pending is not submitted; the caller is told so');
    const receipt = JSON.parse(first.stdout);
    assert.equal(receipt.status, 'pending'); assert.equal(receipt.transport, 'file-inbox');
    // A second call with the same ID returns the same durable receipt, never a second message.
    const again = await runSync(['--config', cfg, 'send-codex', '--target', '88888888-8888-4888-a888-888888888888', '--id', id, '--sender', 'test', '--text', 'Grüße'], join(root, 'claude'));
    assert.equal(JSON.parse(again.stdout).status, 'pending');
    const lines = readFileSync(join(coord, 'codex-inbox.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1); assert.equal(JSON.parse(lines[0]).text, 'Grüße');
    const inbox = await runSync(['--config', cfg, 'inbox'], join(root, 'claude'));
    assert.equal(inbox.code, 0, inbox.stderr);
    assert.equal(JSON.parse(inbox.stdout).messages.length, 1);
    const status = await runSync(['--config', cfg, 'delivery-status', '--id', id], join(root, 'claude'));
    assert.equal(JSON.parse(status.stdout).status, 'pending');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the Windows helper sha matches Node for the canonical pipe', onWindows, () => {
  const pipe = '\\\\.\\pipe\\LOCAL\\cc-msg-ABCDEF0123456789abcdef0123456789';
  const code = `import sys; sys.path.insert(0, ${JSON.stringify(join(repo, 'native'))}); import desktop_sync, hashlib; print(hashlib.sha256(desktop_sync.canonical_pipe(sys.argv[1]).encode()).hexdigest())`;
  const out = spawnSync(python!.binary, [...python!.args, '-c', code, pipe], { encoding: 'utf8', windowsHide: true });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(`${process.pid}.${out.stdout.trim()}.key`, claudeInboxKeyName(process.pid, pipe));
  assert.equal(createHash('sha256').update(canonicalClaudePipe(pipe)!).digest('hex'), out.stdout.trim());
  assert.equal(win32.basename(script), 'desktop_sync.py');
});

test('the CIM process listing is passed encoded, so command-line quoting cannot change it', () => {
  const script = Buffer.from(CIM_ARGS.at(-1)!, 'base64').toString('utf16le');
  assert.equal(CIM_ARGS.at(-2), '-EncodedCommand');
  assert.match(script, /Get-CimInstance Win32_Process/); assert.match(script, /\[char\]9/);
});

// Opt-in, read-only: FFD_LIVE_DESKTOP=1 checks the real PC's process list, package folders and
// app liveness. It opens nothing, starts nothing and messages no session.
const live = { skip: process.platform !== 'win32' || process.env.FFD_LIVE_DESKTOP !== '1' ? 'set FFD_LIVE_DESKTOP=1 on Windows' : false };
test('live: process listing, app packages and liveness on this PC (read-only)', live, async () => {
  const home = userInfo().homedir, realEnv = { LOCALAPPDATA: join(home, 'AppData', 'Local'), USERPROFILE: home };
  const rows = await windowsProcesses();
  assert.ok(rows.some(r => r.pid === process.pid && /node(\.exe)?$/i.test(r.path)), 'this test process is listed with its path');
  const claude = windowsClaudeDesktop(realEnv), codex = windowsCodexDesktop(realEnv);
  console.log(`# live: Claude Desktop ${claude ? JSON.stringify(claude) : 'not installed'}, Codex Desktop ${codex ? JSON.stringify(codex) : 'not installed'}`);
  const apps = await probeWindowsApps(undefined, { codex: !!codex, claude: !!claude?.aumid });
  const running = rows.map(r => r.path);
  assert.equal(apps.codex, !codex || running.some(p => /\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$/i.test(p)), 'tasklist and CIM agree on Codex');
  assert.equal(apps.claude, !claude?.aumid || running.some(p => isClaudeDesktopExecutable(p, 'win32')), 'tasklist and CIM agree on Claude');
});
