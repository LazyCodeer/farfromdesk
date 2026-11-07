import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Application modules cache their state root at import time.
const root = mkdtempSync(join(tmpdir(), 'ffd-brain-tabs-'));
process.env.WSB_STATE_DIR = root; process.env.FARFROMDESK_HOME = join(root, 'home');
test.after(() => rmSync(root, { recursive: true, force: true }));
const { Store } = await import('../src/store.js');
const { MetaBrain } = await import('../src/meta-brain.js');
const { MetaSecret } = await import('../src/meta-brain-config.js');

/** A brain whose desktop answers list_tabs per browser with `answer`. */
function brain(answer: (browser: string) => unknown) {
  const store = new Store(':memory:');
  const calls: any[] = [];
  const device = {
    assist: async () => ({}), targets: async () => [],
    run: async (_scope: string, q: any) => {
      calls.push(q);
      if (q.action !== 'list_tabs') return { tab_id: 't', text: 'page text', title: 'Docs', url: 'https://example.org/docs' };
      const r = answer(q.browser);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  const b = new MetaBrain(store, new MetaSecret(root), { interpret: async () => ({}) } as any, device as any) as any;
  return { b, calls, m: { id: 'm1', text: 'x' }, done: () => store.close() };
}
const notRunning = new Error('DESKTOP_BROWSER_NOT_RUNNING');
const one = { windows: [{ tabs: [{ tabRef: 'r1', title: 'Project docs', url: 'https://example.org/docs' }] }] };

test('a tab request says why the browsers could not be read instead of "No open tab matches"', async () => {
  const off = brain(() => new Error('MAC_CONTROL_DISABLED: Turn on Remote control in Settings, then try again.'));
  for (const said of [await off.b.readTabFor(off.m, 'docs', false), await off.b.focusTabFor(off.m, 'docs')]) {
    assert.equal(said, 'Refused: Desktop control is switched off in Settings. Turn on Remote control, then ask me again.');
  }
  assert.equal(await off.b.tabsData(off.m), 'Refused: Desktop control is switched off in Settings. Turn on Remote control, then ask me again.');
  off.done();
});

test('a browser that could not be read is named next to the ones that were', async () => {
  const mixed = brain(browser => browser === 'chrome' ? one : browser === 'edge' ? new Error('BROWSER_TAB_GONE: That browser window is no longer open. List the tabs again.') : notRunning);
  const said = await mixed.b.readTabFor(mixed.m, 'nothing-like-this', false);
  assert.match(said, /^No open tab matches "nothing-like-this" in the browsers I could read\. Some could not be read: That browser window is no longer open/);
  const read = JSON.parse(await mixed.b.readTabFor(mixed.m, 'docs', false));
  assert.equal(read.browser, 'chrome');
  assert.equal(read.text, 'page text');
  mixed.done();
});

test('with every browser simply closed the answer stays the plain one', async () => {
  const closed = brain(() => notRunning);
  assert.equal(await closed.b.focusTabFor(closed.m, 'docs'), 'No open tab matches "docs". Use list_tabs to see them.');
  closed.done();
});
