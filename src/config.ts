import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultStateDirectory } from './platform.js';

export const stateDir = process.env.WSB_STATE_DIR ?? defaultStateDirectory();
export const port = Number(process.env.WSB_PORT ?? 47831);
export const baseUrl = `http://127.0.0.1:${port}`;
export const codexBin = process.env.WSB_CODEX_BIN ?? 'codex';
export const claudeBin = process.env.WSB_CLAUDE_BIN ?? 'claude';
export function initializeState() {
  if(process.platform !== 'win32') process.umask(0o077);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if(process.platform !== 'win32') chmodSync(stateDir, 0o700);
  const file = join(stateDir, 'admin-token');
  try { writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag:'wx' }); }
  catch(e:any) { if(e.code!=='EEXIST') throw e; }
  return readFileSync(file, 'utf8').trim();
}
