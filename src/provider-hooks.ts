import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The bridge hears a native permission prompt only through the provider's own
 * hook. Installing it is a manual CLI step today, so a healthy signed-in Claude
 * install can sit on a permission dialog that the bridge never learns about.
 * This module installs and repairs exactly one hook per provider, namespaced by
 * our own command line, and never touches another tool's entries.
 */

export type ProviderHookState = 'current' | 'installed' | 'repaired' | 'unreadable' | 'unavailable';
export type ProviderHookReport = { provider:ProviderName; file:string; state:ProviderHookState; detail?:string; backup?:string };

export type ProviderName = 'codex' | 'claude';
export type HookTarget = { provider:ProviderName; node:string; cli:string; stateDir:string; port:number; home?:string };

const EVENTS = ['Stop','PermissionRequest'] as const;
const PERMISSION_TIMEOUT_SECONDS = 920; // Just past the bridge's own 15 minute approval window.

export function providerHookPath(provider:ProviderName, home=homedir()) {
  return provider==='codex'?join(home,'.codex/hooks.json'):join(home,'.claude/settings.json');
}
const quote = (value:string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The command carries this app's own state directory and port, so an installed
 * Local build never posts a prompt to the production bridge. */
export function providerHookCommand(o:{node:string;cli:string;stateDir:string;port:number;provider:ProviderName}) {
  return [`WSB_STATE_DIR=${quote(o.stateDir)}`,`WSB_PORT=${String(o.port)}`,quote(o.node),quote(o.cli),'hook',o.provider].join(' ');
}
/** Matches any bridge hook, including the older command that baked in no state. */
export function isBridgeHookCommand(command:string) {
  return /(?:^|[\s'"/])cli\.js['"]?\s+hook\s+(?:codex|claude)\b/.test(command);
}
function readConfig(file:string):{config:any}|{state:'unreadable';detail:string} {
  if(!existsSync(file))return {config:{}};
  let raw='';try{raw=readFileSync(file,'utf8');}catch(e){return {state:'unreadable',detail:`Could not read ${file}.`};}
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
  const file=providerHookPath(o.provider,o.home),parsed=readConfig(file);
  if('state' in parsed)return {provider:o.provider,file,state:parsed.state,detail:parsed.detail};
  const wanted=providerHookCommand(o),commands:any[]=groupsFor(parsed.config).flatMap((g:any)=>Array.isArray(g?.hooks)?g.hooks.map((h:any)=>String(h?.command??'')):[]);
  const mine=commands.filter(isBridgeHookCommand);
  if(!mine.length)return {provider:o.provider,file,state:'unavailable',detail:'the bridge hook is not installed'};
  if(mine.includes(wanted))return {provider:o.provider,file,state:'current'};
  return {provider:o.provider,file,state:'unavailable',detail:'the bridge hook points at another app state or build'};
}
/**
 * Idempotent. Adds our hook group for every event we need, replaces an older
 * bridge command in place, keeps every other tool's groups, and writes only
 * when the file really changed. The previous bytes are backed up first.
 */
export function installProviderHooks(o:HookTarget):ProviderHookReport {
  const file=providerHookPath(o.provider,o.home),parsed=readConfig(file);
  if('state' in parsed)return {provider:o.provider,file,state:parsed.state,detail:parsed.detail};
  const config=parsed.config,wanted=providerHookCommand(o);
  const before=groupsFor(config).flatMap((g:any)=>Array.isArray(g?.hooks)?g.hooks.map((h:any)=>String(h?.command??'')):[]);
  const existed=before.some(isBridgeHookCommand),currentCount=before.filter(c=>c===wanted).length;
  config.hooks=config.hooks&&typeof config.hooks==='object'?config.hooks:{};
  for(const event of EVENTS) {
    const group={hooks:[{type:'command',command:wanted,timeout:event==='PermissionRequest'?PERMISSION_TIMEOUT_SECONDS:8}]};
    const existing=Array.isArray(config.hooks[event])?config.hooks[event].filter((g:any)=>!Array.isArray(g?.hooks)||!g.hooks.some((h:any)=>isBridgeHookCommand(String(h?.command??'')))):[];
    config.hooks[event]=[...existing,group];
  }
  const next=JSON.stringify(config,null,2)+'\n';
  const previous=existsSync(file)?readFileSync(file,'utf8'):null;
  // Every event needs our exact command once; anything else means a repair.
  if(previous===next&&currentCount===EVENTS.length)return {provider:o.provider,file,state:'current'};
  let backup:string|undefined;
  if(previous!==null&&previous!==next) {
    backup=`${file}.whatsapp-bridge-backup-${Date.now()}`;
    try{copyFileSync(file,backup);}catch{backup=undefined;}
  }
  const mode=existsSync(file)?statSync(file).mode&0o777:0o600;
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
  return `FarFromDesk cannot see ${[...new Set(names)].join(' or ')} permission prompts on this Mac yet (${broken[0].detail??broken[0].state}). Prompts will appear in the app only.`;
}