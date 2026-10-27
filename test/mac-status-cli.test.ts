import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('mac-status asks the existing backend for a fresh nonprompting check only',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-mac-status-cli-')),calls:unknown[]=[];
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    calls.push({method:req.method,path:req.url,body:JSON.parse(body)});
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({enabled:true,trusted:false,error:null}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const port=(server.address() as any).port;
  const env={...process.env,WSB_STATE_DIR:dir,WSB_PORT:String(port)};
  const args=['--import','tsx',fileURLToPath(new URL('../src/cli.ts',import.meta.url)),'mac-status'];
  try {
    const result=await promisify(execFile)(process.execPath,args,{env});
    assert.equal(JSON.parse(result.stdout).trusted,false);
    assert.deepEqual(calls,[{method:'POST',path:'/api/mac-control',body:{action:'check'}}]);
    await assert.rejects(promisify(execFile)(process.execPath,[...args,'permission'],{env}),/without arguments/);
    assert.equal(calls.length,1,'unsupported arguments cannot request permission or control');
  }finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});

test('request-events reads only the exact encoded request through the backend',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-request-events-cli-')),calls:unknown[]=[];
  const server=createServer((req,res)=>{
    calls.push({method:req.method,path:req.url});res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({events:[{event:'uncertain'}],deliveries:[]}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const env={...process.env,WSB_STATE_DIR:dir,WSB_PORT:String((server.address() as any).port)};
  const args=['--import','tsx',fileURLToPath(new URL('../src/cli.ts',import.meta.url)),'request-events'];
  try {
    const result=await promisify(execFile)(process.execPath,[...args,'tg:test?other=1'],{env});
    assert.equal(JSON.parse(result.stdout).events[0].event,'uncertain');
    assert.deepEqual(calls,[{method:'GET',path:'/api/request-events?id=tg%3Atest%3Fother%3D1'}]);
    await assert.rejects(promisify(execFile)(process.execPath,args,{env}),/request-events REQUEST-ID/);
    assert.equal(calls.length,1);
  }finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});
