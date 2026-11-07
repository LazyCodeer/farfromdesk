import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { openDirectMac, directMacAllowed, bridgeCurl } from '../src/direct-mac.js';

// A direct /muse run gets the owner's Mac tools for that run only, and the token never appears in
// the prompt it is given.
test('a direct run pass works only for its run, keeps the token out of the prompt, and ends with the run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ffd-direct-mac-')), store = new Store(':memory:');
  try {
    const mac = openDirectMac(store, dir, '47961', 'muse:wa:1', 'darwin');
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

// On Windows the token never passes through a shell: curl reads the whole header from a file, and
// the command reads the same in PowerShell, bash and cmd (Windows PowerShell's own curl is an alias).
test('a Windows direct run gives curl.exe a header file and names the PC apps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ffd-direct-win-')), store = new Store(':memory:');
  try {
    const run = openDirectMac(store, dir, '47961', 'muse:wa:1', 'win32');
    const file = /-H "@([^"]+)"/.exec(run.note)![1];
    const token = /^Authorization: Bearer ([0-9a-f]{64})\n$/.exec(readFileSync(file, 'utf8'))![1];
    assert.ok(!run.note.includes(token));
    assert.doesNotMatch(run.note, /\$\(|plutil|cat '|Apple|Safari|Messages|Mac\b/);
    assert.ok(run.note.includes('curl.exe -s --max-time 70 -X POST "http://127.0.0.1:47961/api/direct/desktop-control" -H "Content-Type: application/json" -H "X-Direct-Run: muse:wa:1" -H "@'));
    assert.ok(run.note.includes('--data-binary "@-"'));
    assert.match(run.note, /the owner's PC apps \(Outlook calendar, mail and tasks, OneNote/);
    assert.match(run.note, /\\uXXXX escape/);
    assert.equal(directMacAllowed(store, 'muse:wa:1', token), true);
    run.close();
    assert.equal(existsSync(file), false);
    assert.equal(bridgeCurl('darwin', 'http://x', ['A: b'], { posixToken: 'T' }), `curl -s --max-time 70 -X POST 'http://x' -H 'A: b' -H "Authorization: Bearer T" --data-binary @-`);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
