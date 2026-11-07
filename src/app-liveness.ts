import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { probeWindowsApps, probeWindowsAppsSync } from './desktop-apps.js';

const exec=promisify(execFile);

/** Bundle identifiers that own a native session, as reported by LaunchServices. */
const CODEX_APPS=['com.openai.codex'];
const CLAUDE_APPS=['com.anthropic.claudefordesktop','com.anthropic.claude'];

/**
 * Cheap liveness probe for the desktop apps that own native sessions.
 * One `lsappinfo list` per maintenance tick, matched by bundle identifier rather than by
 * executable name: the Codex desktop app ships as "ChatGPT.app", so a path match misses it
 * and the bridge wrongly told the owner the app was closed while it was answering.
 * Any failure reports `true`, so the bridge never claims an app is closed when it cannot tell.
 */
export async function probeDesktopApps():Promise<{codex:boolean;claude:boolean}> {
  // Windows: filtered `tasklist /apps`, matched by package identity, not by image name alone:
  // Claude Code's CLI is also claude.exe, and Codex Desktop runs as ChatGPT.exe.
  if(process.platform==='win32')return probeWindowsApps().catch(()=>({codex:true,claude:true}));
  if(process.platform!=='darwin')return {codex:true,claude:true};
  try {
    const {stdout}=await exec('/usr/bin/lsappinfo',['list'],{timeout:2500,maxBuffer:1024*1024});
    const ids=new Set([...String(stdout).matchAll(/bundleID="([^"]+)"/g)].map(match=>match[1]));
    return {codex:CODEX_APPS.some(id=>ids.has(id)),claude:CLAUDE_APPS.some(id=>ids.has(id))};
  } catch {
    return {codex:true,claude:true};
  }
}

/**
 * Same probe, synchronous, for the moment a receipt is written: a cached answer can be a minute
 * old, which is how a message that arrived seconds after the app quit still read "queued".
 * One 30ms `lsappinfo` per owner message, so this never runs on a timer.
 */
export function probeDesktopAppsNow():{codex:boolean;claude:boolean} {
  // Windows answers from the newest background probe: a synchronous tasklist can take seconds.
  if(process.platform==='win32')return probeWindowsAppsSync();
  if(process.platform!=='darwin')return {codex:true,claude:true};
  try {
    const stdout=execFileSync('/usr/bin/lsappinfo',['list'],{timeout:2500,maxBuffer:1024*1024,encoding:'utf8'});
    const ids=new Set([...String(stdout).matchAll(/bundleID="([^"]+)"/g)].map(match=>match[1]));
    return {codex:CODEX_APPS.some(id=>ids.has(id)),claude:CLAUDE_APPS.some(id=>ids.has(id))};
  } catch {
    return {codex:true,claude:true};
  }
}
