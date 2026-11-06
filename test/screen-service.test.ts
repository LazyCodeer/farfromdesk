import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoWindowsHelper, WindowsDesktopBackend, type WindowsHelper } from '../src/remote-p2p/windows-desktop.js';
import { ServicePipeHelper, screenServiceStatus } from '../src/screen-service.js';
import { screenLockGate } from '../src/session-lock.js';

// The FarFromDesk Screen Helper (native/screen-service) is faked here: these run on every OS.
const pipePath = () => process.platform === 'win32' ? `\\\\.\\pipe\\ffd-test-${process.pid}-${Math.random().toString(36).slice(2)}` : join(mkdtempSync(join(tmpdir(), 'ffd-pipe-')), 's');

function fakeService(answer: (r: any, socket: Socket) => void, refusal?: string) {
  const path = pipePath();
  const server = createServer(socket => {
    if (refusal) { socket.end(JSON.stringify({ id: 0, ok: false, error: refusal }) + '\n'); return; }
    let buf = ''; socket.setEncoding('utf8');
    socket.on('data', (d: string) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) answer(JSON.parse(l), socket); } });
  });
  return new Promise<{ path: string; close(): void }>(resolve => server.listen(path, () => resolve({ path, close: () => server.close() })));
}
const local = (): WindowsHelper & { calls: string[] } => { const calls: string[] = []; return { calls, async request(b) { calls.push(String(b.op)); return { ok: true, locked: true }; }, stop() {} }; };

test('the pipe helper talks the line protocol and reports the service lock screen as interactive', async () => {
  const svc = await fakeService((r, s) => s.write(JSON.stringify({ id: r.id, ok: true, locked: true, interactive: true }) + '\n'));
  const pipe = new ServicePipeHelper(svc.path);
  try {
    assert.equal(await pipe.open(), true);
    assert.deepEqual(await pipe.request({ op: 'state' }), { id: 1, ok: true, locked: true, interactive: true });
  } finally { pipe.stop(); svc.close(); }
});

test('the backend prefers the Screen Helper, and the phone is told it can unlock', async () => {
  const svc = await fakeService((r, s) => s.write(JSON.stringify(r.op === 'capture'
    ? { id: r.id, ok: true, locked: true, width: 10, height: 10, jpeg: Buffer.from([0xff, 0xd8, 1, 2]).toString('base64') }
    : { id: r.id, ok: true, locked: true, interactive: true }) + '\n'));
  const fallback = local();
  const auto = new AutoWindowsHelper(() => new ServicePipeHelper(svc.path), () => fallback, 'win32');
  const backend = new WindowsDesktopBackend(auto);
  try {
    assert.equal(await backend.ready(true), 'locked');
    assert.equal(backend.lockScreenInput, true);
    assert.equal((await backend.capture(new AbortController().signal)).width, 10);
    assert.deepEqual(fallback.calls, [], 'the per-user helper is not started');
  } finally { backend.stop(); svc.close(); }
});

test('no service, or a refusing one, falls back to the per-user helper (lock screen not reachable)', async () => {
  for (const make of [
    async () => ({ path: pipePath(), close() {} }),                                   // nothing listening
    () => fakeService(() => {}, 'CONSOLE_NOT_OWNER'),                                  // the console is someone else's
  ]) {
    const svc = await make(), fallback = local();
    const auto = new AutoWindowsHelper(() => new ServicePipeHelper(svc.path), () => fallback, 'win32');
    const backend = new WindowsDesktopBackend(auto);
    try {
      assert.equal(await backend.ready(true), 'locked');
      assert.equal(backend.lockScreenInput, false);
      assert.deepEqual(fallback.calls, ['state']);
    } finally { backend.stop(); svc.close(); }
  }
  const mac = local();
  const offWindows = new AutoWindowsHelper(() => { throw Error('not tried off Windows'); }, () => mac, 'darwin');
  await offWindows.request({ op: 'state' });
  assert.deepEqual(mac.calls, ['state']);
});

test('the service status is read from sc.exe, installed and running told apart', async () => {
  const sc = (stdout: string, code = 0) => async () => ({ code, stdout });
  assert.deepEqual(await screenServiceStatus('darwin'), { supported: false, bundled: false, installed: false, running: false });
  const running = await screenServiceStatus('win32', sc('SERVICE_NAME: FarFromDeskScreen\n        STATE              : 4  RUNNING\n'));
  assert.equal(running.installed, true); assert.equal(running.running, true);
  const stopped = await screenServiceStatus('win32', sc('SERVICE_NAME: FarFromDeskScreen\n        STATE              : 1  STOPPED\n'));
  assert.equal(stopped.installed, true); assert.equal(stopped.running, false);
  const missing = await screenServiceStatus('win32', sc('[SC] EnumQueryServicesStatus:OpenService FAILED 1060', 1060));
  assert.equal(missing.installed, false); assert.equal(missing.running, false);
});

test('a locked Windows PC gets an unlock link only when the Screen Helper runs', async () => {
  const notes: string[] = [];
  const withHelper = screenLockGate({ probe: async () => true, link: async () => 'Open this link: https://ffd.example/remote/#x', notify: t => notes.push(t), platform: 'win32', lockScreenUnlockable: async () => true });
  await assert.rejects(withHelper('click'), /SESSION_LOCKED: the PC is locked.*link has been sent/s);
  assert.match(notes.at(-1)!, /Your PC is locked, so click was not sent to the screen\. Unlock it from your phone:\n\nOpen this link/);
  const without = screenLockGate({ probe: async () => true, link: async () => { throw Error('no link without the helper'); }, notify: t => notes.push(t), platform: 'win32', lockScreenUnlockable: async () => false });
  await assert.rejects(without('click'), /do not send a remote-control link/);
  assert.match(notes.at(-1)!, /has to be unlocked at the PC itself/);
});
