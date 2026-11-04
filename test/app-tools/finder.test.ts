import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import FINDER_PACK from '../../src/app-tools/packs/finder.js';
import { allPackTools, toolByName } from '../../src/app-tools/packs.js';
import { buildIndex, selectTools, tokenize } from '../../src/app-tools/retrieve.js';

/**
 * The Finder pack tests.
 *
 * Finder is where a wrong write is destructive to the owner's real files, so the standard
 * invariants carry one extra job here: prove that no plan, refusals included, contains a
 * creating, deleting, moving or renaming shape.
 *
 * The two tools are not registered in `PACKS` yet; the integrator does that. Until then the
 * selection tests build an index from the existing packs plus this one, which is exactly the
 * tool set the integrator will assemble.
 */
const tools = [...new Map([...allPackTools(), ...FINDER_PACK.tools].map(tool => [tool.name, tool])).values()];
const index = buildIndex(tools);
const choose = (text: string, app?: string) => selectTools(text, { app, index }).map(match => match.tool.name);

const samples: Record<string, Record<string, string>> = {
  finder_recent: { folder: 'Downloads', limit: '10' },
  finder_find: { query: 'invoice', folder: 'Documents', limit: '10' },
};

const toolOf = (name: string) => FINDER_PACK.tools.find(tool => tool.name === name) ?? toolByName(name)!;

const scriptOf = (name: string, args: Record<string, string>): string => {
  const planned = toolOf(name).plan(args);
  assert.equal(planned.kind, 'osascript', `${name} must be AppleScript`);
  return planned.kind === 'osascript' ? planned.script : '';
};

/** The mutation shapes this pack must never contain, refusals included. */
const MUTATION = /\bmake new\b|\bdelete\b|\bduplicate\b|\bmove\b|\bsend\b|\bset (?:name|text|content|position|bounds|volume|player state) of\b/i;

test('the finder pack names, describes and argues its tools well enough to be chosen', () => {
  // A registered pack is fine; a name owned by a different pack is not.
  const registered = new Map(allPackTools().map(tool => [tool.name, tool.pack]));
  const seen = new Set<string>();
  for (const tool of FINDER_PACK.tools) {
    assert.ok(!seen.has(tool.name), `${tool.name} is declared twice in the pack`);
    seen.add(tool.name);
    if (registered.has(tool.name)) {
      assert.equal(registered.get(tool.name), tool.pack, `${tool.name} collides with another pack's tool`);
    }
    assert.match(tool.name, /^finder_[a-z]+(_[a-z]+)*$/, `${tool.name} is not finder_prefixed_snake_case`);
    assert.equal(tool.pack, 'finder');
    assert.equal(tool.app, 'Finder');
    assert.equal(tool.bundleId, 'com.apple.finder');
    // Every tool in this pack is read only, and that is what drives retrieval polarity.
    assert.equal(tool.writes, false, `${tool.name} must be read only`);

    const sentences = tool.description.split(/\.\s+/).filter(Boolean);
    assert.ok(sentences.length >= 3, `${tool.name} needs at least three sentences, has ${sentences.length}`);
    assert.match(tool.description, /Use this when/, `${tool.name} does not say when to use it`);
    assert.match(tool.description, /never (?:moves|renames|opens|deletes|changes)/, `${tool.name} does not spell out that nothing is moved or deleted`);

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
  assert.equal(FINDER_PACK.id, 'finder');
  assert.equal(FINDER_PACK.app, 'Finder');
  assert.equal(FINDER_PACK.bundleId, 'com.apple.finder');
  assert.ok(FINDER_PACK.summary.length > 20);
});

test('every finder plan is a read-only AppleScript that answers in words', () => {
  for (const tool of FINDER_PACK.tools) {
    const script = scriptOf(tool.name, samples[tool.name] ?? {});
    assert.match(script, /\breturn\b/, `${tool.name} never returns anything`);
    assert.doesNotMatch(script, MUTATION, `${tool.name} carries a moving or changing shape`);
    // Every listing is capped, so the turn cannot be held open by a huge folder or a huge limit.
    assert.match(script, /set cap to \d+/, `${tool.name} does not cap what it answers with`);
  }
  // Finder reads the folder the owner named, or the downloads folder when they named none.
  const recent = scriptOf('finder_recent', samples.finder_recent);
  assert.match(recent, /path to downloads folder/);
  // The recent listing walks every item and compares dates, so it caps the walk as well as the
  // answer. 400 was measured too slow on a real Downloads folder (the osascript call timed out at
  // 20s), so the walk is capped at 60 and the sentence says how many items it looked at.
  assert.match(recent, /set scanCap to 60/);
  const documents = scriptOf('finder_find', { query: 'invoice', folder: 'Documents', limit: '10' });
  assert.match(documents, /path to documents folder/);
  const absolute = scriptOf('finder_find', { query: 'invoice', folder: '/Users/someone/Desktop', limit: '10' });
  assert.match(absolute, /POSIX file "\/Users\/someone\/Desktop"/);
});

test('the finder tools refuse what they cannot do, in words and without touching a file', () => {
  const noQuery = scriptOf('finder_find', {});
  assert.match(noQuery, /I need the word or phrase to look for in the file names/);
  const noQueryPlanned = toolOf('finder_find').plan({});
  assert.match(String(noQueryPlanned.kind === 'osascript' ? noQueryPlanned.script : ''), /\breturn\b/);

  const badLimit = scriptOf('finder_recent', { limit: 'ten' });
  assert.match(badLimit, /whole number of items/);
  assert.doesNotMatch(badLimit, MUTATION);

  // An unknown folder name is refused rather than guessed at, because guessing lists the wrong
  // folder. This is the sentence the owner reads instead.
  const unknownFolder = scriptOf('finder_recent', { folder: 'Screenshots', limit: '10' });
  assert.match(unknownFolder, /not one I read by name/);
  assert.match(unknownFolder, /Downloads, Desktop, Documents/);
  assert.doesNotMatch(unknownFolder, /tell application "Finder"/, 'a refusal must not touch Finder at all');
  assert.doesNotMatch(unknownFolder, MUTATION);

  // The limit is clamped rather than rejected: 999 is the 25 newest items, not 999.
  assert.match(scriptOf('finder_recent', { limit: '999' }), /set cap to 25\n/);
  // Zero is not a whole number of items to return.
  assert.match(scriptOf('finder_recent', { limit: '0' }), /whole number of items/);
});

test("the owner's own phrasings for the finder tools pick the right tool", () => {
  assert.equal(choose('what did i download recently')[0], 'finder_recent');
  assert.equal(choose('show me the newest files in my downloads')[0], 'finder_recent');
  assert.equal(choose('list the files i worked on today')[0], 'finder_recent');
  assert.equal(choose('what is new in my downloads folder', 'Finder')[0], 'finder_recent');

  assert.equal(choose('find the file called invoice')[0], 'finder_find');
  assert.equal(choose('where is the file named budget')[0], 'finder_find');
  assert.equal(choose('is there a file called passport in my downloads')[0], 'finder_find');
  assert.equal(choose('search my documents folder for the invoice', 'Finder')[0], 'finder_find');
});

test('the finder tools are not selected for coding work', () => {
  assert.deepEqual(choose('write the failing test'), []);
  assert.deepEqual(choose('fix the failing unit test'), []);
  assert.deepEqual(choose('add a retry to the sync loop'), []);
  assert.deepEqual(choose('add a checks column to task_contracts'), []);
  assert.deepEqual(choose('read the router contract code'), []);
});

/**
 * T0 in the verification ladder: the script has to compile against Finder's own dictionary.
 * `osacompile` only reads the app's .sdef and needs no Automation grant, so this runs everywhere
 * and catches a script that would fail the first time the owner asked for it. A live run (T4)
 * still needs the owner's one-time Automation allow-click and has not happened.
 */
test('every finder AppleScript tool compiles against the Finder dictionary', { skip: process.platform !== 'darwin' ? 'macOS only' : false }, () => {
  if (!existsSync('/usr/bin/osacompile')) return;
  const dir = mkdtempSync(join(tmpdir(), 'ffd-finder-osacompile-'));
  try {
    for (const tool of FINDER_PACK.tools) {
      const planned = tool.plan(samples[tool.name] ?? {});
      assert.equal(planned.kind, 'osascript', `${tool.name} should be AppleScript`);
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