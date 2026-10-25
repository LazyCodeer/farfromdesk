import test from 'node:test';
import assert from 'node:assert/strict';
import { selectClaudeDiscovery, inboxPaths, hasClaudeInbox } from '../src/desktop-claude.js';

test('desktop discovery prefers the running app executable independently of standalone CLI login',()=>{
  const paths={running:['/desktop/2.1.308/claude'],configured:'/bin/desktop-latest',launcher:'/bin/launcher',fallback:'/bin/standalone'};
  assert.equal(selectClaudeDiscovery(paths,()=>true),'/desktop/2.1.308/claude');
  assert.equal(selectClaudeDiscovery({...paths,running:[]},()=>true),'/bin/desktop-latest');
  assert.equal(selectClaudeDiscovery({...paths,running:[]},p=>p!=='/bin/desktop-latest'),'/bin/launcher');
  assert.equal(selectClaudeDiscovery({...paths,running:[]},()=>false),'/bin/standalone');
});

test('explicit desktop override fails closed when missing and versions are re-evaluated',()=>{
  const paths={running:['/desktop/2.1.99/claude','/desktop/2.1.308/claude'],fallback:'claude'};
  assert.equal(selectClaudeDiscovery(paths,()=>true),'/desktop/2.1.308/claude');
  assert.equal(selectClaudeDiscovery({...paths,override:'/chosen/claude'},()=>true),'/chosen/claude');
  assert.throws(()=>selectClaudeDiscovery({...paths,override:'/missing'},()=>false),/unavailable/);
  assert.throws(()=>selectClaudeDiscovery({...paths,override:'relative'},()=>true),/unavailable/);
});

test('readiness accepts only the exact PID inbox pattern used by desktop-sync',async()=>{
  const list='p123\nf20\nn/tmp/cc-socks-501/123.sock\nf21\nn/tmp/cc-socks-501/456.sock\nn/tmp/other/123.sock\nn->0xdeadbeef';
  assert.deepEqual(inboxPaths(list,123),['/tmp/cc-socks-501/123.sock']);
  assert.deepEqual(inboxPaths('p123\nn->0xdeadbeef',123),[]);
  assert.equal(await hasClaudeInbox('123'),false);assert.equal(await hasClaudeInbox(-1),false);
});
