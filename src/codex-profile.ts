import {homedir} from 'node:os';
import {isAbsolute,join,relative} from 'node:path';
import {lstatSync,realpathSync,statSync} from 'node:fs';

/** Local's selected native profile is separate from its backend and agent roots. */
export function codexProfileHome(env:NodeJS.ProcessEnv=process.env):string {
  if(env.FFD_ISOLATED_LOCAL!=='1')return env.CODEX_HOME??join(homedir(),'.codex');
  const selected=env.FFD_SELECTED_CODEX_HOME,state=env.WSB_STATE_DIR;
  if(!selected||!state||!isAbsolute(selected)||!isAbsolute(state))throw new Error('The selected Codex profile or Local state path is unavailable.');
  try {
    if(lstatSync(selected).isSymbolicLink())throw new Error('Symlink profile');
    const profile=realpathSync(selected),local=realpathSync(state);
    if(!statSync(profile).isDirectory())throw new Error('Not a directory');
    const within=(a:string,b:string)=>{const r=relative(a,b);return r===''||(!r.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&r!=='..'&&!isAbsolute(r));};
    if(within(profile,local)||within(local,profile))throw new Error('Profile and Local state overlap');
    return profile;
  } catch {throw new Error('The selected Codex profile is unavailable or overlaps Local state. No Codex operation was started.');}
}

export function codexProfileEnvironment(env:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv {
  return {...env,CODEX_HOME:codexProfileHome(env)};
}
