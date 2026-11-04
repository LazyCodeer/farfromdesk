import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installProviderHooks, providerHookState } from '../src/provider-hooks.js';

/** A home with one provider config directory in it. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'ffd-hooks-'));
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  return {
    home,
    file: (provider: 'codex' | 'claude') =>
      join(home, provider === 'codex' ? '.codex/hooks.json' : '.claude/settings.json'),
    close: () => rmSync(home, { recursive: true, force: true }),
  };
}

const target = (home: string, provider: 'codex' | 'claude') => ({
  provider,
  node: '/usr/local/bin/node',
  cli: '/Applications/FarFromDesk.app/cli.js',
  stateDir: '/nonexistent-but-absolute/state',
  port: 47961,
  home,
  // No NODE_TEST_CONTEXT here on purpose: this is the production guard, and the
  // provider path is an explicit temporary home, so no owner profile is touched.
  env: {},
});

test('a provider config that cannot be a file is reported, and never opened', () => {
  const f = fixture();
  try {
    // A FIFO at the hook path is the shape that used to freeze the whole bridge:
    // the synchronous read blocked forever, so the port stopped answering and no
    // permission prompt could ever be reported.
    execFileSync('/usr/bin/mkfifo', [f.file('codex')]);
    const started = Date.now();
    const report = installProviderHooks(target(f.home, 'codex'));
    assert.equal(report.state, 'unreadable');
    assert.match(String(report.detail), /not a regular file/);
    assert.ok(Date.now() - started < 5000, 'the check must not wait on the file');

    const state = providerHookState(target(f.home, 'codex'));
    assert.equal(state.state, 'unreadable');
    assert.match(String(state.detail), /not a regular file/);
  } finally {
    f.close();
  }
});

test('a directory at the hook path is not treated as config either', () => {
  const f = fixture();
  try {
    mkdirSync(f.file('claude'));
    const report = installProviderHooks(target(f.home, 'claude'));
    assert.equal(report.state, 'unreadable');
    const state = providerHookState(target(f.home, 'claude'));
    assert.equal(state.state, 'unreadable');
  } finally {
    f.close();
  }
});

test('a regular config file is still installed and read back', () => {
  const f = fixture();
  try {
    writeFileSync(f.file('codex'), JSON.stringify({ hooks: { Stop: [] }, other: true }));
    const report = installProviderHooks(target(f.home, 'codex'));
    assert.equal(report.state, 'installed');
    const installed = providerHookState(target(f.home, 'codex'));
    assert.equal(installed.state, 'current');
    // Another tool's data survives, which is the whole point of merging.
    const raw = JSON.parse(
      execFileSync('/bin/cat', [f.file('codex')], { encoding: 'utf8' }),
    );
    assert.equal(raw.other, true);
  } finally {
    f.close();
  }
});