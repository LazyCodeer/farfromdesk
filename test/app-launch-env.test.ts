import test from 'node:test';
import assert from 'node:assert/strict';
import { userInfo } from 'node:os';
import { appLaunchEnvironment } from '../src/cursor-paths.js';

// Live, 8 Nov 2026: Claude Desktop launched by Local inherited its private HOME, lost the keychain and signed out.
test('apps FarFromDesk opens get the owner home, not the isolated one',()=>{
  const env=appLaunchEnvironment({FFD_ISOLATED_LOCAL:'1',HOME:'/x/FarFromDesk Local/home',CLAUDE_CONFIG_DIR:'/x/claude',CODEX_HOME:'/x/codex',FFD_PORT:'1',PATH:'/usr/bin',LANG:'en_US.UTF-8'});
  assert.equal(env.HOME,userInfo().homedir);
  assert.deepEqual(Object.keys(env).sort(),['HOME','LANG','PATH']);
});
