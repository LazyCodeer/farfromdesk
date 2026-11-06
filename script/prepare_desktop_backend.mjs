import { pruneDesktopBackend, pruneDevelopmentFiles } from './prune_desktop_backend.mjs';
import { cpSync, mkdirSync, copyFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=resolve(import.meta.dirname,'..'),target=join(root,'build','desktop-backend');
rmSync(target,{recursive:true,force:true});mkdirSync(target,{recursive:true});
for(const file of ['package.json','package-lock.json','LICENSE','THIRD_PARTY_NOTICES.md'])copyFileSync(join(root,file),join(target,file));
cpSync(join(root,'dist'),join(target,'dist'),{recursive:true});
// Retain the existing Mac desktop transport and its helpers.
if(process.platform==='darwin') {
  cpSync(join(root,'native'),join(target,'native'),{recursive:true});
  if(process.env.FFD_LOCAL_BUILD==='1')for(const helper of ['local-mail-keychain','local-mail-approval']){
    const result=spawnSync('/usr/bin/swiftc',[join(root,'native',helper+'.swift'),'-o',join(target,'native',helper)],{stdio:'inherit'});
    if(result.status!==0)throw new Error('Could not build the Local email helper.');
  }
  if(process.env.FFD_LOCAL_BUILD==='1'){
    const eventkit=spawnSync('/usr/bin/swiftc',[join(root,'native','eventkit-helper.swift'),'-O','-framework','EventKit','-Xlinker','-sectcreate','-Xlinker','__TEXT','-Xlinker','__info_plist','-Xlinker',join(root,'native','eventkit-helper-Info.plist'),'-o',join(target,'native','eventkit-helper')],{stdio:'inherit'});
    if(eventkit.status!==0)throw new Error('Could not build the Calendar and Reminders helper.');
  }
  const ax=spawnSync('python3',[join(root,'script/build_accessibility_helper.py'),join(target,'native'),...(process.env.FFD_LOCAL_BUILD==='1'?['--bundle-id','com.codecylabs.farfromdesk.localtest.accessibility']:[])],{stdio:'inherit'});
  if(ax.status!==0)throw new Error('Could not build the macOS Accessibility helper.');
  const driver=spawnSync('python3',[join(root,'script/prepare_desktop_driver.py'),join(target,'native/cua-driver')],{stdio:'inherit'});
  if(driver.status!==0)throw new Error('Could not verify and bundle the desktop driver.');
} else {
  // Windows and Linux desktop control: one script each over the OS accessibility layer.
  mkdirSync(join(target,'native'));
  copyFileSync(join(root,'native',process.platform==='win32'?'desktop-windows.ps1':'desktop-linux.py'),join(target,'native',process.platform==='win32'?'desktop-windows.ps1':'desktop-linux.py'));
  // Windows phone screen control: the capture and input helper (src/remote-p2p/windows-desktop.ts).
  if(process.platform==='win32')copyFileSync(join(root,'native','remote-windows.ps1'),join(target,'native','remote-windows.ps1'));
  // Local email on Windows: the Credential Manager broker and the send approval prompt.
  if(process.platform==='win32'&&process.env.FFD_LOCAL_BUILD==='1')for(const helper of ['local-mail-credentials.ps1','local-mail-approval.ps1'])copyFileSync(join(root,'native',helper),join(target,'native',helper));
  // Windows Claude Desktop and Codex Desktop sessions: desktop-sync runs these under Python (src/desktop-apps.ts).
  if(process.platform==='win32')for(const file of ['desktop_sync.py','codex_delivery.py'])copyFileSync(join(root,'native',file),join(target,'native',file));
}
cpSync(join(root,'skills'),join(target,'skills'),{recursive:true});
// npm's CLI JavaScript is available beside npm on official Node installations.
// Invoke the known CLI through Node to avoid Windows shell interpolation.
const npmCli=process.env.npm_execpath;
if(!npmCli)throw new Error('Run through npm run desktop:backend so npm_execpath is provided.');
const result=spawnSync(process.execPath,[npmCli,'ci','--omit=dev','--no-audit','--no-fund'],{cwd:target,stdio:'inherit'});
if(result.status!==0)process.exit(result.status??1);
const pruned=pruneDesktopBackend(target);
const development=pruneDevelopmentFiles(target);
console.log(`Removed development-only files: ${(development.removedBytes/1024/1024).toFixed(1)} MiB.`);
console.log(`Removed unused bundled Claude CLI packages: ${(pruned.removedBytes/1024/1024).toFixed(1)} MiB; installed native CLI remains required.`);
mkdirSync(join(target,'runtime'));copyFileSync(process.execPath,join(target,'runtime',process.platform==='win32'?'node.exe':'node'));
// Preserve Node's complete upstream license alongside the executable.
const nodeLicense=await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,{signal:AbortSignal.timeout(30000)});
if(!nodeLicense.ok)throw new Error('Could not obtain the pinned Node runtime license.');
const licenseText=await nodeLicense.text();
if(!licenseText.includes('Node.js')||licenseText.length<10000)throw new Error('Unexpected Node license response.');
writeFileSync(join(target,'runtime','Node-LICENSE.txt'),licenseText);
console.log('Prepared backend and native Node runtime for '+process.platform+'/'+process.arch);

const speechSource=join(root,'build',process.arch==='arm64'?'speech-runtime':'speech-runtime-x86_64');
// A development build (flutter run against build/desktop-backend) does not need the
// speech runtime, which takes a long native build. Packaging still refuses to run
// without build/speech, so this cannot ship an installer that lacks voice notes.
const devWithoutSpeech=process.env.FFD_DESKTOP_NO_SPEECH==='1';
if(existsSync(join(speechSource,'manifest.json'))){
  rmSync(join(root,'build','speech'),{recursive:true,force:true});
  cpSync(speechSource,join(root,'build','speech'),{recursive:true});
}else if(devWithoutSpeech)console.warn('FFD_DESKTOP_NO_SPEECH=1: development backend without the bundled speech runtime. Voice notes stay unavailable, and packaging will refuse until it is built.');
else throw new Error('Build the bundled speech runtime (python script/build_speech_runtime.py) before packaging the desktop backend, or set FFD_DESKTOP_NO_SPEECH=1 for a development build without voice notes.');

const revision=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'});
if(revision.status!==0)throw new Error('A committed source revision is required.');
writeFileSync(join(target,'build.json'),JSON.stringify({sourceCommit:revision.stdout.trim()}));
