import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { openDirectMac, directMacAllowed, directMacGrant } from '../src/direct-mac.js';

// A direct /muse run gets the owner's Mac tools for that run only, and the token never appears in
// the prompt it is given.
test('a direct run pass works only for its run, keeps the token out of the prompt, and ends with the run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ffd-direct-mac-')), store = new Store(':memory:');
  try {
    const mac = openDirectMac(store, dir, '47961', 'muse:wa:1');
    const file = /cat '([^']+)'/.exec(mac.note)![1], token = readFileSync(file, 'utf8');
    assert.ok(!mac.note.includes(token), 'the token is read from a file, never written in the prompt');
    assert.match(mac.note, /Apple Notes/);
    assert.equal(directMacAllowed(store, 'muse:wa:1', token), true);
    assert.equal(directMacAllowed(store, 'muse:wa:2', token), false);
    assert.equal(directMacAllowed(store, 'muse:wa:1', 'x'.repeat(64)), false);
    mac.close();
    assert.equal(directMacAllowed(store, 'muse:wa:1', token), false);
    assert.equal(existsSync(file), false);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

// Live, 5 Nov 2026: Muse read "draft an X post" as a git pull request, grepped the app's JS for action
// arguments, and lost every window ref on the follow-up message, which is a new run.
test('the note names X and every action, and refs outlive one run of the same chat while the pass does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ffd-direct-mac-')), store = new Store(':memory:');
  try {
    store.destination = () => 'tg:1:2';
    const a = openDirectMac(store, dir, '47961', 'muse:tg:1:2:10'), b = openDirectMac(store, dir, '47961', 'muse:tg:1:2:11');
    for (const word of ['x.com', 'pull request', 'social_drafts', 'pick_file', 'new_tab{windowRef', 'actionId', '"send":true']) assert.ok(a.note.includes(word), word);
    const tokenA = readFileSync(/cat '([^']+)'/.exec(a.note)![1], 'utf8'), tokenB = readFileSync(/cat '([^']+)'/.exec(b.note)![1], 'utf8');
    const ga = directMacGrant(store, 'muse:tg:1:2:10', tokenA)!, gb = directMacGrant(store, 'muse:tg:1:2:11', tokenB)!;
    assert.equal(ga.scope, gb.scope, 'two messages in one chat share window and tab refs');
    assert.equal(ga.destination, 'tg:1:2');
    assert.equal(directMacGrant(store, 'muse:tg:1:2:11', tokenA), undefined, 'the pass stays per run');
    const other = openDirectMac(store, dir, '47961', 'cursor:tg:1:2:12'), tokenC = readFileSync(/cat '([^']+)'/.exec(other.note)![1], 'utf8');
    assert.notEqual(directMacGrant(store, 'cursor:tg:1:2:12', tokenC)!.scope, ga.scope, 'another runner does not share refs');
    a.close(); b.close(); other.close();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
