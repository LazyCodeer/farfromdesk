import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopControl } from '../src/desktop-control.js';

/**
 * Two defects this file exists for, both found by asking a live build to act:
 *   "what is in Comet right now" summarized a menu bar, because the first of Comet's four
 *   windows was chrome-less and the resolver took the first one.
 *   "press escape" was refused by the driver with "observe: pid and window_id are required",
 *   because the batch named no window for the observation to attach to.
 */
function control(tree: any, windows: any[], results: Record<string, any> = {}, activate: (app: string, bundleId?: string) => Promise<unknown> = async () => {}) {
  const calls: { name: string; args: any }[] = [];
  const prefs = { get: (k: string) => (k === 'mac-control-enabled' ? 'true' : undefined), set: () => {} };
  const driver = {
    call: async (name: string, args: any) => {
      calls.push({ name, args });
      if (name === 'check_permissions') return { accessibility: true, screen_recording: true };
      if (name === 'get_accessibility_tree') return tree;
      if (name === 'list_windows') return { windows };
      return results[name] ?? {};
    },
  };
  const c = new DesktopControl(prefs as any, driver as any, undefined as any, 'darwin', Date.now, activate as any);
  return { c, calls, of: (name: string) => calls.filter(x => x.name === name) };
}

const COMET_APPS = { apps: [{ name: 'Comet', bundle_id: 'ai.perplexity.comet', pid: 52476 }] };
// Measured live: the tree reported only one chrome-less window for Comet, while list_windows
// reported twelve, including the titled page window. Both shapes are reproduced here.
const COMET_TREE = { ...COMET_APPS, windows: [{ pid: 52476, title: '', window_id: 3097 }] };
const COMET_WINDOWS = [
  { pid: 52476, app_name: 'Comet', title: '', window_id: 3097 },
  { pid: 52476, app_name: 'Comet', title: '', window_id: 3095 },
  { pid: 52476, app_name: 'Comet', title: 'Private Email', window_id: 3091 },
];

test('a read finds the titled window even when the tree does not list it as on screen', async () => {
  const h = control(COMET_TREE, COMET_WINDOWS, { get_window_state: { window_title: 'Private Email', tree_markdown: '- [0] AXWindow "Private Email"\n  - [1] AXButton "Compose"', element_count: 2 } });
  const out = await h.c.assist('brain:t', { action: 'read_window', app: 'Comet' });
  assert.equal(out.window, 'Private Email');
  assert.equal(h.of('get_window_state')[0].args.window_id, 3091, 'the window the tree omitted is the one that was read');
});

test('a named window wins over the default one', async () => {
  const h = control(COMET_TREE, COMET_WINDOWS, { get_window_state: { window_title: 'Private Email', tree_markdown: '', element_count: 0 } });
  await h.c.assist('brain:t', { action: 'read_window', app: 'Comet', window: 'private' });
  assert.equal(h.of('get_window_state')[0].args.window_id, 3091);
});

test('the target list offers an app whose window is not on screen', async () => {
  const h = control(COMET_TREE, COMET_WINDOWS);
  assert.deepEqual(await h.c.targets(0), [{ name: 'Comet', bundleId: 'ai.perplexity.comet', windows: ['Private Email'] }]);
});

test('an action batch names the window so its observation can attach', async () => {
  const h = control(COMET_TREE, COMET_WINDOWS, { run_steps: { ok: true, observation: { summary: 'changed 1' } } });
  const out = await h.c.assist('brain:t', { action: 'press_key', app: 'Comet', key: 'escape' });
  const args = h.of('run_steps')[0].args;
  assert.equal(args.pid, 52476);
  assert.equal(args.window_id, 3091, 'the observation needs a window to attach to');
  assert.deepEqual(args.steps, [{ press_key: { key: 'escape' } }]);
  assert.equal(out.ok, true);
});

test('delivery stays in the background and never silently escalates', async () => {
  const h = control(COMET_TREE, COMET_WINDOWS, { run_steps: { ok: true } });
  await h.c.assist('brain:t', { action: 'click', app: 'Comet', name: 'Compose' });
  const args = h.of('run_steps')[0].args;
  assert.equal(args.delivery_mode, 'background');
  assert.equal('foreground_fallback' in args, false, 'a refused step must be reported, not foregrounded');
});

test('an app with no open window is refused before the driver is asked to act', async () => {
  const h = control({ apps: [{ name: 'Ghost', bundle_id: 'x.ghost', pid: 1 }], windows: [] }, []);
  await assert.rejects(() => h.c.assist('brain:t', { action: 'click', app: 'Ghost', name: 'Go' }), /DESKTOP_APP_NOT_RUNNING/);
  assert.equal(h.of('run_steps').length, 0);
});

test('the exclusions are checked before anything is read or launched', async () => {
  const h = control(COMET_TREE, COMET_WINDOWS);
  await assert.rejects(() => h.c.assist('brain:t', { action: 'read_window', app: 'System Settings' }), /SENSITIVE_TARGET/);
  await assert.rejects(() => h.c.assist('brain:t', { action: 'open_app', app: 'Keychain Access' }), /SENSITIVE_TARGET/);
  assert.equal(h.of('get_accessibility_tree').length, 0, 'no app was even enumerated');
});

test('a revoked grant stops the action with the grant named', async () => {
  const prefs = { get: (k: string) => (k === 'mac-control-enabled' ? 'true' : undefined), set: () => {} };
  const driver = { call: async () => ({ accessibility: false, screen_recording: false }) };
  const c = new DesktopControl(prefs as any, driver as any, undefined as any, 'darwin', Date.now);
  await assert.rejects(() => c.assist('brain:t', { action: 'open_app', app: 'Comet' }), /ACCESSIBILITY_PERMISSION_REQUIRED/);
});
test('driver bookkeeping never reaches the owner as if it were the answer', async () => {
  const h = control(COMET_TREE, COMET_WINDOWS, { run_steps: { ok: true, observation: { summary: 'full read (no usable earlier read of this window to diff against)' } } });
  const out = await h.c.assist('brain:t', { action: 'press_key', app: 'Comet', key: 'escape' });
  assert.equal(out.ok, true);
  assert.equal(out.observation, null);
  assert.equal(out.changes, null, 'nothing changed, so there is nothing to report');
  // A refusal still explains itself.
  const f = control(COMET_TREE, COMET_WINDOWS, { run_steps: { ok: false, observation: { summary: 'no element matched' } } });
  assert.equal((await f.c.assist('brain:t', { action: 'click', app: 'Comet', name: 'Nope' })).observation, 'no element matched');
});

test('a successful action reports that something changed, never the window text', async () => {
  // Measured: the raw diff put a sender address and a subject line from a mail page into the
  // owner's chat. "The window changed" describes the same outcome without carrying content,
  // and without the element count, which reads like a diff line in a message.
  const h = control(COMET_TREE, COMET_WINDOWS, { run_steps: { ok: true, observation: { state: { diff_counts: { added: 1, changed: 2, removed: 0 }, tree_diff: '~ AXStaticText = "freetier@costalerts.amazonaws.com AWS Free Tier"' } } } });
  const out = await h.c.assist('brain:t', { action: 'click', app: 'Comet', name: 'Inbox' });
  assert.equal(out.changes, 'The window changed.');
  assert.equal('diff' in out, false, 'the raw diff must not leave this layer');
  assert.equal(JSON.stringify(out).includes('costalerts'), false);
});

test('opening an app brings it to the front', async () => {
  // The owner asked for this: "when we told it to open something then it should be able to
  // bring it in the focus automatically". launch_app alone suppresses self-activation.
  let activated = 0;
  const h = control(COMET_TREE, COMET_WINDOWS, {
    launch_app: { name: 'Comet', pid: 52476, launch_state: { process_running: true, window_ready: true }, self_activation_suppressed: true },
    bring_to_front: { activated: true, status: 'activated', window_id: 3091 },
  }, async () => { activated++; });
  const out = await h.c.assist('brain:t', { action: 'open_app', app: 'Comet' });
  assert.equal(out.fronted, true);
  assert.equal(out.stoleFocus, true);
  assert.equal(h.of('bring_to_front')[0].args.pid, 52476);
  assert.equal(activated, 0, 'the driver fronted it, so LaunchServices was not needed');
});

test('an app the driver cannot front is activated through LaunchServices', async () => {
  // Measured live on Notes: launch_app suppresses self-activation and the app kept only stale
  // off-screen windows, so bring_to_front refused with "No eligible top-level windows found
  // for pid 16976". Only LaunchServices activation gave it a real on-screen window.
  const seen: string[] = [];
  let attempts = 0;
  const prefs = { get: (k: string) => (k === 'mac-control-enabled' ? 'true' : undefined), set: () => {} };
  const driver = {
    call: async (name: string, args: any) => {
      seen.push(name);
      if (name === 'check_permissions') return { accessibility: true, screen_recording: true };
      if (name === 'get_accessibility_tree') return COMET_APPS;
      if (name === 'list_windows') return { windows: COMET_WINDOWS };
      if (name === 'launch_app') return { name: 'Comet', pid: 52476, launch_state: { process_running: true, window_ready: false }, self_activation_suppressed: true };
      if (name === 'bring_to_front') { attempts++; if (attempts === 1) throw new Error('DESKTOP_NATIVE_REFUSED: No eligible top-level windows found for pid 52476.'); return { activated: true, status: 'activated' }; }
      return {};
    },
  };
  const c = new DesktopControl(prefs as any, driver as any, undefined as any, 'darwin', Date.now, (async (_app: string, bundleId?: string) => { seen.push('activate:' + bundleId); }) as any);
  const out = await c.assist('brain:t', { action: 'open_app', app: 'Comet' });
  assert.equal(out.fronted, true, 'the second attempt succeeded');
  assert.equal(attempts, 2);
  assert.ok(seen.includes('activate:ai.perplexity.comet'), 'LaunchServices was asked by bundle id');
});

const NOTES_WINDOWS = [
  { pid: 16976, app_name: 'Notes', title: 'Search - No Results', window_id: 19220 },
  { pid: 16976, app_name: 'Notes', title: 'Notes', window_id: 19221 },
];

test('the reviewed Notes tool runs its whole sequence in one background batch', async () => {
  const h = control({ apps: [{ name: 'Notes', bundle_id: 'com.apple.Notes', pid: 16976 }], windows: [] }, NOTES_WINDOWS, { run_steps: { ok: true, window_title: 'Notes' } });
  const out = await h.c.packTool('brain:t', 'notes_create_note', { body: 'tomorrow meeting at 10pm' });
  const args = h.of('run_steps')[0].args;
  assert.equal(args.delivery_mode, 'background');
  // Either Notes window works: the search state and a note share the toolbar, and the
  // resolver prefers the frontmost titled window. What matters is that a window is named,
  // because the driver refuses a batch whose observation cannot attach to one.
  assert.ok([19220, 19221].includes(args.window_id), `named window ${args.window_id}`);
  assert.deepEqual(args.steps, [
    { press_key: { key: 'escape' } },
    { click: { role: 'AXButton', name: 'New Note' } },
    { type_text: { role: 'AXTextArea', text: 'tomorrow meeting at 10pm' } },
  ]);
  assert.equal(out.ok, true);
  assert.equal(out.window, 'Notes');
});

test('an unknown tool or a missing argument is refused before the driver acts', async () => {
  const h = control({ apps: [{ name: 'Notes', bundle_id: 'com.apple.Notes', pid: 16976 }], windows: [] }, NOTES_WINDOWS, {});
  await assert.rejects(() => h.c.packTool('brain:t', 'notes_send_fax', {}), /APP_TOOL_UNKNOWN/);
  await assert.rejects(() => h.c.packTool('brain:t', 'notes_create_note', {}), /APP_TOOL_ARGUMENT_MISSING/);
  assert.equal(h.of('run_steps').length, 0);
});

test('an app tool with no open window is refused before the driver is asked', async () => {
  const h = control({ apps: [{ name: 'Notes', bundle_id: 'com.apple.Notes', pid: 1 }], windows: [] }, []);
  await assert.rejects(() => h.c.packTool('brain:t', 'notes_create_note', { body: 'x' }), /DESKTOP_APP_NOT_RUNNING/);
  assert.equal(h.of('run_steps').length, 0);
});

test('a tool that refuses its own arguments answers with its own sentence', async () => {
  const h = control({ apps: [{ name: 'Calendar', bundle_id: 'com.apple.iCal', pid: 42 }], windows: [] }, []);
  // The model has to work the date out itself, so a bad one is a plan-level guard rather than a
  // driver failure: it must not reach osascript and must not read as "I could not do that".
  await assert.rejects(
    () => h.c.packTool('brain:t', 'calendar_create_event', { title: 'Call Ashitosh', start: 'tomorrow at 5', end: 'tomorrow at 6' }),
    /^Error: APP_TOOL_ARGUMENT_INVALID: A date has to look like/,
  );
  await assert.rejects(
    () => h.c.packTool('brain:t', 'calendar_create_event', { title: 'Call Ashitosh', start: '2026-11-04 17:00:00', end: '2026-11-04 16:00:00' }),
    /^Error: APP_TOOL_ARGUMENT_INVALID: The end time has to be after the start time\./,
  );
  assert.equal(h.of('run_steps').length, 0);
});
