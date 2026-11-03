import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { ServerMode } from '../src/server-mode.js';

const HELPER = readFileSync(new URL('../native/server-mode/helper.sh', import.meta.url), 'utf8');

// A stand-in for pmset that records what the helper asked for. Real sleep policy
// is never touched by these tests.
const FAKE_PMSET = `#!/bin/sh
printf '%s\\n' "$*" >> "$FFD_TEST_LOG"
if [ "$1" = "-g" ]; then
  if [ "$2" = "batt" ]; then printf "Now drawing from '%s'\\n -InternalBattery-0 50%%; charging; present: true\\n" "\${FAKE_POWER:-AC Power}"; exit 0; fi
  printf 'System-wide power settings:\\n SleepDisabled\\t\\t%s\\n' "\${FAKE_SLEEPDISABLED:-0}"; exit 0
fi
exit 0
`;

type HelperCase = { enabled?: boolean; power?: 'AC Power' | 'Battery Power'; ageSeconds?: number; graceSeconds?: number; uid?: string; sleepDisabled?: string; raw?: string };

function helperRun(input: HelperCase) {
  const dir = mkdtempSync(join(tmpdir(), 'ffd-helper-'));
  const pmset = join(dir, 'pmset');
  const state = join(dir, 'server-mode.json');
  const log = join(dir, 'calls.log');
  writeFileSync(pmset, FAKE_PMSET, { mode: 0o755 });
  writeFileSync(log, '');
  if (input.raw !== undefined) writeFileSync(state, input.raw);
  else writeFileSync(state, JSON.stringify({ version: 1, enabled: input.enabled !== false, heartbeat: Date.now(), pid: 1 }));
  if (input.ageSeconds) {
    const when = new Date(Date.now() - input.ageSeconds * 1000);
    utimesSync(state, when, when);
  }
  const result = spawnSync('/bin/sh', [new URL('../native/server-mode/helper.sh', import.meta.url).pathname, '--once'], {
    encoding: 'utf8',
    env: { ...process.env, FFD_STATE_FILE: state, FFD_STATE_UID: input.uid ?? String(process.getuid?.() ?? 0), FFD_PMSET: pmset, FFD_TEST_LOG: log, FAKE_POWER: input.power ?? 'AC Power', FAKE_SLEEPDISABLED: input.sleepDisabled ?? '0', ...(input.graceSeconds === undefined ? {} : { FFD_GRACE_MAX_AGE: String(input.graceSeconds) }) },
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const out = (result.stdout ?? '').trim();
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, out, calls };
}

test('server mode keeps sleep disabled only with a fresh heartbeat on AC power', () => {
  const run = helperRun({ enabled: true, power: 'AC Power' });
  assert.match(run.out, /reason=ok/);
  assert.ok(run.calls.includes('-a disablesleep 1'), `expected a disable-sleep call, saw ${JSON.stringify(run.calls)}`);
});

test('server mode never disables sleep on battery, and restores normal sleep', () => {
  const run = helperRun({ enabled: true, power: 'Battery Power', sleepDisabled: '1' });
  assert.match(run.out, /reason=on-battery/);
  assert.ok(!run.calls.includes('-a disablesleep 1'));
  assert.ok(run.calls.includes('-a disablesleep 0'), 'an already disabled sleep must be restored');
});

test('a heartbeat that stopped inside the grace window holds sleep off', () => {
  const run = helperRun({ enabled: true, ageSeconds: 900, sleepDisabled: '0' });
  assert.match(run.out, /reason=grace/);
  assert.ok(run.calls.includes('-a disablesleep 1'), 'the app being away must not end the hold inside the window');
  assert.ok(!run.calls.includes('-a disablesleep 0'));
});

test('a heartbeat older than the grace window restores normal sleep', () => {
  const run = helperRun({ enabled: true, ageSeconds: 3 * 60 * 60, sleepDisabled: '1' });
  assert.match(run.out, /reason=stale-heartbeat/);
  assert.ok(run.calls.includes('-a disablesleep 0'));
  assert.ok(!run.calls.includes('-a disablesleep 1'));
});

test('the grace window is the configured length, not a fixed hour', () => {
  const inside = helperRun({ enabled: true, ageSeconds: 300, graceSeconds: 600, sleepDisabled: '0' });
  assert.match(inside.out, /reason=grace/);
  assert.ok(inside.calls.includes('-a disablesleep 1'));

  const past = helperRun({ enabled: true, ageSeconds: 900, graceSeconds: 600, sleepDisabled: '1' });
  assert.match(past.out, /reason=stale-heartbeat/);
  assert.ok(past.calls.includes('-a disablesleep 0'));
});

test('the grace window never applies on battery', () => {
  const run = helperRun({ enabled: true, ageSeconds: 900, power: 'Battery Power', sleepDisabled: '1' });
  assert.match(run.out, /reason=on-battery/);
  assert.ok(run.calls.includes('-a disablesleep 0'));
});

test('turning the setting off restores normal sleep without an admin prompt', () => {
  const run = helperRun({ enabled: false, sleepDisabled: '1' });
  assert.match(run.out, /reason=disabled/);
  assert.ok(run.calls.includes('-a disablesleep 0'));
  assert.ok(!run.calls.includes('-a disablesleep 1'));
});

test('a malformed or foreign state file can never keep the Mac awake', () => {
  const malformed = helperRun({ raw: 'not json', sleepDisabled: '1' });
  assert.match(malformed.out, /reason=bad-state/);
  assert.ok(!malformed.calls.includes('-a disablesleep 1'));

  const foreign = helperRun({ enabled: true, uid: String((process.getuid?.() ?? 0) + 1) });
  assert.match(foreign.out, /reason=wrong-owner/);
  assert.ok(!foreign.calls.includes('-a disablesleep 1'));
});

test('server mode with no state file leaves normal sleep in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ffd-helper-missing-'));
  const pmset = join(dir, 'pmset'), log = join(dir, 'calls.log');
  writeFileSync(pmset, FAKE_PMSET, { mode: 0o755 });
  writeFileSync(log, '');
  const result = spawnSync('/bin/sh', [new URL('../native/server-mode/helper.sh', import.meta.url).pathname, '--once'], {
    encoding: 'utf8',
    env: { ...process.env, FFD_STATE_FILE: join(dir, 'absent.json'), FFD_STATE_UID: String(process.getuid?.() ?? 0), FFD_PMSET: pmset, FFD_TEST_LOG: log },
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  rmSync(dir, { recursive: true, force: true });
  assert.match(result.stdout, /reason=no-state/);
  assert.ok(!calls.includes('-a disablesleep 1'));
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ffd-server-mode-'));
  const approved: string[] = [];
  const calls: string[] = [];
  let powerOff = false;
  const store = new Store(':memory:');
  const mode = new ServerMode(store, {
    platform: 'darwin',
    stateFile: join(dir, 'server-mode.json'),
    helperPath: join(dir, 'helper.sh'),
    plistPath: join(dir, 'daemon.plist'),
    approve: async script => {
      approved.push(script);
      // A real install writes the bundled source, so the version check can then say it is current.
      writeFileSync(join(dir, 'helper.sh'), HELPER);
    },
    run: async (_file, args) => {
      calls.push(args.join(' '));
      if (args[1] === 'batt') return powerOff ? "Now drawing from 'Battery Power'\n" : "Now drawing from 'AC Power'\n";
      return 'System-wide power settings:\n SleepDisabled\t\t1\n';
    },
    now: () => Date.now(),
    heartbeatMs: 15,
    heartbeatMaxAgeSeconds: 300,
  });
  return { dir, store, mode, approved, calls, setPowerOff: (v: boolean) => { powerOff = v; } };
}

test('enabling server mode installs the helper once and records the owner heartbeat', async () => {
  const f = fixture();
  try {
    await f.mode.setEnabled(true);
    assert.equal(f.approved.length, 1);
    const script = f.approved[0];
    assert.match(script, /com\.codecylabs\.farfromdesk\.servermode/);
    assert.match(script, /launchctl bootstrap system/);
    assert.match(script, new RegExp(String(process.getuid?.() ?? 0)));
    assert.match(script, /FarFromDesk server mode helper/);
    assert.match(script, /FFD_GRACE_MAX_AGE/);
    const state = JSON.parse(readFileSync(join(f.dir, 'server-mode.json'), 'utf8'));
    assert.equal(state.enabled, true);
    const view = f.mode.view();
    assert.equal(view.enabled, true);
    assert.equal(view.helperInstalled, true);
    assert.equal(view.active, true);
    assert.equal(view.lidSleepDisabled, true);
    assert.ok(view.heartbeatAgeMs !== null && view.heartbeatAgeMs < 5_000, 'a running app heartbeats now');
    assert.ok(view.graceRemainingMs !== null && view.graceRemainingMs > 0, 'the grace window is measurable while it holds');
    // The app itself must never need root: only the helper changes sleep policy.
    assert.ok(!f.calls.some(call => call.startsWith('-a disablesleep')));
  } finally { f.mode.close(); f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('the heartbeat keeps the state file fresh while server mode is on', async () => {
  const f = fixture();
  try {
    await f.mode.setEnabled(true);
    const before = JSON.parse(readFileSync(join(f.dir, 'server-mode.json'), 'utf8')).heartbeat;
    await new Promise(resolve => setTimeout(resolve, 60));
    const after = JSON.parse(readFileSync(join(f.dir, 'server-mode.json'), 'utf8')).heartbeat;
    assert.ok(after > before, 'heartbeat must advance');
  } finally { f.mode.close(); f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('turning server mode off writes a disabled state and needs no approval', async () => {
  const f = fixture();
  try {
    await f.mode.setEnabled(true);
    await f.mode.setEnabled(false);
    assert.equal(f.approved.length, 1);
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'server-mode.json'), 'utf8')).enabled, false);
    assert.equal(f.mode.view().enabled, false);
    assert.equal(f.mode.view().active, false);
  } finally { f.mode.close(); f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('a cancelled or failed approval leaves server mode off', async () => {
  const f = fixture();
  try {
    f.mode = new ServerMode(f.store, {
      platform: 'darwin',
      stateFile: join(f.dir, 'server-mode.json'),
      helperPath: join(f.dir, 'helper.sh'),
      plistPath: join(f.dir, 'daemon.plist'),
      approve: async () => { throw new Error('Administrator approval was cancelled. Nothing was changed.'); },
      run: async (_file, args) => (args[1] === 'batt' ? "Now drawing from 'AC Power'\n" : ' SleepDisabled\t\t0\n'),
    });
    await assert.rejects(f.mode.setEnabled(true), /cancelled/);
    assert.equal(f.store.get('server-mode'), 'false');
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'server-mode.json'), 'utf8')).enabled, false);
    assert.match(String(f.mode.view().error), /cancelled/);
  } finally { f.mode.close(); f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('startup clears a leftover enabled state so a crash cannot pin the Mac awake', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'server-mode.json'), JSON.stringify({ version: 1, enabled: true, heartbeat: Date.now() }));
    f.store.set('server-mode', 'false');
    await f.mode.initialize();
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'server-mode.json'), 'utf8')).enabled, false);
  } finally { f.mode.close(); f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('server mode is macOS only and its helper cannot be removed while on', async () => {
  const f = fixture();
  try {
    const other = new ServerMode(f.store, { platform: 'linux' });
    await assert.rejects(other.setEnabled(true), /macOS only/);
    await f.mode.setEnabled(true);
    await assert.rejects(f.mode.removeHelper(), /Turn server mode off/);
  } finally { f.mode.close(); f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('removing the helper restores normal sleep and deletes the daemon', async () => {
  const f = fixture();
  try {
    await f.mode.setEnabled(true);
    writeFileSync(join(f.dir, 'daemon.plist'), '<plist/>');
    await f.mode.setEnabled(false);
    await f.mode.removeHelper();
    const script = f.approved[f.approved.length - 1];
    assert.match(script, /launchctl bootout system\/com\.codecylabs\.farfromdesk\.servermode/);
    assert.match(script, /pmset -a disablesleep 0/);
    assert.match(script, /rm -rf '\/Library\/Application Support\/FarFromDesk\/server-mode'/);
    assert.equal(f.approved.length, 2);
  } finally { f.mode.close(); f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('an installed helper from an older build is replaced on the next enable', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'helper.sh'), '#!/bin/sh\nFFD_HELPER_VERSION=1\n');
    await f.mode.setEnabled(true);
    assert.equal(f.approved.length, 1, 'an out-of-date helper must be reinstalled, not kept');
    assert.match(f.approved[0], /FFD_HELPER_VERSION=2/);
    assert.equal(f.mode.view().enabled, true);
  } finally { f.mode.close(); f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('an installed helper with no version marker is replaced too', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'helper.sh'), '#!/bin/sh\necho older\n');
    await f.mode.setEnabled(true);
    assert.equal(f.approved.length, 1);
  } finally { f.mode.close(); f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('a current helper is not reinstalled on every enable', async () => {
  const f = fixture();
  try {
    await f.mode.setEnabled(true);
    await f.mode.setEnabled(false);
    await f.mode.setEnabled(true);
    assert.equal(f.approved.length, 1, 'the installed helper already matches the bundled one, so no prompt');
  } finally { f.mode.close(); f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('a clean shutdown does not release the hold, so a restart cannot sleep the Mac', async () => {
  const f = fixture();
  try {
    await f.mode.setEnabled(true);
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'server-mode.json'), 'utf8')).enabled, true);
    f.mode.close();
    const state = JSON.parse(readFileSync(join(f.dir, 'server-mode.json'), 'utf8'));
    assert.equal(state.enabled, true, 'a restarting backend must not open a window where the Mac can sleep');
    // Turning the setting off is the one thing that releases it at once.
    await f.mode.setEnabled(false);
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'server-mode.json'), 'utf8')).enabled, false);
  } finally { f.mode.close(); f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});
