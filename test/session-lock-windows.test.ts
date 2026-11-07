import test from 'node:test';
import assert from 'node:assert/strict';
import {screenLockGate, sessionLocked, windowsSessionLocked, WINDOWS_LOCK_SCRIPT, type LockRunner} from '../src/session-lock.js';

function runner(stdout: string | Error) {
  const calls: {file: string; args: string[]; options: Parameters<LockRunner>[2]}[] = [];
  const run: LockRunner = async (file, args, options) => {
    calls.push({file, args, options});
    if (stdout instanceof Error) throw stdout;
    return {stdout};
  };
  return {calls, run};
}

test('the Windows probe reads the input desktop through a hidden PowerShell', async () => {
  const locked = runner('{"locked":true,"desktop":"Winlogon"}');
  assert.equal(await windowsSessionLocked(locked.run), true);
  assert.match(locked.calls[0].file, /powershell\.exe$/i);
  assert.equal(locked.calls[0].options.windowsHide, true);
  assert.equal(await windowsSessionLocked(runner('{"locked":false,"desktop":"Default"}').run), false);
  // Neither answer may be invented.
  assert.equal(await windowsSessionLocked(runner('{}').run), undefined);
  assert.equal(await windowsSessionLocked(runner('not json').run), undefined);
  assert.equal(await windowsSessionLocked(runner(new Error('timeout')).run), undefined);
  assert.ok(/^[\x00-\x7f]*$/.test(WINDOWS_LOCK_SCRIPT), 'Windows PowerShell 5.1 needs an ASCII script');
  assert.ok(!WINDOWS_LOCK_SCRIPT.includes('$"') && !WINDOWS_LOCK_SCRIPT.includes('?.'), 'C# 5 only');
});

test('a function probe answers directly, and a throwing one is unknown', async () => {
  assert.equal(await sessionLocked(async () => true), true);
  assert.equal(await sessionLocked(async () => false), false);
  assert.equal(await sessionLocked(async () => undefined), undefined);
  assert.equal(await sessionLocked(async () => { throw new Error('no'); }), undefined);
});

test('a locked PC refuses a screen action and says to unlock it at the PC, without a link', async () => {
  const notices: string[] = [];
  let linked = 0, clock = 1_000_000;
  const gate = screenLockGate({probe: async () => true, link: async () => { linked += 1; return 'https://example.invalid/x'; }, notify: text => { notices.push(text); }, platform: 'win32', now: () => clock});
  await assert.rejects(() => gate('click'), (e: Error) => /^SESSION_LOCKED: the PC is locked/.test(e.message) && /unlock it at the PC/.test(e.message) && !/\bMac\b/.test(e.message));
  assert.equal(linked, 0, 'the phone cannot reach the Windows lock screen, so no link is minted');
  assert.equal(notices.length, 1);
  assert.match(notices[0], /^Your PC is locked, so click was not sent to the screen\./);
  await assert.rejects(() => gate('click'), /SESSION_LOCKED/);
  assert.equal(notices.length, 1, 'a retry loop does not repeat the notice');
  clock += 61_000;
  await assert.rejects(() => gate('type_text'), /SESSION_LOCKED/);
  assert.equal(notices.length, 2);
  for (const action of ['stop', 'status', 'check_permissions']) await gate(action);
});

test('an unlocked or unknown PC runs the action', async () => {
  const notices: string[] = [];
  for (const probe of [async () => false, async () => undefined, async () => { throw new Error('x'); }]) {
    await screenLockGate({probe, link: async () => 'x', notify: text => { notices.push(text); }, platform: 'win32'})('click');
  }
  assert.deepEqual(notices, []);
});

test('the macOS wording is unchanged and other platforms say computer', async () => {
  const mac: string[] = [];
  await assert.rejects(() => screenLockGate({probe: async () => true, link: async () => 'https://example.invalid/a', notify: t => { mac.push(t); }, platform: 'darwin'})('click'),
    (e: Error) => /SESSION_LOCKED: the Mac is locked/.test(e.message) && /enter your Mac password/.test(e.message));
  assert.match(mac[0], /^Your Mac is locked, so click was not sent to the screen\. Unlock it from your phone:/);
  await assert.rejects(() => screenLockGate({probe: async () => true, link: async () => undefined, notify: () => {}, platform: 'linux'})('click'), /SESSION_LOCKED: the computer is locked/);
});

// Opt-in and read-only: asks Windows which desktop has input right now.
test('live: this PC reports a lock state', {skip: process.platform !== 'win32' || process.env.FFD_LIVE_DESKTOP !== '1'}, async () => {
  const state = await windowsSessionLocked();
  assert.equal(typeof state, 'boolean', 'the probe must answer on a signed-in PC');
});
