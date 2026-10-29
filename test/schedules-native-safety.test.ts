import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,rmSync,statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

for(const scenario of ['owner','binding','composition','brief','delegated','no-schema'])test(`combined F1/F2 guard: ${scenario}`,()=>{
  const root=mkdtempSync(join(tmpdir(),'ffd-schedule-native-isolated-'));
  try{
    assert.deepEqual(readdirSync(root),[]);if(process.platform!=='win32')assert.equal(statSync(root).mode&0o077,0);
    const env={...process.env,WSB_STATE_DIR:root,NODE_NO_WARNINGS:'1'};
    for(const key of Object.keys(env))if(/(?:TOKEN|SECRET|PASSWORD|API_KEY)/i.test(key))delete env[key];
    const result=spawnSync(process.execPath,['--import','tsx','test/fixtures/schedule-native-safety.mts',scenario],{cwd:process.cwd(),env,encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,`isolated fixture failed: ${result.stderr}`);assert.match(result.stdout,/ok/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
