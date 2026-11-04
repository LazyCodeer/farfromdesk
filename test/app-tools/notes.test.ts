import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import NOTES_PACK from '../../src/app-tools/packs/notes.js';
import { allPackTools, toolByName } from '../../src/app-tools/packs.js';
import { buildIndex, selectTools, tokenize } from '../../src/app-tools/retrieve.js';
import { detectDevicePlan } from '../../src/brain-device.js';

/**
 * The Notes pack tests.
 *
 * Notes is where the owner's real failure was: "Give me summary of all the notes" was answered
 * with the accessibility labels of whatever the Notes window happened to be showing. The rule
 * that fixes it, and the one this file pins, is that an answer about note content must come from
 * a read of the note content. So besides the standard pack invariants there are two jobs here
 * that the other packs do not carry:
 *
 *  1. The summarise phrasings must select a tool that returns the note texts, and must never
 *     resolve to `read_window` (the chrome read). The structural half of that is asserted against
 *     `detectDevicePlan`, the same function the companion's deterministic router uses.
 *  2. Every write must read the note first, refuse when rewriting would drop something Notes
 *     holds natively, and read the note back afterwards so the returned line carries proof.
 *
 * The pack is registered in `PACKS`, so the index here is the real one the companion will build.
 */
const index = buildIndex(allPackTools());
const choose = (text: string, app?: string) => selectTools(text, { app, index }).map(match => match.tool.name);

const samples: Record<string, Record<string, string>> = {
  notes_recent: { limit: '5' },
  notes_read: { name: 'Roof', chars: '4000' },
  notes_find: { query: 'plumber' },
  notes_create_note: { body: 'the roof is leaking' },
  notes_append: { name: 'Roof', text: 'the plumber comes monday' },
  notes_update: { name: 'Roof', text: 'the leak is fixed' },
  notes_delete: { name: 'Roof', confirm: 'Roof' },
};

const planOf = (name: string, args: Record<string, string>) => {
  const tool = toolByName(name) ?? NOTES_PACK.tools.find(candidate => candidate.name === name);
  assert.ok(tool, `${name} is not in the notes pack or the registry`);
  return tool.plan(args);
};

const scriptOf = (name: string, args: Record<string, string>): string => {
  const planned = planOf(name, args);
  assert.equal(planned.kind, 'osascript', `${name} must be AppleScript`);
  return planned.kind === 'osascript' ? planned.script : '';
};

test('the notes pack names, describes and argues its tools well enough to be chosen', () => {
  const seen = new Set<string>();
  for (const tool of NOTES_PACK.tools) {
    assert.ok(!seen.has(tool.name), `${tool.name} is declared twice in the pack`);
    seen.add(tool.name);
    assert.match(tool.name, /^notes_[a-z]+(_[a-z]+)*$/, `${tool.name} is not notes_prefixed_snake_case`);
    assert.equal(tool.pack, 'notes');
    assert.equal(tool.app, 'Notes');
    assert.equal(tool.bundleId, 'com.apple.Notes');

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
  assert.equal(NOTES_PACK.id, 'notes');
  assert.ok(NOTES_PACK.summary.length > 20);
  // writes drives read/write polarity in retrieval, so it has to be honest per tool.
  const writes = Object.fromEntries(NOTES_PACK.tools.map(tool => [tool.name, tool.writes]));
  assert.deepEqual(writes, {
    notes_recent: false,
    notes_read: false,
    notes_find: false,
    notes_create_note: true,
    notes_append: true,
    notes_update: true,
    notes_delete: true,
  });
});

test('every notes tool is registered, and the registry holds exactly one copy', () => {
  for (const tool of NOTES_PACK.tools) {
    assert.equal(toolByName(tool.name)?.name, tool.name, `${tool.name} is not in the registry`);
  }
  assert.equal(allPackTools().filter(tool => tool.name === 'notes_recent').length, 1);
});

test('the owner phrasings for the notes tools pick the right tool', () => {
  // The two phrasings from the actual failure: both must reach the tool that returns note text.
  assert.equal(choose('summarise all my notes')[0], 'notes_recent');
  assert.equal(choose('give me a summary of all the notes')[0], 'notes_recent');
  assert.equal(choose('show me my notes', 'Notes')[0], 'notes_recent');
  assert.equal(choose('what did I write about the roof')[0], 'notes_read');
  assert.equal(choose('add a line to my note about the roof')[0], 'notes_append');
  assert.equal(choose('update my note about the roof to say the leak is fixed')[0], 'notes_update');
  assert.equal(choose('delete the note called shopping list')[0], 'notes_delete');
  assert.equal(choose('find my note about the plumber')[0], 'notes_find');
});

test('the notes tools are not selected for coding work', () => {
  assert.deepEqual(choose('write the failing test'), []);
  assert.deepEqual(choose('add a retry to the sync loop'), []);
  assert.deepEqual(choose('add a checks column to task_contracts'), []);
  assert.deepEqual(choose('read the router contract code'), []);
  assert.deepEqual(choose('where is the router contract code'), []);
});

/**
 * The routing pin the owner's failure asks for. `detectDevicePlan` is the deterministic half of
 * the companion's device router: if a phrasing matches one of its patterns and the app name
 * resolves against a running app, the turn becomes a window read or an app open instead of a
 * tool call. A summary request must never be one of those.
 */
test('a summarise request never resolves to read_window', () => {
  const apps = [{ name: 'Notes' }, { name: 'Calendar' }, { name: 'Reminders' }];
  for (const text of ['summarise all my notes', 'give me a summary of all the notes', 'summarise my notes']) {
    const plan = detectDevicePlan(text, apps);
    assert.equal(plan, null, `"${text}" must not become a device plan, got ${plan?.action}`);
    assert.notEqual(plan?.action, 'read_window', `"${text}" was routed to a window read`);
    assert.equal(choose(text)[0], 'notes_recent', `"${text}" must select the notes content tool`);
  }
  // "show me my notes" has the exact shape of a window read. It is safe only because the app
  // name it carries ("my notes") tidies to something that is not a running app. Pin that, so a
  // future router change that loosens app matching cannot turn it back into a chrome read.
  const shape = detectDevicePlan('show me my notes', apps);
  assert.equal(shape, null);
  assert.equal(detectDevicePlan('read Notes', apps)?.action, 'read_window');

  // The tool itself must return the note text, not a window label, and must ask for enough of
  // it: 20 notes of prose do not fit in the 600-character status cap.
  const planned = planOf('notes_recent', {});
  assert.equal(planned.kind, 'osascript');
  if (planned.kind === 'osascript') {
    assert.match(planned.script, /plaintext of/);
    assert.ok((planned.outputChars ?? 0) >= 60000, `notes_recent returns ${planned.outputChars} characters, too few for a summary`);
  }
});

test('every notes tool refuses a bad or missing argument in words, and never throws', () => {
  const refusals: [string, Record<string, string>, RegExp][] = [
    ['notes_read', {}, /I need the name or the id/],
    ['notes_read', { name: 'Roof', chars: 'lots' }, /whole number/],
    ['notes_recent', { limit: 'lots' }, /whole number of notes/],
    ['notes_append', {}, /name of the note to add to/],
    ['notes_append', { name: 'Roof' }, /no text to add/],
    ['notes_update', {}, /name of the note to update/],
    ['notes_update', { name: 'Roof' }, /new text is empty/],
    ['notes_delete', {}, /name of the single note to delete/],
    ['notes_delete', { name: 'Roof' }, /needs the note name typed again/],
    ['notes_delete', { name: 'Roof', confirm: 'Shed' }, /does not match the note name/],
  ];
  for (const [name, args, message] of refusals) {
    const planned = planOf(name, args);
    assert.equal(planned.kind, 'osascript', `${name} should refuse with a sentence`);
    const script = planned.kind === 'osascript' ? planned.script : '';
    assert.match(script, message, `${name} with ${JSON.stringify(args)} did not refuse in words`);
    // A refusal must not carry the mutation it is refusing.
    assert.doesNotMatch(script, /set body of n to|\tdelete n\n/, `${name} refusal still carries a write`);
  }
});

test('a notes write reads the note before and after, and refuses what it cannot safely rewrite', () => {
  // Each write identifies exactly one note by exact name, refuses an ambiguous name, reads the
  // note's text before and after, and returns the length or the start of the new text as proof.
  for (const name of ['notes_append', 'notes_update']) {
    const script = scriptOf(name, samples[name]);
    assert.match(script, /every note whose name is sought/, `${name} must find by exact name`);
    assert.match(script, /if \(count of liveHits\) is greater than 1 then return/, `${name} must refuse an ambiguous name`);
    assert.match(script, /if \(count of liveHits\) is 0 then return/, `${name} must refuse a missing note`);
    // A note the owner deleted sits in Recently Deleted, and `every note` includes it: naming a
    // note that only exists there must not resolve to it.
    assert.match(script, /Recently Deleted/, `${name} must not treat a deleted note as a live one`);
    const before = script.indexOf('copy (plaintext of n) to beforeText');
    const write = script.indexOf('set body of n to');
    const after = script.indexOf('plaintext of n) to nowText') >= 0 ? script.indexOf('plaintext of n) to nowText') : script.indexOf('plaintext of n) to afterText');
    assert.ok(before >= 0 && write > before && after > write, `${name} must read before and after it writes`);
    assert.match(script, /characters/, `${name} must return the note length as proof`);
  }
  // Rewriting the HTML body would bake an inline image or a checklist in as text, so a note
  // that holds one is refused rather than rewritten.
  for (const name of ['notes_append', 'notes_update']) {
    const script = scriptOf(name, samples[name]);
    assert.match(script, /holds an attachment, a checklist, an image or an embedded object/, `${name} must refuse a lossy rewrite`);
    assert.match(script, /"<img"/);
    assert.match(script, /"attachment"/);
  }

  // A delete needs the note name typed a second time, refuses anything but one exact note, and
  // reports the note it removed.
  const deleteScript = scriptOf('notes_delete', samples.notes_delete);
  assert.match(deleteScript, /if confirmation is not sought then return/);
  assert.match(deleteScript, /every note whose name is sought/);
  assert.match(deleteScript, /if \(count of liveHits\) is greater than 1 then return/);
  assert.match(deleteScript, /Recently Deleted/);
  assert.match(deleteScript, /return "Deleted the note /);
  const deleteTool = NOTES_PACK.tools.find(tool => tool.name === 'notes_delete')!;
  assert.match(deleteTool.description, /never a folder and never a group/);
  assert.match(deleteTool.description, /not usable for bulk deletion/);
  assert.deepEqual(deleteTool.args.map(arg => [arg.name, arg.required]), [['name', true], ['confirm', true]]);

  // No notes script may delete more than the one note it was asked about, or touch a folder.
  for (const tool of NOTES_PACK.tools) {
    const planned = tool.plan(samples[tool.name] ?? {});
    if (planned.kind !== 'osascript') continue;
    assert.doesNotMatch(planned.script, /delete (?:every|all)\b|\bdelete folder|delete container/i, `${tool.name} can delete in bulk`);
  }
});

test('notes_recent is bounded and says so, and stops on a character budget rather than dropping notes', () => {
  const tool = toolByName('notes_recent')!;
  assert.match(tool.description, /at most 20 notes/);
  assert.match(tool.description, /60000 characters/);
  const script = scriptOf('notes_recent', { limit: '9999' });
  assert.match(script, /set cap to 20/, 'the limit is capped at 20');
  assert.match(script, /set scanCap to 300/);
  assert.match(script, /if seen > scanCap then exit repeat/);
  assert.match(script, /room is less than 1 then exit repeat/);
  // A listing stays a summary: each note is shown by its start, not by its whole text, and the
  // budget still guards the total. Measured live 2026-11-04: full bodies made the reply one
  // note's text wall instead of a summary of the notes.
  assert.match(script, /length of tx\) is greater than 40/);
  assert.match(script, /set ln to ln & " — " & tx/);
});

/**
 * T0 in the verification ladder: the script has to compile against Notes' own dictionary.
 * `osacompile` only reads Notes.app's .sdef and needs no Automation grant, so this runs
 * everywhere. A live run (T4) still needs the owner's one-time Automation allow-click.
 */
test('every notes AppleScript tool compiles against the Notes dictionary', { skip: process.platform !== 'darwin' ? 'macOS only' : false }, () => {
  if (!existsSync('/usr/bin/osacompile')) return;
  const dir = mkdtempSync(join(tmpdir(), 'ffd-notes-osacompile-'));
  try {
    for (const tool of NOTES_PACK.tools) {
      const planned = tool.plan(samples[tool.name] ?? {});
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