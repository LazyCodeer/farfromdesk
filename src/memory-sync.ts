import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { safePath } from './settings-backup.js';

export type MemFile={text:string;at:number};
export type MemFiles=Record<string,MemFile>;
const hash=(f?:MemFile)=>f===undefined?'':createHash('sha256').update(f.text).digest('hex');

/** Three-way merge by path. One side changed: it wins. Both changed: the newer wins and the other is kept as .conflict.md. */
export function mergeMemory(base:Record<string,string>,local:MemFiles,remote:MemFiles):MemFiles {
  const out:MemFiles={};
  for(const p of new Set([...Object.keys(local),...Object.keys(remote)])){
    const l=local[p],r=remote[p],b=base[p]??'',lh=hash(l),rh=hash(r);
    if(lh===rh||rh===b){if(l)out[p]=l;continue;}
    if(lh===b){if(r)out[p]=r;continue;}
    // Both sides changed. A delete loses to an edit.
    const [win,lose]=!l?[r,l]:!r?[l,r]:l.at>=r.at?[l,r]:[r,l];
    out[p]=win!;
    if(lose)out[p.replace(/\.md$/,'.conflict.md')]=lose;
  }
  return out;
}
export const memoryHashes=(f:MemFiles)=>Object.fromEntries(Object.entries(f).map(([p,v])=>[p,hash(v)]));

export function readMemory(root:string):MemFiles {
  const out:MemFiles={};
  try{for(const f of readdirSync(join(root,'memory'),{recursive:true}) as string[]){
    const p='memory/'+f;if(!safePath(p))continue;
    const file=join(root,p);out[p]={text:readFileSync(file,'utf8'),at:statSync(file).mtimeMs};
  }}catch{}
  return out;
}

/** Makes the memory folder match `want`, touching only files that differ. */
export function writeMemory(root:string,have:MemFiles,want:MemFiles){
  for(const [p,f] of Object.entries(want)){
    if(!safePath(p)||have[p]?.text===f.text)continue;
    const file=join(root,p),partial=file+'.restore';
    mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileSync(partial,f.text,{mode:0o600});renameSync(partial,file);
  }
  for(const p of Object.keys(have))if(!(p in want)&&safePath(p))try{unlinkSync(join(root,p));}catch{}
}
