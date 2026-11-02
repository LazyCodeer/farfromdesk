import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { museArgs, runMuse } from '../src/muse-session.js';

/** A stand-in for `muse` that prints the JSONL records the real binary prints. */
function stub(dir: string, body: string) {
  const path=join(dir,'muse');
  writeFileSync(path,`#!/bin/sh\n${body}\n`);
  chmodSync(path,0o755);
  return path;
}
const record=(type:string,kind:string,payload:Record<string,unknown>)=>JSON.stringify({schema_version:1,stream:{kind:'session',id:'01a1972a-stub'},payload_type:type,payload:{kind,...payload}});

function workspace() {
  const dir=mkdtempSync(join(tmpdir(),'ffd-muse-'));
  return {dir,close:()=>rmSync(dir,{recursive:true,force:true})};
}

test('a finished run returns the terminal text, model and token usage',async()=>{
  const w=workspace();
  try {
    const binary=stub(w.dir,[
      `echo '${record('run.output.delta','run_output_delta',{text:'Ready'})}'`,
      `echo '${record('run.usage','run_usage',{models:[{model:'muse-spark-1.3',input_tokens:12,output_tokens:3}]})}'`,
      `echo '${record('run.terminal.completed','run_terminal',{terminal:'completed',text:'Ready',reason:null})}'`,
    ].join('\n'));
    const result=await runMuse({prompt:'say ready',cwd:w.dir,binary,sessionId:'01a1972a-c63d-7351-8e3e-810ecfd91ea9'});
    assert.equal(result.text,'Ready');
    assert.equal(result.model,'muse-spark-1.3');
    assert.deepEqual(result.usage,{inputTokens:12,outputTokens:3});
  } finally {w.close();}
});

test('a run that did not complete is an error, never an answer',async()=>{
  const w=workspace();
  try {
    const binary=stub(w.dir,[
      `echo '${record('run.output.delta','run_output_delta',{text:'partial'})}'`,
      `echo '${record('run.terminal.completed','run_terminal',{terminal:'failed',text:'partial',reason:'max_model_steps'})}'`,
      'exit 1',
    ].join('\n'));
    await assert.rejects(()=>runMuse({prompt:'go',cwd:w.dir,binary}),/failed: max_model_steps/);
  } finally {w.close();}
});

test('a finished run with no text is an error',async()=>{
  const w=workspace();
  try {
    const binary=stub(w.dir,`echo '${record('run.terminal.completed','run_terminal',{terminal:'completed',text:'  ',reason:null})}'`);
    await assert.rejects(()=>runMuse({prompt:'go',cwd:w.dir,binary}),/without any answer text/);
  } finally {w.close();}
});

test('a process that exits before a terminal record is an error and keeps the reason',async()=>{
  const w=workspace();
  try {
    const binary=stub(w.dir,`echo 'muse: provider credential rejected' >&2\nexit 3`);
    await assert.rejects(()=>runMuse({prompt:'go',cwd:w.dir,binary}),/exited with code 3.*credential rejected/);
  } finally {w.close();}
});

test('a missing binary says Muse is not installed',async()=>{
  const w=workspace();
  try {
    await assert.rejects(()=>runMuse({prompt:'go',cwd:w.dir,binary:join(w.dir,'absent')}),/not installed/);
  } finally {w.close();}
});

test('a run that hangs is stopped by the timeout',async()=>{
  const w=workspace();
  try {
    const binary=stub(w.dir,'sleep 30');
    const started=Date.now();
    await assert.rejects(()=>runMuse({prompt:'go',cwd:w.dir,binary,timeoutMs:120}),/did not finish in time/);
    assert.ok(Date.now()-started<5000,'the timeout fires instead of waiting for the stub');
  } finally {w.close();}
});

test('the headless arguments keep approvals off and carry the session id',()=>{
  const args=museArgs({prompt:'hello',cwd:'/tmp',sessionId:'11111111-1111-4111-a111-111111111111',model:'muse-spark-1.3',maxModelSteps:4});
  assert.deepEqual(args.slice(0,2),['exec','--json']);
  assert.ok(args.includes('--disable-approval'));
  assert.ok(args.includes('--session-id'));
  assert.equal(args.at(-1),'hello');
  assert.ok(!args.includes('--yolo'),'the sandbox stays on');
});

test('project rules load only when the owner trusted the workspace',()=>{
  const trusted=museArgs({prompt:'hello',cwd:'/tmp',trustWorkspace:true});
  const untrusted=museArgs({prompt:'hello',cwd:'/tmp',trustWorkspace:false});
  assert.ok(trusted.includes('--trust-workspace'),'a chosen project loads its own rules and skills');
  assert.ok(!untrusted.includes('--trust-workspace'),'the private coordinator folder loads nothing');
  assert.ok(untrusted.includes('--disable-approval'),'approvals stay off either way');
});
