import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { BrowserTabs,browserFailure,type BrowserNative } from '../src/browser-tabs.js';
const nativeBrowser={id:'ai.perplexity.comet',name:'Comet',pid:123,supported:true};
function fixture() {
  const calls:Record<string,unknown>[]=[];
  let time=1000,changed=false,fail='',pageUrl='https://example.org/hackathon?private=do-not-return#private';
  const native:BrowserNative=async q=>{
    calls.push(q);
    if(fail)throw new Error(fail);
    if(q.action==='inventory')return [nativeBrowser,{id:'org.mozilla.firefox',name:'Firefox',pid:5,supported:false}];
    if(q.action==='tabs')return [{windowId:'1',tabId:'2',title:'Hackathon details',url:pageUrl},{windowId:'1',tabId:'3',title:'Hackathon schedule',url:'https://example.org/schedule'},{windowId:'1',tabId:'4',title:'Internal',url:'file:///private/a'}];
    if(changed)throw new Error('TAB_STALE');
    if(q.action==='read')return {url:pageUrl,title:'Hackathon details',text:'Overview. Click Schedule.',links:[{id:'0',label:'Schedule',href:'https://example.org/schedule?private=hidden',x:10,y:20},{id:'1',label:'Code',href:'javascript:alert(1)',x:0,y:0}],controls:[],viewport:{width:1000,height:800},scrollY:0};
    return q.action==='follow'?{navigationRequested:true}:{selected:true};
  };
  const service=new BrowserTabs(native,'darwin',()=>time);
  return {service,calls,change:()=>changed=true,fail:(e:string)=>fail=e,advance:()=>time+=300001,pageUrl:(s:string)=>pageUrl=s};
}
async function selected(f:ReturnType<typeof fixture>,scope='owner:a') {
  const list=await f.service.run(scope,{action:'discover',query:'hackathon'}) as any;
  const tabRef=list.browsers[0].tabs[0].tabRef;
  await f.service.run(scope,{action:'select',tabRef});return tabRef;
}
test('discovery only reads tab metadata, reports ambiguity and unsupported browsers, strips query and fragment',async()=>{
  const f=fixture(),r=await f.service.run('owner:a',{action:'discover',query:'hackathon'}) as any;
  assert.equal(r.matches,2);assert.equal(r.ambiguous,true);assert.equal(r.browsers[1].supported,false);
  assert.equal(r.browsers[0].tabs[0].url,'https://example.org/hackathon');
  assert.doesNotMatch(JSON.stringify(r),/do-not-return|file:\/\//);
  assert.deepEqual(f.calls.map(c=>c.action),['inventory','tabs']);
});
test('reading requires a selected tab belonging to this request; refs expire and rediscovery invalidates',async()=>{
  const f=fixture(),list=await f.service.run('owner:a',{action:'discover'}) as any,tabRef=list.browsers[0].tabs[0].tabRef;
  await assert.rejects(f.service.run('owner:b',{action:'select',tabRef}),/TAB_STALE/);
  await assert.rejects(f.service.run('owner:a',{action:'read',tabRef}),/Select the exact/);
  await f.service.run('owner:a',{action:'select',tabRef});f.advance();
  await assert.rejects(f.service.run('owner:a',{action:'read',tabRef}),/TAB_STALE/);
  const fresh=await selected(f);await f.service.run('owner:a',{action:'discover'});
  await assert.rejects(f.service.run('owner:a',{action:'read',tabRef:fresh}),/TAB_STALE/);
});
test('live selected page output is untrusted, link targets are restricted and follow invalidates before uncertain navigation',async()=>{
  const f=fixture(),tabRef=await selected(f),page=await f.service.run('owner:a',{action:'read',tabRef}) as any;
  assert.equal(page.untrustedPageEvidence,true);assert.equal(page.links.length,1);assert.equal(page.links[0].href,'https://example.org/schedule');
  await assert.rejects(f.service.run('owner:a',{action:'follow',tabRef,linkId:'0'}),/PAGE_STALE/);
  await assert.rejects(f.service.run('owner:a',{action:'follow',tabRef,linkId:'1',snapshotId:page.snapshotId}),/Choose a link/);
  f.fail('BROWSER_TIMEOUT');
  await assert.rejects(f.service.run('owner:a',{action:'follow',tabRef,linkId:'0',snapshotId:page.snapshotId}),/BROWSER_TIMEOUT/);
  await assert.rejects(f.service.run('owner:a',{action:'follow',tabRef,linkId:'0',snapshotId:page.snapshotId}),/TAB_STALE/);
});
test('scroll invalidates links; changed and disconnected tabs never fall back to another target',async()=>{
  const f=fixture(),tabRef=await selected(f),page=await f.service.run('owner:a',{action:'read',tabRef}) as any;
  await f.service.run('owner:a',{action:'scroll',tabRef,direction:'down'});
  await assert.rejects(f.service.run('owner:a',{action:'follow',tabRef,linkId:'0',snapshotId:page.snapshotId}),/PAGE_STALE/);
  f.change();await assert.rejects(f.service.run('owner:a',{action:'read',tabRef}),/TAB_STALE/);
  assert.equal(f.calls.at(-1)?.tabId,'2');assert.equal(f.calls.at(-1)?.pid,123);
  f.fail('BROWSER_DISCONNECTED');await assert.rejects(f.service.run('owner:a',{action:'select',tabRef}),/BROWSER_DISCONNECTED/);
});
test('permissions and unsupported operating systems fail clearly with no private command output',async()=>{
  assert.match(browserFailure({stderr:'Executing JavaScript through AppleScript is turned off.'}).message,/PAGE_PERMISSION_REQUIRED/);
  assert.match(browserFailure({stderr:'Not authorized -1743'}).message,/AUTOMATION_PERMISSION_REQUIRED/);
  assert.match(browserFailure({killed:true,stderr:'private URL'}).message,/BROWSER_TIMEOUT/);
  assert.doesNotMatch(browserFailure({stderr:'private URL'}).message,/private URL/);
  let calls=0;await assert.rejects(new BrowserTabs(async()=>{calls++;},'win32').run('a',{action:'discover'}),/macOS only/);assert.equal(calls,0);
  const f=fixture(),tabRef=await selected(f);f.fail('PAGE_PERMISSION_REQUIRED');
  await assert.rejects(f.service.run('owner:a',{action:'read',tabRef}),/PAGE_PERMISSION_REQUIRED/);
  assert.equal(f.calls.filter(c=>c.action==='read').length,1);
});
test('arbitrary scripts, navigation URLs and unrecognized actions never reach the browser',async()=>{
  const f=fixture();
  for(const q of [{action:'evaluate',script:'bad'},{action:'discover',url:'https://example.org'},{action:'read',script:'bad'}])await assert.rejects(f.service.run('a',q));
  assert.equal(f.calls.length,0);
});

test('exact browser-name discovery scopes before tab calls and does not filter its titles by the browser name',async()=>{
  const calls:Record<string,unknown>[]=[];
  const service=new BrowserTabs(async q=>{
    calls.push(q);
    if(q.action==='inventory')return [{id:'com.google.Chrome',name:'Google Chrome',pid:8,supported:true},nativeBrowser];
    assert.equal(q.browser,nativeBrowser.id,'unrelated browsers must not receive tab requests');
    return [{windowId:'1',tabId:'2',title:'Hackathon',url:'https://example.org/event'}];
  },'darwin');
  const result=await service.run('owner:a',{action:'discover',query:'Comet'}) as any;
  assert.equal(result.matches,1);assert.equal(result.browsers.length,1);
  assert.deepEqual(calls.map(q=>q.action),['inventory','tabs']);
});

test('explicit browser and page filters remain separate; unknown browser never queries a substitute',async()=>{
  const f=fixture();
  const result=await f.service.run('owner:a',{action:'discover',browser:'ai.perplexity.comet',query:'schedule'}) as any;
  assert.equal(result.matches,1);assert.equal(result.browsers[0].tabs[0].title,'Hackathon schedule');
  const before=f.calls.length;
  await assert.rejects(f.service.run('owner:a',{action:'discover',browser:'Not running'}),/BROWSER_NOT_RUNNING/);
  assert.deepEqual(f.calls.slice(before).map(q=>q.action),['inventory']);
  const unsupported=await f.service.run('owner:a',{action:'discover',browser:'Firefox'}) as any;
  assert.equal(unsupported.browsers[0].supported,false);assert.equal(f.calls.at(-1)?.action,'inventory');
  await assert.rejects(f.service.run('owner:a',{action:'select',browser:'Comet',tabRef:result.browsers[0].tabs[0].tabRef}),/only for discovery/);
});

test('timeout diagnostics identify only an allowlisted phase without inferring permission or successful inventory',async()=>{
  const error=browserFailure({killed:true,stderr:'FFD_BROWSER_STAGE:windows\nFFD_BROWSER_STAGE:tabs\nprivate-url-and-title'});
  assert.match(error.message,/stage: tabs/);assert.match(error.message,/Permission status is unknown/);
  assert.doesNotMatch(error.message,/private-url-and-title/);
  assert.match(browserFailure({stderr:'AppleEvent timed out (-1712)'}).message,/BROWSER_TIMEOUT/);
  assert.match(browserFailure({killed:true,stderr:'FFD_BROWSER_STAGE:private-value'}).message,/stage: unknown/);
  const calls:string[]=[];
  const service=new BrowserTabs(async q=>{calls.push(String(q.action));if(q.action==='inventory')return [nativeBrowser];throw error;},'darwin');
  const result=await service.run('owner:a',{action:'discover',browser:'Comet'}) as any;
  assert.equal(result.matches,0);assert.match(result.browsers[0].error,/BROWSER_TIMEOUT/);
  assert.match(result.next,/Check browser errors/);assert.deepEqual(calls,['inventory','tabs']);
});

test('JXA diagnostics mark the stalled phase and never log browser metadata',()=>{
  const source=readFileSync(new URL('../native/browser-tabs.js',import.meta.url),'utf8');
  for(const stop of ['windows','tabs','tab-metadata','none']) {
    const logs:string[]=[],fail=(at:string)=>{if(stop===at)throw Error('fixture stall');};
    const tab={id:()=>2,title:()=>{fail('tab-metadata');return 'PRIVATE TITLE';},url:()=> 'https://example.org/private'};
    const window={id:()=>1,tabs:()=>{fail('tabs');return [tab];}};
    const context={ObjC:{import:()=>{},unwrap:(x:unknown)=>x},$:{NSWorkspace:{sharedWorkspace:{runningApplications:[{bundleIdentifier:nativeBrowser.id,localizedName:'Comet',processIdentifier:123}]}}},Application:()=>({running:()=>true,windows:()=>{fail('windows');return [window];}}),console:{log:(s:string)=>logs.push(s)}};
    const run=()=>runInNewContext(source+`\nrun([${JSON.stringify(JSON.stringify({action:'tabs',browser:nativeBrowser.id,pid:123}))}]);`,context);
    if(stop==='none')assert.equal(JSON.parse(run())[0].title,'PRIVATE TITLE');else assert.throws(run,/fixture stall/);
    assert.equal(logs.at(-1),'FFD_BROWSER_STAGE:'+(stop==='none'?'tab-metadata':stop));
    assert.doesNotMatch(logs.join('\n'),/PRIVATE TITLE|example.org/);
  }
});
