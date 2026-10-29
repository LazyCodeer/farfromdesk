import test from 'node:test';
import assert from 'node:assert/strict';
import type {Router} from '../src/router.js';
import {ProofProjectSnapshots} from '../src/proof-project.js';

test('project capture is disabled without consulting state or the filesystem',async()=>{
  const router=new Proxy({} as Router,{get(){throw new Error('Disabled capture accessed bridge state');}});
  const snapshots=new ProofProjectSnapshots(router);
  assert.equal(await snapshots.capture('wa:synthetic-request','before'),false);
  assert.equal(await snapshots.capture('wa:synthetic-request','after'),false);
});
