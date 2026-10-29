import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,mkdtempSync,mkdirSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {coordinatorRoots,safeTestTempBase} from '../script/run_node_tests.mjs';

function launcherEnv(root:string,overrides:Record<string,string>) {
  const fakeHome=join(root,'fake-home'),preload=join(root,'synthetic-home.mjs');mkdirSync(fakeHome,{recursive:true});
  writeFileSync(preload,"import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; os.homedir=()=>process.env.FFD_SYNTHETIC_HOME; syncBuiltinESMExports();");
  const env={...process.env,...overrides,FFD_SYNTHETIC_HOME:fakeHome,NODE_OPTIONS:`--import=${pathToFileURL(preload).href}`};delete env.NODE_TEST_CONTEXT;
  return {env,fakeHome};
}

test('the coordinator root matches configured and default app paths',()=>{
  const fakeHome=join(tmpdir(),'synthetic-user'),configured=join(fakeHome,'projects');
  assert.deepEqual(coordinatorRoots({},fakeHome),[join(fakeHome,'.farfromdesk')]);
  assert.deepEqual(coordinatorRoots({FARFROMDESK_HOME:configured},fakeHome),[join(fakeHome,'.farfromdesk'),configured]);
});

test('test temp selection rejects configured and default state, including aliases',()=>{
  const root=mkdtempSync(join(tmpdir(),'ffd-safe-temp-'));
  try {
    const configured=join(root,'configured'),defaultState=join(root,'default');
    const nested=join(configured,'nested'),safe=join(root,'safe');
    for(const dir of [configured,defaultState,nested,safe])mkdirSync(dir);
    assert.throws(()=>safeTestTempBase(configured,[configured,defaultState]),/outside app state/);
    assert.throws(()=>safeTestTempBase(nested,[configured,defaultState]),/outside app state/);
    assert.throws(()=>safeTestTempBase(defaultState,[configured,defaultState]),/outside app state/);
    assert.equal(safeTestTempBase(safe,[configured,defaultState]),safeTestTempBase(safe,[]));
    const stateAlias=join(root,'state-alias'),tempAlias=join(root,'temp-alias');
    // Directory junctions work on Windows without symlink privileges.
    const kind=process.platform==='win32'?'junction':'dir';
    symlinkSync(configured,stateAlias,kind);symlinkSync(nested,tempAlias,kind);
    assert.throws(()=>safeTestTempBase(tempAlias,[configured,defaultState]),/outside app state/);
    assert.throws(()=>safeTestTempBase(nested,[stateAlias,defaultState]),/outside app state/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('a missing state root is resolved through its existing symlinked ancestor',()=>{
  const root=mkdtempSync(join(tmpdir(),'ffd-safe-missing-'));
  try {
    const safe=join(root,'safe'),parent=join(root,'parent');mkdirSync(safe);mkdirSync(parent);
    assert.equal(safeTestTempBase(safe,[join(parent,'not-created')]),safeTestTempBase(safe,[]));
    const alias=join(root,'alias');symlinkSync(safe,alias,process.platform==='win32'?'junction':'dir');
    assert.throws(()=>safeTestTempBase(safe,[alias]),/outside app state/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('unverifiable app state or temp paths fail closed',()=>{
  const root=mkdtempSync(join(tmpdir(),'ffd-safe-invalid-'));
  try {
    assert.throws(()=>safeTestTempBase(join(root,'missing-temp'),[join(root,'state')]),/Cannot verify the test temp directory/);
    // A regular file cannot be treated as a missing state directory ancestor.
    const file=join(root,'file');writeFileSync(file,'synthetic');
    assert.throws(()=>safeTestTempBase(root,[join(file,'state')]),/Cannot verify test temp isolation/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('an inaccessible synthetic state ancestor fails closed',{skip:process.platform==='win32'||process.getuid?.()===0},()=>{
  const root=mkdtempSync(join(tmpdir(),'ffd-safe-denied-'));
  const restricted=join(root,'restricted'),state=join(restricted,'state'),safe=join(root,'safe');
  try {
    mkdirSync(restricted);mkdirSync(state);mkdirSync(safe);chmodSync(restricted,0);
    assert.throws(()=>safeTestTempBase(safe,[state]),/Cannot verify test temp isolation/);
  } finally {chmodSync(restricted,0o700);rmSync(root,{recursive:true,force:true});}
});

test('the launcher refuses a temp base inside configured state before creating a root',()=>{
  const root=mkdtempSync(join(tmpdir(),'ffd-safe-runner-')),state=join(root,'state');mkdirSync(state);
  try {
    writeFileSync(join(state,'synthetic-sentinel'),'test');
    const {env}=launcherEnv(root,{WSB_STATE_DIR:state,FARFROMDESK_HOME:state,TMPDIR:state,TMP:state,TEMP:state});
    const result=spawnSync(process.execPath,['script/run_node_tests.mjs','files','test/test-safe-temp.test.ts'],{env,encoding:'utf8',timeout:10000});
    assert.notEqual(result.status,0);assert.match(result.stderr,/outside app state/);
    assert.deepEqual(readdirSync(state),['synthetic-sentinel']);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('the launcher refuses a temp base inside a configured coordinator workspace, including aliases',()=>{
  const root=mkdtempSync(join(tmpdir(),'ffd-project-runner-'));
  try{
    const projects=join(root,'projects'),nested=join(projects,'nested'),state=join(root,'state'),alias=join(root,'project-alias');
    mkdirSync(projects);mkdirSync(nested);mkdirSync(state);symlinkSync(projects,alias,process.platform==='win32'?'junction':'dir');
    for(const candidate of [projects,nested,join(alias,'nested')]){
      const {env}=launcherEnv(root,{WSB_STATE_DIR:state,FARFROMDESK_HOME:projects,TMPDIR:candidate,TMP:candidate,TEMP:candidate});
      const before=readdirSync(nested),beforeProjects=readdirSync(projects);
      const result=spawnSync(process.execPath,['script/run_node_tests.mjs','files','test/test-safe-temp.test.ts'],{env,encoding:'utf8',timeout:10000});
      assert.notEqual(result.status,0,candidate);assert.match(result.stderr,/outside app state/);assert.deepEqual(readdirSync(nested),before);assert.deepEqual(readdirSync(projects),beforeProjects);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('a configured workspace does not remove protection for the default workspace',()=>{
  const root=mkdtempSync(join(tmpdir(),'ffd-default-workspace-'));
  try{
    const state=join(root,'state'),configured=join(root,'configured');mkdirSync(state);mkdirSync(configured);
    const prepared=launcherEnv(root,{WSB_STATE_DIR:state,FARFROMDESK_HOME:configured});
    const defaultRoot=join(prepared.fakeHome,'.farfromdesk'),nested=join(defaultRoot,'nested'),alias=join(root,'default-alias');
    mkdirSync(defaultRoot);mkdirSync(nested);symlinkSync(defaultRoot,alias,process.platform==='win32'?'junction':'dir');
    for(const candidate of [defaultRoot,nested,join(alias,'nested')]){
      const env={...prepared.env,TMPDIR:candidate,TMP:candidate,TEMP:candidate};
      const beforeDefault=readdirSync(defaultRoot),beforeNested=readdirSync(nested);
      const result=spawnSync(process.execPath,['script/run_node_tests.mjs','files','test/test-safe-temp.test.ts'],{env,encoding:'utf8',timeout:10000});
      assert.notEqual(result.status,0,candidate);assert.match(result.stderr,/outside app state/);
      assert.deepEqual(readdirSync(defaultRoot),beforeDefault);assert.deepEqual(readdirSync(nested),beforeNested);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
