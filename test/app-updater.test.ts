import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {newer,releaseAsset,checksum,safeArchiveNames,publicResponse,download,swapBundle,extractArchive,unpackedSize} from '../src/app-updater.js';
function release(v='0.8.0') {const name=`FarFromDesk-${v}-macos-arm64.zip`,url=`https://github.com/LazyCodeer/farfromdesk/releases/download/v${v}/${name}`;return {tag_name:'v'+v,draft:false,prerelease:false,assets:[{name,state:'uploaded',browser_download_url:url,size:3},{name:name+'.sha256',state:'uploaded',browser_download_url:url+'.sha256'}]};}
test('updater rejects same-base local downgrade, wrong channels, missing or foreign assets',()=>{
 assert.equal(newer('0.7.1','0.7.1-local.2022'),false);assert.equal(newer('0.7.2','0.7.1-local.2022'),true);
 assert.equal(newer('0.8.0-preview.10','0.8.0-preview.9'),true);
 assert.throws(()=>releaseAsset(release('0.7.1'),'0.7.1','0.7.1-local.2022','arm64'));
 assert.throws(()=>releaseAsset(release('0.8.0-preview.1'),'0.8.0-preview.1','0.7.1-local.2022','arm64'));
 assert.equal(releaseAsset(release(),'0.8.0','0.7.1','arm64').bytes,3);
 assert.throws(()=>releaseAsset(release(),'0.8.0','0.7.1','x64'));
 const bad=release();bad.assets[0].browser_download_url='https://evil.example/app.zip';assert.throws(()=>releaseAsset(bad,'0.8.0','0.7.1','arm64'));
 const missing=release();missing.assets.pop();assert.throws(()=>releaseAsset(missing,'0.8.0','0.7.1','arm64'));
});
test('checksum is tied to the exact filename and archive entries stay inside bundle',()=>{
 assert.equal(checksum('a'.repeat(64)+'  app.zip\n','app.zip'),'a'.repeat(64));
 assert.throws(()=>checksum('a'.repeat(64)+'  other.zip','app.zip'));
 for(const paths of [['/etc/passwd'],['FarFromDesk.app/../../outside'],['Other.app/a'],['FarFromDesk.app\\..\\x']])assert.throws(()=>safeArchiveNames(paths));
 safeArchiveNames(['FarFromDesk.app/Contents/Info.plist','__MACOSX/FarFromDesk.app/._Contents']);
});
test('redirects remain HTTPS and cannot forward to arbitrary hosts',async()=>{
 let count=0;const fake=(async()=>{count++;return new Response(null,{status:302,headers:{location:'https://evil.example/update'}});}) as typeof fetch;
 await assert.rejects(publicResponse('https://github.com/a',AbortSignal.timeout(1000),fake),/Untrusted/);assert.equal(count,1);
 await assert.rejects(publicResponse('http://github.com/a',AbortSignal.timeout(1000),fake),/Untrusted/);
});
test('streamed download checks actual byte count and hashes downloaded bytes',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'ffd-updater-download-'));
 try{
  const fake=(async()=>new Response('abc')) as typeof fetch;const progress:number[]=[];
  const digest=await download('https://github.com/a',join(temp,'good'),3,async n=>{progress.push(n);},fake);
  assert.equal(digest,createHash('sha256').update('abc').digest('hex'));assert.equal(await readFile(join(temp,'good'),'utf8'),'abc');assert.deepEqual(progress,[3]);
  await assert.rejects(download('https://github.com/a',join(temp,'short'),4,async()=>{},fake),/incomplete/);
  await assert.rejects(download('https://github.com/a',join(temp,'large'),2,async()=>{},fake),/exceeded/);
 }finally{await rm(temp,{recursive:true,force:true});}
});
test('bundle swap keeps previous app and restores it if launch cannot be submitted',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'ffd-updater-swap-')),app=join(temp,'app'),staged=join(temp,'staged'),old=join(temp,'old');
 try{
  await mkdir(app);await mkdir(staged);await writeFile(join(app,'version'),'old');await writeFile(join(staged,'version'),'new');
  await assert.rejects(swapBundle(staged,app,old,async()=>{throw new Error('launch failed');}),/launch failed/);
  assert.equal(await readFile(join(app,'version'),'utf8'),'old');assert.equal(await readFile(join(staged,'version'),'utf8'),'new');
  let launched=0;await swapBundle(staged,app,old,async()=>{launched++;});assert.equal(launched,1);
  assert.equal(await readFile(join(app,'version'),'utf8'),'new');assert.equal(await readFile(join(old,'version'),'utf8'),'old');
 }finally{await rm(temp,{recursive:true,force:true});}
});

test('macOS extraction is confined even when an archive traverses a symlink', {skip:process.platform!=='darwin'}, async()=>{
 const temp=await realpath(await mkdtemp(join(tmpdir(),'ffd-update-archive-'))),stage=join(temp,'stage'),outside=join(temp,'outside');await mkdir(stage);await mkdir(outside);
 const exec=promisify(execFile);
 try{
  const archive=join(temp,'test.zip');
  await exec('python3',['-c',`import zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('FarFromDesk.app/Contents/test.txt','hello')
`,archive]);
  assert.ok(unpackedSize((await exec('/usr/bin/unzip',['-Z','-t',archive])).stdout)>0);
  await extractArchive(archive,stage);assert.equal(await readFile(join(stage,'FarFromDesk.app/Contents/test.txt'),'utf8'),'hello');
  await rm(stage,{recursive:true});await mkdir(stage);
  await exec('python3',['-c',`import zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w') as z:
 i=zipfile.ZipInfo('FarFromDesk.app/link');i.create_system=3;i.external_attr=(0o120777<<16);z.writestr(i,sys.argv[2])
 z.writestr('FarFromDesk.app/link/escaped.txt','must not write')
`,archive,outside]);
  await extractArchive(archive,stage).catch(()=>{});
  await assert.rejects(readFile(join(outside,'escaped.txt')),/ENOENT/);
 }finally{await rm(temp,{recursive:true,force:true});}
});
