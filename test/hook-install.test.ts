import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairProviderHooks } from '../src/hook-install.js';

const node = process.execPath;
const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname;

test('the report is read back from the child process', async () => {
  const reports = await repairProviderHooks({ node, cli: fixture('hook-report-ok.mjs') });
  assert.deepEqual(reports, [
    { provider: 'codex', file: '/tmp/hooks.json', state: 'current' },
  ]);
});

test('a child that never answers is killed, and says nothing was learned', async () => {
  // The shape of the real failure: a read that waits on a disk that never
  // answers. On the bridge's own thread this froze the whole app, port included.
  const dir = mkdtempSync(join(tmpdir(), 'ffd-hook-install-'));
  const fifo = join(dir, 'blocked');
  try {
    execFileSync('/usr/bin/mkfifo', [fifo]);
    const started = Date.now();
    const reports = await repairProviderHooks({
      node,
      cli: fixture('hook-report-stuck.mjs'),
      timeoutMs: 700,
      env: { ...process.env, FFD_TEST_FIFO: fifo },
    });
    assert.equal(reports, null);
    assert.ok(Date.now() - started < 5_000, 'the deadline has to be what ends it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
