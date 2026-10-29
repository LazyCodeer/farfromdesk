import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {lstatSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
// This import happens before any fixture sets WSB_STATE_DIR at module scope.
import {stateDir,coordinatorHome} from '../../../src/config.js';

test('the runner isolates state before imports and blocks unmocked remote fetch',async()=>{
  const root=dirname(stateDir);
  assert.equal(stateDir,process.env.WSB_STATE_DIR);
  assert.equal(coordinatorHome,process.env.FARFROMDESK_HOME);
  assert.notEqual(stateDir,process.env.ISOLATION_SENTINEL);
  assert.equal(process.env.HOME,join(root,'home'));
  assert.equal(process.env.XDG_CONFIG_HOME,join(root,'xdg'));
  assert.equal(process.env.APPDATA,join(root,'appdata'));
  assert.ok(Number(process.env.WSB_PORT)>0&&Number(process.env.WSB_PORT)<=65535);
  assert.notEqual(process.env.WSB_PORT,'47831');
  assert.equal(process.env.OPENAI_API_KEY,undefined);
  assert.equal(process.env.FFD_META_KEY,undefined);
  assert.equal(process.env.AWS_ACCESS_KEY_ID,undefined);
  assert.equal(process.env.AWS_SECRET_ACCESS_KEY,undefined);
  assert.equal(process.env.AWS_SHARED_CREDENTIALS_FILE,undefined);
  assert.equal(process.env.AWS_CONFIG_FILE,undefined);
  assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS,undefined);
  assert.equal(process.env.GIT_CONFIG_GLOBAL,undefined);
  assert.equal(process.env.AZURE_CONFIG_DIR,undefined);
  assert.equal(process.env.DATABASE_URL,undefined);
  assert.equal(process.env.REDIS_URL,undefined);
  assert.equal(process.env.GH_CONFIG_DIR,undefined);
  assert.equal(process.env.CUSTOM_CONFIG_DIR,undefined);
  assert.equal(process.env.INNOCUOUS_RUNTIME_SETTING,undefined);
  if(process.env.ISOLATION_EXPECT_AUDIO==='1')assert.equal(process.env.WSB_AUDIO_TEST_MODEL,'/synthetic-opt-in-model');
  assert.equal(process.env.NODE_EXTRA_CA_CERTS,undefined);
  assert.equal(process.env.NODE_PATH,undefined);
  assert.equal(process.env.NODE_V8_COVERAGE,undefined);
  assert.equal(process.env.SSH_AUTH_SOCK,undefined);
  assert.equal(process.env.WSB_DESKTOP_SYNC_BIN,join(root,'missing-desktop-sync'));
  if(process.platform!=='win32')assert.equal(lstatSync(root).mode&0o777,0o700);
  console.log(`ISOLATED_TEST_ROOT=${root}`);
  writeFileSync(join(stateDir,'synthetic-state'),'test');
  if(process.env.ISOLATION_PROBE_FAIL==='1')throw new Error('synthetic test failure');
  const guarded=globalThis.fetch;
  await assert.rejects(guarded('https://example.invalid'),/non-loopback/);
  const server=createServer((_,res)=>{res.writeHead(302,{location:'https://example.invalid/'});res.end();});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  try{await assert.rejects(guarded(`http://127.0.0.1:${(server.address() as any).port}/`));}
  finally{await new Promise<void>(done=>server.close(()=>done()));}
  const result=spawnSync(process.execPath,['--input-type=module','-e',
    'if(process.env.WSB_STATE_DIR!==process.argv[1]||process.env.DATABASE_URL||process.env.GH_CONFIG_DIR) process.exit(5); try {await fetch("https://example.invalid"); process.exit(3)} catch(e) {if (!String(e.message).includes("non-loopback")) process.exit(4)}',stateDir],{encoding:'utf8'});
  assert.equal(result.status,0);
  // Tests can still install a fake fetch without a network request.
  globalThis.fetch=async()=>new Response('fake');
  assert.equal(await (await fetch('https://example.invalid')).text(),'fake');
  globalThis.fetch=guarded;
  // Later fixture overrides do not change module-level captured stateDir.
  const late=mkdtempSync(join(tmpdir(),'ffd-late-'));
  try{process.env.WSB_STATE_DIR=late;assert.notEqual(stateDir,late);}
  finally{process.env.WSB_STATE_DIR=stateDir;rmSync(late,{recursive:true,force:true});}
});
