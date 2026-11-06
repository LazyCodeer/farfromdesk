import test from 'node:test';
import assert from 'node:assert/strict';
import {ChildProcess,execFileSync} from 'node:child_process';
import {APPROVED_KEY,RUN_KEY,STARTUP_APPROVED,STARTUP_NAME,installWindowsStartup,installedApp,openWindowsApp,regQueryValue,resolveWindowsBin,stopWindowsService,systemHost,type WindowsHost} from '../src/windows-service.js';

// Runs on every OS. The registry, process list and app launch are fakes, so nothing
// here registers a real autostart entry or starts an app.
const env={LOCALAPPDATA:'C:\\Users\\owner\\AppData\\Local',SystemRoot:'C:\\Windows'};
const app='C:\\Users\\owner\\AppData\\Local\\Programs\\FarFromDesk\\farfromdesk.exe';
function host(files:string[],running:string[]=[],initial:Record<string,string>={}){
  const values=new Map(Object.entries(initial)),launched:string[]=[];
  const fake:WindowsHost={
    env,
    registry:{
      read:(key,name)=>values.get(`${key}|${name}`),
      writeString:(key,name,value)=>{values.set(`${key}|${name}`,value);},
      writeBinary:(key,name,hex)=>{values.set(`${key}|${name}`,`hex:${hex}`);},
      remove:(key,name)=>{values.delete(`${key}|${name}`);},
    },
    exists:path=>files.includes(path),running:()=>running,launch:exe=>{launched.push(exe);},
  };
  return {fake,values,launched};
}

test('install writes exactly the entry the app\'s Open at login switch writes, then starts the app',()=>{
  assert.equal(installedApp(env),app);
  const {fake,values,launched}=host([app]);
  assert.match(installWindowsStartup(fake),/starts when you sign in to this PC.*Open at login.*Starting it now/);
  // launch_at_startup: Run\FarFromDesk = the exe path, StartupApproved\Run\FarFromDesk = 02 + 11 zero bytes.
  assert.deepEqual([...values],[[`${RUN_KEY}|${STARTUP_NAME}`,app],[`${APPROVED_KEY}|${STARTUP_NAME}`,`hex:${STARTUP_APPROVED}`]]);
  assert.equal(STARTUP_NAME,'FarFromDesk');assert.equal(Buffer.from(STARTUP_APPROVED,'hex').length,12);assert.equal(Buffer.from(STARTUP_APPROVED,'hex')[0],2);
  assert.deepEqual(launched,[app]);
  // Running again changes nothing and never adds a second entry.
  assert.match(installWindowsStartup(host([app],['farfromdesk.exe'],Object.fromEntries(values)).fake),/already running/);
});

test('install reports a replaced entry, does not start a second copy, and refuses without the app',()=>{
  const {fake,values,launched}=host([app],['explorer.exe','farfromdesk.exe'],{[`${RUN_KEY}|${STARTUP_NAME}`]:'D:\\old\\farfromdesk.exe'});
  assert.match(installWindowsStartup(fake),/replaced the earlier entry that started D:\\old\\farfromdesk\.exe.*already running/);
  assert.equal(values.get(`${RUN_KEY}|${STARTUP_NAME}`),app);assert.deepEqual(launched,[]);
  const missing=host([]);
  assert.throws(()=>installWindowsStartup(missing.fake),/Install the FarFromDesk app for Windows first/);
  assert.equal(missing.values.size,0);assert.deepEqual(missing.launched,[]);
});

test('open starts the installed app, else a local release build, and never a second copy',()=>{
  const root='C:\\src\\farfromdesk',dev=`${root}\\desktop\\build\\windows\\x64\\runner\\Release\\farfromdesk.exe`;
  let h=host([app,dev]);assert.equal(openWindowsApp(root,h.fake),'Opening FarFromDesk.');assert.deepEqual(h.launched,[app]);
  h=host([dev]);openWindowsApp(root,h.fake);assert.deepEqual(h.launched,[dev]);
  h=host([app],['farfromdesk.exe']);assert.match(openWindowsApp(root,h.fake),/already running/);assert.deepEqual(h.launched,[]);
  assert.throws(()=>openWindowsApp(root,host([]).fake),/Install the FarFromDesk app for Windows first/);
});

test('stop-service asks the backend to shut down and is honest when nothing runs',async()=>{
  let calls=0;
  assert.match(await stopWindowsService(async()=>{calls++;}),/^Stopped\. Credentials and sessions are retained/);assert.equal(calls,1);
  assert.match(await stopWindowsService(async()=>{throw new Error('fetch failed');}),/not running on this PC/);
  await assert.rejects(stopWindowsService(async()=>{throw new Error('Unauthorized');}),/Unauthorized/);
});

test('resolveBin uses where.exe and keeps explicit paths',()=>{
  const calls:{file:string;args:string[];hide:boolean}[]=[];
  const run=(file:string,args:string[],options:{windowsHide:boolean})=>{calls.push({file,args,hide:options.windowsHide});return 'C:\\Users\\o\\AppData\\Roaming\\npm\\codex.cmd\r\nC:\\tools\\codex.exe\r\n';};
  assert.equal(resolveWindowsBin('codex',env,run as any),'C:\\Users\\o\\AppData\\Roaming\\npm\\codex.cmd');
  assert.deepEqual(calls,[{file:'C:\\Windows\\System32\\where.exe',args:['codex'],hide:true}]);
  assert.equal(resolveWindowsBin('C:\\tools\\claude.exe',env,run as any),'C:\\tools\\claude.exe');
  assert.equal(resolveWindowsBin('./bin/claude',env,run as any),'./bin/claude');assert.equal(calls.length,1);
  assert.throws(()=>resolveWindowsBin('missing',env,(()=>{throw new Error('exit 1');}) as any),/missing was not found on PATH/);
});

test('reg query output is parsed by value name, including names with spaces',()=>{
  const out=`\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    FarFromDesk Local    REG_SZ    C:\\local\\farfromdesk.exe\r\n    FarFromDesk    REG_SZ    ${app}\r\n\r\n`;
  assert.equal(regQueryValue(out,'FarFromDesk'),app);assert.equal(regQueryValue(out,'FarFromDesk Local'),'C:\\local\\farfromdesk.exe');
  assert.equal(regQueryValue(out,'Other'),undefined);
});

// Opt-in (FFD_LIVE_DESKTOP=1, Windows): the real reg.exe, tasklist and where.exe, against a
// throwaway key of its own. It never writes the Run key, so it cannot register an autostart.
test('live: registry, process list and where.exe work against a throwaway key',{skip:process.platform!=='win32'||process.env.FFD_LIVE_DESKTOP!=='1'},()=>{
  const key=`HKCU\\Software\\FarFromDesk-test-${process.pid}-${Date.now()}`,h=systemHost();
  try {
    h.registry.writeString(key,'FarFromDesk Test',app);assert.equal(h.registry.read(key,'FarFromDesk Test'),app);
    h.registry.writeBinary(key,'FarFromDesk Test',STARTUP_APPROVED);assert.equal(h.registry.read(key,'FarFromDesk Test'),STARTUP_APPROVED);
    h.registry.remove(key,'FarFromDesk Test');assert.equal(h.registry.read(key,'FarFromDesk Test'),undefined);
    assert.ok(h.running().includes('node.exe'));
    assert.match(resolveWindowsBin('powershell'),/\\powershell\.exe$/i);
  } finally {try{execFileSync(`${process.env.SystemRoot??'C:\\Windows'}\\System32\\reg.exe`,['delete',key,'/f'],{stdio:'ignore',windowsHide:true});}catch{}}
});

test('the system host hides every helper process and lists running programs',async()=>{
  const seen:{file:string;args:string[];hide:boolean}[]=[];
  const run=(file:string,args:string[],options:{windowsHide:boolean})=>{seen.push({file,args,hide:options.windowsHide});
    return file.endsWith('tasklist.exe')?'"System Idle Process","0","Services","0","8 K"\r\n"FarFromDesk.exe","42","Console","1","9 K"\r\n':`\r\n${RUN_KEY}\r\n    FarFromDesk    REG_SZ    ${app}\r\n`;};
  const h=systemHost(env,run as any);
  assert.deepEqual(h.running(),['system idle process','farfromdesk.exe']);
  assert.equal(h.registry.read(RUN_KEY,STARTUP_NAME),app);
  h.registry.writeString(RUN_KEY,'FarFromDesk',app);h.registry.writeBinary(APPROVED_KEY,'FarFromDesk',STARTUP_APPROVED);
  assert.deepEqual(seen.slice(2).map(s=>s.args),[['add',RUN_KEY,'/v','FarFromDesk','/t','REG_SZ','/d',app,'/f'],['add',APPROVED_KEY,'/v','FarFromDesk','/t','REG_BINARY','/d',STARTUP_APPROVED,'/f']]);
  assert.ok(seen.every(s=>s.hide&&s.file.startsWith('C:\\Windows\\System32\\')));
  // The app is started through Explorer (so its window is shown), itself hidden.
  const proto=ChildProcess.prototype as unknown as {spawn:(o:{file:string;args:string[];windowsHide?:boolean})=>unknown};
  const original=proto.spawn,spawned:{file:string;args:string[];hide:boolean}[]=[];
  proto.spawn=function(this:unknown,o){spawned.push({file:o.file,args:o.args,hide:!!o.windowsHide});return original.call(this,{...o,file:'ffd-missing-explorer-for-test',args:['ffd-missing-explorer-for-test']});};
  try{systemHost({...env,SystemRoot:'C:\\ffd-missing-windows'},run as any).launch(app);await new Promise(r=>setTimeout(r,50));}finally{proto.spawn=original;}
  assert.equal(spawned.length,1);assert.equal(spawned[0].file,'C:\\ffd-missing-windows\\explorer.exe');assert.equal(spawned[0].args.at(-1),app);assert.equal(spawned[0].hide,true);
});
