import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import SAFARI_PACK from '../../src/app-tools/packs/safari.js';
import { allPackTools, toolByName } from '../../src/app-tools/packs.js';
import { buildIndex, selectTools, tokenize } from '../../src/app-tools/retrieve.js';

/**
 * The Safari pack tests.
 *
 * Safari's page text is the one read in these four packs that can be blocked twice over: it needs
 * the Automation grant, and it can also need Safari's "Allow JavaScript from Apple Events"
 * developer setting. The pack reads the declared `text of tab` property rather than injecting
 * JavaScript, but it still may be refused. These tests pin the honest behaviour: both gates are
 * named in the failure sentence, and the refusal path never throws a raw error number alone.
 *
 * The two tools are not registered in `PACKS` yet; the integrator does that. Until then the
 * selection tests build an index from the existing packs plus this one.
 */
const tools = [...new Map([...allPackTools(), ...SAFARI_PACK.tools].map(tool => [tool.name, tool])).values()];
const index = buildIndex(tools);
const choose = (text: string, app?: string) => selectTools(text, { app, index }).map(match => match.tool.name);

const samples: Record<string, Record<string, string>> = {
  safari_tabs: { window: '1', limit: '20' },
  safari_read_tab: { query: 'recipe', limit: '4000' },
};

const toolOf = (name: string) => SAFARI_PACK.tools.find(tool => tool.name === name) ?? toolByName(name)!;

const scriptOf = (name: string, args: Record<string, string>): string => {
  const planned = toolOf(name).plan(args);
  assert.equal(planned.kind, 'osascript', `${name} must be AppleScript`);
  return planned.kind === 'osascript' ? planned.script : '';
};

/** The mutation shapes this pack must never contain, refusals included. */
const MUTATION = /\bmake new\b|\bdelete\b|\bduplicate\b|\bmove\b|\bsend\b|\bset (?:name|text|content|position|bounds|volume|player state) of\b/i;

test('the safari pack names, describes and argues its tools well enough to be chosen', () => {
  // A registered pack is fine; a name owned by a different pack is not.
  const registered = new Map(allPackTools().map(tool => [tool.name, tool.pack]));
  const seen = new Set<string>();
  for (const tool of SAFARI_PACK.tools) {
    assert.ok(!seen.has(tool.name), `${tool.name} is declared twice in the pack`);
    seen.add(tool.name);
    if (registered.has(tool.name)) {
      assert.equal(registered.get(tool.name), tool.pack, `${tool.name} collides with another pack's tool`);
    }
    assert.match(tool.name, /^safari_[a-z]+(_[a-z]+)*$/, `${tool.name} is not safari_prefixed_snake_case`);
    assert.equal(tool.pack, 'safari');
    assert.equal(tool.app, 'Safari');
    assert.equal(tool.bundleId, 'com.apple.Safari');
    // Every tool in this pack is read only, and that is what drives retrieval polarity.
    assert.equal(tool.writes, false, `${tool.name} must be read only`);

    const sentences = tool.description.split(/\.\s+/).filter(Boolean);
    assert.ok(sentences.length >= 3, `${tool.name} needs at least three sentences, has ${sentences.length}`);
    assert.match(tool.description, /Use this when/, `${tool.name} does not say when to use it`);
    assert.match(tool.description, /never (?:opens|clicks)/, `${tool.name} does not spell out that it never drives the browser`);

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
  assert.equal(SAFARI_PACK.id, 'safari');
  assert.equal(SAFARI_PACK.app, 'Safari');
  assert.equal(SAFARI_PACK.bundleId, 'com.apple.Safari');
  assert.ok(SAFARI_PACK.summary.length > 20);
});

test('every safari plan is a read-only AppleScript that answers in words', () => {
  for (const tool of SAFARI_PACK.tools) {
    const script = scriptOf(tool.name, samples[tool.name] ?? {});
    assert.match(script, /\breturn\b/, `${tool.name} never returns anything`);
    assert.doesNotMatch(script, MUTATION, `${tool.name} carries a closing or changing shape`);
  }
  // Safari has several windows; the tools read the front one unless the owner gives a number.
  assert.match(scriptOf('safari_tabs', {}), /set w to front window/);
  assert.match(scriptOf('safari_tabs', { window: '2' }), /set n to 2\n/);
  assert.match(scriptOf('safari_tabs', { window: '2' }), /set w to window n/);
  assert.match(scriptOf('safari_tabs', { window: '2' }), /if n > \(count of windows\) then return "There is no Safari window number "/);
  // The listing is bounded, so a window with hundreds of tabs cannot hold the turn open.
  assert.match(scriptOf('safari_tabs', { limit: '999' }), /set cap to 50\n/);
  assert.match(scriptOf('safari_read_tab', { query: 'recipe', limit: '999999' }), /set cap to 40000\n/);
});

test('the safari tools refuse what they cannot do, in words, and name both gates when blocked', () => {
  const noQuery = scriptOf('safari_read_tab', {});
  assert.match(noQuery, /I need a fragment of the tab title or its web address/);
  assert.doesNotMatch(noQuery, MUTATION);

  // A page read that matches nothing and one that matches several both refuse rather than guess.
  const read = scriptOf('safari_read_tab', samples.safari_read_tab);
  assert.match(read, /No open Safari tab has a title or address containing /);
  assert.match(read, /More than one open Safari tab matches /);
  // The two gates are named in the failure sentence: the Automation grant and the developer
  // setting. This is the honest path, because which one applies cannot be decided from here.
  assert.match(read, /Privacy and Security, Automation/);
  assert.match(read, /Allow JavaScript from Apple Events/);
  assert.match(read, /on error errMsg number errNum/);
  assert.match(read, /text of t/);

  const badWindow = scriptOf('safari_tabs', { window: 'the first one' });
  assert.match(badWindow, /The window has to be a whole number/);
  assert.doesNotMatch(badWindow, /tell application "Safari"/, 'a refusal must not touch Safari at all');
  assert.doesNotMatch(badWindow, MUTATION);

  const badLimit = scriptOf('safari_tabs', { limit: '0' });
  assert.match(badLimit, /whole number of tabs/);
});

test("the owner's own phrasings for the safari tools pick the right tool", () => {
  assert.equal(choose('what tabs do i have open')[0], 'safari_tabs');
  assert.equal(choose('list my open safari tabs')[0], 'safari_tabs');
  assert.equal(choose('what pages do i have up in safari')[0], 'safari_tabs');
  assert.equal(choose('what tabs do i have open', 'Safari')[0], 'safari_tabs');

  assert.equal(choose('read the article i have open')[0], 'safari_read_tab');
  assert.equal(choose('what does this page say')[0], 'safari_read_tab');
  assert.equal(choose('read the page about the recipe')[0], 'safari_read_tab');
  assert.equal(choose('read the article i have open', 'Safari')[0], 'safari_read_tab');
});

test('the safari tools are not selected for coding work', () => {
  assert.deepEqual(choose('write the failing test'), []);
  assert.deepEqual(choose('fix the failing unit test'), []);
  assert.deepEqual(choose('add a retry to the sync loop'), []);
  assert.deepEqual(choose('add a checks column to task_contracts'), []);
  assert.deepEqual(choose('read the router contract code'), []);
});

/**
 * T0 in the verification ladder: the script has to compile against Safari's own dictionary.
 * `osacompile` only reads the app's .sdef and needs no Automation grant, so this runs everywhere
 * and catches a script that would fail the first time the owner asked for it. Whether Safari
 * actually hands over `text of tab` at runtime, and whether "Allow JavaScript from Apple Events"
 * is required for it, is NOT verified here: that needs the owner's machine and their permission.
 */
test('every safari AppleScript tool compiles against the Safari dictionary', { skip: process.platform !== 'darwin' ? 'macOS only' : false }, () => {
  if (!existsSync('/usr/bin/osacompile')) return;
  const dir = mkdtempSync(join(tmpdir(), 'ffd-safari-osacompile-'));
  try {
    for (const tool of SAFARI_PACK.tools) {
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