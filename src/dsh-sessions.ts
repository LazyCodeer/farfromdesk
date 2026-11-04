import {runDsh, type DshResult, type DshRunOptions} from './dsh-session.js';

/**
 * DeepSeek sessions and mid-task collaboration.
 *
 * One folder is one conversation: `dsh --profile headless --json -` opens a session and
 * `--session-id` continues it. Two turns in the same folder can therefore never run at the same
 * time — the second would either adopt a session the first is still writing or open a second one
 * and lose the thread. Measured on 4 November 2026: the CLI adopts a persisted session scoped to
 * its working directory, so a queue per folder is exactly the right granularity.
 *
 * The queue is also the collaboration surface: a message that arrives while a turn is running is
 * not dropped and not interleaved. It waits, in order, and the caller is told it was queued so the
 * owner hears "this is behind the previous task" instead of seeing two answers fight.
 */

export interface DshQueueState {
  /** A turn is running in this folder right now. */
  busy: boolean;
  /** Turns waiting behind it, including ones not started. */
  waiting: number;
}

interface Chain {
  tail: Promise<unknown>;
  running: number;
  waiting: number;
  controller?: AbortController;
}

const chains = new Map<string, Chain>();

export function dshQueueState(folder: string): DshQueueState {
  const chain = chains.get(folder);
  return {busy: (chain?.running ?? 0) > 0, waiting: chain?.waiting ?? 0};
}

/**
 * Run one turn, behind any turn already running in this folder. `queued` is decided at the moment
 * of the call, so the caller can say so before the run even starts.
 */
export function runDshQueued(
  folder: string,
  options: DshRunOptions,
  runner: (options: DshRunOptions) => Promise<DshResult> = runDsh,
): {result: Promise<DshResult>; queued: boolean} {
  const chain = chains.get(folder) ?? {tail: Promise.resolve(), running: 0, waiting: 0};
  chains.set(folder, chain);
  // `running` counts every turn that has been accepted for this folder (started or waiting), so the
  // state is honest the instant a message arrives — the first turn is in flight before its promise
  // callback has had a chance to run.
  const queued = chain.running > 0;
  chain.running += 1;
  if (queued) chain.waiting += 1;
  const controller = new AbortController();
  chain.controller = controller;
  const result = chain.tail.then(async () => {
    if (queued) chain.waiting -= 1;
    try {
      return await runner({...options, signal: controller.signal});
    } finally {
      chain.running -= 1;
      if (chain.running === 0 && chain.waiting === 0 && chains.get(folder) === chain) chains.delete(folder);
    }
  });
  // A failed turn must not poison the folder's queue: the next message still runs.
  chain.tail = result.catch(() => undefined);
  return {result, queued};
}

/** Stop whatever is running in this folder. Reports whether there was anything to stop. */
export function dshCancel(folder: string): boolean {
  const controller = chains.get(folder)?.controller;
  if (!controller) return false;
  controller.abort();
  return true;
}