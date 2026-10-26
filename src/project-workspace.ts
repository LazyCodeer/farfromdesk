import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

function metadata(path:string) {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const st=fstatSync(fd);
    if(!st.isFile()||st.size>8192)throw new Error('Invalid Git metadata');
    return readFileSync(fd,'utf8').trim();
  }finally{closeSync(fd);}
}

// Git's worktree pointers identify the project even for worktrees outside it.
// Never infer a project from a folder merely named ".claude/worktrees".
export function projectWorkspace(path:string) {
  const cwd=realpathSync(path);
  if(!statSync(cwd).isDirectory())throw new Error('Workspace is not a folder');
  try {
    const gitFile=join(cwd,'.git'),pointer=metadata(gitFile);
    if(!pointer.startsWith('gitdir: '))return cwd;
    const gitdir=realpathSync(resolve(cwd,pointer.slice(8)));
    if(realpathSync(resolve(gitdir,metadata(join(gitdir,'gitdir'))))!==gitFile)return cwd;
    const common=realpathSync(resolve(gitdir,metadata(join(gitdir,'commondir'))));
    if(basename(common)!=='.git'||!statSync(common).isDirectory())return cwd;
    return dirname(common);
  }catch{return cwd;}
}
