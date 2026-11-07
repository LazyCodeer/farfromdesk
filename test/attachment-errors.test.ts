import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentRefusal } from '../src/attachment-errors.js';

test('a file sent in a text-only mode tells the owner why, on every channel', () => {
  for (const m of [
    'DeepSeek Harness mode accepts text. Choose /claude or /codex for a file, or quote the intended session reply.',
    'Meta brain mode accepts text and voice. Choose /claude or /codex for a file, or quote the intended session reply.',
    'Your chosen session is paused or unavailable. Select it again. Nothing was sent elsewhere.',
    'Choose an exact session before sending an attachment.',
    'Send the task as a text or voice message first. Attachment task review is not available yet. Nothing was sent.',
    'Telegram bot downloads must be at most 20 MB.',
  ]) assert.equal(attachmentRefusal(new Error(m)), m);
});

test('internal errors stay behind the generic message', () => {
  assert.equal(attachmentRefusal(new Error('SQLITE_BUSY: database is locked')), undefined);
  assert.equal(attachmentRefusal(new Error('fetch failed')), undefined);
  assert.equal(attachmentRefusal('Choose an exact session'), undefined);
});
