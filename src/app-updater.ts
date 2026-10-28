/** Owner-clicked macOS updater. No provider SDKs, shell interpolation or account switching. */
import {createHash} from 'node:crypto';
import {access,cp,lstat,mkdir,open,readFile,readdir,realpath,rename,rm,stat,statfs,writeFile} from 'node:fs/promises';
import {constants,createWriteStream} from 'node:fs';
import {basename,dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export const repository='LazyCodeer/farfromdesk';
export type UpdateProgress={phase:string;message:string;received?:number;total?:number;version?:string;pid?:number};
export function version(value:string) {
 const m=/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(value);
 if(!m)throw new Error('Invalid update version.');
 return {core:m.slice(1,4).map(Number),pre:m[4]?.split('.')??[]};
}
export function newer(candidate:string,current:string) {
 const a=version(candidate),b=version(current);
 for(let i=0;i<3;i++)if(a.core[i]!==b.core[i])return a.core[i]>b.core[i];
 // A local build already includes the public base version; never replace it with that release.
 if(b.pre[0]==='local')return false;
 if(!a.pre.length||!b.pre.length)return !a.pre.length&&!!b.pre.length;
 for(let i=0;i<Math.min(a.pre.length,b.pre.length);i++){
  if(a.pre[i]===b.pre[i])continue;
  const x=/^\d+$/.test(a.pre[i]),y=/^\d+$/.test(b.pre[i]);
  return x&&y?Number(a.pre[i])>Number(b.pre[i]):x!==y?!x:a.pre[i]>b.pre[i];
 }
 return a.pre.length>b.pre.length;
}
export function releaseAsset(data:any,requested:string,current:string,arch:string,platform: "macos" | "windows" = "macos") {
 if(platform==="windows" && arch!=="x64")throw new Error("No compatible Windows installer is available.");
 if(!['arm64','x64'].includes(arch)||!newer(requested,current))throw new Error('This release is not newer than your installed app.');
 if((version(current).pre.length===0||version(current).pre[0]==='local')&&version(requested).pre.length)throw new Error('Stable installations do not install preview releases.');
 const tag=data?.tag_name;
 if(!['v'+requested,requested].includes(tag)||data.draft!==false||!Array.isArray(data.assets))throw new Error('Release is unavailable.');
 if(!version(requested).pre.length&&data.prerelease!==false)throw new Error('Release channel does not match.');
 const name=platform==="windows"?`FarFromDesk-${requested}-windows-x64-setup.exe`:`FarFromDesk-${requested}-macos-${arch}.zip`,url=`https://github.com/${repository}/releases/download/${tag}/${name}`;
 const match=(n:string,u:string)=>data.assets.filter((a:any)=>a.name===n&&a.state==='uploaded'&&a.browser_download_url===u);
 const assets=match(name,url),sums=match(name+'.sha256',url+'.sha256');
 if(assets.length!==1||sums.length!==1||!Number.isSafeInteger(assets[0].size)||assets[0].size<=0||assets[0].size>2*1024**3)throw new Error('A complete compatible update is not available.');
 return {name,url,bytes:assets[0].size as number,checksumUrl:url+'.sha256'};
}
export function checksum(text:string,name:string) {
 const lines=text.trim().split(/\r?\n/);if(lines.length!==1)throw new Error('Invalid update checksum.');
 const m=/^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(lines[0]);
 if(!m||m[2]!==name)throw new Error('Update checksum does not identify this package.');return m[1].toLowerCase();
}
export function safeArchiveNames(names:string[]) {
 if(!names.length||names.length>100000)throw new Error('Invalid update archive.');
 for(const name of names){
  if(isAbsolute(name)||name.includes('\\')||name.split('/').some(p=>p==='..')||!['FarFromDesk.app','__MACOSX'].includes(name.split('/')[0]))throw new Error('Unsafe path in update archive.');
 }
}
export function machoArchitectures(header:Buffer):string[] {
 if(header.length<8)throw new Error('Invalid Mac executable header.');
 const magic=header.readUInt32BE(0),thin=[0xfeedfacf,0xcffaedfe],fat=[0xcafebabe,0xbebafeca,0xcafebabf,0xbfbafeca];
 const little=[0xcffaedfe,0xbebafeca,0xbfbafeca].includes(magic);
 const word=(offset:number)=>little?header.readUInt32LE(offset):header.readUInt32BE(offset);
 const name=(cpu:number)=>cpu===0x0100000c?'arm64':cpu===0x01000007?'x86_64':'unsupported';
 if(thin.includes(magic))return [name(word(4))];
 if(!fat.includes(magic))throw new Error('Update does not contain a Mac executable.');
 const count=word(4),stride=[0xcafebabf,0xbfbafeca].includes(magic)?32:20;
 if(count<1||count>32||8+count*stride>header.length)throw new Error('Invalid universal executable header.');
 return Array.from({length:count},(_,i)=>name(word(8+i*stride)));
}
async function executableArchitectures(path:string) {
 const file=await open(path,'r');try{const header=Buffer.alloc(4096);const {bytesRead}=await file.read(header,0,header.length,0);return machoArchitectures(header.subarray(0,bytesRead));}finally{await file.close();}
}
export function unpackedSize(summary:string) {
 const m=/([\d]+) bytes uncompressed/.exec(summary);if(!m)throw new Error('Cannot verify unpacked update size.');
 const bytes=Number(m[1]);if(!Number.isSafeInteger(bytes)||bytes<=0||bytes>3*1024**3)throw new Error('Unpacked update is too large.');return bytes;
}
export async function extractArchive(archive:string,stage:string) {
 safeArchiveNames((await command('/usr/bin/unzip',['-Z1',archive])).split('\n'));
 const sandboxPath=JSON.stringify(await realpath(stage));
 await command('/usr/bin/sandbox-exec',['-p',`(version 1)(allow default)(deny file-write*)(allow file-write* (subpath ${sandboxPath}))`,'/usr/bin/ditto','-x','-k',archive,stage]);
}
function trustedDownload(url:URL) {return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(url.hostname);}
export async function publicResponse(url:string,signal:AbortSignal,fetcher:typeof fetch=fetch) {
 let target=new URL(url);
 for(let n=0;n<6;n++){
  if(!trustedDownload(target)&&!(n===0&&target.origin==='https://api.github.com'))throw new Error('Untrusted update download location.');
  const response=await fetcher(target,{redirect:'manual',signal,headers:{'User-Agent':'FarFromDesk-updater','Accept':target.hostname==='api.github.com'?'application/vnd.github+json':'application/octet-stream'}});
  if([301,302,303,307,308].includes(response.status)){
   const next=response.headers.get('location');await response.body?.cancel();if(!next)throw new Error('Update redirect missing.');target=new URL(next,target);continue;
  }
  if(!response.ok){await response.body?.cancel();throw new Error(`Update server returned ${response.status}. Try again later.`);}return response;
 }
 throw new Error('Too many update redirects.');
}
export async function small(url:string,limit:number) {
 const response=await publicResponse(url,AbortSignal.timeout(20000));const chunks:Uint8Array[]=[];let size=0;
 for await(const chunk of response.body!){size+=chunk.length;if(size>limit)throw new Error('Update metadata too large.');chunks.push(chunk);}
 return Buffer.concat(chunks).toString('utf8');
}
export async function download(url:string,file:string,bytes:number,progress:(n:number)=>Promise<void>,fetcher:typeof fetch=fetch) {
 const response=await publicResponse(url,AbortSignal.timeout(20*60*1000),fetcher);const out=createWriteStream(file,{flags:'wx',mode:0o600});
 const hash=createHash('sha256');let count=0,last=0;
 // Explicit completion observes disk-full errors as well as network failures.
 const done=new Promise<void>((resolve,reject)=>{out.on('finish',resolve);out.on('error',reject);});void done.catch(()=>{});
 try{for await(const part of response.body!){count+=part.length;if(count>bytes)throw new Error('Update exceeded its advertised size.');hash.update(part);if(!out.write(part))await new Promise<void>((r,j)=>{const drain=()=>{out.off('error',error);r();};const error=(e:Error)=>{out.off('drain',drain);j(e);};out.once('drain',drain);out.once('error',error);});if(Date.now()-last>500){await progress(count);last=Date.now();}}
 out.end();await done;if(count!==bytes)throw new Error('Update download was incomplete.');return hash.digest('hex');
 }catch(e){out.destroy();throw e;}
}
async function command(binary:string,args:string[]) {return (await exec(binary,args,{timeout:120000,maxBuffer:16*1024*1024})).stdout.trim();}
async function plist(app:string,key:string){return command('/usr/libexec/PlistBuddy',['-c',`Print :${key}`,join(app,'Contents/Info.plist')]);}
async function signature(app:string){const {stderr}=await exec('/usr/bin/codesign',['-dv','--verbose=4',app]);return /TeamIdentifier=(.+)/.exec(stderr)?.[1];}
async function validateLinks(root:string) {
 if(!(await lstat(root)).isDirectory()||(await realpath(root))!==root)throw new Error('Update app root must be a real directory.');
 async function walk(dir:string):Promise<void>{for(const entry of await readdir(dir,{withFileTypes:true})){const p=join(dir,entry.name);if(entry.isSymbolicLink()){const target=await realpath(p);if(!target.startsWith(root+'/'))throw new Error('Update contains a link outside its app bundle.');}else if(entry.isDirectory())await walk(p);}}
 await walk(root);
}
export async function swapBundle(staged:string,app:string,previous:string,launch:()=>Promise<void>) {
 await rename(app,previous);
 try{await rename(staged,app);}catch(e){await rename(previous,app);throw e;}
 try{await launch();}catch(e){await rename(app,staged);await rename(previous,app);throw e;}
}
export async function runUpdate(requestFile:string) {
 process.umask(0o077);
 const request=JSON.parse(await readFile(requestFile,'utf8')) as {app:string;state:string;port:number;version:string;current:string;uiPid:number};
 const app=resolve(request.app),state=await realpath(request.state),directory=join(state,'app-update');
 const output=join(directory,'status.json'),lock=join(directory,'lock');
 const report=async(p:UpdateProgress)=>{await writeFile(output+'.tmp',JSON.stringify({...p,version:request.version,pid:process.pid}),{mode:0o600});await rename(output+'.tmp',output);};
 if(process.platform!=='darwin')throw new Error('Automatic installation is currently available on macOS.');
 if(basename(app)!=='FarFromDesk.app'||(await lstat(app)).isSymbolicLink())throw new Error('Install FarFromDesk in a writable Applications folder first.');
 if(!Number.isInteger(request.port)||request.port<1||request.port>65535||!Number.isInteger(request.uiPid)||request.uiPid<=1)throw new Error('Invalid running app identity.');
 await mkdir(directory,{recursive:true,mode:0o700});
 try{await mkdir(lock,{mode:0o700});}catch{throw new Error('An update is already in progress. Check the update status before retrying.');}
 let shutDown=false,swapped=false,ownedStage=false;
 const stage=join(dirname(app),'.FarFromDesk-update-stage'),previous=join(dirname(app),'.FarFromDesk-previous.app');
 const local=async(path:string,body?:object)=>{
  const token=(await readFile(join(state,'admin-token'),'utf8')).trim();
  const response=await fetch(`http://127.0.0.1:${request.port}${path}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(10000)});
  const data=await response.json() as any;if(!response.ok)throw new Error(data.error??'The app could not prepare for updating.');return data;
 };
 try {
  await report({phase:'checking',message:'Checking the update package…'});
  const originalApp=await stat(app);
  const installedMeta=JSON.parse(await readFile(join(app,'Contents/Resources/backend/build.json'),'utf8'));
  const actualVersion=installedMeta.buildId??await plist(app,'CFBundleShortVersionString');
  if(actualVersion!==request.current)throw new Error('The installed version changed. Reopen the app before updating.');
  await access(dirname(app),constants.W_OK);await access(app,constants.W_OK);
  const executable=join(app,'Contents/MacOS/FarFromDesk');
  if(await command('/bin/ps',['-p',String(request.uiPid),'-o','comm='])!==executable)throw new Error('The running app changed. Reopen FarFromDesk and try again.');
  const disk=await statfs(dirname(app));
  const release=JSON.parse(await small(`https://api.github.com/repos/${repository}/releases/tags/v${request.version}`,512*1024));
  const asset=releaseAsset(release,request.version,request.current,process.arch==='arm64'?'arm64':'x64');
  if(disk.bavail*disk.bsize<asset.bytes*4+512*1024**2)throw new Error('Free more disk space before installing this update.');
  const expected=checksum(await small(asset.checksumUrl,4096),asset.name),archive=join(directory,'package.zip');
  await rm(archive,{force:true});
  const actual=await download(asset.url,archive,asset.bytes,n=>report({phase:'downloading',message:'Downloading update…',received:n,total:asset.bytes}));
  if(actual!==expected)throw new Error('The update checksum did not match. Nothing was installed.');
  await report({phase:'verifying',message:'Verifying the downloaded app…'});
  const expanded=unpackedSize(await command('/usr/bin/unzip',['-Z','-t',archive]));
  const free=await statfs(dirname(app));if(free.bavail*free.bsize<expanded+512*1024**2)throw new Error('Not enough free space to unpack the update.');
  if(await stat(stage).then(()=>true,()=>false))throw new Error('An earlier update stage remains. Recover it before trying another installation.');
  await mkdir(stage,{mode:0o700});ownedStage=true;
  await extractArchive(archive,stage);
  const staged=join(stage,'FarFromDesk.app');await validateLinks(staged);
  await command('/usr/bin/codesign',['--verify','--deep','--strict',staged]);
  if(await plist(staged,'CFBundleIdentifier')!==await plist(app,'CFBundleIdentifier'))throw new Error('The downloaded app has a different identity.');
  if(await plist(staged,'CFBundleShortVersionString')!==version(request.version).core.join('.'))throw new Error('The downloaded app version does not match the release.');
  const team=await signature(app),newTeam=await signature(staged);
  if(team&&team!=='not set'&&newTeam!==team)throw new Error('The update is signed by a different publisher.');
  const architecture=process.arch==='arm64'?'arm64':'x86_64';
  if(!(await executableArchitectures(join(staged,'Contents/MacOS/FarFromDesk'))).includes(architecture))throw new Error('Update architecture does not match this Mac.');
  await access(join(staged,'Contents/Resources/backend/dist/main.js'));await access(join(staged,'Contents/Resources/backend/runtime/node'),constants.X_OK);
  const expectedCommit=JSON.parse(await readFile(join(staged,'Contents/Resources/backend/build.json'),'utf8')).sourceCommit;
  if(typeof expectedCommit!=='string'||!expectedCommit)throw new Error('Update build identity is missing.');
  await report({phase:'preparing',message:'Saving state and preparing to restart…'});
  // This authenticated endpoint checks active work and stops dispatch atomically.
  const health=await local('/api/health');
  const backendCmd=await command('/bin/ps',['-p',String(health.pid),'-o','command=']);
  if(!backendCmd.startsWith(join(app,'Contents/Resources/backend/runtime/node')+' '))throw new Error('Another installation is running. Close it before updating.');
  const currentApp=await stat(app);
  if(currentApp.ino!==originalApp.ino||currentApp.dev!==originalApp.dev)throw new Error('The app was replaced while downloading. Check for updates again.');
  const uiPids=(await command('/bin/ps',['-axo','pid=,comm='])).split('\n').flatMap(row=>{const m=/^\s*(\d+)\s+(.+)$/.exec(row);return m&&m[2]===executable?[Number(m[1])]:[];});
  await local('/api/update-shutdown',{});shutDown=true;
  for(let i=0;i<100;i++){try{process.kill(health.pid,0);}catch{break;}if(i===99)throw new Error('The app backend did not stop.');await new Promise(r=>setTimeout(r,100));}
  // Preserve the durable request ledger before the next build can migrate it. Pairing/media remain untouched.
  await cp(join(state,'bridge.sqlite'),join(directory,'before-update.sqlite'));
  for(const uiPid of uiPids){
   try{process.kill(uiPid,'SIGTERM');}catch{}
   for(let i=0;i<100;i++){try{process.kill(uiPid,0);}catch{break;}if(i===99)throw new Error('The app window did not close.');await new Promise(r=>setTimeout(r,100));}
  }
  await rm(previous,{recursive:true,force:true});
  await report({phase:'installing',message:'Installing update and restarting FarFromDesk…'});
  await swapBundle(staged,app,previous,async()=>{await command('/usr/bin/open',[app]);});swapped=true;
  await report({phase:'restarting',message:'Waiting for FarFromDesk to reconnect…'});
  for(let i=0;i<90;i++){
   try{const h=await local('/api/health');if(h.pid!==health.pid&&h.sourceCommit===expectedCommit&&h.buildId===request.version){await report({phase:'complete',message:'Update installed successfully.'});await rm(archive,{force:true});await rm(stage,{recursive:true,force:true});return;}}catch{}
   await new Promise(r=>setTimeout(r,1000));
  }
  throw new Error('Update installed, but restart could not be confirmed. Reopen FarFromDesk; the previous app and request backup are retained.');
 }catch(e){
  if(!swapped){if(ownedStage)await rm(stage,{recursive:true,force:true});await rm(join(directory,'package.zip'),{force:true});if(shutDown)await command('/usr/bin/open',[app]).catch(()=>{});}
  await report({phase:'error',message:e instanceof Error?e.message:'Update failed. Your existing app and data have been retained.'});
 }finally{await rm(lock,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.argv[2]==='--run') {
 runUpdate(process.argv[3]).catch(e=>{console.error(e instanceof Error?e.message:'Update failed');process.exitCode=1;});
}
