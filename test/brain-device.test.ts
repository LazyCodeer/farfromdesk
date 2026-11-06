import test from 'node:test';
import assert from 'node:assert/strict';
import { DevicePlan, devicePlanIssue, deviceFailureCode, deviceOutcome, deviceRefusal, plainCause, runDevicePlan, summarizeTree, detectDevicePlan, deviceVerbLike, appInventoryRequest, authoringRequest, notesAuthoringRequest, authoringText, notesWritePlan, type DeviceControl } from '../src/brain-device.js';
import { safeEventDetails } from '../src/request-events.js';
import { stripAxMetadata } from '../src/desktop-control.js';
import { Interpretation } from '../src/meta-model.js';

test('a plan accepts only the documented fields', () => {
  assert.equal(DevicePlan.parse({ action: 'open_app', app: 'Comet' }).app, 'Comet');
  assert.throws(() => DevicePlan.parse({ action: 'open_app', app: 'Comet', shell: 'rm -rf /' }), /Unrecognized key|unrecognized/i);
  assert.throws(() => DevicePlan.parse({ action: 'nope' }));
  assert.throws(() => DevicePlan.parse({ action: 'type', text: 'a'.repeat(4001) }));
  assert.doesNotThrow(() => DevicePlan.parse({ action: 'type', text: 'a'.repeat(1500) }), 'eleven sheet rows fit in one step');
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
  // The owner asked for an opened app to come forward, so that is the sentence when the
  // driver confirmed the activation.
  assert.deepEqual(
    deviceOutcome({ action: 'open_app', app: 'Comet' }, { app: 'Comet', running: true, windowReady: true, fronted: true }),
    { ok: true, line: 'Opened Comet and brought it to the front.', evidence: null });
  // Opened but no window is a different fact from opened with a window.
  assert.match(deviceOutcome({ action: 'open_app', app: 'Comet' }, { app: 'Comet', running: true, windowReady: false }).line, /^Opened Comet\.$/);
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

test('a pack tool answers with its own content, not a bare done', () => {
  // The live failure: "give me a summary of all my notes" ran a Notes read and answered
  // "Done in Notes." with the tool's own sentence thrown away.
  const recent = deviceOutcome(
    { action: 'app_tool', app: 'Notes', tool: 'notes_recent' },
    { ok: true, app: 'Notes', output: 'Showing 2 note(s), newest first: ### Roof (folder: Notes)' });
  assert.equal(recent.line, 'Here is what is in Notes:');
  assert.match(recent.evidence!, /Showing 2 note\(s\)/);
  // Content lives in exactly one place: the reply is line and evidence joined, so a read
  // that repeated itself in both was printed twice in the owner's chat.
  assert.doesNotMatch(recent.line, /Roof/);
  const written = deviceOutcome(
    { action: 'app_tool', app: 'Notes', tool: 'notes_append' },
    { ok: true, app: 'Notes', output: 'Added to Roof: it now has 40 characters.' });
  assert.equal(written.line, 'Added to Roof: it now has 40 characters.');
  assert.equal(written.evidence, null);
  // A tool that returns nothing still gets an honest sentence rather than an empty reply.
  assert.equal(deviceOutcome({ action: 'app_tool', app: 'Notes', tool: 'notes_recent' }, { ok: true, app: 'Notes', output: '   ' }).line, 'Notes has nothing to show for that.');
  // Where a mapping names what happened in the owner's own terms, it still wins.
  assert.equal(deviceOutcome({ action: 'app_tool', app: 'Notes', tool: 'notes_create_note' }, { ok: true, app: 'Notes', output: 'Wrote the note X in Notes.' }).line, 'Wrote the note in Notes.');
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
  assert.equal(failed.code, 'driver_unavailable', 'machine output from the helper is not a refusal it chose');
  // Unrecognized helper text is not forwarded: this exact bookkeeping string is what
  // brain-reply exists to delete, and it arrived inline instead.
  const bookkeeping = deviceOutcome({ action: 'click', app: 'Comet', name: 'Send' }, { ok: false, observation: 'full read (no usable earlier read of this window to diff against)' });
  assert.doesNotMatch(bookkeeping.line, /full read/);
  assert.equal(bookkeeping.line, 'I could not do that in Comet: the helper could not complete it.');
  const chosen = deviceOutcome({ action: 'click', app: 'Comet', name: 'Send' }, { ok: false, observation: 'no element matched' });
  assert.equal(chosen.code, 'driver_refused');
  assert.equal(deviceFailureCode(new Error('MCP error -32000: Connection closed')), 'driver_unavailable');
  assert.equal(deviceFailureCode(new Error('DESKTOP_NATIVE_REFUSED: nope')), 'driver_refused');
  assert.equal(deviceFailureCode(new Error('DESKTOP_APP_NOT_RUNNING: Comet')), 'target_unavailable');
  assert.equal(deviceFailureCode(new Error('ACCESSIBILITY_PERMISSION_REQUIRED: x')), 'permission_required');
  assert.equal(deviceFailureCode(new Error('who knows')), 'unknown');
  // No doubled full stop from a message that already ends in one.
  assert.equal(deviceRefusal(new Error('DESKTOP_TARGET_STALE: Discover targets for this request again.'), 'darwin'), 'I could not do that on your Mac: the helper could not complete it.');
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

test('a read shows the labels, not the accessibility plumbing', () => {
  // Live on 3 November a Notes read spent its whole character budget on `[id=...]` and
  // multi-line `[actions=[...]]` blobs, so the reply listed element ids and no note title.
  // The metadata is stripped before the budget is applied, which is what this pins.
  const raw = [
    '- [0] AXWindow "Notes" [id=_NS:8 actions=[raise]]',
    '    - [1] AXOutline (Folders) [id=_NS:20]',
    '      - [5] AXRow [actions=[name:pin',
    'target:0x0',
    'selector:(null),name:bin',
    'target:0x0',
    'selector:(null)]]',
    '        - AXStaticText = "tomorrow meeting at 10pm woth ashitosh"',
    '      - [6] AXButton "New Note"',
    '      - [7] AXRow  help="Perform press or select Return to open note."]',
  ].join('\n');
  const clean = stripAxMetadata(raw);
  assert.doesNotMatch(clean, /\[id=|\[actions=|selector:/);
  assert.match(clean, /"tomorrow meeting at 10pm woth ashitosh"/);
  assert.match(summarizeTree(clean, 8, 'Notes'), /tomorrow meeting at 10pm woth ashitosh/);
});

test('a clock and a shortcut are furniture, not content', () => {
  // Measured live on a meeting page: "1:13", "PM" and "(Raise hand (ctrl + ⌘ + h))" took
  // three of the eight bullets the owner asked to be filled with what is on screen.
  const tree = ['- [0] AXWindow "Meet - SpliceAI discussion"',
    '  - [1] AXStaticText = "1:13"',
    '  - [2] AXStaticText = "PM"',
    '  - [3] AXStaticText = "1:05 PM"',
    '  - [4] AXButton "Raise hand (ctrl + ⌘ + h)"',
    '  - [5] AXStaticText = "Nihal singh"'].join('\n');
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
  // The live tree truncates the closing quote, which is what the first version of this rule
  // missed: it only knew the balanced form, so the real window still showed
  // `Deployment name" = "claude-fable-5-1`.
  const truncated = ['- [0] AXWindow "Microsoft Foundry"',
    '  - [1] AXStaticText = "Deployment name"',
    '  - [2] AXTextField "Deployment name" = "claude-fable-5-1'].join('\n');
  assert.equal(summarizeTree(truncated, 8, 'Microsoft Foundry'), '- Deployment name: claude-fable-5-1');
});

test('a page is never emptied by the chrome rule', () => {
  // The chrome rule reads indentation, so a tree that omits the container row between a
  // toolbar subtree and the page subtree dropped the whole page: the owner would have read
  // "I read Comet." and nothing else, with no sign that the read had found nothing.
  const tree = ['- [0] AXWindow "Inbox"', '  - [1] AXToolbar', '    - [2] AXButton "Reload"', '      - [3] AXStaticText = "Amazon Web Services billing alert"'].join('\n');
  assert.equal(summarizeTree(tree, 8, 'Inbox'), '- Reload\n- Amazon Web Services billing alert');
  // The strict pass still wins when it finds anything, so a normal tree keeps no chrome.
  const normal = ['- [0] AXWindow "Inbox"', '  - [1] AXToolbar', '    - [2] AXButton "Reload"', '  - [3] AXStaticText = "AWS billing alert"'].join('\n');
  assert.equal(summarizeTree(normal, 8, 'Inbox'), '- AWS billing alert');
});

test('only a heading that is the window title is dropped, not one that mentions it', () => {
  // "Notes" as a window title used to drop "Notes about the trip" as well.
  const tree = ['- [0] AXWindow "Notes"', '  - [1] AXStaticText = "Notes about the trip"', '  - [2] AXStaticText = "Shopping list"'].join('\n');
  assert.equal(summarizeTree(tree, 8, 'Notes'), '- Notes about the trip\n- Shopping list');
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

test('courtesy does not change the shape', () => {
  // Measured live on 2026-11-03: "Could you open notes" was not device-shaped, so a pending
  // coding contract re-sent its review card instead of opening the app.
  for (const text of ['Could you open notes', 'Can you open Notes', 'would you please open Comet', 'Hey, can u open Notes', 'ok now open Comet']) {
    assert.equal(deviceVerbLike(text), true, text);
  }
  assert.deepEqual(detectDevicePlan('Could you open notes', OPEN_APPS), { action: 'open_app', app: 'Notes' });
  assert.deepEqual(detectDevicePlan('Can you please press escape in Comet', OPEN_APPS), { action: 'press_key', app: 'Comet', key: 'escape' });
  assert.deepEqual(detectDevicePlan('could you read Notes', OPEN_APPS), { action: 'read_window', app: 'Notes' });
  assert.equal(deviceVerbLike('Can you fix the failing tests'), false, 'courtesy must not make coding work device-shaped');
  assert.equal(detectDevicePlan('Can you open the PR', OPEN_APPS), null);
  assert.equal(appInventoryRequest('Could you show me all apps'), true);
  assert.equal(authoringRequest('Could you write a note that the roof is leaking'), true);
  assert.equal(authoringText('Could you write a note that the roof is leaking'), 'the roof is leaking');
  assert.equal(authoringText('Can you write down buy milk'), 'buy milk');
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

test('an app inventory is a device turn, and so is a bare request to write', () => {
  for (const text of ['Show me opened apps', 'show me all apps', 'List apps', 'what apps are open', 'Which applications are running right now?', 'show apps']) {
    assert.equal(appInventoryRequest(text), true, text);
  }
  // Coding work and ordinary chat must not be claimed, or the contract review is skipped.
  for (const text of ['open the PR', 'fix the failing tests', 'list my codex sessions', 'where are we', 'show me the diff', 'list files']) {
    assert.equal(appInventoryRequest(text), false, text);
  }
  assert.equal(authoringRequest('Write a notes about tomorrow meeting at 10pm woth ashitosh'), true);
  assert.equal(authoringRequest('now write the notes'), true);
  assert.equal(authoringRequest('type hello in Notes'), true);
  // Verbs that open coding work far more often than they write into an app stay out.
  assert.equal(authoringRequest('add a dark theme to the settings page'), false);
  assert.equal(authoringRequest('create a new session for this'), false);
  assert.equal(authoringRequest('save the last change'), false);
  assert.equal(authoringRequest('fix the failing tests'), false);
  assert.equal(authoringRequest('/write the notes'), false);
  // Only a named note is claimed without an app; a bare coding write keeps its review.
  for (const text of ['Write a notes about tomorrow meeting at 10pm woth ashitosh', 'now write the notes', 'note that the roof is leaking']) {
    assert.equal(notesAuthoringRequest(text), true, text);
  }
  for (const text of ['write the failing test', 'write unit tests for the parser', 'type hello']) {
    assert.equal(notesAuthoringRequest(text), false, text);
  }
});

test('a bare write keeps the owner words verbatim and drops only the filler', () => {
  assert.equal(authoringText('Write a notes about tomorrow meeting at 10pm woth ashitosh'), 'tomorrow meeting at 10pm woth ashitosh');
  assert.equal(authoringText('write a note: buy milk'), 'buy milk');
  assert.equal(authoringText('note that the roof is leaking'), 'the roof is leaking');
  assert.equal(authoringText('please jot down call the plumber'), 'call the plumber');
  assert.equal(authoringText('write'), undefined);
  // Nothing is rewritten: a typo is what the owner asked to be written.
  assert.equal(authoringText('append teh invoice number'), 'teh invoice number');
});

test('a bare write in Notes runs the reviewed Notes tool, not a blind type', () => {
  // Measured live: the blind type landed in the Notes search field while the owner was told
  // it had been written down. The pack is what makes the claim match the driver's report.
  assert.deepEqual(notesWritePlan('Notes', 'tomorrow meeting at 10pm'), { action: 'app_tool', tool: 'notes_create_note', app: 'Notes', args: { body: 'tomorrow meeting at 10pm' } });
  assert.deepEqual(notesWritePlan('notes', 'buy milk').action, 'app_tool');
  // Any other app keeps the general promise: the owner's own words, typed where they are.
  assert.deepEqual(notesWritePlan('TextEdit', 'buy milk'), { action: 'type', app: 'TextEdit', text: 'buy milk' });
});

test('an app tool plan is validated and reported like any other plan', async () => {
  assert.match(devicePlanIssue({ action: 'app_tool' })!, /which app tool/i);
  assert.equal(devicePlanIssue({ action: 'app_tool', tool: 'notes_create_note' }), null);
  const seen: any[] = [];
  const control: DeviceControl = {
    assist: async () => { throw new Error('assist must not be used for an app tool'); },
    targets: async () => [],
    packTool: async (scope, name, args) => { seen.push({ scope, name, args }); return { action: 'app_tool', tool: name, app: 'Notes', ok: true, window: 'Notes' }; },
  };
  const out = await runDevicePlan(control, { action: 'app_tool', tool: 'notes_create_note', app: 'Notes', args: { body: 'buy milk' } }, 'brain:t', () => {});
  assert.deepEqual(seen, [{ scope: 'brain:t', name: 'notes_create_note', args: { body: 'buy milk' } }]);
  assert.equal(out.ok, true);
  assert.equal(out.line, 'Wrote the note in Notes.');
});

test('a helper without app tools says so instead of claiming anything', async () => {
  const control: DeviceControl = { assist: async () => ({}), targets: async () => [] };
  const out = await runDevicePlan(control, { action: 'app_tool', tool: 'notes_create_note', app: 'Notes', args: { body: 'x' } }, 'brain:t', () => {});
  assert.equal(out.ok, false);
  assert.match(out.line, /not available right now/i);
  assert.equal(out.code, 'driver_unavailable');
});

test('a failed app tool is reported in the owner words, never the driver text', async () => {
  const control: DeviceControl = {
    assist: async () => ({}),
    targets: async () => [],
    packTool: async () => { throw Object.assign(new Error('APP_TOOL_FAILED: notes_create_note did not run: {"type":"text","text":"DESKTOP_NATIVE_REFUSED"}'), {}); },
  };
  const out = await runDevicePlan(control, { action: 'app_tool', tool: 'notes_create_note', app: 'Notes', args: { body: 'x' } }, 'brain:t', () => {});
  assert.equal(out.ok, false);
  assert.ok(!/DESKTOP_NATIVE_REFUSED|\{"type"/.test(out.line), out.line);
});

test('the Automation grant is named as the exact switch to flip', () => {
  assert.match(deviceRefusal(new Error('AUTOMATION_PERMISSION_REQUIRED: macOS is waiting for your permission to control Calendar. Open System Settings > Privacy & Security > Automation, allow FarFromDesk Local to control Calendar, then ask me again. Nothing was sent.')), /Privacy & Security > Automation/);
  assert.match(deviceRefusal(new Error('APP_TOOL_ARGUMENT_MISSING: calendar_create_event needs start.')), /needs start/);
  assert.match(deviceRefusal(new Error('APP_TOOL_UNKNOWN: notes_send_fax')), /reviewed tool/i);
});

test('a bad tool argument is told to the owner as the tool described it', () => {
  const line = deviceRefusal(new Error('APP_TOOL_ARGUMENT_INVALID: A date has to look like 2026-11-04 09:00:00, not "tomorrow at 5".'));
  assert.match(line, /^I could not use those details, so I did nothing: A date has to look like/);
  assert.equal(deviceFailureCode(new Error('APP_TOOL_ARGUMENT_INVALID: nope')), 'invalid_arguments');
  assert.equal(deviceFailureCode(new Error('APP_TOOL_ARGUMENT_MISSING: calendar_create_event needs start.')), 'invalid_arguments');
});

// Regression: notes_recent, mail_recent and reminders_open returned "Done in Notes." and dropped
// what they read, so a read the owner asked for came back empty.
test('a reading app tool answers with what it read', () => {
  const read = deviceOutcome({ action: 'app_tool', app: 'Notes', tool: 'notes_recent' } as DevicePlan, { ok: true, output: 'Groceries: milk, eggs' });
  assert.equal(read.ok, true);
  assert.equal(read.evidence, 'Groceries: milk, eggs');
  assert.match(read.line, /Notes/);
  assert.equal(deviceOutcome({ action: 'app_tool', app: 'Mail', tool: 'mail_recent' } as DevicePlan, { ok: true, output: '' }).line, 'Mail has nothing to show for that.');
  assert.equal(deviceOutcome({ action: 'app_tool', app: 'Notes', tool: 'notes_delete' } as DevicePlan, { ok: true }).line, 'Done in Notes.');
});

// Live, 4 November 2026: "what is playing" and "any new messages" failed as invalid_response.
test('a model decision with number or null tool arguments still parses', async () => {
  const { tolerant, Interpretation } = await import('../src/meta-model.js');
  const raw = { intent: 'device', provider: 'unspecified', taskIds: [], device: { action: 'app_tool', tool: 'messages_recent', app: 'Messages', args: { limit: 5, query: null } } };
  const parsed = Interpretation.parse(tolerant(raw, 'any new messages'));
  assert.deepEqual(parsed.device?.args, { limit: '5' });
  assert.equal(parsed.normalized, 'any new messages');
});

// Live: every remaining invalid_response was the device object, with "" or null in unused fields.
test('a device decision with empty or unknown fields still parses, and a chat drops its device', async () => {
  const { tolerant, Interpretation } = await import('../src/meta-model.js');
  const device = Interpretation.parse(tolerant({ intent: 'device', normalized: 'x', provider: 'unspecified', taskIds: [], device: { action: 'app_tool', tool: 'calendar_list_events', app: 'Calendar', key: '', window: null, reason: 'owner asked', args: { days: 1 } } }, 'x'));
  assert.deepEqual(device.device, { action: 'app_tool', tool: 'calendar_list_events', app: 'Calendar', args: { days: '1' } });
  const chat = Interpretation.parse(tolerant({ intent: 'chat', normalized: 'x', provider: 'unspecified', taskIds: [], reply: 'ok', device: { action: '' } }, 'x'));
  assert.equal(chat.device, undefined);
});

// Live: "what tabs are open" was skipped as a tab command because it contains "open".
test('a question about open tabs is not a tab command', async () => {
  const { TAB_COMMAND } = await import('../src/meta-brain.js');
  for (const q of ['what tabs are open', 'how many tabs do I have open', 'which tabs are open in comet']) assert.equal(TAB_COMMAND.test(q), false, q);
  for (const q of ['open a new tab', 'close that tab', 'switch to the gmail tab']) assert.equal(TAB_COMMAND.test(q), true, q);
});
