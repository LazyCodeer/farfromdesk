import test from 'node:test';
import assert from 'node:assert/strict';
import { MacControl,type MacNative } from '../src/mac-control.js';
const h='a'.repeat(64);
function fixture(){
  const prefs=new Map<string,string>(),calls:any[]=[];let time=1000,error='';
  const native:MacNative=async input=>{
    calls.push(input);if(error)throw new Error(error);
    if(input.action==='status'||input.action==='requestPermission')return {trusted:false};
    if(input.action==='discover')return {apps:[{pid:42,bundleId:'test.app',name:'Test App',launched:123},{pid:43,bundleId:'test.other',name:'Other',launched:124}]};
    if(input.action==='windows')return {windows:[{index:0,title:'Test window',identifier:'one',frame:[0,0,800,600],windowHash:h}]};
    if(input.action==='read')return {snapshotHash:h,controls:[{path:[0],controlHash:h,role:'AXTextField',label:'Practice',value:'',enabled:true,protected:false,actions:['AXPress'],frame:[10,10,100,50]}]};
    return {selected:true,focused:true,window:{index:0,title:'Test window',identifier:'one',frame:[0,0,800,600],windowHash:h},actionSent:true,verified:false};
  };
  const service=new MacControl({get:k=>prefs.get(k),set:(k,v)=>{prefs.set(k,v);}},native,'darwin',()=>time);
  return {service,calls,fail:(s:string)=>{error=s;},advance:()=>{time+=121000;},setTime:(n:number)=>{time=n;}};
}
async function selected(f:ReturnType<typeof fixture>){
  f.service.configure(true);const apps=await f.service.run('owner:1',{action:'discover'}) as any;
  const windows=await f.service.run('owner:1',{action:'windows',appRef:apps.apps[0].appRef}) as any;
  const windowRef=windows.windows[0].windowRef;
  await f.service.run('owner:1',{action:'select',windowRef});return windowRef;
}
test('Mac control defaults off, never prompts from polling and filters app discovery without reading windows',async()=>{
  const f=fixture();assert.equal(f.service.view().enabled,false);
  await assert.rejects(f.service.run('owner:1',{action:'discover'}),/DISABLED/);assert.equal(f.calls.length,0);
  await f.service.status();assert.equal(f.calls[0].action,'status');assert.equal(f.service.view().trusted,false);
  f.service.configure(true);const r=await f.service.run('owner:1',{action:'discover'}) as any;assert.equal(r.ambiguous,true);assert.equal(r.contentRead,false);
  assert.equal(f.calls.some(c=>c.action==='windows'),false);
  const filtered=await f.service.run('owner:1',{action:'discover',query:'Test App'}) as any;assert.equal(filtered.apps.length,1);
  await f.service.status(true);assert.equal(f.calls.at(-1).action,'requestPermission');
});
test('Exact app/window refs are scoped, expiring and require selection',async()=>{
  const f=fixture();const windowRef=await selected(f);
  await assert.rejects(f.service.run('other-owner',{action:'read',windowRef}),/STALE/);
  f.advance();await assert.rejects(f.service.run('owner:1',{action:'read',windowRef}),/STALE/);
  const g=fixture();g.service.configure(true);
  const a=await g.service.run('owner:1',{action:'discover'}) as any;
  const w=await g.service.run('owner:1',{action:'windows',appRef:a.apps[0].appRef}) as any;
  await assert.rejects(g.service.run('owner:1',{action:'read',windowRef:w.windows[0].windowRef}),/Select/);
});
test('Interactions use native snapshot fingerprints, consume snapshots before execution and never replay',async()=>{
  const f=fixture(),windowRef=await selected(f);
  const r=await f.service.run('owner:1',{action:'read',windowRef}) as any;
  assert.equal(r.untrustedAppEvidence,true);assert.equal(r.controls[0].path,undefined);
  const q={action:'type',windowRef,snapshotId:r.snapshotId,controlId:r.controls[0].controlId,text:'Practice only'};
  await f.service.run('owner:1',q);assert.equal(f.calls.at(-1).snapshotHash,h);assert.deepEqual(f.calls.at(-1).path,[0]);
  const before=f.calls.length;await assert.rejects(f.service.run('owner:1',q),/STALE/);assert.equal(f.calls.length,before);
  const next=await f.service.run('owner:1',{action:'read',windowRef}) as any;f.fail('ACTION_OUTCOME_UNKNOWN');
  const click={action:'click',windowRef,snapshotId:next.snapshotId,controlId:next.controls[0].controlId};
  await assert.rejects(f.service.run('owner:1',click),/UNKNOWN/);f.fail('');await assert.rejects(f.service.run('owner:1',click),/STALE/);
});
test('Permission refusal, stale native windows and unsupported controls never switch methods',async()=>{
  const f=fixture(),windowRef=await selected(f);f.fail('ACCESSIBILITY_PERMISSION_REQUIRED');
  await assert.rejects(f.service.run('owner:1',{action:'read',windowRef}),/PERMISSION_REQUIRED/);assert.equal(f.service.view().trusted,false);
  f.fail('');await assert.rejects(f.service.run('owner:1',{action:'read',windowRef}),/STALE/);
  const g=fixture(),w=await selected(g);g.fail('WINDOW_STALE');await assert.rejects(g.service.run('owner:1',{action:'read',windowRef:w}),/WINDOW_STALE/);
  assert.equal(g.calls.filter(c=>c.action==='read').length,1);
});
test('Unscoped coordinates, scripts, unknown fields and control characters are refused before native calls',async()=>{
  const f=fixture();f.service.configure(true);
  for(const q of [{action:'click',x:1,y:2},{action:'evaluate',script:'x'},{action:'discover',text:'x'},{action:'type',text:'go\n'},{action:'discover',pid:9}])await assert.rejects(f.service.run('owner:1',q));
  assert.equal(f.calls.length,0);
});
test('Disable cancels in-flight work and invalidates targets even if the helper returns later',async()=>{
  let release:(value:any)=>void=()=>{};let signal:AbortSignal|undefined;const values=new Map<string,string>();
  const service=new MacControl({get:k=>values.get(k),set:(k,v)=>{values.set(k,v);}},async(q,s)=>{signal=s;return new Promise(r=>{release=r;});},'darwin');
  service.configure(true);const pending=service.run('owner:1',{action:'discover'});
  await assert.rejects(service.run('owner:1',{action:'discover'}),/in progress/);
  service.configure(false);assert.equal(signal?.aborted,true);release({apps:[]});await assert.rejects(pending,/STOPPED/);
  assert.equal(service.view().enabled,false);
});
test('Stop works while disabled; non-Mac builds report unsupported without invoking the helper',async()=>{
  const service=new MacControl({get:()=>undefined,set:()=>{}},async()=>{throw new Error('must not call');},'linux');
  assert.equal((await service.status()).supported,false);assert.equal((await service.run('a',{action:'stop'}) as any).stopped,true);
  await assert.rejects(service.run('a',{action:'discover'}),/macOS only/);
});
test('Successful empty AXWindows is explicit and does not select or read another target',async()=>{
  const calls:string[]=[],prefs=new Map<string,string>();
  const service=new MacControl({get:k=>prefs.get(k),set:(k,v)=>{prefs.set(k,v);}},async q=>{
    calls.push(String(q.action));
    if(q.action==='discover')return {apps:[{pid:42,bundleId:'test.app',name:'Test App',launched:123}]};
    return {windows:[],windowQuery:'success',appActive:false,appHidden:true};
  },'darwin');
  service.configure(true);const a=await service.run('owner:empty',{action:'discover'}) as any;
  const result=await service.run('owner:empty',{action:'windows',appRef:a.apps[0].appRef}) as any;
  assert.deepEqual(result.windows,[]);assert.equal(result.windowQuery,'success');assert.equal(result.appHidden,true);
  assert.match(result.next,/Open the existing app/);assert.deepEqual(calls,['discover','windows']);
});
test('Window query errors propagate and never become a successful empty list',async()=>{
  for(const code of ['AX_APP_UNRESPONSIVE','AX_WINDOWS_UNSUPPORTED','AX_WINDOWS_NO_VALUE','AX_WINDOWS_INVALID_RESPONSE']) {
    const f=fixture();f.service.configure(true);const a=await f.service.run('owner:1',{action:'discover'}) as any;f.fail(code);
    await assert.rejects(f.service.run('owner:1',{action:'windows',appRef:a.apps[0].appRef}),new RegExp(code));
    assert.equal(f.calls.at(-1).action,'windows');
  }
});

test('successful reads renew idle lease but never extend the hard request lifetime',async()=>{const f=fixture(),id=await selected(f);f.setTime(110000);await f.service.run('owner:1',{action:'read',windowRef:id});f.setTime(150000);await f.service.run('owner:1',{action:'read',windowRef:id});for(const n of [250000,350000,450000,550000]){f.setTime(n);await f.service.run('owner:1',{action:'read',windowRef:id});}f.setTime(601001);await assert.rejects(f.service.run('owner:1',{action:'read',windowRef:id}),/STALE/);});
