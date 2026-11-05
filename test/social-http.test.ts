import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {get,request} from 'node:http';
import {randomUUID} from 'node:crypto';

test('social rejects session and browser requests; even admin cannot enable provider or publication actions',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ffd-social-http-'));const probe=createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as any).port;await new Promise<void>(r=>probe.close(()=>r()));
 process.env.WSB_STATE_DIR=root;process.env.WSB_PORT=String(port);process.env.FFD_ISOLATED_LOCAL='1';
 const [{Store},{Router},{Approvals},{serve}]=await Promise.all([import('../src/store.js'),import('../src/router.js'),import('../src/approvals.js'),import('../src/server.js')]);
 const store=new Store(':memory:'),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,new Approvals(store));const worker=store.register('worker','codex',randomUUID(),'/tmp');
 const server=serve(store,router,{} as any,'synthetic-admin',{macControl:{view:()=>({}),stop:()=>{}}} as any);await new Promise<void>(r=>server.once('listening',r));const url=`http://127.0.0.1:${port}`;
 const post=(d:any,headers:Record<string,string>={})=>fetch(url+'/api/social',{method:'POST',headers:{authorization:'Bearer synthetic-admin','content-type':'application/json',...headers},body:JSON.stringify(d)});
 try{
  assert.equal((await post({op:'create',brief:'no'},{authorization:`Bearer ${worker.token}`,'x-binding-id':worker.binding.id})).status,403);
  assert.equal((await post({op:'create',brief:'no'},{origin:url})).status,400);
  const c=await post({op:'create',brief:'synthetic'});assert.equal(c.status,200);const d=(await c.json() as any).result;
  for(const op of ['account','remove-account','research','draft','image','prepare','check','review','publish']){const res=await post({op,id:d.id,revision:d.revision,accountId:'123456',token:'synthetic-token',confirmed:true,challenge:'invented'});assert.equal(res.status,403,op);}
  assert.equal(existsSync(join(root,'social-instagram.json')),false);
  const begin=await post({op:'begin',id:d.id,revision:d.revision,kind:'draft'});assert.equal(begin.status,200);const operation=(await begin.json() as any).result;
  const payload=Buffer.from(JSON.stringify({id:d.id,operationId:operation.operationId,result:{text:'नमस्ते 🌿'}}));const split=payload.indexOf(Buffer.from('🌿'))+1;
  const saved=await new Promise<{status:number;body:string}>((resolve,reject)=>{const req=request(url+'/api/social/result',{method:'POST',agent:false,headers:{authorization:'Bearer synthetic-admin','content-type':'application/json'}},res=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode??0,body:Buffer.concat(chunks).toString('utf8')}));});req.on('error',reject);req.write(payload.subarray(0,split));setTimeout(()=>req.end(payload.subarray(split)),10);});
  assert.equal(saved.status,200);const revised=JSON.parse(saved.body).result;assert.equal(revised.caption,'नमस्ते 🌿');
  const receipt=await fetch(url+`/api/social?id=${encodeURIComponent(d.id)}&receipt=${encodeURIComponent(operation.operationId)}`,{headers:{authorization:'Bearer synthetic-admin'}});assert.equal((await receipt.json() as any).receipt.status,'completed');d.revision=revised.revision;
  assert.equal((await post({op:'delete',id:d.id,revision:d.revision})).status,400);assert.equal((await post({op:'delete',id:d.id,revision:d.revision,confirmed:true})).status,200);
  await new Promise<void>(r=>server.close(()=>r()));process.env.FFD_ISOLATED_LOCAL='0';
  const main=serve(store,router,{} as any,'synthetic-admin',{macControl:{view:()=>({}),stop:()=>{}}} as any);await new Promise<void>(r=>main.once('listening',r));
  try{const status=await new Promise<number>((resolve,reject)=>{get(url+'/api/social',{agent:false,headers:{authorization:'Bearer synthetic-admin'}},r=>{r.resume();resolve(r.statusCode??0);}).on('error',reject);});assert.equal(status,200);}finally{await new Promise<void>(r=>main.close(()=>r()));}
 }finally{if(server.listening)await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(root,{recursive:true,force:true});}
});
