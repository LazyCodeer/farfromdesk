import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computerName } from './platform.js';
import type { Store } from './store.js';

/**
 * A one-run pass to the owner's computer app tools for a direct /muse, /deepseek or /cursor run.
 *
 * Those runs are not coordinator jobs, so the coordinator route refused them, and Muse answered
 * "check my recent notes" from its own memory files and "my calendar" with "OAuth client deleted"
 * (live, 4 November 2026). The pass lives only while the run does: the token sits in a 0600 file
 * the run's curl reads when it runs, so it never appears in the prompt or the transcript, and
 * only its hash is stored. Closing the run removes both.
 */
const MAX_MS = 25 * 60 * 1000;
const key = (id: string) => `direct-mac:${id}`;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * The curl command a headless session pipes JSON into, for this platform.
 *
 * macOS keeps its POSIX form, where the shell reads the token with `$(...)`. On Windows that
 * substitution means nothing to cmd and runs differently in PowerShell, so the token arrived empty
 * and every call got a 401. There curl reads the whole Authorization header from a file itself
 * (`-H @file`), which needs no shell feature at all, and `curl.exe` is named because `curl` in
 * Windows PowerShell 5.1 is an alias for Invoke-WebRequest. Double quotes read the same in
 * PowerShell, bash and cmd for these values.
 */
export function bridgeCurl(platform: NodeJS.Platform, url: string, headers: string[], auth: { posixToken: string } | { headerFile: string }, secs = 70): string {
  if (platform === 'win32') {
    if (!('headerFile' in auth)) throw new Error('A Windows bridge command reads its token from a header file.');
    return `curl.exe -s --max-time ${secs} -X POST "${url}" ${headers.map(h => `-H "${h}"`).join(' ')} -H "@${auth.headerFile}" --data-binary "@-"`;
  }
  if (!('posixToken' in auth)) throw new Error('A POSIX bridge command reads its token in the shell.');
  return `curl -s --max-time ${secs} -X POST '${url}' ${headers.map(h => `-H '${h}'`).join(' ')} -H "Authorization: Bearer ${auth.posixToken}" --data-binary @-`;
}

/** Writes the header file a Windows `bridgeCurl` points at. Owner-only, like the token file. */
export function writeAuthHeader(file: string, token: string) {
  writeFileSync(file, `Authorization: Bearer ${token}\n`, { mode: 0o600 });
}

/** Windows PowerShell 5.1 pipes text to a program as ASCII, so non-ASCII owner words go in as JSON escapes. */
export const WINDOWS_PIPE_NOTE = ' Write any non-ASCII character in the JSON as a \\uXXXX escape.';

/** What the owner's apps are called in a session note, for this platform. */
export function ownerAppsPhrase(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `the owner's ${computerName(platform)} apps (Outlook calendar, mail and tasks, OneNote, files, what is playing, browser tabs such as Gmail, or any app window)`;
  return `the owner's ${computerName(platform)} apps (Apple Notes, Calendar, Reminders, Mail, Finder, Safari, Music, Messages, browser tabs such as Gmail, or any app window)`;
}

export function openDirectMac(store: Store, stateDir: string, port: string, runId: string, platform: NodeJS.Platform = process.platform): { note: string; close(): void } {
  const id = runId.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120), token = randomBytes(32).toString('hex');
  const windows = platform === 'win32';
  const dir = join(stateDir, 'direct-mac'), base = join(dir, createHash('sha256').update(id).digest('hex').slice(0, 24));
  const file = windows ? `${base}.header` : `${base}.token`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (windows) writeAuthHeader(file, token);
  else writeFileSync(file, token, { mode: 0o600 });
  store.set(key(id), JSON.stringify({ hash: digest(token), expires: Date.now() + MAX_MS, destination: store.destination() ?? null }));
  const url = `http://127.0.0.1:${port}/api/direct/desktop-control`, headers = ['Content-Type: application/json', `X-Direct-Run: ${id}`];
  const post = windows
    ? bridgeCurl(platform, url, headers, { headerFile: file })
    : bridgeCurl(platform, url, headers, { posixToken: `$(cat '${file.replaceAll("'", "'\\''")}')` });
  const which = windows
    ? `For anything in ${ownerAppsPhrase(platform)}, use the owner's FarFromDesk tools, not your own memory, APIs or scripts. "My notes" means OneNote and "my calendar" means Outlook.`
    : `For anything in ${ownerAppsPhrase(platform)}, use the owner's FarFromDesk tools, not your own memory, APIs or AppleScript. "My notes" means Apple Notes.`;
  const note = `${which} List tools: echo '{"action":"app_tools","text":"<the owner words>"}' | ${post} . Run one: echo '{"action":"app_tool","tool":"<name>","args":{...string values}}' | ${post} (a tool that writes also needs "actionId":"<a new UUID>"). Browser tabs: {"action":"list_tabs","browser":"comet"} then {"action":"read_tab","tabRef":"<from list_tabs>"}. Answer from what they return.${windows ? WINDOWS_PIPE_NOTE : ''}`;
  return { note, close() { store.set(key(id), 'null'); rmSync(file, { force: true }); } };
}

export function directMacAllowed(store: Store, runId: unknown, token: string): boolean {
  if (typeof runId !== 'string' || !token) return false;
  let grant: { hash?: string; expires?: number } | null = null;
  try { grant = JSON.parse(store.get(key(runId)) ?? 'null'); } catch { return false; }
  if (!grant?.hash || typeof grant.expires !== 'number' || grant.expires < Date.now()) return false;
  const a = Buffer.from(grant.hash), b = Buffer.from(digest(token));
  return a.length === b.length && timingSafeEqual(a, b);
}
