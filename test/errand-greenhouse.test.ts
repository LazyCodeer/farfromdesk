import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {request as httpsRequest} from 'node:https';
import {greenhouseBoardReader,greenhouseGet,greenhouseListingReader,publicGreenhouseAddress,requestPinned} from '../src/errand-greenhouse.js';
import {greenhousePageIdentity} from '../src/errand-greenhouse-page.js';
import type {ErrandScope} from '../src/errand-missions.js';

const scope:ErrandScope={requestId:'wa:test',owner:'owner',destination:'owner',bindingId:'test',bindingIdentity:'test'};
const input={jobs:[{board:'example',id:'12345'}]};
const api=()=>JSON.stringify({id:12345,title:'Flutter Engineer',location:{name:'Bangalore'},absolute_url:'https://job-boards.greenhouse.io/example/jobs/12345',application_deadline:'2099-12-31'});
const page=(extra='')=>`<!DOCTYPE html><html><head><title>Job Application for Flutter Engineer at Example</title><meta property="og:url" content="https://job-boards.greenhouse.io/example/jobs/12345?gh_jid=12345"/></head><body><h1 class="section-header other">Flutter Engineer</h1>${extra}<form id="application-form"></form></body></html>`;
function transport(options:{dns?:string[];status?:number;api?:string;page?:string;onRequest?:()=>void}={}){
  const calls:{host:string;path:string;address:string}[]=[];
  return {calls,resolve:async()=>options.dns??['8.8.8.8'],request:async(host:string,path:string,address:string)=>{
    calls.push({host,path,address});options.onRequest?.();
    return {status:options.status??200,body:host==='boards-api.greenhouse.io'?options.api??api():options.page??page(),contentType:host==='boards-api.greenhouse.io'?'application/json':'text/html'};
  }};
}
test('returns published evidence without claiming applications are open',async()=>{
  const fake=transport();const reader=greenhouseListingReader(()=>true,()=>1234,fake);
  const rows=await reader(scope,input,new AbortController().signal);
  assert.equal(rows.length,1);assert.equal(rows[0].url,'https://job-boards.greenhouse.io/example/jobs/12345');
  assert.equal(rows[0].verification,'public-listing-published');assert.equal(rows[0].workplace,'unknown');assert.ok(rows[0].applicationDeadline!>1234);
  assert.equal(rows[0].excerpt,'Flutter Engineer — Bangalore');
  assert.equal(rows[0].location,'Bangalore');
  assert.equal(rows[0].employer,'Example');
  assert.match(rows[0].sourceHash,/^[a-f0-9]{64}$/);
  assert.deepEqual(fake.calls,[{host:'boards-api.greenhouse.io',path:'/v1/boards/example/jobs/12345',address:'8.8.8.8'},{host:'job-boards.greenhouse.io',path:'/example/jobs/12345',address:'8.8.8.8'}]);
});
test('published metadata, a future deadline and an asserted open status do not alone prove applications remain open',async()=>{
  for(const fields of [
    {application_deadline:'2099-12-31',published:true},
    {application_deadline:'2099-12-31T23:59:59Z',status:'open'},
    {application_deadline:null,published:true},
  ]){
    const response=JSON.stringify({...JSON.parse(api()),...fields});
    const fake=transport({api:response,page:page('This position is closed and no longer accepting applications')});
    await assert.rejects(greenhouseListingReader(()=>true,()=>1234,fake)(scope,input,new AbortController().signal),/closed|deadline/);
  }
});
test('blocks private, special and IPv6 addresses before connection',async()=>{
  for(const address of ['127.0.0.1','10.1.2.3','169.254.169.254','100.64.1.1','192.168.1.1','198.18.1.1','224.0.0.1','::1','::ffff:127.0.0.1']){
    assert.equal(publicGreenhouseAddress(address),false);const fake=transport({dns:[address]});
    await assert.rejects(greenhouseGet('boards-api.greenhouse.io','/v1/boards/example/jobs/12345',new AbortController().signal,fake,()=>true),/unsafe address/);assert.equal(fake.calls.length,0);
  }
  const mixed=transport({dns:['8.8.8.8','10.0.0.1']});await assert.rejects(greenhouseGet('boards-api.greenhouse.io','/v1/boards/example/jobs/12345',new AbortController().signal,mixed,()=>true),/unsafe address/);assert.equal(mixed.calls.length,0);
});
test('rejects arbitrary hosts, query-bearing paths, redirects and oversized responses',async()=>{
  const fake=transport();for(const [host,path] of [['evil.example','/a'],['boards-api.greenhouse.io','/jobs?token=abc'],['boards-api.greenhouse.io','//evil.example/a'],['boards-api.greenhouse.io','/a/../b']])await assert.rejects(greenhouseGet(host,path,new AbortController().signal,fake,()=>true),/Invalid/);
  assert.equal(fake.calls.length,0);
  for(const status of [301,302,307,404,500])await assert.rejects(greenhouseGet('boards-api.greenhouse.io','/v1/boards/example/jobs/12345',new AbortController().signal,transport({status}),()=>true),/verified/);
  await assert.rejects(greenhouseGet('boards-api.greenhouse.io','/v1/boards/example/jobs/12345',new AbortController().signal,transport({api:'x'.repeat(512*1024+1)}),()=>true),/verified/);
});
test('rejects mismatched IDs, unsafe links, generic pages and malformed input',async()=>{
  const cases=[
    {api:JSON.stringify({id:999,title:'Flutter Engineer',absolute_url:'https://job-boards.greenhouse.io/example/jobs/12345'})},
    {api:JSON.stringify({...JSON.parse(api()),absolute_url:'https://job-boards.greenhouse.io/example/jobs/12345?token=private'})},
    {api:JSON.stringify({...JSON.parse(api()),absolute_url:'https://evil.example/example/jobs/12345'})},
    {api:JSON.stringify({...JSON.parse(api()),absolute_url:'https://job-boards.greenhouse.io/another/jobs/12345'})},
    {page:'<html>Sorry, job not found</html>'},
    {page:page('This position is closed and no longer accepting applications')},
    {page:page('This position is &#99;losed')},
    {page:page('This position is no longer available.')},
    {page:page('This job posting has been removed.')},
    {page:'<script>var id=12345;var title="Flutter Engineer";</script><h1>Sorry, we could not load this job.</h1>'},
  ];
  for(const value of cases)await assert.rejects(greenhouseListingReader(()=>true,()=>1234,transport(value))(scope,input,new AbortController().signal));
  const fake=transport(),reader=greenhouseListingReader(()=>true,()=>1234,fake);
  for(const invalid of [{jobs:[{board:'../private',id:'123'}]},{jobs:[{board:'sk-'+ 'a'.repeat(20),id:'123'}]},{jobs:[{board:'example',id:'1?token=private'}]},{jobs:Array(11).fill(input.jobs[0])}])await assert.rejects(reader(scope,invalid,new AbortController().signal));
  assert.equal(fake.calls.length,0);
});
test('location data with spoofing controls or oversized content is not used',async()=>{
  for(const name of ['Bangalore\u202eevil','Bangalore'+'.'.repeat(160)]){
    const fake=transport({api:JSON.stringify({...JSON.parse(api()),location:{name}})});
    await assert.rejects(greenhouseListingReader(()=>true,()=>1234,fake)(scope,input,new AbortController().signal),/location is invalid/);
  }
});
test('unusable page-title employer metadata is omitted rather than guessed',async()=>{
  for(const value of ['https://evil.example','Example\u202eevil','Example'.repeat(30),'person@example.test']){
    const fake=transport({page:page().replace('at Example','at '+value)});
    const [row]=await greenhouseListingReader(()=>true,()=>1234,fake)(scope,input,new AbortController().signal);
    assert.equal(row.employer,undefined);
  }
});
test('allows an absent deadline as distinct unverified evidence but rejects invalid or expired deadlines',async()=>{
  for(const value of [undefined,null]){
    const fake=transport({api:JSON.stringify({...JSON.parse(api()),application_deadline:value})});
    const [row]=await greenhouseListingReader(()=>true,()=>Date.parse('2026-01-01Z'),fake)(scope,input,new AbortController().signal);
    assert.equal(row.verification,'public-listing-published-no-deadline');assert.equal(row.applicationDeadline,undefined);
    assert.equal(fake.calls.length,2);
  }
  for(const value of ['','bad','2000-02-30','2000-01-01T00:00:00','2020-01-01T00:00:00+99:99','2000-01-01']){
    const fake=transport({api:JSON.stringify({...JSON.parse(api()),application_deadline:value})});
    await assert.rejects(greenhouseListingReader(()=>true,()=>Date.parse('2026-01-01Z'),fake)(scope,input,new AbortController().signal),/deadline/);
    assert.equal(fake.calls.length,1);
  }
  const boundary=Date.parse('2099-12-31T00:00:00Z');let time=boundary-1;
  const fake=transport({onRequest:()=>{if(fake.calls.length===2)time=boundary;}});
  await assert.rejects(greenhouseListingReader(()=>true,()=>time,fake)(scope,input,new AbortController().signal),/deadline/);
});
test('searches only the authorized board, matching role and location locally and verifying exact jobs',async()=>{
  const calls:{host:string;path:string}[]=[];
  const fake={resolve:async()=>['8.8.8.8'],request:async(host:string,path:string)=>{
    calls.push({host,path});
    if(path==='/v1/boards/example/jobs')return {status:200,contentType:'application/json',body:JSON.stringify({jobs:[
      {id:12345,title:'Flutter Engineer',location:{name:'Bangalore'}},{id:999,title:'Designer',location:{name:'Bangalore'}},{id:888,title:'Flutter Engineer',location:{name:'London'}},
    ]})};
    return {status:200,contentType:host==='boards-api.greenhouse.io'?'application/json':'text/html',body:host==='boards-api.greenhouse.io'?api():page()};
  }};
  const result=await greenhouseBoardReader(()=>true,()=>1234,fake)(scope,{board:'example',role:'Flutter',location:'Bangalore'},new AbortController().signal);
  assert.equal(result.length,1);assert.equal(result[0].verification,'public-listing-published');
  assert.deepEqual(calls.map(x=>x.path),['/v1/boards/example/jobs','/v1/boards/example/jobs/12345','/example/jobs/12345']);
  assert.ok(calls.every(x=>!x.path.includes('Flutter')&&!x.path.includes('Bangalore')&&!x.path.includes('?')));
});
test('board search does not turn a transport failure into an empty result',async()=>{
  const fake={resolve:async()=>['8.8.8.8'],request:async(_host:string,path:string)=>{
    if(path==='/v1/boards/example/jobs')return {status:200,contentType:'application/json',body:JSON.stringify({jobs:[{id:12345,title:'Flutter Engineer',location:{name:'Bangalore'}}]})};
    throw new Error('Synthetic network outage');
  }};
  await assert.rejects(greenhouseBoardReader(()=>true,()=>1234,fake)(scope,{board:'example',role:'Flutter',location:'Bangalore'},new AbortController().signal),/network outage/);
});
test('a listing whose role or location changed after board search is excluded',async()=>{
  for(const changed of [{title:'Other Role'},{location:{name:'London'}}]){
    const fake={resolve:async()=>['8.8.8.8'],request:async(host:string,path:string)=>{
      if(path==='/v1/boards/example/jobs')return {status:200,contentType:'application/json',body:JSON.stringify({jobs:[{id:12345,title:'Flutter Engineer',location:{name:'Bangalore'}}]})};
      return {status:200,contentType:host==='boards-api.greenhouse.io'?'application/json':'text/html',body:JSON.stringify({...JSON.parse(api()),...changed})};
    }};
    assert.deepEqual(await greenhouseBoardReader(()=>true,()=>1234,fake)(scope,{board:'example',role:'Flutter',location:'Bangalore'},new AbortController().signal),[]);
  }
});
test('recognizes only structural page identity, never script or error-page substrings',()=>{
  const match=(html:string)=>greenhousePageIdentity(html,'job-boards.greenhouse.io','example','12345','Flutter Engineer');
  assert.equal(match(page()),true);
  assert.equal(match(page().replace('gh_jid=12345','gh_jid=99999')),false);
  assert.equal(match(page().replace('/example/jobs/12345','/another/jobs/12345')),false);
  assert.equal(match(page().replace('Flutter Engineer</h1>','Other job</h1>')),false);
  assert.equal(match(page().replace('<form id="application-form">','<form id="application-form" hidden>')),false);
  assert.equal(match(page().replace('<h1 class="section-header other">','<h1 class="section-header other" style="display:none">')),false);
  for(const attr of ['hidden','aria-hidden="true"','style="display:none"','style="visibility:hidden"']){
    const withHiddenHeading=page().replace('<h1 class="section-header other">Flutter Engineer</h1>',`<div ${attr}><div><h1 class="section-header other">Flutter Engineer</h1></div></div><h1>Sorry, could not load this job</h1>`);
    const withHiddenForm=page().replace('<form id="application-form"></form>',`<div ${attr}><form id="application-form"></form></div>`);
    assert.equal(match(withHiddenHeading),false);assert.equal(match(withHiddenForm),false);
    const hiddenText=page().replace('Flutter Engineer</h1>',`<span ${attr}>Flutter Engineer</span></h1><p>Sorry, unable to load this job.</p>`);
    assert.equal(match(hiddenText),false);
  }
  assert.equal(match(page().replace('<h1 class="section-header other">','<div hidden/><h1 class="section-header other">')),false);
  for(const inert of ['template','textarea','iframe','object'])assert.equal(match(page().replace('<h1 class="section-header other">',`<${inert}/><h1 class="section-header other">`)),false);
  assert.equal(match(page().replace('<h1 class="section-header other">Flutter Engineer</h1>','<script>var x=`<h1 class="section-header">Flutter Engineer</h1>`</script><h1>Sorry, we could not load this job. 12345 Flutter Engineer</h1>')),false);
  assert.equal(match(page().replace('<form id="application-form"></form>','<script>var x=`<form id="application-form"></form>`</script>')),false);
  assert.equal(match(page().replace('</body>','<svg><g><svg><path d="M0 0"/></svg></g></svg><textarea>ignored &lt;text&gt;</textarea></body>')),true);
  assert.equal(match(page().replace('<h1 class="section-header other">Flutter Engineer</h1>','<template><template></template><h1 class="section-header">Flutter Engineer</h1></template>')),false);
  assert.equal(match(page().replace('<h1 class="section-header other">Flutter Engineer</h1>','<svg><text>Flutter Engineer</text></svg><h1>Sorry, could not load this job</h1>')),false);
  assert.equal(match(page().replace('<form id="application-form"></form>','<textarea><form id="application-form"></form></textarea>')),false);
  assert.equal(match(page().replace('</head>','<meta property="og:url" content="https://job-boards.greenhouse.io/example/jobs/12345"/></head>')),false);
  assert.equal(match(page().replace('<h1 class="section-header other">','<h1 class="section-header" class="section-header">')),false);
  assert.equal(match(page().replace('<h1 class="section-header other">','<div>'.repeat(129)+'<h1 class="section-header other">').replace('</h1>','</h1>'+'</div>'.repeat(129))),false);
  assert.equal(match(page()+' '.repeat(512*1024)),false);
});
test('does not start outbound HTTPS if owner scope changes during DNS',async()=>{
  let current=true,release!:(value:string[])=>void;
  const fake=transport();fake.resolve=()=>new Promise(resolve=>{release=resolve;});
  const pending=greenhouseListingReader(()=>current,()=>1234,fake)(scope,input,new AbortController().signal);
  current=false;release(['8.8.8.8']);
  await assert.rejects(pending,/owner request changed/);assert.equal(fake.calls.length,0);
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
  let pinned='';opts.lookup('boards.greenhouse.io',{},(_err:unknown,address:string)=>{pinned=address;});assert.equal(pinned,'');await new Promise<void>(resolve=>process.nextTick(resolve));assert.equal(pinned,'8.8.8.8');
  peer='127.0.0.1';await assert.rejects(get(),/address changed/);assert.equal(attempts[1].destroyed,true);
  peer='8.8.8.8';status=302;await assert.rejects(get(),/verified/);assert.equal(attempts[2].destroyed,true);
  status=200;body='x'.repeat(512*1024+1);await assert.rejects(get(),/too large/);assert.equal(attempts[3].destroyed,true);
});
test('pinned lookup is deferred so a denied socket rejects after error handlers are attached',async()=>{
  let returned=false;
  const fakeRequest=(opts:any)=>{
    const req:any=new EventEmitter();req.end=()=>{};
    opts.lookup('boards.greenhouse.io',{},()=>{
      assert.equal(returned,true);
      const error=Object.assign(new Error('Synthetic socket denied'),{code:'EPERM'});
      req.emit('error',error);
    });
    returned=true;return req;
  };
  await assert.rejects(requestPinned('boards.greenhouse.io','/example/jobs/12345','8.8.8.8',new AbortController().signal,fakeRequest as typeof httpsRequest),/Synthetic socket denied/);
});
