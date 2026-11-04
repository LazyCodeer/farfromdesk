import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  cursorAppBinary,
  cursorCliBinary,
  cursorConversationDb,
  cursorDataDir,
  cursorProjectPath,
  cursorProjectSlug,
  cursorProjectsDir,
  cursorSupportDir,
} from '../src/cursor-paths.js';

// Every fixture lives in a synthetic temp directory, never the developer's real ~/.cursor. The base
// resolves through realpath so the path walk in cursorProjectPath sees real directories rather than
// the /var symlink macOS puts in front of its temp directory.
const realTmp=realpathSync(tmpdir());
const dirs:string[]=[];
function fixture(prefix:string):string {
  const dir=mkdtempSync(join(realTmp,prefix));
  dirs.push(dir);
  return dir;
}
test.after(()=>{for(const dir of dirs)rmSync(dir,{recursive:true,force:true});});

test('explicit Cursor directories win over the owner home and derive their children',()=>{
  const data=fixture('cursor-paths-data-'),support=join(data,'support');
  const env={CURSOR_DATA_DIR:data,CURSOR_SUPPORT_DIR:support} as NodeJS.ProcessEnv;
  assert.equal(cursorDataDir(env),data);
  assert.equal(cursorProjectsDir(env),join(data,'projects'));
  assert.equal(cursorSupportDir(env),support);
  assert.equal(cursorConversationDb(env),join(support,'User','globalStorage','conversation-search.db'));
  assert.equal(cursorDataDir({WSB_CURSOR_DATA_DIR:data} as NodeJS.ProcessEnv),data);
  assert.equal(cursorDataDir({CURSOR_DATA_DIR:data,WSB_CURSOR_DATA_DIR:'/tmp/other'} as NodeJS.ProcessEnv),data);
  assert.equal(cursorAppBinary({CURSOR_APP_BIN:'/tmp/Cursor.app'} as NodeJS.ProcessEnv),'/tmp/Cursor.app');
  assert.equal(cursorCliBinary({CURSOR_AGENT_BIN:'/tmp/agent'} as NodeJS.ProcessEnv),'/tmp/agent');
  assert.equal(cursorCliBinary({WSB_CURSOR_BIN:'/tmp/wsb-agent'} as NodeJS.ProcessEnv),'/tmp/wsb-agent');
  assert.equal(cursorCliBinary({} as NodeJS.ProcessEnv),'agent');
});

test('a slug replaces separators but keeps spaces, and a round trip recovers the folder',()=>{
  const base=fixture('cursor-paths-round-');
  const workspace=join(base,'Users','sam','My Projects','demo');
  mkdirSync(workspace,{recursive:true});
  const env={CURSOR_DATA_DIR:base} as NodeJS.ProcessEnv;
  assert.equal(cursorProjectSlug(workspace),workspace.replace(/^\/+/,'').replace(/\//g,'-'));
  assert.match(cursorProjectSlug(workspace),/My Projects/);
  assert.equal(cursorProjectPath(cursorProjectSlug(workspace),env),workspace);
});

test('a truncated slug with a hash suffix still recovers the folder it was cut from',()=>{
  const base=fixture('cursor-paths-truncated-');
  const workspace=join(base,'alpha-beta-gamma-delta-epsilon','omega-psi-chi-phi');
  mkdirSync(workspace,{recursive:true});
  const env={CURSOR_DATA_DIR:base} as NodeJS.ProcessEnv;
  const full=cursorProjectSlug(workspace);
  // Cursor cuts a long name and appends a short hex hash; the cut prefix is still a real prefix.
  const truncated=`${full.slice(0,full.length-2)}-a1b2c3d4`;
  assert.notEqual(truncated,full);
  assert.equal(cursorProjectPath(truncated,env),workspace);
});

test('a chat with no folder behind it, or an unknown slug, recovers nothing',()=>{
  const base=fixture('cursor-paths-empty-');
  const env={CURSOR_DATA_DIR:base} as NodeJS.ProcessEnv;
  assert.equal(cursorProjectPath('empty-window',env),null);
  assert.equal(cursorProjectPath('no-such-project-anywhere-a1b2c3',env),null);
  assert.equal(cursorProjectPath('',env),null);
});