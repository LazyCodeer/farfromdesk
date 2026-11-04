import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DesktopControl } from '../../src/desktop-control.js';
import { allPackTools } from '../../src/app-tools/packs.js';
import { deviceRefusal } from '../../src/brain-device.js';
import type { AppTool } from '../../src/app-tools/types.js';

/**
 * The `cli` plan kind at the packTool seam.
 *
 * Calendar and Reminders are the first tools whose work happens in a bundled helper instead of
 * in osascript. Three things have to hold and none of them is visible from the pack tests:
 *   1. a helper that is not in this build is an honest refusal ("not available on this Mac yet"),
 *      not a crash and not a UI driver step that types into whatever window is in front;
 *   2. the helper is started with an argument ARRAY against a bare file name resolved under the
 *      app's own backend/native, never a shell string;
 *   3. a malformed argument throws before any process starts, so `packTool` answers with
 *      APP_TOOL_ARGUMENT_INVALID the way the pre-existing test/desktop-assist.test.ts pins.
 * A plan that returns a sentence (nothing to change, no such event) is still a successful call:
 * the owner reads the sentence and nothing was changed.
 */

/** The same seam test/desktop-assist.test.ts uses: a driver that only records. */
function harness() {
  const calls: { name: string; args: any }[] = [];
  const prefs = { get: (k: string) => (k === 'mac-control-enabled' ? 'true' : undefined), set: () => {} };
  const driver = {
    call: async (name: string, args: any) => {
      calls.push({ name, args });
      if (name === 'check_permissions') return { accessibility: true, screen_recording: true };
      return {};
    },
  };
  const control = new DesktopControl(prefs as any, driver as any, undefined as any, 'darwin', Date.now, (async () => {}) as any);
  return { control, calls, of: (name: string) => calls.filter(call => call.name === name) };
}

/** Where src/desktop-control.ts resolves `binary` from: the app's own backend/native. */
const HELPER = fileURLToPath(new URL('../../native/eventkit-helper', import.meta.url));
const HELPERS_BUILT = existsSync(HELPER);

const SAMPLES: Record<string, Record<string, string>> = {
  calendar_find_events: { query: 'standup', start: '2026-11-04', end: '2026-11-11' },
  calendar_read_event: { summary: 'Standup', start: '2026-11-04 09:00:00' },
  calendar_list_events: { days: '7' },
  calendar_create_event: { title: 'Call the plumber', start: '2026-11-04 17:00:00', end: '2026-11-04 17:30:00' },
  calendar_update_event: { summary: 'Standup', start: '2026-11-04 09:00:00', new_start: '2026-11-04 10:00:00' },
  calendar_delete_event: { summary: 'Standup', start: '2026-11-04 09:00:00', confirm: 'Standup' },
  reminders_list: {},
  reminders_open: { limit: '10' },
  reminders_read: { name: 'buy milk' },
  reminders_add: { title: 'buy milk', due: '2026-11-06 09:00:00' },
  reminders_complete: { name: 'buy milk', confirm: 'buy milk' },
  reminders_update: { name: 'buy milk', confirm: 'buy milk', due: '2026-11-06 09:00:00' },
  reminders_delete: { name: 'buy milk', confirm: 'buy milk' },
};

function planFor(tool: AppTool) {
  try {
    return tool.plan(SAMPLES[tool.name] ?? {});
  } catch {
    // A tool whose arguments are not in the sample table (or a guard that throws) is simply not
    // part of this check; the pack's own test covers its arguments.
    return undefined;
  }
}

test('a helper that is not in this build is refused in words, and no UI step runs', { skip: process.platform !== 'darwin' }, async () => {
  const h = harness();
  if (!HELPERS_BUILT) {
    await assert.rejects(
      h.control.packTool('brain:t', 'calendar_list_events', { days: '7' }),
      /^Error: APP_TOOL_HELPER_MISSING: calendar_list_events is not available on this Mac yet: the eventkit-helper helper is missing from this build\. Nothing was changed\.$/,
    );
    // The sentinel prefix is what brain-device turns into something the owner can read. It must
    // never reach them verbatim. NOTE: for the sentence itself to survive, deviceRefusal needs the
    // pass-through branch in the integrator diff (src/brain-device.ts); without it the mapper
    // falls back to its generic cause phrase, which is why this assertion checks the shape rather
    // than the words.
    const said = deviceRefusal(new Error('APP_TOOL_HELPER_MISSING: calendar_list_events is not available on this Mac yet: the eventkit-helper helper is missing from this build. Nothing was changed.'));
    assert.ok(!said.includes('APP_TOOL_HELPER_MISSING'), 'the sentinel prefix never reaches the owner');
    assert.match(said, /not available on this Mac yet|could not/i);
  } else {
    // Once the helper ships, the same call must still not fall through to typing steps; it either
    // answers or refuses for a reason this test does not need to pin (the owner's grant state).
    try {
      const out = await h.control.packTool('brain:t', 'calendar_list_events', { days: '7' });
      assert.equal(out.action, 'app_tool');
      assert.equal(out.window, null);
    } catch (error) {
      assert.match(String((error as Error).message), /^APP_TOOL_FAILED:|^APP_TOOL_HELPER_MISSING:|^AUTOMATION_PERMISSION_REQUIRED:|^APP_TOOL_ARGUMENT_INVALID:/);
    }
  }
  // The whole point: a helper tool never becomes a batch of clicks on the frontmost window.
  assert.equal(h.of('run_steps').length, 0);
  assert.equal(h.of('get_accessibility_tree').length, 0);
});

test('a malformed time throws before any process starts', { skip: process.platform !== 'darwin' }, async () => {
  const h = harness();
  await assert.rejects(
    h.control.packTool('brain:t', 'calendar_create_event', { title: 'Call the plumber', start: 'tomorrow', end: '2026-11-05 10:00:00' }),
    /^Error: APP_TOOL_ARGUMENT_INVALID: A date has to look like/,
  );
  await assert.rejects(
    h.control.packTool('brain:t', 'calendar_create_event', { title: 'Call the plumber', start: '2026-11-05 11:00:00', end: '2026-11-05 10:00:00' }),
    /^Error: APP_TOOL_ARGUMENT_INVALID: The end time has to be after the start time\.$/,
  );
  assert.equal(h.of('run_steps').length, 0);
});

test('a plan that returns a sentence is a successful call and carries no window', { skip: process.platform !== 'darwin' }, async () => {
  const h = harness();
  const out = await h.control.packTool('brain:t', 'calendar_update_event', { summary: 'Standup', start: '2026-11-04 09:00:00' });
  assert.equal(out.action, 'app_tool');
  assert.equal(out.tool, 'calendar_update_event');
  assert.equal(out.app, 'Calendar');
  assert.equal(out.ok, true);
  assert.equal(out.window, null);
  assert.match(out.output, /nothing to change/i);
  assert.equal(h.of('run_steps').length, 0);
});

/**
 * A helper's stdout is not trusted input.
 *
 * The parser a plan carries runs inside packTool's own try, so a formatter that throws would be
 * reported as "the tool did not run" plus whatever the throw said, which is neither true nor
 * readable. Every reply below is something a helper can genuinely print: an empty stdout when the
 * process is killed, an `Error:` line, a JSON value that is not the shape the command documents,
 * a null field where a string was expected, and a reply cut off mid-object.
 */
const HOSTILE_REPLIES: string[] = [
  '',
  '   \n  ',
  'not json at all',
  'Error: There is no event called "Standup" near that time.',
  'null',
  '[]',
  '{}',
  '0',
  'true',
  '"a string"',
  '{"events":null}',
  '{"events":[{}]}',
  '{"events":[{"id":null,"title":null,"startDate":"nonsense"}]}',
  '{"reminders":[{"id":1,"title":{},"dueDate":[]}]}',
  '{"lists":[1,2,3]}',
  '\u0000\u0001\u0002',
  '{"events":[{"title":"Standup","startDate":"2026-11-04T09:00:00Z","endDate":"bad","attendees":"none"}],"next":',
  'x'.repeat(100000),
];

test('a helper reply that cannot be read becomes a sentence, never a throw', () => {
  const formatted = allPackTools()
    .map(tool => ({ tool, plan: planFor(tool) }))
    .filter(entry => entry.plan?.kind === 'cli' && typeof entry.plan.format === 'function');
  assert.ok(formatted.length >= 10, `expected most helper tools to carry a parser, found ${formatted.length}`);
  for (const { tool, plan } of formatted) {
    const read = (plan as { kind: 'cli'; format: (raw: string) => string }).format;
    for (const reply of HOSTILE_REPLIES) {
      let out: unknown;
      assert.doesNotThrow(() => { out = read(reply); }, `${tool.name} must not throw on ${JSON.stringify(reply.slice(0, 40))}`);
      assert.equal(typeof out, 'string', `${tool.name} answers with a string`);
      assert.ok((out as string).length > 0, `${tool.name} answers with something readable`);
    }
  }
});

/**
 * The helper's own parser is the contract, so it is read rather than restated.
 *
 * A plan that asks for a subcommand the helper does not have, or a flag it does not allow, is an
 * exit-64 usage error at runtime and an honest refusal at best. This check reads the Swift switch
 * and fails here instead, so the two cannot drift apart silently. The list below covers both
 * places the source lives: the integrator moves it from src/app-tools/native into native/, and
 * this test must keep working across that move.
 */
const SWIFT_SOURCES = ['../../native/eventkit-helper.swift', '../../src/app-tools/native/eventkit-helper.swift']
  .map(relative => fileURLToPath(new URL(relative, import.meta.url)))
  .filter(existsSync);

/** Subcommand -> the flags it allows, plus the flags that take no value. */
function helperSurface(source: string) {
  // Each function body is bounded by its own column-zero closing brace. Without that the scan runs
  // on into the rest of the file and every later `case` is read as part of the first one: the
  // boolean set for "events" picked up the allowed flags of "events" itself, which is the very
  // valueless-flag bug the Swift file's own comment records as fixed.
  const body = (signature: string) => {
    const start = source.indexOf(signature);
    const end = source.indexOf('\n}\n', start);
    return source.slice(start, end === -1 ? undefined : end);
  };
  const commands = new Map<string, Set<string>>();
  for (const chunk of body('func execute(').split(/\n    case "/).slice(1)) {
    const name = chunk.slice(0, chunk.indexOf('"'));
    const allowed = /rejectUnknownFlags\(flags, allowed: \[([^\]]*)\]/.exec(chunk);
    if (!allowed) continue;
    commands.set(name, new Set([...allowed[1].matchAll(/"(--[a-z-]+)"/g)].map(match => match[1])));
  }
  const booleans = new Map<string, Set<string>>();
  for (const chunk of body('func booleanFlags(').split(/\n    case "/).slice(1)) {
    const name = chunk.slice(0, chunk.indexOf('"'));
    booleans.set(name, new Set([...chunk.matchAll(/"(--[a-z-]+)"/g)].map(match => match[1])));
  }
  return { commands, booleans };
}

test('every helper plan speaks a subcommand and flags the helper implements', { skip: !SWIFT_SOURCES.length }, () => {
  const surface = helperSurface(readFileSync(SWIFT_SOURCES[0], 'utf8'));
  assert.ok(surface.commands.size >= 10, `expected the helper's commands, found ${surface.commands.size}`);
  // The reader is pinned too, because a reader that quietly reads too much would make every check
  // below pass for the wrong reason. "events" allows four flags and has NO valueless flags; the
  // only command with a valueless flag besides --help is "reminders" (--completed) and "create"
  // (--all-day).
  assert.deepEqual([...surface.commands.get('events')!].sort(), ['--calendar', '--from', '--limit', '--to']);
  assert.deepEqual([...surface.booleans.get('reminders')!].sort(), ['--completed', '--help']);
  assert.equal(surface.booleans.get('events'), undefined, 'events has no valueless flag, so its --from value is never mistaken for a flag');
  assert.equal(surface.booleans.get('reminder-update'), undefined, 'reminder-update reads --completed as a value, not a switch');
  const cli = allPackTools().map(tool => ({ tool, plan: planFor(tool) })).filter(entry => entry.plan?.kind === 'cli');
  assert.ok(cli.length >= 12, `expected the helper-backed tools, found ${cli.length}`);
  for (const { tool, plan } of cli) {
    const { args } = plan as { kind: 'cli'; args: string[] };
    const command = args[0];
    const allowed = surface.commands.get(command);
    assert.ok(allowed, `${tool.name} asks for ${command}, which the helper implements`);
    const bare = surface.booleans.get(command) ?? new Set(['--help']);
    for (let index = 1; index < args.length; index += 1) {
      const flag = args[index];
      assert.ok(flag.startsWith('--'), `${tool.name} passes ${flag} as a flag`);
      assert.ok(allowed.has(flag) || flag === '--help', `${tool.name} passes ${flag}, which ${command} allows`);
      if (bare.has(flag)) continue;
      const value = args[index + 1];
      assert.ok(value !== undefined && !value.startsWith('--'), `${tool.name} gives ${flag} a value, not another flag`);
      index += 1;
    }
  }
});

test('every helper plan uses a bare file name and an argument array', () => {
  const cli = allPackTools().map(tool => ({ tool, plan: planFor(tool) })).filter(entry => entry.plan?.kind === 'cli');
  assert.ok(cli.length >= 6, `expected the helper-backed tools, found ${cli.length}`);
  for (const { tool, plan } of cli) {
    const built = plan as { kind: 'cli'; binary: string; args: string[] };
    assert.match(built.binary, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, `${tool.name} names its helper with a plain file name`);
    assert.ok(Array.isArray(built.args) && built.args.every(arg => typeof arg === 'string'), `${tool.name} passes an array of strings, never a shell line`);
    assert.ok(built.args.length > 0 && !built.args[0].startsWith('-'), `${tool.name} starts with a subcommand`);
  }
});