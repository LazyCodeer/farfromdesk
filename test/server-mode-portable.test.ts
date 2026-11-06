import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { ServerMode, execRun, linuxOnAcPower, readWindowsLidAction, windowsLidAction, WINDOWS_LID_GUIDANCE } from '../src/server-mode.js';
import { repairProviderHooks } from '../src/hook-install.js';

// Runs on every OS: the Windows and Linux paths are driven through injected commands,
// so nothing here touches the real power policy.
const node = (code: string) => () => spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'ignore', 'pipe'] });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ffd-server-portable-'));
  const store = new Store(':memory:');
  const power = join(dir, 'power_supply');
  return { dir, store, power, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function supply(dir: string, name: string, type: string, online?: string) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'type'), type + '\n');
  if (online !== undefined) writeFileSync(join(dir, name, 'online'), online + '\n');
}

// Shape of `powercfg /query SCHEME_CURRENT SUB_BUTTONS LIDACTION` (English labels; only the hex matters).
const powercfg = (ac: number, dc: number) => `Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)
  Subgroup GUID: 4f971e89-eebd-4455-a8de-9e59040e7347  (Power buttons and lid)
    Power Setting GUID: 5ca83367-6e45-459f-a27b-476b1d01c936  (Lid close action)
      Possible Setting Index: 000
      Possible Setting Friendly Name: Do nothing
      Possible Setting Index: 001
      Possible Setting Friendly Name: Sleep
    Current AC Power Setting Index: 0x0000000${ac}
    Current DC Power Setting Index: 0x0000000${dc}
`;

test('powercfg lid action and Linux mains state parse from real output shapes', () => {
  assert.deepEqual(windowsLidAction(powercfg(0, 1)), { ac: 0, dc: 1 });
  assert.equal(windowsLidAction('no values here'), null);
  const f = fixture();
  try {
    supply(f.power, 'BAT0', 'Battery');
    assert.equal(linuxOnAcPower(f.power), null, 'a battery with no readable mains is unknown, not AC');
    supply(f.power, 'AC', 'Mains', '1');
    assert.equal(linuxOnAcPower(f.power), true);
    supply(f.power, 'AC', 'Mains', '0');
    assert.equal(linuxOnAcPower(f.power), false);
    const desktop = join(f.dir, 'desktop'); mkdirSync(desktop);
    assert.equal(linuxOnAcPower(desktop), true, 'no battery at all is a desktop on mains');
    assert.equal(linuxOnAcPower(join(f.dir, 'missing')), null);
  } finally { f.done(); }
});

test('Linux server mode holds a logind lock while on and drops it when off', async () => {
  const f = fixture();
  supply(f.power, 'AC', 'Mains', '1');
  let spawned = 0;
  const mode = new ServerMode(f.store, { platform: 'linux', stateFile: join(f.dir, 's.json'), powerSupplyDir: f.power, inhibit: () => { spawned++; return node('process.stdin.resume()')(); } });
  try {
    assert.equal(mode.supported, true);
    await mode.setEnabled(true);
    let view = mode.view();
    assert.equal(spawned, 1);
    assert.equal(view.enabled, true);
    assert.equal(view.lidSleepDisabled, true);
    assert.equal(view.onAcPower, true);
    assert.equal(view.active, true);
    assert.equal(view.helperInstalled, false, 'no privileged helper exists off macOS');
    await mode.setEnabled(false);
    view = mode.view();
    assert.equal(view.active, false);
    assert.equal(view.lidSleepDisabled, false);
    await mode.removeHelper();
  } finally { mode.close(); f.done(); }
});

test('Linux server mode reports a polkit refusal and stays off', async () => {
  const f = fixture();
  const mode = new ServerMode(f.store, { platform: 'linux', stateFile: join(f.dir, 's.json'), powerSupplyDir: f.power, inhibit: node('process.stderr.write("Failed to inhibit: Access denied");process.exit(1)') });
  try {
    await assert.rejects(mode.setEnabled(true), /refused to hold sleep off: Failed to inhibit: Access denied/);
    assert.equal(f.store.get('server-mode'), 'false');
    assert.equal(mode.view().active, false);
    assert.match(String(mode.view().error), /Access denied/);
  } finally { mode.close(); f.done(); }
});

test('Linux server mode retakes its lock at startup when it was left on', async () => {
  const f = fixture();
  supply(f.power, 'AC', 'Mains', '1');
  f.store.set('server-mode', 'true');
  let spawned = 0;
  const mode = new ServerMode(f.store, { platform: 'linux', stateFile: join(f.dir, 's.json'), powerSupplyDir: f.power, inhibit: () => { spawned++; return node('process.stdin.resume()')(); } });
  try {
    await mode.initialize();
    assert.equal(spawned, 1);
    assert.equal(mode.view().active, true);
  } finally { mode.close(); f.done(); }
});

test('Windows server mode reads the lid action back and names the fix until it is Do nothing', async () => {
  const f = fixture();
  let lid = 1, line = 'Online';
  const calls: string[] = [];
  const mode = new ServerMode(f.store, {
    platform: 'win32', stateFile: join(f.dir, 's.json'),
    run: async (file, args) => { calls.push(file); return /powercfg/i.test(file) ? powercfg(lid, 1) : line + '\r\n'; },
  });
  try {
    await mode.setEnabled(true);
    let view = mode.view();
    assert.equal(view.enabled, true);
    assert.equal(view.lidSleepDisabled, false);
    assert.equal(view.active, false, 'a lid that still sleeps is never reported as server mode working');
    assert.equal(view.guidance, WINDOWS_LID_GUIDANCE);
    assert.ok(calls.some(c => /powercfg\.exe$/i.test(c)) && calls.some(c => /powershell\.exe$/i.test(c)));
    lid = 0; await mode.refresh();
    view = mode.view();
    assert.equal(view.active, true);
    assert.equal(view.guidance, null);
    line = 'Offline'; await mode.refresh();
    assert.equal(mode.view().onAcPower, false);
    assert.equal(mode.view().active, false);
    await mode.setEnabled(false);
    assert.equal(mode.view().guidance, null);
  } finally { mode.close(); f.done(); }
});

test('Windows server mode claims nothing when powercfg cannot be read', async () => {
  const f = fixture();
  const mode = new ServerMode(f.store, { platform: 'win32', stateFile: join(f.dir, 's.json'), run: async () => { throw new Error('not found'); } });
  try {
    await mode.setEnabled(true);
    const view = mode.view();
    assert.equal(view.lidSleepDisabled, null);
    assert.equal(view.onAcPower, null);
    assert.equal(view.active, false);
  } finally { mode.close(); f.done(); }
});

// Shape of the same query on an OEM plan that marks LIDACTION hidden: /query prints the scheme only.
const hiddenQuery = 'Power Scheme GUID: 6fecc5ae-f350-48a5-b669-b472cb895ccf  (Performance)\r\n';

test('Windows server mode reads a hidden lid action through /qh and still names the fix', async () => {
  const f = fixture();
  const flags: string[] = [];
  const mode = new ServerMode(f.store, {
    platform: 'win32', stateFile: join(f.dir, 's.json'),
    run: async (file, args) => {
      if (!/powercfg/i.test(file)) return 'Online\r\n';
      flags.push(args[0]!);
      return args[0] === '/qh' ? powercfg(1, 1) : hiddenQuery;
    },
  });
  try {
    await mode.setEnabled(true);
    const view = mode.view();
    assert.equal(view.lidSleepDisabled, false, 'a hidden Sleep is read, not reported as unknown');
    assert.equal(view.guidance, WINDOWS_LID_GUIDANCE);
    assert.deepEqual([...new Set(flags)], ['/qh'], 'one powercfg per poll when /qh answers');
  } finally { mode.close(); f.done(); }
});

test('the lid query falls back to /query when /qh is refused, and claims nothing when both fail', async () => {
  const seen: string[] = [];
  const parsed = await readWindowsLidAction(async (_file, args) => {
    seen.push(args[0]!);
    if (args[0] === '/qh') throw new Error('Invalid Parameters');
    return powercfg(0, 1);
  }, 'powercfg.exe');
  assert.deepEqual(parsed, { ac: 0, dc: 1 });
  assert.deepEqual(seen, ['/qh', '/query']);
  assert.equal(await readWindowsLidAction(async () => hiddenQuery, 'powercfg.exe'), null);
});

// The app starts the backend detached, with no console. Any console child that is not
// created hidden then opens its own terminal window: the server-mode flashing bug.
async function spawnOptions(start: () => Promise<unknown>) {
  const proto = ChildProcess.prototype as unknown as { spawn: (o: { windowsHide?: boolean; file: string }) => unknown };
  const original = proto.spawn;
  const seen: { file: string; windowsHide: boolean }[] = [];
  proto.spawn = function (this: unknown, o) { seen.push({ file: o.file, windowsHide: !!o.windowsHide }); return original.call(this, o); };
  try { await start(); } finally { proto.spawn = original; }
  return seen;
}

test('server-mode probes and the startup hook repair start their children hidden', async () => {
  const probes = await spawnOptions(() => execRun(process.execPath, ['-e', 'process.stdout.write("ok")']));
  assert.equal(probes.length, 1);
  assert.equal(probes[0]!.windowsHide, true);
  const hooks = await spawnOptions(() => repairProviderHooks({ node: process.execPath, cli: '-e', timeoutMs: 5000 }).catch(() => null));
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0]!.windowsHide, true);
});
