import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { turnEnvelope, updateRole } from '../src/roles.js';

test('persistent sessions are told once when the role changes; Telegram button taps count as owner input',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-powers-')),store=new Store(join(dir,'state.db'));
  try {
    const b=store.register('worker','claude','11111111-1111-4111-a111-111111111111',dir).binding;
    const first=turnEnvelope(store,b,'First','wa:1',{},[],dir,true);
    assert.doesNotMatch(first.body,/role bootstrap|role updated/);first.acknowledge();
    updateRole(store,b,'cheerful');
    const changed=turnEnvelope(store,b,'Next','wa:2',{},[],dir,true);
    assert.match(changed.body,/role updated to .*Read the role file/);changed.acknowledge();
    assert.doesNotMatch(turnEnvelope(store,b,'Again','wa:3',{},[],dir,true).body,/role updated/);
    assert.equal(store.ownerInputId('tg-choice:1:cb2'),true);
    assert.equal(store.ownerInputId('tg-choicex:1'),false);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('the coordinator can send the owner a file from their folders, under the same limits as the brain',()=>{
  const channel=readFileSync(new URL('../src/master-channel.ts',import.meta.url),'utf8');
  const server=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
  assert.match(channel,/enum:\[\.\.\.desktopActions,'send_file'/);
  assert.match(channel,/Never say you cannot attach or send files/);
  const route=server.slice(server.indexOf("path==='/api/master/desktop-control'"));
  const handler=route.slice(route.indexOf("input.action==='send_file'"),route.indexOf("if(input.action==='status')"));
  assert.match(handler,/ownerRequest\(requestId\)/);
  assert.match(handler,/requireDesktopPermission\(\)/);
  assert.match(handler,/ownerFileToSend\(/);
  assert.match(handler,/sent>=5/);
  assert.match(handler,/outputOwnerFile\(requestId,parent\.destination/);
});

test('the coordinator can send the owner a picture of their whole screen',()=>{
  const channel=readFileSync(new URL('../src/master-channel.ts',import.meta.url),'utf8');
  const server=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
  assert.match(channel,/'send_screenshot'\]/);
  const route=server.slice(server.indexOf("path==='/api/master/desktop-control'"));
  const handler=route.slice(route.indexOf("input.action==='send_screenshot'"),route.indexOf("if(input.action==='status')"));
  assert.match(handler,/requireUnlockedScreen/);
  assert.match(handler,/taken>=3/);
  assert.match(handler,/captureScreen\(\)/);
  assert.match(handler,/outputOwnerPhoto\(requestId,parent\.destination/);
});

test('coordinator reminders go through the bridge scheduler, not a timer in its own session',()=>{
  const channel=readFileSync(new URL('../src/master-channel.ts',import.meta.url),'utf8');
  const server=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
  const policy=readFileSync(new URL('../src/master-policy.ts',import.meta.url),'utf8');
  const masters=readFileSync(new URL('../src/masters.ts',import.meta.url),'utf8');
  assert.match(channel,/name:'master_reminder'/);
  assert.match(channel,/name==='master_reminder'\?'\/api\/master\/reminder'/);
  assert.match(masters,/coordinatorBridgeTools=\[[^\]]*'master_reminder'/);
  const route=server.slice(server.indexOf("path==='/api/master/reminder'"),server.indexOf("path==='/api/master/desktop-control'"));
  assert.match(route,/ownerRequest\(requestId\)/);
  assert.match(route,/ownerInputId\(requestId\)/);
  assert.match(route,/schedules\.brainCreate\(/);
  assert.match(policy,/master_reminder action create/);
});
