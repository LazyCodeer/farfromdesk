import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confirmCodexSession,requireCodexHistory,saveNewCodexWorkerSettings } from '../src/codex-session.js';
import { realpathSync } from 'node:fs';

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

test('new Desktop worker saves scoped settings without a model turn or disabling approvals',async()=>{
  const calls:any[]=[];
  await saveNewCodexWorkerSettings({async request(method,params){calls.push({method,params});return {}; }},'exact-id',dir);
  assert.deepEqual(calls,[{method:'thread/settings/update',params:{threadId:'exact-id',cwd:realpathSync(dir),approvalPolicy:'on-request',sandboxPolicy:{type:'workspaceWrite',writableRoots:[realpathSync(dir)],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false}}}]);
});

test('unsupported or rejected native settings fail without fallback or retry',async()=>{
  let calls=0;
  await assert.rejects(saveNewCodexWorkerSettings({async request(){calls++;throw new Error('native private diagnostic');}},'exact-id',dir),e=>e instanceof Error&&/No task was sent/.test(e.message)&&!e.message.includes('private'));
  assert.equal(calls,1);
});

test('request observation matches exact envelope and rejects ambiguous turns',async()=>{
  const {observeCodexRequest}=await import('../src/codex-session.js');
  const requestId='tg:owner:8',cwd=process.cwd(),binding={native_id:'exact-thread',cwd};
  const turn=(id:string,status:string,request=requestId)=>({id,status,items:[{type:'userMessage',content:[{type:'text',text:JSON.stringify({requestId:request})}]}]});
  const runtime=(turns:any[])=>({request:async()=>({thread:{id:'exact-thread',cwd,turns}})});
  assert.deepEqual(await observeCodexRequest(runtime([turn('one','interrupted')]),binding,requestId),{status:'interrupted',turnId:'one'});
  assert.equal(await observeCodexRequest(runtime([turn('other','completed','tg:owner:80')]),binding,requestId),undefined);
  assert.equal(await observeCodexRequest(runtime([turn('one','completed'),turn('two','inProgress')]),binding,requestId),undefined);
});
