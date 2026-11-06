import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {managedAgentReach,sddlAllowedSids,setupAgentReach,windowsArgument} from '../src/agent-reach-setup.js';
import {fakeWindowsProgram} from './windows-fake-exe.js';
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

// Windows: the same guarantees, driven through a real fake uv.exe (see windows-fake-exe.ts).
const windowsOnly=process.platform==='win32'?test:test.skip;
const fakeUv=(steps:string[])=>fakeWindowsProgram('uv',steps);
const stageOf=(root:string)=>readdirSync(join(root,'agent-reach')).find(s=>s.startsWith('install-'))!;
windowsOnly('Windows setup installs the fixed source into a private folder with a scrubbed environment',async()=>{
  const root=mkdtempSync(join(tmpdir(),'reach-setup-')),uv=fakeUv(['log=%UV_TOOL_DIR%\\env','install=1']);
  const old=process.env.GH_TOKEN;process.env.GH_TOKEN='synthetic-never-inherit';
  try {
    assert.match(await setupAgentReach(root,{uv:uv.file}),/installed/);
    const stage=join(root,'agent-reach',stageOf(root)),env=readFileSync(join(stage,'tools','env'),'utf8');
    assert.match(env,/ARGS=tool install git\+https:\/\/github\.com\/Panniantong\/Agent-Reach\.git@14c213405669414492bda0f8d52cc6531d062c45\n/);
    assert.doesNotMatch(env,/synthetic-never-inherit/);
    for(const name of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP'])assert.ok(env.includes(`${name}=${join(stage,'home')}`),name);
    assert.match(env,/GIT_CONFIG_GLOBAL=NUL\n/);assert.match(env,/GIT_CONFIG_NOSYSTEM=1\n/);assert.match(env,/UV_NO_CONFIG=1\n/);
    assert.ok(env.includes(`CWD=${stage}`));
    assert.equal(managedAgentReach(root),join(stage,'bin','agent-reach.exe'));
    assert.match(await setupAgentReach(root,{uv:uv.file}),/already installed/);
    writeFileSync(managedAgentReach(root)!,'changed');assert.throws(()=>managedAgentReach(root),/incomplete or changed/);
    await assert.rejects(setupAgentReach(root,{uv:uv.file}),/incomplete or changed/);
  }finally{if(old===undefined)delete process.env.GH_TOKEN;else process.env.GH_TOKEN=old;rmSync(root,{recursive:true,force:true});rmSync(uv.dir,{recursive:true,force:true});}
});
windowsOnly('Windows setup refuses linked or shared tool folders before running uv',async()=>{
  const root=mkdtempSync(join(tmpdir(),'reach-setup-')),target=mkdtempSync(join(tmpdir(),'reach-target-')),ran=join(root,'ran'),uv=fakeUv([`touch=${ran}`]);
  try{
    symlinkSync(target,join(root,'agent-reach'),'junction');await assert.rejects(setupAgentReach(root,{uv:uv.file}),/private real directories/);
    rmSync(join(root,'agent-reach'));mkdirSync(join(root,'agent-reach'));
    // A folder created normally inherits access for other accounts (such as Administrators).
    await assert.rejects(setupAgentReach(root,{uv:uv.file}),/private real directories/);
    assert.throws(()=>managedAgentReach(root),/incomplete or changed/);
    assert.equal(existsSync(ran),false);
  }finally{rmSync(root,{recursive:true,force:true});rmSync(target,{recursive:true,force:true});rmSync(uv.dir,{recursive:true,force:true});}
});
windowsOnly('Windows uv failures, partial installs and concurrent setups never produce an install',async()=>{
  const root=mkdtempSync(join(tmpdir(),'reach-setup-')),bad=fakeUv(['partial=1','exit=1']),slow=fakeUv(['sleep=1500','install=1']);
  try{
    await assert.rejects(setupAgentReach(root,{uv:bad.file}),/setup failed/);assert.throws(()=>managedAgentReach(root),/incomplete or changed/);
    rmSync(join(root,'agent-reach'),{recursive:true,force:true});
    const first=setupAgentReach(root,{uv:slow.file});
    await assert.rejects(setupAgentReach(root,{uv:slow.file}),/running or was interrupted/);assert.match(await first,/installed/);assert.ok(managedAgentReach(root));
  }finally{rmSync(root,{recursive:true,force:true});rmSync(bad.dir,{recursive:true,force:true});rmSync(slow.dir,{recursive:true,force:true});}
});
windowsOnly('Windows setup ends everything the installer started, on success and at the deadline',async()=>{
  const root=mkdtempSync(join(tmpdir(),'reach-setup-')),marker=join(root,'unexpected'),late=join(root,'late');
  const leftover=fakeUv([`orphan=2000|${marker}`,'install=1']),slow=fakeUv([`orphan=2000|${late}`,'sleep=3000','install=1']);
  try{
    assert.match(await setupAgentReach(root,{uv:leftover.file}),/installed/);
    rmSync(join(root,'agent-reach'),{recursive:true,force:true});
    await assert.rejects(setupAgentReach(root,{uv:slow.file,timeoutMs:300}),/failed or timed out/);assert.throws(()=>managedAgentReach(root),/incomplete or changed/);
    await new Promise(r=>setTimeout(r,2500));
    assert.equal(existsSync(marker),false);assert.equal(existsSync(late),false);
  }finally{rmSync(root,{recursive:true,force:true});rmSync(leftover.dir,{recursive:true,force:true});rmSync(slow.dir,{recursive:true,force:true});}
});
windowsOnly('Windows caller termination kills installer descendants and leaves a fail-closed lock',async()=>{
  const root=mkdtempSync(join(tmpdir(),'reach-setup-')),late=join(root,'late');
  const uv=fakeUv(['touch=%UV_TOOL_DIR%\\started',`orphan=2500|${late}`,'sleep=2500','touch=%UV_TOOL_DIR%\\finished']);
  const module=new URL('../src/agent-reach-setup.ts',import.meta.url).href;
  const script=`import {setupAgentReach} from ${JSON.stringify(module)}; await setupAgentReach(${JSON.stringify(root)},{uv:${JSON.stringify(uv.file)}});`;
  const parent=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:process.cwd(),stdio:'ignore',windowsHide:true});
  try {
    let stage='';for(let i=0;i<1500;i++){const home=join(root,'agent-reach');if(existsSync(home)){stage=readdirSync(home).find(s=>s.startsWith('install-'))??'';if(stage&&existsSync(join(home,stage,'tools','started')))break;}await new Promise(r=>setTimeout(r,10));}
    assert.ok(stage);const dir=join(root,'agent-reach',stage,'tools');assert.ok(existsSync(join(dir,'started')));
    parent.kill('SIGKILL');await once(parent,'exit');await new Promise(r=>setTimeout(r,3200));
    assert.equal(existsSync(join(dir,'finished')),false);assert.equal(existsSync(late),false);
    assert.ok(existsSync(join(root,'agent-reach','setup.lock')));assert.throws(()=>managedAgentReach(root),/incomplete or changed/);
    await assert.rejects(setupAgentReach(root,{uv:uv.file}),/running or was interrupted/);
  }finally{try{parent.kill('SIGKILL');}catch{}rmSync(root,{recursive:true,force:true});rmSync(uv.dir,{recursive:true,force:true});}
});
test('Windows access lists count every non-deny entry as access, and arguments round-trip',()=>{
  assert.deepEqual(sddlAllowedSids('D:PAI(A;OICI;FA;;;S-1-5-21-1-2-3-1001)(A;OICI;FA;;;SY)'),['S-1-5-21-1-2-3-1001','SY']);
  assert.deepEqual(sddlAllowedSids('O:BAD:AI(D;;FA;;;WD)(A;OICIID;FA;;;BA)(XA;;FA;;;S-1-5-11;(x))'),undefined);
  assert.deepEqual(sddlAllowedSids('D:AI(D;;FA;;;WD)(A;OICIID;FA;;;BA)(A;;FA;;;S-1-5-11)'),['BA','S-1-5-11']);
  assert.equal(sddlAllowedSids('no list'),undefined);
  assert.equal(windowsArgument('C:\\Program Files\\uv\\uv.exe'),'"C:\\Program Files\\uv\\uv.exe"');
  assert.equal(windowsArgument('a"b\\'),'"a\\"b\\\\"');assert.equal(windowsArgument('plain'),'plain');assert.equal(windowsArgument(''),'""');
});
