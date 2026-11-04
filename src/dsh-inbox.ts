import {mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

/**
 * Cross-session messages for DeepSeek sessions.
 *
 * A headless DeepSeek session is not a daemon: it exists for the length of one turn, so there is no
 * socket to hand a message to and no idle chat to wake. A message between sessions is therefore a
 * durable record on disk that the *receiving* session's next turn carries as part of its prompt. The
 * record is written before anything runs, so a crash cannot lose it or deliver it twice.
 *
 * The states mirror the discipline of `desktop-sync`, because the same lies are available here:
 * `submitted` is a local write, not a read by the other side.
 *
 * - `prepared`: on disk, no turn has taken it yet. The only state that may be picked up again.
 * - `dispatching`: a turn is being assembled with this message right now. Never picked up again, so
 *   a crash at this instant leaves the message reported rather than silently re-sent.
 * - `received`: a turn that carried it finished, so the message reached the model.
 * - `unknown`: a turn that carried it failed. The far side may or may not have read it, so it is
 *   withheld and reported; it is never re-delivered automatically.
 *
 * One JSON file per message means a message is one atomic rename away from existing, and a message
 * that is half-written can never be read as a valid record.
 */

export type DshMessageState = 'prepared' | 'dispatching' | 'received' | 'unknown';

export interface DshMessage {
  id: string;
  /** Display attribution only: a label the sender chose, never a verified identity. */
  from: string;
  text: string;
  createdAt: string;
  state: DshMessageState;
  stateAt: string;
  /** Why a message is `unknown`, in one line a person can read. */
  note?: string;
}

/** A folder name that keeps its identity on disk and in a log, without characters a path hates. */
export function folderSlug(folder: string): string {
  const name = folder.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-60) || 'root';
  return `${name}-${createHash('sha256').update(folder).digest('hex').slice(0, 8)}`;
}

export function inboxDir(root: string, folder: string, label: string): string {
  return join(root, 'deepseek-inbox', folderSlug(folder), label.replace(/[^A-Za-z0-9._-]+/g, '_'));
}

function persist(path: string, message: DshMessage): void {
  // Write beside the record, then rename over it: a reader either sees the old record or the new
  // one, never a half-written file.
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(message, null, 1), 'utf8');
  renameSync(temporary, path);
}

function readAll(directory: string): DshMessage[] {
  let names: string[] = [];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const messages: DshMessage[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const value = JSON.parse(readFileSync(join(directory, name), 'utf8')) as DshMessage;
      if (value?.id && typeof value.text === 'string' && value.state) messages.push(value);
    } catch {
      // An unreadable record is not a message; it stays on disk for a person to look at.
    }
  }
  return messages.sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)));
}

/** Every message for one session, oldest first. */
export function listMessages(root: string, folder: string, label: string): DshMessage[] {
  return readAll(inboxDir(root, folder, label));
}

export function pendingMessages(root: string, folder: string, label: string): DshMessage[] {
  return listMessages(root, folder, label).filter(message => message.state === 'prepared');
}

export interface SendOptions {
  root: string;
  folder: string;
  label: string;
  text: string;
  from: string;
  /** Supply an id when the caller needs to look the same message up after a crash. */
  id?: string;
  now?: () => string;
}

/**
 * Record a message for another session. Returns the stored record; its state is `prepared`, which
 * means "durably mine to deliver", not "the other session has seen it".
 */
export function sendMessage(options: SendOptions): DshMessage {
  const directory = inboxDir(options.root, options.folder, options.label);
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const at = (options.now ?? (() => new Date().toISOString()))();
  const message: DshMessage = {
    id: options.id ?? `deepseek-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`,
    from: options.from,
    text: options.text,
    createdAt: at,
    state: 'prepared',
    stateAt: at,
  };
  persist(join(directory, `${message.id}.json`), message);
  return message;
}

export function findMessage(root: string, folder: string, label: string, id: string): DshMessage | undefined {
  return listMessages(root, folder, label).find(message => message.id === id);
}

/**
 * Take every `prepared` message and mark it `dispatching` before the turn that carries it starts.
 * Nothing else may take a `dispatching` message, so a crash between this call and the model reading
 * the prompt leaves an honest `unknown` rather than a duplicate delivery.
 */
export function claimMessages(root: string, folder: string, label: string, now?: () => string): DshMessage[] {
  const directory = inboxDir(root, folder, label);
  const at = (now ?? (() => new Date().toISOString()))();
  const claimed: DshMessage[] = [];
  for (const message of pendingMessages(root, folder, label)) {
    const next: DshMessage = {...message, state: 'dispatching', stateAt: at};
    persist(join(directory, `${message.id}.json`), next);
    claimed.push(next);
  }
  return claimed;
}

/** Settle claimed messages once the turn's outcome is known. `prepared` and `unknown` are final here. */
export function settleMessages(
  root: string,
  folder: string,
  label: string,
  ids: string[],
  state: Extract<DshMessageState, 'received' | 'unknown'>,
  note?: string,
  now?: () => string,
): DshMessage[] {
  const directory = inboxDir(root, folder, label);
  const at = (now ?? (() => new Date().toISOString()))();
  const settled: DshMessage[] = [];
  for (const id of ids) {
    const current = findMessage(root, folder, label, id);
    if (!current || current.state !== 'dispatching') continue;
    const next: DshMessage = {...current, state, stateAt: at, ...(note ? {note: note.slice(0, 300)} : {})};
    persist(join(directory, `${id}.json`), next);
    settled.push(next);
  }
  return settled;
}

/** The prompt blocks a turn carries for the messages it claimed. */
export function messagePrompt(claimed: DshMessage[]): string {
  if (!claimed.length) return '';
  const blocks = claimed.map(message => `Message from ${message.from} (${message.id}):\n${message.text}`);
  return `${blocks.join('\n\n')}\n\n`;
}

/** Remove one record. Used by tests and cleanup, never by delivery. */
export function dropMessage(root: string, folder: string, label: string, id: string): void {
  try {
    unlinkSync(join(inboxDir(root, folder, label), `${id}.json`));
  } catch {
    // Nothing to drop.
  }
}
