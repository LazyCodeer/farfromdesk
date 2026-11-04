import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store.js';

/**
 * A one-run pass to the owner's Mac app tools for a direct /muse, /deepseek or /cursor run.
 *
 * Those runs are not coordinator jobs, so the coordinator route refused them, and Muse answered
 * "check my recent notes" from its own memory files and "my calendar" with "OAuth client deleted"
 * (live, 4 November 2026). The pass lives only while the run does: the token sits in a 0600 file
 * the run's shell reads with cat, so it never appears in the prompt or the transcript, and only
 * its hash is stored. Closing the run removes both.
 */
const MAX_MS = 25 * 60 * 1000;
const key = (id: string) => `direct-mac:${id}`;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export function openDirectMac(store: Store, stateDir: string, port: string, runId: string): { note: string; close(): void } {
  const id = runId.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120), token = randomBytes(32).toString('hex');
  const dir = join(stateDir, 'direct-mac'), file = join(dir, `${createHash('sha256').update(id).digest('hex').slice(0, 24)}.token`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, token, { mode: 0o600 });
  store.set(key(id), JSON.stringify({ hash: digest(token), expires: Date.now() + MAX_MS, destination: store.destination() ?? null }));
  const quoted = file.replaceAll("'", "'\\''");
  const post = `curl -s --max-time 70 -X POST 'http://127.0.0.1:${port}/api/direct/desktop-control' -H 'Content-Type: application/json' -H 'X-Direct-Run: ${id}' -H "Authorization: Bearer $(cat '${quoted}')" --data-binary @-`;
  const note = `For anything in the owner's Mac apps (Apple Notes, Calendar, Reminders, Mail, Finder, Safari, Music, Messages, browser tabs such as Gmail, or any app window), use the owner's FarFromDesk tools, not your own memory, APIs or AppleScript. "My notes" means Apple Notes. List tools: echo '{"action":"app_tools","text":"<the owner words>"}' | ${post} . Run one: echo '{"action":"app_tool","tool":"<name>","args":{...string values}}' | ${post} (a tool that writes also needs "actionId":"<a new UUID>"). Browser tabs: {"action":"list_tabs","browser":"comet"} then {"action":"read_tab","tabRef":"<from list_tabs>"}. Answer from what they return.`;
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
