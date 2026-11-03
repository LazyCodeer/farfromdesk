import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { PACKS, allPackTools, appleDate, asStr, packFor, toolByName } from '../src/app-tools/packs.js';
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

test('creating a note never types into the search field', () => {
  const plan = toolByName('notes_create_note')!.plan({ body: 'tomorrow meeting at 10pm' });
  assert.equal(plan.kind, 'steps');
  const steps = plan.kind === 'steps' ? plan.steps : [];
  assert.deepEqual(steps[0], { press_key: { key: 'escape' } });
  // A name-only click on "New Note" is refused live because it also names a menu item.
  assert.deepEqual(steps[1], { click: { role: 'AXButton', name: 'New Note' } });
  assert.deepEqual(steps[2], { type_text: { role: 'AXTextArea', text: 'tomorrow meeting at 10pm' } });
  assert.ok(!JSON.stringify(steps).includes('Search'));
});

test('apple dates are refused unless they are the one shape AppleScript accepts', () => {
  assert.equal(appleDate('2026-11-04 09:00:00'), 'date "2026-11-04 09:00:00"');
  for (const bad of ['tomorrow at 5', '2026-11-04', '04/11/2026 09:00', '']) {
    assert.throws(() => appleDate(bad), /has to look like/);
  }
  assert.equal(asStr('he said "hi"\\'), '"he said \\"hi\\"\\\\"');
});

test('the calendar tools build a script that touches one calendar and reads only', () => {
  const create = toolByName('calendar_create_event')!.plan({
    title: 'Meeting with Ashitosh',
    start: '2026-11-04 17:00:00',
    end: '2026-11-04 17:30:00',
    calendar: 'Home',
  });
  assert.equal(create.kind, 'osascript');
  const script = create.kind === 'osascript' ? create.script : '';
  assert.match(script, /tell application "Calendar"/);
  assert.match(script, /tell calendar "Home"/);
  assert.match(script, /make new event at end of events with properties/);
  assert.ok(!/send|mail|invite/i.test(script), 'creating an event must not invite anyone');

  const list = toolByName('calendar_list_events')!.plan({ days: '1' });
  const listScript = list.kind === 'osascript' ? list.script : '';
  assert.match(listScript, /1 \* days/);
  assert.ok(!/make new|delete/.test(listScript), 'listing events must not change anything');
  // A wild number cannot turn a read into a storm.
  const capped = toolByName('calendar_list_events')!.plan({ days: '9999' });
  assert.match(capped.kind === 'osascript' ? capped.script : '', /60 \* days/);
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
  assert.deepEqual(PACKS.map(pack => pack.id), ['notes', 'calendar']);
  assert.equal(packFor('notes')?.app, 'Notes');
  assert.equal(packFor('Calendar')?.id, 'calendar');
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
  for (const tool of tools.filter(candidate => !candidate.writes)) {
    const plan = tool.plan(Object.fromEntries(tool.args.map(arg => [arg.name, 'x'])));
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
 * catches a script that would fail the first time the owner asked for it. Calendar and Notes
 * are the two packs with osascript plans; the steps plans are covered by the driver tests.
 */
const SCRIPT_SAMPLES: Record<string, Record<string, string>> = {
  notes_find: { query: 'the roof' },
  calendar_create_event: { title: 'Call Ashitosh', start: '2026-11-05 17:00:00', end: '2026-11-05 17:30:00' },
  calendar_list_events: { days: '7' },
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
