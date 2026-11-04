import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { PACKS, allPackTools, appleDate, appleDateAssign, asStr, packFor, toolByName } from '../src/app-tools/packs.js';
import { buildIndex, describeTools, selectTools, tokenize, toolText } from '../src/app-tools/retrieve.js';

const tools = allPackTools();

test('every pack tool is named, described and argued clearly enough to be chosen', () => {
  const seen = new Set<string>();
  for (const tool of tools) {
    assert.ok(!seen.has(tool.name), `${tool.name} is declared twice`);
    seen.add(tool.name);
    assert.match(tool.name, new RegExp(`^${tool.pack}_`), `${tool.name} is not prefixed with its pack`);
    assert.match(tool.name, /^[a-z]+(_[a-z]+)+$/, `${tool.name} is not app_prefixed_snake_case`);

    // The research is blunt: descriptions are the biggest single factor, and short ones lose.
    const sentences = tool.description.split(/\.\s+/).filter(Boolean);
    assert.ok(sentences.length >= 3, `${tool.name} needs at least three sentences, has ${sentences.length}`);
    assert.match(tool.description, /Use this when/, `${tool.name} does not say when to use it`);
    assert.match(tool.description, /does not|never|only/, `${tool.name} does not say what it will not do`);

    assert.ok(tool.examples.length >= 2, `${tool.name} needs at least two owner phrasings`);
    assert.ok(tool.keywords.length >= 4, `${tool.name} needs retrieval keywords`);
    for (const arg of tool.args) {
      assert.match(arg.name, /^[a-z][a-z0-9_]*$/, `${tool.name}.${arg.name} is not snake_case`);
      assert.ok(arg.description.length > 20, `${tool.name}.${arg.name} needs a real description`);
    }
    assert.ok(describeTools([tool]).startsWith(`- ${tool.name}`));
  }
  assert.equal(seen.size, tools.length);
});

test('every typing step says which control it types into', () => {
  // Measured 2026-11-03: a tool whose type_text carried no target typed into the open note
  // body instead of the search field it was written for, and the note's own text had to be put
  // back by hand. An untargeted keystroke goes wherever focus happens to be, which is never
  // good enough for a reviewed tool.
  for (const tool of tools) {
    // A phrase with fewer than two meaningful words ("where is that note" reduces to just
    // "note") would switch the tool off for every request that mentions the app at all, so the
    // retrieval layer ignores those. This asserts nobody adds one believing it is a guard.
    for (const phrase of tool.notFor ?? []) {
      assert.ok(tokenize(phrase).length >= 2, `${tool.name} notFor "${phrase}" has one meaningful word and never applies`);
    }
    let plan;
    // A tool may refuse a dummy argument (the calendar tools reject a date that is not a real
    // one). That is the tool doing its job, and it is not what this test is looking at.
    try { plan = tool.plan(Object.fromEntries(tool.args.map(arg => [arg.name, 'x']))); } catch { continue; }
    if (plan.kind !== 'steps') continue;
    for (const step of plan.steps) {
      const typed = (step as any).type_text;
      if (!typed) continue;
      assert.ok(typed.role || typed.name, `${tool.name} types without naming a control: ${JSON.stringify(step)}`);
    }
  }
});

test('creating a note goes through Notes itself, never through keystrokes', () => {
  const plan = toolByName('notes_create_note')!.plan({ body: 'tomorrow meeting at 10pm' });
  // Live on 2026-11-03 the keystroke path typed into a note that was already open. Creating through
  // Apple Notes returns the note's name, so the tool can say what it made and nothing can be typed.
  assert.equal(plan.kind, 'osascript');
  const script = plan.kind === 'osascript' ? plan.script : '';
  assert.match(script, /make new note with properties \{body:theText\}/);
  assert.match(script, /set name of fresh to "tomorrow meeting at 10pm"/);
  assert.match(script, /Wrote the note /);
  assert.doesNotMatch(script, /type_text|keystroke|click|Search/);
});

test('apple dates are refused unless they are the one shape AppleScript accepts', () => {
  assert.equal(appleDate('2026-11-04 09:00:00'), '2026-11-04 09:00:00');
  for (const bad of ['tomorrow at 5', '2026-11-04', '04/11/2026 09:00', '', '2026-11-04 25:00:00']) {
    assert.throws(() => appleDate(bad), /has to look like/);
  }
  // The date is built from its parts, because a `date "..."` literal is coerced with the Mac's
  // own date settings and would fail on a machine set to another format.
  const assign = appleDateAssign('d1', '2026-11-04 17:30:00');
  assert.equal(assign, 'set d1 to current date\nset day of d1 to 1\nset year of d1 to 2026\nset month of d1 to 11\nset day of d1 to 4\nset time of d1 to 63000\n');
  const plans = allPackTools().map(tool => JSON.stringify(tool.plan({ title: 'x', start: '2026-11-04 17:00:00', end: '2026-11-04 17:30:00', query: 'x', days: '7' }))).join(' ');
  assert.ok(!/date \"/.test(plans), 'no plan may contain a locale-parsed date literal');
  assert.equal(asStr('he said "hi"\\'), '"he said \\"hi\\"\\\\"');
});

test('the calendar tools go through the bundled EventKit helper and read only', () => {
  // Calendar and Reminders moved off AppleScript onto a bundled Swift helper that talks to
  // EventKit directly. The plan is a command line, never a shell string, so the arguments are
  // discrete and a value with a space in it cannot become a second command.
  const create = toolByName('calendar_create_event')!.plan({
    title: 'Meeting with the team',
    start: '2026-11-04 17:00:00',
    end: '2026-11-04 17:30:00',
    calendar: 'Home',
  });
  assert.equal(create.kind, 'cli');
  const argv = create.kind === 'cli' ? create.args : [];
  assert.equal(create.kind === 'cli' ? create.binary : '', 'eventkit-helper');
  assert.deepEqual(argv.slice(0, 5), ['create', '--title', 'Meeting with the team', '--start', '2026-11-04 17:00:00']);
  assert.ok(argv.includes('--end') && argv.includes('2026-11-04 17:30:00'), 'the end time must be passed');
  assert.ok(argv.includes('--calendar') && argv.includes('Home'), 'the chosen calendar must be passed');
  assert.ok(!argv.some(word => /send|invite|mail|attendee/i.test(word)), 'creating an event must not invite anyone');

  const list = toolByName('calendar_list_events')!.plan({ days: '1' });
  assert.equal(list.kind, 'cli');
  const listArgs = list.kind === 'cli' ? list.args : [];
  assert.equal(listArgs[0], 'events', 'listing events is the helper read command');
  assert.ok(!listArgs.some(word => /^(?:create|update|delete|complete|reminder-create|reminder-update|reminder-delete)$/.test(word)), 'listing events must not change anything');
  const window = (args: string[]) => {
    const from = args[args.indexOf('--from') + 1];
    const to = args[args.indexOf('--to') + 1];
    return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
  };
  assert.equal(window(listArgs), 1);
  // A wild number cannot turn a read into a storm.
  const capped = toolByName('calendar_list_events')!.plan({ days: '9999' });
  assert.equal(capped.kind === 'cli' ? window(capped.args) : -1, 60);
});

const choose = (text: string, app?: string) => selectTools(text, { app, index: index }).map(match => match.tool.name);
const index = buildIndex(tools);

test('the phrases the owner actually uses pick the right tool', () => {
  assert.equal(choose('write a note that the roof is leaking')[0], 'notes_create_note');
  assert.equal(choose('Could you write a note that the roof is leaking')[0], 'notes_create_note');
  assert.equal(choose('jot this in notes: call the plumber on monday')[0], 'notes_create_note');
  // Asking to find a note must never offer the tool that writes one: the words overlap and a
  // wrong write is worse than a wrong answer. `notes_find` is read-only AppleScript.
  assert.equal(choose('find my note about the roof')[0], 'notes_find');
  assert.equal(choose('find my note about the roof', 'Notes')[0], 'notes_find');
  assert.equal(choose('put a meeting on my calendar tomorrow at 5')[0], 'calendar_create_event');
  // The owner is in Calendar, so the pack is in play even when they do not name the app:
  // that is the "load the tools of the app I am working in" rule.
  assert.equal(choose('add a meeting with ashitosh tomorrow at 5pm', 'Calendar')[0], 'calendar_create_event');
  assert.equal(choose('write a note that the roof is leaking', 'Notes')[0], 'notes_create_note');
  assert.equal(choose('what is coming up this week', 'Calendar')[0], 'calendar_list_events');
  assert.equal(choose('am I free tomorrow', 'Calendar')[0], 'calendar_list_events');
});

test('coding work does not pick up a Mac tool', () => {
  assert.deepEqual(choose('fix the failing unit test'), []);
  assert.deepEqual(choose('add a retry to the sync loop'), []);
  assert.deepEqual(choose('add a checks column to task_contracts'), []);
  assert.deepEqual(choose('where is the router contract code'), []);
  // The app in front is not enough on its own: the words have to mean something too.
  assert.deepEqual(choose('add a retry to the sync loop', 'Cursor'), []);
});

test('an app that is named but not acted on does not become a tool call', () => {
  const indexless = buildIndex(tools);
  const bare = selectTools('notes', { index: indexless });
  assert.deepEqual(bare, [], 'a bare app name is not a request to do anything');
  assert.ok(tokenize('Notes, and the notes!').every(word => word === 'note'));
  assert.match(toolText(toolByName('notes_create_note')!), /write a note that the roof is leaking/);
});

test('the pack list tells the owner what is installed', () => {
  assert.deepEqual(PACKS.map(pack => pack.id), ['notes', 'calendar', 'reminders', 'mail', 'finder', 'safari', 'music', 'messages']);
  assert.equal(packFor('notes')?.app, 'Notes');
  assert.equal(packFor('Calendar')?.id, 'calendar');
  assert.equal(packFor('Reminders')?.app, 'Reminders');
  assert.equal(packFor('Cursor'), undefined);
  assert.ok(PACKS.every(pack => pack.summary.length > 20));
});

test('a chosen tool can always be described without its arguments', () => {
  const lines = describeTools(tools);
  for (const tool of tools) assert.ok(lines.includes(tool.name), `${tool.name} is missing from the description list`);
  assert.equal(lines.split('\n').length, tools.length);
});
test('the owner opening verb decides read against write', () => {
  // "save this for later" and "find my note" share nearly every other word, and "what did I
  // write" contains the write verb but is a read. The first verb wins.
  // The paraphrase only becomes a Mac request because the owner is in Notes: with no app in
  // front the word "save" alone is not enough to put a writing tool in play.
  assert.equal(choose('save this for later: invoice 442', 'Notes')[0], 'notes_create_note');
  assert.equal(choose('remind me to buy milk later', 'Notes').includes('notes_find'), false);
  assert.equal(choose('search my notes for the invoice')[0], 'notes_find');
  assert.equal(choose('where did i write about the roof')[0], 'notes_find');
  assert.equal(choose('is anything booked on Friday', 'Calendar')[0], 'calendar_list_events');
  assert.equal(choose('what does my Friday look like', 'Calendar')[0], 'calendar_list_events');
  // A sentence that only contains a copula is left undecided rather than forced into a mode.
  assert.equal(choose('note that the roof is leaking')[0], 'notes_create_note');
});

test('a tool that only reads never carries a step that changes the Mac', () => {
  const WRITING_HELPER_COMMANDS = new Set(['create', 'update', 'delete', 'complete', 'reminder-create', 'reminder-update', 'reminder-delete']);
  for (const tool of tools.filter(candidate => !candidate.writes)) {
    let plan;
    try {
      plan = tool.plan(Object.fromEntries(tool.args.map(arg => [arg.name, 'x'])));
    } catch (error) {
      // Argument values here are deliberately junk, so a read tool is allowed to answer with an
      // argument error instead of a plan: a plan that was never built cannot have changed
      // anything. Anything else it throws is a real failure.
      assert.match(String(error), /A date has to look like|whole number|The end of the window/, `${tool.name} threw something that is not an argument sentence`);
      continue;
    }
    if (plan.kind === 'cli') {
      // A cli plan is a helper command line: the helper's own verb is what would change
      // something, so a read tool must never be handed a writing subcommand.
      assert.match(plan.binary, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, `${tool.name} names a helper that is not a plain file`);
      assert.ok(!WRITING_HELPER_COMMANDS.has(String(plan.args[0])), `${tool.name} reads with a writing helper command`);
      continue;
    }
    assert.equal(plan.kind, 'osascript', `${tool.name} reads with UI steps, which can type`);
    const script = plan.kind === 'osascript' ? plan.script : '';
    assert.doesNotMatch(script, /\bmake new\b|\bdelete\b|\bduplicate\b|\bmove\b|\bset (?:name|body|value) of\b/i, `${tool.name} mutates something`);
    assert.match(script, /return /, `${tool.name} never returns what it read`);
  }
  // The one read tool that goes through Notes says so in its own script.
  const find = toolByName('notes_find')!.plan({ query: 'roof' });
  assert.match(find.kind === 'osascript' ? find.script : '', /tell application "Notes"/);
  assert.match(find.kind === 'osascript' ? find.script : '', /contains q/);
});

/**
 * The AppleScript tools must at least compile against the app's own dictionary. This needs no
 * Automation grant (`osacompile` only reads the .sdef in the app), so it runs everywhere and
 * catches a script that would fail the first time the owner asked for it. Notes, Calendar and
 * Reminders carry osascript plans; the steps plan is covered by the driver tests.
 */
const SCRIPT_SAMPLES: Record<string, Record<string, string>> = {
  notes_find: { query: 'the roof' },
  notes_read: { name: 'Roof', chars: '4000' },
  notes_recent: { limit: '5' },
  notes_append: { name: 'Roof', text: 'the plumber comes monday' },
  notes_update: { name: 'Roof', text: 'the leak is fixed' },
  notes_delete: { name: 'Roof', confirm: 'Roof' },
  calendar_create_event: { title: 'Call the plumber', start: '2026-11-05 17:00:00', end: '2026-11-05 17:30:00' },
  calendar_list_events: { days: '7' },
  calendar_find_events: { query: 'standup', start: '2026-11-04', end: '2026-11-11' },
  calendar_read_event: { summary: 'Standup', start: '2026-11-04 09:00:00' },
  calendar_update_event: { summary: 'Standup', start: '2026-11-04 09:00:00', new_start: '2026-11-04 10:00:00' },
  calendar_delete_event: { summary: 'Standup', start: '2026-11-04 09:00:00', confirm: 'Standup' },
  reminders_add: { title: 'Buy oat milk', due: '2026-11-06 09:00:00' },
  reminders_list: {},
  reminders_open: { limit: '10' },
  reminders_read: { name: 'buy milk' },
  reminders_complete: { name: 'buy milk', confirm: 'buy milk' },
  reminders_update: { name: 'buy milk', confirm: 'buy milk', due: '2026-11-06 09:00:00' },
  reminders_delete: { name: 'buy milk', confirm: 'buy milk' },
};

test('every AppleScript tool compiles against its app dictionary', { skip: process.platform !== 'darwin' ? 'macOS only' : false }, () => {
  const osacompile = existsSync('/usr/bin/osacompile');
  if (!osacompile) return;
  const dir = mkdtempSync(join(tmpdir(), 'ffd-osacompile-'));
  try {
    for (const tool of allPackTools()) {
      const planned = tool.plan(SCRIPT_SAMPLES[tool.name] ?? {});
      if (planned.kind !== 'osascript') continue;
      const file = join(dir, `${tool.name}.applescript`);
      writeFileSync(file, planned.script, 'utf8');
      const result = spawnSync('/usr/bin/osacompile', ['-o', join(dir, `${tool.name}.scpt`), file], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${tool.name} does not compile: ${result.stderr ?? ''}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Every writing plan changes one thing at a time, and an AppleScript plan that changes something
 * that already exists reads it first.
 *
 * This replaced an earlier rule that the reviewed set may only create ("a writing AppleScript
 * plan only creates"). The owner asked to add to a note, replace its text and delete one, so
 * create-only is no longer true and the old assertion failed the moment the notes pack was
 * registered. The invariant that still has to hold is narrower and more important: one sentence
 * never changes more than one of the owner's things, and a plan that could drop something refuses
 * after the read instead of attempting the write. Each pack's own test pins its exact refusal
 * sentences; this one pins the shape of every writing plan in the registry.
 */
test('a writing plan changes one thing at a time and reads it before writing', () => {
  const WRITING_HELPER_COMMANDS = new Set(['create', 'update', 'delete', 'complete', 'reminder-create', 'reminder-update', 'reminder-delete']);
  for (const tool of allPackTools()) {
    if (!tool.writes) continue;
    const planned = tool.plan(SCRIPT_SAMPLES[tool.name] ?? {});
    if (planned.kind === 'cli') {
      // The EventKit helper resolves its target by title (and, for events, by time), so the
      // match is the read: it changes one thing or refuses. There is no way to ask it for a
      // range, which is the property this asserts.
      assert.match(planned.binary, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, `${tool.name} names a helper that is not a plain file`);
      assert.ok(WRITING_HELPER_COMMANDS.has(String(planned.args[0])), `${tool.name} does not name a writing helper command`);
      assert.ok(!planned.args.includes('--all') && !planned.args.includes('--span'), `${tool.name} could change more than one thing`);
      if (/delete|complete/.test(String(planned.args[0]))) {
        const at = planned.args.indexOf('--confirm');
        assert.ok(at > 0, `${tool.name} deletes or completes without the owner's confirmation`);
        assert.ok(planned.args[at + 1] && planned.args[at + 1] !== '--confirm', `${tool.name} confirms nothing`);
      }
      continue;
    }
    if (planned.kind !== 'osascript') continue;
    const script = planned.script;
    // A tool that refused a dummy sample is doing its job; there is no write to check.
    if (/^return "/.test(script)) continue;
    assert.doesNotMatch(script, /\b(?:delete|remove|complete|duplicate|move|rename)\s+(?:every|all|each)\b/i, `${tool.name} changes more than one thing`);
    assert.doesNotMatch(script, /\b(?:delete|clear|remove)\s+(?:the\s+)?(?:folder|container|group)\b/i, `${tool.name} deletes a container`);
    assert.doesNotMatch(script, /\brename\b/i, `${tool.name} renames something the owner already has`);
    // A plan that only creates a new thing has nothing to read first.
    if (/\bmake new /.test(script)) continue;
    // Changing something that exists: resolve exactly one item, read it, and only then write.
    assert.match(script, /whose name is/, `${tool.name} changes something without naming exactly one`);
    assert.match(script, /(?:body|plaintext) of n/, `${tool.name} writes without reading the thing first`);
  }
});

/**
 * A person's name must never be part of a tool's retrieval text. The calendar tool used to carry
 * "add a meeting with ashitosh tomorrow at 5pm" and "Meeting with Ashitosh", and that made a note
 * request about the same person ("don't let me forget to call Ashitosh") match the calendar tool
 * ahead of the note tool. The live sentence still lives in the golden set, where it belongs.
 */
test('a name in a request does not pull in another app tool', () => {
  const retrievalText = allPackTools().map(tool => JSON.stringify([tool.description, tool.examples, tool.keywords, tool.args])).join(' ').toLowerCase();
  assert.ok(!retrievalText.includes('ashitosh'), 'a person\'s name is not tool vocabulary');
  assert.deepEqual(choose("don't let me forget to call Ashitosh", 'Notes'), ['notes_create_note']);
  assert.equal(choose('add a meeting with ashitosh tomorrow at 5pm', 'Calendar')[0], 'calendar_create_event');
  // A plan stated as a fact is still a calendar request, which is why the create tool's
  // description says so rather than relying on a name to match.
  assert.equal(choose('I am seeing Ashitosh on Friday', 'Calendar')[0], 'calendar_create_event');
});
