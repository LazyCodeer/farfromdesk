import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownInstructionFile } from '../src/roles.js';
import { coordinatorBridgeTools } from '../src/masters.js';
import { screenLockGate } from '../src/session-lock.js';
import { ownerFileToSend } from '../src/open-file.js';
import { directRunFileSent, directRunFileTarget, openDirectMac } from '../src/direct-mac.js';
import { Store } from '../src/store.js';
import type { Binding } from '../src/store.js';

// Restrictions found in the owner's phone test on Windows (6 Nov 2026), each now lifted only as far as is safe.

test('a coordinator reads its own role folder and the bundled skills without asking, nothing else', () => {
  const root = mkdtempSync(join(tmpdir(), 'ffd-role-read-')), skills = join(root, 'skills'), b = { id: 'coord-1' } as Binding;
  try {
    mkdirSync(join(root, 'roles', 'coord-1'), { recursive: true }); mkdirSync(join(root, 'roles', 'other'), { recursive: true }); mkdirSync(skills);
    const own = join(root, 'roles', 'coord-1', 'abc.md'), other = join(root, 'roles', 'other', 'x.md'), skill = join(skills, 'SKILL.md'), secret = join(root, 'bridge.sqlite');
    for (const f of [own, other, skill, secret]) writeFileSync(f, 'x');
    assert.equal(ownInstructionFile(b, own, root, skills), true);
    assert.equal(ownInstructionFile(b, skill, root, skills), true);
    assert.equal(ownInstructionFile(b, other, root, skills), false, 'another session\'s role');
    assert.equal(ownInstructionFile(b, secret, root, skills), false, 'private app state');
    assert.equal(ownInstructionFile(b, join(root, 'roles', 'coord-1', '..', '..', 'bridge.sqlite'), root, skills), false);
    assert.equal(ownInstructionFile(b, 'roles/coord-1/abc.md', root, skills), false, 'relative paths');
    assert.equal(ownInstructionFile(b, join(root, 'roles', 'coord-1'), root, skills), false, 'a folder');
    if (process.platform === 'win32') assert.equal(ownInstructionFile(b, own.toUpperCase(), root, skills, 'win32'), true, 'Windows paths compare without case');
    // A link inside the role folder that leads out is judged by where it leads.
    const link = join(root, 'roles', 'coord-1', 'escape.md');
    let linked = true; try { symlinkSync(secret, link); } catch { linked = false; }
    if (linked) assert.equal(ownInstructionFile(b, link, root, skills), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the coordinator\'s own bridge tools are pre-allowed on every route', () => {
  for (const t of ['master_browser', 'master_desktop_control', 'whatsapp_reply', 'master_dispatch']) assert.ok(coordinatorBridgeTools.includes(`mcp__session_bridge__${t}`), t);
  assert.ok(coordinatorBridgeTools.every(t => t.startsWith('mcp__session_bridge__')), 'only the bridge, never native tools');
});

test('a locked Windows PC still answers app tools and reads, but refuses anything that acts on the screen', async () => {
  const notes: string[] = [];
  const gate = screenLockGate({ probe: async () => true, link: async () => undefined, notify: t => notes.push(t), platform: 'win32' });
  for (const action of ['app_tools', 'app_tool', 'list_apps', 'list_windows', 'read_window', 'list_browsers', 'list_tabs', 'read_tab']) await gate(action);
  for (const action of ['click', 'type_text', 'press_key', 'open_app', 'focus_tab', 'new_tab', 'close_tab', 'drag']) await assert.rejects(gate(action), /SESSION_LOCKED/, action);
  const mac = screenLockGate({ probe: async () => true, link: async () => undefined, notify: () => {}, platform: 'darwin' });
  await assert.rejects(mac('app_tool'), /SESSION_LOCKED/, 'macOS keeps its rule: its app tools drive the screen');
});

test('a headless run sends a file only from the owner\'s folders, only for an owner message, five at most', () => {
  const home = mkdtempSync(join(tmpdir(), 'ffd-send-home-')), state = mkdtempSync(join(tmpdir(), 'ffd-send-state-')), store = new Store(':memory:');
  try {
    mkdirSync(join(home, 'Downloads', '.hidden'), { recursive: true }); mkdirSync(join(home, 'AppData'));
    const ok = join(home, 'Downloads', 'report.zip'), hidden = join(home, 'Downloads', '.hidden', 'x.txt'), outside = join(home, 'AppData', 'secret.txt');
    for (const f of [ok, hidden, outside]) writeFileSync(f, 'data');
    assert.deepEqual(ownerFileToSend(ok, home), { path: ok, name: 'report.zip', size: 4 });
    assert.match((ownerFileToSend(hidden, home) as { error: string }).error, /never hidden/);
    assert.match((ownerFileToSend(outside, home) as { error: string }).error, /only from Downloads/);
    assert.match((ownerFileToSend(join(home, 'Downloads'), home) as { error: string }).error, /only from|folder/);
    assert.match((ownerFileToSend('report.zip', home) as { error: string }).error, /full path/);
    const run = openDirectMac(store, state, '47961', 'deepseek:tg:1:42', 'win32');
    try {
      assert.match(run.note, /"action":"list_browsers"/);
      assert.doesNotMatch(run.note, /comet/i, 'no guessed browser on Windows');
      assert.match(run.note, /"action":"send_file"/);
      assert.deepEqual(directRunFileTarget(store, 'deepseek:tg:1:42'), { requestId: 'tg:1:42', destination: store.destination() ?? null });
      for (let i = 0; i < 5; i++) directRunFileSent(store, 'deepseek:tg:1:42');
      assert.match((directRunFileTarget(store, 'deepseek:tg:1:42') as { error: string }).error, /five/);
    } finally { run.close(); }
    const notOwner = openDirectMac(store, state, '47961', 'deepseek:job-7', 'win32');
    try { assert.match((directRunFileTarget(store, 'deepseek:job-7') as { error: string }).error, /owner sent/); } finally { notOwner.close(); }
    assert.match((directRunFileTarget(store, 'deepseek:tg:1:42') as { error: string }).error, /no pass|ended/, 'closed runs send nothing');
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); }
});

test('a warm coordinator keeps one Claude process across turns, lean, and starts a fresh resume after a failure', async () => {
  const { ClaudeSDKSession } = await import('../src/claude-sdk-session.js');
  const calls: any[] = []; let closed = 0, fail = false;
  const query: any = (input: any) => {
    calls.push(input);
    const it = (async function* () {
      for await (const m of input.prompt) {
        const text = m.message.content[0].text;
        if (fail) { fail = false; yield { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'exact' }; continue; }
        yield { type: 'assistant', session_id: 'exact' };
        yield { type: 'result', subtype: 'success', is_error: false, session_id: 'exact', result: `done: ${text}` };
      }
    })();
    return Object.assign(it, { close() { closed++; } });
  };
  const s = new ClaudeSDKSession(process.execPath, '/project', 'exact', false, async () => true, {}, query, '', { warm: true, lean: true });
  try {
    assert.equal(await s.run('one'), 'done: one');
    assert.equal(await s.run('two'), 'done: two');
    assert.equal(calls.length, 1, 'one process for both turns');
    assert.equal(calls[0].options.sessionId, 'exact');
    assert.equal(calls[0].options.strictMcpConfig, true);
    assert.deepEqual(calls[0].options.disallowedTools, ['Task', 'Agent']);
    assert.deepEqual(calls[0].options.skills, []);
    assert.deepEqual(calls[0].options.settingSources, ['user', 'project', 'local'], 'owner permissions and env still load');
    fail = true;
    await assert.rejects(s.run('three'), /could not complete this turn/);
    assert.equal(closed, 1, 'a failed turn ends the warm process');
    assert.equal(await s.run('four'), 'done: four');
    assert.equal(calls.length, 2); assert.equal(calls[1].options.resume, 'exact', 'the next turn resumes the same session');
  } finally { s.close(); }
  assert.equal(closed, 2);
  const plain = new ClaudeSDKSession(process.execPath, '/project', 'exact', false, async () => true, {}, ((i: any) => { calls.push(i); return Object.assign((async function* () { yield { type: 'result', subtype: 'success', is_error: false, session_id: 'exact', result: 'ok' }; })(), { close() {} }); }) as any);
  await plain.run('x'); assert.equal(calls.at(-1).options.strictMcpConfig, undefined, 'other sessions are unchanged'); plain.close();
});

test('the Windows browser helper never brings an app-launch page (t.me) to the front', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../native/browser-windows.ps1', import.meta.url), 'utf8');
  const m = /-match '([^']+)'\) \{\s*Fail 'BROWSER_LAUNCH_PAGE'/.exec(src);
  assert.ok(m, 'the guard is in Select-Tab');
  const re = new RegExp(m![1].replace(/\(\?i\)/, ''), 'i');
  for (const t of ['Telegram: Launch @farfromhomelocaltestingbot', 'Telegram: Contact @someone', 'Launch Meeting - Zoom']) assert.ok(re.test(t), t);
  for (const t of ['Inbox (3) - Gmail', 'Telegram Web', 'GitHub - ranxianglei/billion-context']) assert.ok(!re.test(t), t);
});

test('the Windows coordinator is told the new_tab fields the schema accepts', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/master-channel.ts', import.meta.url), 'utf8');
  const fields = readFileSync(new URL('../src/desktop-control.ts', import.meta.url), 'utf8');
  assert.match(fields, /new_tab:\['windowRef','url','actionId'\]/);
  assert.match(src, /new_tab with a windowRef from list_tabs and url/);
  assert.doesNotMatch(src, /new_tab with browser/);
});

test('the Windows desktop helper lists windows on other virtual desktops', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../native/desktop-windows.ps1', import.meta.url), 'utf8');
  assert.match(src, /public static IntPtr\[\] OtherDesktopWindows\(\)/);
  assert.match(src, /cloaked == 2/, 'only windows the shell cloaks for another desktop');
  assert.match(src, /foreach \(\$h in \[FfdUser32\]::OtherDesktopWindows\(\)\)/);
});

test('Outlook items are returned as one collection, never unrolled by PowerShell', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../native/app-tools-windows.ps1', import.meta.url), 'utf8');
  assert.match(src, /return ,\(\$items\.Restrict\(\$filter\)\)/);
  assert.match(src, /return ,\$plain/);
});

test('app tool args accept numbers and booleans as text', async () => {
  const { DesktopControl } = await import('../src/desktop-control.js');
  const prefs = new Map([['mac-control-enabled', 'true']]);
  const c = new DesktopControl({ get: (k: string) => prefs.get(k), set: (k: string, v: string) => { prefs.set(k, v); } } as any, undefined, undefined, 'linux');
  await assert.rejects(c.run('s', { action: 'app_tool', tool: 'nope', args: { limit: 3, all: true } }), /APP_TOOL_UNKNOWN/, 'the args pass validation');
  await assert.rejects(c.run('s', { action: 'app_tool', tool: 'nope', args: { limit: { x: 1 } } }), /invalid/i);
});
