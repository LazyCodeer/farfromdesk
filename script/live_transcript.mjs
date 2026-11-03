/**
 * Replay a transcript against the running app.
 *
 * This is the live half of the eval harness: the tests replay transcripts against a fake
 * driver, and this replays them against the Mac. It posts each line through the app's own
 * composer route (`POST /api/inbox-send`), which mirrors a fresh owner text message exactly,
 * then waits and prints what the app answered.
 *
 *   node script/live_transcript.mjs "Could you open notes" "write a note that buy milk"
 *   node script/live_transcript.mjs --dry          # check the plumbing, send nothing
 *
 * It writes to the owner's real chat, so a turn someone is watching will see it. The admin
 * token is the app's own, read from the same file the app writes it to; nothing here can
 * drive the screen without that app being installed and running.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.FFD_APP_DATA ?? join(homedir(), 'Library', 'Application Support', 'FarFromDesk Local');
const BASE = process.env.FFD_BASE_URL ?? 'http://127.0.0.1:47961';
const dry = process.argv.includes('--dry');
const lines = process.argv.slice(2).filter(arg => arg !== '--dry');
if (!lines.length && !dry) { console.error('usage: node script/live_transcript.mjs [--dry] "turn one" "turn two" ...'); process.exit(2); }

const token = readFileSync(join(APP, 'admin-token'), 'utf8').trim();
const db = new DatabaseSync(join(APP, 'bridge.sqlite'), { readOnly: true });
const since = () => Number((db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM outbox').get() ?? {}).n ?? 0);
const waitFor = async (after, ms = 90000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const rows = db.prepare('SELECT rowid,destination,body FROM outbox WHERE rowid>? ORDER BY rowid').all(after);
    if (rows.some(row => String(row.body ?? '').trim())) return rows;
    await new Promise(done => setTimeout(done, 400));
  }
  return db.prepare('SELECT rowid,destination,body FROM outbox WHERE rowid>? ORDER BY rowid').all(after);
};

if (dry) {
  console.log(`app data   ${APP}`);
  console.log(`base url   ${BASE}`);
  console.log(`token      ${token.length} characters`);
  console.log(`outbox     ${since()} rows`);
  const targets = db.prepare("SELECT key,value FROM settings WHERE key LIKE 'owner-target:%'").all();
  for (const row of targets) console.log(`target     ${row.key.replace('owner-target:', '')} = ${row.value}`);
  process.exit(0);
}

let cursor = since();
for (const text of lines) {
  console.log(`>>> ${text}`);
  const response = await fetch(`${BASE}/api/inbox-send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ text }),
  });
  const body = await response.text();
  console.log(`    [${response.status}] ${body.slice(0, 300)}`);
  if (!response.ok) { console.error('    the app refused the turn; stopping so the reason is not lost'); process.exitCode = 1; break; }
  const rows = await waitFor(cursor);
  for (const row of rows) {
    if (row.rowid <= cursor) continue;
    cursor = Math.max(cursor, Number(row.rowid));
    const reply = String(row.body ?? '').trim();
    if (reply) console.log(`<<< ${reply.split('\n').map((l, i) => (i ? `    ${l}` : l)).join('\n')}`);
  }
  console.log('');
}
db.close();