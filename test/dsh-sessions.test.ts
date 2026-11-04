import test from 'node:test';
import assert from 'node:assert/strict';
import type { DshResult, DshRunOptions } from '../src/dsh-session.js';
import { addDshLabel, dshCancel, dshLabels, dshLegacySessionKey, dshQueueKey, dshQueueState, dshSessionKey, dshWorkspaces, runDshQueued } from '../src/dsh-sessions.js';

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
test('two labels in one folder are two conversations and run together', async () => {
  const g = gate();
  const folder = '/tmp/ffd-queue-labelled';
  const notes = runDshQueued(folder, { prompt: 'notes work', cwd: folder }, g.run, 'notes');
  const calendar = runDshQueued(folder, { prompt: 'calendar work', cwd: folder }, g.run, 'calendar');
  assert.equal(notes.queued, false);
  assert.equal(calendar.queued, false, 'a different label is not behind the first');
  const second = runDshQueued(folder, { prompt: 'notes again', cwd: folder }, g.run, 'notes');
  assert.equal(second.queued, true, 'the same label still waits in order');
  assert.deepEqual(dshQueueState(folder, 'notes'), { busy: true, waiting: 1 });
  assert.deepEqual(dshQueueState(folder, 'calendar'), { busy: true, waiting: 0 });
  g.release();
  await Promise.all([notes.result, calendar.result, second.result]);
  assert.equal(g.peak(), 2, 'the two conversations ran at once, and only those two');
});

test('a label has its own session key, and the folder-only key stays readable', () => {
  assert.equal(dshSessionKey('/w/spliceai', 'notes'), 'deepseek-session:/w/spliceai:notes');
  assert.equal(dshLegacySessionKey('/w/spliceai'), 'deepseek-session:/w/spliceai');
  assert.notEqual(dshQueueKey('/w/spliceai', 'notes'), dshQueueKey('/w/spliceai', 'calendar'));
  assert.equal(dshQueueKey('/w/spliceai', 'calendar'), dshQueueKey('/w/spliceai', 'calendar'));
});

test('labels list the default first, add once, and survive a broken record', () => {
  const store = new Map<string, string>();
  const get = (key: string) => store.get(key);
  const set = (key: string, value: string) => { store.set(key, value); };
  assert.deepEqual(dshLabels(get, '/w'), ['default'], 'a folder with no record still has the default');
  addDshLabel(get, set, '/w', 'notes');
  addDshLabel(get, set, '/w', 'notes');
  addDshLabel(get, set, '/w', 'calendar');
  assert.deepEqual(dshLabels(get, '/w'), ['default', 'notes', 'calendar'], 'each label appears once');
  store.set('deepseek-labels:/w', 'not json');
  assert.deepEqual(dshLabels(get, '/w'), ['default'], 'a broken record is not a label list');
  store.set('deepseek-labels:/w', JSON.stringify(Array.from({ length: 20 }, (_, index) => `l${index}`)));
  assert.deepEqual(dshLabels(get, '/w').length, 12, 'a folder cannot accumulate unbounded labels');
});

test('the folders that have conversations are found from the keys the commands wrote', () => {
  const keys = [
    'deepseek-labels:/Users/sagar/work/spliceai',
    'deepseek-session:/Users/sagar/work/spliceai:default',
    'deepseek-session:/Users/sagar/work/spliceai:research',
    'deepseek-session:/tmp/lonely:default',
    'deepseek-session:/tmp/legacy',
    'deepseek-session:C:\\repo:default',
    'unrelated:key',
  ];
  const found = dshWorkspaces(prefix => keys.filter(key => key.startsWith(prefix)));
  assert.deepEqual(found, [
    '/Users/sagar/work/spliceai',
    '/tmp/lonely',
    'C:\\repo',
  ], 'the label prefix is authoritative, the last colon separates the label, and nothing else is a workspace');
  assert.deepEqual(dshWorkspaces(() => []), [], 'no keys means no workspaces');
});
