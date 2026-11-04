import {homedir,userInfo} from 'node:os';
import {join} from 'node:path';

/**
 * Muse is installed and signed in by the owner in their own home. The Local app runs its backend
 * with an isolated HOME so its state stays separate, and that would otherwise hide the owner's
 * Muse install behind an empty app-private home: the credential and session index would look
 * missing and Muse would report itself signed out. When we are isolated, resolve the owner's real
 * home instead of the backend's private one. Explicit MUSE_* variables always win.
 */
export function museHome(env:NodeJS.ProcessEnv=process.env):string {
  if(env.FFD_ISOLATED_LOCAL!=='1')return env.HOME?.trim()||homedir();
  try{return userInfo().homedir;}catch{return homedir();}
}
export const museConfigDir=(env:NodeJS.ProcessEnv=process.env):string=>env.MUSE_CONFIG_DIR?.trim()||join(museHome(env),'.config','muse');
export const museAuthPath=(env:NodeJS.ProcessEnv=process.env):string=>join(museConfigDir(env),'auth.json');
export const museDataHome=(env:NodeJS.ProcessEnv=process.env):string=>env.MUSE_DATA_DIR?.trim()||join(museHome(env),'.local','share','muse');
export const museBinary=(env:NodeJS.ProcessEnv=process.env):string=>env.MUSE_BIN?.trim()||join(museHome(env),'.local','bin','muse');