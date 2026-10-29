import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('test runner ignores installed state, isolates children and removes its temporary root',()=>{
  const sentinel=mkdtempSync(join(tmpdir(),'ffd-test-sentinel-'));
  try {
    const file=join(sentinel,'meta-model-api-key');writeFileSync(file,'synthetic-sentinel');
    const cert=join(sentinel,'synthetic-ca.pem');writeFileSync(cert,'');
    const env={...process.env,WSB_STATE_DIR:sentinel,ISOLATION_SENTINEL:sentinel,WSB_PORT:'47831',OPENAI_API_KEY:'synthetic-api-key',FFD_META_KEY:'synthetic-meta-key',AWS_ACCESS_KEY_ID:'synthetic-access-id',AWS_SECRET_ACCESS_KEY:'synthetic-secret-key',AWS_SHARED_CREDENTIALS_FILE:'/must-not-read',AWS_CONFIG_FILE:'/must-not-read',GOOGLE_APPLICATION_CREDENTIALS:'/must-not-read',GIT_CONFIG_GLOBAL:'/must-not-read',AZURE_CONFIG_DIR:'/must-not-read',DATABASE_URL:'postgres://synthetic:secret@example.invalid/test',REDIS_URL:'redis://synthetic:secret@example.invalid',GH_CONFIG_DIR:'/must-not-read',CUSTOM_CONFIG_DIR:'/must-not-read',INNOCUOUS_RUNTIME_SETTING:'synthetic',ISOLATION_EXPECT_AUDIO:'1',WSB_AUDIO_TEST_MODEL:'/synthetic-opt-in-model',NODE_PATH:'/must-not-read',NODE_EXTRA_CA_CERTS:cert,NODE_V8_COVERAGE:join(sentinel,'synthetic-coverage'),SSH_AUTH_SOCK:'/must-not-use',WSB_DESKTOP_SYNC_BIN:'/must-not-run'};
    delete env.NODE_TEST_CONTEXT;
    const result=spawnSync(process.execPath,['script/run_node_tests.mjs','files','script/tests/fixtures/node_runner_probe.test.ts'],{
      env,encoding:'utf8',timeout:30000,
    });
    assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(file,'utf8'),'synthetic-sentinel');
    const root=/ISOLATED_TEST_ROOT=([^\r\n]+)/.exec(result.stdout)?.[1];
    assert.ok(root);assert.equal(existsSync(root),false);
  } finally {rmSync(sentinel,{recursive:true,force:true});}
});

test('test runner rejects an empty focused selection',()=>{
  const result=spawnSync(process.execPath,['script/run_node_tests.mjs','files'],{encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Specify at least one test file/);
});

test('test runner removes its temporary state after a failing suite',()=>{
  const env={...process.env,ISOLATION_PROBE_FAIL:'1'};delete env.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,['script/run_node_tests.mjs','files','script/tests/fixtures/node_runner_probe.test.ts'],{env,encoding:'utf8',timeout:30000});
  assert.notEqual(result.status,0);
  const root=/ISOLATED_TEST_ROOT=([^\r\n]+)/.exec(result.stdout)?.[1];
  assert.ok(root);assert.equal(existsSync(root),false);
});

test('shell entry clears an inherited Node preload before starting Node',{skip:process.platform==='win32'},()=>{
  const sentinel=mkdtempSync(join(tmpdir(),'ffd-preload-sentinel-'));
  try{
    const marker=join(sentinel,'ran'),preload=join(sentinel,'preload.cjs');
    writeFileSync(preload,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'loaded')`);
    const env={...process.env,NODE_OPTIONS:`--require=${preload}`,ISOLATION_SENTINEL:sentinel};delete env.NODE_TEST_CONTEXT;
    const result=spawnSync('/bin/sh',['script/run-tests.sh','files','script/tests/fixtures/node_runner_probe.test.ts'],{env,encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(marker),false,'the inherited preload must never run');
  }finally{rmSync(sentinel,{recursive:true,force:true});}
});

test('Windows batch entry clears an inherited Node preload before starting Node',{skip:process.platform!=='win32'},()=>{
  const sentinel=mkdtempSync(join(tmpdir(),'ffd-preload-sentinel-'));
  try{
    const marker=join(sentinel,'ran'),preload=join(sentinel,'preload.cjs');
    writeFileSync(preload,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'loaded')`);
    const env={...process.env,NODE_OPTIONS:`--require="${preload}"`,ISOLATION_SENTINEL:sentinel};delete env.NODE_TEST_CONTEXT;
    const result=spawnSync('cmd.exe',['/d','/c','script\\run-tests.cmd','files','script/tests/fixtures/node_runner_probe.test.ts'],{env,encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(marker),false,'the inherited preload must never run');
  }finally{rmSync(sentinel,{recursive:true,force:true});}
});

test('canceling the runner stops its test process group and removes isolated state',{skip:process.platform==='win32',timeout:15000},async()=>{
  const outer=mkdtempSync(join(tmpdir(),'ffd-cancel-test-'));
  const env={...process.env,TMPDIR:outer};delete env.NODE_TEST_CONTEXT;
  const runner=spawn(process.execPath,['script/run_node_tests.mjs','files','script/tests/fixtures/node_runner_hang.test.ts'],{env,stdio:'ignore'});
  let root='',pids:number[]=[];
  try {
    const deadline=Date.now()+7000;
    while(Date.now()<deadline){
      const candidate=readdirSync(outer).find(name=>name.startsWith('farfromdesk-tests-'));
      if(candidate){root=join(outer,candidate);const marker=join(root,'state','started');
        if(existsSync(marker)){pids=readFileSync(marker,'utf8').trim().split(' ').map(Number);break;}}
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.equal(pids.length,2,'synthetic test and child should have started');
    const exited=new Promise<number|null>((resolve,reject)=>{runner.once('exit',resolve);runner.once('error',reject);});
    runner.kill('SIGTERM');assert.equal(await exited,143);
    assert.equal(existsSync(root),false,'temporary state should be removed');
    for(const pid of pids){
      assert.ok(Number.isInteger(pid)&&pid>1);
      const gone=()=>{try{process.kill(pid,0);return false;}catch(e:any){return e.code==='ESRCH';}};
      const until=Date.now()+3000;while(!gone()&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,25));
      assert.ok(gone(),`synthetic child ${pid} should have exited`);
    }
  } finally {if(runner.exitCode===null&&runner.signalCode===null)runner.kill('SIGKILL');rmSync(outer,{recursive:true,force:true});}
});
