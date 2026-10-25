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
const {NativeAgents,mergeClaudeSessions}=await import('../src/native.js');
const {Connections}=await import('../src/connections.js');
test.after(()=>rmSync(dir,{recursive:true,force:true}));
test('Desktop worker routes via its inbox, never managed CLI; workspace guard runs before delivery',async()=>{
  const store=new Store(':memory:'),approvals=new Approvals(store),native=new NativeAgents(store,approvals);
  try {
    (native as any).desktopConfig=async()=>{};
    const b=store.register('desktop-worker','claude','11111111-1111-4111-a111-111111111111',dir).binding;
    store.set(`managed-worker:${b.id}`,'true');store.set(`execution-mode:${b.id}`,'desktop');
    native.connections=new Connections(store,async()=>({state:'verified',label:'Test account',accountKey:'test'}));
    native.catalog=async()=>({sessions:[{id:b.native_id,cwd:dir,provider:'claude',name:'Desktop',status:'running',executionMode:'desktop',available:true}],cursor:null});
    let managed=0,guard=0;native.managedRun=async()=>{managed++;};native.beforeRun=()=>{guard++;};
    await native.run(b,'Harmless offline test','wa:test');assert.equal(managed,0);assert.equal(guard,2);assert.ok(readFileSync(counter,'utf8').includes('sent'));
    const first=readFileSync(counter,'utf8');native.beforeRun=()=>{throw new Error('Workspace approval revoked');};
    await assert.rejects(native.run(b,'No send','wa:blocked'),/revoked/);assert.equal(readFileSync(counter,'utf8'),first);
    native.beforeRun=()=>{};store.set(`execution-mode:${b.id}`,'cli');await assert.rejects(native.run(b,'No silent route switch','wa:changed'),/connection changed/);await native.connections.choose(b,'cli',true);native.catalog=async()=>({sessions:[{id:b.native_id,cwd:dir,provider:'claude',name:'CLI',status:'saved',executionMode:'cli',available:true}],cursor:null});await native.run(b,'CLI test','wa:cli');assert.equal(managed,1);assert.equal(readFileSync(counter,'utf8'),first);
  }finally{native.close();store.close();}
});


test('live CLI discovery never erases a saved Desktop chat or borrows its account identity',()=>{
 const id='11111111-1111-4111-a111-111111111111';
 const desktop={id,desktopId:'local_'+id,accountScope:'desktop-account',provider:'claude' as const,executionMode:'desktop' as const,cwd:dir,name:'Desktop history',status:'saved',activation:'desktop-open' as const};
 const rows=[...mergeClaudeSessions([],[desktop],[{sessionId:id,pid:12,cwd:dir,name:'CLI running'}],new Set(),new Set([12])).values()];
 assert.equal(rows.length,2);const d=rows.find(s=>s.executionMode==='desktop')!,c=rows.find(s=>s.executionMode==='cli')!;
 assert.equal(d.desktopId,desktop.desktopId);assert.equal(d.available,false);assert.match(d.status,/running in CLI/);
 assert.equal(c.available,true);assert.equal(c.accountScope,undefined);assert.equal(c.desktopId,undefined);
});
