import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Items } from '../src/items.js';
import { itemSessionLabel } from '../src/item-session-label.js';

test('item labels show platform and workspace while preserving exact native identity',()=>{
  const store=new Store(':memory:');try {
    const b=store.register('codex-task','codex','11111111-1111-4111-a111-111111111111','/projects/FarFromDesk').binding;
    store.set(`execution-mode:${b.id}`,'desktop');
    const original='Can you check this long confusing title?';store.set(`name:${b.id}`,original);
    const items=new Items(store),item=items.add('Improve notifications',undefined,b.id);
    assert.match(items.text(),/Codex Desktop · FarFromDesk/);assert.doesNotMatch(items.text(),/confusing title/);
    assert.equal(items.view()[0].sessionTitle,original);assert.equal(items.view()[0].binding_id,b.id);
    assert.equal(items.session(original).id,b.id);assert.equal(items.session('codex-task').native_id,b.native_id);
    assert.equal(items.session(itemSessionLabel(store,b)).id,b.id);
    assert.equal(store.get(`name:${b.id}`),original);assert.match(items.show(item.id),/Original chat title:/);
    const other=store.register('codex-other','codex','22222222-2222-4222-a222-222222222222',b.cwd).binding;
    store.set(`execution-mode:${other.id}`,'desktop');
    assert.notEqual(itemSessionLabel(store,b),itemSessionLabel(store,other));
    store.set(`name:${other.id}`,original);assert.throws(()=>items.session(original),/More than one/);
    assert.equal(items.session(b.id).id,b.id);
  }finally{store.close();}
});
