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
  cpSync(join(root,'skills'),join(target,'skills'),{recursive:true});
}
// npm's CLI JavaScript is available beside npm on official Node installations.
// Invoke the known CLI through Node to avoid Windows shell interpolation.
const npmCli=process.env.npm_execpath;
if(!npmCli)throw new Error('Run through npm run desktop:backend so npm_execpath is provided.');
const result=spawnSync(process.execPath,[npmCli,'ci','--omit=dev','--no-audit','--no-fund'],{cwd:target,stdio:'inherit'});
if(result.status!==0)process.exit(result.status??1);
mkdirSync(join(target,'runtime'));copyFileSync(process.execPath,join(target,'runtime',process.platform==='win32'?'node.exe':'node'));
console.log('Prepared backend and native Node runtime for '+process.platform+'/'+process.arch);

const speechSource=join(root,'build',process.arch==='arm64'?'speech-runtime':'speech-runtime-x86_64');
if(!existsSync(join(speechSource,'manifest.json')))throw new Error('Build the bundled speech runtime before packaging the desktop backend.');
rmSync(join(root,'build','speech'),{recursive:true,force:true});
cpSync(speechSource,join(root,'build','speech'),{recursive:true});

const revision=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'});
if(revision.status!==0)throw new Error('A committed source revision is required.');
writeFileSync(join(target,'build.json'),JSON.stringify({sourceCommit:revision.stdout.trim()}));
