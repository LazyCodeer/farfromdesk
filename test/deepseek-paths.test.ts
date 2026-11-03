import test from 'node:test';
import assert from 'node:assert/strict';
import {userInfo} from 'node:os';
import {join} from 'node:path';
import {dshBinary,dshCredentialsPath,dshHome,dshSessionsDir} from '../src/dsh-paths.js';

// Regression: the packaged Local backend runs with an isolated HOME, and reading DeepSeek's
// credential and session store from that private home made a healthy install report itself
// signed out with no sessions, so DeepSeek never appeared as a detected app.

test('an isolated Local backend resolves DeepSeek under the owner home',()=>{
  const env={FFD_ISOLATED_LOCAL:'1',HOME:'/tmp/ffd-private-home'} as NodeJS.ProcessEnv;
  const owner=userInfo().homedir;
  assert.equal(dshHome(env),join(owner,'.dsh'));
  assert.equal(dshCredentialsPath(env),join(owner,'.dsh','.credentials.yaml'));
  assert.equal(dshSessionsDir(env),join(owner,'.dsh','sessions'));
  assert.equal(dshBinary(env),'dsh');
});

test('an explicit DSH_HOME wins over the owner home',()=>{
  const env={FFD_ISOLATED_LOCAL:'1',HOME:'/tmp/private',DSH_HOME:'/tmp/dsh'} as NodeJS.ProcessEnv;
  assert.equal(dshHome(env),'/tmp/dsh');
  assert.equal(dshCredentialsPath(env),'/tmp/dsh/.credentials.yaml');
  assert.equal(dshSessionsDir(env),'/tmp/dsh/sessions');
});

test('an explicit DSH_BIN wins, and a normal shell keeps its own home',()=>{
  assert.equal(dshBinary({DSH_BIN:'/tmp/bin/dsh'} as NodeJS.ProcessEnv),'/tmp/bin/dsh');
  const env={HOME:'/tmp/plain'} as NodeJS.ProcessEnv;
  assert.equal(dshHome(env),join('/tmp/plain','.dsh'));
  assert.equal(dshCredentialsPath(env),join('/tmp/plain','.dsh','.credentials.yaml'));
  assert.equal(dshSessionsDir(env),join('/tmp/plain','.dsh','sessions'));
});