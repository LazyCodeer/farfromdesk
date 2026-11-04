import assert from 'node:assert/strict';
import { test } from 'node:test';
import REMINDERS_PACK from '../../src/app-tools/packs/reminders.js';
import { allPackTools } from '../../src/app-tools/packs.js';
import { buildIndex, selectTools, tokenize } from '../../src/app-tools/retrieve.js';
import { EVENTKIT_HELPER } from '../../src/app-tools/adapters/eventkit.js';

/**
 * The Reminders pack tests.
 *
 * The pack no longer writes AppleScript: every tool plans a `kind: 'cli'` call to the bundled
 * EventKit helper, and the JSON the helper prints is turned into lines by the adapter. This file
 * pins the four things that can silently rot when a pack moves engines:
 *
 *  1. the exact argument vector each tool sends (T3), because that vector is the engine contract;
 *  2. the JSON-to-lines formatting, because the owner reads those lines;
 *  3. every bad argument refusing in words, with no helper started;
 *  4. the retrieval text still choosing the right tool for the owner's own phrasings, and the
 *     coding vocabulary staying out of this pack's text entirely.
 *
 * At the time this test was written the two moved tools still lived inline in `packs.ts`, so the
 * index is built from the registry with this pack's copies laid over the top. That makes the test
 * pass while the migration is in flight and also after the inline copies are deleted.
 */
const byName = new Map(allPackTools().map(tool => [tool.name, tool]));
for (const tool of REMINDERS_PACK.tools) byName.set(tool.name, tool);
const tools = [...byName.values()];
const index = buildIndex(tools);
const choose = (text: string, app?: string) => selectTools(text, { app, index }).map(match => match.tool.name);
const toolFrom = (name: string) => tools.find(tool => tool.name === name);

/** The seven tools this pack must declare, in order, and whether each one changes something. */
const EXPECTED = [
  'reminders_list',
  'reminders_open',
  'reminders_read',
  'reminders_add',
  'reminders_complete',
  'reminders_update',
  'reminders_delete',
];

/** A valid sample for every tool, so a plan can be built without a refusal. */
const samples: Record<string, Record<string, string>> = {
  reminders_list: {},
  reminders_open: { limit: '10', list: 'Shopping' },
  reminders_read: { name: 'Buy milk' },
  reminders_add: { title: 'Buy milk', list: 'Shopping', due: '2026-11-05 09:00:00' },
  reminders_complete: { name: 'Buy milk', confirm: 'Buy milk' },
  reminders_update: { name: 'Buy milk', confirm: 'Buy milk', due: '2026-11-06 09:00:00' },
  reminders_delete: { name: 'Buy milk', confirm: 'Buy milk' },
};

const planOf = (name: string, args: Record<string, string>) => {
  const tool = toolFrom(name);
  assert.ok(tool, `${name} is not in the reminders pack or the registry`);
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

/** One reminder shaped like the helper's reply. */
const REMINDER =
  '{"id":"R1","title":"Buy milk","list":"Shopping","dueDate":"2026-11-05T09:00:00","isCompleted":false,"notes":"2 litres"}';

test('the reminders pack declares its seven tools, once each, and argues them well enough to be chosen', () => {
  assert.deepEqual(REMINDERS_PACK.tools.map(tool => tool.name), EXPECTED);
  const seen = new Set<string>();
  for (const tool of REMINDERS_PACK.tools) {
    assert.ok(!seen.has(tool.name), `${tool.name} is declared twice in the pack`);
    seen.add(tool.name);
    assert.match(tool.name, /^reminders_[a-z]+(_[a-z]+)*$/, `${tool.name} is not reminders_prefixed_snake_case`);
    assert.equal(tool.pack, 'reminders');
    assert.equal(tool.app, 'Reminders');
    assert.equal(tool.bundleId, 'com.apple.reminders');

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
  assert.equal(REMINDERS_PACK.id, 'reminders');
  assert.ok(REMINDERS_PACK.summary.length > 20);
  const writes = Object.fromEntries(REMINDERS_PACK.tools.map(tool => [tool.name, tool.writes]));
  assert.deepEqual(writes, {
    reminders_list: false,
    reminders_open: false,
    reminders_read: false,
    reminders_add: true,
    reminders_complete: true,
    reminders_update: true,
    reminders_delete: true,
  });
});

test('every reminders tool is registered exactly once, including the moved ones', () => {
  for (const name of EXPECTED) {
    assert.equal(tools.filter(tool => tool.name === name).length, 1, `${name} is not registered exactly once`);
  }
  assert.equal(byName.get('reminders_add')?.name, 'reminders_add');
});

test('the owner phrasings for the reminders tools pick the right tool', () => {
  assert.equal(choose('what reminder lists do i have')[0], 'reminders_list');
  assert.equal(choose('what reminders do i have open')[0], 'reminders_list');
  assert.equal(choose('anything I have to do today')[0], 'reminders_open');
  assert.equal(choose('what is still on my reminders')[0], 'reminders_open');
  assert.equal(choose('show me my open reminders on the shopping list')[0], 'reminders_open');
  assert.equal(choose('show me my reminder about the plumber')[0], 'reminders_read');
  assert.equal(choose('read me the reminder called pay the water bill')[0], 'reminders_read');
  assert.equal(choose('what does the call the dentist reminder say')[0], 'reminders_read');
  assert.equal(choose('add oat milk to my reminders')[0], 'reminders_add');
  assert.equal(choose('put call the plumber on my reminders list for friday at 9')[0], 'reminders_add');
  assert.equal(choose('add pick up the dry cleaning to my reminders list')[0], 'reminders_add');
  assert.equal(choose('mark the plumber reminder as done')[0], 'reminders_complete');
  assert.equal(choose('i finished the plumber reminder')[0], 'reminders_complete');
  assert.equal(choose('tick off the plumber reminder')[0], 'reminders_complete');
  assert.equal(choose('change the plumber reminder to friday')[0], 'reminders_update');
  assert.equal(choose('push the dentist reminder to tomorrow morning')[0], 'reminders_update');
  assert.equal(choose('add a note to the dentist reminder')[0], 'reminders_update');
  assert.equal(choose('delete the reminder called pay the water bill confirm pay the water bill')[0], 'reminders_delete');
  assert.equal(choose('get rid of the pick up the dry cleaning reminder')[0], 'reminders_delete');
});

test('the reminders tools are not selected for coding work', () => {
  assert.deepEqual(choose('write the failing test'), []);
  assert.deepEqual(choose('add a retry to the sync loop'), []);
  assert.deepEqual(choose('where is the router contract code'), []);
  assert.deepEqual(choose('create a new session for this'), []);
  assert.deepEqual(choose('add a checks column to a task table'), []);
});

test('each reminders tool sends the exact helper argument vector', () => {
  assert.deepEqual(cliPlan('reminders_list', samples.reminders_list).args, ['lists']);
  assert.deepEqual(cliPlan('reminders_open', samples.reminders_open).args, [
    'reminders', '--list', 'Shopping', '--limit', '10',
  ]);
  assert.deepEqual(cliPlan('reminders_read', samples.reminders_read).args, ['reminder', '--title', 'Buy milk']);
  assert.deepEqual(cliPlan('reminders_add', samples.reminders_add).args, [
    'reminder-create', '--title', 'Buy milk', '--list', 'Shopping', '--due', '2026-11-05 09:00:00',
  ]);
  assert.deepEqual(cliPlan('reminders_complete', samples.reminders_complete).args, [
    'reminder-update', '--title', 'Buy milk', '--completed', 'yes',
  ]);
  assert.deepEqual(cliPlan('reminders_update', samples.reminders_update).args, [
    'reminder-update', '--title', 'Buy milk', '--due', '2026-11-06 09:00:00',
  ]);
  assert.deepEqual(cliPlan('reminders_delete', samples.reminders_delete).args, [
    'reminder-delete', '--title', 'Buy milk', '--confirm', 'Buy milk',
  ]);
});

test('the list reads ask for enough characters', () => {
  assert.ok((cliPlan('reminders_open', samples.reminders_open).outputChars ?? 0) >= 6000);
  assert.ok((cliPlan('reminders_list', samples.reminders_list).outputChars ?? 0) >= 6000);
});

test('every reminders tool formats the helper JSON into lines with the title, list, time and id', () => {
  const listFormat = cliPlan('reminders_list', samples.reminders_list).format;
  assert.ok(listFormat, 'reminders_list must carry a format');
  const lists = listFormat('{"lists":[{"title":"Shopping","source":"iCloud","eventCount":3}]}');
  assert.match(lists, /Shopping/);
  assert.match(lists, /iCloud/);

  const openFormat = cliPlan('reminders_open', samples.reminders_open).format;
  assert.ok(openFormat, 'reminders_open must carry a format');
  const open = openFormat(`{"reminders":[${REMINDER}]}`);
  assert.match(open, /Buy milk/);
  assert.match(open, /Shopping/);
  assert.match(open, /2026-11-05 09:00:00/);
  assert.match(open, /\[id R1\]/);

  const readFormat = cliPlan('reminders_read', samples.reminders_read).format;
  assert.ok(readFormat, 'reminders_read must carry a format');
  const read = readFormat(REMINDER);
  assert.match(read, /Buy milk/);
  assert.match(read, /Shopping/);
  assert.match(read, /2026-11-05 09:00:00/);
  assert.match(read, /\[id R1\]/);
  // Reading one reminder is the reason its notes are in the answer at all.
  assert.match(read, /Notes: 2 litres/);

  for (const [name, verb] of [
    ['reminders_add', 'added'],
    ['reminders_complete', 'completed'],
    ['reminders_update', 'changed'],
    ['reminders_delete', 'deleted'],
  ] as const) {
    const format = cliPlan(name, samples[name]).format;
    assert.ok(format, `${name} must carry a format`);
    const line = format(REMINDER);
    assert.match(line, /Buy milk/, `${name} lost the title`);
    assert.match(line, /Shopping/, `${name} lost the list`);
    assert.match(line, /2026-11-05 09:00:00/, `${name} lost the due time`);
    assert.match(line, /\[id R1\]/, `${name} lost the id`);
    assert.match(line, new RegExp(`it ${verb} this reminder`), `${name} does not say what happened`);
  }
});

test('every reminders tool refuses a bad or missing argument in words, and never starts the helper', () => {
  const refusals: [string, Record<string, string>, RegExp][] = [
    ['reminders_open', { limit: 'lots' }, /whole number/],
    ['reminders_read', {}, /exact name of the reminder to read back/],
    ['reminders_add', {}, /I need the name of the reminder/],
    ['reminders_add', { title: 'Buy milk', due: 'soon' }, /A date has to look like/],
    ['reminders_complete', {}, /exact name of the reminder to complete/],
    ['reminders_complete', { name: 'Buy milk' }, /confirm argument too/],
    ['reminders_complete', { name: 'Buy milk', confirm: 'milk' }, /does not match the reminder name/],
    ['reminders_update', {}, /exact name of the reminder to change/],
    ['reminders_update', { name: 'Buy milk', confirm: 'Buy milk' }, /was not told what to change/],
    ['reminders_update', { name: 'Buy milk', confirm: 'Buy milk', flag: 'true' }, /cannot change whether a reminder is flagged/],
    ['reminders_update', { name: 'Buy milk', confirm: 'Buy milk', priority: 'high' }, /not a priority between 0 and 9/],
    ['reminders_update', { name: 'Buy milk', confirm: 'Buy milk', due: 'soon' }, /A date has to look like/],
    ['reminders_delete', {}, /exact name of the reminder to delete/],
    ['reminders_delete', { name: 'Buy milk' }, /confirm argument too/],
    ['reminders_delete', { name: 'Buy milk', confirm: 'milk' }, /does not match the reminder name/],
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

test('the reminders guardrails hold: no bulk delete, and the delete repeats the exact name', () => {
  for (const tool of REMINDERS_PACK.tools) {
    const planned = tool.plan(samples[tool.name] ?? {});
    const text = planned.kind === 'cli' ? [planned.binary, ...planned.args].join(' ') : planned.kind === 'osascript' ? planned.script : '';
    assert.doesNotMatch(text, /\b(?:delete|remove|complete)\s+(?:every|all|each)\b/i, `${tool.name} can act in bulk`);
  }
  const removed = cliPlan('reminders_delete', samples.reminders_delete);
  assert.ok(removed.args.includes('--confirm'), 'a delete must pass --confirm');
  assert.ok(removed.args.includes('Buy milk'));
  assert.ok(!removed.args.includes('*'));
});

test('the reminders retrieval text keeps the coding vocabulary out', () => {
  const text = JSON.stringify(REMINDERS_PACK);
  assert.doesNotMatch(text, /\b(?:task|tasks|todo|issue|ticket)\b/i, 'a coding word leaked into the reminders pack text');
});