import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearStage, recordStage } from '../src/startup-stage.js';

test('the step being run is on disk before the work starts, and cleared after', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ffd-stage-'));
  try {
    const file = join(dir, 'startup-stage.json');
    recordStage(dir, 'listing your session folders');
    const written = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(written.stage, 'listing your session folders');
    assert.ok(typeof written.at === 'number');
    clearStage(dir);
    assert.throws(() => readFileSync(file, 'utf8'));
    // Clearing twice, or without a stage file, is not an error.
    clearStage(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stage that cannot be written never breaks startup', () => {
  assert.doesNotThrow(() => recordStage('/nonexistent-state-dir-for-stage', 'x'));
  assert.doesNotThrow(() => clearStage('/nonexistent-state-dir-for-stage'));
});

test('a stale stage file from a killed run is left for the app to read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ffd-stage-'));
  try {
    const file = join(dir, 'startup-stage.json');
    writeFileSync(file, JSON.stringify({ stage: 'listing your session folders', at: 1 }));
    // Nothing clears it: a process that froze cannot run, and the app needs to see
    // the step it reached.
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).stage, 'listing your session folders');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
