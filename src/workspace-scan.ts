import { realpathSync } from 'node:fs';
import { projectWorkspace } from './project-workspace.js';

// Same app identity and permissions as the parent. No permission overrides.
// A folder macOS denies (Documents, Desktop, iCloud, removable volumes) is skipped
// and reported, so one protected session never hides every other workspace.
let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{input+=chunk;if(input.length>4*1024*1024)process.exit(1);});
process.stdin.on('end',()=>{
  try {
    const paths=JSON.parse(input);
    if(!Array.isArray(paths)||paths.length>20000)throw new Error('Invalid input');
    const resolved=[],denied=[];
    for(const path of paths){
      if(typeof path!=='string')throw new Error('Invalid path');
      try{const sessionCwd=realpathSync(path);resolved.push([path,{sessionCwd,cwd:projectWorkspace(sessionCwd)}]);}
      catch(error:any){if(error?.code==='EPERM'||error?.code==='EACCES')denied.push(path);}
    }
    process.stdout.write(JSON.stringify({resolved,denied}));
  }catch{process.exitCode=1;}
});
