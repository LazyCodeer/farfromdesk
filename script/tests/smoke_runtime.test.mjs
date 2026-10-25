import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {smokeFetch,stopSmokeApp} from '../smoke_runtime.mjs';

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
