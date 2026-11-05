import test from 'node:test';
import assert from 'node:assert/strict';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { ownerPath } from '../src/desktop-control.js';

test('owner paths in Downloads resolve, hidden or escaping ones do not', () => {
  const home = userInfo().homedir;
  assert.equal(ownerPath('~/Downloads/a.pdf'), join(home, 'Downloads', 'a.pdf'));
  assert.equal(ownerPath(join(home, 'Downloads', 'a.pdf')), join(home, 'Downloads', 'a.pdf'), 'a full path was refused before the fix');
  assert.equal(ownerPath('~/Downloads/.secret/a.pdf'), undefined);
  assert.equal(ownerPath('~/Library/a.pdf'), undefined);
  assert.equal(ownerPath('~/Downloads/../.ssh/id'), undefined);
});
test('every runner gets pick_file from the one catalog, and it refuses files outside the owner folders', async () => {
  const { desktopCatalog, DesktopControl } = await import('../src/desktop-control.js');
  assert.match(desktopCatalog(), /pick_file\{browser,text,actionId\}/);
  const c = new DesktopControl({ get: () => undefined, set: () => {} } as any);
  await assert.rejects(c.run('s', { action: 'pick_file', browser: 'Comet', text: '~/Library/x.jpg', actionId: crypto.randomUUID() }), /DESKTOP_FILE_REFUSED/);
});
