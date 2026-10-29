// Run tests with a fresh state root established before any application imports.
// Direct node/tsx test invocations bypass this runner; use npm run test:file.
import {mkdtempSync,mkdirSync,chmodSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(fileURLToPath(new URL('..',import.meta.url)));
const portable=['test/portable.test.ts','test/coordinator.test.ts','test/speech-bundle.test.ts'];

export function selectedTests(mode,args) {
  if(mode==='files') {
    if(!args.length)throw new Error('Specify at least one test file.');
    return {files:args,options:[]};
  }
  if(mode!=='all'&&mode!=='portable')throw new Error('Choose all, portable, or files.');
  const files=mode==='portable'?portable:readdirSync(join(repo,'test'))
    .filter(name=>name.endsWith('.test.ts')).sort().map(name=>`test/${name}`);
  if(!files.length)throw new Error('No test files found.');
  return {files,options:args};
}

export async function startTests(mode,args) {
  const {files,options}=selectedTests(mode,args);
  const root=mkdtempSync(join(tmpdir(),'farfromdesk-tests-'));
  let guardPort;
  try {
    chmodSync(root,0o700);
    const state=join(root,'state'),projects=join(root,'projects'),codex=join(root,'codex'),claude=join(root,'claude'),userHome=join(root,'home');
    for(const dir of [state,projects,codex,claude,userHome])mkdirSync(dir,{mode:0o700});
    const preload=pathToFileURL(join(repo,'script/test_fetch_guard.mjs')).href;
    // Never inherit account credentials, installed helper paths, the running
    // bridge port, or arbitrary Node preload hooks into the isolated process.
    const env={...process.env};
    for(const key of Object.keys(env))if(/(?:^|_)(?:KEY|KEY_ID|TOKEN|TOKEN_FILE|SECRET|PASSWORD|CREDENTIALS?|WEBHOOK_URL)$/i.test(key)||
      /^(?:WSB_CODEX_BIN|WSB_CLAUDE_BIN|WSB_CLAUDE_DESKTOP_BIN|WSB_DESKTOP_SYNC_BIN|WSB_CODEX_SOCKET|SSH_AUTH_SOCK|SSH_AGENT_PID)$/i.test(key))delete env[key];
    // Hold a fresh loopback port with a reject-only listener. A test that
    // accidentally uses the default bridge URL cannot reach a real service.
    for(let i=0;i<10;i++){
      guardPort=createServer(socket=>socket.destroy());
      await new Promise((resolve,reject)=>{guardPort.once('error',reject);guardPort.listen(0,'127.0.0.1',resolve);});
      if(guardPort.address().port!==47831&&String(guardPort.address().port)!==process.env.WSB_PORT)break;
      await new Promise(resolve=>guardPort.close(resolve));guardPort=undefined;
    }
    if(!guardPort)throw new Error('Could not allocate an isolated bridge port.');
    Object.assign(env,{HOME:userHome,USERPROFILE:userHome,WSB_PORT:String(guardPort.address().port),WSB_STATE_DIR:state,FARFROMDESK_HOME:projects,CODEX_HOME:codex,CLAUDE_CONFIG_DIR:claude,
      WSB_CODEX_BIN:join(root,'missing-codex'),WSB_CLAUDE_BIN:join(root,'missing-claude'),WSB_CLAUDE_DESKTOP_BIN:join(root,'missing-claude-desktop'),WSB_DESKTOP_SYNC_BIN:join(root,'missing-desktop-sync'),NODE_OPTIONS:`--import=${preload}`});
    const child=spawn(process.execPath,['--import','tsx','--test',...options,...files],{cwd:repo,env,stdio:'inherit',detached:process.platform!=='win32'});
    return {child,root,guardPort};
  } catch(e) {guardPort?.close();rmSync(root,{recursive:true,force:true});throw e;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  let execution,stopping,forceTimer;
  // Remember a signal even while the loopback guard is being started, so the
  // new temporary root is still cleaned up if cancellation arrives immediately.
  const stop=signal=>{
    if(!execution)return;
    const {child}=execution;
    try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,signal);else child.kill(signal);}
    catch(e){if(e.code!=='ESRCH')try{child.kill(signal);}catch{}}
  };
  const terminate=signal=>{
    if(stopping)return;stopping=signal;
    if(execution){stop(signal);forceTimer=setTimeout(()=>stop('SIGKILL'),2000);}
  };
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>terminate(signal));
  try {execution=await startTests(process.argv[2]??'all',process.argv.slice(3));}
  catch(e) {console.error(`Test runner could not start: ${e.message}`);process.exitCode=1;}
  if(execution) {
    const {child,root,guardPort}=execution;
    // The runner owns a separate process group on POSIX. Never signal the
    // caller's shell or unrelated app processes when a test run is canceled.
    if(stopping){stop(stopping);forceTimer=setTimeout(()=>stop('SIGKILL'),2000);}
    child.once('error',()=>{clearTimeout(forceTimer);guardPort.close();rmSync(root,{recursive:true,force:true});process.exitCode=1;});
    child.once('close',(code,signal)=>{
      if(stopping)stop('SIGKILL');clearTimeout(forceTimer);
      guardPort.close();
      rmSync(root,{recursive:true,force:true});
      process.exitCode=stopping==='SIGINT'?130:stopping==='SIGTERM'?143:Number.isInteger(code)?code:signal==='SIGINT'?130:1;
    });
  }
}
