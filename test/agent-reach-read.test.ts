import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {agentReachRead} from '../src/agent-reach.js';

const posix=process.platform==='win32'?test.skip:test;
posix('selected source reads use Exa, retain exact validated URL and reject redirects',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ffd-read-')),file=join(dir,'fake');
 const fake=(url:string)=>{const response=JSON.stringify({schema_version:1,ok:true,channel:'web',action:'read',backend:'exa',items:[{title:'Source',url,text:'Public text'}]});writeFileSync(file,`#!/bin/sh\n[ "$1 $2 $4 $5" = 'web read --backend exa' ] || exit 2\nprintf '%s' '${response}'\n`);chmodSync(file,0o700);};
 try{
  fake('https://example.com/');const ok=await agentReachRead('https://example.com/',()=>true,{executable:file});assert.equal(ok.status,'ok');if(ok.status==='ok')assert.equal(ok.sources[0].url,'https://example.com/');
  fake('https://127.0.0.1/admin');const redirected=await agentReachRead('https://example.com/',()=>true,{executable:file});assert.equal(redirected.status,'ok');if(redirected.status==='ok')assert.deepEqual(redirected.sources,[]);
  for(const url of ['http://example.com/','https://127.0.0.1/','https://localhost/','https://service.internal/','https://example.com/?token=secret','https://example.com/?X-Amz-Signature=abc','https://example.com/?X-Goog-Credential=abc','https://example.com/?sig=abc','https://example.com/#access_token=abc'])await assert.rejects(agentReachRead(url,()=>true,{executable:file}),/Invalid public source/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
posix('a provider block page is never treated as a successful read',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ffd-read-block-')),file=join(dir,'fake');
 const safe=JSON.stringify({schema_version:1,ok:true,channel:'web',action:'read',backend:'exa',items:[{title:'Page',url:'https://example.com/',text:'Please verify you are human to continue.'}]});
 writeFileSync(file,`#!/bin/sh\nprintf '%s' '${safe}'\n`);chmodSync(file,0o700);
 try{await assert.rejects(agentReachRead('https://example.com/',()=>true,{executable:file}),/did not allow/);}finally{rmSync(dir,{recursive:true,force:true});}
});
