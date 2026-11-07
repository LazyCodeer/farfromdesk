import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

import { runDsh } from '../src/dsh-session.js';

const dir=mkdtempSync(join(tmpdir(),'ffd-deepseek-session-'));
test.after(()=>rmSync(dir,{recursive:true,force:true}));

/** The JSON event the real stream would print. No apostrophes: the stub is a shell script. */
const emit=(event:unknown)=>`echo '${JSON.stringify(event)}'`;

/** A stand-in for `dsh --profile headless --json -` that records its arguments and stdin. */
function stub(name:string,body:string) {
  const path=join(dir,name),args=join(dir,`${name}.args`),stdin=join(dir,`${name}.stdin`);
  writeFileSync(path,`#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(args)}
cat > ${JSON.stringify(stdin)}
${body}
`);
  chmodSync(path,0o755);
  return {path,args,stdin};
}

test('a completed run resolves with the final answer and the session id from the opening event',async()=>{
  const sessionId='11111111-1111-4111-a111-111111111111';
  const run=stub('ok',[
    emit({type:'session',sessionId,cwd:dir}),
    emit({type:'status',state:'started'}),
    emit({type:'thinking',text:'considering'}),
    emit({type:'text',text:'working'}),
    emit({type:'final',text:'DeepSeek answered the request.'}),
  ].join('\n'));
  const result=await runDsh({prompt:'do the thing',cwd:dir,binary:run.path});
  assert.equal(result.text,'DeepSeek answered the request.');
  assert.equal(result.sessionId,sessionId,'the session id comes from the opening event');
  assert.equal(readFileSync(run.stdin,'utf8'),'do the thing','the prompt is delivered on stdin');
});

test('a relative working directory runs the task in that exact project',async()=>{
  const project=mkdtempSync(join(tmpdir(),'ffd-deepseek-project-'));
  const where=join(dir,'where.txt');
  const run=stub('relative',[
    `pwd > ${JSON.stringify(where)}`,
    emit({type:'session',sessionId:'relative-session',cwd:project}),
    emit({type:'final',text:'Done.'}),
  ].join('\n'));
  try {
    const cwd=relative(process.cwd(),project);
    assert.ok(cwd&&!isAbsolute(cwd),'the fixture is reached by a relative path');
    const result=await runDsh({prompt:'where am I',cwd,binary:run.path});
    assert.equal(result.text,'Done.');
    assert.equal(realpathSync(readFileSync(where,'utf8').trim()),realpathSync(project),'the run happened in the project itself');
  }finally{rmSync(project,{recursive:true,force:true});}
});

test('a run that exits 1 with an error event rejects instead of answering',async()=>{
  const run=stub('failed',[
    emit({type:'session',sessionId:'refused-session',cwd:dir}),
    emit({type:'error',message:'Session belongs to a different working directory.'}),
    emit({type:'final',text:''}),
    'exit 1',
  ].join('\n'));
  await assert.rejects(()=>runDsh({prompt:'resume it',cwd:dir,binary:run.path}),/exited with code 1: Session belongs to a different working directory\./);
});

test('a run that exits 0 with an empty final rejects instead of answering',async()=>{
  const run=stub('empty',[
    emit({type:'session',sessionId:'empty-session',cwd:dir}),
    emit({type:'final',text:'   '}),
  ].join('\n'));
  await assert.rejects(()=>runDsh({prompt:'say nothing',cwd:dir,binary:run.path}),/without any answer text/);
});

test('a resumed run passes --session-id and still sends the prompt on stdin',async()=>{
  const sessionId='22222222-2222-4222-a222-222222222222';
  const run=stub('resume',[
    emit({type:'session',sessionId,cwd:dir}),
    emit({type:'final',text:'Continued.'}),
  ].join('\n'));
  const result=await runDsh({prompt:'continue please',cwd:dir,sessionId,binary:run.path});
  assert.equal(result.text,'Continued.');
  assert.equal(result.sessionId,sessionId);
  const args=readFileSync(run.args,'utf8');
  assert.match(args,new RegExp('--session-id\\n'+sessionId),'the adopted session id is passed to the CLI');
  assert.match(args,/--profile\nheadless/);
  assert.match(args,/--json/);
  assert.match(args,/\n-\n$/,'the documented stdin marker is the last argument');
  assert.equal(readFileSync(run.stdin,'utf8'),'continue please');
});
test('a session held open by the DeepSeek app is explained with a way forward',async()=>{
  const run=stub('held',[
    emit({type:'error',message:'session "session-2b25d7c5" is already owned by an active write handle'}),
    'exit 1',
  ].join('\n'));
  await assert.rejects(()=>runDsh({prompt:'check mail',cwd:dir,binary:run.path}),/Nothing was done: this DeepSeek session is open in the DeepSeek Harness app.*\/deepseek new/);
});
