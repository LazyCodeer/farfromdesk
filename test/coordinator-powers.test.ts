import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { turnEnvelope, updateRole } from '../src/roles.js';

test('persistent sessions are told once when the role changes; Telegram button taps count as owner input',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-powers-')),store=new Store(join(dir,'state.db'));
  try {
    const b=store.register('worker','claude','11111111-1111-4111-a111-111111111111',dir).binding;
    const first=turnEnvelope(store,b,'First','wa:1',{},[],dir,true);
    assert.doesNotMatch(first.body,/role bootstrap|role updated/);first.acknowledge();
    updateRole(store,b,'cheerful');
    const changed=turnEnvelope(store,b,'Next','wa:2',{},[],dir,true);
    assert.match(changed.body,/role updated to .*Read the role file/);changed.acknowledge();
    assert.doesNotMatch(turnEnvelope(store,b,'Again','wa:3',{},[],dir,true).body,/role updated/);
    assert.equal(store.ownerInputId('tg-choice:1:cb2'),true);
    assert.equal(store.ownerInputId('tg-choicex:1'),false);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
