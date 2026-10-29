import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Writable} from 'node:stream';
import {once} from 'node:events';
import {smokeFetch,stopSmokeApp} from '../smoke_runtime.mjs';
import {runSupervisedSmoke} from '../smoke_supervisor.mjs';

test('native smoke times out both stalled headers and stalled response bodies',async()=>{
  const server=createServer((req,res)=>{if(req.url==='/body'){res.writeHead(200);res.write('{');}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const url=`http://127.0.0.1:${server.address().port}`;
    await assert.rejects(smokeFetch(url,{},100));
    const body=await smokeFetch(url+'/body',{},100);
    await assert.rejects(body.json());
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('native smoke cleanup terminates a GUI that ignores SIGTERM',{skip:process.platform==='win32',timeout:5000},async()=>{
  const app=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],{detached:true,stdio:['ignore','pipe','ignore']});
  try {
    await once(app.stdout,'data');
    const exited=once(app,'exit');
    await stopSmokeApp(app,100);
    const [,signal]=await exited;
    assert.equal(signal,'SIGKILL');
  } finally {try{process.kill(-app.pid,'SIGKILL');}catch{}}
});


test('explicit shutdown cancellation remains effective alongside the smoke deadline',async()=>{
  const server=createServer(()=>{});server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const controller=new AbortController();setTimeout(()=>controller.abort(),50);
    const start=Date.now();await assert.rejects(smokeFetch(`http://127.0.0.1:${server.address().port}`,{signal:controller.signal},3000));
    assert.ok(Date.now()-start<1500,'caller cancellation must not be replaced by the longer default');
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('supervisor preserves the smoke worker result and output',async()=>{
  let captured='';const sink=new Writable({write(chunk,_encoding,done){captured+=chunk;done();}});
  const result=await runSupervisedSmoke(process.execPath,['-e',"console.log('real worker output')"],{deadlineMs:3000,stdout:sink,stderr:sink});
  assert.equal(result,0);assert.match(captured,/real worker output/);
});

test('independent supervisor terminates a worker whose event loop blocks', {timeout:5000}, async()=>{
  let captured='';const sink=new Writable({write(chunk,_encoding,done){captured+=chunk;done();}});
  const before=Date.now();
  const result=await runSupervisedSmoke(process.execPath,['-e',"process.send({type:'phase',name:'simulated blocked setup'}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20000)"],{deadlineMs:700,stdout:sink,stderr:sink});
  assert.equal(result,124);assert.ok(Date.now()-before<3500);assert.match(captured,/simulated blocked setup/);
});

test('supervisor fails and returns when a detached descendant keeps stdout open', {skip:process.platform==='win32',timeout:7000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-supervisor-test-')),pidFile=join(dir,'pid');let pid;
  let captured='';const sink=new Writable({write(chunk,_encoding,done){captured+=chunk;done();}});
  try {
    const worker=`const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const app=spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{detached:true,stdio:'inherit'});writeFileSync(${JSON.stringify(pidFile)},String(app.pid));process.send({type:'app-started',pid:app.pid});setTimeout(()=>process.exit(0),300);`;
    const before=Date.now();
    const result=await runSupervisedSmoke(process.execPath,['-e',worker],{deadlineMs:3500,pipeGraceMs:300,stdout:sink,stderr:sink});
    pid=Number(readFileSync(pidFile,'utf8'));assert.equal(result,1);assert.ok(Date.now()-before<2500);assert.match(captured,/output pipes remained open/);
    // SIGKILL can leave a briefly unreaped zombie; that is no longer a running process.
    for(let i=0;i<30;i++) {
      const p=spawnSync('ps',['-p',String(pid),'-o','stat='],{encoding:'utf8'});
      if(p.status!==0||p.stdout.trim().startsWith('Z'))return;
      await new Promise(r=>setTimeout(r,50));
    }
    assert.fail('detached smoke app remained alive after supervisor cleanup');
  } finally {if(pid)try{process.kill(-pid,'SIGKILL');}catch{}rmSync(dir,{recursive:true,force:true});}
});


test('a blocked smoke worker and its verified detached app are both terminated on deadline', {skip:process.platform==='win32',timeout:7000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-supervisor-blocked-')),pidFile=join(dir,'pid');let pid;
  let captured='';const sink=new Writable({write(chunk,_encoding,done){captured+=chunk;done();}});
  try {
    const worker=`const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const app=spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{detached:true,stdio:'inherit'});writeFileSync(${JSON.stringify(pidFile)},String(app.pid));process.send({type:'app-started',pid:app.pid});setTimeout(()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20000),300);`;
    const result=await runSupervisedSmoke(process.execPath,['-e',worker],{deadlineMs:1000,stdout:sink,stderr:sink});
    pid=Number(readFileSync(pidFile,'utf8'));assert.equal(result,124);assert.match(captured,/supervisor exceeded/);
    for(let i=0;i<30;i++) {
      const p=spawnSync('ps',['-p',String(pid),'-o','stat='],{encoding:'utf8'});
      if(p.status!==0||p.stdout.trim().startsWith('Z'))return;
      await new Promise(r=>setTimeout(r,50));
    }
    assert.fail('detached smoke app survived the independent timeout');
  } finally {if(pid)try{process.kill(-pid,'SIGKILL');}catch{}rmSync(dir,{recursive:true,force:true});}
});


test('unread log output cannot keep the supervisor alive past its deadline', {timeout:8000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-supervisor-backpressure-')),pidFile=join(dir,'worker-pid');let workerPid;
  const moduleUrl=new URL('../smoke_supervisor.mjs',import.meta.url).href;
  const worker=`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));const b='x'.repeat(65536);function write(){while(process.stdout.write(b)){}process.stdout.once('drain',write)}write();`;
  const harness=`import {runSupervisedSmoke} from ${JSON.stringify(moduleUrl)};const code=await runSupervisedSmoke(process.execPath,['-e',${JSON.stringify(worker)}],{deadlineMs:1200});process.exitCode=code;setTimeout(()=>process.exit(code),250);`;
  // Intentionally never read stdout: this reproduces a stalled CI log consumer.
  const parent=spawn(process.execPath,['--input-type=module','-e',harness],{stdio:['ignore','pipe','pipe']});let diagnostic='';parent.stderr.on('data',chunk=>diagnostic+=chunk);
  try {
    const [code]=await Promise.race([once(parent,'exit'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('supervisor remained blocked by stdout')),4500))]);
    assert.equal(code,124);assert.match(diagnostic,/output was truncated/);assert.match(diagnostic,/supervisor exceeded/);
  } finally {
    parent.stdout.destroy();parent.stderr.destroy();parent.kill('SIGKILL');
    try{workerPid=Number(readFileSync(pidFile,'utf8'));if(process.platform!=='win32')process.kill(-workerPid,'SIGKILL');else spawnSync('taskkill',['/pid',String(workerPid),'/T','/F'],{stdio:'ignore',timeout:2000});}catch{}
    rmSync(dir,{recursive:true,force:true});
  }
});

test('deadline requests authenticated shutdown of the separate detached smoke backend', {skip:process.platform==='win32',timeout:9000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-native-smoke-')),guiFile=join(dir,'gui-pid'),backendFile=join(dir,'backend-pid');let guiPid,backendPid;
  let captured='';const sink=new Writable({write(chunk,_encoding,done){captured+=chunk;done();}});
  const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const fakeBackend=`const http=require('node:http'),fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(dir,'admin-token'))},'synthetic');fs.writeFileSync(${JSON.stringify(backendFile)},String(process.pid));http.createServer((req,res)=>{if(req.headers.authorization!=='Bearer synthetic'){res.writeHead(401);return res.end();}if(req.url==='/api/health'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({app:'FarFromDesk',protocol:1,pid:process.pid}));}if(req.url==='/api/shutdown'){res.end('{}');setTimeout(()=>process.exit(0),10);return;}res.writeHead(404);res.end();}).listen(${port},'127.0.0.1');`;
  const fakeGui=`const {spawn}=require('node:child_process');const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(guiFile)},String(process.pid));spawn(process.execPath,['-e',${JSON.stringify(fakeBackend)}],{detached:true,stdio:'inherit'}).unref();setInterval(()=>{},1000);`;
  const worker=`const {spawn}=require('node:child_process');process.send({type:'backend-info',state:${JSON.stringify(dir)},port:${port}});const app=spawn(process.execPath,['-e',${JSON.stringify(fakeGui)}],{detached:true,stdio:'inherit'});process.send({type:'app-started',pid:app.pid});setTimeout(()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20000),300);`;
  try {
    const result=await runSupervisedSmoke(process.execPath,['-e',worker],{deadlineMs:1300,stdout:sink,stderr:sink});
    guiPid=Number(readFileSync(guiFile,'utf8'));backendPid=Number(readFileSync(backendFile,'utf8'));
    assert.equal(result,124);assert.match(captured,/requested shutdown of its authenticated isolated backend/);
    for(let i=0;i<40;i++) {
      const states=[guiPid,backendPid].map(pid=>spawnSync('ps',['-p',String(pid),'-o','stat='],{encoding:'utf8'}));
      if(states.every(p=>p.status!==0||p.stdout.trim().startsWith('Z')))return;
      await new Promise(r=>setTimeout(r,50));
    }
    assert.fail('the smoke GUI or isolated backend survived timeout cleanup');
  } finally {for(const pid of [guiPid,backendPid])if(pid)try{process.kill(-pid,'SIGKILL');}catch{}rmSync(dir,{recursive:true,force:true});}
});


test('timeout never shuts down an unrelated service on the smoke port', {timeout:7000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-native-smoke-'));writeFileSync(join(dir,'admin-token'),'synthetic');let shutdowns=0;
  const server=createServer((req,res)=>{if(req.url==='/api/shutdown')shutdowns++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({app:'Unrelated',protocol:1,pid:process.pid}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  let captured='';const sink=new Writable({write(chunk,_encoding,done){captured+=chunk;done();}});
  try {
    const worker=`process.send({type:'backend-info',state:${JSON.stringify(dir)},port:${server.address().port}});setTimeout(()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20000),150);`;
    const result=await runSupervisedSmoke(process.execPath,['-e',worker],{deadlineMs:600,stdout:sink,stderr:sink});
    assert.equal(result,124);assert.equal(shutdowns,0);assert.match(captured,/could not verify backend cleanup/);
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});


for(const exitCode of [0,1])test(`smoke worker exit ${exitCode} cleans its detached backend and never grants unproved success`, {skip:process.platform==='win32',timeout:9000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-native-smoke-')),pidFile=join(dir,'backend-pid');let backendPid;
  let captured='';const sink=new Writable({write(chunk,_encoding,done){captured+=chunk;done();}});
  const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const backend=`const http=require('node:http'),fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(dir,'admin-token'))},'synthetic');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));http.createServer((req,res)=>{if(req.headers.authorization!=='Bearer synthetic'){res.writeHead(401);return res.end();}if(req.url==='/api/health'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({app:'FarFromDesk',protocol:1,pid:process.pid}));}if(req.url==='/api/shutdown'){res.end('{}');setTimeout(()=>process.exit(0),10);return;}res.writeHead(404);res.end();}).listen(${port},'127.0.0.1');`;
  const worker=`const {spawn}=require('node:child_process');process.send({type:'backend-info',state:${JSON.stringify(dir)},port:${port}});spawn(process.execPath,['-e',${JSON.stringify(backend)}],{detached:true,stdio:'ignore'}).unref();setTimeout(()=>process.exit(${exitCode}),500);`;
  try {
    const result=await runSupervisedSmoke(process.execPath,['-e',worker],{deadlineMs:4000,stdout:sink,stderr:sink});
    backendPid=Number(readFileSync(pidFile,'utf8'));
    assert.equal(result,1);assert.match(captured,/requested shutdown of its authenticated isolated backend/);
    if(exitCode===0)assert.match(captured,/did not confirm its isolated backend exited/);
    for(let i=0;i<40;i++) {
      const p=spawnSync('ps',['-p',String(backendPid),'-o','stat='],{encoding:'utf8'});
      if(p.status!==0||p.stdout.trim().startsWith('Z'))return;
      await new Promise(r=>setTimeout(r,50));
    }
    assert.fail('detached backend survived after the worker closed');
  } finally {if(backendPid)try{process.kill(-backendPid,'SIGKILL');}catch{}rmSync(dir,{recursive:true,force:true});}
});

test('successful worker reports verified backend exit before success',async()=>{
  let captured='';const sink=new Writable({write(chunk,_encoding,done){captured+=chunk;done();}});
  const worker="process.send({type:'backend-info',state:'/synthetic/unused',port:50000});process.send({type:'backend-pid',pid:12345});process.send({type:'backend-exited',pid:12345});setTimeout(()=>process.exit(0),50)";
  const result=await runSupervisedSmoke(process.execPath,['-e',worker],{deadlineMs:3000,stdout:sink,stderr:sink});
  assert.equal(result,0);assert.doesNotMatch(captured,/did not confirm/);
});


test('real smoke worker and supervisor pass against a fully isolated synthetic packaged app', {skip:process.platform==='win32',timeout:20000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-supervisor-e2e-')),scriptDir=join(dir,'script'),temp=join(dir,'tmp');
  const guiPidFile=join(dir,'gui-pid'),backendPidFile=join(dir,'backend-pid');let guiPid,backendPid,wrapper;
  mkdirSync(scriptDir,{recursive:true});mkdirSync(temp,{recursive:true});
  for(const name of ['smoke_supervisor.mjs','smoke_desktop_app.mjs','smoke_runtime.mjs'])copyFileSync(new URL('../'+name,import.meta.url),join(scriptDir,name));
  const stage=join(dir,'build','desktop-release','stage');
  const guiPath=process.platform==='darwin'?join(stage,'FarFromDesk.app','Contents','MacOS','FarFromDesk'):join(stage,'FarFromDesk','farfromdesk');
  mkdirSync(join(guiPath,'..'),{recursive:true});
  const backend=`const http=require('node:http'),fs=require('node:fs'),path=require('node:path');const state=process.env.WSB_STATE_DIR,port=Number(process.env.WSB_PORT);fs.writeFileSync(path.join(state,'admin-token'),'only-synthetic-token');fs.writeFileSync(path.join(state,'smoke-ui-ready'),'ready');fs.writeFileSync(${JSON.stringify(backendPidFile)},String(process.pid));const names=['farfromdesk-coordinator','farfromdesk-worker'];const installation=names.map(name=>({installation:[0,1].map(i=>{const file=path.join(state,name+i);fs.writeFileSync(file,'First line: one emoji and a short native *bold* heading');return {status:'installed',path:file}})}));const server=http.createServer((req,res)=>{if(req.headers.authorization!=='Bearer only-synthetic-token'){res.writeHead(401);return res.end('{}')}res.setHeader('Content-Type','application/json');if(req.url==='/api/health')return res.end(JSON.stringify({app:'FarFromDesk',protocol:1,pid:process.pid}));if(req.url==='/api/status')return res.end(JSON.stringify({preferences:{backgroundEnabled:false},master:null,voice:{ready:false,download:{state:'needed'}}}));if(req.url==='/api/agents')return res.end(JSON.stringify({sync:{state:'complete'},agents:names.map(name=>({name})),installation}));if(req.url==='/api/shutdown'){res.end('{}');server.close(()=>process.exit(0));return;}res.writeHead(404);res.end('{}')});server.listen(port,'127.0.0.1');`;
  const gui=`#!/usr/bin/env node\nconst {spawn}=require('node:child_process'),fs=require('node:fs');fs.writeFileSync(${JSON.stringify(guiPidFile)},String(process.pid));spawn(process.execPath,['-e',${JSON.stringify(backend)}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000);`;
  writeFileSync(guiPath,gui,{mode:0o755});let output='';
  try {
    wrapper=spawn(process.execPath,['script/smoke_supervisor.mjs'],{cwd:dir,env:{...process.env,TMPDIR:temp},stdio:['ignore','pipe','pipe']});
    wrapper.stdout.on('data',chunk=>output+=chunk);wrapper.stderr.on('data',chunk=>output+=chunk);
    const [code]=await once(wrapper,'close');guiPid=Number(readFileSync(guiPidFile,'utf8'));backendPid=Number(readFileSync(backendPidFile,'utf8'));
    assert.equal(code,0,output);assert.match(output,/Native UI rendered/);assert.match(output,/checking isolated backend exited/);
    assert.doesNotMatch(output,/only-synthetic-token/);
  } finally {
    wrapper?.kill('SIGKILL');for(const pid of [guiPid,backendPid])if(pid)try{process.kill(-pid,'SIGKILL');}catch{}rmSync(dir,{recursive:true,force:true});
  }
});
