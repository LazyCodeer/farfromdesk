import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {accessSync,closeSync,constants,existsSync,lstatSync,mkdtempSync,mkdirSync,openSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {delimiter,dirname,join,relative,isAbsolute,sep} from 'node:path';

const PIN='14c213405669414492bda0f8d52cc6531d062c45';
const source=`git+https://github.com/Panniantong/Agent-Reach.git@${PIN}`;
const privateDir=(dir:string)=>{const v=lstatSync(dir);if(!v.isDirectory()||v.isSymbolicLink()||process.getuid&&v.uid!==process.getuid!()||(v.mode&0o077)!==0)throw Error('Research tool folders must be private real directories.');};
const below=(root:string,file:string)=>{const part=relative(root,file);return part!==''&&!isAbsolute(part)&&part!=='..'&&!part.startsWith(`..${sep}`);};
function executable(stage:string){
  privateDir(stage);const exe=join(stage,'bin','agent-reach'),resolved=realpathSync(exe);
  if(!below(realpathSync(stage),resolved))throw Error('Research executable is outside its installation.');
  const stat=lstatSync(resolved);if(!stat.isFile()||stat.size>1024*1024)throw Error('Research executable is invalid.');
  accessSync(exe,constants.X_OK);return {exe,digest:createHash('sha256').update(readFileSync(resolved)).digest('hex')};
}
/** An interrupted or unverified managed install must never shadow a trusted tool. */
export function managedAgentReach(stateRoot:string,allowSetupLock=false):string|undefined {
  const root=join(stateRoot,'agent-reach');try{lstatSync(root);}catch(e:any){if(e.code==='ENOENT')return;throw e;}
  try{
    privateDir(root);if(!allowSetupLock&&existsSync(join(root,'setup.lock')))throw Error('setup incomplete');
    const manifest=join(root,'manifest.json'),info=lstatSync(manifest);if(!info.isFile()||info.isSymbolicLink()||info.size>4096)throw Error('invalid manifest');
    const data=JSON.parse(readFileSync(manifest,'utf8'));
    if(data.pin!==PIN||typeof data.stage!=='string'||!/^install-[a-zA-Z0-9]+$/.test(data.stage)||typeof data.digest!=='string')throw Error('invalid manifest');
    const found=executable(join(root,data.stage));if(found.digest!==data.digest)throw Error('changed executable');return found.exe;
  }catch{throw Error('The managed research installation is incomplete or changed. Review its tool folder before trying again.');}
}

// The local supervisor owns the installer process group, a deadline, and a pipe
// whose other end is held by the caller. Caller death closes the pipe and kills
// the group, even if the caller was terminated without a cleanup handler.
const supervisor=`const net=require('node:net'),{spawn}=require('node:child_process');
const die=()=>{try{process.kill(-process.pid,'SIGKILL')}catch{process.exit(1)}};
const watch=new net.Socket({fd:3,readable:true,writable:true});watch.on('end',die);watch.on('error',die);watch.resume();
const child=spawn(process.argv[1],process.argv.slice(2),{stdio:'ignore'});
const timer=setTimeout(die,Number(process.env.FFD_SETUP_TIMEOUT));
child.on('error',die);child.on('exit',code=>{clearTimeout(timer);if(code===0)watch.write('ok',die);else die()});`;

/** Install only after an explicit local CLI invocation. Never invokes upstream setup. */
export async function setupAgentReach(stateRoot:string,options:{uv?:string;timeoutMs?:number}={}):Promise<string>{
  if(process.platform==='win32')throw Error('Public research setup is unavailable on Windows.');
  const state=lstatSync(stateRoot);if(!state.isDirectory()||state.isSymbolicLink())throw Error('Open FarFromDesk first; its state folder must be a real directory.');
  const root=join(realpathSync(stateRoot),'agent-reach');
  const paths=(process.env.PATH??'').split(delimiter).filter(isAbsolute);
  const uv=options.uv??paths.map(p=>join(p,'uv')).find(file=>{try{accessSync(file,constants.X_OK);return true;}catch{return false;}});
  // Do not hide an existing separately installed tool if setup cannot start.
  if(!uv&&!existsSync(root))throw Error('Install uv and Python 3.10 or newer first, then retry this local command.');
  try{mkdirSync(root,{mode:0o700});}catch(e:any){if(e.code!=='EEXIST')throw e;}privateDir(root);
  const lock=join(root,'setup.lock');let fd:number;
  try{fd=openSync(lock,'wx',0o600);}catch(e:any){if(e.code==='EEXIST')throw Error('Research setup is running or was interrupted. Review its tool folder before retrying.');throw e;}closeSync(fd);
  try {
    const manifest=join(root,'manifest.json');
    // Verify existing installs while holding the exclusive lock.
    if(existsSync(manifest)){
      managedAgentReach(stateRoot,true);return 'Research tool is already installed. No changes were made.';
    }
    if(!uv)throw Error('Install uv and Python 3.10 or newer first, then retry this local command.');
    const stage=mkdtempSync(join(root,'install-'));for(const dir of ['tools','bin','home','cache'])mkdirSync(join(stage,dir),{mode:0o700});
    await new Promise<void>((resolve,reject)=>{
      const child=spawn(process.execPath,['-e',supervisor,uv,'tool','install',source],{cwd:stage,env:{HOME:join(stage,'home'),PATH:[dirname(uv),'/usr/bin','/bin','/usr/local/bin','/opt/homebrew/bin'].join(delimiter),UV_TOOL_DIR:join(stage,'tools'),UV_TOOL_BIN_DIR:join(stage,'bin'),UV_CACHE_DIR:join(stage,'cache'),UV_NO_CONFIG:'1',UV_PYTHON_DOWNLOADS:'never',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',LANG:'C.UTF-8',FFD_SETUP_TIMEOUT:String(options.timeoutMs??180_000)},stdio:['ignore','ignore','ignore','pipe'],detached:true});
      let receipt='';child.stdio[3]?.on('data',chunk=>{receipt+=String(chunk).slice(0,3);});
      child.on('error',()=>reject(Error('Could not start the research installer.')));
      child.on('close',(_code,signal)=>receipt==='ok'&&signal==='SIGKILL'?resolve():reject(Error('Research setup failed or timed out. Check uv and Python 3.10+, then retry.')));
    });
    const {digest}=executable(stage);
    writeFileSync(manifest,JSON.stringify({pin:PIN,stage:stage.slice(root.length+1),digest}),{flag:'wx',mode:0o600});
    return 'Public GitHub and Exa web research installed. No browser setup or login was performed.';
  } finally {rmSync(lock,{force:true});}
}
