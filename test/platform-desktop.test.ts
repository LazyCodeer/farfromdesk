import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopControl } from '../src/desktop-control.js';
import { PortableDesktop, portableLimits, type PortableExec } from '../src/desktop-portable.js';
import { deviceRefusal } from '../src/brain-device.js';

// Runs on every OS. The Windows and Linux paths are driven through a fake executor that
// answers like the bundled scripts; the last test runs the real script for this OS.
type Call = { file: string; action: string; args: any };
function fakeExec(answer: (action: string, args: any) => unknown, calls: Call[] = []): PortableExec {
  return async (file, argv) => {
    const action = argv.at(-2)!, args = JSON.parse(Buffer.from(argv.at(-1)!, 'base64').toString());
    calls.push({ file, action, args });
    return JSON.stringify(answer(action, args));
  };
}
const WINDOWS = [
  { app: 'Notepad', process: 'notepad', title: 'notes.txt - Notepad', pid: 10, id: '100', active: true },
  { app: 'KeePass', process: 'keepass', title: 'Passwords', pid: 11, id: '101', active: false },
];
function answer(action: string, args: any) {
  if (action === 'list') return { ok: true, windows: WINDOWS };
  if (action === 'read') return args.app === 'nothing' ? { ok: false, error: 'DESKTOP_APP_NOT_RUNNING: nothing has no open window.' } : { ok: true, app: 'Notepad', window: 'notes.txt - Notepad', elements: [{ role: 'Edit', name: 'Text editor', value: 'hello' }, { role: 'Button', name: 'Save', value: '' }], truncated: false };
  if (action === 'click') return args.name === 'Nope' ? { ok: false, error: 'DESKTOP_CONTROL_NOT_FOUND: No control named "Nope" in that window.' } : { ok: true, mode: 'pattern' };
  if (action === 'type') return { ok: true, mode: args.name ? 'set' : 'keystrokes', field: args.name ?? '' };
  if (action === 'key') return { ok: true };
  if (action === 'screenshot') return { ok: true, pngBase64: 'iVBORw0KGgo=', scope: 'window', window: args.window ?? null };
  return { ok: false, error: 'UNSUPPORTED_ACTION: ?' };
}
function prefs(enabled = true) { const m = new Map([['mac-control-enabled', String(enabled)]]); return { get: (k: string) => m.get(k), set: (k: string, v: string) => { m.set(k, v); } }; }
const noDriver = { call: async () => { throw new Error('the macOS driver must not run here'); }, stop() {} } as any;
function control(platform: NodeJS.Platform, enabled = true, calls: Call[] = []) {
  const portable = new PortableDesktop(platform, fakeExec(answer, calls));
  return new DesktopControl(prefs(enabled), noDriver, async () => ({}), platform, Date.now, async () => {}, undefined, portable);
}

test('each platform runs its own bundled script with the action and a base64 JSON payload', async () => {
  const calls: Call[] = [];
  await new PortableDesktop('win32', fakeExec(answer, calls)).call('read', { app: 'Notepad', text: 'quote " and \\ survive' });
  await new PortableDesktop('linux', fakeExec(answer, calls)).call('list');
  assert.match(calls[0]!.file, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
  assert.deepEqual(calls[0]!.args, { app: 'Notepad', text: 'quote " and \\ survive' });
  assert.equal(calls[1]!.file, 'python3');
  await assert.rejects(new PortableDesktop('darwin').call('list'), /DESKTOP_PLATFORM_UNSUPPORTED/);
  await assert.rejects(new PortableDesktop('linux', async () => { throw Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' }); }).call('list'), /ATSPI_UNAVAILABLE/);
  await assert.rejects(new PortableDesktop('win32', async () => 'not json').call('list'), /DESKTOP_DRIVER_FAILED/);
});

test('Windows and Linux report support and their limits honestly, Wayland included', () => {
  for (const platform of ['win32', 'linux'] as const) {
    const view = control(platform).view();
    assert.equal(view.supported, true);
    assert.equal(view.driverVersion, null, 'the macOS driver is not what runs here');
    // Linux still has macOS-only parts; Windows has its own ports of all of them now.
    assert.equal(view.limits.some(l => /macOS only/.test(l)), platform === 'linux');
    // Windows also acts (test/desktop-windows-actions.test.ts) and reads the owner's open Chromium tabs (browser-windows.ts); Linux reads.
    if (platform === 'linux') assert.deepEqual([...view.actions], ['status', 'check_permissions', 'list_apps', 'list_windows', 'read_window', 'stop']);
    else for (const action of ['click', 'open_app', 'list_browsers', 'list_tabs', 'new_tab', 'focus_tab', 'close_tab', 'read_tab']) assert.ok(view.actions.includes(action as never), action);
  }
  assert.ok(portableLimits('win32').some(l => /Browser tabs work in Chrome, Edge, Brave and Comet/.test(l)));
  assert.ok(portableLimits('win32').some(l => /administrator/.test(l)));
  assert.ok(portableLimits('win32').some(l => /App tools use classic Outlook/.test(l)));
  assert.ok(portableLimits('linux', { XDG_SESSION_TYPE: 'wayland' }).some(l => /Wayland/.test(l)));
  assert.ok(!portableLimits('linux', { DISPLAY: ':0' }).some(l => /Wayland/.test(l)));
  assert.equal(control('freebsd').view().supported, false);
});

test('the owner brain vocabulary reads, clicks, types and presses keys off macOS', async () => {
  for (const platform of ['win32', 'linux'] as const) {
    const calls: Call[] = [];
    const c = control(platform, true, calls);
    const read = await c.assist('s', { action: 'read_window', app: 'Notepad' });
    assert.match(read.tree, /Edit "Text editor": hello/);
    assert.equal(read.complete, true);
    assert.equal((await c.assist('s', { action: 'click', app: 'Notepad', name: 'Save' })).ok, true);
    const set = await c.assist('s', { action: 'type', app: 'Notepad', name: 'Text editor', text: 'hi' });
    assert.match(set.changes, /Set the Text editor text/);
    const typed = await c.assist('s', { action: 'type', app: 'Notepad', text: 'hi' });
    assert.match(typed.changes, /keystrokes/);
    await c.assist('s', { action: 'press_key', app: 'Notepad', key: 'c', modifiers: ['cmd'] });
    assert.deepEqual(calls.at(-1)!.args, { app: 'Notepad', key: 'c', modifiers: ['cmd'] });
    const opened = await c.assist('s', { action: 'open_app', app: 'notepad' });
    assert.equal(opened.app, 'Notepad');
    // Windows looks Paint up among installed apps (the fake helper has none to offer); Linux cannot open closed apps.
    await assert.rejects(c.assist('s', { action: 'open_app', app: 'Paint' }), platform === 'linux' ? /DESKTOP_APP_NOT_RUNNING/ : /UNSUPPORTED_ACTION/);
    await assert.rejects(c.assist('s', { action: 'click', app: 'Notepad', name: 'Nope' }), err => deviceRefusal(err) === 'No control named "Nope" in that window.');
    if (platform === 'linux') await assert.rejects(c.assist('s', { action: 'pick_file', app: 'Notepad', text: '/tmp/x' }), err => /does not work on Linux yet/.test(deviceRefusal(err)));
  }
});

test('the same gates hold off macOS: the Settings switch, password apps and one action at a time', async () => {
  const calls: Call[] = [];
  await assert.rejects(control('win32', false, calls).assist('s', { action: 'read_window', app: 'Notepad' }), /MAC_CONTROL_DISABLED/);
  await assert.rejects(control('linux', true, calls).assist('s', { action: 'read_window', app: 'KeePass' }), /SENSITIVE_TARGET/);
  await assert.rejects(control('win32', true, calls).assist('s', { action: 'read_window', app: 'Credential Manager' }), /SENSITIVE_TARGET/);
  assert.equal(calls.length, 0, 'a refused request never reaches the desktop');
  // Password apps never appear as targets either.
  assert.deepEqual((await control('win32').targets(0)).map(t => t.name), ['Notepad']);
  let release!: () => void;
  const slow = new PortableDesktop('linux', async () => { await new Promise<void>(r => { release = r; }); return JSON.stringify({ ok: true, windows: [] }); });
  const busy = new DesktopControl(prefs(), noDriver, async () => ({}), 'linux', Date.now, async () => {}, undefined, slow);
  const first = busy.assist('s', { action: 'open_app', app: 'x' }).catch(() => {});
  await new Promise(r => setTimeout(r, 10));
  await assert.rejects(busy.assist('s', { action: 'read_window', app: 'x' }), /DESKTOP_BUSY/);
  release(); await first;
});

test('the brain read path lists, picks a window and reads it with a screenshot off macOS', async () => {
  const c = control('linux');
  const apps = (await c.run('brain:1', { action: 'list_apps', query: 'note' })).apps;
  assert.deepEqual(apps.map((a: any) => [a.name, a.running, a.active]), [['Notepad', true, true]]);
  const windows = (await c.run('brain:1', { action: 'list_windows', appRef: apps[0].appRef })).windows;
  assert.equal(windows[0].title, 'notes.txt - Notepad');
  const state = await c.run('brain:1', { action: 'read_window', windowRef: windows[0].windowRef, screenshot: true });
  assert.deepEqual(state.controls.map((x: any) => x.label), ['Text editor', 'Save']);
  assert.equal(state.screenshot.pngBase64, 'iVBORw0KGgo=');
  await assert.rejects(c.run('brain:1', { action: 'list_tabs', browser: 'chrome' }), /DESKTOP_PLATFORM_UNSUPPORTED: list_tabs works on macOS only/);
  assert.equal((await c.capabilityProbe(0, true)).ok, true);
  assert.equal((await c.permissionReport()).accessibility, true, 'no grant step exists, so nothing is missing');
});

test('the real script for this OS answers JSON: a result or a named refusal', { skip: !['win32', 'linux'].includes(process.platform) }, async () => {
  const portable = new PortableDesktop();
  for (const action of ['list', 'screenshot'] as const) {
    try {
      const result = await portable.call(action);
      if (action === 'list') assert.ok(Array.isArray(result.windows));
      else assert.ok(Buffer.from(result.pngBase64, 'base64').subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
    } catch (error) {
      // A CI runner may have no desktop session or no AT-SPI; the script must still say so by name.
      assert.match(String((error as Error).message), /^[A-Z_]+: \S/);
    }
  }
});
