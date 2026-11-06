import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readdirSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const dir=mkdtempSync(join(tmpdir(),'ffd-hook-sdk-'));process.env.WSB_STATE_DIR=dir;
mkdirSync(join(dir,'bindings'),{recursive:true});
writeFileSync(join(dir,'bindings','b1.json'),JSON.stringify({id:'b1',provider:'claude',nativeId:'s1',token:'t'}));
const {handleHook}=await import('../src/hooks.js');
test('hooks stay out of a session FarFromDesk drives through the SDK',async()=>{
  process.env.FFD_SDK_DRIVER='C:/some/other/install';
  try{
    assert.equal(await handleHook('claude',{session_id:'s1',hook_event_name:'PermissionRequest',tool_name:'Grep',tool_input:{}}),undefined);
    await handleHook('claude',{session_id:'s1',hook_event_name:'Stop',turn_id:'x',last_assistant_message:'done'});
    assert.ok(!existsSync(join(dir,'spool'))||readdirSync(join(dir,'spool')).length===0);
  }finally{delete process.env.FFD_SDK_DRIVER;}
  await handleHook('claude',{session_id:'s1',hook_event_name:'Stop',turn_id:'y',last_assistant_message:'done'});
  assert.equal(readdirSync(join(dir,'spool')).filter(f=>f.endsWith('.json')).length,1);
});
