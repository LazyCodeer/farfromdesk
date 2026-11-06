import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { constants } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { codexProfileHome } from './codex-profile.js';
import { computerName } from './platform.js';

/**
 * The bridge hears a native permission prompt only through the provider's own
 * hook. Installing it is a manual CLI step today, so a healthy signed-in Claude
 * install can sit on a permission dialog that the bridge never learns about.
 * This module installs and repairs exactly one hook per provider, namespaced by
 * our own command line, and never touches another tool's entries.
 */

export type ProviderHookState = 'current' | 'installed' | 'repaired' | 'unreadable' | 'unavailable' | 'owned-by-other';
export type ProviderHookReport = { provider:ProviderName; file:string; state:ProviderHookState; detail?:string; backup?:string; stateDir?:string };

export type ProviderName = 'codex' | 'claude';
export type HookTarget = { provider:ProviderName; node:string; cli:string; stateDir:string; port:number; home?:string; env?:NodeJS.ProcessEnv; takeOver?:boolean; platform?:NodeJS.Platform };

const EVENTS = ['Stop','PermissionRequest'] as const;
const PERMISSION_TIMEOUT_SECONDS = 920; // Just past the bridge's own 15 minute approval window.

/** A scratch state directory belongs to a throwaway run, never to the owner. */
export function scratchState(state:string, tmp=tmpdir()) {
  return state===tmp||state.startsWith(`${tmp}${sep}`)||/^\/(private\/)?(var\/folders|tmp)\//.test(state);
}
/** The isolated Local runtime has a private HOME, but the provider apps read the
 * owner's real profile, so a hook written under the private one is read by nobody.
 * This is the same rule `muse-paths.ts` uses, and it is why the first installed
 * build appeared to install hooks that no provider would ever load. */
export function ownerHome(env:NodeJS.ProcessEnv=process.env):string {
  const home=env.HOME?.trim()||homedir();
  const state=env.WSB_STATE_DIR?.trim();
  // Local's backend gets a private HOME under its own state directory. The
  // isolated flag is not always exported to it, so the state relationship is the
  // reliable signal; `codex-profile` relies on CODEX_HOME the same way.
  const privateHome=env.FFD_ISOLATED_LOCAL==='1'||!!state&&(home===state||home.startsWith(`${state}${sep}`));
  if(!privateHome)return home;
  try{return userInfo().homedir;}catch{return homedir();}
}
/** True when a configured path belongs to this app's own private profile rather
 * than to the provider app we want to instrument. The bridge sets CLAUDE_CONFIG_DIR
 * and CODEX_HOME for the sessions it runs itself, while Claude Desktop and the
 * Codex app read their own profiles, so a private path must not decide where a
 * hook goes. This is what the second installed build got wrong. */
function underState(value:string|undefined, env:NodeJS.ProcessEnv) {
  const state=env.WSB_STATE_DIR?.trim();
  return !!state&&!!value&&(value===state||value.startsWith(`${state}${sep}`));
}
/** Where the provider app itself keeps its config, honouring an owner override. */
export function providerConfigDir(provider:ProviderName, env:NodeJS.ProcessEnv=process.env):string {
  if(provider==='codex'){
    const configured=env.CODEX_HOME?.trim();
    if(configured&&!underState(configured,env))return configured;
    try{return codexProfileHome(env);}catch{return join(ownerHome(env),'.codex');}
  }
  const configured=env.CLAUDE_CONFIG_DIR?.trim();
  if(configured&&!underState(configured,env))return configured;
  return join(ownerHome(env),'.claude');
}
export function providerHookPath(provider:ProviderName, home?:string, env:NodeJS.ProcessEnv=process.env) {
  // An explicit home is for tests and callers that already know the two profiles.
  if(home)return provider==='codex'?join(home,'.codex/hooks.json'):join(home,'.claude/settings.json');
  const dir=providerConfigDir(provider,env);
  return provider==='codex'?join(dir,'hooks.json'):join(dir,'settings.json');
}
const quote = (value:string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The command carries this app's own state directory and port, so an installed
 * Local build never posts a prompt to the production bridge. */
export function providerHookCommand(o:{node:string;cli:string;stateDir:string;port:number;provider:ProviderName},platform:NodeJS.Platform=process.platform) {
  return hookEntryText(providerHookEntry(o,platform));
}
type HookOptions={node:string;cli:string;stateDir:string;port:number;provider:ProviderName};
/** The command fields of one installed hook handler. `args` means exec form: no shell at all. */
export type HookEntry={command:string;args?:string[]};
/**
 * The hook handler for this platform. A POSIX `NAME=value cmd` prefix only means something to a
 * POSIX shell, and on Windows neither provider runs one by default:
 * - Codex runs a hook as `%COMSPEC% /C "<command>"` (codex-rs hooks/src/engine/command_runner.rs),
 *   so the state and port are set with cmd's own `set "NAME=value"`.
 * - Claude Code runs a shell-form hook in Git Bash when it finds one and in PowerShell otherwise, and
 *   PowerShell does not hand the hook's stdin to a native child. Its exec form (`args`) spawns the
 *   program directly with stdin attached in every case, so node is started directly and sets the two
 *   variables itself before loading the CLI. Measured with Claude Code 2.1.318 on Windows 11: the exec
 *   form and the Git Bash form delivered the hook JSON (UTF-8 intact); the PowerShell shell form
 *   started node but never delivered stdin.
 */
export function providerHookEntry(o:HookOptions,platform:NodeJS.Platform=process.platform):HookEntry {
  if(platform!=='win32')return {command:[`WSB_STATE_DIR=${quote(o.stateDir)}`,`WSB_PORT=${String(o.port)}`,quote(o.node),quote(o.cli),'hook',o.provider].join(' ')};
  if(o.provider==='codex'){
    // cmd expands %NAME% even inside quotes and no Windows path can hold a double quote; refuse
    // rather than write a hook that would post to the wrong place.
    if([o.stateDir,o.node,o.cli].some(v=>/[%"\r\n]/.test(v)))throw new Error('A path for the Codex hook contains a character cmd.exe cannot carry (%, " or a line break).');
    return {command:`set "WSB_STATE_DIR=${o.stateDir}"&& set "WSB_PORT=${String(o.port)}"&& "${o.node}" "${o.cli}" hook codex`};
  }
  const boot=`process.env.WSB_STATE_DIR=${JSON.stringify(o.stateDir)};process.env.WSB_PORT=${JSON.stringify(String(o.port))};process.argv.splice(1,0,${JSON.stringify(o.cli)});import(require("node:url").pathToFileURL(process.argv[1]).href)`;
  return {command:o.node,args:['-e',boot,'hook',o.provider]};
}
/** One comparable string for a handler, whichever form it uses. */
export function hookEntryText(h:{command?:unknown;args?:unknown}):string {
  const command=String(h?.command??'');
  return Array.isArray(h?.args)?[command,...h.args.map(String)].join('\n'):command;
}
/** Matches any bridge hook, including the older command that baked in no state and the Windows forms. */
export function isBridgeHookCommand(command:string) {
  return /(?:^|[\s'"/\\])cli\.js['"]?\s+hook\s+(?:codex|claude)\b/.test(command)||/cli\.js[\s\S]*\nhook\n(?:codex|claude)$/.test(command);
}
/** The state directory a bridge hook posts to; undefined for a legacy unpinned command. */
export function hookStateDir(command:string) {
  const js=/process\.env\.WSB_STATE_DIR=("(?:[^"\\]|\\.)*")/.exec(command);
  if(js)try{return JSON.parse(js[1]) as string;}catch{}
  const cmd=/set "WSB_STATE_DIR=([^"]*)"/.exec(command);
  if(cmd)return cmd[1];
  const match=/WSB_STATE_DIR=(?:'((?:[^']|'\\'')*)'|"([^"]*)"|(\S+))/.exec(command);
  return match?.[1]?.replaceAll("'\\''","'")??match?.[2]??match?.[3];
}
/** Provider config files are JSON documents; anything larger is not one. */
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
/**
 * Reads a provider config file without ever letting the bridge hang on it.
 *
 * The read is synchronous by design (the installer is synchronous), so a path
 * that blocks in `open` takes the whole bridge with it: the HTTP port stops
 * answering, no permission prompt is ever reported, and the only way out is to
 * kill the process. A FIFO, socket or device sitting at `hooks.json` does exactly
 * that, so only a regular file is opened, and `O_NONBLOCK` is set as well.
 */
function readText(file:string):string {
  const info=statSync(file,{throwIfNoEntry:false});
  if(!info)throw new Error('missing');
  if(!info.isFile())throw new Error('not a regular file');
  if(info.size>MAX_CONFIG_BYTES)throw new Error('too large to be a provider config');
  const handle=openSync(file,constants.O_RDONLY|constants.O_NONBLOCK);
  try {
    const size=fstatSync(handle).size;
    const buffer=Buffer.allocUnsafe(size);
    const read=readSync(handle,buffer,0,buffer.length,0);
    return buffer.subarray(0,read).toString('utf8');
  } finally { closeSync(handle); }
}
function readConfig(file:string):{config:any}|{state:'unreadable';detail:string} {
  if(!existsSync(file))return {config:{}};
  let raw='';try{raw=readText(file);}catch(e){
    const why=e instanceof Error?e.message:'unreadable';
    if(why==='missing')return {config:{}};
    return {state:'unreadable',detail:why==='not a regular file'?`${file} is not a regular file; it was left untouched.`:`Could not read ${file}.`};
  }
  if(!raw.trim())return {config:{}};
  try {
    const config=JSON.parse(raw);
    if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('shape');
    return {config};
  } catch { return {state:'unreadable',detail:`${file} is not valid JSON; it was left untouched.`}; }
}
function groupsFor(config:any):any[] {
  return Array.isArray(config?.hooks?.PermissionRequest)?config.hooks.PermissionRequest:[];
}
/** Read-only. Reports what the provider app would load right now. */
export function providerHookState(o:HookTarget):ProviderHookReport {
  const env=o.env??process.env,file=providerHookPath(o.provider,o.home,env),parsed=readConfig(file);
  if('state' in parsed)return {provider:o.provider,file,state:parsed.state,detail:parsed.detail};
  let wanted:string;try{wanted=providerHookCommand(o,o.platform);}catch(e){return {provider:o.provider,file,state:'unavailable',detail:e instanceof Error?e.message:String(e)};}
  const commands:any[]=groupsFor(parsed.config).flatMap((g:any)=>Array.isArray(g?.hooks)?g.hooks.map((h:any)=>hookEntryText(h)):[]);
  const mine=commands.filter(isBridgeHookCommand),foreign=mine.find(command=>hookStateDir(command)!==o.stateDir);
  // Another FarFromDesk install (the production app, or an older unpinned hook)
  // owns this provider's prompts. Report it; never silently take the hook away.
  if(foreign)return {provider:o.provider,file,state:'owned-by-other',stateDir:hookStateDir(foreign),detail:`another FarFromDesk install (${hookStateDir(foreign)??'its default state'}) owns this hook`};
  if(!mine.length)return {provider:o.provider,file,state:'unavailable',detail:'the bridge hook is not installed'};
  if(mine.includes(wanted))return {provider:o.provider,file,state:'current',stateDir:o.stateDir};
  return {provider:o.provider,file,state:'unavailable',detail:'the bridge hook points at another build'};
}
/**
 * Idempotent. Adds our hook group for every event we need, replaces an older
 * bridge command in place, keeps every other tool's groups, and writes only
 * when the file really changed. The previous bytes are backed up first.
 */
export function installProviderHooks(o:HookTarget):ProviderHookReport {
  // A throwaway state directory means a throwaway run: the packaged smoke and any
  // test harness must never write into the owner's real provider profile. The
  // smoke sets FFD_ISOLATED_LOCAL plus a temp state, which is exactly the shape
  // that would otherwise resolve to the real home.
  const env=o.env??process.env,file=providerHookPath(o.provider,o.home,env);
  if(env.NODE_TEST_CONTEXT||scratchState(o.stateDir))return {provider:o.provider,file,state:'unavailable',detail:'this run uses a temporary state directory or a test context, so the owner profile was left untouched'};
  const parsed=readConfig(file);
  if('state' in parsed)return {provider:o.provider,file,state:parsed.state,detail:parsed.detail};
  const config=parsed.config,entry=providerHookEntry(o,o.platform),wanted=hookEntryText(entry);
  const before=groupsFor(config).flatMap((g:any)=>Array.isArray(g?.hooks)?g.hooks.map((h:any)=>hookEntryText(h)):[]);
  const bridge=before.filter(isBridgeHookCommand),foreign=bridge.find(command=>hookStateDir(command)!==o.stateDir);
  // Two FarFromDesk installs share one provider config file. The one that does not
  // own it must not overwrite the other's hook: that would silently take the
  // owner's permission prompts away from the app that was handling them.
  if(foreign&&!o.takeOver)return {provider:o.provider,file,state:'owned-by-other',stateDir:hookStateDir(foreign),detail:`another FarFromDesk install (${hookStateDir(foreign)??'its default state'}) owns this hook`};
  const existed=bridge.length>0;
  config.hooks=config.hooks&&typeof config.hooks==='object'?config.hooks:{};
  for(const event of EVENTS) {
    const group={hooks:[{type:'command',...entry,timeout:event==='PermissionRequest'?PERMISSION_TIMEOUT_SECONDS:8}]};
    const existing=Array.isArray(config.hooks[event])?config.hooks[event].filter((g:any)=>!Array.isArray(g?.hooks)||!g.hooks.some((h:any)=>isBridgeHookCommand(hookEntryText(h)))):[];
    config.hooks[event]=[...existing,group];
  }
  const next=JSON.stringify(config,null,2)+'\n';
  const previous=existsSync(file)?readText(file):null;
  // The rendered file already carries exactly one bridge command per event.
  if(previous===next)return {provider:o.provider,file,state:'current'};
  let backup:string|undefined;
  if(previous!==null&&previous!==next) {
    backup=`${file}.whatsapp-bridge-backup-${Date.now()}`;
    try{copyFileSync(file,backup);}catch{backup=undefined;}
  }
  const mode=existsSync(file)?statSync(file).mode&0o777:0o600;
  // A fresh machine has no provider config directory yet.
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  writeFileSync(file,next,{mode});
  return {provider:o.provider,file,state:existed?'repaired':'installed',backup};
}
export function installAllProviderHooks(o:Omit<HookTarget,'provider'>):ProviderHookReport[] {
  if(!existsSync(o.cli))return (['codex','claude'] as ProviderName[]).map(provider=>({provider,file:providerHookPath(provider,o.home),state:'unavailable' as const,detail:'the bridge build is incomplete'}));
  return (['codex','claude'] as ProviderName[]).flatMap(provider=>{
    try{return [installProviderHooks({...o,provider})];}catch(e){return [{provider,file:providerHookPath(provider,o.home),state:'unreadable' as const,detail:e instanceof Error?e.message:'the hook file could not be written'}];}
  });
}
/** One line a non-technical owner can act on, or undefined when nothing is wrong. */
export function hookTroubleLine(reports:ProviderHookReport[]|undefined) {
  const broken=(reports??[]).filter(r=>r.state!=='current');
  if(!broken.length)return;
  const names=broken.map(r=>r.provider==='claude'?'Claude':r.provider==='codex'?'Codex':'the coding app');
  return `FarFromDesk cannot see ${[...new Set(names)].join(' or ')} permission prompts on this ${computerName()} yet (${broken[0].detail??broken[0].state}). Prompts will appear in the app only.`;
}