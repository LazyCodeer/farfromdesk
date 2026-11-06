import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProviderHookReport } from './provider-hooks.js';

const run = promisify(execFile);

/**
 * Repairs the provider hooks in a separate process and reads back its report.
 *
 * Startup has to read the owner's provider config, and those paths are not always
 * local: on this Mac `~/.claude` is a symlink onto an external volume. A read that
 * waits on a sleeping or busy disk freezes the thread it runs on, and on the
 * bridge's own thread that was a quiet death: the port answered nothing, no
 * permission prompt could be reported, and the only way out was to kill the app.
 *
 * A child process can be killed when it does not come back, which a thread stuck
 * inside a system call cannot. `null` means the report never arrived, and the
 * caller says so instead of pretending the hooks are fine.
 */
export async function repairProviderHooks(options: {
  node: string;
  cli: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<ProviderHookReport[] | null> {
  try {
    const { stdout } = await run(
      options.node,
      [options.cli, 'install-hooks', '--json'],
      {
        timeout: options.timeoutMs ?? 15_000,
        // A process waiting on a stalled disk ignores a polite signal.
        killSignal: 'SIGKILL',
        // The app starts this backend without a console; a visible one would flash.
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: options.env ?? process.env,
      },
    );
    const parsed = JSON.parse(String(stdout).trim());
    if (!Array.isArray(parsed)) return null;
    return parsed as ProviderHookReport[];
  } catch {
    return null;
  }
}