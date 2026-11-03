import test from 'node:test';
import assert from 'node:assert/strict';
import { DevicePlan, devicePlanIssue, deviceFailureCode, deviceOutcome, deviceRefusal, plainCause, runDevicePlan, summarizeTree, detectDevicePlan, deviceVerbLike, type DeviceControl } from '../src/brain-device.js';
import { safeEventDetails } from '../src/request-events.js';
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
  assert.match(deviceOutcome({ action: 'click', app: 'Comet' }, { ok: false, observation: 'no element matched' }).line, /nothing there matched/);
  // A target the owner named is used in the sentence: "nothing matched" alone leaves them
  // wondering what was looked for.
  assert.equal(deviceOutcome({ action: 'click', app: 'Comet', name: 'Send' }, { ok: false, observation: 'no element matched' }).line, 'I could not find "Send" in Comet. Nothing changed.');
  assert.equal(deviceOutcome({ action: 'click', app: 'Comet' }, { ok: false, observation: 'run_steps: step 1 of 1 failed; 0 step(s) ran before it, 0 not run 1.' }).line, 'I could not do that in Comet: the action did not complete.');
});

test('a refusal names the grant the owner has to change', () => {
  assert.match(deviceRefusal(new Error('ACCESSIBILITY_PERMISSION_REQUIRED: Allow FarFromDesk')), /Accessibility is not granted/);
  assert.match(deviceRefusal(new Error('MAC_CONTROL_DISABLED: nope')), /switched off in Settings/);
  assert.match(deviceRefusal(new Error('SENSITIVE_TARGET: x')), /not allowed to drive/);
  assert.match(deviceRefusal(new Error('DESKTOP_APP_NOT_RUNNING: Comet has no open window')), /no open window/);
  // An unexpected driver failure still says something true and bounded.
  assert.ok(deviceRefusal(new Error('E'.repeat(500))).length <= 300, 'the refusal stays short');
});

test('the driver envelopes never reach the owner', () => {
  // Measured live: these exact two strings were the whole reply.
  assert.match(deviceRefusal(new Error('MCP error -32000: Connection closed')), /lost the connection/i);
  const envelope = deviceRefusal(new Error('DESKTOP_NATIVE_REFUSED: run_steps rejected before running anything: observe: `pid` and `window_id` are required (no step names a window to inherit from)'));
  assert.doesNotMatch(envelope, /window_id|DESKTOP_NATIVE_REFUSED/);
  assert.doesNotMatch(envelope, /"type"/);
  assert.match(envelope, /could not do that/i);
  // Recognized phrasings become owner words rather than the helper's own.
  assert.equal(deviceRefusal(new Error('DESKTOP_NATIVE_REFUSED: no element matched a button named Send')), 'I could not do that: nothing there matched that name.');
  assert.equal(plainCause('MCP error -32000: Connection closed'), 'the helper could not complete it');
});

test('a failed action reports a sentence and a code, never the driver raw', () => {
  const failed = deviceOutcome({ action: 'click', app: 'Comet', name: 'Send' }, { ok: false, observation: '[{"type":"text","text":"observe: pid required"}]' });
  assert.equal(failed.ok, false);
  assert.doesNotMatch(failed.line, /"type"|pid/);
  assert.match(failed.line, /I could not do that in Comet/);
  // The log gets a code, not the text: request events exclude driver and provider words.
  assert.equal(failed.code, 'driver_refused');
  assert.equal(deviceFailureCode(new Error('MCP error -32000: Connection closed')), 'driver_unavailable');
  assert.equal(deviceFailureCode(new Error('DESKTOP_NATIVE_REFUSED: nope')), 'driver_refused');
  assert.equal(deviceFailureCode(new Error('DESKTOP_APP_NOT_RUNNING: Comet')), 'target_unavailable');
  assert.equal(deviceFailureCode(new Error('ACCESSIBILITY_PERMISSION_REQUIRED: x')), 'permission_required');
  assert.equal(deviceFailureCode(new Error('who knows')), 'unknown');
});

test('a device failure is recorded as a code, never as the driver words', () => {
  // A refused action must still leave a trace that can be read back later.
  assert.deepEqual(safeEventDetails({ action: 'press_key', outcome: 'blocked', code: 'driver_unavailable' }), { action: 'press_key', outcome: 'blocked', code: 'driver_unavailable' });
  assert.deepEqual(safeEventDetails({ action: 'press_key', outcome: 'blocked', detail: 'MCP error -32000: Connection closed' }), { action: 'press_key', outcome: 'blocked' });
});

test('the tree is summarized for a phone', () => {
  const tree = ['- [0] AXWindow "Inbox"', '  - [1] AXGroup', '  - [2] AXButton "Compose" [actions=[press]]', '  - [3] AXButton "Compose" [actions=[press]]', '  - [4] AXStaticText = "Unread"'].join('\n');
  const summary = summarizeTree(tree);
  assert.match(summary, /Compose/);
  assert.match(summary, /Unread/);
  assert.equal(summary.split('Compose').length - 1, 1, 'repeats are dropped');
  assert.equal(/AXGroup|actions=|\[\d\]/.test(summary), false, 'vocabulary and ids are dropped');
  assert.ok(summarizeTree(Array.from({ length: 60 }, (_, i) => `- [${i}] AXButton "b${i}"`).join('\n')).length <= 700);
  // One label per line: a semicolon run is a wall to parse on a phone.
  assert.equal(summary, '- Compose\n- Unread');
});

test('a window summary is content, not the menu bar', () => {
  // Measured live: "what is in Comet right now" answered with the menu bar only.
  const tree = ['- [0] AXWindow "Private Email"',
    '  - [1] AXMenuBar', '    - [2] AXMenuBarItem "Apple"', '    - [3] AXMenuBarItem "File"', '    - [4] AXMenuBarItem "Edit"', '    - [5] AXMenuBarItem "View"', '    - [6] AXMenuBarItem "Help"',
    '  - [7] AXToolbar', '    - [8] AXButton "Reload"',
    '  - [9] AXStaticText = "AWS Free Tier limit alert"'].join('\n');
  const summary = summarizeTree(tree);
  assert.doesNotMatch(summary, /^Apple|^File$/m);
  assert.doesNotMatch(summary, /Reload/, 'the toolbar is chrome too');
  assert.match(summary, /AWS Free Tier limit alert/);
  // Bounded: a page with 250 elements must not become a 250-line message.
  assert.equal(summarizeTree(Array.from({ length: 250 }, (_, i) => `- [${i}] AXStaticText = "row ${i}"`).join('\n')).split('\n').length, 8);
});

test('a clock and a shortcut are furniture, not content', () => {
  // Measured live on a meeting page: "1:13", "PM" and "(Raise hand (ctrl + ⌘ + h))" took
  // three of the eight bullets the owner asked to be filled with what is on screen.
  const tree = ['- [0] AXWindow "Meet - SpliceAI discussion"',
    '  - [1] AXStaticText = "1:13"',
    '  - [2] AXStaticText = "PM"',
    '  - [3] AXButton "Raise hand (ctrl + ⌘ + h)"',
    '  - [4] AXStaticText = "Nihal singh"'].join('\n');
  assert.equal(summarizeTree(tree, 8, 'Meet - SpliceAI discussion'), '- Nihal singh');
});

test('a field reads as label and value, once', () => {
  // Measured live on a settings page: the label arrived alone and then with its value, so
  // two of eight bullets were spent on one row, and the pair kept its quotes and equals sign.
  const tree = ['- [0] AXWindow "Microsoft Foundry"',
    '  - [1] AXStaticText = "Deployment name"',
    '  - [2] AXTextField "Deployment name" = "claude-fable-5-1"',
    '  - [3] AXButton "Deploy"'].join('\n');
  const summary = summarizeTree(tree, 8, 'Microsoft Foundry');
  assert.equal(summary, '- Deployment name: claude-fable-5-1\n- Deploy');
  assert.doesNotMatch(summary, /"|= "|\[/);
});

test('a heading that repeats the window title is not a second bullet', () => {
  // Measured live: of eight bullets on a mail window, the first one repeated the title the
  // sentence above it had already given, icon and all.
  const tree = ['- [0] AXWindow "Private Email 🔊"', '  - [1] AXStaticText = "Private Email"', '  - [2] AXButton "Compose"'].join('\n');
  assert.equal(summarizeTree(tree, 8, 'Private Email 🔊'), '- Compose');
  assert.equal(summarizeTree(tree, 8, 'Something Else'), '- Private Email\n- Compose');
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

test('a thrown native refusal names the target the owner asked for', async () => {
  // The driver reports this refusal by throwing, which is the path the first live run took:
  // the reply said only "nothing there matched that name", with no sign of what was looked for.
  const control: DeviceControl = {
    assist: async () => { throw new Error('DESKTOP_NATIVE_REFUSED: no element matched a button named Flibbertigibbet'); },
    targets: async () => [],
  };
  const outcome = await runDevicePlan(control, { action: 'click', app: 'Comet', name: 'the Flibbertigibbet button' }, 'brain:x', () => {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.line, 'I could not find "the Flibbertigibbet button" in Comet. Nothing changed.');
  assert.equal(outcome.code, 'driver_refused');
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

test('the router can tell a device-shaped message without a driver call', () => {
  assert.equal(deviceVerbLike('open Comet'), true);
  assert.equal(deviceVerbLike('press escape in Comet'), true);
  assert.equal(deviceVerbLike('what is in Comet right now'), true);
  // Coding and chat must not be claimed, or the contract review would be skipped for them.
  assert.equal(deviceVerbLike('fix the failing tests'), false);
  assert.equal(deviceVerbLike('where are we'), false);
  assert.equal(deviceVerbLike('list my codex sessions'), false);
  assert.equal(deviceVerbLike('/open Comet'), false);
  assert.equal(deviceVerbLike('   '), false);
});
