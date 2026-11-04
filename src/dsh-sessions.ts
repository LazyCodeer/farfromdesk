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
 * owner hears "this is behind the previous task" instead of seeing two answers fight. A *labelled*
 * session is its own queue, so three conversations in one workspace do not wait on each other.
 */

/**
 * Labels. A folder used to be the whole identity of a conversation, which allowed exactly one
 * session per workspace. Two sessions in one folder are two different `dsh` sessions with two
 * different ids, and the CLI adopts a session scoped to its working directory, so labels make
 * "three sessions in the spliceai workspace" possible without giving up the queue: the queue is per
 * label, not per folder, because two different conversations in one folder cannot corrupt each other.
 */
export const DEFAULT_DSH_LABEL = 'default';

export function dshSessionKey(folder: string, label: string): string {
  return `deepseek-session:${folder}:${label}`;
}

/** The key an app older than labels wrote. Read as a fallback, never written. */
export function dshLegacySessionKey(folder: string): string {
  return `deepseek-session:${folder}`;
}

export function dshActiveLabelKey(folder: string): string {
  return `deepseek-active-label:${folder}`;
}

export function dshLabelsKey(folder: string): string {
  return `deepseek-labels:${folder}`;
}

/** The queue key: one conversation, not one folder. */
export function dshQueueKey(folder: string, label: string = DEFAULT_DSH_LABEL): string {
  return `${folder}\u0000${label}`;
}

/** Labels this folder knows about, oldest first, with `default` always present. */
export function dshLabels(get: (key: string) => string | undefined, folder: string): string[] {
  let stored: string[] = [];
  try {
    const parsed = JSON.parse(get(dshLabelsKey(folder)) ?? '[]') as unknown;
    if (Array.isArray(parsed)) stored = parsed.filter((value): value is string => typeof value === 'string' && !!value.trim());
  } catch {
    stored = [];
  }
  const labels = [DEFAULT_DSH_LABEL, ...stored.filter(label => label !== DEFAULT_DSH_LABEL)];
  return labels.slice(0, 12);
}

export function addDshLabel(get: (key: string) => string | undefined, set: (key: string, value: string) => void, folder: string, label: string): void {
  const labels = dshLabels(get, folder);
  if (!labels.includes(label)) set(dshLabelsKey(folder), JSON.stringify([...labels.filter(value => value !== DEFAULT_DSH_LABEL), label].slice(0, 12)));
}

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

export function dshQueueState(folder: string, label: string = DEFAULT_DSH_LABEL): DshQueueState {
  const chain = chains.get(dshQueueKey(folder, label));
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
  label: string = DEFAULT_DSH_LABEL,
): {result: Promise<DshResult>; queued: boolean} {
  const key = dshQueueKey(folder, label);
  const chain = chains.get(key) ?? {tail: Promise.resolve(), running: 0, waiting: 0};
  chains.set(key, chain);
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
      if (chain.running === 0 && chain.waiting === 0 && chains.get(key) === chain) chains.delete(key);
    }
  });
  // A failed turn must not poison the folder's queue: the next message still runs.
  chain.tail = result.catch(() => undefined);
  return {result, queued};
}

/** Stop whatever is running in this folder. Reports whether there was anything to stop. */
export function dshCancel(folder: string, label: string = DEFAULT_DSH_LABEL): boolean {
  const controller = chains.get(dshQueueKey(folder, label))?.controller;
  if (!controller) return false;
  controller.abort();
  return true;
}