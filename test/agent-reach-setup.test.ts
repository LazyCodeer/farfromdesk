import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {managedAgentReach,setupAgentReach} from '../src/agent-reach-setup.js';
const posix=process.platform==='win32'?test.skip:test;

posix('explicit setup installs the fixed source into a private directory with scrubbed environment',async()=>{
  const root=mkdtempSync(join(tmpdir(),'reach-setup-')),uv=join(root,'fake-uv');
  writeFileSync(uv,`#!/bin/sh\nprintf '%s\\n' "$*" "$GH_TOKEN" > "$UV_TOOL_DIR/args"\nprintf '#!/bin/sh\\nexit 0\\n' > "$UV_TOOL_BIN_DIR/agent-reach"\nchmod 700 "$UV_TOOL_BIN_DIR/agent-reach"\n`);chmodSync(uv,0o700);
  const old=process.env.GH_TOKEN;process.env.GH_TOKEN='synthetic-never-inherit';
  try {
    assert.match(await setupAgentReach(root,{uv}),/installed/);
    const stage=readdirSync(join(root,'agent-reach')).find(s=>s.startsWith('install-'))!;
    const args=readFileSync(join(root,'agent-reach',stage,'tools','args'),'utf8');assert.match(args,/14c213405669414492bda0f8d52cc6531d062c45/);assert.doesNotMatch(args,/synthetic-never-inherit|setup/);assert.ok(managedAgentReach(root));
    assert.match(await setupAgentReach(root,{uv}),/already installed/);
    writeFileSync(managedAgentReach(root)!,'changed');assert.throws(()=>managedAgentReach(root),/incomplete or changed/);
    await assert.rejects(setupAgentReach(root,{uv}),/incomplete or changed/);
  }finally{if(old===undefined)delete process.env.GH_TOKEN;else process.env.GH_TOKEN=old;rmSync(root,{recursive:true,force:true});}
});
posix('setup refuses symlinked or non-private tool directories before running uv',async()=>{
  const root=mkdtempSync(join(tmpdir(),'reach-setup-')),target=mkdtempSync(join(tmpdir(),'reach-target-'));
  try{symlinkSync(target,join(root,'agent-reach'));await assert.rejects(setupAgentReach(root,{uv:'/does-not-exist'}),/private real directories/);}finally{rmSync(root,{recursive:true,force:true});rmSync(target,{recursive:true,force:true});}
});
posix('uv failures report failure and do not claim an installation',async()=>{
  const root=mkdtempSync(join(tmpdir(),'reach-setup-')),uv=join(root,'bad-uv');
  writeFileSync(uv,'#!/bin/sh\nexit 1\n');chmodSync(uv,0o700);
  try{await assert.rejects(setupAgentReach(root,{uv}),/setup failed/);}finally{rmSync(root,{recursive:true,force:true});}
});
posix('an incomplete setup is never discovered or treated as successful',async()=>{
  const root=mkdtempSync(join(tmpdir(),'reach-setup-')),uv=join(root,'bad-uv');
  writeFileSync(uv,'#!/bin/sh\nprintf "partial" > "$UV_TOOL_BIN_DIR/agent-reach"\nexit 1\n');chmodSync(uv,0o700);
  try{await assert.rejects(setupAgentReach(root,{uv}),/setup failed/);assert.throws(()=>managedAgentReach(root),/incomplete or changed/);}finally{rmSync(root,{recursive:true,force:true});}
});
posix('concurrent setup requests cannot share an install',async()=>{
  const root=mkdtempSync(join(tmpdir(),'reach-setup-')),uv=join(root,'slow-uv');
  writeFileSync(uv,'#!/bin/sh\nsleep 1\nprintf "#!/bin/sh\\nexit 0\\n" > "$UV_TOOL_BIN_DIR/agent-reach"\nchmod 700 "$UV_TOOL_BIN_DIR/agent-reach"\n');chmodSync(uv,0o700);
  try{const first=setupAgentReach(root,{uv});await assert.rejects(setupAgentReach(root,{uv}),/running or was interrupted/);assert.match(await first,/installed/);assert.ok(managedAgentReach(root));}finally{rmSync(root,{recursive:true,force:true});}
});
posix('parent termination kills installer descendants and leaves a fail-closed lock',async()=>{
  const root=mkdtempSync(join(tmpdir(),'reach-setup-')),uv=join(root,'slow-uv');
  writeFileSync(uv,'#!/bin/sh\ntouch "$UV_TOOL_DIR/started"\nsleep 2\ntouch "$UV_TOOL_DIR/finished"\n');chmodSync(uv,0o700);
  const module=new URL('../src/agent-reach-setup.ts',import.meta.url).href;
  const script=`import {setupAgentReach} from ${JSON.stringify(module)}; await setupAgentReach(${JSON.stringify(root)},{uv:${JSON.stringify(uv)}});`;
  const parent=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:process.cwd(),stdio:'ignore'});
  try {
    let stage='';for(let i=0;i<200;i++){const home=join(root,'agent-reach');if(existsSync(home)){stage=readdirSync(home).find(s=>s.startsWith('install-'))??'';if(stage&&existsSync(join(home,stage,'tools','started')))break;}await new Promise(r=>setTimeout(r,10));}
    assert.ok(stage);const dir=join(root,'agent-reach',stage,'tools');assert.ok(existsSync(join(dir,'started')));
    parent.kill('SIGKILL');await once(parent,'exit');await new Promise(r=>setTimeout(r,2400));
    assert.equal(existsSync(join(dir,'finished')),false);assert.ok(existsSync(join(root,'agent-reach','setup.lock')));assert.throws(()=>managedAgentReach(root),/incomplete or changed/);
    await assert.rejects(setupAgentReach(root,{uv}),/running or was interrupted/);
  }finally{try{parent.kill('SIGKILL');}catch{}rmSync(root,{recursive:true,force:true});}
});
posix('setup stops installer descendants before reporting success',async()=>{
  const root=mkdtempSync(join(tmpdir(),'reach-setup-')),uv=join(root,'background-uv'),marker=join(root,'unexpected');
  writeFileSync(uv,`#!/bin/sh\n(sleep 2; touch '${marker}') &\nprintf '#!/bin/sh\\nexit 0\\n' > "$UV_TOOL_BIN_DIR/agent-reach"\nchmod 700 "$UV_TOOL_BIN_DIR/agent-reach"\n`);chmodSync(uv,0o700);
  try{assert.match(await setupAgentReach(root,{uv}),/installed/);await new Promise(r=>setTimeout(r,2300));assert.equal(existsSync(marker),false);}finally{rmSync(root,{recursive:true,force:true});}
});
posix('the supervisor deadline stops a slow installation',async()=>{
  const root=mkdtempSync(join(tmpdir(),'reach-setup-')),uv=join(root,'slow-uv'),marker=join(root,'unexpected');
  writeFileSync(uv,`#!/bin/sh\nsleep 2\ntouch '${marker}'\n`);chmodSync(uv,0o700);
  try{await assert.rejects(setupAgentReach(root,{uv,timeoutMs:150}),/failed or timed out/);await new Promise(r=>setTimeout(r,2200));assert.equal(existsSync(marker),false);assert.throws(()=>managedAgentReach(root),/incomplete or changed/);}finally{rmSync(root,{recursive:true,force:true});}
});
