import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import MAIL_PACK from '../../src/app-tools/packs/mail.js';
import { allPackTools, toolByName } from '../../src/app-tools/packs.js';
import { buildIndex, selectTools, tokenize } from '../../src/app-tools/retrieve.js';

/**
 * The Mail pack tests.
 *
 * The owner's failure this pack answers is "summarise my mail": the companion read the labels of
 * the Mail window instead of the message text. So, besides the standard pack invariants, these
 * tests pin two jobs the other packs do not carry:
 *
 *  1. Every read is a real read: each read-only plan is AppleScript that returns something and
 *     carries no mutation verb, so an answer about what a message says can only come from the
 *     message.
 *  2. `mail_draft` can never send. Its script is built around `make new outgoing message` and the
 *     test asserts the send verb cannot appear in it at all; the draft is proved by reading the
 *     front of the drafts mailbox back, and the tool says so honestly when it cannot.
 *
 * `packs/mail.ts` is not yet registered in `src/app-tools/packs.ts` (the integrator does that),
 * so this file adds `MAIL_PACK.tools` to the tool list itself, exactly like the calendar test.
 */
const tools = [...allPackTools(), ...MAIL_PACK.tools];
const index = buildIndex(tools);
const choose = (text: string, app?: string) => selectTools(text, { app, index }).map(match => match.tool.name);

const samples: Record<string, Record<string, string>> = {
  mail_recent: { limit: '5', mailbox: 'INBOX' },
  mail_find: { query: 'bank', mailbox: 'INBOX' },
  mail_read: { subject: 'Invoice 442', sender: 'the bank', chars: '4000' },
  mail_draft: { to: 'landlord@example.com', subject: 'Rent is paid', body: 'The rent is paid for this month.' },
};

const planOf = (name: string, args: Record<string, string>) => {
  const tool = toolByName(name) ?? MAIL_PACK.tools.find(candidate => candidate.name === name);
  assert.ok(tool, `${name} is not in the mail pack or the registry`);
  return tool.plan(args);
};

const scriptOf = (name: string, args: Record<string, string>): string => {
  const planned = planOf(name, args);
  assert.equal(planned.kind, 'osascript', `${name} must be AppleScript`);
  return planned.kind === 'osascript' ? planned.script : '';
};

/** Everything about a tool a request could match on, the same text retrieval embeds. */
function retrievalText(tool: (typeof MAIL_PACK.tools)[number]): string {
  return [
    tool.pack,
    tool.name.replace(/_/g, ' '),
    tool.app,
    tool.description,
    ...tool.args.map(arg => `${arg.name} ${arg.description}`),
    ...tool.examples,
    ...tool.keywords,
  ].join('\n');
}

test('the mail pack names, describes and argues its tools well enough to be chosen', () => {
  const seen = new Set<string>();
  for (const tool of MAIL_PACK.tools) {
    assert.ok(!seen.has(tool.name), `${tool.name} is declared twice in the pack`);
    seen.add(tool.name);
    assert.match(tool.name, /^mail_[a-z]+(_[a-z]+)*$/, `${tool.name} is not mail_prefixed_snake_case`);
    assert.equal(tool.pack, 'mail');
    assert.equal(tool.app, 'Mail');
    assert.equal(tool.bundleId, 'com.apple.mail');

    const sentences = tool.description.split(/\.\s+/).filter(Boolean);
    assert.ok(sentences.length >= 3, `${tool.name} needs at least three sentences, has ${sentences.length}`);
    assert.match(tool.description, /Use this when/, `${tool.name} does not say when to use it`);
    assert.match(tool.description, /does not|never|only|read only/, `${tool.name} does not say what it will not do`);

    assert.ok(tool.examples.length >= 2, `${tool.name} needs at least two owner phrasings`);
    assert.ok(tool.keywords.length >= 4, `${tool.name} needs retrieval keywords`);
    for (const example of tool.examples) {
      assert.doesNotMatch(example, /@/, `${tool.name} example "${example}" carries an email address`);
      // No proper nouns: an example with a capitalised word that is not "I" would leak a name.
      assert.doesNotMatch(example.replace(/\bI\b/g, ''), /\b[A-Z][a-z]/, `${tool.name} example "${example}" looks like it carries a proper noun`);
    }
    for (const arg of tool.args) {
      assert.match(arg.name, /^[a-z][a-z0-9_]*$/, `${tool.name}.${arg.name} is not snake_case`);
      assert.ok(arg.description.length > 20, `${tool.name}.${arg.name} needs a real description`);
    }
    for (const phrase of tool.notFor ?? []) {
      assert.ok(tokenize(phrase).length >= 2, `${tool.name} notFor "${phrase}" has fewer than two meaningful words`);
    }
    // Coding vocabulary must never appear in anything retrieval can match on.
    assert.doesNotMatch(
      retrievalText(tool),
      /\b(?:task|tasks|todo|issue|ticket)\b/i,
      `${tool.name} carries coding vocabulary`,
    );
  }
  assert.equal(MAIL_PACK.id, 'mail');
  assert.ok(MAIL_PACK.summary.length > 20);
  // writes drives read/write polarity in retrieval, so it has to be honest per tool.
  const writes = Object.fromEntries(MAIL_PACK.tools.map(tool => [tool.name, tool.writes]));
  assert.deepEqual(writes, {
    mail_recent: false,
    mail_find: false,
    mail_read: false,
    mail_draft: true,
  });
  // The order the pack declares is the order the answer documents them in.
  assert.deepEqual(MAIL_PACK.tools.map(tool => tool.name), ['mail_recent', 'mail_find', 'mail_read', 'mail_draft']);
});

test('mail_draft creates a draft and can never send', () => {
  const tool = MAIL_PACK.tools.find(candidate => candidate.name === 'mail_draft')!;
  assert.equal(tool.writes, true);
  assert.match(tool.description, /never sends|does not send/, 'the description must say plainly that it never sends');
  assert.deepEqual(tool.args.map(arg => [arg.name, arg.required]), [['to', true], ['subject', true], ['body', true]]);

  const script = scriptOf('mail_draft', samples.mail_draft);
  assert.match(script, /make new outgoing message/);
  assert.match(script, /visible:false/);
  assert.doesNotMatch(script, /\bsend\b/i, 'the draft script must not carry the send verb');
  // The proof is read back out of the front of Mail's drafts, not assumed from the make command.
  assert.match(script, /message 1 of drafts mailbox/);
  assert.match(script, /count of words of/);
  assert.match(script, /not sent/);
  // When the draft is not visible yet it says so rather than claiming success.
  assert.match(script, /it was not at the front of the drafts mailbox when I looked/);
});

test('every read-only tool is AppleScript that returns and carries no mutation', () => {
  for (const tool of MAIL_PACK.tools) {
    if (tool.writes) continue;
    const planned = tool.plan(samples[tool.name] ?? {});
    assert.equal(planned.kind, 'osascript', `${tool.name} must be AppleScript`);
    if (planned.kind !== 'osascript') continue;
    assert.match(planned.script, /\breturn\b/, `${tool.name} returns nothing`);
    assert.doesNotMatch(
      planned.script,
      /\bmake new\b|\bdelete\b|\bset (?:name|content|subject) of\b/i,
      `${tool.name} carries a mutation verb`,
    );
  }
});

test('every tool refuses a bad or missing argument in words, and never throws', () => {
  const refusals: [string, Record<string, string>, RegExp][] = [
    ['mail_recent', { limit: 'lots' }, /whole number of messages/],
    ['mail_find', {}, /word or phrase to look for/],
    ['mail_read', {}, /subject of the message to read/],
    ['mail_read', { subject: 'Invoice 442' }, /sender of the message too/],
    ['mail_read', { subject: 'Invoice 442', sender: 'the bank', chars: 'lots' }, /character limit has to be a whole number/],
    ['mail_draft', {}, /recipient for the draft/],
    ['mail_draft', { to: 'landlord@example.com' }, /subject for the draft/],
    ['mail_draft', { to: 'landlord@example.com', subject: 'Rent is paid' }, /body for the draft/],
  ];
  for (const [name, args, message] of refusals) {
    const planned = planOf(name, args);
    assert.equal(planned.kind, 'osascript', `${name} should refuse with a sentence`);
    const script = planned.kind === 'osascript' ? planned.script : '';
    assert.match(script, message, `${name} with ${JSON.stringify(args)} did not refuse in words`);
    // A refusal must not carry the mutation it is refusing.
    assert.doesNotMatch(script, /\bmake new\b|\bdelete\b|\bset (?:name|content|subject) of\b/i, `${name} refusal still carries a write`);
  }
  // A missing limit on a read-only list is not an error: it falls back to the default.
  assert.match(scriptOf('mail_recent', {}), /set cap to 10/);
});

test('the owner phrasings for the mail tools pick the right tool', () => {
  assert.equal(choose('summarise my mail')[0], 'mail_recent');
  assert.equal(choose('give me a summary of my inbox', 'Mail')[0], 'mail_recent');
  assert.equal(choose('find the message from the bank', 'Mail')[0], 'mail_find');
  assert.equal(choose('what did the last message about the invoice say', 'Mail')[0], 'mail_read');
  assert.equal(choose('draft a reply to the landlord saying the rent is paid', 'Mail')[0], 'mail_draft');
});

test('the mail tools are not selected for coding work', () => {
  assert.deepEqual(choose('write the failing test'), []);
  assert.deepEqual(choose('fix the failing unit test'), []);
  assert.deepEqual(choose('add a retry to the sync loop'), []);
  assert.deepEqual(choose('add a checks column to task_contracts'), []);
  assert.deepEqual(choose('read the router contract code'), []);
});

test('mail_recent slices the body and mail_find is capped, and both say so', () => {
  const recent = MAIL_PACK.tools.find(tool => tool.name === 'mail_recent')!;
  assert.match(recent.description, /at most 10|the most allowed \(25\)/);
  const recentScript = scriptOf('mail_recent', { limit: '9999' });
  assert.match(recentScript, /set cap to 25/, 'the limit is capped at 25');
  assert.match(recentScript, /set slice to 400/);
  assert.match(recentScript, /content of msg/);
  assert.match(recentScript, /\[cut off here: the message continues\]/);

  const find = MAIL_PACK.tools.find(tool => tool.name === 'mail_find')!;
  assert.match(find.description, /no more than 300 messages/);
  assert.match(find.description, /no more than 12 matches/);
  const findScript = scriptOf('mail_find', samples.mail_find);
  assert.match(findScript, /set scanCap to 300/);
  assert.match(findScript, /set matchCap to 12/);
  // Bodies are never read by the search: only the sender, subject and date lines.
  assert.doesNotMatch(findScript, /content of msg/);

  const readScript = scriptOf('mail_read', { subject: 'Invoice 442', sender: 'the bank', chars: '99999' });
  assert.match(readScript, /set cap to 40000/, 'the character cap is capped at 40000');
});

/**
 * T0 in the verification ladder: the script has to compile against Mail's own dictionary.
 * `osacompile` only reads Mail.app's .sdef and needs no Automation grant, so this catches a
 * script that would fail the first time the owner asked for it. A live run (T4) still needs the
 * owner's one-time Automation allow-click and has not happened.
 */
test('every mail AppleScript tool compiles against the Mail dictionary', { skip: process.platform !== 'darwin' ? 'macOS only' : false }, () => {
  if (!existsSync('/usr/bin/osacompile')) return;
  const dir = mkdtempSync(join(tmpdir(), 'ffd-mail-osacompile-'));
  try {
    for (const tool of MAIL_PACK.tools) {
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