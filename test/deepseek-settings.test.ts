import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

/**
 * The owner's DeepSeek settings, over the local admin route. What matters here: a provider that is
 * not DeepSeek can be named, the key is stored but never returned, and an unconfigured route is
 * reported as unconfigured rather than as working.
 */
test('the owner stores a DeepSeek provider and key without the key ever coming back', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'wsb-deepseek-settings-'));
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as any).port;
  await new Promise<void>(r => probe.close(() => r()));
  process.env.WSB_STATE_DIR = temp;
  process.env.WSB_PORT = String(port);
  // The app reads the owner's own DSH profile and credential store, which is the point of the
  // feature, so a test about defaults has to point DSH_HOME at an empty home of its own.
  const savedDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(temp, 'dsh');
  const [{ Store }, { Router }, { Approvals }, { serve }] = await Promise.all([
    import('../src/store.js'),
    import('../src/router.js'),
    import('../src/approvals.js'),
    import('../src/server.js'),
  ]);
  const store = new Store(':memory:');
  const router = new Router(store, { run: async () => {}, stop: () => {} } as any, new Approvals(store));
  const server = serve(store, router, { status: 'not paired' } as any, 'test-admin-token', {} as any);
  await new Promise<void>(r => server.once('listening', r));
  const url = `http://127.0.0.1:${port}`;
  const headers = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' };
  try {
    const before = await (await fetch(url + '/api/deepseek', { headers })).json() as any;
    assert.equal(before.route, 'deepseek-official');
    assert.equal(before.model, 'deepseek-flash');
    assert.equal(before.keyEnv, 'DEEPSEEK_API_KEY');
    assert.equal(before.configured, false);
    assert.equal(before.hasStoredKey, false);
    assert.match(before.hint, /needs an API key/);

    const saved = await (await fetch(url + '/api/deepseek', {
      method: 'POST',
      headers,
      body: JSON.stringify({ provider: 'openai', model: 'gpt-5', reasoningEffort: 'high', apiKey: 'sk-stored-secret' }),
    })).json() as any;
    assert.equal(saved.route, 'openai');
    assert.equal(saved.model, 'gpt-5');
    assert.equal(saved.keyEnv, 'OPENAI_API_KEY', 'the key variable follows the provider');
    assert.equal(saved.keySource, 'settings');
    assert.equal(saved.configured, true);
    assert.equal(saved.hasStoredKey, true);
    assert.ok(!JSON.stringify(saved).includes('sk-stored-secret'), 'the key is never returned');
    assert.equal(store.get('deepseek-api-key'), 'sk-stored-secret');

    // A variable name that is not one is refused rather than written.
    const bad = await fetch(url + '/api/deepseek', { method: 'POST', headers, body: JSON.stringify({ keyEnv: 'not a variable' }) });
    assert.equal(bad.status, 400);

    const cleared = await (await fetch(url + '/api/deepseek', { method: 'POST', headers, body: JSON.stringify({ clearKey: true }) })).json() as any;
    assert.equal(cleared.hasStoredKey, false);
    assert.equal(cleared.configured, false, 'an inherited variable is not claimed as a stored one');
    assert.equal(store.get('deepseek-api-key'), '');
  } finally {
    if (savedDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedDshHome;
    await new Promise<void>(r => server.close(() => r()));
    rmSync(temp, { recursive: true, force: true });
  }
});
/**
 * The sessions view the app draws. It has to agree with the chat commands, because both read the
 * same store keys and the same records: a session the panel cannot see is a session the owner cannot
 * switch back to.
 */
test('the app sees, switches and feeds the labelled DeepSeek sessions of one folder', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'wsb-deepseek-sessions-'));
  const workspace = mkdtempSync(join(tmpdir(), 'wsb-deepseek-folder-'));
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as any).port;
  await new Promise<void>(r => probe.close(() => r()));
  process.env.WSB_STATE_DIR = temp;
  process.env.WSB_PORT = String(port);
  const savedDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(temp, 'dsh');
  const [{ Store }, { Router }, { Approvals }, { serve }] = await Promise.all([
    import('../src/store.js'),
    import('../src/router.js'),
    import('../src/approvals.js'),
    import('../src/server.js'),
  ]);
  const store = new Store(':memory:');
  store.set('deepseek-workspace', workspace);
  const router = new Router(store, { run: async () => {}, stop: () => {} } as any, new Approvals(store));
  const server = serve(store, router, { status: 'not paired' } as any, 'test-admin-token', {} as any);
  await new Promise<void>(r => server.once('listening', r));
  // `config.port` is read once at import, so the address the server actually bound is the truth here.
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const headers = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' };
  const view = async (body?: any) => (await (await fetch(url + '/api/deepseek', body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers })).json()) as any;
  try {
    const first = await view();
    assert.equal(first.workspace, workspace, 'the configured workspace is reported as it is');
    assert.equal(first.folder, workspace, 'and the view names the folder it is describing');
    assert.deepEqual(first.sessions.map((s: any) => s.label), ['default'], 'a folder starts with the default session');
    assert.equal(first.activeLabel, 'default');
    assert.equal(first.sessions[0].sessionId, null, 'no session id until a task runs');
    assert.equal(first.inbox.length, 0);

    const created = await view({ action: 'new', label: 'research' });
    assert.deepEqual(created.sessions.map((s: any) => s.label), ['default', 'research']);
    assert.equal(created.activeLabel, 'research', 'a new session becomes the active one');
    assert.equal(created.sessions.find((s: any) => s.label === 'research').active, true);

    const refused = await fetch(url + '/api/deepseek', { method: 'POST', headers, body: JSON.stringify({ action: 'use', label: 'not-a-session' }) });
    assert.equal(refused.status, 400, 'switching to a session that does not exist is refused');

    const used = await view({ action: 'use', label: 'default' });
    assert.equal(used.activeLabel, 'default');

    const sent = await view({ action: 'send', label: 'research', text: 'Please check the failing test.' });
    assert.equal(sent.sessions.find((s: any) => s.label === 'research').pending, 1, 'the panel sees an undelivered message');
    assert.equal(sent.inboxLabel, 'default', 'the inbox that came back names whose it is');
    const research = await view({ action: 'use', label: 'research' });
    assert.equal(research.inboxLabel, 'research');
    const note = research.inbox.find((m: any) => m.text === 'Please check the failing test.');
    assert.equal(note?.state, 'prepared', 'a message the app writes is prepared until a turn carries it');
    assert.equal(note?.from, 'the app');

    const stopped = await view({ action: 'stop', label: 'research' });
    assert.equal(stopped.sessions.length, 2, 'stopping nothing is not an error');

    // A session belongs to a workspace, so the view has to keep them apart rather than pile them up.
    const other = mkdtempSync(join(tmpdir(), 'wsb-deepseek-other-'));
    try {
      const elsewhere = await view({ action: 'new', label: 'release', folder: other });
      assert.equal(elsewhere.folder, other, 'the action happened in the folder it named');
      assert.deepEqual(elsewhere.sessions.map((s: any) => s.label), ['default', 'release']);
      assert.deepEqual(elsewhere.workspaces.map((w: any) => w.folder), [workspace, other].sort());
      const here = elsewhere.workspaces.find((w: any) => w.folder === workspace);
      assert.deepEqual(here.sessions.map((s: any) => s.label), ['default', 'research'], 'each workspace keeps its own sessions');
      const staged = await view({ action: 'workspace', folder: workspace });
      assert.equal(staged.workspace, workspace, 'the app can pick which workspace it is looking at');
      const refused = await fetch(url + '/api/deepseek', { method: 'POST', headers, body: JSON.stringify({ action: 'workspace', folder: join(other, 'not-there') }) });
      assert.equal(refused.status, 400, 'a folder that does not exist is refused');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    if (savedDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedDshHome;
    await new Promise<void>(r => server.close(() => r()));
    rmSync(temp, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
