import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DesktopControl } from '../src/desktop-control.js';
import { PortableDesktop, portableLimits, type PortableExec } from '../src/desktop-portable.js';
import { deviceRefusal } from '../src/brain-device.js';
import { MacControl, macControlUnsupported } from '../src/mac-control.js';
import { ffdSkill } from '../src/ffd.js';
import { deviceToolText } from '../src/meta-model.js';

// Windows acting, driven through a fake desktop-windows.ps1: nothing here touches the real
// desktop. The fake keeps a tiny world (windows, one installed app that can be launched, a
// window's controls) and records every call so each test can check what would have run.
type Call = { action: string; args: any; hide: boolean };
const CONTROLS = [
  { role: 'Button', name: 'Save', value: '', rid: '42.100.1', enabled: true, rect: [10, 10, 60, 24] },
  { role: 'Edit', name: 'Prompt', value: '', rid: '42.100.2', enabled: true, rect: [10, 50, 400, 30] },
  { role: 'Edit', name: 'Password', value: '', rid: '42.100.3', enabled: true, password: true, rect: [10, 90, 400, 30] },
  { role: 'Button', name: 'New', value: '', rid: '42.100.4', enabled: true, rect: [500, 10, 40, 24] },
  { role: 'Button', name: 'Greyed', value: '', rid: '42.100.5', enabled: false, rect: [550, 10, 40, 24] },
];
function world() {
  const calls: Call[] = [];
  const windows: any[] = [
    { app: 'Notepad', process: 'Notepad', title: 'notes.txt - Notepad', pid: 10, id: '100', active: true },
    { app: 'Claude', process: 'claude', title: 'Claude', pid: 12, id: '120', active: false },
  ];
  let composer = '';
  const exec: PortableExec = async (_file, argv, options) => {
    const action = argv.at(-2)!, args = JSON.parse(Buffer.from(argv.at(-1)!, 'base64').toString());
    calls.push({ action, args, hide: options.windowsHide });
    const answer = (() => {
      if (action === 'list') return { ok: true, windows };
      if (action === 'apps') return { ok: true, apps: [
        { name: 'Paint', appId: 'Microsoft.Paint_8wekyb3d8bbwe!App', path: '', source: 'start' },
        { name: 'Paint Old Installer Entry', appId: '', path: '', source: 'uninstall' },
        { name: 'KeePass Password Safe', appId: 'keepass', path: '', source: 'start' },
      ].filter(a => a.name.toLowerCase().includes(String(args.query))) };
      if (action === 'launch') { windows.push({ app: 'Paint', process: 'mspaint', title: 'Untitled - Paint', pid: 30, id: '300', active: false }); return { ok: true, started: true }; }
      if (action === 'front') return { ok: true, fronted: true };
      if (action === 'read') return { ok: true, app: 'Claude', window: 'Claude', pid: 12, id: '120', bounds: [100, 100, 800, 600], truncated: false,
        elements: (args.ids ? CONTROLS : CONTROLS.map(({ role, name, value }) => ({ role, name, value }))).map(e => e.name === 'Prompt' ? { ...e, value: composer } : e) };
      if (action === 'screenshot') return { ok: true, pngBase64: 'iVBORw0KGgo=', scope: 'window', width: 800, height: 600 };
      if (action === 'act') {
        if (args.op === 'type') composer = args.text;
        return { ok: true, mode: args.op === 'click' || args.op === 'scroll' ? 'pattern' : args.op === 'type' ? 'set' : 'pointer' };
      }
      if (action === 'pointer') return { ok: true, fronted: true, mode: 'pointer' };
      if (action === 'pick') return { ok: true, closed: !String(args.path).includes('missing'), mode: 'button' };
      if (action === 'click' || action === 'type' || action === 'key') return { ok: true, mode: 'pattern' };
      return { ok: false, error: 'UNSUPPORTED_ACTION: ?' };
    })();
    return JSON.stringify(answer);
  };
  const prefs = new Map([['mac-control-enabled', 'true']]);
  const noDriver = { call: async () => { throw new Error('the macOS driver must not run here'); }, stop() {} } as any;
  const control = new DesktopControl({ get: k => prefs.get(k), set: (k, v) => { prefs.set(k, v); } }, noDriver, async () => ({}), 'win32', Date.now, async () => {}, undefined, new PortableDesktop('win32', exec));
  return { control, calls, windows, prefs };
}
const acts = (calls: Call[]) => calls.filter(c => !['list', 'read', 'apps', 'screenshot'].includes(c.action));

test('Windows advertises the actions it now answers, and its limits say what is still impossible', () => {
  const { control } = world();
  assert.deepEqual([...control.view().actions], ['status', 'check_permissions', 'list_apps', 'list_windows', 'read_window', 'open_app', 'click', 'double_click', 'right_click', 'drag', 'scroll', 'type_text', 'press_key', 'chat_controls', 'chat_action', 'stop']);
  const limits = portableLimits('win32').join(' ');
  assert.match(limits, /administrator/);
  assert.match(limits, /locked/);
  assert.match(limits, /front/);
  assert.doesNotMatch(limits, /pixel clicks are macOS only/);
  assert.doesNotMatch(limits, /[\u2013\u2014]/, 'no dashes in owner-facing text');
});

test('check_permissions on Windows names no macOS setting', async () => {
  const report = await world().control.run('s', { action: 'check_permissions' });
  assert.equal(report.driverVersion, null);
  assert.doesNotMatch(`${report.note} ${report.next}`, /System Settings|macOS|Accessibility/);
  assert.match(report.note, /administrator/);
});

test('the brain opens a closed app from the Start menu and brings its new window forward', async () => {
  const { control, calls } = world();
  const opened = await control.assist('s', { action: 'open_app', app: 'paint' });
  assert.deepEqual(opened, { action: 'open_app', app: 'Paint', running: true, windowReady: true, fronted: true, stoleFocus: true });
  assert.deepEqual(acts(calls).map(c => [c.action, c.args]), [['launch', { appId: 'Microsoft.Paint_8wekyb3d8bbwe!App' }], ['front', { hwnd: '300' }]]);
  assert.ok(calls.every(c => c.hide), 'every helper runs with windowsHide');
  // Already open: brought forward, never launched a second time.
  const again = await control.assist('s', { action: 'open_app', app: 'notepad' });
  assert.equal(again.fronted, true);
  assert.equal(calls.filter(c => c.action === 'launch').length, 1);
  // Not installed: a plain sentence naming the PC.
  await assert.rejects(control.assist('s', { action: 'open_app', app: 'Photoshop' }), err => deviceRefusal(err) === 'Photoshop is not installed on this PC, or Windows has no way to start it.');
  // Password managers are never opened, even when installed.
  await assert.rejects(control.assist('s', { action: 'open_app', app: 'KeePass' }), /SENSITIVE_TARGET/);
});

test('pick_file fills the Windows file dialog and reports whether it closed', async () => {
  const { control, calls } = world();
  const picked = await control.assist('s', { action: 'pick_file', app: 'Chrome', text: 'C:\\Users\\me\\Downloads\\post.png' });
  assert.equal(picked.ok, true);
  assert.deepEqual(calls.at(-1)!.args, { app: 'Chrome', path: 'C:\\Users\\me\\Downloads\\post.png' });
  const stuck = await control.assist('s', { action: 'pick_file', app: 'Chrome', text: 'C:\\missing.png' });
  assert.equal(stuck.ok, false);
  assert.match(stuck.observation, /still open/);
});

test('find_app (list_apps with a query) reports installed apps that are not running, and open_app starts one', async () => {
  const { control, calls } = world();
  const found = (await control.run('brain:1', { action: 'list_apps', query: 'paint' })).apps;
  assert.deepEqual(found.map((a: any) => [a.name, a.running, a.launchable ?? true]), [['Paint', false, true], ['Paint Old Installer Entry', false, false]]);
  // A running match answers from the window list alone: no installed-app scan.
  const before = calls.filter(c => c.action === 'apps').length;
  assert.deepEqual((await control.run('brain:1', { action: 'list_apps', query: 'note' })).apps.map((a: any) => a.running), [true]);
  assert.equal(calls.filter(c => c.action === 'apps').length, before);
  await assert.rejects(control.run('brain:1', { action: 'open_app', appRef: found[0].appRef }), /DESKTOP_ACTION_ID_REQUIRED/);
  const actionId = randomUUID();
  const opened = await control.run('brain:1', { action: 'open_app', appRef: found[0].appRef, actionId });
  assert.equal(opened.windowReady, true);
  await assert.rejects(control.run('brain:1', { action: 'open_app', appRef: found[0].appRef, actionId }), /ALREADY_ATTEMPTED/);
  await assert.rejects(control.run('brain:1', { action: 'open_app', appRef: found[1].appRef, actionId: randomUUID() }), /no way to start it/);
});

async function claudeWindow(control: DesktopControl, screenshot = false) {
  const app = (await control.run('c:1', { action: 'list_apps', query: 'claude' })).apps[0];
  const win = (await control.run('c:1', { action: 'list_windows', appRef: app.appRef })).windows[0];
  const state = await control.run('c:1', { action: 'read_window', windowRef: win.windowRef, ...(screenshot ? { screenshot: true } : {}) });
  return { win, state };
}

test('a coordinator acts on a control from the latest read, by its UI Automation runtime id', async () => {
  const { control, calls } = world();
  const { win, state } = await claudeWindow(control, true);
  assert.deepEqual(state.controls.map((c: any) => c.label), ['Save', 'Prompt', 'New', 'Greyed'], 'password fields are left out');
  assert.deepEqual(state.controls[0].frame, { x: 10, y: 10, width: 60, height: 24 });
  assert.equal(state.screenshot.width, 800);
  assert.deepEqual(state.windowBounds, { x: 100, y: 100, width: 800, height: 600 });
  assert.deepEqual(calls.find(c => c.action === 'read')!.args, { hwnd: '120', ids: true, max: 1000 });
  const save = state.controls[0];
  const clicked = await control.run('c:1', { action: 'click', windowRef: win.windowRef, snapshotId: state.snapshotId, controlId: save.controlId, actionId: randomUUID() });
  assert.deepEqual(calls.at(-1), { action: 'act', args: { hwnd: '120', rid: '42.100.1', op: 'click' }, hide: true });
  assert.equal(clicked.deliveryMode, 'background', 'an Invoke pattern needs no focus');
  // The snapshot is consumed: a second action on it is stale, never a replay.
  await assert.rejects(control.run('c:1', { action: 'click', windowRef: win.windowRef, snapshotId: state.snapshotId, controlId: save.controlId, actionId: randomUUID() }), /DESKTOP_CONTROL_STALE/);
  const fresh = (await control.run('c:1', { action: 'read_window', windowRef: win.windowRef }));
  const greyed = fresh.controls.find((c: any) => c.label === 'Greyed');
  await assert.rejects(control.run('c:1', { action: 'click', windowRef: win.windowRef, snapshotId: fresh.snapshotId, controlId: greyed.controlId, actionId: randomUUID() }), /DESKTOP_CONTROL_DISABLED/);
  for (const [action, extra, op] of [['double_click', {}, 'double'], ['right_click', {}, 'right'], ['scroll', { direction: 'down', amount: 2 }, 'scroll'], ['type_text', { text: 'hi' }, 'type'], ['press_key', { key: 'return' }, 'key']] as const) {
    const s = await control.run('c:1', { action: 'read_window', windowRef: win.windowRef });
    const target = s.controls.find((c: any) => c.label === 'Prompt');
    const r = await control.run('c:1', { action, windowRef: win.windowRef, snapshotId: s.snapshotId, controlId: target.controlId, actionId: randomUUID(), ...extra });
    const sent = calls.at(-1)!;
    assert.equal(sent.action, 'act');
    assert.equal(sent.args.op, op);
    assert.equal(sent.args.rid, '42.100.2');
    if (r.dispatch.mode === 'pointer') { assert.equal(r.deliveryMode, 'foreground'); assert.match(r.note, /front/); }
  }
  assert.equal(calls.filter(c => c.action === 'act' && c.args.op === 'key')[0]!.args.key, 'return');
});

test('window-local pixels reach the pointer helper as given, and Windows says the input was in front', async () => {
  const { control, calls } = world();
  const { win } = await claudeWindow(control, true);
  const r = await control.run('c:1', { action: 'click', windowRef: win.windowRef, x: 40, y: 22, actionId: randomUUID() });
  assert.deepEqual(calls.at(-1), { action: 'pointer', args: { hwnd: '120', kind: 'click', x: 40, y: 22 }, hide: true });
  assert.equal(r.deliveryMode, 'foreground', 'never claims the background delivery Windows cannot do');
  await control.run('c:1', { action: 'drag', windowRef: win.windowRef, x: 1, y: 2, toX: 30, toY: 40, button: 'left', actionId: randomUUID() });
  assert.deepEqual(calls.at(-1)!.args, { hwnd: '120', kind: 'drag', x: 1, y: 2, toX: 30, toY: 40, button: 'left' });
  await control.run('c:1', { action: 'scroll', windowRef: win.windowRef, x: 5, y: 5, direction: 'up', amount: 4, actionId: randomUUID() });
  assert.deepEqual(calls.at(-1)!.args, { hwnd: '120', kind: 'scroll', x: 5, y: 5, direction: 'up', amount: 4 });
  const sent = calls.length;
  await assert.rejects(control.run('c:1', { action: 'drag', windowRef: win.windowRef, x: 1, y: 2, actionId: randomUUID() }), /DESTINATION_REQUIRED/);
  await assert.rejects(control.run('c:1', { action: 'scroll', windowRef: win.windowRef, x: 1, y: 2, actionId: randomUUID() }), /DIRECTION_REQUIRED/);
  await assert.rejects(control.run('c:1', { action: 'click', windowRef: win.windowRef, x: 1, actionId: randomUUID() }), /POINT_INCOMPLETE/);
  assert.equal(calls.length, sent, 'a refused point reaches nothing');
});

test('the Settings switch, one action at a time and Stop still gate every Windows action', async () => {
  const { control, calls, prefs } = world();
  const { win, state } = await claudeWindow(control);
  prefs.set('mac-control-enabled', 'false');
  await assert.rejects(control.run('c:1', { action: 'click', windowRef: win.windowRef, snapshotId: state.snapshotId, controlId: state.controls[0].controlId, actionId: randomUUID() }), /MAC_CONTROL_DISABLED/);
  assert.equal(calls.filter(c => c.action === 'act').length, 0);
  prefs.set('mac-control-enabled', 'true');
  control.stop();
  await assert.rejects(control.run('c:1', { action: 'read_window', windowRef: win.windowRef }), /DESKTOP_TARGET_STALE/);
});

test('chat_controls and chat_action use the Claude recipe on Windows, with the draft checked before send', async () => {
  const { control, calls } = world();
  const { win } = await claudeWindow(control);
  const controls = await control.run('c:1', { action: 'chat_controls', windowRef: win.windowRef });
  assert.deepEqual(controls.recipe, { composer: 'Prompt', new: 'New' });
  await control.run('c:1', { action: 'chat_action', windowRef: win.windowRef, chatAction: 'new', actionId: randomUUID() });
  assert.deepEqual(calls.at(-1)!.args, { hwnd: '120', rid: '42.100.4', op: 'click' });
  await control.run('c:1', { action: 'chat_action', windowRef: win.windowRef, chatAction: 'draft', text: 'hello', actionId: randomUUID() });
  assert.deepEqual(calls.at(-1)!.args, { hwnd: '120', rid: '42.100.2', op: 'type', text: 'hello' });
  await assert.rejects(control.run('c:1', { action: 'chat_action', windowRef: win.windowRef, chatAction: 'send', expectedDraft: 'something else', actionId: randomUUID() }), /DESKTOP_DRAFT_MISMATCH/);
  await control.run('c:1', { action: 'chat_action', windowRef: win.windowRef, chatAction: 'send', expectedDraft: 'hello', actionId: randomUUID() });
  assert.deepEqual(calls.at(-1)!.args, { hwnd: '120', rid: '42.100.2', op: 'key', key: 'return' });
  const notepad = (await control.run('c:1', { action: 'list_apps', query: 'notepad' })).apps[0];
  const nwin = (await control.run('c:1', { action: 'list_windows', appRef: notepad.appRef })).windows[0];
  await assert.rejects(control.run('c:1', { action: 'chat_action', windowRef: nwin.windowRef, chatAction: 'new', actionId: randomUUID() }), /DESKTOP_CHAT_RECIPE_REQUIRED/);
});

test('Linux keeps its smaller vocabulary and says so', async () => {
  const exec: PortableExec = async () => JSON.stringify({ ok: true, windows: [] });
  const linux = new DesktopControl({ get: () => 'true', set: () => {} }, { call: async () => { throw new Error('no'); }, stop() {} } as any, async () => ({}), 'linux', Date.now, async () => {}, undefined, new PortableDesktop('linux', exec));
  assert.deepEqual([...linux.view().actions], ['status', 'check_permissions', 'list_apps', 'list_windows', 'read_window', 'stop']);
  await assert.rejects(linux.assist('s', { action: 'pick_file', app: 'Firefox', text: '/tmp/x' }), err => /does not work on Linux yet/.test(deviceRefusal(err)));
  await assert.rejects(linux.run('s', { action: 'click', windowRef: randomUUID(), x: 1, y: 1, actionId: randomUUID() }), /DESKTOP_PLATFORM_UNSUPPORTED/);
});

test('master_mac_control is not advertised off macOS and points at the desktop route; macOS text is unchanged', async () => {
  assert.match(macControlUnsupported('win32'), /master_desktop_control/);
  assert.match(macControlUnsupported('win32'), /this PC/);
  const service = new MacControl({ get: () => 'true', set: () => {} }, async () => { throw new Error('must not call'); }, 'win32');
  await assert.rejects(service.run('a', { action: 'discover' }), /macOS only.*master_desktop_control/);
  const win = ffdSkill('ffd', 'win32'), mac = ffdSkill('ffd', 'darwin');
  assert.doesNotMatch(win, /FFD mac REQ/);
  assert.match(win, /There is no Mac control on this PC/);
  assert.match(mac, /- Mac control \(proxies only\): FFD mac REQ with JSON on stdin/);
  assert.match(mac, /Mac interactions consume their snapshot/);
  const channel = readFileSync(new URL('../src/master-channel.ts', import.meta.url), 'utf8');
  assert.match(channel, /\.filter\(d=>mac\|\|d\.name!=='master_mac_control'\)/);
});

test('the brain tool descriptions name the PC on Windows and keep the macOS wording', () => {
  assert.match(deviceToolText.findApp('win32'), /installed on this PC/);
  assert.match(deviceToolText.openApp('win32'), /on the PC/);
  assert.match(deviceToolText.act('win32'), /Windows file dialog/);
  assert.equal(deviceToolText.findApp('darwin'), 'Whether an app is installed on this Mac, and whether it is running. Check before opening an app the owner names.');
  assert.match(deviceToolText.act('darwin'), /^Click, type or press a key in an app window, one step at a time\. pick_file: app and text/);
  for (const p of ['win32', 'linux'] as const) for (const t of [deviceToolText.findApp(p), deviceToolText.openApp(p), deviceToolText.act(p)]) assert.doesNotMatch(t, /\bMac\b|[\u2013\u2014]/);
});

test('desktop-windows.ps1 stays pure ASCII for Windows PowerShell 5.1', () => {
  const bytes = readFileSync(new URL('../native/desktop-windows.ps1', import.meta.url));
  assert.ok(bytes.every(b => b < 128));
});

test('the real Windows script lists installed apps and reads windows with runtime ids (read-only)', { skip: process.platform !== 'win32' }, async () => {
  const portable = new PortableDesktop();
  const apps = (await portable.call('apps', { query: 'notepad' })).apps;
  assert.ok(Array.isArray(apps));
  for (const a of apps) assert.equal(typeof a.name, 'string');
  const windows = await portable.windows();
  if (windows.length) {
    try {
      const state = await portable.call('read', { hwnd: windows[0]!.id, ids: true, max: 5 });
      for (const e of state.elements) assert.match(String(e.rid), /^-?\d+(\.-?\d+)*$/);
    } catch (error) {
      assert.match(String((error as Error).message), /^[A-Z_]+: \S/);
    }
  }
});

// Opt-in: a small form this test opens in a child PowerShell. The helper reads it with runtime ids,
// presses its button and fills its box through UI Automation patterns only: noInput makes the
// helper refuse rather than fall back to the real pointer or keyboard.
test('live: act presses a button and fills a box by runtime id, without real input', { skip: process.platform !== 'win32' || process.env.FFD_LIVE_DESKTOP !== '1' }, async () => {
  const title = 'FFD act test ' + randomUUID().slice(0, 8);
  const script = `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.Text = '${title}'; $f.Width = 320; $f.Height = 160; `
    + `$t = New-Object System.Windows.Forms.TextBox; $t.AccessibleName = 'Field'; $t.Top = 10; $t.Left = 10; $t.Width = 200; $f.Controls.Add($t); `
    + `$b = New-Object System.Windows.Forms.Button; $b.Text = 'Press'; $b.Top = 50; $b.Left = 10; $b.Add_Click({ [Console]::Out.WriteLine('PRESSED ' + $t.Text) }); $f.Controls.Add($b); `
    // windowsHide starts the child with SW_HIDE, which the form's first show obeys; showing it again makes it visible.
    + `$f.Add_Shown({ $f.Visible = $false; $f.Visible = $true; [Console]::Out.WriteLine('SHOWN') }); [void]$f.ShowDialog()`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], { windowsHide: true });
  let out = ''; child.stdout.on('data', d => { out += d; });
  try {
    for (let i = 0; i < 60 && !out.includes('SHOWN'); i++) await new Promise(r => setTimeout(r, 200));
    const portable = new PortableDesktop();
    const win = (await portable.windows()).find(w => w.title === title);
    assert.ok(win, 'the test form is listed');
    const read = async () => (await portable.call('read', { hwnd: win!.id, ids: true })).elements as any[];
    const field = (await read()).find(e => e.name === 'Field');
    assert.ok(field?.rid, 'the box has a runtime id');
    const typed = await portable.call('act', { hwnd: win!.id, rid: field.rid, op: 'type', text: 'hello', noInput: true });
    assert.equal(typed.mode, 'set');
    assert.equal((await read()).find(e => e.name === 'Field')?.value, 'hello');
    const button = (await read()).find(e => e.name === 'Press');
    const pressed = await portable.call('act', { hwnd: win!.id, rid: button.rid, op: 'click', noInput: true });
    assert.equal(pressed.mode, 'pattern');
    for (let i = 0; i < 20 && !out.includes('PRESSED'); i++) await new Promise(r => setTimeout(r, 100));
    assert.match(out, /PRESSED hello/);
    // A stale id is refused, never guessed.
    await assert.rejects(portable.call('act', { hwnd: win!.id, rid: '1.2.3', op: 'click', noInput: true }), /DESKTOP_CONTROL_STALE/);
  } finally { child.kill(); }
});

// Opt-in: opens its own Open dialog in a child PowerShell, chooses a file it created through UI
// Automation patterns only (no keys, no pointer), and checks the dialog returned that file.
test('live: pick fills a Windows file dialog this test opened', { skip: process.platform !== 'win32' || process.env.FFD_LIVE_DESKTOP !== '1' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ffd-pick-'));
  const file = join(dir, 'chosen.txt'); writeFileSync(file, 'x');
  const title = 'FFD pick test ' + randomUUID().slice(0, 8);
  const script = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = '${title}'; $d.InitialDirectory = '${dir}'; if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.FileName) } else { [Console]::Out.Write('CANCEL') }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], { windowsHide: true });
  let out = ''; child.stdout.on('data', d => { out += d; });
  const done = new Promise<void>(r => child.on('exit', () => r()));
  try {
    const portable = new PortableDesktop();
    let result: any;
    for (let i = 0; i < 40 && !result; i++) {
      await new Promise(r => setTimeout(r, 250));
      try { result = await portable.call('pick', { app: title, path: file }); } catch (e) { if (!/DESKTOP_(APP_NOT_RUNNING|CONTROL_NOT_FOUND)/.test(String(e))) throw e; }
    }
    assert.equal(result?.closed, true);
    await done;
    assert.equal(out.trim().toLowerCase(), file.toLowerCase());
  } finally { child.kill(); rmSync(dir, { recursive: true, force: true }); }
});
