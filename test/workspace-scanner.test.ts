import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceScanner,loadWorkspaces,deniedMessage,scanTimeoutMessage,type ResolvedWorkspaces } from '../src/workspace-scanner.js';

test('a waiting workspace scan shares one task and leaves timers responsive',async()=>{
  let finish!:(value:ResolvedWorkspaces)=>void,calls=0;
  const scanner=new WorkspaceScanner(async()=>{calls++;return new Promise(resolve=>finish=resolve);});
  const a=scanner.scan(['/project']),b=scanner.scan(['/project']);
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(calls,1);assert.equal(a,b);
  finish(new Map());await a;
});

test('workspace timeout or permission failure is latched until explicit retry',async()=>{
  let calls=0;
  const scanner=new WorkspaceScanner(async()=>{calls++;throw new Error('Native child timed out');});
  await assert.rejects(scanner.scan(['/project']),/Native child timed out/);
  await assert.rejects(scanner.scan(['/project']),/Native child timed out/);assert.equal(calls,1);
  scanner.retry();await assert.rejects(scanner.scan(['/project']),/Native child timed out/);assert.equal(calls,2);
});

test('a denied session folder is skipped and named while the others still resolve',async t=>{
  if(process.getuid?.()===0)return t.skip('root ignores folder permissions');
  const { mkdtempSync,mkdirSync,chmodSync,realpathSync,rmSync }=await import('node:fs');
  const { tmpdir }=await import('node:os');const { join }=await import('node:path');
  const root=realpathSync(mkdtempSync(join(tmpdir(),'ffd-scan-'))),open=join(root,'open'),locked=join(root,'locked');
  mkdirSync(open);mkdirSync(join(locked,'project'),{recursive:true});chmodSync(locked,0);
  t.after(()=>{chmodSync(locked,0o700);rmSync(root,{recursive:true,force:true});});
  const scan=new URL('../src/workspace-scan.ts',import.meta.url).pathname;
  const result=await loadWorkspaces([open,join(locked,'project')],['--import','tsx',scan]);
  assert.deepEqual([...result.keys()],[open]);assert.deepEqual(result.denied,[join(locked,'project')]);
  const scanner=new WorkspaceScanner(async()=>result);
  assert.equal((await scanner.scan([open])).size,1);assert.equal((await scanner.scan([open])).size,1);
});

test('a slow scan reports a timeout, not a permission problem',async()=>{
  await assert.rejects(loadWorkspaces(['/project'],['-e','setInterval(()=>{},1000)'],200),error=>error instanceof Error&&error.message===scanTimeoutMessage);
});

test('denied folders are named with where to allow them',()=>{
  const message=deniedMessage(['/Users/a/Documents/x','/Users/a/Documents/y','/Users/a/Library/Mobile Documents/com~apple~CloudDocs/z','/Volumes/USB/p'],'/Users/a');
  assert.match(message,/can't read ~\/Documents, iCloud Drive, \/Volumes\/USB\./);
  assert.match(message,/System Settings > Privacy & Security > Files and Folders > FarFromDesk, or Full Disk Access/);
  assert.doesNotMatch(message,/[–—]/);
});
