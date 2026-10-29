// Run tests with a fresh state root established before any application imports.
// Direct node/tsx test invocations bypass this runner; use npm run test:file.
import {mkdtempSync,mkdirSync,chmodSync,readdirSync,rmSync,realpathSync,statSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join,resolve,relative,dirname,basename,isAbsolute,sep} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(fileURLToPath(new URL('..',import.meta.url)));
const portable=['test/portable.test.ts','test/coordinator.test.ts','test/speech-bundle.test.ts'];
// Keep inherited environment narrow: credentials can appear under arbitrary
// names such as DATABASE_URL or GH_CONFIG_DIR, not only KEY/TOKEN/SECRET.
// These explicit test flags opt into local fixtures and never carry credentials.
const inheritedNames=new Set([
  'PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','OS',
  'PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','NUMBER_OF_PROCESSORS',
  'LANG','LANGUAGE','LC_ALL','LC_CTYPE','LC_COLLATE',
  'LC_MESSAGES','LC_NUMERIC','LC_TIME','LC_MONETARY','LC_PAPER','LC_NAME',
  'LC_ADDRESS','LC_TELEPHONE','LC_MEASUREMENT','LC_IDENTIFICATION','TZ',
  'TERM','COLORTERM','NO_COLOR','FORCE_COLOR','CI','GITHUB_ACTIONS',
  'WSB_AUDIO_TEST_FFMPEG','WSB_AUDIO_TEST_WHISPER','WSB_AUDIO_TEST_MODEL',
  'WSB_AUDIO_TEST_SAMPLE','FFD_LARGE_DOCUMENT_PROBE',
  'ISOLATION_SENTINEL','ISOLATION_PROBE_FAIL','ISOLATION_EXPECT_AUDIO',
]);

function defaultAppState() {
  const home=homedir();
  if(process.platform==='darwin')return join(home,'Library','Application Support','WhatsApp Session Bridge');
  if(process.platform==='win32')return join(process.env.LOCALAPPDATA||join(home,'AppData','Local'),'FarFromDesk');
  return join(process.env.XDG_DATA_HOME||join(home,'.local','share'),'farfromdesk');
}
export function coordinatorRoots(env=process.env,home=homedir()) {
  return [join(home,'.farfromdesk'),...(env.FARFROMDESK_HOME===undefined?[]:[env.FARFROMDESK_HOME])];
}

// Resolve aliases in every existing path component, even when the final state
// directory has not been created. An inaccessible component is not assumed to
// be safe: it could itself be a symlink into the candidate temp directory.
function canonicalPotential(path) {
  let current=resolve(path);const suffix=[];
  for(;;) {
    try{const existing=realpathSync(current);if(!statSync(existing).isDirectory())throw new Error('Not a directory');return resolve(existing,...suffix);}
    catch(error) {
      if(error?.code!=='ENOENT')throw new Error('Cannot verify test temp isolation against app state.');
      const parent=dirname(current);if(parent===current)throw new Error('Cannot verify test temp isolation against app state.');
      suffix.unshift(basename(current));current=parent;
    }
  }
}

/** Reject an existing temp base inside an app-state root, including aliases. */
export function safeTestTempBase(candidate,stateRoots) {
  let base;try{base=realpathSync(resolve(candidate));}
  catch{throw new Error('Cannot verify the test temp directory.');}
  for(const root of stateRoots) {
    const state=canonicalPotential(root),part=relative(state,base);
    if(part===''||(!isAbsolute(part)&&part!=='..'&&!part.startsWith(`..${sep}`)))
      throw new Error('The test temp directory must be outside app state.');
  }
  return base;
}

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
  // The coordinator workspace can contain the owner's projects even when it
  // is separate from app state. Check it before creating any test directory.
  const roots=[...(process.env.WSB_STATE_DIR===undefined?[]:[process.env.WSB_STATE_DIR]),defaultAppState(),...coordinatorRoots()];
  const base=safeTestTempBase(tmpdir(),roots);
  const root=mkdtempSync(join(base,'farfromdesk-tests-'));
  let guardPort;
  try {
    chmodSync(root,0o700);
    const state=join(root,'state'),projects=join(root,'projects'),codex=join(root,'codex'),claude=join(root,'claude'),userHome=join(root,'home'),appData=join(root,'appdata'),xdg=join(root,'xdg'),temp=join(root,'tmp');
    for(const dir of [state,projects,codex,claude,userHome,appData,xdg,temp])mkdirSync(dir,{mode:0o700});
    const preload=pathToFileURL(join(repo,'script/test_fetch_guard.mjs')).href;
    // Do not copy arbitrary inherited environment into tests or their children.
    // In particular this excludes service URLs, credential/config locations,
    // installed helper paths, bridge ports and inherited Node startup hooks.
    const env={};
    for(const [key,value] of Object.entries(process.env))
      if(inheritedNames.has(key.toUpperCase()))env[key]=value;
    // Hold a fresh loopback port with a reject-only listener. A test that
    // accidentally uses the default bridge URL cannot reach a real service.
    for(let i=0;i<10;i++){
      guardPort=createServer(socket=>socket.destroy());
      await new Promise((resolve,reject)=>{guardPort.once('error',reject);guardPort.listen(0,'127.0.0.1',resolve);});
      if(guardPort.address().port!==47831&&String(guardPort.address().port)!==process.env.WSB_PORT)break;
      await new Promise(resolve=>guardPort.close(resolve));guardPort=undefined;
    }
    if(!guardPort)throw new Error('Could not allocate an isolated bridge port.');
    Object.assign(env,{HOME:userHome,USERPROFILE:userHome,APPDATA:appData,LOCALAPPDATA:appData,XDG_CONFIG_HOME:xdg,XDG_DATA_HOME:xdg,XDG_CACHE_HOME:xdg,XDG_RUNTIME_DIR:xdg,TMPDIR:temp,TMP:temp,TEMP:temp,WSB_PORT:String(guardPort.address().port),WSB_STATE_DIR:state,FARFROMDESK_HOME:projects,CODEX_HOME:codex,CLAUDE_CONFIG_DIR:claude,
      WSB_CODEX_BIN:join(root,'missing-codex'),WSB_CLAUDE_BIN:join(root,'missing-claude'),WSB_CLAUDE_DESKTOP_BIN:join(root,'missing-claude-desktop'),WSB_DESKTOP_SYNC_BIN:join(root,'missing-desktop-sync'),NODE_OPTIONS:`--import=${preload}`});
    const child=spawn(process.execPath,['--import','tsx','--test',...options,...files],{cwd:repo,env,stdio:'inherit',detached:process.platform!=='win32'});
    return {child,root,guardPort};
  } catch(e) {guardPort?.close();rmSync(root,{recursive:true,force:true});throw e;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  // Node may propagate coverage through its own test-runner children even if
  // the explicit spawn environment omits it. Clear it from this bootstrap as
  // well; it may already have affected the bootstrap itself before this code.
  delete process.env.NODE_V8_COVERAGE;
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
