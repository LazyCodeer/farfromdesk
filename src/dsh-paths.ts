import {homedir,userInfo} from 'node:os';
import {join} from 'node:path';

/**
 * DeepSeek Harness is installed and signed in by the owner in their own home. The Local app runs
 * its backend with an isolated HOME so its state stays separate, and that would otherwise hide the
 * owner's install behind an empty app-private home: the credential and the session log would look
 * missing and every DeepSeek session would read as signed out. When we are isolated, resolve the
 * owner's real home instead. An explicit DSH_HOME always wins, which is also how the CLI itself
 * decides where its profiles and sessions live.
 */
export function dshOwnerHome(env:NodeJS.ProcessEnv=process.env):string {
  if(env.FFD_ISOLATED_LOCAL!=='1')return env.HOME?.trim()||homedir();
  try{return userInfo().homedir;}catch{return homedir();}
}
export const dshHome=(env:NodeJS.ProcessEnv=process.env):string=>env.DSH_HOME?.trim()||join(dshOwnerHome(env),'.dsh');
export const dshSessionsDir=(env:NodeJS.ProcessEnv=process.env):string=>join(dshHome(env),'sessions');
export const dshCredentialsPath=(env:NodeJS.ProcessEnv=process.env):string=>join(dshHome(env),'.credentials.yaml');
/** The launcher that boots a profile. DSH_BIN exists for tests and unusual installs. */
export const dshBinary=(env:NodeJS.ProcessEnv=process.env):string=>env.DSH_BIN?.trim()||env.WSB_DSH_BIN?.trim()||'dsh';