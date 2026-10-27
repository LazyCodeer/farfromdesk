import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DesktopControl,desktopPage,desktopUrl,visibleElements } from '../src/desktop-control.js';
import { runFfd } from '../src/ffd.js';

function fixture(){
  const prefs=new Map([['mac-control-enabled','true']]),calls:any[]=[],browserCalls:any[]=[];
  let pid=7,truncated=false,fail=false,stopped=0;
  const win={window_id:8,pid:7,layer:0,title:'Page',bounds:{x:0,y:0,width:800,height:600}};
  const elements=[{element_index:0,role:'AXWebArea',label:'Page'},
    {element_index:1,parent_index:0,role:'AXStaticText',value:'Page content'},
    {element_index:2,parent_index:0,element_token:'s00000001:2',role:'AXTextArea',label:'Ask Gemini',value:'',enabled:true}];
  const driver={call:async(name:string,args:any)=>{
    calls.push({name,args});if(fail&&name==='click')throw new Error('UNCERTAIN');
    if(name==='list_apps')return {apps:[{name:'Comet',bundle_id:'ai.perplexity.comet',pid,running:true},{name:'Gemini',bundle_id:'com.google.GeminiMacOS',pid:9,running:true},{name:'Passwords',bundle_id:'com.apple.Passwords',pid:10,running:true}]};
    if(name==='list_windows')return {windows:[{...win,pid:args.pid}]};
    if(name==='get_window_state')return {elements,truncated};
    return {effect:'unverifiable'};
  },stop:()=>{stopped++;}};
  const browser=async(q:any)=>{browserCalls.push(q);if(q.operation==='list_tabs')return {windows:[{window_id:'100',bounds:win.bounds,active_tab_id:'101',tabs:[{tab_id:'101',title:'Page',url:'https://example.org/'}]}]};return {tab_id:'102'};};
  const service=new DesktopControl({get:k=>prefs.get(k),set:(k,v)=>{prefs.set(k,v);}},driver,browser,'darwin');
  return {service,prefs,calls,browserCalls,driver,browser,elements,setPid:(v:number)=>{pid=v;},truncate:()=>{truncated=true;},fail:()=>{fail=true;},stops:()=>stopped};
}
async function window(f:ReturnType<typeof fixture>,gemini=false){const a=await f.service.run('owner',{action:'list_apps'});const w=await f.service.run('owner',{action:'list_windows',appRef:a.apps[gemini?1:0].appRef});return w.windows[0].windowRef;}
test('desktop opt-in and platform gate precede all native work',async()=>{
  const f=fixture();f.prefs.delete('mac-control-enabled');await assert.rejects(f.service.run('owner',{action:'list_apps'}),/DISABLED/);assert.equal(f.calls.length,0);
  const other=new DesktopControl({get:()=>undefined,set:()=>{}},f.driver,f.browser,'win32');assert.equal((await other.run('owner',{action:'status'})).supported,false);await assert.rejects(other.run('owner',{action:'list_apps'}),/MACOS_ONLY/);
});
test('explicit browser, exact request scope and live PID are required',async()=>{
  const f=fixture();await assert.rejects(f.service.run('owner',{action:'list_tabs'}),/SELECT_SUPPORTED_BROWSER/);
  await assert.rejects(f.service.run('owner',{action:'list_tabs',browser:'safari'}),/SELECT_SUPPORTED_BROWSER/);assert.equal(f.browserCalls.length,0);
  const r=await f.service.run('owner',{action:'list_tabs',browser:'comet'}),tabRef=r.windows[0].tabs[0].tabRef;
  await assert.rejects(f.service.run('another',{action:'read_tab',tabRef}),/TARGET_STALE/);
  f.setPid(88);await assert.rejects(f.service.run('owner',{action:'read_tab',tabRef}),/APP_STALE/);
});
test('new tab targets exact discovered window and action reservations survive instances',async()=>{
  const f=fixture(),r=await f.service.run('owner',{action:'list_tabs',browser:'comet'}),actionId=randomUUID();
  const q={action:'new_tab',windowRef:r.windows[0].windowRef,url:'https://example.org/?quoted=%22',actionId};
  await f.service.run('owner',q);await assert.rejects(f.service.run('owner',q),/ALREADY_ATTEMPTED/);
  assert.equal(f.browserCalls.filter(c=>c.operation==='new_tab').length,1);assert.equal(f.browserCalls.at(-2).window_id,'100');
  assert.equal([...f.prefs.keys()].filter(k=>k.startsWith('desktop-action:')).length,1);assert.equal([...f.prefs.values()].includes(q.url),false);
  const again=new DesktopControl({get:k=>f.prefs.get(k),set:(k,v)=>{f.prefs.set(k,v);}},f.driver,f.browser,'darwin');
  const next=await again.run('owner',{action:'list_tabs',browser:'comet'});
  await assert.rejects(again.run('owner',{...q,windowRef:next.windows[0].windowRef}),/ALREADY_ATTEMPTED/);
});
test('unknown actions consume snapshots and never replay',async()=>{
  const f=fixture(),windowRef=await window(f),read=await f.service.run('owner',{action:'read_window',windowRef});
  const control=read.controls.find((e:any)=>e.role==='AXTextArea');
  const q={action:'click',windowRef,controlId:control.controlId,snapshotId:read.snapshotId,actionId:randomUUID()};f.fail();
  await assert.rejects(f.service.run('owner',q),/UNCERTAIN/);await assert.rejects(f.service.run('owner',q),/CONTROL_STALE/);
  assert.equal(f.calls.filter(c=>c.name==='click').length,1);
});
test('page reads isolate sidebar, preserve truncation and reject ambiguous roots',()=>{
  const f=fixture(),es=[...f.elements,{element_index:3,role:'AXWebArea',label:'Perplexity'},{element_index:4,parent_index:3,role:'AXStaticText',value:'Wrong content'}];
  assert.equal(desktopPage({elements:es,truncated:true},'Page').text,'Page content\nAsk Gemini');assert.equal(desktopPage({elements:es,truncated:true},'Page').truncated,true);
  assert.throws(()=>desktopPage({elements:[...es,{element_index:5,role:'AXWebArea',label:'Page'}]},'Page'),/AMBIGUOUS/);
  assert.equal(visibleElements({elements:[{element_index:0,role:'AXSecureTextField'},{element_index:1,parent_index:0,role:'AXStaticText',value:'secret'}]}).length,0);
});
test('chat send refuses missing/mismatched drafts and truncated trees',async()=>{
  const f=fixture(),windowRef=await window(f,true);
  await assert.rejects(f.service.run('owner',{action:'chat_action',windowRef,chatAction:'send',actionId:randomUUID(),expectedDraft:'different'}),/DRAFT_MISMATCH/);
  f.truncate();await assert.rejects(f.service.run('owner',{action:'chat_action',windowRef,chatAction:'draft',text:'test',actionId:randomUUID()}),/TREE_TRUNCATED/);
  assert.equal(f.calls.some(c=>['type_text','press_key','click'].includes(c.name)),false);
});
test('stop invalidates all references, and security apps are not exposed',async()=>{
  const f=fixture(),w=await window(f);assert.equal((await f.service.run('owner',{action:'list_apps'})).apps.length,2);
  f.service.stop();assert.equal(f.stops(),1);await assert.rejects(f.service.run('owner',{action:'read_window',windowRef:w}),/TARGET_STALE/);
});
test('URLs and arbitrary scripts/coordinates are rejected',async()=>{
  const f=fixture();for(const url of ['javascript:alert(1)','file:///tmp/file','https://u:p@example.org/','https://example.org/\n'])assert.throws(()=>desktopUrl(url));
  assert.equal(desktopUrl('about:blank'),'about:blank');
  for(const q of [{action:'click',x:1},{action:'evaluate',script:'x'},{action:'list_apps',text:'x'}])await assert.rejects(f.service.run('owner',q));
  assert.equal(f.calls.length,0);
});
test('FFD desktop sends the exact owner request and validates the action schema',async()=>{
  let sent:any;await runFfd(['desktop','owner-req'],{id:'coordinator'},async(path,data)=>{sent={path,data};return {};},()=>JSON.stringify({action:'list_tabs',browser:'comet'}));
  assert.equal(sent.path,'/api/master/desktop-control');assert.equal(sent.data.requestId,'owner-req');assert.equal(sent.data.browser,'comet');
});
test('Stop aborts in-flight work and a late native response cannot restore targets',async()=>{
  let release:(r:any)=>void=()=>{},signal:AbortSignal|undefined;
  const f=fixture();const service=new DesktopControl({get:()=> 'true',set:()=>{}},{call:async(_n,_a,s)=>{signal=s;return new Promise(r=>{release=r;});},stop:()=>{}},f.browser,'darwin');
  const pending=service.run('owner',{action:'list_apps'});
  await assert.rejects(service.run('owner',{action:'list_apps'}),/BUSY/);
  service.stop();assert.equal(signal?.aborted,true);release({apps:[]});await assert.rejects(pending,/STOPPED/);
});
test('owner authorization is rechecked before each native/browser step',async()=>{
  const f=fixture();let checks=0;
  await assert.rejects(f.service.run('owner',{action:'list_tabs',browser:'comet'},()=>{if(++checks>=2)throw new Error('owner request closed');}),/request closed/);
  assert.equal(f.browserCalls.length,0);
});
test('a native driver restart invalidates cached tokens even if token strings are reused',async()=>{
  const f=fixture();Object.assign(f.driver,{revision:0});const w=await window(f),read=await f.service.run('owner',{action:'read_window',windowRef:w});
  Object.assign(f.driver,{revision:1});const control=read.controls.find((e:any)=>e.role==='AXTextArea');
  await assert.rejects(f.service.run('owner',{action:'click',windowRef:w,snapshotId:read.snapshotId,controlId:control.controlId,actionId:randomUUID()}),/driver restarted/);
  assert.equal(f.calls.some(c=>c.name==='click'),false);
});
