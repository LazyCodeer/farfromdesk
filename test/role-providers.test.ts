import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Approvals } from '../src/approvals.js';
import { updateRole } from '../src/roles.js';
import { ClaudeSDKSession } from '../src/claude-sdk-session.js';
import { ClaudeSession } from '../src/claude-session.js';

const dir=mkdtempSync(join(tmpdir(),'ffd-provider-')),log=join(dir,'requests.jsonl'),fake=join(dir,'codex');
const id='11111111-1111-4111-a111-111111111111';
writeFileSync(fake,`#!${process.execPath}
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');
 if(m.method==='config/read')send({id:m.id,result:{config:{model_provider:'openai'}}});
 else if(m.method==='thread/resume')send({id:m.id,result:{thread:{id:'${id}',cwd:process.cwd()}}});
 else if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn-1'}}});send({method:'item/completed',params:{threadId:'${id}',turnId:'turn-1',item:{type:'agentMessage',text:'Done',phase:'final_answer'}}});send({method:'turn/completed',params:{threadId:'${id}',turn:{id:'turn-1',status:'completed'}}});}
 else send({id:m.id,result:{}});
});`,{mode:0o700});
process.env.WSB_STATE_DIR=dir;process.env.WSB_CODEX_BIN=fake;
const { NativeAgents }=await import('../src/native.js');
const { Masters }=await import('../src/masters.js');
const { Connections }=await import('../src/connections.js');
test.after(()=>rmSync(dir,{recursive:true,force:true}));

test('managed Codex restores persistent role on connection, sends native image plus minimal turns, and updates once per version',async()=>{
  const store=new Store(':memory:'),approvals=new Approvals(store),native=new NativeAgents(store,approvals),router=new Router(store,native,approvals),masters=new Masters(store,router);
  native.connections=new Connections(store,async()=>({state:"verified",label:"Test account",accountKey:"test"}));masters.connections=native.connections;
  native.managedRun=(...args)=>masters.run(...args);
  try {
    const b=store.register('worker','codex',id,dir).binding;store.set('whatsapp-owner','123@s.whatsapp.net');store.set(`managed-codex:${b.id}`,'true');
    await native.connections.choose(b,'cli',true);
    const data=Buffer.from([137,80,78,71,13,10,26,10]);
    store.enqueue('wa:image',b,'Explain this image');router.attachments.stage(b,'wa:image',{filename:'diagram.png',kind:'image',data,sha256:createHash('sha256').update(data).digest('hex')});
    await native.run(b,'Explain this image','wa:image');
    store.enqueue('wa:next',b,'Next task');await native.run(b,'Next task','wa:next');
    let requests=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    const resumes=requests.filter(r=>r.method==='thread/resume'),turns=requests.filter(r=>r.method==='turn/start');
    assert.equal(resumes.length,1);assert.match(resumes[0].params.developerInstructions,/friendly, calm companion/);
    assert.equal(turns.length,2);assert.equal(turns[0].params.input[1].type,'localImage');
    assert.equal(turns[1].params.input.length,1);assert.match(turns[1].params.input[0].text,/Next task/);
    assert.doesNotMatch(turns[1].params.input[0].text,/role bootstrap|friendly, calm companion|Explain this image/);
    updateRole(store,b,'professional');store.enqueue('wa:style',b,'New style');await native.run(b,'New style','wa:style');
    requests=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(requests.filter(r=>r.method==='thread/resume').length,2);assert.match(requests.filter(r=>r.method==='thread/resume')[1].params.developerInstructions,/concise and professional/);
    assert.equal(store.job('wa:image')?.status,'completed');
  }finally{masters.close();native.close();approvals.cancel();store.close();}
});

test('Claude public SDK appends persistent instructions to native preset and uses structured image inputs',async()=>{
  const calls:any[]=[];
  const queryFactory=((args:any)=>{
    calls.push(args);
    const iterable=(async function*(){yield {type:'result',subtype:'success',is_error:false,session_id:id,result:'Image reviewed',usage:{input_tokens:10,output_tokens:5}};})();
    return Object.assign(iterable,{close:()=>{}});
  }) as any;
  const session=new ClaudeSDKSession(process.execPath,dir,id,false,async()=>false,{},queryFactory,'Current role: concise, native permissions remain.');
  try {
    const image={type:'image',source:{type:'base64',media_type:'image/png',data:'iVBORw0KGgo='}};
    await session.run('Explain the image',[image]);
    assert.deepEqual(calls[0].options.systemPrompt,{type:'preset',preset:'claude_code',append:'Current role: concise, native permissions remain.',snapshot:false});
    const content=[];for await(const m of calls[0].prompt)content.push(m);
    assert.equal(content[0].session_id,id);assert.deepEqual(content[0].message.content,[{type:'text',text:'Explain the image'},image]);
    await session.run('Next task');assert.equal(calls[1].prompt,'Next task');assert.equal(calls[1].options.resume,id);assert.equal(calls[1].options.forkSession,false);
    assert.deepEqual(session.lastUsage,{inputTokens:10,outputTokens:5});
  }finally{session.close();}
});

test('Claude stdio initializes version-safe prompt settings once and sends image blocks on the user turn',async()=>{
  const binary=join(dir,'claude'),capture=join(dir,'claude-capture.jsonl');
  writeFileSync(binary,`#!${process.execPath}
const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2)})+'\\n');
const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(capture)},line+'\\n');
if(m.type==='control_request')console.log(JSON.stringify({type:'control_response',response:{request_id:'initialize',subtype:'success'}}));
if(m.type==='user')console.log(JSON.stringify({type:'result',session_id:'${id}',subtype:'success',result:'Done',usage:{input_tokens:7,output_tokens:3}}));
});`,{mode:0o700});
  const session=new ClaudeSession(binary,dir,id,true,async()=>false,process.env,{instructions:'Professional role; preserve native permissions.'});
  try {
    await session.initialize();await session.run('Latest task',[{type:'image',source:{type:'base64',media_type:'image/png',data:'iVBORw0KGgo='}}]);
    const rows=readFileSync(capture,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(rows[0].args.includes('--append-system-prompt'));assert.ok(rows[0].args.includes('--system-prompt-snapshot'));
    assert.equal(rows[1].request.systemPromptSnapshot,false);assert.equal(rows[2].message.content[0].text,'Latest task');assert.equal(rows[2].message.content[1].type,'image');
    assert.deepEqual(session.lastUsage,{inputTokens:7,outputTokens:3});
  }finally{session.close();}
});
