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
import type { ContractDecision } from '../src/task-contract-model.js';
import type { Interpretation } from '../src/meta-model.js';

/**
 * Transcript-level evals for the brain.
 *
 * The other device suites test one turn at a time, in isolation from the router, so the
 * failures that reached the owner on 2026-11-03 were invisible: a plain Mac request was
 * classified as coding work, the coding classifier then swallowed every later turn as a
 * "correction", and the model was allowed to invent app state the driver had already
 * reported. Each test below is one of those live transcripts, replayed against the real
 * router, the real task-contract flow and a fake desktop driver.
 *
 * The policy sets taskContracts true on purpose: the shared fixtures set it false, which
 * makes the contract path pass trivially and hides exactly this class of bug.
 */

const pass: ContractDecision = { kind: 'pass', goal: '', exclusions: [], checks: [], question: '' };
const proposal = (question: string): ContractDecision => ({ kind: 'contract', goal: 'Add the requested dark theme', exclusions: ['Do not publish'], checks: ['Theme can be enabled', 'Existing theme still works'], question });
const chat = (reply: string): Interpretation => ({ intent: 'chat', provider: 'unspecified', normalized: 'x', taskIds: [], reply });
const clarify = (reply: string): Interpretation => ({ intent: 'clarify', provider: 'unspecified', normalized: 'x', taskIds: [], reply });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ffd-conversation-'));
  const store = new Store(':memory:'), approvals = new Approvals(store);
  const native = { run: async () => {}, stop: () => {}, catalog: async () => ({ sessions: [] }) };
  store.set('whatsapp-owner', 'owner@s.whatsapp.net');
  const r = new Router(store, native as any, approvals); r.pump = () => {};
  r.coordinator = new Coordinator(store, native as any, r, () => {});
  const binding = store.register('codex-one', 'codex', randomUUID(), '/tmp').binding; store.set('active', binding.id);
  const secret = new MetaSecret(dir); secret.save('synthetic-conversation-key-not-real');
  saveBrainConfig(store, secret, { policy: { ...DEFAULT_BRAIN, taskContracts: true, enabled: true, allowRouting: true, allowStatus: true, allowManagement: true, failure: 'block', providers: ['codex', 'claude'] } });
  const seen: any[] = [], calls: any[] = [];
  let replies: Interpretation[] = [];
  const model = { interpret: async (_k: any, _p: any, input: any) => { seen.push(input); return replies.shift() ?? chat('Okay.'); } };
  // Notes is running with no titled window: the live shape that made the model say Notes
  // was not open. It must still be a target, and the driver's sentence is the fact.
  const targets = [{ name: 'Notes', bundleId: 'com.apple.Notes', windows: [] }, { name: 'Comet', bundleId: 'ai.perplexity.comet', windows: ['Inbox'] }];
  const device = {
    assist: async (_s: string, plan: any) => { calls.push(plan); return { app: plan.app, running: true, windowReady: false, ...(plan.action === 'open_app' ? {} : { ok: true }) }; },
    targets: async () => targets,
    // A reviewed app tool is recorded next to the raw plans, so a transcript can assert that
    // the pack did the write instead of a blind type.
    packTool: async (_s: string, name: string, args: any) => { calls.push({ action: 'app_tool', tool: name, app: 'Notes', args }); return { action: 'app_tool', tool: name, app: 'Notes', ok: true, window: 'Notes' }; },
  };
  r.brain = new MetaBrain(store, secret, model as any, device as any);
  let decisions: ContractDecision[] = [];
  r.contracts = new TaskContracts(store, secret, async () => decisions.shift() ?? pass);
  // Who acts on the Mac follows the owner's selection, which the brain checks itself.
  store.set(`owner-target:${store.destination()}`, JSON.stringify({ kind: 'brain' }));
  const send = async (id: string, text: string) => r.receive({ id: `wa:${id}`, text, ownerIntent: true, ownerCommand: true });
  const out = () => store.db.prepare('SELECT body,source FROM outbox ORDER BY rowid').all() as any[];
  const last = () => String(out().at(-1)?.body ?? '');
  const rows = (table: string) => store.db.prepare(`SELECT * FROM ${table}`).all() as any[];
  return {
    store, r, send, last, rows, calls, seen,
    replies: (...v: Interpretation[]) => { replies = v; },
    decisions: (...v: ContractDecision[]) => { decisions = v; },
    markSent: () => store.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run(),
    close() { r.stopped = true; approvals.cancel(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('an app inventory is not swallowed by a pending coding contract', async () => {
  // Live: "Show me opened apps" was answered "I could not update the contract. Please send
  // the correction again." twice, because the pending contract claimed every turn.
  const f = fixture(); try {
    f.decisions(proposal('Which item should be opened, and what does "open" mean for it?'));
    f.replies(chat('Notes and Comet are open.'));
    assert.equal((await f.send('1', 'Make the dark theme change')).status, 'handled');
    f.markSent();
    assert.equal(f.rows('task_contracts').filter(c => c.state === 'pending').length, 1);
    await f.send('2', 'Show me opened apps');
    assert.doesNotMatch(f.last(), /could not update the contract/i);
    assert.equal(f.rows('task_contracts').filter(c => c.state === 'pending').length, 1, 'the contract is still pending, nothing was approved');
    assert.ok(f.rows('brain_tasks').some(t => t.id === 'wa:2'), 'the inventory reached the brain');
  } finally { f.close(); }
});

test('the answer to a device question is not turned into a coding contract', async () => {
  // Live: "Yes make it open" answered the brain's own device question and became a coding
  // contract instead, with a review card about open-source and licensing.
  const f = fixture(); try {
    // What the coding classifier actually did with "Yes make it open" once it saw it: the
    // first turn is ordinary chat, the answer to the device question becomes coding work.
    f.decisions(pass, proposal('What item should be opened, and what does "open" mean for it?'));
    f.replies(clarify('Notes is not open right now. Do you want me to open it and write it there?'));
    // "my notes" names no app the driver can resolve, so this is the turn the model answers
    // with a question, which is the setup this test needs.
    await f.send('1', 'Could you open my notes');
    assert.equal(f.rows('brain_tasks')[0]?.state, 'clarification');
    f.replies(chat('Opening it now.'));
    await f.send('2', 'Yes make it open');
    assert.equal(f.rows('task_contracts').length, 0, 'a device answer is never a coding contract');
    assert.ok(f.rows('brain_tasks').some(t => t.id === 'wa:2'), 'the answer reached the brain, not the contract flow');
  } finally { f.close(); }
});

test('a bare write after using an app goes to that app, with the owner words verbatim', async () => {
  // Live: "Write a notes about tomorrow meeting at 10pm woth ashitosh" after "Opened Notes"
  // was answered "Notes is not open right now. Do you want me to open it and write it there?"
  const f = fixture(); try {
    await f.send('1', 'open Notes');
    assert.deepEqual(f.calls[0], { action: 'open_app', app: 'Notes' });
    assert.match(f.last(), /has not drawn a window/, 'the driver report is what the owner read');
    await f.send('2', 'Write a notes about tomorrow meeting at 10pm woth ashitosh');
    // The blind type is what landed in the Notes search field live while the owner was told
    // it had been written; the reviewed Notes tool is what replaces it.
    assert.deepEqual(f.calls[1], { action: 'app_tool', tool: 'notes_create_note', app: 'Notes', args: { body: 'tomorrow meeting at 10pm woth ashitosh' } });
    assert.match(f.last(), /Wrote the note in Notes/);
    assert.doesNotMatch(f.last(), /not open right now/i);
    assert.equal(f.seen.length, 0, 'the unambiguous device path never asks the model');
  } finally { f.close(); }
});

test('model prose may not contradict what the driver just reported', async () => {
  // The failing sentence was never in src/: it was model wording on the clarify branch,
  // emitted with no comparison against the device fact.
  const f = fixture(); try {
    await f.send('1', 'open Notes');
    f.replies(clarify('Notes is not open right now. Do you want me to open it and write it there?'));
    await f.send('2', 'Anything new in Notes?');
    assert.equal(f.seen.length, 1, 'the model was consulted for this one');
    assert.match(f.last(), /has not drawn a window/);
    assert.doesNotMatch(f.last(), /not open right now/i);
  } finally { f.close(); }
});

test('ordinary talk about the app is not replaced by the driver line', async () => {
  // The guard above must not swallow normal conversation: only a reply that describes app
  // state is a claim about the Mac, and only that kind is replaced.
  const f = fixture(); try {
    await f.send('1', 'open Notes');
    f.replies(chat('Agreed, Notes is handy for meeting minutes.'));
    await f.send('2', 'Notes is my favourite app');
    assert.match(f.last(), /handy for meeting minutes/);
    assert.doesNotMatch(f.last(), /has not drawn a window/);
  } finally { f.close(); }
});

test('a bare coding request is not stolen by the last app used', async () => {
  // "write the failing test" is authoring and coding work at once. After using Notes it
  // must still get its contract review, not be typed into Notes.
  const f = fixture(); try {
    await f.send('1', 'open Notes');
    f.decisions(proposal('What should the failing test cover?'));
    await f.send('2', 'write the failing test');
    assert.equal(f.calls.length, 1, 'nothing was typed into Notes');
    assert.equal(f.rows('task_contracts').length, 1, 'it kept its contract review');
  } finally { f.close(); }
});
test('a command for another subsystem is not an answer to a pending contract', async () => {
  // Live: with a contract pending, "/muse" was answered "The task or connection changed.
  // Send the task again. Nothing was sent." and the platform switch never ran. A command
  // is never a correction to a coding task, even when the pending row has gone stale.
  const f = fixture(); try {
    f.decisions(proposal('Which item should be opened, and what does "open" mean for it?'));
    assert.equal((await f.send('1', 'Make the dark theme change')).status, 'handled');
    f.markSent();
    assert.equal(f.rows('task_contracts').filter(c => c.state === 'pending').length, 1);
    // The connection moved on, so the pending row is now stale: exactly what the live
    // transcript had when the owner switched platforms.
    f.store.db.prepare("UPDATE task_contracts SET key_hash='moved-on' WHERE state='pending'").run();
    await f.send('2', '/muse');
    assert.doesNotMatch(f.last(), /task or connection changed/i);
    assert.notEqual(f.last(), '', 'the command produced an answer of its own');
    assert.equal(f.rows('task_contracts').filter(c => c.state === 'pending').length, 1, 'the command did not invalidate the contract');
  } finally { f.close(); }
});
