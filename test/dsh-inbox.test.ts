import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimMessages, dropMessage, findMessage, inboxDir, listMessages, messagePrompt,
  pendingMessages, sendMessage, settleMessages,
} from '../src/dsh-inbox.js';

function root(label: string) {
  return mkdtempSync(join(tmpdir(), `ffd-inbox-${label}-`));
}

const folder = '/tmp/ffd-inbox-workspace';

test('a message is prepared, claimed once, and settled as received', () => {
  const home = root('deliver');
  try {
    const sent = sendMessage({ root: home, folder, label: 'notes', text: 'The build is 2399.', from: 'calendar' });
    assert.equal(sent.state, 'prepared', 'writing the record is not delivery');
    assert.deepEqual(pendingMessages(home, folder, 'notes').map(message => message.id), [sent.id]);

    const claimed = claimMessages(home, folder, 'notes');
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].state, 'dispatching', 'claiming happens before the turn starts');
    assert.deepEqual(claimMessages(home, folder, 'notes'), [], 'a claimed message is never taken twice');

    settleMessages(home, folder, 'notes', [sent.id], 'received');
    assert.equal(findMessage(home, folder, 'notes', sent.id)?.state, 'received');
    assert.deepEqual(pendingMessages(home, folder, 'notes'), [], 'a received message is not pending');
    assert.deepEqual(claimMessages(home, folder, 'notes'), [], 'and it is never delivered again');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a failed turn leaves the message unknown, with the reason, and never redelivers it', () => {
  const home = root('failed');
  try {
    const sent = sendMessage({ root: home, folder, label: 'notes', text: 'Anything?', from: 'calendar' });
    claimMessages(home, folder, 'notes');
    settleMessages(home, folder, 'notes', [sent.id], 'unknown', 'DeepSeek Harness exited with code 1');
    const stored = findMessage(home, folder, 'notes', sent.id);
    assert.equal(stored?.state, 'unknown');
    assert.match(stored?.note ?? '', /exited with code 1/, 'the reason is recorded, not guessed');
    assert.deepEqual(claimMessages(home, folder, 'notes'), [], 'an uncertain delivery is reported, not retried');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('messages belong to a label, not to a folder', () => {
  const home = root('labels');
  try {
    sendMessage({ root: home, folder, label: 'notes', text: 'for notes', from: 'owner' });
    sendMessage({ root: home, folder, label: 'calendar', text: 'for calendar', from: 'owner' });
    assert.deepEqual(listMessages(home, folder, 'notes').map(message => message.text), ['for notes']);
    assert.deepEqual(listMessages(home, folder, 'calendar').map(message => message.text), ['for calendar']);
    assert.deepEqual(listMessages(home, '/tmp/ffd-inbox-other', 'notes'), [], 'another folder is another inbox');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a settled message is final, whatever the later turn says', () => {
  const home = root('final');
  try {
    const sent = sendMessage({ root: home, folder, label: 'notes', text: 'once', from: 'owner' });
    claimMessages(home, folder, 'notes');
    settleMessages(home, folder, 'notes', [sent.id], 'received');
    const again = settleMessages(home, folder, 'notes', [sent.id], 'unknown', 'a later failure');
    assert.deepEqual(again, [], 'only a dispatching message can be settled');
    assert.equal(findMessage(home, folder, 'notes', sent.id)?.state, 'received');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the prompt names the sender, the id and the words', () => {
  const home = root('prompt');
  try {
    const first = sendMessage({ root: home, folder, label: 'notes', text: 'Please check the queue.', from: 'calendar' });
    const second = sendMessage({ root: home, folder, label: 'notes', text: 'Second.', from: 'owner' });
    const prompt = messagePrompt(claimMessages(home, folder, 'notes'));
    assert.match(prompt, new RegExp(`Message from calendar \\(${first.id}\\):\\nPlease check the queue\\.`));
    assert.match(prompt, new RegExp(`Message from owner \\(${second.id}\\):\\nSecond\\.`));
    assert.ok(prompt.endsWith('\n\n'), 'the task follows the messages, separated');
    assert.equal(messagePrompt([]), '', 'no messages means the prompt is untouched');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an unreadable record is ignored, not treated as a message', () => {
  const home = root('broken');
  try {
    const sent = sendMessage({ root: home, folder, label: 'notes', text: 'real', from: 'owner' });
    const directory = inboxDir(home, folder, 'notes');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'broken.json'), '{ not json', 'utf8');
    writeFileSync(join(directory, 'half.json.tmp'), '{"id":"half"', 'utf8');
    assert.deepEqual(listMessages(home, folder, 'notes').map(message => message.id), [sent.id]);
    assert.ok(readdirSync(directory).includes('broken.json'), 'the broken file is left for a person');
    dropMessage(home, folder, 'notes', sent.id);
    assert.deepEqual(listMessages(home, folder, 'notes'), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
