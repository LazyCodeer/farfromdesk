import { closeSync, mkdirSync, openSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A loopback port for a test bridge server that no other test file in this run can get.
 *
 * The old pattern (listen on 0, read the port, close, then serve on it later) failed on
 * macOS CI: test files run in parallel, and between the close and the later listen the OS
 * handed the same ephemeral port to another socket. The logs showed
 * `listen EADDRINUSE 127.0.0.1:49210` and `fetch failed` from tests that pass on their own.
 *
 * So: ports come from 20000-29999, below every OS's ephemeral range (Linux 32768+, macOS
 * and Windows 49152+), which the OS never assigns on its own, and each one is claimed with
 * an exclusive lock file in the run's temp folder (one per run, shared by every test file),
 * so two files can never pick the same one. A bind check skips ports something else holds.
 */
export async function reservePort(): Promise<number> {
  const dir = join(tmpdir(), 'ffd-test-ports');
  mkdirSync(dir, { recursive: true });
  const start = Math.floor(Math.random() * 10000);
  for (let i = 0; i < 10000; i++) {
    const port = 20000 + ((start + i) % 10000);
    try { closeSync(openSync(join(dir, String(port)), 'wx')); } catch { continue; }
    const free = await new Promise<boolean>(resolve => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('No free test port in 20000-29999.');
}
