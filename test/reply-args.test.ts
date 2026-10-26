import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRespondArgs,scopedBridgeCommand } from '../src/reply-args.js';
import { cliReplyRule } from '../src/master-policy.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Desktop command keeps the exact state and port despite a different inherited instance',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-reply-scope-'));
  try {
    const cli=join(dir,"fake cli's.js"),state=join(dir,"test instance's $(not-a-command)");
    writeFileSync(cli,'console.log(JSON.stringify({state:process.env.WSB_STATE_DIR,port:process.env.WSB_PORT,args:process.argv.slice(2)}))');
    const command=scopedBridgeCommand(process.execPath,cli,state,'47839')+" respond 'master' 'tg:request' final";
    const result=JSON.parse(execFileSync('/bin/sh',['-c',command],{encoding:'utf8',env:{...process.env,WSB_STATE_DIR:'/wrong-instance',WSB_PORT:'47831'}}));
    assert.deepEqual(result,{state,port:'47839',args:['respond','master','tg:request','final']});
    assert.throws(()=>scopedBridgeCommand('/node','/cli','/state','0'),/port/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('respond accepts only progress or final and rejects anything that would silently become final',()=>{
  assert.deepEqual(parseRespondArgs(['worker','req-1']),{alias:'worker',requestId:'req-1',kind:'final',turnId:undefined,outcome:undefined});
  assert.equal(parseRespondArgs(['worker','req-1','progress']).kind,'progress');
  assert.equal(parseRespondArgs(['worker','req-1','final','--outcome','done']).outcome,'done');
  assert.equal(parseRespondArgs(['--turn-id','t1','worker','req-1','progress']).turnId,'t1');
  assert.throws(()=>parseRespondArgs(['worker','req-1','--progress']),/Unknown option --progress.*bare word progress/);
  assert.throws(()=>parseRespondArgs(['worker','req-1','--kind','progress']),/Unknown option --kind/);
  assert.throws(()=>parseRespondArgs(['worker','req-1','Working on it']),/Unknown reply kind/);
  assert.throws(()=>parseRespondArgs(['worker','req-1','progress','extra']),/Unexpected argument/);
  assert.throws(()=>parseRespondArgs(['worker','req-1','progress','--outcome']),/needs a value/);
  assert.throws(()=>parseRespondArgs(['worker']),/request ID are required/);
});

test('the reply form in the role parses to each kind',()=>{
  assert.match(cliReplyRule,/ffd reply 'REQUEST-ID' progress/);assert.match(cliReplyRule,/never sends twice/);
  for(const kind of ['progress','final'] as const)assert.equal(parseRespondArgs(['worker','master:wa:1',kind]).kind,kind);
});
