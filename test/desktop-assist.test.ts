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
function control(tree: any, windows: any[], results: Record<string, any> = {}) {
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
  const c = new DesktopControl(prefs as any, driver as any, undefined as any, 'darwin', Date.now);
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