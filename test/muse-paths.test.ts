import test from 'node:test';
import assert from 'node:assert/strict';
import {userInfo} from 'node:os';
import {join} from 'node:path';
import {museAuthPath,museBinary,museDataHome,museHome} from '../src/muse-paths.js';

// Regression: the packaged Local backend runs with an isolated HOME, and reading Muse's
// credential and session index from that private home made a healthy install report itself
// signed out with no sessions, so Muse never appeared as a detected app.

test('an isolated Local backend resolves Muse under the owner home',()=>{
  const env={FFD_ISOLATED_LOCAL:'1',HOME:'/tmp/ffd-private-home'} as NodeJS.ProcessEnv;
  const owner=userInfo().homedir;
  assert.equal(museHome(env),owner);
  assert.equal(museAuthPath(env),join(owner,'.config','muse','auth.json'));
  assert.equal(museBinary(env),join(owner,'.local','bin','muse'));
  assert.equal(museDataHome(env),join(owner,'.local','share','muse'));
});

test('explicit Muse variables win over the owner home',()=>{
  const env={FFD_ISOLATED_LOCAL:'1',HOME:'/tmp/private',MUSE_CONFIG_DIR:'/tmp/cfg',MUSE_DATA_DIR:'/tmp/data',MUSE_BIN:'/tmp/bin/muse'} as NodeJS.ProcessEnv;
  assert.equal(museAuthPath(env),join('/tmp/cfg','auth.json'));
  assert.equal(museDataHome(env),'/tmp/data');
  assert.equal(museBinary(env),'/tmp/bin/muse');
});

test('a normal shell keeps its own home',()=>{
  const env={HOME:'/tmp/plain'} as NodeJS.ProcessEnv;
  assert.equal(museHome(env),'/tmp/plain');
  assert.equal(museAuthPath(env),join('/tmp/plain','.config','muse','auth.json'));
  assert.equal(museDataHome(env),join('/tmp/plain','.local','share','muse'));
});
// Regression: the bridge found Muse under the owner home, but the spawned run still inherited the
// private HOME, so Muse itself answered "missing meta credentials" for a signed-in owner.
test('a Muse run from an isolated backend gets the owner home and credential path',async()=>{
  const {museEnv}=await import('../src/muse-session.js');
  const owner=userInfo().homedir;
  const env=museEnv({FFD_ISOLATED_LOCAL:'1',HOME:'/tmp/ffd-private-home'} as NodeJS.ProcessEnv);
  assert.equal(env.HOME,owner);
  assert.equal(env.MUSE_AUTH_PATH,join(owner,'.config','muse','auth.json'));
  assert.equal(museEnv({HOME:'/tmp/plain',MUSE_AUTH_PATH:'/x/auth.json'} as NodeJS.ProcessEnv).MUSE_AUTH_PATH,'/x/auth.json');
});
