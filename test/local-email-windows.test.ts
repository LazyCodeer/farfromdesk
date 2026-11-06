import test from 'node:test';
import assert from 'node:assert/strict';
import {ChildProcess,spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {mailHelperCommand,currentBootId,windowsPowerShellPath} from '../src/local-email/helper-command.js';
import {localMailHelpersUsable} from '../src/local-email/local-runtime.js';
import {MailKeychainHelper} from '../src/local-email/keychain-helper.js';
import {nativeMailApproval} from '../src/local-email/native-approval.js';
import {windowsCredentialStore,macKeychainStore} from '../src/local-email/keychain-adapter.js';
import {LocalMailService,type HostMailAuthority} from '../src/local-email/service.js';
import {DatabaseSync} from 'node:sqlite';

const windows=process.platform==='win32';
const dir=mkdtempSync(join(tmpdir(),'ffd-mail-win-'));test.after(()=>rmSync(dir,{recursive:true,force:true}));
const broker=resolve('native/local-mail-credentials.ps1'),approval=resolve('native/local-mail-approval.ps1');
const slot=()=>randomBytes(16).toString('hex');

test('Windows helpers run in hidden Windows PowerShell with a minimal environment; Mac helpers are unchanged',()=>{
  const env={SystemRoot:'C:\\Windows',TEMP:'C:\\Temp\\x',SECRET_TOKEN:'must-not-pass',PATH:'C:\\bin'};
  const win=mailHelperCommand('C:\\app\\backend\\native\\local-mail-credentials.ps1',['C:\\state\\email-helper.lock'],'win32',env);
  assert.match(win.file,/^C:\\Windows[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
  assert.deepEqual(win.args.slice(0,6),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File']);
  assert.deepEqual(win.args.slice(6),['C:\\app\\backend\\native\\local-mail-credentials.ps1','C:\\state\\email-helper.lock']);
  assert.deepEqual(win.env,{SystemRoot:'C:\\Windows',windir:'C:\\Windows',TEMP:'C:\\Temp\\x',TMP:'C:\\Temp\\x'});
  assert.equal(win.windowsHide,true);
  const mac=mailHelperCommand('/Applications/FarFromDesk Local.app/Contents/Resources/backend/native/local-mail-keychain',['/state/lock'],'darwin',env);
  assert.deepEqual(mac,{file:'/Applications/FarFromDesk Local.app/Contents/Resources/backend/native/local-mail-keychain',args:['/state/lock'],env:{},windowsHide:true});
});

test('each platform accepts only its own bundled helper kind',()=>{
  assert.equal(localMailHelpersUsable('win32','C:\\b\\native\\local-mail-credentials.ps1','C:\\b\\native\\local-mail-approval.ps1'),true);
  assert.equal(localMailHelpersUsable('win32','C:\\b\\native\\local-mail-keychain','C:\\b\\native\\local-mail-approval'),false);
  assert.equal(localMailHelpersUsable('win32','',''),false);
  assert.equal(localMailHelpersUsable('darwin','/b/native/local-mail-keychain','/b/native/local-mail-approval'),true);
  assert.equal(localMailHelpersUsable('linux','/b/native/local-mail-keychain','/b/native/local-mail-approval'),false);
});

test('boot id comes from sysctl on macOS and the BootId counter on Windows; anything odd fails closed',async()=>{
  const calls:string[][]=[];
  const fake=(out:string)=>async(file:string,args:string[])=>{calls.push([file,...args]);return out;};
  assert.equal(await currentBootId('darwin',fake('1C3F2A10-1111-2222-3333-444455556666\n')),'1C3F2A10-1111-2222-3333-444455556666');
  assert.deepEqual(calls[0],['/usr/sbin/sysctl','-n','kern.bootsessionuuid']);
  const reg='\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters\r\n    BootId    REG_DWORD    0x10c\r\n\r\n';
  assert.equal(await currentBootId('win32',fake(reg)),'windows-boot-268');
  assert.match(calls[1]![0]!,/reg\.exe$/i);
  await assert.rejects(currentBootId('win32',fake('ERROR: The system was unable to find the specified registry key or value.')));
  await assert.rejects(currentBootId('darwin',fake('not-a-uuid')));
  await assert.rejects(currentBootId('linux',fake('x')));
  if(windows)assert.match(await currentBootId(),/^windows-boot-\d+$/);
});

test('the service reports which OS store holds the passwords, and never a Mac name on Windows',()=>{
  const authority:HostMailAuthority={capture:()=>({id:'o',generation:'1'}),isCurrent:()=>true,verifyExplicitSend:()=>{throw Error('no');},approvalCurrent:()=>false,assertExclusiveRecovery:()=>true};
  const vault={read:async()=>undefined,write:async()=>{},remove:async()=>{}};
  for(const [store,kind] of [[windowsCredentialStore(vault,()=>true),'windows-credential-manager'],[macKeychainStore(vault,()=>true),'macos-keychain']] as const){
    const db=new DatabaseSync(':memory:');try{const s=new LocalMailService(db,store,authority).status();assert.equal(s.available,true);assert.equal(s.credentialStorage,kind);}finally{db.close();}
  }
  const db=new DatabaseSync(':memory:');try{assert.equal(new LocalMailService(db,windowsCredentialStore(vault,()=>false),authority).status().credentialStorage,'unavailable');}finally{db.close();}
});

// The app starts the backend detached with no console: a helper started without windowsHide
// would flash a terminal window on the PC.
test('the credential broker and the approval prompt are started hidden',{skip:!windows},async()=>{
  const proto=ChildProcess.prototype as unknown as {spawn:(o:{windowsHide?:boolean;file:string;envPairs?:string[]})=>unknown};
  const original=proto.spawn,seen:{file:string;windowsHide:boolean}[]=[];
  proto.spawn=function(this:unknown,o){seen.push({file:o.file,windowsHide:!!o.windowsHide});return original.call(this,o);};
  const fake=join(dir,'fake-approval.ps1');writeFileSync(fake,"[Console]::OpenStandardInput().CopyTo([IO.Stream]::Null); [Console]::Out.Write('{\"approved\":false}')\r\n");
  try{
    await nativeMailApproval(fake,{id:'d',accountId:'a',revision:'r',digest:'x',from:'a@example.test',to:['b@example.test'],subject:'s',body:'b'});
    const vault=new MailKeychainHelper(broker,join(dir,'hidden.lock'));await vault.start();await vault.close();
  }finally{proto.spawn=original;}
  assert.equal(seen.length,2);for(const s of seen){assert.equal(s.windowsHide,true);assert.equal(s.file.toLowerCase(),windowsPowerShellPath().toLowerCase());}
});

test('the approval helper receives the exact draft as UTF-8 and only its answer decides',{skip:!windows},async()=>{
  // A stand-in for the dialog: approves only when every field arrived byte for byte.
  const fake=join(dir,'echo-approval.ps1');
  writeFileSync(fake,[
    '$s = New-Object IO.StreamReader([Console]::OpenStandardInput(), (New-Object Text.UTF8Encoding($false)))',
    '$v = $s.ReadToEnd() | ConvertFrom-Json',
    '$ok = ($v.from -eq "ana@example.test") -and ($v.to -eq "b@example.test, c@example.test") -and ($v.subject -eq ([string][char]0x00e9 + "t" + [char]0x00e9)) -and ($v.body -eq ("Line 1" + [char]10 + [char]0x0928 + [char]0x092e + [char]0x0938 + [char]0x094d + [char]0x0924 + [char]0x0947))',
    'if ($ok) { [Console]::Out.Write(\'{"approved":true}\') } else { [Console]::Out.Write(\'{"approved":false}\') }',
  ].join('\r\n'));
  const draft={id:'d',accountId:'a',revision:'r',digest:'x',from:'ana@example.test',to:['b@example.test','c@example.test'],subject:'été',body:'Line 1\nनमस्ते'};
  assert.equal(await nativeMailApproval(fake,draft),true);
  assert.equal(await nativeMailApproval(fake,{...draft,subject:'ete'}),false);
  const broken=join(dir,'broken-approval.ps1');writeFileSync(broken,"[Console]::Out.Write('approved')\r\n");
  await assert.rejects(nativeMailApproval(broken,draft),/unavailable/);
  const failing=join(dir,'failing-approval.ps1');writeFileSync(failing,"[Console]::Out.Write('{\"approved\":true}'); exit 3\r\n");
  await assert.rejects(nativeMailApproval(failing,draft),/unavailable/);
});

test('the Windows broker holds an exclusive lock until it exits and rejects bad arguments',{skip:!windows},async()=>{
  const lock=join(dir,'broker.lock'),first=new MailKeychainHelper(broker,lock),second=new MailKeychainHelper(broker,lock);await first.start();
  try{await assert.rejects(second.start());assert.equal(first.isLocked(),true);}finally{await first.close();}
  const replacement=new MailKeychainHelper(broker,lock);await replacement.start();await replacement.close();
  // A namespace outside the synthetic test pattern could name someone else's credential.
  await assert.rejects(new MailKeychainHelper(broker,join(dir,'ns.lock'),15_000,['git:https://github.com']).start());
  await assert.rejects(new MailKeychainHelper(broker,join(dir,'ns2.lock'),15_000,['ffd-test-a','extra']).start());
});

// Opt-in (FFD_LIVE_MAIL_HELPERS=1): writes, reads and deletes one synthetic item under a
// fresh "ffd-test-..." Credential Manager namespace. It never names any other credential.
test('the Windows broker stores and deletes only a synthetic credential in a throwaway namespace',{skip:!windows||process.env.FFD_LIVE_MAIL_HELPERS!=='1'},async()=>{
  const namespace=`ffd-test-${randomBytes(6).toString('hex')}`,key=slot();
  const vault=new MailKeychainHelper(broker,join(dir,'live.lock'),15_000,[namespace]);await vault.start();
  try{
    assert.equal(await vault.read(key),undefined);
    await vault.write(key,'synthetic-secret-é-नमस्ते');
    assert.equal(await vault.read(key),'synthetic-secret-é-नमस्ते');
    await assert.rejects(vault.write(key,'second-write'),'a slot is written once, like SecItemAdd');
    // Credential Manager blobs are at most 2560 bytes; a longer value fails cleanly.
    await assert.rejects(vault.write(slot(),'x'.repeat(2561)));
    await vault.remove(key);assert.equal(await vault.read(key),undefined);await vault.remove(key);
    await assert.rejects(vault.read('not-a-slot'));
  }finally{
    await vault.close();
    try{execFileSync('cmdkey',[`/delete:${namespace}/${key}`],{stdio:'ignore',windowsHide:true});}catch{/* already gone */}
  }
  const listed=execFileSync('cmdkey',['/list'],{encoding:'utf8',windowsHide:true});assert.equal(listed.includes(namespace),false);
});

// Opt-in (FFD_LIVE_MAIL_DIALOG=1): shows the real approval window for a moment on the PC,
// checks it is visible with Cancel focused, then ends it without any click. Ending the
// prompt is never an approval.
test('the real approval window appears, visible, and ending it sends nothing',{skip:!windows||process.env.FFD_LIVE_MAIL_DIALOG!=='1'},async()=>{
  const probe=join(dir,'probe.ps1');
  writeFileSync(probe,[
    'param([int]$ProcessId)',
    'Add-Type -TypeDefinition @"',
    'using System; using System.Runtime.InteropServices; using System.Text;',
    'public static class FFDProbe {',
    '  public delegate bool Enum(IntPtr h, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(Enum cb, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
    '  public static string Find(uint target) { string found = ""; EnumWindows(delegate (IntPtr h, IntPtr l) { uint pid; GetWindowThreadProcessId(h, out pid); if (pid == target && IsWindowVisible(h)) { StringBuilder s = new StringBuilder(256); GetWindowText(h, s, 256); found = s.ToString(); return false; } return true; }, IntPtr.Zero); return found; }',
    '}',
    '"@',
    '[Console]::Out.Write([FFDProbe]::Find([uint32]$ProcessId))',
  ].join('\r\n'));
  const c=mailHelperCommand(approval,[]);
  const child=spawn(c.file,c.args,{stdio:['pipe','pipe','pipe'],env:c.env,windowsHide:true});
  child.stdin.end(JSON.stringify({from:'synthetic@example.test',to:'nobody@example.test',subject:'Synthetic approval check',body:'This is a test window. It closes by itself.'}));
  let output='';child.stdout.on('data',d=>output+=d);
  const exited=new Promise<number|null>(r=>child.once('close',code=>r(code)));
  try{
    let title='';
    for(let i=0;i<40&&!title;i++){await new Promise(r=>setTimeout(r,500));title=execFileSync(windowsPowerShellPath(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',probe,String(child.pid)],{encoding:'utf8',windowsHide:true}).trim();}
    assert.equal(title,'FarFromDesk','the approval window is shown, not hidden by the hidden start');
  }finally{child.kill();}
  assert.notEqual(await exited,0);assert.equal(output,'');
});
