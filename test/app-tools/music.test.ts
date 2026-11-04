import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import MUSIC_PACK from '../../src/app-tools/packs/music.js';
import { allPackTools, toolByName } from '../../src/app-tools/packs.js';
import { buildIndex, selectTools, tokenize } from '../../src/app-tools/retrieve.js';

/**
 * The Music pack tests.
 *
 * Music's dictionary contains `play`, `pause`, `next track` and `set sound volume`. A companion
 * that starts or stops the owner's music by itself is a bad failure, so the standard invariants
 * carry one extra job here: prove that neither plan, refusals included, contains a transport
 * verb or a volume change.
 *
 * The two tools are not registered in `PACKS` yet; the integrator does that. Until then the
 * selection tests build an index from the existing packs plus this one.
 */
const tools = [...new Map([...allPackTools(), ...MUSIC_PACK.tools].map(tool => [tool.name, tool])).values()];
const index = buildIndex(tools);
const choose = (text: string, app?: string) => selectTools(text, { app, index }).map(match => match.tool.name);

const samples: Record<string, Record<string, string>> = {
  music_current: {},
  music_library: { query: 'sunshine', limit: '10' },
};

const toolOf = (name: string) => MUSIC_PACK.tools.find(tool => tool.name === name) ?? toolByName(name)!;

const scriptOf = (name: string, args: Record<string, string>): string => {
  const planned = toolOf(name).plan(args);
  assert.equal(planned.kind, 'osascript', `${name} must be AppleScript`);
  return planned.kind === 'osascript' ? planned.script : '';
};

/** The mutation shapes this pack must never contain, refusals included. */
const MUTATION = /\bmake new\b|\bdelete\b|\bduplicate\b|\bmove\b|\bsend\b|\bset (?:name|text|content|position|bounds|volume|player state) of\b/i;

/** The transport verbs that would change what the owner hears. */
const TRANSPORT = /\bplay\b|\bpause\b|\bnext track\b|\bprevious track\b|\bplaypause\b|\bset sound volume\b/i;

test('the music pack names, describes and argues its tools well enough to be chosen', () => {
  // A registered pack is fine; a name owned by a different pack is not.
  const registered = new Map(allPackTools().map(tool => [tool.name, tool.pack]));
  const seen = new Set<string>();
  for (const tool of MUSIC_PACK.tools) {
    assert.ok(!seen.has(tool.name), `${tool.name} is declared twice in the pack`);
    seen.add(tool.name);
    if (registered.has(tool.name)) {
      assert.equal(registered.get(tool.name), tool.pack, `${tool.name} collides with another pack's tool`);
    }
    assert.match(tool.name, /^music_[a-z]+(_[a-z]+)*$/, `${tool.name} is not music_prefixed_snake_case`);
    assert.equal(tool.pack, 'music');
    assert.equal(tool.app, 'Music');
    assert.equal(tool.bundleId, 'com.apple.Music');
    // Every tool in this pack is read only, and that is what drives retrieval polarity.
    assert.equal(tool.writes, false, `${tool.name} must be read only`);

    const sentences = tool.description.split(/\.\s+/).filter(Boolean);
    assert.ok(sentences.length >= 3, `${tool.name} needs at least three sentences, has ${sentences.length}`);
    assert.match(tool.description, /Use this when/, `${tool.name} does not say when to use it`);
    assert.match(tool.description, /never (?:plays|pauses|searches)/, `${tool.name} does not spell out that it never drives playback`);

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
  assert.equal(MUSIC_PACK.id, 'music');
  assert.equal(MUSIC_PACK.app, 'Music');
  assert.equal(MUSIC_PACK.bundleId, 'com.apple.Music');
  assert.ok(MUSIC_PACK.summary.length > 20);
  // What is playing takes nothing to say.
  assert.equal(toolOf('music_current').args.length, 0);
});

test('every music plan is a read-only AppleScript that answers in words and never drives playback', () => {
  for (const tool of MUSIC_PACK.tools) {
    const script = scriptOf(tool.name, samples[tool.name] ?? {});
    assert.match(script, /\breturn\b/, `${tool.name} never returns anything`);
    assert.doesNotMatch(script, MUTATION, `${tool.name} carries a changing shape`);
    assert.doesNotMatch(script, TRANSPORT, `${tool.name} carries a transport verb that would change what is playing`);
  }
  // The now-playing answer reads the player state and the current track, and says so when nothing
  // is on rather than reporting an empty track.
  const current = scriptOf('music_current', {});
  assert.match(current, /player state as string/);
  // `st` is a reserved AppleScript word, so the player state lives in `pstate`.
  assert.match(current, /if pstate is "stopped" then return "Nothing is playing in Music just now\."/);
  assert.match(current, /name of current track/);
  assert.match(current, /artist of current track/);
  assert.match(current, /album of current track/);

  // The library search is bounded, so a library of thousands of tracks cannot hold the turn open.
  const library = scriptOf('music_library', samples.music_library);
  assert.match(library, /count of tracks of library playlist 1/);
  assert.match(library, /set scanCap to 2000\n/);
  assert.match(library, /contains q/);
});

test('the music tools refuse what they cannot do, in words and without touching the player', () => {
  const noQuery = scriptOf('music_library', {});
  assert.match(noQuery, /I need the word or phrase to look for in the music library/);
  assert.doesNotMatch(noQuery, /tell application "Music"/, 'a refusal must not touch Music at all');
  assert.doesNotMatch(noQuery, MUTATION);
  assert.doesNotMatch(noQuery, TRANSPORT);

  const badLimit = scriptOf('music_library', { query: 'sunshine', limit: 'a few' });
  assert.match(badLimit, /whole number of matches/);
  assert.doesNotMatch(badLimit, TRANSPORT);
  // The limit is clamped rather than trusted: 999 is 25 matches.
  assert.match(scriptOf('music_library', { query: 'sunshine', limit: '999' }), /set cap to 25\n/);
  assert.match(scriptOf('music_library', { query: 'sunshine', limit: '0' }), /whole number of matches/);
});

test("the owner's own phrasings for the music tools pick the right tool", () => {
  assert.equal(choose('what song is playing')[0], 'music_current');
  assert.equal(choose('is the music paused', 'Music')[0], 'music_current');
  assert.equal(choose('what am i listening to', 'Music')[0], 'music_current');
  assert.equal(choose('what is the artist playing right now', 'Music')[0], 'music_current');

  assert.equal(choose('do i have that song in my music library')[0], 'music_library');
  assert.equal(choose('find the album by that band in my library')[0], 'music_library');
  assert.equal(choose('search my music for a song called sunshine')[0], 'music_library');
  assert.equal(choose('search my music for a song called sunshine', 'Music')[0], 'music_library');
});

test('the music tools are not selected for coding work', () => {
  assert.deepEqual(choose('write the failing test'), []);
  assert.deepEqual(choose('fix the failing unit test'), []);
  assert.deepEqual(choose('add a retry to the sync loop'), []);
  assert.deepEqual(choose('add a checks column to task_contracts'), []);
  assert.deepEqual(choose('read the router contract code'), []);
});

/**
 * T0 in the verification ladder: the script has to compile against Music's own dictionary.
 * `osacompile` only reads the app's .sdef and needs no Automation grant, so this runs everywhere
 * and catches a script that would fail the first time the owner asked for it. A live run (T4)
 * still needs the owner's one-time Automation allow-click and has not happened.
 */
test('every music AppleScript tool compiles against the Music dictionary', { skip: process.platform !== 'darwin' ? 'macOS only' : false }, () => {
  if (!existsSync('/usr/bin/osacompile')) return;
  const dir = mkdtempSync(join(tmpdir(), 'ffd-music-osacompile-'));
  try {
    for (const tool of MUSIC_PACK.tools) {
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