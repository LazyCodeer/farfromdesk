import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { openDirectMac, directMacAllowed } from '../src/direct-mac.js';

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
