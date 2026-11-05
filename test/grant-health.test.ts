import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GrantHealth,diagnoseGrant,readAppSignature,WORKING_CDHASH,type AppSignature} from '../src/grant-health.js';
import { reservePort } from './test-port.js';

const app='/Applications/FarFromDesk.app';
const adhoc:AppSignature={app,bundleId:'app.sessionbridge.mac',cdhash:'new',adhoc:true,quarantined:false};
const prefsOf=(seed:Record<string,string>={})=>{const m=new Map(Object.entries(seed));return {get:(k:string)=>m.get(k),set:(k:string,v:string)=>{m.set(k,v);},m};};

test('reads the ad-hoc signature and a quarantined driver from codesign and xattr',async()=>{
  const calls:string[][]=[];
  const exec=async(file:string,args:string[])=>{
    calls.push([file,...args]);
    if(file.endsWith('codesign'))return {stdout:'',stderr:'Executable=x\nIdentifier=app.sessionbridge.mac\nCDHash=4c0a8f70\nSignature=adhoc\nTeamIdentifier=not set\n'};
    if(args.at(-1)!.endsWith('cua-driver/cua-driver'))return {stdout:'0081;...',stderr:''};
    throw new Error('No such xattr');
  };
  assert.deepEqual(await readAppSignature(app,exec),{app,bundleId:'app.sessionbridge.mac',cdhash:'4c0a8f70',adhoc:true,quarantined:true});
  assert.equal(await readAppSignature('/repo/src',exec),null,'outside a bundle there is nothing to diagnose');
  const team=async()=>({stdout:'',stderr:'Identifier=app.sessionbridge.mac\nCDHash=aa\nTeamIdentifier=ABCDE12345\n'});
  assert.equal((await readAppSignature(app,async(f,a)=>f.endsWith('xattr')?Promise.reject(new Error('none')):team()))!.adhoc,false);
});

test('a failing check on a different ad-hoc build is diagnosed as a stale grant with a reset path',()=>{
  const stale=diagnoseGrant(adhoc,false,null,'old')!;
  assert.equal(stale.kind,'stale');
  assert.match(stale.summary,/still shows on/);
  assert.ok(stale.steps.some(s=>s.includes('tccutil reset Accessibility app.sessionbridge.mac')));
  assert.deepEqual(stale.resetServices,['Accessibility','ScreenCapture']);
  assert.deepEqual(diagnoseGrant(adhoc,false,true,'old')!.resetServices,['Accessibility'],'a working Screen Recording grant is left alone');
  assert.equal(diagnoseGrant(adhoc,false,null,undefined)!.kind,'unconfirmed');
  assert.equal(diagnoseGrant(adhoc,false,null,'new')!.kind,'unconfirmed','same build: no proof it went stale');
  assert.equal(diagnoseGrant(adhoc,true,null,'old'),null);
  assert.equal(diagnoseGrant(adhoc,null,null,'old'),null);
  assert.equal(diagnoseGrant({...adhoc,adhoc:false},false,null,'old'),null,'a team-signed grant survives rebuilds');
  assert.match(diagnoseGrant({...adhoc,quarantined:true},false,null)!.steps[0],/xattr -dr com.apple.quarantine "\/Applications\/FarFromDesk.app"/);
  for(const text of [stale.summary,...stale.steps])assert.doesNotMatch(text,/[\u2013\u2014]/);
});

test('remembers the build that worked, and resets only on request',async()=>{
  const prefs=prefsOf(),execs:string[][]=[];let signature=adhoc;
  const health=new GrantHealth(prefs,async()=>signature,async(f,a)=>{execs.push([f,...a]);return {stdout:'',stderr:''};},'darwin');
  await assert.rejects(health.reset(),/Nothing to reset/);
  assert.equal(await health.check(true),null);
  assert.equal(prefs.m.get(WORKING_CDHASH),'new');
  assert.equal((await health.check(false))!.kind,'unconfirmed');
  prefs.set(WORKING_CDHASH,'from-1.0.0');
  assert.equal((await health.check(null)),health.view(),'an unknown result keeps the last diagnosis');
  assert.equal((await health.check(false,true))!.kind,'stale');
  assert.deepEqual(execs,[],'checking never touches permissions');
  assert.deepEqual(await health.reset(),['Accessibility']);
  assert.deepEqual(execs,[['/usr/bin/tccutil','reset','Accessibility','app.sessionbridge.mac']]);
  assert.equal(await new GrantHealth(prefsOf(),async()=>adhoc,undefined,'linux').check(false),null);
});

test('status explains a stale grant, and only the app itself can reset it',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'ffd-grant-'));
  const port=await reservePort();
  process.env.WSB_STATE_DIR=temp;process.env.WSB_PORT=String(port);
  const [{Store},{Router},{Approvals},{serve}]=await Promise.all([import('../src/store.js'),import('../src/router.js'),import('../src/approvals.js'),import('../src/server.js')]);
  const store=new Store(':memory:');const approvals=new Approvals(store);
  const router=new Router(store,{run:async()=>{},stop:()=>{},connections:{route:()=>undefined}} as any,approvals);
  const {token}=store.register('session','claude',randomUUID(),'/tmp');
  store.set(WORKING_CDHASH,'from-1.0.0');
  const tcc:string[][]=[],statusCalls:boolean[]=[];
  const grantHealth=new GrantHealth(store,async()=>adhoc,async(f,a)=>{tcc.push([f,...a]);return {stdout:'',stderr:''};},'darwin');
  const macControl={view:()=>({supported:true,trusted:false,capture:{trusted:null}}),stop:()=>{},configure:()=>({}),status:async(prompt:boolean)=>{statusCalls.push(prompt);return {supported:true,trusted:false,capture:{}};}};
  const desktopControl={view:()=>({permission:{accessibility:false},capability:{ok:false,detail:'not trusted'}}),stop:()=>{},permissionReport:async()=>({accessibility:false}),capabilityProbe:async()=>({ok:false,detail:'not trusted'})};
  const server=serve(store,router,{status:'not paired'} as any,'synthetic-admin',{macControl,desktopControl,grantHealth,masters:{options:()=>({}),platformPreferences:()=>[]},power:{view:()=>({})}} as any);
  await new Promise<void>(r=>server.once('listening',r));
  const post=(auth:string,body:object)=>fetch(`http://127.0.0.1:${port}/api/mac-control`,{method:'POST',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    const status=await (await fetch(`http://127.0.0.1:${port}/api/status`,{headers:{Authorization:'Bearer synthetic-admin'}})).json();
    assert.equal(status.grant.kind,'stale');
    assert.equal(status.grant.bundleId,'app.sessionbridge.mac');
    assert.deepEqual(tcc,[],'showing the diagnosis changed nothing');
    assert.ok([401,403].includes((await post(token,{action:'reset-permission'})).status),'a session cannot clear a grant');
    assert.deepEqual(tcc,[]);
    const reset=await post('synthetic-admin',{action:'reset-permission'});assert.equal(reset.status,200);
    assert.deepEqual((await reset.json()).reset,['Accessibility','ScreenCapture']);
    assert.deepEqual(tcc.map(c=>c[2]),['Accessibility','ScreenCapture']);
    assert.deepEqual(statusCalls,[true],'macOS is asked again right after the reset');
  }finally{router.stopped=true;approvals.cancel();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(temp,{recursive:true,force:true});}
});
