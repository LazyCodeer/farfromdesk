import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { masterWorkspaces, pickedWorkspace } from '../src/masters.js';

// Temp folders are never offered as projects, so this one lives in the checkout.
// The owner could only create a Claude Desktop coordinator in its private folder: desktop apps got
// no project list, and a folder counted only with an open chat (owner, 4 November 2026).
test('a Claude Desktop project folder is offered without an open chat, and a picked folder is accepted', () => {
  const dir = mkdtempSync(join(process.cwd(), '.ffd-folder-test-')), file = join(dir, 'a.txt');
  try {
    const sessions = [{ id: 'closed', cwd: dir, available: false, updatedAt: 2 }];
    const [w] = masterWorkspaces('claude', 'desktop', sessions);
    assert.equal(w.available, true);
    assert.equal(w.launcherId, undefined, 'a closed chat is not a launcher');
    const picked = pickedWorkspace(dir);
    assert.equal(picked.available, true);
    assert.equal(picked.id, `folder:${dir}`);
    writeFileSync(file, 'x');
    assert.throws(() => pickedWorkspace(file), /folder, not a file/);
    assert.throws(() => pickedWorkspace('relative/path'), /existing project folder/);
    assert.throws(() => pickedWorkspace(join(dir, 'missing')), /no longer exists/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
