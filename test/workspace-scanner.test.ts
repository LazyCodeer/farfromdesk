import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceScanner,type ResolvedWorkspaces } from '../src/workspace-scanner.js';

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
  await assert.rejects(scanner.scan(['/project']),/file access/);
  await assert.rejects(scanner.scan(['/project']),/file access/);assert.equal(calls,1);
  scanner.retry();await assert.rejects(scanner.scan(['/project']),/file access/);assert.equal(calls,2);
});
