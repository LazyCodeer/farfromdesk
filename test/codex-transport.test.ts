import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { CodexSession } from '../src/codex-session.js';

test('a broken native input pipe rejects pending work once without replay or an uncaught stream error',async()=>{
  // Node with a nonexistent app-server entry is an inert fixture, never the installed Codex.
  const session=new CodexSession(process.execPath,tmpdir(),async()=>({}));
  let closed=0;session.on('closed',()=>closed++);
  const ended=once(session.process,'exit');
  try {
    const request=session.request('initialize',{});
    const rejected=assert.rejects(request,/connection ended; delivery may be uncertain/);
    session.process.stdin.destroy(Object.assign(new Error('fixture broken pipe'),{code:'EPIPE'}));
    await rejected;await ended;
    assert.equal(session.alive,false);assert.equal(session.pending.size,0);assert.equal(closed,1);
    await assert.rejects(session.request('initialize',{}),/offline/);
    assert.equal(session.sequence,1,'no automatic retry');
  }finally{session.close();}
});
