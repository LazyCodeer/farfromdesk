import test from 'node:test';
import assert from 'node:assert/strict';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { MetaBrain } from '../src/meta-brain.js';

test('owner paths in Downloads resolve, hidden or escaping ones do not', () => {
  const ownerPath = (MetaBrain.prototype as any).ownerPath as (raw: string) => string | undefined;
  const home = userInfo().homedir;
  assert.equal(ownerPath('~/Downloads/a.pdf'), join(home, 'Downloads', 'a.pdf'));
  assert.equal(ownerPath(join(home, 'Downloads', 'a.pdf')), join(home, 'Downloads', 'a.pdf'), 'a full path was refused before the fix');
  assert.equal(ownerPath('~/Downloads/.secret/a.pdf'), undefined);
  assert.equal(ownerPath('~/Library/a.pdf'), undefined);
  assert.equal(ownerPath('~/Downloads/../.ssh/id'), undefined);
});
