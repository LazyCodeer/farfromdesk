import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store.js';
import { desktopCatalog } from './desktop-control.js';

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
  const destination = store.destination() ?? null;
  // Window and tab refs belong to the runner and the owner's chat, not one message: "now attach the
  // image" is a new run, and per-run refs made it rediscover every window (DESKTOP_TARGET_STALE, live
  // 5 Nov 2026). The pass itself stays per run.
  const scope = `direct:${destination ? `${id.split(':')[0]}:${destination}` : id}`;
  store.set(key(id), JSON.stringify({ hash: digest(token), expires: Date.now() + MAX_MS, destination, scope }));
  const quoted = file.replaceAll("'", "'\\''");
  const post = `curl -s --max-time 70 -X POST 'http://127.0.0.1:${port}/api/direct/desktop-control' -H 'Content-Type: application/json' -H 'X-Direct-Run: ${id}' -H "Authorization: Bearer $(cat '${quoted}')" --data-binary @-`;
  // Muse read "draft an X post" as a git pull request and spent ~12 turns grepping the app's JS for
  // these argument names, and another 5 querying the Social database (live, 5 Nov 2026), so both are here.
  const note = `For anything in the owner's Mac apps (Apple Notes, Calendar, Reminders, Mail, Finder, Safari, Music, Messages, browser tabs such as Gmail, or any app window), use the owner's FarFromDesk tools, not your own memory, APIs, AppleScript or the app's files. "My notes" means Apple Notes. "X" means x.com, the social network (a "post" or "draft" there is a tweet, never a git pull request). Call: echo '<json>' | ${post} . App tools: {"action":"app_tools","text":"<the owner words>"} lists them; {"action":"app_tool","tool":"<name>","args":{...string values}} runs one. Social drafts the owner made in FarFromDesk (caption plus image paths in Downloads): {"action":"social_drafts"}. Desktop actions, each a JSON object with action plus these fields: ${desktopCatalog()}. appRef comes from list_apps, windowRef from list_windows (or list_tabs for new_tab), tabRef from list_tabs, snapshotId and controlId from read_window. pick_file chooses a file (text, e.g. ~/Downloads/x.jpg) in the macOS file picker an upload button opened in browser. Every action except list_* and read_* also needs "actionId":"<a new UUID>". Add "send":true to read_window or read_tab with screenshot:true to send that screenshot to the owner's chat. To draft an X post: social_drafts for the caption and image, list_tabs, new_tab with url https://x.com/intent/post?text=<URL-encoded caption>, then list_apps, list_windows and read_window on the browser to click the add-photo control and pick_file the image with browser set to that browser. Never press Post or Send unless the owner said to. Answer from what the tools return.`;
  return { note, close() { store.set(key(id), 'null'); rmSync(file, { force: true }); } };
}

/** The run's grant (its ref scope and the owner chat it was opened for) when the token is its own. */
export function directMacGrant(store: Store, runId: unknown, token: string): { scope: string; destination: string | null } | undefined {
  if (typeof runId !== 'string' || !token) return undefined;
  let grant: { hash?: string; expires?: number; scope?: string; destination?: string | null } | null = null;
  try { grant = JSON.parse(store.get(key(runId)) ?? 'null'); } catch { return undefined; }
  if (!grant?.hash || typeof grant.expires !== 'number' || grant.expires < Date.now()) return undefined;
  const a = Buffer.from(grant.hash), b = Buffer.from(digest(token));
  return a.length === b.length && timingSafeEqual(a, b) ? { scope: grant.scope ?? `direct:${runId}`, destination: grant.destination ?? null } : undefined;
}
export const directMacAllowed = (store: Store, runId: unknown, token: string) => !!directMacGrant(store, runId, token);
