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
  assert.equal(dshBinary(env,()=>false),'dsh');
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

// Regression: the packaged Local backend is started by the desktop app with
// `PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`, and the DeepSeek installer's `dsh` symlink
// lives in `/usr/local/bin`. Resolving from PATH alone made `/deepseek` answer "DeepSeek Harness is
// not installed" on a machine where it was installed and signed in.
test('a packaged backend finds dsh outside its own PATH',()=>{
  const env={FFD_ISOLATED_LOCAL:'1',HOME:'/tmp/ffd-private-home',PATH:'/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin'} as NodeJS.ProcessEnv;
  assert.equal(dshBinary(env,candidate=>candidate==='/usr/local/bin/dsh'),'/usr/local/bin/dsh');
  assert.equal(
    dshBinary(env,candidate=>candidate===join(userInfo().homedir,'.local','bin','dsh')),
    join(userInfo().homedir,'.local','bin','dsh'),
  );
  // Nothing installed anywhere: the bare name is the last resort, and the spawn will say so.
  assert.equal(dshBinary(env,()=>false),'dsh');
});