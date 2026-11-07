import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'ffd-tool-attach-'));
process.env.WSB_STATE_DIR = root; process.env.FARFROMDESK_HOME = join(root, 'home');
test.after(() => rmSync(root, { recursive: true, force: true }));
const { Store } = await import('../src/store.js');
const { ownerAttachmentTool, ownerAttachmentTarget, keepToolAttachment } = await import('../src/owner-commands.js');

function fixture() {
  const store = new Store(':memory:');
  store.set('whatsapp-owner', 'synthetic-owner');
  const r = { store, stopped: false, coordinator: undefined } as any;
  const select = (target: unknown) => store.set(`owner-target:${store.destination()}`, JSON.stringify(target));
  return { store, r, select };
}

test('a file sent in DeepSeek, Muse or Cursor mode goes to that tool', () => {
  const { store, r, select } = fixture();
  try {
    for (const tool of ['deepseek', 'muse', 'cursor']) {
      select({ kind: 'tool', tool });
      assert.equal(ownerAttachmentTool(r, { id: 'wa:1', text: 'what is this?' } as any), tool);
    }
    assert.equal(ownerAttachmentTool(r, { id: 'wa:2', text: '', quotedId: 'q' } as any), undefined, 'a quoted reply keeps its session');
    select({ kind: 'brain' });
    assert.equal(ownerAttachmentTool(r, { id: 'wa:3', text: '' } as any), undefined);
    assert.throws(() => ownerAttachmentTarget(r, { id: 'wa:3', text: '' } as any), /Meta brain mode accepts text/);
  } finally { store.close(); }
});

test('the file is kept by path for the tool to open', () => {
  const src = join(root, 'download.pdf'); writeFileSync(src, '%PDF-1.4 synthetic');
  const kept = keepToolAttachment('wa:ABC/../x', { filename: 'report.pdf', download: { path: src } });
  assert.ok(kept.startsWith(join(root, 'tool-attachments')));
  assert.ok(!kept.includes('..'));
  assert.equal(readFileSync(kept, 'utf8'), '%PDF-1.4 synthetic');
  const fromBuffer = keepToolAttachment('wa:DEF', { filename: 'image.jpg', data: Buffer.from('jpeg') });
  assert.equal(readFileSync(fromBuffer, 'utf8'), 'jpeg');
  assert.throws(() => keepToolAttachment('wa:GHI', { filename: '../evil', data: Buffer.from('x') }), /simple file name/);
});

test('videos are accepted as files when their header matches', async () => {
  const { validateFileHeader, fileType } = await import('../src/file-types.js');
  const { incomingMetadata } = await import('../src/attachments.js');
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(16)]);
  assert.doesNotThrow(() => validateFileHeader('clip.mp4', mp4));
  assert.doesNotThrow(() => validateFileHeader('clip.mov', mp4));
  assert.doesNotThrow(() => validateFileHeader('clip.webm', Buffer.from([26, 69, 223, 163, 0, 0])));
  assert.throws(() => validateFileHeader('clip.mp4', Buffer.from('MZ not a video at all')), /Invalid video signature/);
  assert.equal(fileType('clip.mp4').mime, 'video/mp4');
  assert.equal(incomingMetadata({ mimetype: 'video/mp4', fileLength: 1000 }, 'document').filename, 'video.mp4', 'a WhatsApp video without a name');
  assert.equal(incomingMetadata({ mimetype: 'video/mp4', fileName: 'trip.mp4', fileLength: 1000 }, 'document').filename, 'trip.mp4');
});
