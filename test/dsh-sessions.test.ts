import test from 'node:test';
import assert from 'node:assert/strict';
import type { DshResult, DshRunOptions } from '../src/dsh-session.js';
import { dshCancel, dshQueueState, runDshQueued } from '../src/dsh-sessions.js';

const answer = (text: string): DshResult => ({ text, sessionId: 'session-x', error: null });

/** A runner that waits until the test releases it, so overlap is observable rather than timed. */
function gate() {
  let release: () => void = () => {};
  const opened = new Promise<void>(resolve => { release = resolve; });
  let inFlight = 0, peak = 0;
  const order: string[] = [];
  const run = async (options: DshRunOptions): Promise<DshResult> => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    order.push(options.prompt);
    await opened;
    inFlight -= 1;
    if (options.signal?.aborted) return Promise.reject(new Error('The DeepSeek run was cancelled.'));
    return answer(`done: ${options.prompt}`);
  };
  return { run, release, peak: () => peak, order, inFlight: () => inFlight };
}

test('two turns in one folder never overlap, and the second is told it queued', async () => {
  const g = gate();
  const folder = '/tmp/ffd-queue-one';
  const first = runDshQueued(folder, { prompt: 'one', cwd: folder }, g.run);
  assert.equal(first.queued, false, 'the first turn starts immediately');
  const second = runDshQueued(folder, { prompt: 'two', cwd: folder }, g.run);
  assert.equal(second.queued, true, 'the second turn is queued behind the first');
  assert.deepEqual(dshQueueState(folder), { busy: true, waiting: 1 });

  g.release();
  assert.equal((await first.result).text, 'done: one');
  assert.equal((await second.result).text, 'done: two');
  assert.equal(g.peak(), 1, 'only one turn ran at a time');
  assert.deepEqual(g.order, ['one', 'two'], 'the queue is first in, first out');
  assert.deepEqual(dshQueueState(folder), { busy: false, waiting: 0 }, 'the folder goes idle again');
});

test('different folders are different conversations and run together', async () => {
  const g = gate();
  const a = runDshQueued('/tmp/ffd-folder-a', { prompt: 'a', cwd: '/tmp/ffd-folder-a' }, g.run);
  const b = runDshQueued('/tmp/ffd-folder-b', { prompt: 'b', cwd: '/tmp/ffd-folder-b' }, g.run);
  assert.equal(a.queued, false);
  assert.equal(b.queued, false, 'another folder is not behind the first');
  g.release();
  await Promise.all([a.result, b.result]);
  assert.equal(g.peak(), 2, 'folders are independent');
});

test('a failed turn does not poison the folder', async () => {
  const folder = '/tmp/ffd-queue-fail';
  const boom = async (): Promise<DshResult> => { throw new Error('boom'); };
  await assert.rejects(runDshQueued(folder, { prompt: 'bad', cwd: folder }, boom).result, /boom/);
  const ok = runDshQueued(folder, { prompt: 'good', cwd: folder }, async () => answer('recovered'));
  assert.equal(ok.queued, false, 'the queue is empty again');
  assert.equal((await ok.result).text, 'recovered');
});

test('a queued turn can be cancelled, and cancelling is reported honestly', async () => {
  const g = gate();
  const folder = '/tmp/ffd-queue-stop';
  const first = runDshQueued(folder, { prompt: 'long', cwd: folder }, g.run);
  assert.equal(dshCancel(folder), true);
  assert.equal(dshCancel('/tmp/ffd-queue-never'), false, 'nothing running is not a stop');
  g.release();
  await assert.rejects(first.result, /cancelled/);
});