import {execFileSync} from 'node:child_process';
import {chmodSync,closeSync,existsSync,lstatSync,openSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {MailKeychainHelper} from './keychain-helper.js';
import {macKeychainStore} from './keychain-adapter.js';
import {nativeMailApproval} from './native-approval.js';
import {metaMailWriter} from './meta-writer.js';
import {LocalMailHost} from './host.js';
import {brainPolicy,MetaSecret} from '../meta-brain-config.js';
import type {Store} from '../store.js';

/** This runtime is created only by the isolated Local backend. */
export async function startLocalMail(root:string,store:Store,helperPath:string,approvalPath:string){
  if(process.platform!=='darwin'||!isAbsolute(root)||!isAbsolute(helperPath)||!isAbsolute(approvalPath)||!existsSync(helperPath)||!existsSync(approvalPath))throw new Error('Email is unavailable in this build.');
  const broker=new MailKeychainHelper(helperPath,join(root,'email-helper.lock'));await broker.start();let db:DatabaseSync|undefined;
  try{
    const file=join(root,'email.sqlite');if(!existsSync(file)){const fd=openSync(file,'wx',0o600);closeSync(fd);}if(!lstatSync(file).isFile())throw Error('invalid state');chmodSync(file,0o600);db=new DatabaseSync(file);
    const bootId=execFileSync('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{encoding:'utf8',timeout:3000,env:{}}).trim();if(!/^[a-fA-F0-9-]{36}$/.test(bootId))throw Error('boot id unavailable');
    const vault=macKeychainStore(broker,()=>broker.isLocked()),secret=new MetaSecret(root);
    const host=new LocalMailHost(db,vault,()=>broker.isLocked(),draft=>nativeMailApproval(approvalPath,draft),async(request,current)=>{
      const key=secret.read();if(!key||!brainPolicy(store).enabled)throw new Error('Email assistant unavailable.');
      return metaMailWriter(key)(request,()=>current()&&brainPolicy(store).enabled&&secret.read()===key);
    },undefined,bootId);
    await host.mail.cleanupCredentials();return {host,close:async()=>{host.close();await broker.close();db!.close();}};
  }catch{db?.close();await broker.close();throw new Error('Email is unavailable in this build.');}
}
