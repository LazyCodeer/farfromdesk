import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Coordinator } from '../src/coordinator.js';
import { Approvals } from '../src/approvals.js';
import { MetaBrain } from '../src/meta-brain.js';
import { MetaSecret, DEFAULT_BRAIN, saveBrainConfig } from '../src/meta-brain-config.js';
import { OwnerMemory } from '../src/owner-memory.js';
import type { Interpretation } from '../src/meta-model.js';

const fresh=()=>{const root=mkdtempSync(join(tmpdir(),'ffd-memory-')),store=new Store(':memory:');return {root,store,memory:new OwnerMemory(store,root,'ATC means the air-traffic repo')};};

test('memory starts with an index, about-me and migrated notes', () => {
  const {memory}=fresh();
  assert.deepEqual(memory.paths().slice(0,2),['MEMORY.md','about-me.md']);
  assert.match(memory.read('words.md')!,/ATC means the air-traffic repo/);
  assert.equal(memory.history().length,0);
  assert.equal(memory.introNeeded(),true);
  assert.deepEqual(Object.keys(memory.always()),['MEMORY.md','about-me.md','collaboration.md']);
  assert.match(memory.read('MEMORY.md')!,/\[Collaboration\]\(collaboration\.md\)/);
  assert.equal(memory.collaborates(),false);
});

test('memory commands view, create, replace and insert inside the folder only', () => {
  const {memory}=fresh();
  assert.match(memory.command({command:'view',path:'/memories'},'brain:1',true),/^MEMORY\.md\nabout-me\.md\ncollaboration\.md/);
  assert.match(memory.command({command:'view',path:'about-me.md'},'brain:1',true),/^1\t# About you/);
  assert.equal(memory.command({command:'str_replace',path:'about-me.md',old_str:'- Call me:',new_str:'- Call me: Sam'},'brain:1',true),'Saved about-me.md.');
  assert.equal(memory.introNeeded(),false);
  memory.command({command:'create',path:'projects/website.md',file_text:'# Website\n- Staging is staging.example.com\n'},'brain:1',true);
  assert.match(memory.read('MEMORY.md')!,/\]\(projects\/website\.md\)/);
  memory.command({command:'insert',path:'words.md',insert_line:1,insert_text:'- Priya reviews design'},'brain:1',true);
  assert.match(memory.read('words.md')!,/^# Words and names\n- Priya reviews design/);
  assert.equal(memory.changes('brain:1').filter(c=>c.path!=='MEMORY.md').length,3);
  assert.match(memory.command({command:'create',path:'../escape.md',file_text:'x'},'brain:1',true),/Markdown names/);
  assert.match(memory.command({command:'insert',path:'words.md',insert_text:'my api key is abc'},'brain:1',true),/not saved/);
  assert.match(memory.command({command:'create',path:'x.md',file_text:'x'},'brain:1',false),/turned off saving/);
  assert.equal(memory.read('x.md'),undefined);
});

test('undo restores the previous text and catches outside edits', () => {
  const {memory,root}=fresh();
  memory.command({command:'insert',path:'preferences.md',insert_text:'- Only message me when done'},'brain:2',true);
  memory.undo(memory.changes('brain:2')[0].id);
  assert.doesNotMatch(memory.read('preferences.md')!,/Only message me/);
  writeFileSync(join(root,'memory','words.md'),'# Words\n- Priya reviews design\n');
  const outside=memory.history().find(c=>c.source==='outside');
  assert.equal(outside?.path,'words.md');
  memory.undo(outside!.id);
  assert.match(memory.read('words.md')!,/ATC means/);
  memory.write('projects/x.md','# x\n','owner');
  memory.undo(memory.history().find(c=>c.path==='projects/x.md')!.id);
  assert.equal(existsSync(join(root,'memory','projects','x.md')),false);
});

test('asking for the intro again reopens it until about-me is answered', () => {
  const {memory}=fresh();
  memory.write('about-me.md','# About you\n- Call me: Sam\n','owner');
  assert.equal(memory.introNeeded(),false);
  memory.restartIntro();
  assert.equal(memory.introNeeded(),true);
});

function brain(script:(tool:(i:any)=>string,input:any)=>Partial<Interpretation>) {
  const dir=mkdtempSync(join(tmpdir(),'ffd-memory-brain-')),store=new Store(':memory:'),approvals=new Approvals(store),native={run:async()=>{},stop:()=>{},catalog:async()=>({sessions:[]})};
  store.set('whatsapp-owner','owner@s.whatsapp.net');
  const router=new Router(store,native as any,approvals),c=new Coordinator(store,native as any,router,()=>{});router.coordinator=c;router.pump=()=>{};
  c.registry.register(store.register('codex-proxy','codex',randomUUID(),'/tmp').binding);
  const secret=new MetaSecret(dir);secret.save('synthetic-test-key-never-a-real-key');
  const policy={...DEFAULT_BRAIN,enabled:true,allowRouting:true,failure:'block' as const,providers:['codex'] as 'codex'[]};
  saveBrainConfig(store,secret,{policy});
  const inputs:any[]=[];
  router.brain=new MetaBrain(store,secret,{interpret:async(_k,_p,i,tool)=>{inputs.push(i);return {intent:'chat',normalized:'x',provider:'unspecified',taskIds:[],...script(tool!,i)} as Interpretation;}});
  const say=(text:string)=>router.brain.handle(router,{id:`wa:${randomUUID()}`,text} as any);
  return {store,router,secret,policy,say,inputs,out:()=>store.db.prepare('SELECT body FROM outbox ORDER BY rowid').all().map((r:any)=>String(r.body)),close(){approvals.cancel();store.close();}};
}

test('the first hi goes to the model for an intro, and what it saves is announced and undoable', async () => {
  const f=brain((tool,input)=>{
    if(input.original==='Sam')tool({command:'str_replace',path:'about-me.md',old_str:'- Call me:',new_str:'- Call me: Sam'});
    return {reply:input.intro?'Hi, I pass work to your sessions. What should I call you?':'Nice to meet you, Sam.'};
  });
  await f.say('hi');
  assert.equal(f.inputs[0].intro,'needed');
  assert.deepEqual(Object.keys(f.inputs[0].memory),['MEMORY.md','about-me.md','collaboration.md']);
  await f.say('Sam');
  assert.match(f.router.brain.owner.read('about-me.md')!,/^- Call me: Sam$/m);
  assert.ok(f.out().some(b=>/Saved "Call me: Sam" in about-me\.md[\s\S]*undo/.test(b)));
  const calls=f.inputs.length;
  await f.say('hello');
  assert.equal(f.inputs.length,calls,'greetings skip the model once the intro is answered');
  await f.say('undo');
  assert.doesNotMatch(f.router.brain.owner.read('about-me.md')!,/Call me: Sam/);
  f.close();
});

test('learning off saves nothing', async () => {
  const f=brain(tool=>{tool({command:'insert',path:'words.md',insert_text:'- ATC is the air-traffic repo'});return {};});
  saveBrainConfig(f.store,f.secret,{policy:{...f.policy,learn:false}});
  await f.say('ATC is the air-traffic repo');
  assert.doesNotMatch(f.router.brain.owner.read('words.md')!,/ATC/);
  f.close();
});

test('the brain may pick an unnamed platform only by following collaboration.md', async () => {
  const f=brain(()=>({intent:'task',provider:'codex',normalized:'Plan the export'}));
  f.router.brain.owner.write('about-me.md','# About you\n- Call me: Sam\n','owner');
  await f.say('Plan the invoice export');
  assert.equal(f.store.jobs().length,0);
  assert.match(f.out().at(-1)!,/name the coding platform/);
  f.router.brain.owner.write('collaboration.md','# Collaboration\n- Planning and review: Codex\n','owner');
  await f.say('Plan the invoice export again');
  assert.equal(f.store.jobs().length,1);
  f.close();
});
