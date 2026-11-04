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
    await new Promise<void>(r => server.close(() => r()));
    rmSync(temp, { recursive: true, force: true });
  }
});