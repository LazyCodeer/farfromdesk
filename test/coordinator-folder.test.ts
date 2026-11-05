import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { masterWorkspaces, pickedWorkspace } from '../src/masters.js';

// Temp folders are never offered as projects, so this one lives in the checkout.
// The owner could only create a Claude Desktop coordinator in its private folder: desktop apps got
// no project list, and a folder counted only with an open chat (owner, 4 November 2026).
// Claude Desktop cannot open a chat with a prompt on its own, so a folder without an open chat is
// offered only once an owner-connected Desktop chat can start it (5 November 2026: the picker
// defaulted to such a folder and setup failed at its first step).
test('a Claude Desktop folder without an open chat needs a connected launcher, and a picked folder is accepted', () => {
  const dir = mkdtempSync(join(process.cwd(), '.ffd-folder-test-')), file = join(dir, 'a.txt');
  try {
    const sessions = [{ id: 'closed', cwd: dir, available: false, updatedAt: 2 }];
    const [none] = masterWorkspaces('claude', 'desktop', sessions);
    assert.equal(none.available, false, 'nothing can start a chat there');
    const [w] = masterWorkspaces('claude', 'desktop', sessions, undefined, true);
    assert.equal(w.available, true, 'a connected launcher can start it');
    assert.equal(w.launcherId, undefined, 'a closed chat is not a launcher');
    const [open] = masterWorkspaces('claude', 'desktop', [{ id: 'open', cwd: dir, available: true, updatedAt: 3 }]);
    assert.equal(open.available, true);assert.equal(open.launcherId, 'open', 'an open chat in the folder starts it');
    assert.equal(masterWorkspaces('claude', 'cli', sessions)[0].available, true, 'Claude CLI needs no launcher');
    const picked = pickedWorkspace(dir);
    assert.equal(picked.available, true);
    assert.equal(picked.id, `folder:${dir}`);
    writeFileSync(file, 'x');
    assert.throws(() => pickedWorkspace(file), /folder, not a file/);
    assert.throws(() => pickedWorkspace('relative/path'), /existing project folder/);
    assert.throws(() => pickedWorkspace(join(dir, 'missing')), /no longer exists/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
