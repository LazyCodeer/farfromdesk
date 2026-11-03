import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {screenLockGate, sessionLocked} from '../src/session-lock.js';

/** A stand-in for the bundled probe: prints the JSON it is told to print, and can
 * fail outright, which is what a missing or unreadable helper does. */
function probeFor(dir: string, body: string) {
  const path = join(dir, 'session-state');
  writeFileSync(path, `#!/bin/sh\n${body}\n`, {mode: 0o755});
  return path;
}

function fixture(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ffd-session-lock-'));
  return {dir, probe: probeFor(dir, body), dispose: () => rmSync(dir, {recursive: true, force: true})};
}

test('the probe distinguishes locked, unlocked and unusable', async () => {
  const locked = fixture(`printf '%s\\n' '{"unlocked":false,"reason":"SESSION_LOCKED"}'`);
  const unlocked = fixture(`printf '%s\\n' '{"unlocked":true,"reason":"UNLOCKED"}'`);
  const silent = fixture(`printf '%s\\n' '{"reason":"LOGIN_UNCONFIRMED"}'`);
  const broken = fixture('exit 3');
  try {
    assert.equal(await sessionLocked(locked.probe), true);
    assert.equal(await sessionLocked(unlocked.probe), false);
    // Not a lock, and not a proof of unlock either. Neither answer may be invented.
    assert.equal(await sessionLocked(silent.probe), undefined);
    assert.equal(await sessionLocked(broken.probe), undefined);
    assert.equal(await sessionLocked(join(locked.dir, 'absent')), undefined);
  } finally {
    locked.dispose();
    unlocked.dispose();
    silent.dispose();
    broken.dispose();
  }
});

test('a locked Mac refuses a screen action and sends the link instead', async () => {
  const f = fixture(`printf '%s\\n' '{"unlocked":false,"reason":"SESSION_LOCKED"}'`);
  const notices: string[] = [];
  let linked = 0;
  try {
    const gate = screenLockGate({probe: f.probe, link: async () => { linked += 1; return 'Open this link on your phone in the next 5 minutes:\nhttps://example.invalid/abc\n\nThe page gives you a code.'; }, notify: text => { notices.push(text); }});
    await assert.rejects(() => gate('click'), /SESSION_LOCKED/);
    assert.equal(linked, 1, 'the owner must be given a way to unlock, not just told no');
    assert.equal(notices.length, 1);
    assert.match(notices[0], /Your Mac is locked, so click was not sent to the screen/);
    assert.match(notices[0], /https:\/\/example\.invalid\/abc/);
  } finally { f.dispose(); }
});

test('an unlocked Mac runs the action and never sends a link', async () => {
  const f = fixture(`printf '%s\\n' '{"unlocked":true,"reason":"UNLOCKED"}'`);
  const notices: string[] = [];
  let linked = 0;
  try {
    const gate = screenLockGate({probe: f.probe, link: async () => { linked += 1; return 'link'; }, notify: text => { notices.push(text); }});
    await gate('click');
    assert.equal(linked, 0);
    assert.deepEqual(notices, []);
  } finally { f.dispose(); }
});

test('a probe that cannot answer does not block the owner', async () => {
  const f = fixture('exit 3');
  let linked = 0;
  try {
    const gate = screenLockGate({probe: f.probe, link: async () => { linked += 1; return 'link'; }, notify: () => {}});
    await gate('click');
    assert.equal(linked, 0);
  } finally { f.dispose(); }
});

test('the actions that mean nothing to the screen are never refused while locked', async () => {
  const f = fixture(`printf '%s\\n' '{"unlocked":false,"reason":"SESSION_LOCKED"}'`);
  let linked = 0;
  try {
    const gate = screenLockGate({probe: f.probe, link: async () => { linked += 1; return 'link'; }, notify: () => {}});
    for (const action of ['stop', 'status', 'check_permissions']) await gate(action);
    assert.equal(linked, 0, 'diagnosing a locked Mac must stay possible');
  } finally { f.dispose(); }
});

test('a locked Mac still refuses when the link cannot be made', async () => {
  const f = fixture(`printf '%s\\n' '{"unlocked":false,"reason":"SESSION_LOCKED"}'`);
  try {
    // The remote password may be unset, or the host may fail to start. The action must
    // still be refused: a failed handshake is not a reason to act on a locked screen.
    const gate = screenLockGate({probe: f.probe, link: async () => { throw new Error('no password set'); }, notify: () => {}});
    await assert.rejects(() => gate('type_text'), /SESSION_LOCKED/);
  } finally { f.dispose(); }
});

test('a delivery failure does not hide the reason for the refusal', async () => {
  const f = fixture(`printf '%s\\n' '{"unlocked":false,"reason":"SESSION_LOCKED"}'`);
  try {
    const gate = screenLockGate({probe: f.probe, link: async () => 'link', notify: () => { throw new Error('The owner connection changed.'); }});
    await assert.rejects(() => gate('click'), /SESSION_LOCKED/);
  } finally { f.dispose(); }
});