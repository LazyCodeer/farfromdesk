import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'ffd-pr-test-')); process.env.WSB_STATE_DIR = root; process.env.FARFROMDESK_HOME = join(root, 'home');
test.after(() => rmSync(root, { recursive: true, force: true }));
const { Store } = await import('../src/store.js');
const { PrWatch, prStatus } = await import('../src/pr-watch.js');

test('a PR a session opened is watched, and the owner hears green, failing, merged and the end-of-day summary', async () => {
  const owner = 'owner@s.whatsapp.net', store = new Store(':memory:');
  store.set('whatsapp-owner', owner); store.set('control-channel', 'whatsapp'); store.set('pr-watch-cursor', '0');
  store.set('morning-brief-zone', 'UTC'); store.set('day-summary-time', '19:00');
  const binding = store.register('worker', 'codex', randomUUID(), '/tmp').binding;
  let now = Date.parse('2026-11-06T10:00:00Z');
  store.db.prepare("INSERT INTO outbox(id,binding_id,body,status,source,wa_id,created_at,destination,reply_kind) VALUES('o1',?,?,'sent','s1','w1',?,?,'final')")
    .run(binding.id, 'Opened https://github.com/acme/app/pull/42 for the login fix.', now - 1000, owner);
  let view: any = { state: 'OPEN', title: 'Fix login', statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS' }] };
  const calls: string[] = [];
  const watch = new PrWatch(store, async (repo, n) => { calls.push(`${repo}#${n}`); return view; }, () => now);
  const notices = () => (store.db.prepare("SELECT body FROM outbox WHERE binding_id IS NULL ORDER BY created_at,rowid").all() as any[]).map(r => r.body);

  await watch.tick();
  assert.deepEqual(calls, ['acme/app#42']);
  assert.deepEqual(notices(), [], 'pending says nothing');

  await watch.tick(); assert.equal(calls.length, 1, 'not checked again within 3 minutes');
  now += 4 * 60_000; view = { ...view, statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }, { name: 'lint', conclusion: 'SUCCESS' }] };
  await watch.tick();
  now += 4 * 60_000; view = { ...view, statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] };
  await watch.tick();
  now += 4 * 60_000; await watch.tick();
  now += 4 * 60_000; view = { ...view, state: 'MERGED' };
  await watch.tick();
  now += 4 * 60_000; await watch.tick();
  assert.equal(calls.length, 5, 'merged PRs stop being checked');
  assert.deepEqual(notices(), [
    'Checks failing on acme/app#42 "Fix login": test.',
    'All checks passed, ready to merge: acme/app#42 "Fix login".',
    'Merged: acme/app#42 "Fix login".',
  ]);

  now = Date.parse('2026-11-06T19:05:00Z'); await watch.tick(); await watch.tick();
  const summary = notices().filter(b => b.startsWith('End of day'));
  assert.equal(summary.length, 1, 'once a day');
  assert.match(summary[0], /Finished: worker \(1\)/);
  assert.match(summary[0], /acme\/app#42 "Fix login" merged/);

  assert.equal(prStatus({ state: 'OPEN', title: '', statusCheckRollup: [] }), 'pending');
  assert.equal(prStatus({ state: 'OPEN', title: '', statusCheckRollup: [{ context: 'ci', state: 'ERROR' }] }), 'failing:ci');
});
