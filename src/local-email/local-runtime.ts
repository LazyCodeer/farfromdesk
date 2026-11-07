import {chmodSync,closeSync,existsSync,lstatSync,openSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {MailKeychainHelper} from './keychain-helper.js';
import {macKeychainStore,windowsCredentialStore} from './keychain-adapter.js';
import {nativeMailApproval} from './native-approval.js';
import {currentBootId} from './helper-command.js';
import {metaMailWriter} from './meta-writer.js';
import {LocalMailHost} from './host.js';
import {brainPolicy,MetaSecret} from '../meta-brain-config.js';
import type {Store} from '../store.js';

/**
 * The bundled helpers each platform needs: compiled Swift executables on macOS, PowerShell
 * scripts on Windows (Credential Manager broker and approval dialog). Any other platform has
 * no local email.
 */
export function localMailHelpersUsable(platform:NodeJS.Platform,helperPath:string,approvalPath:string){
  if(!isAbsolute(helperPath)||!isAbsolute(approvalPath))return false;
  if(platform==='darwin')return true;
  if(platform==='win32')return /\.ps1$/i.test(helperPath)&&/\.ps1$/i.test(approvalPath);
  return false;
}

/** This runtime is created only by the isolated Local backend. */
export async function startLocalMail(root:string,store:Store,helperPath:string,approvalPath:string){
  if(!isAbsolute(root)||!localMailHelpersUsable(process.platform,helperPath,approvalPath)||!existsSync(helperPath)||!existsSync(approvalPath))throw new Error('Email is unavailable in this build.');
  const broker=new MailKeychainHelper(helperPath,join(root,'email-helper.lock'));await broker.start();let db:DatabaseSync|undefined;
  try{
    const file=join(root,'email.sqlite');if(!existsSync(file)){const fd=openSync(file,'wx',0o600);closeSync(fd);}if(!lstatSync(file).isFile())throw Error('invalid state');chmodSync(file,0o600);db=new DatabaseSync(file);
    const bootId=await currentBootId();
    const vault=(process.platform==='win32'?windowsCredentialStore:macKeychainStore)(broker,()=>broker.isLocked()),secret=new MetaSecret(root);
    const host=new LocalMailHost(db,vault,()=>broker.isLocked(),draft=>nativeMailApproval(approvalPath,draft),async(request,current)=>{
      const key=secret.read();if(!key||!brainPolicy(store).enabled)throw new Error('Email assistant unavailable.');
      return metaMailWriter(key)(request,()=>current()&&brainPolicy(store).enabled&&secret.read()===key);
    },undefined,bootId);
    await host.mail.cleanupCredentials();return {host,close:async()=>{host.close();await broker.close();db!.close();}};
  }catch{db?.close();await broker.close();throw new Error('Email is unavailable in this build.');}
}
