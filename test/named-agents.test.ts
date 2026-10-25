import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { syncNamedAgents, defineNamedAgent, assignNamedAgent, agentDefinition, installNamedAgent, renderNamedAgent, agentRoots } from '../src/named-agents.js';
import { roleConfig, turnEnvelope } from '../src/roles.js';
import { toWhatsApp } from '../src/whatsapp-format.js';

function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'ffd-agents-'))),store=new Store(':memory:');return {root,store,roots:{codex:join(root,'codex','agents'),claude:join(root,'claude','agents')},close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};}
const parseFields=(text:string)=>Object.fromEntries(text.split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>{const [key,...value]=line.split(' = ');return [key,JSON.parse(value.join(' = '))];}));
const input={name:'farfromdesk-reviewer',description:'Review code changes and report verified findings.',instructions:'Act as a careful code reviewer. Inspect the requested diff, prioritize real correctness problems, cite exact evidence, and clearly distinguish tested results from hypotheses.'};
test('native agent files use official schemas, parse and preserve provider permissions',()=>{
 const f=fixture();try{
  const result=syncNamedAgents(f.store,f.roots);assert.equal(result.length,2);assert.ok(result.every(a=>a.installation.every(p=>p.status==='installed')));
  const codex=readFileSync(join(f.roots.codex,'farfromdesk-coordinator.toml'),'utf8');
  const parsed=parseFields(codex);
  assert.deepEqual(Object.keys(parsed).sort(),['description','developer_instructions','name']);assert.match(parsed.developer_instructions,/Core|Identity/);
  const claude=readFileSync(join(f.roots.claude,'farfromdesk-coordinator.md'),'utf8');assert.match(claude,/name: farfromdesk-coordinator/);assert.match(claude,/model: inherit/);assert.doesNotMatch(claude,/^permissionMode:|^tools:|^hooks:/m);
  assert.deepEqual(syncNamedAgents(f.store,f.roots),result);
 }finally{f.close();}
});
test('named specialist creation is idempotent, selection changes next role and avoids repeated prompt',()=>{
 const f=fixture();try{
  defineNamedAgent(f.store,input,f.roots);defineNamedAgent(f.store,input,f.roots);
  const b=f.store.register('worker','codex','11111111-1111-4111-a111-111111111111',f.root).binding;
  const before=roleConfig(f.store,b);assignNamedAgent(f.store,b,input.name,f.roots);
  const role=roleConfig(f.store,b);assert.notEqual(role.version,before.version);assert.match(role.instructions,/careful code reviewer/);assert.equal(role.agentName,input.name);
  const first=turnEnvelope(f.store,b,'Review this change','wa:one',{},[],f.root);first.acknowledge();
  const next=turnEnvelope(f.store,b,'Next change','wa:two',{},[],f.root);assert.match(next.body,/farfromdesk-reviewer/);assert.doesNotMatch(next.body,/careful code reviewer/);
  assert.throws(()=>defineNamedAgent(f.store,{...input,instructions:input.instructions+' Changed.'},f.roots),/different instructions/);
  assert.throws(()=>assignNamedAgent(f.store,b,'farfromdesk-coordinator',f.roots),/selected coordinator/);
 }finally{f.close();}
});
test('malformed names/config injection and unknown role do not escape native folders',()=>{
 const f=fixture();try{
  for(const name of ['../../evil','farfromdesk-../evil','/tmp/agent','farfromdesk-x\nmodel = "bad"','Agent','farfromdesk-coordinator'])assert.throws(()=>defineNamedAgent(f.store,{...input,name},f.roots));
  assert.throws(()=>defineNamedAgent(f.store,{...input,description:'bad\nhooks: something'},f.roots));
  assert.throws(()=>agentDefinition(f.store,'farfromdesk-missing'));
  const role={...agentDefinition(f.store,'farfromdesk-worker'),description:'Quoted "name"',instructions:'Text """\nmodel = "unwanted"'};
  const parsed=parseFields(renderNamedAgent(role,'codex'));assert.equal(parsed.model,undefined);
 }finally{f.close();}
});
test('user edits, unrelated files and symlinks are preserved while managed versions can update',()=>{
 const f=fixture();try{
  const role=agentDefinition(f.store,'farfromdesk-worker');installNamedAgent(f.store,role,f.roots);
  const file=join(f.roots.codex,role.name+'.toml');writeFileSync(file,'user custom file');
  assert.equal(installNamedAgent(f.store,role,f.roots)[0].status,'conflict');assert.equal(readFileSync(file,'utf8'),'user custom file');
  const modified={...role,instructions:role.instructions+'\nAn app-owned revision.'};assert.equal(installNamedAgent(f.store,modified,f.roots)[1].status,'installed');
  rmSync(file);symlinkSync(join(f.root,'outside'),file);assert.equal(installNamedAgent(f.store,role,f.roots)[0].status,'unavailable');
  mkdirSync(join(f.root,'redirect'));symlinkSync(join(f.root,'redirect'),join(f.root,'linked'));
  assert.equal(installNamedAgent(f.store,role,{...f.roots,codex:join(f.root,'linked','agents')})[0].status,'unavailable');
 }finally{f.close();}
});
test('WhatsApp conversion handles headings, bold, lists, links and tables without changing code or URLs',()=>{
 assert.equal(toWhatsApp('## Update\n**Done** and ~~old~~\n• One'),' *Update*\n*Done* and ~old~\n- One'.trimStart());
 const code='```js\nconst x = "**bold**";\n```';assert.equal(toWhatsApp(code),'```\nconst x = "**bold**";\n```');
 assert.equal(toWhatsApp('Use `**literal**` and https://example.com/__keep__'),'Use `**literal**` and https://example.com/__keep__');
 assert.equal(toWhatsApp('[Build](https://example.com/a?q=1)'),'Build — https://example.com/a?q=1');
 assert.equal(toWhatsApp('| Check | Result |\n| --- | --- |\n| Tests | Passed |'),'- Check: Tests · Result: Passed');
 for(const native of ['✅ *Done*\n- Tests passed','_Optional_ ~old~','🔎 Progress','No formatting','\uE000FFD0\uE001 `safe`'])assert.equal(toWhatsApp(native),native);
});

test('intentional provider-home symlinks resolve to the configured disk without accepting symlinked agent files',()=>{
 const f=fixture(),oldCodex=process.env.CODEX_HOME,oldClaude=process.env.CLAUDE_CONFIG_DIR;
 try{
  const target=join(f.root,'relocated-claude');mkdirSync(target);const home=join(f.root,'claude-home');symlinkSync(target,home);
  process.env.CODEX_HOME=join(f.root,'codex-home');process.env.CLAUDE_CONFIG_DIR=home;
  const roots=agentRoots();assert.equal(roots.claude,join(target,'agents'));
  const result=syncNamedAgents(f.store);assert.ok(result.every(a=>a.installation.every(p=>p.status==='installed')));
  const file=join(target,'agents','farfromdesk-worker.md');rmSync(file);symlinkSync(join(f.root,'elsewhere'),file);
  assert.equal(installNamedAgent(f.store,agentDefinition(f.store,'farfromdesk-worker'))[1].status,'unavailable');
 }finally{
  if(oldCodex===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldCodex;
  if(oldClaude===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=oldClaude;
  f.close();
 }
});
