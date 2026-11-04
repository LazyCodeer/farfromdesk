import assert from 'node:assert/strict';
import { test } from 'node:test';
import CALENDAR_PACK from '../../src/app-tools/packs/calendar.js';
import { allPackTools } from '../../src/app-tools/packs.js';
import { buildIndex, selectTools, tokenize } from '../../src/app-tools/retrieve.js';
import { EVENTKIT_HELPER } from '../../src/app-tools/adapters/eventkit.js';

/**
 * The Calendar pack tests.
 *
 * The pack no longer writes AppleScript: every tool plans a `kind: 'cli'` call to the bundled
 * EventKit helper, and the JSON the helper prints is turned into lines by the adapter. This file
 * pins the four things that can silently rot when a pack moves engines:
 *
 *  1. the exact argument vector each tool sends (T3), because that vector is the engine contract;
 *  2. the JSON-to-lines formatting, because the owner reads those lines;
 *  3. every bad argument refusing in words, with no helper started;
 *  4. the retrieval text still choosing the right tool for the owner's own phrasings.
 *
 * At the time this test was written the four moved tools still lived inline in `packs.ts`, so the
 * index is built from the registry with this pack's copies laid over the top. That makes the test
 * pass while the migration is in flight and also after the inline copies are deleted.
 */
const byName = new Map(allPackTools().map(tool => [tool.name, tool]));
for (const tool of CALENDAR_PACK.tools) byName.set(tool.name, tool);
const tools = [...byName.values()];
const index = buildIndex(tools);
const choose = (text: string, app?: string) => selectTools(text, { app, index }).map(match => match.tool.name);
const toolFrom = (name: string) => tools.find(tool => tool.name === name);

/** The six tools this pack must declare, in order, and whether each one changes something. */
const EXPECTED = [
  'calendar_find_events',
  'calendar_read_event',
  'calendar_list_events',
  'calendar_create_event',
  'calendar_update_event',
  'calendar_delete_event',
];

/** A valid sample for every tool, so a plan can be built without a refusal. */
const samples: Record<string, Record<string, string>> = {
  calendar_find_events: { query: 'dentist', start: '2026-11-04', end: '2026-11-11' },
  calendar_read_event: { summary: 'Standup', start: '2026-11-04 09:00:00' },
  calendar_list_events: { days: '7' },
  calendar_create_event: { title: 'Dentist', start: '2026-11-04 09:00:00', end: '2026-11-04 10:00:00', calendar: 'Work' },
  calendar_update_event: { summary: 'Standup', start: '2026-11-04 09:00:00', new_start: '2026-11-04 10:00:00' },
  calendar_delete_event: { summary: 'Standup', start: '2026-11-04 09:00:00', confirm: 'Standup' },
};

const planOf = (name: string, args: Record<string, string>) => {
  const tool = toolFrom(name);
  assert.ok(tool, `${name} is not in the calendar pack or the registry`);
  return tool.plan(args);
};

/** A plan that must be a helper call; returns the narrowed plan so `.args`/`.format` are usable. */
const cliPlan = (name: string, args: Record<string, string>) => {
  const planned = planOf(name, args);
  assert.equal(planned.kind, 'cli', `${name} must plan an EventKit helper call`);
  if (planned.kind !== 'cli') throw new Error(`${name} did not plan a helper call`);
  assert.equal(planned.binary, EVENTKIT_HELPER, `${name} must go through ${EVENTKIT_HELPER}`);
  return planned;
};

/** The local day `offset` days from today, mirroring the pack's own window arithmetic. */
function localDay(offset = 0): string {
  const day = new Date();
  day.setDate(day.getDate() + offset);
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

test('the calendar pack declares its six tools, once each, and argues them well enough to be chosen', () => {
  assert.deepEqual(CALENDAR_PACK.tools.map(tool => tool.name), EXPECTED);
  const seen = new Set<string>();
  for (const tool of CALENDAR_PACK.tools) {
    assert.ok(!seen.has(tool.name), `${tool.name} is declared twice in the pack`);
    seen.add(tool.name);
    assert.match(tool.name, /^calendar_[a-z]+(_[a-z]+)*$/, `${tool.name} is not calendar_prefixed_snake_case`);
    assert.equal(tool.pack, 'calendar');
    assert.equal(tool.app, 'Calendar');
    assert.equal(tool.bundleId, 'com.apple.iCal');

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
    for (const phrase of tool.notFor ?? []) {
      assert.ok(tokenize(phrase).length >= 2, `${tool.name} notFor "${phrase}" has fewer than two meaningful words`);
    }
  }
  assert.equal(CALENDAR_PACK.id, 'calendar');
  assert.ok(CALENDAR_PACK.summary.length > 20);
  const writes = Object.fromEntries(CALENDAR_PACK.tools.map(tool => [tool.name, tool.writes]));
  assert.deepEqual(writes, {
    calendar_find_events: false,
    calendar_read_event: false,
    calendar_list_events: false,
    calendar_create_event: true,
    calendar_update_event: true,
    calendar_delete_event: true,
  });
});

test('every calendar tool is registered exactly once, including the moved ones', () => {
  for (const name of EXPECTED) {
    assert.equal(tools.filter(tool => tool.name === name).length, 1, `${name} is not registered exactly once`);
  }
  assert.equal(byName.get('calendar_find_events')?.name, 'calendar_find_events');
});

test('the owner phrasings for the calendar tools pick the right tool', () => {
  assert.equal(choose('find the meeting with the team')[0], 'calendar_find_events');
  assert.equal(choose('search my calendar for the dentist')[0], 'calendar_find_events');
  // The date words are enough to reach the windowed search, the pack's first-declared read.
  assert.equal(choose('what is on my calendar on friday')[0], 'calendar_find_events');
  assert.equal(choose('what is on my calendar today')[0], 'calendar_list_events');
  assert.equal(choose('what is coming up this week')[0], 'calendar_list_events');
  assert.equal(choose('am I free tomorrow', 'Calendar')[0], 'calendar_list_events');
  assert.equal(choose('read the details of the standup')[0], 'calendar_read_event');
  assert.equal(choose('add a meeting with the team tomorrow at 5pm')[0], 'calendar_create_event');
  assert.equal(choose('schedule a call at 9 tomorrow morning')[0], 'calendar_create_event');
  assert.equal(choose('move my dentist appointment to 6pm')[0], 'calendar_update_event');
  assert.equal(choose('delete the event called standup confirm standup')[0], 'calendar_delete_event');
});

test('the calendar tools are not selected for coding work', () => {
  assert.deepEqual(choose('write the failing test'), []);
  assert.deepEqual(choose('add a retry to the sync loop'), []);
  assert.deepEqual(choose('where is the router contract code'), []);
  assert.deepEqual(choose('create a new session for this'), []);
});

test('each calendar tool sends the exact helper argument vector', () => {
  assert.deepEqual(cliPlan('calendar_find_events', samples.calendar_find_events).args, [
    'events', '--from', '2026-11-04', '--to', '2026-11-11', '--limit', '300',
  ]);
  assert.deepEqual(cliPlan('calendar_read_event', samples.calendar_read_event).args, [
    'event-by-title', '--title', 'Standup', '--start', '2026-11-04 09:00:00',
  ]);
  assert.deepEqual(cliPlan('calendar_list_events', samples.calendar_list_events).args, [
    'events', '--from', localDay(0), '--to', localDay(7), '--limit', '300',
  ]);
  assert.deepEqual(cliPlan('calendar_create_event', samples.calendar_create_event).args, [
    'create', '--title', 'Dentist', '--start', '2026-11-04 09:00:00', '--end', '2026-11-04 10:00:00', '--calendar', 'Work',
  ]);
  assert.deepEqual(cliPlan('calendar_update_event', samples.calendar_update_event).args, [
    'update', '--title', 'Standup', '--start', '2026-11-04 09:00:00', '--new-start', '2026-11-04 10:00:00',
  ]);
  assert.deepEqual(cliPlan('calendar_delete_event', samples.calendar_delete_event).args, [
    'delete', '--title', 'Standup', '--start', '2026-11-04 09:00:00', '--confirm', 'Standup',
  ]);
});

test('the list reads ask for enough characters', () => {
  assert.ok((cliPlan('calendar_find_events', samples.calendar_find_events).outputChars ?? 0) >= 8000);
  assert.ok((cliPlan('calendar_list_events', samples.calendar_list_events).outputChars ?? 0) >= 8000);
});

test('every calendar tool formats the helper JSON into lines with the title, calendar, time and id', () => {
  const event = '{"id":"E1","title":"Dentist","calendar":"Work","startDate":"2026-11-04T09:00:00","endDate":"2026-11-04T10:00:00","notes":"bring the x-ray"}';

  const findFormat = cliPlan('calendar_find_events', samples.calendar_find_events).format;
  assert.ok(findFormat, 'calendar_find_events must carry a format');
  const found = findFormat(`{"events":[${event}]}`);
  assert.match(found, /Dentist/);
  assert.match(found, /Work/);
  assert.match(found, /2026-11-04 09:00:00/);
  assert.match(found, /\[id E1\]/);

  const readFormat = cliPlan('calendar_read_event', samples.calendar_read_event).format;
  assert.ok(readFormat, 'calendar_read_event must carry a format');
  const read = readFormat(event);
  assert.match(read, /Dentist/);
  assert.match(read, /Work/);
  assert.match(read, /2026-11-04 09:00:00/);
  assert.match(read, /\[id E1\]/);
  // Reading one event is the reason notes and attendees are in the answer at all.
  assert.match(read, /Notes: bring the x-ray/);

  const listFormat = cliPlan('calendar_list_events', samples.calendar_list_events).format;
  assert.ok(listFormat, 'calendar_list_events must carry a format');
  const listed = listFormat(`{"events":[${event}]}`);
  assert.match(listed, /Dentist/);
  assert.match(listed, /Work/);
  assert.match(listed, /2026-11-04 09:00:00/);
  assert.match(listed, /\[id E1\]/);

  const writeEvent = '{"id":"E9","title":"Standup","calendar":"Work","startDate":"2026-11-04T10:00:00","endDate":"2026-11-04T11:00:00"}';
  for (const name of ['calendar_create_event', 'calendar_update_event', 'calendar_delete_event']) {
    const format = cliPlan(name, samples[name]).format;
    assert.ok(format, `${name} must carry a format`);
    const line = format(writeEvent);
    assert.match(line, /Standup/, `${name} lost the title`);
    assert.match(line, /Work/, `${name} lost the calendar`);
    assert.match(line, /2026-11-04 10:00:00/, `${name} lost the time`);
    assert.match(line, /\[id E9\]/, `${name} lost the id`);
  }
});

test('every calendar tool refuses a bad or missing argument in words, and never starts the helper', () => {
  // A missing or ambiguous thing, a confirm mismatch and an empty change are answers about the
  // data: the tool returns its own sentence and the helper is never started.
  const refusals: [string, Record<string, string>, RegExp][] = [
    ['calendar_read_event', {}, /exact event title/],
    ['calendar_create_event', {}, /I need the title/],
    ['calendar_update_event', {}, /exact event title/],
    ['calendar_update_event', { summary: 'Standup', start: '2026-11-04 09:00:00' }, /nothing to change/],
    ['calendar_delete_event', { summary: 'Standup', start: '2026-11-04 09:00:00' }, /confirm argument to say exactly/],
    ['calendar_delete_event', { summary: 'Standup', start: '2026-11-04 09:00:00', confirm: 'standup' }, /confirm argument to say exactly/],
  ];
  for (const [name, args, message] of refusals) {
    const planned = planOf(name, args);
    assert.equal(planned.kind, 'osascript', `${name} should refuse with a sentence`);
    const script = planned.kind === 'osascript' ? planned.script : '';
    assert.match(script, message, `${name} with ${JSON.stringify(args)} did not refuse in words`);
    // A refusal is a sentence, never a command line: nothing names the helper.
    assert.doesNotMatch(script, /eventkit-helper/, `${name} refusal would start the helper`);
  }
});

test('a malformed time is an argument error, not a sentence from the helper', () => {
  // test/desktop-assist.test.ts pins this for calendar_create_event: packTool must report
  // APP_TOOL_ARGUMENT_INVALID and neither the helper nor osascript may be started.
  const bad: [string, Record<string, string>, RegExp][] = [
    ['calendar_find_events', { start: 'next friday' }, /A date has to look like/],
    ['calendar_read_event', { summary: 'Standup', start: 'soon' }, /A date has to look like/],
    ['calendar_list_events', { days: 'lots' }, /whole number/],
    ['calendar_create_event', { title: 'Standup', start: 'tomorrow' }, /A date has to look like/],
    ['calendar_create_event', { title: 'Standup', start: '2026-11-04 10:00:00', end: '2026-11-04 09:00:00' }, /end time has to be after the start/],
    ['calendar_update_event', { summary: 'Standup', start: 'soon', new_start: '2026-11-04 10:00:00' }, /A date has to look like/],
    ['calendar_update_event', { summary: 'Standup', start: '2026-11-04 09:00:00', new_start: 'later' }, /A date has to look like/],
    ['calendar_delete_event', { summary: 'Standup', start: 'sometime', confirm: 'Standup' }, /A date has to look like/],
  ];
  for (const [name, args, message] of bad) {
    assert.throws(() => planOf(name, args), message, `${name} with ${JSON.stringify(args)} did not throw`);
  }
});

test('the calendar guardrails hold: no bulk delete, and the delete repeats the exact title', () => {
  for (const tool of CALENDAR_PACK.tools) {
    const planned = tool.plan(samples[tool.name] ?? {});
    const text = planned.kind === 'cli' ? [planned.binary, ...planned.args].join(' ') : planned.kind === 'osascript' ? planned.script : '';
    assert.doesNotMatch(text, /\b(?:delete|remove|complete)\s+(?:every|all|each)\b/i, `${tool.name} can act in bulk`);
  }
  const removed = cliPlan('calendar_delete_event', samples.calendar_delete_event);
  assert.ok(removed.args.includes('--confirm'), 'a delete must pass --confirm');
  assert.ok(removed.args.includes('Standup'));
  assert.ok(!removed.args.includes('*'));
});