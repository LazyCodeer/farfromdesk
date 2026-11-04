import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import MESSAGES_PACK from '../../src/app-tools/packs/messages.js';
import { allPackTools, toolByName } from '../../src/app-tools/packs.js';
import { buildIndex, selectTools, tokenize } from '../../src/app-tools/retrieve.js';

/**
 * The Messages pack tests.
 *
 * Messages is the one app here whose dictionary no longer exposes message contents: the shipped
 * sdef defines `participant`, `account`, `chat` and `file transfer` and nothing else, so there is
 * no `message` class, no `text` and no `sender` to read. The pack still asks for them, because the
 * terms resolve for the compiler and a future macOS may restore them, but every read is wrapped so
 * that the owner gets a sentence naming the Automation permission and this limitation instead of a
 * raw error number. These tests pin that honest path; whether the read succeeds at runtime is NOT
 * verified here and cannot be without the owner's permission.
 *
 * The two tools are not registered in `PACKS` yet; the integrator does that. Until then the
 * selection tests build an index from the existing packs plus this one.
 */
const tools = [...new Map([...allPackTools(), ...MESSAGES_PACK.tools].map(tool => [tool.name, tool])).values()];
const index = buildIndex(tools);
const choose = (text: string, app?: string) => selectTools(text, { app, index }).map(match => match.tool.name);

const samples: Record<string, Record<string, string>> = {
  messages_recent: { with: 'Sam', limit: '10' },
  messages_find: { query: 'dinner', limit: '10' },
};

const toolOf = (name: string) => MESSAGES_PACK.tools.find(tool => tool.name === name) ?? toolByName(name)!;

const scriptOf = (name: string, args: Record<string, string>): string => {
  const planned = toolOf(name).plan(args);
  assert.equal(planned.kind, 'osascript', `${name} must be AppleScript`);
  return planned.kind === 'osascript' ? planned.script : '';
};

/** The mutation shapes this pack must never contain, refusals included. `send` is the key one. */
const MUTATION = /\bmake new\b|\bdelete\b|\bduplicate\b|\bmove\b|\bsend\b|\bset (?:name|text|content|position|bounds|volume|player state) of\b/i;

test('the messages pack names, describes and argues its tools well enough to be chosen', () => {
  // A registered pack is fine; a name owned by a different pack is not.
  const registered = new Map(allPackTools().map(tool => [tool.name, tool.pack]));
  const seen = new Set<string>();
  for (const tool of MESSAGES_PACK.tools) {
    assert.ok(!seen.has(tool.name), `${tool.name} is declared twice in the pack`);
    seen.add(tool.name);
    if (registered.has(tool.name)) {
      assert.equal(registered.get(tool.name), tool.pack, `${tool.name} collides with another pack's tool`);
    }
    assert.match(tool.name, /^messages_[a-z]+(_[a-z]+)*$/, `${tool.name} is not messages_prefixed_snake_case`);
    assert.equal(tool.pack, 'messages');
    assert.equal(tool.app, 'Messages');
    assert.equal(tool.bundleId, 'com.apple.MobileSMS');
    // Every tool in this pack is read only, and that is what drives retrieval polarity.
    assert.equal(tool.writes, false, `${tool.name} must be read only`);

    const sentences = tool.description.split(/\.\s+/).filter(Boolean);
    assert.ok(sentences.length >= 3, `${tool.name} needs at least three sentences, has ${sentences.length}`);
    assert.match(tool.description, /Use this when/, `${tool.name} does not say when to use it`);
    // Sending is the one genuinely dangerous verb in this dictionary, so the refusal to send has
    // to be explicit in the retrieval text.
    assert.match(tool.description, /never sends, replies/, `${tool.name} does not spell out that it never sends`);
    assert.match(tool.description, /mark(?:s|ing)? anything as read/, `${tool.name} does not promise not to mark messages read`);

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
  assert.equal(MESSAGES_PACK.id, 'messages');
  assert.equal(MESSAGES_PACK.app, 'Messages');
  assert.equal(MESSAGES_PACK.bundleId, 'com.apple.MobileSMS');
  assert.ok(MESSAGES_PACK.summary.length > 20);
  // The conversation is named by the other person, so that argument is required.
  assert.equal(toolOf('messages_recent').args.find(arg => arg.name === 'with')?.required, true);
});

test('every messages plan is a read-only AppleScript that answers in words and never sends', () => {
  for (const tool of MESSAGES_PACK.tools) {
    const script = scriptOf(tool.name, samples[tool.name] ?? {});
    assert.match(script, /\breturn\b/, `${tool.name} never returns anything`);
    assert.doesNotMatch(script, MUTATION, `${tool.name} carries a sending or changing shape`);
    // The one-time Automation grant is named in every failure path.
    assert.match(script, /Automation permission for Messages/);
    assert.match(script, /Privacy and Security, Automation/);
    // The dictionary gap is stated too, because the read can be refused even with the grant.
    assert.match(script, /no longer lists message contents/);
    assert.match(script, /Nothing was sent and nothing was changed\./);
  }
  const recent = scriptOf('messages_recent', samples.messages_recent);
  assert.match(recent, /participants of c/);
  assert.match(recent, /handle of p/);
  assert.match(recent, /text of m/);
  assert.match(recent, /sender of m as string/);
  // The conversation is taken from the end of the history, bounded by the limit.
  assert.match(recent, /set startAt to n - cap \+ 1/);

  const find = scriptOf('messages_find', samples.messages_find);
  assert.match(find, /text of m/);
  // Searching every conversation would never finish, so the scan is bounded on both axes.
  assert.match(find, /set chatCap to 40\n/);
  assert.match(find, /set msgCap to 150\n/);
});

test('the messages tools refuse what they cannot do, in words and without touching Messages', () => {
  const noPerson = scriptOf('messages_recent', {});
  assert.match(noPerson, /I need the name, number or handle of the other person/);
  assert.doesNotMatch(noPerson, /tell application "Messages"/, 'a refusal must not touch Messages at all');
  assert.doesNotMatch(noPerson, MUTATION);

  const noQuery = scriptOf('messages_find', {});
  assert.match(noQuery, /I need the word or phrase to look for in the message history/);
  assert.doesNotMatch(noQuery, MUTATION);

  const badLimit = scriptOf('messages_recent', { with: 'Sam', limit: 'lots' });
  assert.match(badLimit, /whole number of messages/);
  assert.doesNotMatch(badLimit, MUTATION);
  // The limit is clamped rather than trusted: 999 is 25 messages.
  assert.match(scriptOf('messages_recent', { with: 'Sam', limit: '999' }), /set cap to 25\n/);
  assert.match(scriptOf('messages_find', { query: 'dinner', limit: '999' }), /set cap to 25\n/);
  assert.match(scriptOf('messages_recent', { with: 'Sam', limit: '0' }), /whole number of messages/);

  // A conversation that matches nothing is refused in words rather than reported as empty.
  assert.match(scriptOf('messages_recent', samples.messages_recent), /No Messages conversation matching /);
});

test("the owner's own phrasings for the messages tools pick the right tool", () => {
  // "message" and "messages" are deliberately not narrowed by the scorer on their own, because the
  // word also means an item of mail; where a phrasing is genuinely ambiguous between the two apps
  // the test says which app the owner is looking at, exactly as the scorer's own note describes.
  assert.equal(choose('what did they say in messages', 'Messages')[0], 'messages_recent');
  assert.equal(choose('read my last messages with a friend')[0], 'messages_recent');
  assert.equal(choose('what are my most recent messages', 'Messages')[0], 'messages_recent');
  assert.equal(choose('show the last messages in that conversation')[0], 'messages_recent');
  assert.equal(choose('read my last messages with a friend', 'Messages')[0], 'messages_recent');

  assert.equal(choose('where did someone mention the address')[0], 'messages_find');
  assert.equal(choose('find the message about the meeting time')[0], 'messages_find');
  assert.equal(choose('search my messages for that word', 'Messages')[0], 'messages_find');
  assert.equal(choose('who said something about the train')[0], 'messages_find');
  assert.equal(choose('search my messages for that word', 'Messages')[0], 'messages_find');
});

test('the messages tools are not selected for coding work', () => {
  assert.deepEqual(choose('write the failing test'), []);
  assert.deepEqual(choose('fix the failing unit test'), []);
  assert.deepEqual(choose('add a retry to the sync loop'), []);
  assert.deepEqual(choose('add a checks column to task_contracts'), []);
  assert.deepEqual(choose('read the router contract code'), []);
});

/**
 * T0 in the verification ladder: the script has to compile against Messages' own dictionary.
 * `osacompile` only reads the app's .sdef and needs no Automation grant, so this runs everywhere.
 * It does NOT prove the read works: the sdef has no `message` class, so the property accesses
 * compile as untyped references and are expected to fail at runtime, where the pack turns the
 * failure into a readable sentence.
 */
test('every messages AppleScript tool compiles against the Messages dictionary', { skip: process.platform !== 'darwin' ? 'macOS only' : false }, () => {
  if (!existsSync('/usr/bin/osacompile')) return;
  const dir = mkdtempSync(join(tmpdir(), 'ffd-messages-osacompile-'));
  try {
    for (const tool of MESSAGES_PACK.tools) {
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