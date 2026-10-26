import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRespondArgs, replyCommands } from '../src/reply-args.js';

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

test('the envelope names both full commands and each one parses to its kind',()=>{
  const r=replyCommands("'/node' '/cli.js' respond 'worker' 'master:wa:1'");
  for(const kind of ['progress','final'] as const) {
    const words=r[kind].split(' ').map(w=>w.replace(/^'|'$/g,'')).slice(3);
    assert.equal(parseRespondArgs(words).kind,kind);assert.ok(r[kind].endsWith(` ${kind}`));
  }
  assert.match(r.stdin,/heredoc/);
});
