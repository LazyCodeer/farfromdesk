import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,writeFileSync,readFileSync,rmSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureFfd,runFfd,replyCheck } from '../src/ffd.js';
import { scopedBridgeCommand } from '../src/reply-args.js';

test('ffd launcher runs the scoped bridge CLI for its own session, and the skill names it',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-launch-'));
  try {
    const cli=join(dir,'cli.js'),state=join(dir,"state's");
    writeFileSync(cli,'console.log(JSON.stringify({state:process.env.WSB_STATE_DIR,port:process.env.WSB_PORT,args:process.argv.slice(2)}))');
    const files=ensureFfd(join(dir,'home'),state,'master-1',scopedBridgeCommand(process.execPath,cli,state,'47839'),[join(dir,'support/.claude/skills/farfromdesk')]);
    assert.equal(statSync(files.ffd).mode&0o777,0o700);
    const out=JSON.parse(execFileSync(files.ffd,['reply','tg:1','final',"it's done"],{encoding:'utf8',env:{...process.env,WSB_STATE_DIR:'/wrong'}}));
    assert.deepEqual(out,{state,port:'47839',args:['ffd','master-1','reply','tg:1','final',"it's done"]});
    assert.ok(readFileSync(files.skill,'utf8').includes(`FFD below is ${files.ffd}`));
    assert.equal(readFileSync(join(dir,'support/.claude/skills/farfromdesk/SKILL.md'),'utf8'),readFileSync(files.skill,'utf8'));
    const worker=ensureFfd(join(dir,'home'),state,'worker-1','true',[],false);
    assert.doesNotMatch(readFileSync(worker.skill,'utf8'),/ffd ask|FFD ask|FFD send|FFD mac/);assert.match(readFileSync(worker.skill,'utf8'),/FFD reply REQ final/);
    assert.throws(()=>ensureFfd(dir,state,'../x','true'),/Invalid/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('ffd commands map to bridge calls with content-derived event IDs',async()=>{
  const calls:any[]=[];
  const call=async(path:string,data?:any)=>{calls.push({path,data});
    if(path==='/api/master/delegate')return {requestId:'master:x'};
    if(path==='/api/master/selected')return {sessions:[{id:'b1',alias:'codex-a',name:'Website redesign'},{id:'b2',alias:'codex-b',name:'Docs'}]};
    if(path.startsWith('/api/master/sessions'))return {text:'Codex\n1. Website redesign'};
    if(path==='/api/master/coordinators')return {coordinators:[{bindingId:'me',provider:'codex',name:'Codex coordinator',state:'connected'}]};
    return {};};
  const none=()=>'';
  await runFfd(['reply','tg:1','progress','Checking'],{id:'me'},call,none);
  await runFfd(['reply','tg:1','progress','Checking'],{id:'me'},call,none);
  assert.equal(calls[0].data.eventId,calls[1].data.eventId);
  await runFfd(['ask','claude','tg:1','Status of 2207?'],{id:'me'},call,none);
  assert.equal(calls[2].data.coordinatorId,'claude');assert.match(calls[2].data.eventId,/^ask-/);
  await runFfd(['send','tg:1','website redesign','Run tests'],{id:'me'},call,none);
  assert.deepEqual(calls.at(-1).data.targets,['b1']);
  await assert.rejects(runFfd(['send','tg:1','Unknown','x'],{id:'me'},call,none),/not connected/);
  assert.match(await runFfd(['sessions'],{id:'me'},call,none),/No Claude proxy is set up/);
  assert.equal(await runFfd(['reply','tg:1','final'],{id:'me'},call,()=>'From stdin').then(()=>calls.at(-1).data.text),'From stdin');
  await assert.rejects(runFfd(['reply','tg:1','final'],{id:'me'},call,()=>'  '),/empty/);
  await assert.rejects(runFfd(['reply','tg:1','done','x'],{id:'me'},call,none),/progress\|final/);
});

test('ffd Mac commands bind the request and refuse raw native targets or forged request IDs',async()=>{
  const calls:any[]=[];const call=async(path:string,data?:unknown)=>{calls.push({path,data});return {apps:[]};};
  await runFfd(['mac','tg:mac'],{id:'me'},call,()=>JSON.stringify({action:'discover'}));
  assert.deepEqual(calls,[{path:'/api/master/mac-control',data:{action:'discover',requestId:'tg:mac'}}]);
  await assert.rejects(runFfd(['mac','tg:mac'],{id:'me'},call,()=>JSON.stringify({action:'discover',requestId:'forged'})));
  await assert.rejects(runFfd(['mac','tg:mac'],{id:'me'},call,()=>JSON.stringify({action:'click',pid:3})));
  assert.equal(calls.length,1);
});

test('reply check warns about long, technical replies but never blocks them',async()=>{
  assert.equal(replyCheck('✅ *Export fixed*\n- Tests pass.\nNext: nothing.'),'');
  const out=replyCheck('Built at /Users/me/app with trusted=null — '+'x'.repeat(900));
  for(const w of [/characters/,/file path/,/key=value/,/dash/,/still sent/])assert.match(out,w);
  const calls:any[]=[];
  const r=await runFfd(['reply','tg:1','final','Staged at ~/Apps/Test.app'],{id:'me'},async(path,data)=>{calls.push(data);return {};},()=>'');
  assert.equal(calls.length,1);assert.match(r,/Queued.*\n.*file path/s);
});

test('structured reply choices validate before transport and retain payload',async()=>{
 const calls:any[]=[];const call=async(path:string,body:any)=>{calls.push({path,body});return {};};
 const payload={text:'Choose next',options:{choices:[{id:'a',label:'Inspect'},{id:'b',label:'Wait'}],expiresInSeconds:60}};
 await runFfd(['reply-options','request','progress'],{id:'session'},call,()=>JSON.stringify(payload));
 assert.deepEqual(calls[0].body.options,payload.options);
 await assert.rejects(runFfd(['reply-options','request','progress'],{id:'session'},call,()=>JSON.stringify({...payload,options:{choices:[]}})));
 assert.equal(calls.length,1);
});
