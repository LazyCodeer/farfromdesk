import test from 'node:test';
import assert from 'node:assert/strict';
import { DevicePlan, devicePlanIssue, deviceOutcome, deviceRefusal, runDevicePlan, summarizeTree, detectDevicePlan, type DeviceControl } from '../src/brain-device.js';
import { Interpretation } from '../src/meta-model.js';

test('a plan accepts only the documented fields', () => {
  assert.equal(DevicePlan.parse({ action: 'open_app', app: 'Comet' }).app, 'Comet');
  assert.throws(() => DevicePlan.parse({ action: 'open_app', app: 'Comet', shell: 'rm -rf /' }), /Unrecognized key|unrecognized/i);
  assert.throws(() => DevicePlan.parse({ action: 'nope' }));
  assert.throws(() => DevicePlan.parse({ action: 'type', text: 'a'.repeat(1201) }));
  // Control characters would let one field carry a second command to the driver.
  assert.throws(() => DevicePlan.parse({ action: 'type', text: 'echo\x1b[2J' }));
  assert.throws(() => DevicePlan.parse({ action: 'press_key', key: 'cmd+q' }));
});

test('a missing field is a question, not a crash', () => {
  assert.match(devicePlanIssue({ action: 'open_app' })!, /which app/i);
  assert.match(devicePlanIssue({ action: 'type', app: 'Notes' })!, /what should i type/i);
  assert.match(devicePlanIssue({ action: 'press_key' })!, /which app/i);
  assert.match(devicePlanIssue({ action: 'press_key', app: 'Comet' })!, /which key/i);
  assert.match(devicePlanIssue({ action: 'click', app: 'Comet' })!, /what should i click/i);
  assert.equal(devicePlanIssue({ action: 'open_app', app: 'Comet' }), null);
  assert.equal(devicePlanIssue({ action: 'click', app: 'Comet', name: 'Compose' }), null);
  // A bare key has no window to land in, so the app is required, not optional.
  assert.match(devicePlanIssue({ action: 'press_key', key: 'escape' })!, /which app/i);
  assert.equal(devicePlanIssue({ action: 'press_key', app: 'Comet', key: 'escape' }), null);
});

test('the driver result is reported, not the model guess', () => {
  assert.deepEqual(
    deviceOutcome({ action: 'open_app', app: 'Comet' }, { app: 'Comet', running: true, windowReady: true }),
    { ok: true, line: 'Opened Comet.', evidence: null });
  // Opened but no window is a different fact from opened with a window.
  assert.match(deviceOutcome({ action: 'open_app', app: 'Comet' }, { app: 'Comet', running: true, windowReady: false }).line, /has not drawn a window/i);
  assert.equal(deviceOutcome({ action: 'open_app', app: 'Comet' }, { app: 'Comet', running: false }).ok, false);
  const read = deviceOutcome({ action: 'read_window', app: 'Comet' }, { app: 'Comet', window: 'Inbox', tree: '- [0] AXWindow "Inbox"\n  - [1] AXButton "Compose" [actions=[press]]' });
  assert.equal(read.ok, true);
  assert.match(read.evidence!, /Compose/);
  assert.equal(deviceOutcome({ action: 'read_window', app: 'Comet' }, { app: 'Comet', tree: '' }).ok, false);
  assert.equal(deviceOutcome({ action: 'click', app: 'Comet' }, { ok: true }).line, 'Clicked in Comet.');
  assert.equal(deviceOutcome({ action: 'press_key', app: 'Comet', key: 'escape' }, { ok: true }).line, 'Pressed escape in Comet.');
  assert.match(deviceOutcome({ action: 'click', app: 'Comet' }, { ok: false, observation: 'no element matched' }).line, /no element matched/);
});

test('a refusal names the grant the owner has to change', () => {
  assert.match(deviceRefusal(new Error('ACCESSIBILITY_PERMISSION_REQUIRED: Allow FarFromDesk')), /Accessibility is not granted/);
  assert.match(deviceRefusal(new Error('MAC_CONTROL_DISABLED: nope')), /switched off in Settings/);
  assert.match(deviceRefusal(new Error('SENSITIVE_TARGET: x')), /not allowed to drive/);
  assert.match(deviceRefusal(new Error('DESKTOP_APP_NOT_RUNNING: Comet has no open window')), /no open window/);
  // An unexpected driver failure still says something true and bounded.
  assert.ok(deviceRefusal(new Error('E'.repeat(500))).length <= 300, 'the refusal stays short');
});

test('the tree is summarized for a phone', () => {
  const tree = ['- [0] AXWindow "Inbox"', '  - [1] AXGroup', '  - [2] AXButton "Compose" [actions=[press]]', '  - [3] AXButton "Compose" [actions=[press]]', '  - [4] AXStaticText = "Unread"'].join('\n');
  const summary = summarizeTree(tree);
  assert.match(summary, /Compose/);
  assert.match(summary, /Unread/);
  assert.equal(summary.split('Compose').length - 1, 1, 'repeats are dropped');
  assert.equal(/AXGroup|actions=|\[\d\]/.test(summary), false, 'vocabulary and ids are dropped');
  assert.ok(summarizeTree(Array.from({ length: 60 }, (_, i) => `- [${i}] AXButton "b${i}"`).join('\n')).length <= 700);
});

test('the plan reaches the driver without undefined fields', async () => {
  const seen: Record<string, unknown>[] = [];
  const control: DeviceControl = {
    assist: async (_scope, plan) => { seen.push(plan as unknown as Record<string, unknown>); return { app: 'Comet', running: true, windowReady: true }; },
    targets: async () => [],
  };
  const outcome = await runDevicePlan(control, { action: 'open_app', app: 'Comet' }, 'brain:x', () => {});
  assert.equal(outcome.ok, true);
  assert.deepEqual(seen[0], { action: 'open_app', app: 'Comet' });
  assert.equal('window' in seen[0], false);
});

test('a driver failure becomes a reported refusal, never a throw', async () => {
  const control: DeviceControl = {
    assist: async () => { throw new Error('ACCESSIBILITY_PERMISSION_REQUIRED: x'); },
    targets: async () => [],
  };
  const outcome = await runDevicePlan(control, { action: 'click', app: 'Comet', name: 'Send' }, 'brain:x', () => {});
  assert.equal(outcome.ok, false);
  assert.match(outcome.line, /Accessibility is not granted/);
});

test('an incomplete plan never reaches the driver', async () => {
  let called = 0;
  const control: DeviceControl = { assist: async () => { called++; return {}; }, targets: async () => [] };
  const outcome = await runDevicePlan(control, { action: 'type', app: 'Notes' }, 'brain:x', () => {});
  assert.equal(called, 0);
  assert.equal(outcome.ok, false);
});

test('the model can express a device action and nothing else can sneak in', () => {
  const decision = Interpretation.parse({ intent: 'device', normalized: 'open Comet', provider: 'unspecified', taskIds: [], device: { action: 'open_app', app: 'Comet' } });
  assert.equal(decision.device?.action, 'open_app');
  assert.equal(decision.intent, 'device');
  assert.throws(() => Interpretation.parse({ intent: 'device', normalized: 'x', provider: 'unspecified', taskIds: [], device: { action: 'open_app', app: 'Comet', command: 'id' } }));
  // A device intent with no plan is still valid input: the brain asks instead of acting.
  assert.equal(Interpretation.parse({ intent: 'device', normalized: 'x', provider: 'unspecified', taskIds: [] }).device, undefined);
});
const OPEN_APPS = [{ name: 'Comet' }, { name: 'Notes' }];

test('an unambiguous device command is detected without the model', () => {
  assert.deepEqual(detectDevicePlan('open Comet', OPEN_APPS), { action: 'open_app', app: 'Comet' });
  assert.deepEqual(detectDevicePlan('Open Comet.', OPEN_APPS), { action: 'open_app', app: 'Comet' });
  assert.deepEqual(detectDevicePlan('what is in Comet right now', OPEN_APPS), { action: 'read_window', app: 'Comet' });
  assert.deepEqual(detectDevicePlan('read Notes', OPEN_APPS), { action: 'read_window', app: 'Notes' });
  assert.deepEqual(detectDevicePlan('press escape in Comet', OPEN_APPS), { action: 'press_key', app: 'Comet', key: 'escape' });
  assert.deepEqual(detectDevicePlan('press enter in Comet', OPEN_APPS), { action: 'press_key', app: 'Comet', key: 'return' });
  assert.deepEqual(detectDevicePlan('click Compose in Comet', OPEN_APPS), { action: 'click', app: 'Comet', name: 'Compose' });
  assert.deepEqual(detectDevicePlan('type hello there in Notes', OPEN_APPS), { action: 'type', app: 'Notes', text: 'hello there' });
});

test('a command that is not unmistakably a device command is left to the model', () => {
  // A key with no app has nowhere to land in the background.
  assert.equal(detectDevicePlan('press escape', OPEN_APPS), null);
  // An app that is not open right now: the model may still choose to open it.
  assert.equal(detectDevicePlan('open Notes', [{ name: 'Comet' }]), null);
  // Coding work that merely contains a device verb must not be hijacked.
  assert.equal(detectDevicePlan('open the PR', OPEN_APPS), null);
  assert.equal(detectDevicePlan('fix the failing tests in Comet', OPEN_APPS), null);
  assert.equal(detectDevicePlan('read the build log from yesterday', OPEN_APPS), null);
  assert.equal(detectDevicePlan('find the file I opened in Comet', OPEN_APPS), null);
  // Owner commands are commands, not device requests.
  assert.equal(detectDevicePlan('/open Comet', OPEN_APPS), null);
  assert.equal(detectDevicePlan('   ', OPEN_APPS), null);
});
