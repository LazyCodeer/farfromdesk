import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {EmbeddedDesktopDriver} from '../dist/desktop-driver.js';
import {NativeOwnerBackend} from '../dist/owner-view/native.js';
import {OwnerViewSession} from '../dist/owner-view/session.js';
import {ownerViewServer} from '../dist/owner-view/http.js';
// Explicit manual invocation only. Real input to the isolated fixture, never normal apps.
if(process.argv[2]!=='--run-safe-fixture')throw Error('Explicit safe fixture trial flag required');
const root=resolve('build/owner-view-test/native')+'/';
const driver=new EmbeddedDesktopDriver(root,'FarFromDesk Owner View Test.app',true);
const out=resolve('docs/evidence/owner-view/live-trial-'+Date.now());await mkdir(out,{recursive:true});
const evidence={startedAt:new Date().toISOString(),checks:[],inputAttempts:[]};
let backend,session,view;
try{
 const apps=await driver.call('list_apps',{}),app=apps.apps.filter(a=>a.bundle_id==='com.codecy.mac-control-lab.fixture'&&a.running).sort((a,b)=>b.pid-a.pid)[0];
 assert(app,'Open MacControlFixture first');
 const windows=await driver.call('list_windows',{pid:app.pid});
 const window=windows.windows.find(w=>w.title==='Mac Control Lab — Fixture'&&w.layer===0);assert(window,'Fixture must exist');
 if(!window.is_on_screen)await driver.call('bring_to_front',{pid:app.pid,window_id:window.window_id});
 backend=new NativeOwnerBackend(app.pid,window.window_id,'/tmp/ffd-owner-session-state',root,driver);
 const nativeAct=backend.act.bind(backend);backend.act=async(...args)=>{try{return await nativeAct(...args);}catch(e){evidence.nativeFailure=e.message;throw e;}};
 assert(await backend.ready(),JSON.stringify(backend.lastReadiness));evidence.checks.push('fresh unlocked state and both native grants');
 const tree=()=>driver.call('get_window_state',{pid:app.pid,window_id:window.window_id,include_screenshot:false,tree_format:'elements',max_elements:5000});
 session=new OwnerViewSession(backend);view=ownerViewServer(session);const origin=await view.listen();let cookie='';
 const post=async(path,data={})=>{const r=await fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(data)});const body=await r.json();return {status:r.status,body,cookie:r.headers.get('set-cookie')};};
 assert.equal((await post('/frame')).status,409);evidence.checks.push('unauthenticated frame refused');
 const claim=await post('/claim',{code:session.pairingCode});assert.equal(claim.status,200);cookie=claim.cookie.split(';')[0];
 assert.equal((await post('/claim',{code:session.pairingCode})).status,409);evidence.checks.push('one-time pairing');
 const frame=async(name)=>{const r=await post('/frame');assert.equal(r.status,200,JSON.stringify(r.body));if(name)await writeFile(join(out,name+'.png'),Buffer.from(r.body.png,'base64'));return r.body;};
 let f=await frame('before');evidence.checks.push(`real screenshot ${f.width}x${f.height}`);
 if(!process.argv.includes('--click-only')){
 const target=f.fields.find(x=>x.label==='Test input');assert(target);
 const text='FarFromDesk live test '+new Date().toISOString();
 const typing={id:randomUUID(),frameId:f.frameId,kind:'type',fieldId:target.id,text};
 evidence.inputAttempts.push({kind:'type',id:typing.id});await writeFile(join(out,'result.json'),JSON.stringify(evidence,null,2));
 const typed=await post('/action',typing);assert.equal(typed.status,200,JSON.stringify(typed.body));
 const afterType=await tree();assert.equal(afterType.elements.find(x=>x.label==='Test input').value.split(text).length-1,1);evidence.checks.push('typed text exactly read back from native field');
 assert.equal((await post('/action',typing)).status,409);evidence.checks.push('duplicate action refused');
 await frame('after-type');
 }
 const beforeClick=await tree();const button=beforeClick.elements.find(e=>e.role==='AXButton'&&e.label==='Increment');assert(button?.frame);
 const axWindow=beforeClick.elements.find(e=>e.role==='AXWindow'&&e.frame);assert(axWindow);
 const wr={x:axWindow.frame.x,y:axWindow.frame.y,width:axWindow.frame.w,height:axWindow.frame.h};
 f=await frame();
 const click={id:randomUUID(),frameId:f.frameId,kind:'click',x:(button.frame.x+button.frame.w/2-wr.x)/wr.width,y:(button.frame.y+button.frame.h/2-wr.y)/wr.height};
 evidence.inputAttempts.push({kind:'click',id:click.id});await writeFile(join(out,'result.json'),JSON.stringify(evidence,null,2));
 const clicked=await post('/action',click);assert.equal(clicked.status,200,JSON.stringify(clicked.body));
 await frame('after-click');const afterClick=await tree();
 await writeFile(join(out,'fixture-tree-before.txt'),beforeClick.tree_markdown??'');await writeFile(join(out,'fixture-tree-after.txt'),afterClick.tree_markdown??'');
 evidence.checks.push('one picture-coordinate click dispatched; screenshot saved for outcome verification');
 f=await frame();await new Promise(r=>setTimeout(r,5100));
 assert.equal((await post('/action',{id:randomUUID(),frameId:f.frameId,kind:'click',x:.5,y:.5})).body.error,'STALE_FRAME_REFRESH_FIRST');evidence.checks.push('expired frame refused before native input');
 assert.equal((await post('/stop')).status,200);assert.equal((await post('/frame')).body.error,'SESSION_ENDED');evidence.checks.push('Stop revokes subsequent frame access');
 evidence.success=true;
}catch(e){evidence.error=e.message;process.exitCode=1;}
finally{session?.stop();backend?.stop();driver.stop();if(view)await new Promise(r=>view.server.close(r));await writeFile(join(out,'result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));}
