// Run ONLY in a disposable Windows user/CI runner with no installed FarFromDesk.
// Uses two real, differently versioned installers and the real updater/lifecycle.
// Only the release transport is supplied locally; the shipped CLI has no feed override.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createReadStream} from 'node:fs';
import {mkdtemp,readFile,writeFile,cp,mkdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {newer} from '../dist/app-updater.js';
import {uninstallKey} from '../dist/windows-updater.js';

const [oldSetup,oldVersion,newSetup,newVersion]=process.argv.slice(2);
assert.equal(process.platform,'win32','This is a Windows-only upgrade test.');
assert.ok(oldSetup&&newSetup&&oldVersion&&newVersion,'Usage: node script/test_windows_upgrade.mjs OLD_EXE OLD_VERSION NEW_EXE NEW_VERSION');
assert.ok(newer(newVersion,oldVersion),'The test must upgrade to a genuinely newer version.');
const ps=join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
function powershell(script,env={}){return execFileSync(ps,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',env:{...process.env,...env},timeout:30000});}
// Refuse to change or uninstall an existing real installation in either scope/view.
const preexisting=powershell(`$roots=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');@(Get-ItemProperty $roots -ErrorAction SilentlyContinue|Where-Object {$_.DisplayName -like '*FarFromDesk*'}).Count`).trim();
assert.equal(preexisting,'0','Use a disposable Windows user/runner: an installation already exists.');
const root=await mkdtemp(join(tmpdir(),'ffd-real-upgrade-')),app=join(root,'Installed app'),state=join(root,'Saved state');
await mkdir(state);
const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));
const env={...process.env,WSB_STATE_DIR:state,WSB_PORT:String(port),FFD_SMOKE_TEST:'1',CODEX_HOME:join(state,'codex'),CLAUDE_CONFIG_DIR:join(state,'claude'),WSB_CODEX_BIN:join(state,'missing-codex'),WSB_CLAUDE_BIN:join(state,'missing-claude')};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function api(path,body){const token=(await readFile(join(state,'admin-token'),'utf8')).trim();const res=await fetch(`http://127.0.0.1:${port}${path}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(3000)});assert.equal(res.status,200);return res.json();}
async function healthy(version){for(let i=0;i<120;i++){try{const h=await api('/api/health');if(h.buildId===version)return h;}catch{}await wait(500);}throw new Error('Backend did not become healthy: '+version);}
let oldUI;
try {
 execFileSync(resolve(oldSetup),['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',`/DIR=${app}`,`/LOG=${join(root,'old-install.log')}`],{timeout:180000});
 oldUI=spawn(join(app,'farfromdesk.exe'),[],{env,cwd:app,stdio:'ignore'});
 await once(oldUI,'spawn');const before=await healthy(oldVersion);
 // Exercise the original failure condition: background forwarding remains on when UI closes.
 await api('/api/preferences',{backgroundEnabled:true,keepAwake:false});
 const originalToken=await readFile(join(state,'admin-token'),'utf8');
 await writeFile(join(state,'preserve-upgrade-sentinel'),'synthetic user data');
 const attempt=join(state,'app-update','attempt-integration');await mkdir(attempt,{recursive:true});
 await cp(process.execPath,join(attempt,'node.exe'));
 for(const name of ['windows-updater.js','app-updater.js'])await cp(resolve('dist',name),join(attempt,name));
 await writeFile(join(attempt,'package.json'),'{"type":"module"}');
 await writeFile(join(attempt,'request.json'),JSON.stringify({app,state,port,version:newVersion,current:oldVersion,uiPid:oldUI.pid}));
 const name=`FarFromDesk-${newVersion}-windows-x64-setup.exe`,url=`https://github.com/LazyCodeer/farfromdesk/releases/download/v${newVersion}/${name}`;
 const candidate=resolve(newSetup),size=(await stat(candidate)).size;
 const hash=createHash('sha256');for await(const chunk of createReadStream(candidate))hash.update(chunk);const digest=hash.digest('hex');
 const metadata={tag_name:'v'+newVersion,draft:false,prerelease:false,assets:[{name,state:'uploaded',size,browser_download_url:url},{name:name+'.sha256',state:'uploaded',browser_download_url:url+'.sha256'}]};
 await writeFile(join(attempt,'fixture.json'),JSON.stringify({candidate,size,digest,name,metadata}));
 await writeFile(join(attempt,'trial.mjs'),`import {readFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';import {Readable} from 'node:stream';
import {runWindowsUpdate} from './windows-updater.js';import {download} from './app-updater.js';
const f=JSON.parse(await readFile(new URL('./fixture.json',import.meta.url),'utf8'));
await runWindowsUpdate(process.argv[2],{small:async url=>url.endsWith('.sha256')?f.digest+'  '+f.name:JSON.stringify(f.metadata),download:(url,file,size,progress)=>download(url,file,size,progress,async()=>new Response(Readable.toWeb(createReadStream(f.candidate))))});`);
 const updater=spawn(join(attempt,'node.exe'),[join(attempt,'trial.mjs'),join(attempt,'request.json')],{env,cwd:attempt,stdio:'inherit'});
 const started=Date.now();
 const [code]=await once(updater,'exit');assert.equal(code,0);
 const result=JSON.parse(await readFile(join(state,'app-update','status.json'),'utf8'));assert.equal(result.phase,'complete',result.message);
 const after=await healthy(newVersion);assert.notEqual(after.pid,before.pid);
 assert.equal((await api('/api/status')).preferences.backgroundEnabled,true);
 assert.equal(await readFile(join(state,'admin-token'),'utf8'),originalToken);
 assert.equal(await readFile(join(state,'preserve-upgrade-sentinel'),'utf8'),'synthetic user data');
 assert.ok((await stat(join(attempt,'before-update.sqlite'))).size>0);
 assert.ok((await stat(join(attempt,'previous','farfromdesk.exe'))).size>0);
 const installed=powershell(`$e=Get-ItemProperty ('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+$env:FFD_TEST_KEY);@{version=$e.DisplayVersion;path=$e.InstallLocation}|ConvertTo-Json -Compress`,{FFD_TEST_KEY:uninstallKey});
 const entry=JSON.parse(installed);assert.equal(entry.version,newVersion);assert.equal(entry.path.replace(/\\$/,''),app);
 const shortcut=powershell(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'FarFromDesk\\FarFromDesk.lnk'));$s.TargetPath`).trim();
 assert.equal(shortcut,join(app,'farfromdesk.exe'));
 console.log(JSON.stringify({passed:true,oldVersion,newVersion,elapsedMs:Date.now()-started,oldPid:before.pid,newPid:after.pid,root},null,2));
} finally {
 // Only this disposable app/state. Never a global taskkill node.exe or user-data deletion.
 await api('/api/shutdown',{}).catch(()=>{});await wait(2000);
 powershell(`Get-Process farfromdesk -ErrorAction SilentlyContinue|Where-Object {$_.Path -eq $env:FFD_TEST_EXE}|ForEach-Object {$_.CloseMainWindow()|Out-Null}`,{FFD_TEST_EXE:join(app,'farfromdesk.exe')});
 await wait(2000);
 try{execFileSync(join(app,'unins000.exe'),['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART'],{timeout:120000});}catch(e){console.error('Disposable test uninstall failed:',e.message);}
 console.log('Disposable upgrade evidence retained at '+root);
}
