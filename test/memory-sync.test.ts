import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeMemory, memoryHashes, readMemory, writeMemory } from '../src/memory-sync.js';

test('memory merge: one-sided edits and deletes win, both-sided edits keep the loser as .conflict.md', () => {
  const f = (text: string, at = 1) => ({ text, at });
  const base = memoryHashes({ 'memory/a.md': f('a'), 'memory/b.md': f('b'), 'memory/c.md': f('c'), 'memory/d.md': f('d') });
  const local = { 'memory/a.md': f('a2'), 'memory/b.md': f('b'), 'memory/d.md': f('d-local', 5), 'memory/new.md': f('n') };
  const remote = { 'memory/a.md': f('a'), 'memory/c.md': f('c'), 'memory/d.md': f('d-remote', 9), 'memory/r.md': f('r') };
  const m = mergeMemory(base, local, remote);
  assert.equal(m['memory/a.md'].text, 'a2', 'local edit');
  assert.equal(m['memory/b.md'], undefined, 'remote delete');
  assert.equal(m['memory/c.md'], undefined, 'local delete');
  assert.equal(m['memory/d.md'].text, 'd-remote', 'newer wins');
  assert.equal(m['memory/d.conflict.md'].text, 'd-local', 'older kept');
  assert.equal(m['memory/new.md'].text, 'n');
  assert.equal(m['memory/r.md'].text, 'r');
  // First sync between two laptops: no base, nothing lost.
  const first = mergeMemory({}, { 'memory/x.md': f('mine', 1) }, { 'memory/x.md': f('theirs', 2), 'memory/y.md': f('y') });
  assert.deepEqual(Object.keys(first).sort(), ['memory/x.conflict.md', 'memory/x.md', 'memory/y.md']);

  const root = mkdtempSync(join(tmpdir(), 'ffd-mem-'));
  try {
    mkdirSync(join(root, 'memory/sub'), { recursive: true });
    writeFileSync(join(root, 'memory/sub/keep.md'), 'k'); writeFileSync(join(root, 'memory/gone.md'), 'g'); writeFileSync(join(root, 'memory/notes.txt'), 't');
    const have = readMemory(root);
    assert.deepEqual(Object.keys(have).sort(), ['memory/gone.md', 'memory/sub/keep.md'], 'only .md memory files');
    writeMemory(root, have, { 'memory/sub/keep.md': have['memory/sub/keep.md'], 'memory/fresh.md': f('fresh'), '../evil.md': f('x') });
    assert.equal(readFileSync(join(root, 'memory/fresh.md'), 'utf8'), 'fresh');
    assert.equal(existsSync(join(root, 'memory/gone.md')), false);
    assert.equal(existsSync(join(root, 'memory/notes.txt')), true);
    assert.equal(existsSync(join(root, '../evil.md')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
