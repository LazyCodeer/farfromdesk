import test from 'node:test';
import assert from 'node:assert/strict';
import { EmbeddedDesktopDriver } from '../src/desktop-driver.js';

// A refusal is an answer, not a broken driver. Ending the connection for one closed it under the
// brain's other steps, which failed with "Connection closed" (logged live, 4 November 2026).
test('a driver refusal keeps the connection; a transport failure ends it', async () => {
  const d = new EmbeddedDesktopDriver('/nonexistent/');
  const client = { callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'element not found' }] }), close: async () => {} };
  (d as any).client = client;
  await assert.rejects(d.call('click', {}), /DESKTOP_NATIVE_REFUSED/);
  assert.equal(d.revision, 0, 'still connected');
  assert.equal((d as any).client, client);
  client.callTool = async () => { throw new Error('MCP error -32000: Connection closed'); };
  await assert.rejects(d.call('click', {}), /Connection closed/);
  assert.equal(d.revision, 1, 'a real transport failure stops it');
  d.stop();
});

test('one slow call timing out keeps the connection for the other steps', async () => {
  const d = new EmbeddedDesktopDriver('/nonexistent/');
  const client = { callTool: async () => { throw Object.assign(new Error('MCP error -32001: Request timed out'), { code: -32001 }); }, close: async () => {} };
  (d as any).client = client;
  await assert.rejects(d.call('hotkey', {}), /timed out/);
  assert.equal(d.revision, 0, 'still connected');
  d.stop();
});

test('overlapping calls leave one idle timer, so a stray one cannot stop the driver mid-task', async () => {
  const d = new EmbeddedDesktopDriver('/nonexistent/');
  let release!: () => void;
  const slow = new Promise<void>(r => { release = r; });
  const client = { callTool: async ({ name }: any) => { if (name === 'slow') await slow; return { content: [{ type: 'text', text: '{}' }] }; }, close: async () => {} };
  (d as any).client = client;
  const a = d.call('slow', {});
  await d.call('fast', {});
  assert.equal((d as any).idle, undefined, 'no idle timer while a call is still running');
  release(); await a;
  assert.ok((d as any).idle, 'idle timer once nothing runs');
  d.stop();
});
