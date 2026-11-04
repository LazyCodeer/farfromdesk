import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopControl, desktopInput } from '../../src/desktop-control.js';

/**
 * The app tools through the coordinator route (master_desktop_control, session_desktop_control,
 * `ffd desktop`), not only through the brain.
 *
 * Measured 4 November 2026: with Muse as the coordinator, "check my recent notes" went to a
 * session whose only desktop functions were clicks and window reads, so the reviewed Notes,
 * Calendar and Mail tools were out of its reach. These pin that every coordinator can find a
 * tool from the owner's words and run it, with writes guarded like every other mutation.
 */
function harness() {
  const saved = new Map<string, string>();
  const prefs = { get: (k: string) => (k === 'mac-control-enabled' ? 'true' : saved.get(k)), set: (k: string, v: string) => { saved.set(k, v); } };
  const driver = { call: async (name: string) => (name === 'check_permissions' ? { accessibility: true, screen_recording: true } : {}) };
  const runs: { file: string; args: string[] }[] = [];
  const exec = async (file: string, args: string[]) => { runs.push({ file, args }); return { stdout: 'Groceries: milk, eggs', stderr: '' }; };
  const control = new DesktopControl(prefs as any, driver as any, undefined as any, 'darwin', Date.now, (async () => {}) as any, exec as any);
  return { control, runs };
}

test('a coordinator finds the right app tool from the owner words, typos included', async () => {
  const { control } = harness();
  const calendar = await control.run('b:r1', { action: 'app_tools', text: 'Check my calender' });
  assert.equal(calendar.tools.length, 32, 'the session gets the whole catalog and decides');
  assert.equal(calendar.likely[0], 'calendar_list_events', 'the matcher only marks the likely tool');
  assert.equal((await control.run('b:r1', { action: 'app_tools', text: 'check my recent notes' })).likely[0], 'notes_recent');
  const none = await control.run('b:r1', { action: 'app_tools', text: 'refactor the sync loop' });
  assert.deepEqual(none.likely, []);
  assert.equal(none.tools.length, 32, 'nothing is hidden when nothing matches');
});

test('a coordinator runs a reading tool and gets its content back', async () => {
  const { control, runs } = harness();
  const result = await control.run('b:r2', { action: 'app_tool', tool: 'notes_recent', args: {} });
  assert.match(JSON.stringify(result), /Groceries/);
  assert.equal(runs.length, 1, 'one helper run, no window clicks');
});

test('a writing tool needs a fresh action ID and is never replayed', async () => {
  const { control } = harness();
  const write = { action: 'app_tool', tool: 'notes_create_note', args: { body: 'hackathon test' } };
  await assert.rejects(control.run('b:r3', write), /DESKTOP_ACTION_ID_REQUIRED/);
  const actionId = '0b7c3c2e-6a2f-4d7e-9a49-8f7c1f3f1a11';
  await control.run('b:r3', { ...write, actionId });
  await assert.rejects(control.run('b:r3', { ...write, actionId }), /DESKTOP_ACTION_ALREADY_ATTEMPTED/);
  await assert.rejects(control.run('b:r3', { action: 'app_tool', tool: 'shell_exec', args: {} }), /APP_TOOL_UNKNOWN/);
  assert.throws(() => desktopInput.parse({ action: 'app_tool', tool: 'notes_recent', args: { n: 5 } }), 'arguments are strings only');
});

// Live, 4 November 2026: the EventKit helper said exactly what to do, and the owner read
// "the action did not complete" instead.
test('a helper refusal reaches the owner in its own words', async () => {
  const { deviceRefusal } = await import('../../src/brain-device.js');
  const prefs = { get: (k: string) => (k === 'mac-control-enabled' ? 'true' : undefined), set: () => {} };
  const driver = { call: async (name: string) => (name === 'check_permissions' ? { accessibility: true, screen_recording: true } : {}) };
  const sentence = 'macOS has not given this helper access to your Calendar. Open System Settings > Privacy & Security > Calendars and turn it on, then try again.';
  const exec = async () => { throw Object.assign(new Error('Command failed'), { code: 1, stderr: `Error: ${sentence}\n` }); };
  const control = new DesktopControl(prefs as any, driver as any, undefined as any, 'darwin', Date.now, (async () => {}) as any, exec as any);
  const error = await control.run('b:r4', { action: 'app_tool', tool: 'calendar_list_events', args: { days: '1' } }).catch(e => e);
  assert.equal(deviceRefusal(error), sentence);
});
