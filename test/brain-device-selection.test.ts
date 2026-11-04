import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Application modules cache their state root at import time.
const root = mkdtempSync(join(tmpdir(), 'ffd-device-select-'));
process.env.WSB_STATE_DIR = root; process.env.FARFROMDESK_HOME = join(root, 'home');
test.after(() => rmSync(root, { recursive: true, force: true }));
const { Store } = await import('../src/store.js');
const { MetaBrain } = await import('../src/meta-brain.js');
const { MetaSecret, saveBrainConfig, DEFAULT_BRAIN } = await import('../src/meta-brain-config.js');

// brainSelected reads r.store, so the fake router must carry it like the real one.
const router = (store: any) => ({ store, stopped: false, coordinator: undefined, guidedModes: { get: () => undefined }, native: {}, approvals: { pending: new Map() } }) as any;

/** Who acts on the Mac follows the owner's selection, so both selections are exercised. */
function fixture(decision: unknown, assist?: unknown) {
  const store = new Store(':memory:');
  const secret = new MetaSecret(root); secret.save('synthetic-device-selection-key-not-real');
  saveBrainConfig(store, secret, { policy: { ...DEFAULT_BRAIN, enabled: true, allowRouting: true, allowStatus: true, failure: 'block', providers: ['codex'] } });
  store.set('whatsapp-owner', 'synthetic-owner');
  const seen: any[] = [], calls: any[] = [];
  const model = { interpret: async (_k: any, _p: any, input: any) => { seen.push(input); return decision; } };
  const device = assist ? { assist: async (_s: string, plan: any) => { calls.push(plan); return assist; }, targets: async () => [{ name: 'Comet', bundleId: 'ai.perplexity.comet', windows: ['Inbox'] }] } : undefined;
  const brain = new MetaBrain(store, secret, model as any, device as any);
  const select = (target: unknown) => store.set(`owner-target:${store.destination()}`, JSON.stringify(target));
  const outbox = () => store.db.prepare('SELECT request_id,body FROM outbox ORDER BY id').all() as any[];
  return { store, brain, seen, calls, select, outbox, done: () => store.close() };
}

test('the brain is told it acts only when the owner selected it', async () => {
  const t = fixture({ intent: 'chat', provider: 'unspecified', normalized: 'hello', taskIds: [], reply: 'Hi.' }, {});
  try {
    t.select({ kind: 'brain' });
    assert.equal(await t.brain.handle(router(t.store), { id: 'local:dev-a', text: 'hello there' } as any), true);
    assert.equal(t.seen[0].deviceControl, 'brain');
    assert.deepEqual(t.seen[0].devices, [{ name: 'Comet', bundleId: 'ai.perplexity.comet', windows: ['Inbox'] }]);
  } finally { t.done(); }
});

test('a session selection never starts the desktop driver', async () => {
  const t = fixture({ intent: 'chat', provider: 'unspecified', normalized: 'hello', taskIds: [], reply: 'Hi.' });
  try {
    t.select({ kind: 'session', id: 'synthetic-session', identity: 'x' });
    assert.equal(await t.brain.handle(router(t.store), { id: 'local:dev-b', text: 'hello there' } as any), true);
    assert.equal(t.seen[0].deviceControl, 'session');
    assert.equal('devices' in t.seen[0], false, 'no target read, so no driver start');
    assert.equal(t.calls.length, 0);
  } finally { t.done(); }
});

test('a selected brain opens the app and reports what the driver said', async () => {
  const t = fixture({ intent: 'device', provider: 'unspecified', normalized: 'open Comet', taskIds: [], device: { action: 'open_app', app: 'Comet' } }, { action: 'open_app', app: 'Comet', running: true, windowReady: true });
  try {
    t.select({ kind: 'brain' });
    assert.equal(await t.brain.handle(router(t.store), { id: 'local:dev-c', text: 'open Comet' } as any), true);
    assert.deepEqual(t.calls, [{ action: 'open_app', app: 'Comet' }]);
    assert.match(String(t.outbox()[0]?.body ?? ''), /Opened Comet\./);
    // Answered in the chat, never queued as work for a coding session.
    assert.equal(t.brain.get('local:dev-c')?.state, 'answered');
  } finally { t.done(); }
});

test('a session selection refuses the device action instead of losing it', async () => {
  const t = fixture({ intent: 'device', provider: 'unspecified', normalized: 'open Comet', taskIds: [], device: { action: 'open_app', app: 'Comet' } }, { action: 'open_app', app: 'Comet', running: true, windowReady: true });
  try {
    t.select({ kind: 'session', id: 'synthetic-session', identity: 'x' });
    assert.equal(await t.brain.handle(router(t.store), { id: 'local:dev-d', text: 'open Comet' } as any), true);
    assert.equal(t.calls.length, 0, 'the brain must not touch the Mac while a session is selected');
    assert.match(String(t.outbox()[0]?.body ?? ''), /\/brain/);
    assert.notEqual(t.brain.get('local:dev-d')?.state, 'interpreting');
  } finally { t.done(); }
});

test('a device plan the model left empty asks instead of acting', async () => {
  const t = fixture({ intent: 'device', provider: 'unspecified', normalized: 'do the thing', taskIds: [] }, { action: 'open_app', app: 'Comet', running: true, windowReady: true });
  try {
    t.select({ kind: 'brain' });
    assert.equal(await t.brain.handle(router(t.store), { id: 'local:dev-e', text: 'do the thing' } as any), true);
    assert.equal(t.calls.length, 0);
    assert.match(String(t.outbox()[0]?.body ?? ''), /Tell me the one thing/);
  } finally { t.done(); }
});

test('a missing grant reaches the owner as the thing to change, never as a queued task', async () => {
  const t = fixture({ intent: 'device', provider: 'unspecified', normalized: 'open Comet', taskIds: [], device: { action: 'open_app', app: 'Comet' } }, undefined);
  try {
    t.select({ kind: 'brain' });
    const throwing = new MetaBrain(t.store, new MetaSecret(root), { interpret: async () => ({ intent: 'device', provider: 'unspecified', normalized: 'open Comet', taskIds: [], device: { action: 'open_app', app: 'Comet' } }) } as any,
      { assist: async () => { throw new Error('ACCESSIBILITY_PERMISSION_REQUIRED: Allow FarFromDesk'); }, targets: async () => [] } as any);
    assert.equal(await throwing.handle(router(t.store), { id: 'local:dev-f', text: 'open Comet' } as any), true);
    assert.match(String(t.outbox()[0]?.body ?? ''), /Accessibility is not granted/);
    assert.equal(t.store.job('local:dev-f'), undefined, 'a device request is never dispatched');
  } finally { t.done(); }
});
test('a device command goes to the model, which decides', async () => {
  // No pattern runs the command first: "open gmail in comet" was cut to "open Comet" by one and
  // the owner never got Gmail (4 November 2026). The model reads it and picks the action.
  const t = fixture({ intent: 'device', provider: 'unspecified', normalized: 'open Comet', taskIds: [], device: { action: 'open_app', app: 'Comet' } }, { action: 'open_app', app: 'Comet', running: true, windowReady: true });
  try {
    t.select({ kind: 'brain' });
    assert.equal(await t.brain.handle(router(t.store), { id: 'local:dev-g', text: 'open Comet' } as any), true);
    assert.equal(t.seen.length, 1, 'the model is consulted');
    assert.deepEqual(t.calls, [{ action: 'open_app', app: 'Comet' }]);
    assert.match(String(t.outbox()[0]?.body ?? ''), /Opened Comet\./);
  } finally { t.done(); }
});

test('the deterministic path still refuses when a session is selected', async () => {
  const t = fixture({ intent: 'task', provider: 'unspecified', normalized: 'open Comet', taskIds: [] }, { action: 'open_app', app: 'Comet', running: true, windowReady: true });
  try {
    t.select({ kind: 'session', id: 'synthetic-session', identity: 'x' });
    await t.brain.handle(router(t.store), { id: 'local:dev-h', text: 'open Comet' } as any).catch(() => undefined);
    assert.equal(t.calls.length, 0, 'a session selection must not let the brain touch the Mac');
  } finally { t.done(); }
});
