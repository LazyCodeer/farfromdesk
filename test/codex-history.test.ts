import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confirmCodexSession,requireCodexHistory } from '../src/codex-session.js';

const dir=mkdtempSync(join(tmpdir(),'ffd-history-'));
test.after(()=>rmSync(dir,{recursive:true,force:true}));

test('saved-chat verification reads full native history without starting a model turn',async()=>{
  const path=join(dir,'saved.jsonl');
  const calls:string[]=[];
  await confirmCodexSession({async request(method,params){
    calls.push(method);assert.deepEqual(params,{threadId:'exact-id',includeTurns:true});
    writeFileSync(path,'{"type":"session_meta"}\n');
    return {thread:{id:'exact-id',cwd:dir,path}};
  }},'exact-id',dir);
  assert.deepEqual(calls,['thread/read']);
});

test('saved-chat verification rejects a different session or workspace',async()=>{
  for(const thread of [{id:'other',cwd:dir},{id:'exact-id',cwd:tmpdir()}]){
    await assert.rejects(confirmCodexSession({async request(){return {thread};}},'exact-id',dir),/identity/);
  }
});

test('database-only, empty and non-file history cannot be treated as ready',async()=>{
  const empty=join(dir,'empty');writeFileSync(empty,'');
  for(const path of [undefined,null,'relative-path',join(dir,'missing'),empty,dir])await assert.rejects(requireCodexHistory(path),/Codex/);
});
