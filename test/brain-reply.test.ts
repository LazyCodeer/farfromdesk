import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerReply, isBookkeeping } from '../src/brain-reply.js';

test('a reply the owner already reads well comes back byte-identical', () => {
  // Idempotence matters twice over: the reply receipt hashes the text, so the same answer
  // has to produce the same bytes on a second pass.
  const good = ['Opened Comet.', 'Pressed escape in Comet.', 'Hi Sagar, good to meet you. Send a task, or ask where are we.', 'I read Comet (Inbox).\n\n- Compose\n- Unread', '📋 *#1 open TextEdit and type hello*\n- Session: coordinator setup\n- State: in progress', '- Compose\n- Unread', 'Do you mean #1 Fix the footer\n\n1. #1 Fix the footer\n2. #2 Website links'].join('\n\n');
  assert.equal(ownerReply(good), good);
  assert.equal(ownerReply(ownerReply(good)), good);
});

test('driver bookkeeping never reaches the owner', () => {
  // Measured live, these two arrived as a second paragraph under the real answer.
  assert.equal(ownerReply('Pressed escape in Comet.\n\nfull read (no usable earlier read of this window to diff against)'), 'Pressed escape in Comet.');
  assert.equal(ownerReply('Pressed escape in Comet.\n\nno change since s00000002; focused element is [90] AXList "Select email"'), 'Pressed escape in Comet.');
  assert.equal(isBookkeeping('full read (no usable earlier read of this window to diff against)'), true);
  assert.equal(isBookkeeping('no change since s00000001'), true);
  assert.equal(isBookkeeping('Opened Comet.'), false);
  assert.equal(isBookkeeping('No change was needed.'), false);
  // A reply that is nothing but bookkeeping keeps its own words: emptying it would fail
  // the receipt's identity check and hide that something did happen.
  assert.equal(ownerReply('full read (no usable earlier read of this window to diff against)'), 'full read (no usable earlier read of this window to diff against)');
});

test('no machine output and no long dash reaches a phone', () => {
  assert.equal(ownerReply('It worked — really'), 'It worked, really');
  assert.equal(ownerReply('It worked – really'), 'It worked, really');
  // The refusal envelope is an array of typed parts, and it was pasted as JSON.
  assert.equal(ownerReply('I could not do that: [{"type":"text","text":"no element matched"}].'), 'I could not do that: no element matched.');
  assert.doesNotMatch(ownerReply('I could not do that: [{"type":"text","text":"boom\\"quoted\\""}].'), /"type"/);
});

test('a semicolon dump becomes a list, prose does not', () => {
  // Measured live: a browser window's labels arrived as one run of fourteen items.
  const dump = ownerReply('Apple; Comet; File; Edit; View; Assistant; History; Bookmarks; Profiles; Tab; Window; Help');
  assert.match(dump, /^- Apple$/m);
  assert.match(dump, /^- Comet$/m);
  assert.equal(dump.split('\n').length, 10, 'the list is capped for a phone');
  assert.ok(dump.split('\n').every(line => line.startsWith('- ')), 'one item per line');
  // Two or three parts are ordinary prose and stay as they are.
  assert.equal(ownerReply('#1 thing: in progress, sent to session; no reply yet'), '#1 thing: in progress, sent to session; no reply yet');
});

test('a line too long for a phone is broken at a space, not mid word', () => {
  const long = 'word '.repeat(120).trim();
  const out = ownerReply(long);
  assert.ok(out.split('\n').every(line => line.length <= 320), 'each line fits');
  assert.equal(out.replace(/\n/g, ' '), long, 'no characters are lost');
  assert.doesNotMatch(out, /wor\nd/, 'never splits a word');
  const bullet = ownerReply(Array.from({ length: 6 }, (_, i) => `item ${i} ${'x'.repeat(60)}`).join('; '));
  assert.ok(bullet.split('\n').every(line => line.length <= 320), 'a long item is wrapped too');
});

test('a dash never eats a newline, and a code span is left alone', () => {
  // The rule used to allow whitespace on both sides of the dash, which swallowed the
  // newline: three lines became one run-on sentence.
  assert.equal(ownerReply('Result:\n- first\n- second'), 'Result:\n- first\n- second');
  assert.equal(ownerReply('Result:\n– first\n– second'), 'Result:\n- first\n- second');
  assert.equal(ownerReply('Result: first – second'), 'Result: first, second');
  assert.equal(ownerReply('text\n—'), 'text', 'a line that is only punctuation is not a line');
  // Quoted code is not prose: a dash inside it is the writer's, not this formatter's.
  assert.equal(ownerReply('```\nconst a = b – c;\n```'), '```\nconst a = b – c;\n```');
  assert.equal(ownerReply('Run `a – b` now'), 'Run `a – b` now');
});

test('control characters cannot ride a reply to a phone', () => {
  assert.equal(ownerReply('done\u0007 \u202eok'), 'done ok');
  assert.equal(ownerReply('  spaced   out  '), 'spaced out');
  assert.equal(ownerReply('kept\n\n\n\nonce'), 'kept\n\nonce', 'blank runs collapse');
  assert.equal(ownerReply(''), '');
});