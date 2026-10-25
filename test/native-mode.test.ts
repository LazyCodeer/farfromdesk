import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Approvals } from '../src/approvals.js';
const dir=mkdtempSync(join(tmpdir(),'tether-native-mode-')),helper=join(dir,'fake-desktop-sync'),counter=join(dir,'calls');
writeFileSync(helper,`#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(counter)},'sent\\n');console.log(JSON.stringify({status:'submitted'}));`,{mode:0o700});
process.env.WSB_STATE_DIR=dir;process.env.WSB_DESKTOP_SYNC_BIN=helper;
const {NativeAgents}=await import('../src/native.js');
test.after(()=>rmSync(dir,{recursive:true,force:true}));
test('Desktop worker routes via its inbox, never managed CLI; workspace guard runs before delivery',async()=>{
  const store=new Store(':memory:'),approvals=new Approvals(store),native=new NativeAgents(store,approvals);
  try {
    (native as any).desktopConfig=async()=>{};
    const b=store.register('desktop-worker','claude','11111111-1111-4111-a111-111111111111',dir).binding;
    store.set(`managed-worker:${b.id}`,'true');store.set(`execution-mode:${b.id}`,'desktop');
    let managed=0,guard=0;native.managedRun=async()=>{managed++;};native.beforeRun=()=>{guard++;};
    await native.run(b,'Harmless offline test','wa:test');assert.equal(managed,0);assert.equal(guard,1);assert.ok(readFileSync(counter,'utf8').includes('sent'));
    const first=readFileSync(counter,'utf8');native.beforeRun=()=>{throw new Error('Workspace approval revoked');};
    await assert.rejects(native.run(b,'No send','wa:blocked'),/revoked/);assert.equal(readFileSync(counter,'utf8'),first);
    native.beforeRun=()=>{};store.set(`execution-mode:${b.id}`,'cli');await native.run(b,'CLI test','wa:cli');assert.equal(managed,1);assert.equal(readFileSync(counter,'utf8'),first);
  }finally{native.close();store.close();}
});
