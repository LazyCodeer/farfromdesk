import './brain-fixture-isolation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Coordinator } from '../src/coordinator.js';
import { Approvals } from '../src/approvals.js';
import { MetaBrain } from '../src/meta-brain.js';
import { DEFAULT_BRAIN, MetaSecret, saveBrainConfig } from '../src/meta-brain-config.js';
import { TaskContracts } from '../src/task-contracts.js';
import { DesktopControl } from '../src/desktop-control.js';
import type { ContractDecision } from '../src/task-contract-model.js';
import type { Interpretation } from '../src/meta-model.js';

/**
 * The fan-out harness: several sessions acting on one Mac at the same time.
 *
 * The app serves many chats and each chat is its own session, so "run these at once" is the
 * normal case, not the exotic one. What the harness exists to prove is the part that is easy
 * to get wrong and invisible in a single-session suite:
 *
 *   - the Mac takes one action at a time, because it is one Mac and the driver holds a single
 *     in-flight action (`src/desktop-control.ts` `private pending`). A second session that asks
 *     while the first is acting is refused with `DESKTOP_BUSY`, which the brain already turns
 *     into "I am already doing something on your Mac" rather than a silent drop or a false
 *     success;
 *   - the refusal lands in the chat that asked, and the completion lands in the chat that acted;
 *   - each session keeps its own device memory under fan-out, so one session's app never
 *     becomes another's.
 *
 * The device here is the real `DesktopControl` over a fake driver, not a stub, so the very
 * serialisation being tested is the shipped one. The driver holds `run_steps` open until the
 * test releases it, which is what makes the overlap deterministic instead of a race.
 */

const pass: ContractDecision = { kind: 'pass', goal: '', exclusions: [], checks: [], question: '' };
const chat = (reply: string): Interpretation => ({ intent: 'chat', provider: 'unspecified', normalized: 'x', taskIds: [], reply });
const wrote = (body: string): Interpretation => ({ intent: 'device', provider: 'unspecified', normalized: 'x', taskIds: [], device: { action: 'app_tool', tool: 'notes_create_note', app: 'Notes', args: { body } } } as Interpretation);

// Two chats is what the app authenticates: the owner's own chat, and one configured
// destination group. Any further chat is refused before routing (`authenticatedOwner`),
// which is a different behaviour from the one this harness is about.
const DEST_A = 'owner@s.whatsapp.net';
const DEST_B = '120363000000000000@g.us';
const AGENTS = [DEST_A, DEST_B];
const OWNER = DEST_A;
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
/** Wait for a condition instead of guessing how long a turn takes under load. */
async function waitFor(condition: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (condition()) return true; await tick(5); }
  return condition();
}

/** A driver that answers the read calls and holds any action open until `release()`. */
function gatedDriver() {
  let inflight = 0, maxInflight = 0;
  let release: (() => void) | undefined;
  const calls: string[] = [];
  const windows = [{ pid: 16976, app_name: 'Notes', title: 'Notes', window_id: 19221 }];
  const apps = { apps: [{ name: 'Notes', bundle_id: 'com.apple.Notes', pid: 16976, active: true }] };
  const driver = {
    call: async (name: string) => {
      calls.push(name);
      if (name === 'check_permissions') return { accessibility: true, screen_recording: true };
      if (name === 'list_apps') return apps;
      if (name === 'list_windows') return { windows };
      if (name === 'get_accessibility_tree') return { ...apps, windows };
      if (name === 'get_window_state') return { window_title: 'Notes', tree_markdown: '- [0] AXWindow "Notes"', element_count: 1 };
      if (name === 'run_steps') {
        inflight += 1; maxInflight = Math.max(maxInflight, inflight);
        await new Promise<void>(resolve => { release = resolve; });
        inflight -= 1;
        return { ok: true, observation: { summary: 'changed 1' } };
      }
      return {};
    },
    stop: () => {},
  };
  return {
    driver,
    calls,
    peak: () => maxInflight,
    inFlight: () => inflight,
    release: () => release?.(),
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ffd-fanout-'));
  const store = new Store(':memory:'), approvals = new Approvals(store);
  const native = { run: async () => {}, stop: () => {}, catalog: async () => ({ sessions: [] }) };
  store.set('whatsapp-owner', OWNER);
  store.set('destination-jid', DEST_B);
  store.set(`owned-group:${DEST_B}`, '1');
  const r = new Router(store, native as any, approvals); r.pump = () => {};
  r.coordinator = new Coordinator(store, native as any, r, () => {});
  const binding = store.register('codex-one', 'codex', randomUUID(), '/tmp').binding; store.set('active', binding.id);
  const secret = new MetaSecret(dir); secret.save('synthetic-fanout-key-not-real');
  saveBrainConfig(store, secret, { policy: { ...DEFAULT_BRAIN, taskContracts: true, enabled: true, allowRouting: true, allowStatus: true, allowManagement: true, failure: 'block', providers: ['codex', 'claude'] } });

  const gate = gatedDriver();
  const prefs = { get: (k: string) => (k === 'mac-control-enabled' ? 'true' : undefined), set: () => {} };
  const control = new DesktopControl(prefs as any, gate.driver as any, undefined as any, 'darwin', Date.now, (async () => {}) as any);

  const seen: any[] = [];
  const model = { interpret: async (_k: any, _p: any, input: any) => { seen.push({ destination: store.destination(), input }); return chat('Okay.'); } };
  r.brain = new MetaBrain(store, secret, model as any, control as any);
  r.contracts = new TaskContracts(store, secret, async () => pass);
  for (const agent of AGENTS) store.set(`owner-target:${agent}`, JSON.stringify({ kind: 'brain' }));

  const send = async (destination: string, id: string, text: string) => {
    const origin = store.captureIncomingOwner(destination, 'whatsapp');
    assert.ok(origin, `the fixture could not capture ${destination} as an owner chat`);
    return store.incomingOwnerContext.run(origin!, () => store.destinationContext.run(destination, () => r.receive({ id: `wa:${id}`, text, ownerIntent: true, ownerCommand: true, activityScope: { destination, owner: OWNER } })));
  };
  const last = (destination: string) => {
    const row = store.db.prepare('SELECT body FROM outbox WHERE destination=? ORDER BY rowid DESC LIMIT 1').get(destination) as any;
    return String(row?.body ?? '');
  };
  const memory = (destination: string) => {
    const raw = store.get(`brain-device-last:${destination}`);
    return raw ? JSON.parse(raw) : undefined;
  };
  const rows = (table: string) => store.db.prepare(`SELECT * FROM ${table}`).all() as any[];
  return {
    store, r, send, last, memory, rows, seen, control, gate,
    model: (fn: (destination: string) => Interpretation) => { (r.brain as any).model.interpret = async (_k: any, _p: any, input: any) => { seen.push({ destination: store.destination(), input }); return fn(store.destination() ?? ''); }; },
    close: () => { rmSync(dir, { recursive: true, force: true }); store.close(); },
  };
}

test('the Mac takes one action at a time even when two sessions ask together', async () => {
  const f = fixture(); try {
    const first = f.control.packTool('brain:one', 'notes_create_note', { body: 'first' });
    // Wait until the first action really is in flight before the second is asked, so the
    // overlap is caused by the test rather than by timing luck.
    await waitFor(() => f.gate.inFlight() > 0);
    assert.equal(f.gate.inFlight(), 1, 'the first action is holding the driver');
    const second = f.control.packTool('brain:two', 'notes_create_note', { body: 'second' });
    const refused = await second.then(() => undefined, (error: Error) => error.message);
    assert.match(String(refused), /^DESKTOP_BUSY/, 'the second session is refused, not queued behind the first');
    f.gate.release();
    const done = await first;
    assert.equal(done.ok, true);
    assert.equal(f.gate.peak(), 1, 'two actions never ran on the Mac at the same time');
  } finally { f.close(); }
});

test('the session that loses the Mac race is told, and the one that won is answered', async () => {
  const f = fixture(); try {
    f.model(destination => wrote(destination === AGENTS[0] ? 'agent one note' : 'agent two note'));
    const one = f.send(AGENTS[0], 'a1', 'write a note that agent one note');
    await waitFor(() => f.gate.inFlight() > 0);
    assert.equal(f.gate.inFlight(), 1, `the first session is acting on the Mac; last reply: ${f.last(AGENTS[0])}; driver calls: ${f.gate.calls.join(',')}`);
    const second = await f.send(AGENTS[1], 'b1', 'write a note that agent two note');
    assert.match(f.last(AGENTS[1]), /already doing something on your Mac/i, `the second chat is told the Mac is busy (receive: ${JSON.stringify(second)}; rows: ${JSON.stringify(f.rows('outbox').map((row: any) => [row.destination, row.body]))}; tasks: ${JSON.stringify(f.rows('brain_tasks').map((row: any) => [row.id, row.state, row.reason]))})`);
    f.gate.release();
    await one;
    assert.match(f.last(AGENTS[0]), /^Wrote the note in Notes/);
    assert.equal(f.last(AGENTS[1]), 'I am already doing something on your Mac. Let that finish, then ask me again.');
    // The refusal is in the refusing chat and the completion is in the acting chat: neither
    // message was broadcast, and neither chat saw the other's sentence.
    const replies = f.rows('outbox').filter((row: any) => row.body);
    assert.ok(replies.every((row: any) => AGENTS.includes(row.destination)), 'every reply names one of the sessions');
    assert.ok(replies.some((row: any) => row.destination === AGENTS[0] && /^Wrote the note/.test(row.body)));
    assert.ok(replies.some((row: any) => row.destination === AGENTS[1] && /already doing something/.test(row.body)));
  } finally { f.close(); }
});

test('each session keeps its own device memory under fan-out', async () => {
  const f = fixture(); try {
    f.model(destination => wrote(`${destination} note`));
    const first = f.send(AGENTS[0], 'a1', 'write a note that agent one note');
    await waitFor(() => f.gate.inFlight() > 0);
    const second = f.send(AGENTS[1], 'b1', 'write a note that agent two note');
    await second;
    f.gate.release();
    await first;
    // One Mac means one winner and two honest refusals; the point is that the winner's memory
    // is the winner's, and the losers leave no memory behind claiming they acted.
    // Each session remembers its own outcome and only its own: the winner remembers a write,
    // the loser remembers that it was refused, and neither remembers the other's app.
    const a = f.memory(AGENTS[0]), b = f.memory(AGENTS[1]);
    assert.equal(a.app, 'Notes');
    assert.equal(a.ok, true);
    assert.match(String(a.line), /^Wrote the note in Notes\.$/);
    assert.equal(b.ok, false);
    assert.match(String(b.line), /already doing something/);
    assert.match(f.last(AGENTS[0]), /^Wrote the note in Notes/);
    assert.match(f.last(AGENTS[1]), /already doing something/);
    const winners = AGENTS.filter(agent => /^Wrote the note/.test(f.last(agent)));
    const losers = AGENTS.filter(agent => /already doing something/.test(f.last(agent)));
    assert.equal(winners.length, 1, 'exactly one action reached the Mac');
    assert.equal(losers.length, 1, 'the other session was told rather than dropped');
  } finally { f.close(); }
});

test('a request with no reviewed tool still gets an honest refusal under fan-out', async () => {
  const f = fixture(); try {
    f.model(() => chat('I cannot do that one.'));
    await Promise.all(AGENTS.map((agent, index) => f.send(agent, `x${index}`, 'rename every file on my desktop')));
    for (const agent of AGENTS) assert.equal(f.last(agent), 'I cannot do that one.');
    assert.equal(f.gate.peak(), 0, 'nothing reached the Mac');
  } finally { f.close(); }
});