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
import { toolByName } from '../src/app-tools/packs.js';
import type { ContractDecision } from '../src/task-contract-model.js';
import type { Interpretation } from '../src/meta-model.js';

/**
 * Several sessions at once, one Mac.
 *
 * The app serves more than one chat, and everything per-chat is keyed by destination: the
 * device memory (`brain-device-last:<destination>`), the pending coding contract
 * (owner + destination), the brain task row, and the reply. This suite runs two of them
 * through one router and one brain, interleaved, because the failures that reached the
 * owner came from a single session and a per-session bug would be invisible in a suite
 * that never runs two.
 *
 * What is deliberately NOT per-session: the app in front. It is a fact about the Mac, not
 * about the chat, so both sessions are offered the same reviewed tools.
 */

const pass: ContractDecision = { kind: 'pass', goal: '', exclusions: [], checks: [], question: '' };
const proposal = (question: string): ContractDecision => ({ kind: 'contract', goal: 'Add the requested dark theme', exclusions: ['Do not publish'], checks: ['Theme can be enabled', 'Existing theme still works'], question });
const chat = (reply: string): Interpretation => ({ intent: 'chat', provider: 'unspecified', normalized: 'x', taskIds: [], reply });
const clarify = (reply: string): Interpretation => ({ intent: 'clarify', provider: 'unspecified', normalized: 'x', taskIds: [], reply });

const DEST_A = 'owner@s.whatsapp.net';
// The owner's other chat is a group they configured as a destination, which is the second
// shape the app authenticates: owner commands are refused from anywhere else.
const DEST_B = '120363000000000000@g.us';
const OWNER = DEST_A;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ffd-sessions-'));
  const store = new Store(':memory:'), approvals = new Approvals(store);
  const native = { run: async () => {}, stop: () => {}, catalog: async () => ({ sessions: [] }) };
  store.set('whatsapp-owner', OWNER);
  store.set('destination-jid', DEST_B);
  store.set(`owned-group:${DEST_B}`, '1');
  const r = new Router(store, native as any, approvals); r.pump = () => {};
  r.coordinator = new Coordinator(store, native as any, r, () => {});
  const binding = store.register('codex-one', 'codex', randomUUID(), '/tmp').binding; store.set('active', binding.id);
  const secret = new MetaSecret(dir); secret.save('synthetic-sessions-key-not-real');
  saveBrainConfig(store, secret, { policy: { ...DEFAULT_BRAIN, taskContracts: true, enabled: true, allowRouting: true, allowStatus: true, allowManagement: true, failure: 'block', providers: ['codex', 'claude'] } });
  const seen: any[] = [], calls: any[] = [];
  let replies: Interpretation[] = [];
  const model = { interpret: async (_k: any, _p: any, input: any) => { seen.push(input); return replies.shift() ?? chat('Okay.'); } };
  const targets = [{ name: 'Notes', bundleId: 'com.apple.Notes', windows: [] }, { name: 'Calendar', bundleId: 'com.apple.iCal', windows: ['October'] }];
  let front: string | undefined = 'Notes';
  const device = {
    assist: async (_s: string, plan: any) => { calls.push({ ...plan, destination: store.destination() }); return { app: plan.app, running: true, windowReady: false, ...(plan.action === 'open_app' ? {} : { ok: true }) }; },
    targets: async () => targets,
    activeApp: async () => front,
    packTool: async (_s: string, name: string, args: any) => {
      const app = toolByName(name)?.app ?? 'Notes';
      calls.push({ action: 'app_tool', tool: name, app, args, destination: store.destination() });
      return { action: 'app_tool', tool: name, app, ok: true, window: app };
    },
  };
  r.brain = new MetaBrain(store, secret, model as any, device as any);
  let decisions: ContractDecision[] = [];
  r.contracts = new TaskContracts(store, secret, async () => decisions.shift() ?? pass);
  for (const destination of [DEST_A, DEST_B]) store.set(`owner-target:${destination}`, JSON.stringify({ kind: 'brain' }));
  // The channels run every message inside the destination and owner context, so a turn
  // knows which chat it belongs to; this mirrors that exactly, including the captured
  // owner record the reply path checks against.
  const send = async (destination: string, id: string, text: string) => {
    const origin = store.captureIncomingOwner(destination, 'whatsapp');
    assert.ok(origin, `the fixture could not capture ${destination} as an owner chat`);
    return store.incomingOwnerContext.run(origin!, () => store.destinationContext.run(destination, () => r.receive({ id: `wa:${id}`, text, ownerIntent: true, ownerCommand: true, activityScope: { destination, owner: OWNER } })));
  };
  const last = (destination: string) => {
    const row = store.db.prepare('SELECT body FROM outbox WHERE destination=? ORDER BY rowid DESC LIMIT 1').get(destination) as any;
    return String(row?.body ?? '');
  };
  const rows = (table: string) => store.db.prepare(`SELECT * FROM ${table}`).all() as any[];
  return {
    store, r, send, last, rows, calls, seen,
    setFront: (app: string | undefined) => { front = app; },
    replies: (...v: Interpretation[]) => { replies = v; },
    decisions: (...v: ContractDecision[]) => { decisions = v; },
    close: () => { rmSync(dir, { recursive: true, force: true }); store.close(); },
  };
}

test('two sessions are answered in their own chat', async () => {
  const f = fixture(); try {
    f.replies(chat('Notes and Calendar are the apps you have open.'));
    await f.send(DEST_A, 'a1', 'Could you open notes');
    await f.send(DEST_B, 'b1', 'Show me all apps');
    assert.match(f.last(DEST_A), /^Opened Notes/);
    assert.match(f.last(DEST_B), /Notes and Calendar are the apps/);
    assert.notEqual(f.last(DEST_A), f.last(DEST_B));
    // The reply rows carry the destination they belong to, so nothing was broadcast.
    const rows = f.rows('outbox').filter((row: any) => row.body);
    assert.ok(rows.every((row: any) => row.destination === DEST_A || row.destination === DEST_B), 'every reply names one of the two chats');
    assert.ok(rows.some((row: any) => row.destination === DEST_A) && rows.some((row: any) => row.destination === DEST_B));
  } finally { f.close(); }
});

test('the device memory is per session, so a bare write does not leak across chats', async () => {
  const f = fixture(); try {
    // Chat A uses Notes, which remembers which app A was working in.
    await f.send(DEST_A, 'a1', 'Could you open notes');
    f.replies(chat('Alright.'));
    await f.send(DEST_A, 'a2', 'write a note that buy milk');
    const wrote = f.calls.filter((call: any) => call.action === 'app_tool');
    assert.equal(wrote.length, 1, 'chat A wrote through the reviewed tool');
    assert.equal(wrote[0].app, 'Notes');
    assert.equal(wrote[0].destination, DEST_A);
    // Chat B never named an app, so there is nothing to write into and it has to ask.
    f.replies(clarify('What should I write in Notes?'));
    await f.send(DEST_B, 'b1', 'write a note that buy bread');
    assert.equal(f.calls.filter((call: any) => call.action === 'app_tool').length, 1, 'chat B did not borrow chat A memory');
    assert.match(f.last(DEST_B), /what should i write/i);
    assert.match(f.last(DEST_A), /wrote the note/i);
  } finally { f.close(); }
});

test('a pending contract in one chat does not swallow another chat turn', async () => {
  const f = fixture(); try {
    // "Make the dark theme change" is unclear coding work, so chat A gets a review card.
    f.decisions(proposal('Which dark theme, and where should it apply?'));
    f.replies(chat('Notes and Calendar are the apps you have open.'));
    await f.send(DEST_A, 'a1', 'Make the dark theme change');
    assert.equal(f.rows('task_contracts').filter((c: any) => c.state === 'pending').length, 1);
    assert.equal(String(f.rows('task_contracts')[0].destination), DEST_A);
    // Chat B asks for something on the Mac. It must not be treated as a correction.
    await f.send(DEST_B, 'b1', 'Show me all apps');
    assert.doesNotMatch(f.last(DEST_B), /could not update the contract/i);
    assert.match(f.last(DEST_B), /Notes and Calendar are the apps you have open/);
    assert.equal(f.rows('task_contracts').filter((c: any) => c.state === 'pending').length, 1, 'chat A contract is still pending');
    assert.ok(f.rows('brain_tasks').some((t: any) => t.id === 'wa:b1'));
  } finally { f.close(); }
});

test('the reviewed tools follow the Mac, not the chat', async () => {
  const f = fixture(); try {
    f.setFront('Calendar');
    f.replies(chat('On it.'));
    await f.send(DEST_A, 'a1', 'add a meeting with ashitosh tomorrow at 5pm');
    f.replies(chat('On it.'));
    await f.send(DEST_B, 'b1', 'put a meeting on my calendar tomorrow at 5');
    const withTools = f.seen.filter((input: any) => Array.isArray(input.appTools) && input.appTools.length);
    assert.equal(withTools.length, 2, 'both chats were offered the tools of the app in front');
    for (const input of withTools) {
      const names = input.appTools.map((tool: any) => tool.name);
      // The order is the retrieval order, so the first entry is the tool the request is
      // about. Measured: the Notes tool stays in the list because the owner's own note
      // example is the sentence "tomorrow meeting at 10pm woth ashitosh", which a calendar
      // request for a meeting with Ashitosh matches; the calendar tool still ranks first.
      assert.equal(names[0], 'calendar_create_event', `expected the calendar tool first, got ${names.join(', ')}`);
      assert.ok(names.length <= 5, 'the shortlist is capped');
      assert.ok(input.appTools.every((tool: any) => tool.app), 'every offered tool names its app');
      assert.match(String(input.now), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \w+$/);
    }
    // With the Notes app in front the Notes tool is offered, and the calendar tool stays in
    // the list for a meeting request. The list is a shortlist, not a decision.
    f.setFront('Notes');
    f.replies(chat('On it.'));
    await f.send(DEST_B, 'b2', 'write a note that buy milk');
    const last = f.seen.at(-1) as any;
    assert.equal(last.appTools[0].name, 'notes_create_note');
    assert.equal(last.appTools[0].app, 'Notes');
  } finally { f.close(); }
});