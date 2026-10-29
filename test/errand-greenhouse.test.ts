import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {request as httpsRequest} from 'node:https';
import {greenhouseGet,greenhouseListingReader,publicGreenhouseAddress,requestPinned} from '../src/errand-greenhouse.js';
import type {ErrandScope} from '../src/errand-missions.js';

const scope:ErrandScope={requestId:'wa:test',owner:'owner',destination:'owner',bindingId:'test',bindingIdentity:'test'};
const input={jobs:[{board:'example',id:'12345'}]};
const api=()=>JSON.stringify({id:12345,title:'Flutter Engineer',absolute_url:'https://job-boards.greenhouse.io/example/jobs/12345'});
function transport(options:{dns?:string[];status?:number;api?:string;page?:string;onRequest?:()=>void}={}){
  const calls:{host:string;path:string;address:string}[]=[];
  return {calls,resolve:async()=>options.dns??['8.8.8.8'],request:async(host:string,path:string,address:string)=>{
    calls.push({host,path,address});options.onRequest?.();
    return {status:options.status??200,body:host==='boards-api.greenhouse.io'?options.api??api():options.page??'<html>Flutter Engineer 12345</html>',contentType:host==='boards-api.greenhouse.io'?'application/json':'text/html'};
  }};
}
test('verifies exact Greenhouse IDs against API and matching public page without sending owner data',async()=>{
  const fake=transport();const reader=greenhouseListingReader(()=>true,()=>1234,fake);
  const rows=await reader(scope,input,new AbortController().signal);
  assert.equal(rows.length,1);assert.equal(rows[0].url,'https://job-boards.greenhouse.io/example/jobs/12345');
  assert.equal(rows[0].verification,'public-listing-verified');assert.equal(rows[0].workplace,'unknown');assert.match(rows[0].sourceHash,/^[a-f0-9]{64}$/);
  assert.deepEqual(fake.calls,[{host:'boards-api.greenhouse.io',path:'/v1/boards/example/jobs/12345',address:'8.8.8.8'},{host:'job-boards.greenhouse.io',path:'/example/jobs/12345',address:'8.8.8.8'}]);
});
test('blocks private, special and IPv6 addresses before connection',async()=>{
  for(const address of ['127.0.0.1','10.1.2.3','169.254.169.254','100.64.1.1','192.168.1.1','198.18.1.1','224.0.0.1','::1','::ffff:127.0.0.1']){
    assert.equal(publicGreenhouseAddress(address),false);const fake=transport({dns:[address]});
    await assert.rejects(greenhouseGet('boards-api.greenhouse.io','/v1/boards/example/jobs/12345',new AbortController().signal,fake),/unsafe address/);assert.equal(fake.calls.length,0);
  }
  const mixed=transport({dns:['8.8.8.8','10.0.0.1']});await assert.rejects(greenhouseGet('boards-api.greenhouse.io','/v1/boards/example/jobs/12345',new AbortController().signal,mixed),/unsafe address/);assert.equal(mixed.calls.length,0);
});
test('rejects arbitrary hosts, query-bearing paths, redirects and oversized responses',async()=>{
  const fake=transport();for(const [host,path] of [['evil.example','/a'],['boards-api.greenhouse.io','/jobs?token=abc'],['boards-api.greenhouse.io','//evil.example/a'],['boards-api.greenhouse.io','/a/../b']])await assert.rejects(greenhouseGet(host,path,new AbortController().signal,fake),/Invalid/);
  assert.equal(fake.calls.length,0);
  for(const status of [301,302,307,404,500])await assert.rejects(greenhouseGet('boards-api.greenhouse.io','/v1/boards/example/jobs/12345',new AbortController().signal,transport({status})),/verified/);
  await assert.rejects(greenhouseGet('boards-api.greenhouse.io','/v1/boards/example/jobs/12345',new AbortController().signal,transport({api:'x'.repeat(512*1024+1)})),/verified/);
});
test('rejects mismatched IDs, unsafe links, generic pages and malformed input',async()=>{
  const cases=[
    {api:JSON.stringify({id:999,title:'Flutter Engineer',absolute_url:'https://job-boards.greenhouse.io/example/jobs/12345'})},
    {api:JSON.stringify({id:12345,title:'Flutter Engineer',absolute_url:'https://job-boards.greenhouse.io/example/jobs/12345?token=private'})},
    {api:JSON.stringify({id:12345,title:'Flutter Engineer',absolute_url:'https://evil.example/example/jobs/12345'})},
    {api:JSON.stringify({id:12345,title:'Flutter Engineer',absolute_url:'https://job-boards.greenhouse.io/another/jobs/12345'})},
    {page:'<html>Sorry, job not found</html>'},
  ];
  for(const value of cases)await assert.rejects(greenhouseListingReader(()=>true,()=>1234,transport(value))(scope,input,new AbortController().signal));
  const fake=transport(),reader=greenhouseListingReader(()=>true,()=>1234,fake);
  for(const invalid of [{jobs:[{board:'../private',id:'123'}]},{jobs:[{board:'example',id:'1?token=private'}]},{jobs:Array(11).fill(input.jobs[0])}])await assert.rejects(reader(scope,invalid,new AbortController().signal));
  assert.equal(fake.calls.length,0);
});
test('stops after cancellation or an owner scope change',async()=>{
  let current=true;const fake=transport({onRequest:()=>{current=false;}});
  await assert.rejects(greenhouseListingReader(()=>current,()=>1234,fake)(scope,input,new AbortController().signal),/owner request changed/);assert.equal(fake.calls.length,1);
  const controller=new AbortController();controller.abort();const another=transport();
  await assert.rejects(greenhouseListingReader(()=>true,()=>1234,another)(scope,input,controller.signal),/owner request changed/);assert.equal(another.calls.length,0);
});
test('pinned HTTPS uses fixed SNI and validated lookup, rejects a changed peer and caps reads',async()=>{
  const attempts:{options:any;destroyed:boolean}[]=[];
  const fakeRequest=(opts:any,callback:(res:any)=>void)=>{
    const info={options:opts,destroyed:false};attempts.push(info);
    const req:any=new EventEmitter();req.destroy=(error?:Error)=>{info.destroyed=true;if(error)req.emit('error',error);};
    req.end=()=>queueMicrotask(()=>{
      const socket:any=new EventEmitter();socket.remoteAddress=peer;req.emit('socket',socket);socket.emit('secureConnect');
      if(info.destroyed)return;
      const res:any=new EventEmitter();res.statusCode=status;res.headers={'content-type':'text/html'};callback(res);
      if(!info.destroyed){res.emit('data',Buffer.from(body));res.emit('end');}
    });
    return req;
  };
  let peer='8.8.8.8',status=200,body='matching';
  const get=()=>requestPinned('boards.greenhouse.io','/example/jobs/12345','8.8.8.8',new AbortController().signal,fakeRequest as typeof httpsRequest);
  assert.equal((await get()).body,'matching');const opts=attempts[0].options;
  assert.equal(opts.hostname,'boards.greenhouse.io');assert.equal(opts.servername,'boards.greenhouse.io');assert.equal(opts.method,'GET');assert.equal(opts.agent,false);
  let pinned='';opts.lookup('boards.greenhouse.io',{},(_err:unknown,address:string)=>{pinned=address;});assert.equal(pinned,'8.8.8.8');
  peer='127.0.0.1';await assert.rejects(get(),/address changed/);assert.equal(attempts[1].destroyed,true);
  peer='8.8.8.8';status=302;await assert.rejects(get(),/verified/);assert.equal(attempts[2].destroyed,true);
  status=200;body='x'.repeat(512*1024+1);await assert.rejects(get(),/too large/);assert.equal(attempts[3].destroyed,true);
});
