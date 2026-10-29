import {closeSync,constants,fstatSync,lstatSync,openSync,readSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import type {ErrandContract,ErrandScope} from './errand-missions.js';
import type {Store} from './store.js';

const MAX_PROFILE_BYTES=32000,MAX_PROFILE_CHARS=8000,MAX_LINE=300,MAX_NOTES=3,MAX_CANDIDATE_LINES=64;
const unsafe=/[\x00-\x1f\x7f\u0085\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const secret=/\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{16,}|xox[baprs]-[a-z0-9-]{12,}|AKIA[A-Z0-9]{16}|bearer|api[ _-]?key|password|private[ _-]?key|secret|token|credential|passphrase|recovery[ _-]?code|seed[ _-]?phrase|authorization)\b|\b[a-z0-9_-]{32,}\b/i;
const generic=new Set(['senior','junior','lead','staff','principal','engineer','engineering','developer','development','manager','position','remote','hybrid','role','the','and','for','with']);
export type ErrandProfileSnapshot={text:string;revision:string};

/** Fixed About-you file only. Never creates memory or follows a final symlink. */
export function readErrandProfile(dir:string):ErrandProfileSnapshot|undefined {
  if(process.platform==='win32'||typeof constants.O_NOFOLLOW!=='number')return;
  let fd:number|undefined;
  try{
    const root=resolve(dir);if(realpathSync(root)!==root)return;
    const parent=lstatSync(root,{bigint:true});if(!parent.isDirectory()||parent.isSymbolicLink())return;
    const path=join(root,'about-me.md'),before=lstatSync(path,{bigint:true});
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>BigInt(MAX_PROFILE_BYTES))return;
    if(typeof process.getuid==='function'&&(before.uid!==BigInt(process.getuid())||parent.uid!==BigInt(process.getuid())))return;
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const opened=fstatSync(fd,{bigint:true});
    const same=(a:typeof before,b:typeof before)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&a.nlink===b.nlink;
    if(!opened.isFile()||!same(before,opened))return;
    const data=Buffer.alloc(MAX_PROFILE_BYTES+1);let size=0,n=0;
    do{n=readSync(fd,data,size,data.length-size,null);size+=n;}while(n&&size<data.length);
    const after=fstatSync(fd,{bigint:true}),pathAfter=lstatSync(path,{bigint:true}),parentAfter=lstatSync(root,{bigint:true});
    if(size>MAX_PROFILE_BYTES||BigInt(size)!==opened.size||!same(opened,after)||!same(opened,pathAfter)||parent.dev!==parentAfter.dev||parent.ino!==parentAfter.ino||parent.ctimeNs!==parentAfter.ctimeNs||realpathSync(root)!==root)return;
    const text=new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(0,size));if(text.length>MAX_PROFILE_CHARS)return;
    const revision=createHash('sha256').update(JSON.stringify([String(opened.dev),String(opened.ino),String(opened.size),String(opened.mtimeNs),String(opened.ctimeNs),String(parent.dev),String(parent.ino),String(parent.ctimeNs)])).update('\0').update(text).digest('hex');
    return {text,revision};
  }catch{return;}finally{if(fd!==undefined)closeSync(fd);}
}

/** Return only complete lines traceable to an exact direct owner text turn. */
export function readOwnedErrandProfile(store:Store,scope:ErrandScope,dir:string,contract:ErrandContract):ErrandProfileSnapshot|undefined {
  if(scope.owner!==scope.destination||store.controlChannel()!=='whatsapp'||store.ownerFor(scope.destination)!==scope.owner)return;
  const snapshot=readErrandProfile(dir);if(!snapshot)return;
  const history=store.db.prepare(`SELECT id,source,CASE WHEN length(before)<=8000 THEN before ELSE NULL END AS before,
    CASE WHEN length(after)<=8000 THEN after ELSE NULL END AS after,
    (COALESCE(length(before),0)>8000 OR COALESCE(length(after),0)>8000) AS invalid
    FROM owner_memory_history WHERE path='about-me.md' ORDER BY id DESC LIMIT 500`).all() as {id:number;source:string;before:string|null;after:string|null;invalid:number}[];
  if(!history.length||history[0].invalid||history[0].after!==snapshot.text)return;
  const split=(value:string|null)=>value===null?[]:value.split(/\r\n|\r|\n/);
  const counts=(lines:string[])=>{const result=new Map<string,number>();for(const line of lines)result.set(line,(result.get(line)??0)+1);return result;};
  const current=split(snapshot.text),currentCounts=counts(current),candidate=selectErrandProfileNotes(snapshot.text,contract,MAX_CANDIDATE_LINES),pending=new Set(candidate.filter(line=>currentCounts.get(line)===1)),allowed=new Set<string>();
  let expected:string|null=snapshot.text;
  for(const row of history){
    if(row.invalid||row.after!==expected||(row.before!==null&&row.before.length>MAX_PROFILE_CHARS)||(row.after!==null&&row.after.length>MAX_PROFILE_CHARS))return;
    const before=counts(split(row.before)),after=counts(split(row.after));
    for(const line of pending){
      if(after.get(line)!==1){pending.delete(line);continue;}
      const count=before.get(line)??0;
      if(count>1){pending.delete(line);continue;}
      if(count===0){
        pending.delete(line);
        if(!row.source.startsWith('brain:wa:'))continue;
        const id=row.source.slice('brain:'.length),input=store.db.prepare('SELECT owner,destination,generation,body_hash,eligible FROM errand_profile_inputs WHERE request_id=?').get(id) as {owner:string;destination:string;generation:string;body_hash:string;eligible:number}|undefined,origin=store.db.prepare('SELECT owner,destination FROM owner_request_origins WHERE request_id=?').get(id) as {owner:string;destination:string}|undefined;
        const turn=store.db.prepare('SELECT original,source,destination FROM brain_tasks WHERE id=?').get(id) as {original:string;source:string;destination:string|null}|undefined;
        if(store.get(`parent:${id}`)||store.get(`report-parent:${id}`)||!input||input.eligible!==1||input.owner!==scope.owner||input.destination!==scope.owner||input.generation!==(store.get('incoming-owner-generation')??'')||origin?.owner!==scope.owner||origin.destination!==scope.owner||turn?.source!=='text'||turn.destination!==scope.owner||input.body_hash!==createHash('sha256').update(turn.original).digest('hex'))continue;
        const exact=line.replace(/^\s*[-*]\s+/,'').trim();
        if(exact&&turn.original.length<=32000&&(turn.original.trim()===exact||turn.original.trim()===line.trim()))allowed.add(line);
      }
    }
    expected=row.before;if(!pending.size||expected===null)break;
  }
  const text=current.filter(line=>allowed.has(line)).slice(0,MAX_NOTES).join('\n');
  const revision=createHash('sha256').update(JSON.stringify([snapshot.revision,history[0].id,scope.owner,store.get('incoming-owner-generation')??'',text])).digest('hex');
  return {text,revision};
}

/** Select verbatim lines only; a match is not a claim, requirement or fit. */
export function selectErrandProfileNotes(profile:string,contract:ErrandContract,limit=MAX_NOTES):string[] {
  if(typeof profile!=='string'||profile.length>MAX_PROFILE_CHARS||Buffer.byteLength(profile)>MAX_PROFILE_BYTES)return [];
  const max=Math.max(0,Math.min(MAX_CANDIDATE_LINES,Math.floor(limit)));if(!max)return [];
  const roleTerms=contract.role.split(/[^\p{L}\p{N}+#.-]+/u);
  const terms=[...(contract.skills??[]),...roleTerms].filter(term=>term.length>=3&&term.length<=40&&!generic.has(term.toLocaleLowerCase()));
  const patterns=[...new Set(terms.map(term=>term.toLocaleLowerCase()))].map(term=>new RegExp(`(?:^|[^\\p{L}\\p{N}+#])${term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?=$|[^\\p{L}\\p{N}+#])`,'iu'));
  if(!patterns.length)return [];
  const lines=profile.split(/\r\n|\r|\n/),selected:string[]=[];
  for(const line of lines){
    if(!line.trim()||line.length>MAX_LINE||unsafe.test(line)||secret.test(line)||line.includes('```')||/^\s*#/.test(line)||/^\s*[-*]?\s*(?:name|call me|call the brain|replies|e-?mail|phone|address|passport|birth|ssn)\s*:/i.test(line))continue;
    if(patterns.some(pattern=>pattern.test(line))&&!selected.includes(line)){selected.push(line);if(selected.length===max)break;}
  }
  return selected;
}
