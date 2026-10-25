import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// @ts-ignore packaging script intentionally uses plain JavaScript on all build hosts.
import {pruneDesktopBackend,pruneDevelopmentFiles} from '../script/prune_desktop_backend.mjs';

test('packaging removes only redundant platform CLI copies, preserving SDK runtime, native image dependencies and licenses',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ffd-package-'));
 try {
  const files=['@anthropic-ai/claude-agent-sdk/sdk.mjs','@anthropic-ai/claude-agent-sdk/README.md','@anthropic-ai/claude-agent-sdk-darwin-arm64/claude','@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe','@anthropic-ai/sdk/index.js','@img/sharp-darwin-arm64/sharp.node'];
  for(const file of files){const path=join(dir,'node_modules',file);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,'fixture');}
  const result=pruneDesktopBackend(dir);assert.equal(result.removedBytes,14);assert.equal(result.packages.length,2);
  for(const file of files)assert.equal(existsSync(join(dir,'node_modules',file)),!file.includes('agent-sdk-darwin')&&!file.includes('agent-sdk-win32'));
  assert.equal(pruneDesktopBackend(dir).removedBytes,0);
  // Removing fallback binaries is valid only while the application passes the installed CLI explicitly.
  assert.match(readFileSync(new URL('../src/claude-sdk-session.ts',import.meta.url),'utf8'),/pathToClaudeCodeExecutable:command.binary/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});


test('development pruning preserves executable sources, native modules and licensing',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ffd-types-'));
 try {
  const keep=['runtime.js','source.ts','native.node','LICENSE','README.md'];
  const remove=['index.d.ts','index.d.mts','index.d.cts','runtime.js.map'];
  mkdirSync(join(dir,'node_modules/pkg'),{recursive:true});
  for(const file of [...keep,...remove])writeFileSync(join(dir,'node_modules/pkg',file),'fixture');
  const result=pruneDevelopmentFiles(dir);assert.equal(result.files,4);
  for(const file of keep)assert.ok(existsSync(join(dir,'node_modules/pkg',file)));
  for(const file of remove)assert.equal(existsSync(join(dir,'node_modules/pkg',file)),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
