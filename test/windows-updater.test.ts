import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseAsset} from '../src/app-updater.js';
import {validateWindowsInstall,installerArguments,installWindowsUpdate,canonicalWindowsInventory} from '../src/windows-updater.js';

const app='C:\\Users\\Test User\\AppData\\Local\\Programs\\FarFromDesk';
const inventory=()=>({installs:[{path:app+'\\',version:'0.8.0'}],processes:[{pid:42,path:app+'\\farfromdesk.exe',started:'2026-10-28T00:00:00Z'}]});
test('short Windows folder names are resolved without hiding duplicate installations',async()=>{
 const short='C:\\Users\\TESTUS~1\\AppData\\Local\\Programs\\FarFromDesk';
 const value=inventory();value.installs[0].path=short;
 const canonical=async(p:string)=>p===short?app:p;
 const normalized=await canonicalWindowsInventory(value,canonical);
 assert.equal(validateWindowsInstall(app,'0.8.0',normalized,42).pid,42);
 value.installs.push({path:app,version:'0.8.0'});
 const duplicates=await canonicalWindowsInventory(value,canonical);
 assert.throws(()=>validateWindowsInstall(app,'0.8.0',duplicates,42),/existing/);
});
test('Windows updater requires the existing registered installation and one exact UI',()=>{
 assert.equal(validateWindowsInstall(app,'0.8.0',inventory(),42).pid,42);
 assert.throws(()=>validateWindowsInstall('C:\\Portable','0.8.0',inventory(),42),/existing/);
 assert.throws(()=>validateWindowsInstall(app,'0.9.0',inventory(),42),/existing/);
 assert.throws(()=>validateWindowsInstall(app,'0.8.0',inventory(),99),/Close other/);
 const duplicate=inventory();duplicate.installs.push({...duplicate.installs[0]});
 assert.throws(()=>validateWindowsInstall(app,'0.8.0',duplicate,42),/existing/);
 const windows=inventory();windows.processes.push({...windows.processes[0],pid:43});
 assert.throws(()=>validateWindowsInstall(app,'0.8.0',windows,42),/Close other/);
});
test('Windows updater selects only the official x64 EXE with its checksum',()=>{
 const name='FarFromDesk-0.8.1-windows-x64-setup.exe';
 const url=`https://github.com/LazyCodeer/farfromdesk/releases/download/v0.8.1/${name}`;
 const data={tag_name:'v0.8.1',draft:false,prerelease:false,assets:[{name,browser_download_url:url,state:'uploaded',size:10},{name:name+'.sha256',browser_download_url:url+'.sha256',state:'uploaded'}]};
 assert.equal(releaseAsset(data,'0.8.1','0.8.0','x64','windows').url,url);
 assert.throws(()=>releaseAsset(data,'0.8.1','0.8.0','arm64','windows'),/compatible/);
 assert.throws(()=>releaseAsset(data,'0.8.1','0.8.1','x64','windows'),/newer/);
 data.assets[0].browser_download_url='https://example.com/a.exe';
 assert.throws(()=>releaseAsset(data,'0.8.1','0.8.0','x64','windows'),/complete/);
});
test('installer receives the existing path verbatim, never a shell or forced process close',()=>{
 const args=installerArguments(app,'C:\\Recovery & logs\\installer.log');
 assert.ok(args.includes('/DIR='+app));assert.ok(args.includes('/LOG=C:\\Recovery & logs\\installer.log'));
 assert.ok(args.includes('/NORESTART'));assert.ok(args.includes('/RESTARTEXITCODE=3010'));assert.ok(args.includes('/NOCLOSEAPPLICATIONS'));
 assert.ok(!args.some(a=>/FORCECLOSE|powershell|cmd\.exe/i.test(a)));
});
const names=['preflight','shutdown','waitBackend','backup','closeUI','ensureStopped','install','verify','launch','health'] as const;
function fixture(failure?:string,code=0) {
 const calls:string[]=[];
 const steps=Object.fromEntries(names.map(name=>[name,async()=>{calls.push(name);if(name===failure)throw new Error('fixture '+name);if(name==='install')return code;}])) as unknown as Parameters<typeof installWindowsUpdate>[0];
 return {calls,steps};
}
test('installation waits for both processes, backup and verification before declaring success',async()=>{
 const {calls,steps}=fixture();await installWindowsUpdate(steps);assert.deepEqual(calls,names);
});
for(const failure of ['preflight','shutdown','waitBackend','backup','closeUI','ensureStopped']) {
 test(`${failure} failure cannot start the installer`,async()=>{
  const {calls,steps}=fixture(failure);await assert.rejects(installWindowsUpdate(steps),new RegExp(failure));
  assert.equal(calls.includes('install'),false);assert.equal(calls.includes('launch'),false);
 });
}
test('failed, reboot-required and uncertain installers are not retried or launched',async()=>{
 for(const code of [1,5,3010,-1]){
  const {calls,steps}=fixture(undefined,code);await assert.rejects(installWindowsUpdate(steps),code===3010?/restart/:/installer stopped/);
  assert.equal(calls.filter(x=>x==='install').length,1);assert.equal(calls.includes('launch'),false);
 }
 const uncertain=fixture('install');await assert.rejects(installWindowsUpdate(uncertain.steps));
 assert.equal(uncertain.calls.filter(x=>x==='install').length,1);
});
test('bad installed version and missing health cannot become successful updates or be replayed',async()=>{
 for(const failure of ['verify','launch','health']){
  const {calls,steps}=fixture(failure);await assert.rejects(installWindowsUpdate(steps),new RegExp(failure));
  assert.equal(calls.filter(x=>x==='install').length,1);
  if(failure==='verify')assert.equal(calls.includes('launch'),false);
 }
});
