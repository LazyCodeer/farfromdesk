import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, lstatSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { defaultStateDirectory } from './platform.js';
import type { Store } from './store.js';

// The owner's memory: plain Markdown in one private folder. MEMORY.md and about-me.md are always read;
// the files the index lists are opened only when a message needs them. Sessions read; only owner words write.
export const MEMORY_INDEX='MEMORY.md',ABOUT_ME='about-me.md',COLLABORATION='collaboration.md';
// collaboration.md rides along because every new task is a routing decision.
export const ALWAYS=[MEMORY_INDEX,ABOUT_ME,COLLABORATION];
const MAX_FILE=8000,MAX_FILES=40;
const NAME=/^(?:MEMORY\.md|[a-z0-9][a-z0-9-]{0,40}(?:\/[a-z0-9][a-z0-9-]{0,40})?\.md)$/;
// A guard at the write boundary, not language understanding: obvious credentials never reach disk.
const SECRET=/\bsk-[a-z0-9]|\bapi[ _-]?key\b|\bpassw(?:or)?d\b|[A-Za-z0-9_\-]{32,}/i;
const DEFAULTS:Record<string,string>={
  [MEMORY_INDEX]:`# Memory index
Read this first. Open a file below only when the message needs it.

- [About you](about-me.md): name, what to call you and the brain, reply style
- [Words and names](words.md): terms, repos and people you mention
- [Preferences](preferences.md): when to message you, how much detail
- [Collaboration](collaboration.md): which platform or session handles which kind of work
`,
  [ABOUT_ME]:`# About you
- Name:
- Call me:
- Call the brain:
- Replies:
`,
  'words.md':'# Words and names\n',
  'preferences.md':'# Preferences\n',
  [COLLABORATION]:`# Collaboration
Which platform or session handles which kind of work. Read before handing work to another session.
One line per rule, for example "- Planning and review: Codex".
`,
};
const LISTED:Record<string,string>={[COLLABORATION]:'[Collaboration](collaboration.md): which platform or session handles which kind of work'};
export type MemoryChange={id:number;at:number;path:string;before:string|null;after:string|null;source:string;summary:string};

export class OwnerMemory {
  readonly dir:string;
  constructor(private store:Store,root=process.env.WSB_STATE_DIR??defaultStateDirectory(),notes='') {
    this.dir=join(root,'memory');
    store.db.exec('CREATE TABLE IF NOT EXISTS owner_memory_history(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,path TEXT NOT NULL,before TEXT,after TEXT,source TEXT NOT NULL,summary TEXT NOT NULL)');
    this.notes=notes;
  }
  private notes:string;private ready=false;
  // Created on first use, so constructing a router never touches the disk.
  private ensure() {
    if(this.ready)return;
    mkdirSync(this.dir,{recursive:true,mode:0o700});
    if(lstatSync(this.dir).isSymbolicLink())throw new Error('Memory storage must not be a symlink.');
    this.ready=true;
    for(const [path,text] of Object.entries(DEFAULTS))if(this.read(path)===undefined)this.write(path,path==='words.md'&&this.notes.trim()?`${text}${this.notes.trim()}\n`:text,'setup','Created');
  }
  private file(path:string) {
    this.ensure();
    if(!NAME.test(path))throw new Error('Memory files are Markdown names like words.md or projects/website.md.');
    return join(this.dir,path);
  }
  read(path:string):string|undefined {
    try{const f=this.file(path);if(lstatSync(f).isSymbolicLink())return undefined;return readFileSync(f,'utf8');}catch{return undefined;}
  }
  paths() {
    this.ensure();
    const out:string[]=[];
    const walk=(rel:string)=>{for(const e of readdirSync(join(this.dir,rel),{withFileTypes:true})){
      const p=rel?`${rel}/${e.name}`:e.name;
      if(e.isDirectory()&&!rel)walk(p);else if(e.isFile()&&NAME.test(p))out.push(p);
    }};
    walk('');
    return out.sort((a,b)=>(ALWAYS.indexOf(a)+1||99)-(ALWAYS.indexOf(b)+1||99)||a.localeCompare(b)).slice(0,MAX_FILES);
  }
  /** Writes one file atomically, records the change and keeps the index listing it. */
  write(path:string,text:string,source:string,summary=`Edited ${path}`) {
    const f=this.file(path),before=this.read(path)??null;
    if(text.length>MAX_FILE)throw new Error(`Keep each memory file under ${MAX_FILE} characters.`);
    if(before===null&&this.paths().length>=MAX_FILES)throw new Error(`Memory holds up to ${MAX_FILES} files.`);
    if(before===text)return;
    mkdirSync(dirname(f),{recursive:true,mode:0o700});
    const partial=`${f}.${randomUUID()}`;
    try{writeFileSync(partial,text,{mode:0o600,flag:'wx'});renameSync(partial,f);}finally{rmSync(partial,{force:true});}
    this.store.db.prepare('INSERT INTO owner_memory_history(at,path,before,after,source,summary) VALUES(?,?,?,?,?,?)').run(Date.now(),path,before,text,source,summary.slice(0,300));
    if(before===null&&path!==MEMORY_INDEX){
      const index=this.read(MEMORY_INDEX)??DEFAULTS[MEMORY_INDEX];
      if(!index.includes(`](${path})`))this.write(MEMORY_INDEX,`${index.replace(/\n*$/,'\n')}- ${LISTED[path]??`[${path.replace(/\.md$/,'')}](${path})`}\n`,source,`Listed ${path}`);
    }
  }
  /** Picks up edits made outside the app (a text editor, or the proxy session) so they can be undone too. */
  scan() {
    for(const path of this.paths()){
      const last=this.store.db.prepare('SELECT after FROM owner_memory_history WHERE path=? ORDER BY id DESC LIMIT 1').get(path) as {after:string|null}|undefined,now=this.read(path)??null;
      if(last&&last.after!==now)this.store.db.prepare('INSERT INTO owner_memory_history(at,path,before,after,source,summary) VALUES(?,?,?,?,?,?)').run(Date.now(),path,last.after,now,'outside',`Changed outside the app`);
    }
  }
  history(limit=20):MemoryChange[] {
    this.scan();
    return this.store.db.prepare("SELECT * FROM owner_memory_history WHERE source<>'setup' ORDER BY id DESC LIMIT ?").all(limit) as MemoryChange[];
  }
  undo(id:number) {
    const c=this.store.db.prepare('SELECT * FROM owner_memory_history WHERE id=?').get(id) as MemoryChange|undefined;
    if(!c||c.source==='setup')throw new Error('That change can no longer be undone.');
    this.scan();
    if((this.read(c.path)??null)!==c.after)throw new Error(`${c.path} changed since then. Edit it directly instead.`);
    if(c.before===null){rmSync(this.file(c.path),{force:true});this.store.db.prepare('INSERT INTO owner_memory_history(at,path,before,after,source,summary) VALUES(?,?,?,?,?,?)').run(Date.now(),c.path,c.after,null,'undo',`Removed ${c.path}`);}
    else this.write(c.path,c.before,'undo',`Undid: ${c.summary}`);
  }
  /** Anthropic-style memory commands for the brain's tool loop. Writes are refused when learning is off. */
  command(i:{command:string;path:string;file_text?:string;old_str?:string;new_str?:string;insert_line?:number;insert_text?:string},source:string,canWrite:boolean):string {
    const path=i.path.replace(/^\/?(?:memories\/?)?/,'');
    try {
      if(i.command==='view'){
        if(!path)return this.paths().join('\n');
        const text=this.read(path);if(text===undefined)return `${path} does not exist.`;
        return text.split('\n').map((l,n)=>`${n+1}\t${l}`).join('\n');
      }
      if(!canWrite)return 'The owner turned off saving to memory. Nothing was saved.';
      const before=this.read(path);
      const next=i.command==='create'?i.file_text??''
        :i.command==='str_replace'?(()=>{if(before===undefined||!i.old_str)throw new Error(`${path} has no such text.`);if(before.split(i.old_str).length!==2)throw new Error('old_str must appear exactly once.');return before.replace(i.old_str,()=>i.new_str??'');})()
        :i.command==='insert'?(()=>{const lines=(before??'').split('\n');lines.splice(Math.min(i.insert_line??lines.length,lines.length),0,i.insert_text??'');return lines.join('\n');})()
        :undefined;
      if(next===undefined)return 'Unknown memory command.';
      const added=next.split('\n').filter(l=>!(before??'').split('\n').includes(l)).join(' ').trim();
      if(SECRET.test(added))return 'That looks like a key, password or code, so it was not saved.';
      this.write(path,next,source,added?`Saved "${added.replace(/^[-*]\s*/,'').slice(0,160)}" in ${path}`:`Edited ${path}`);
      return `Saved ${path}.`;
    }catch(e){return (e as Error).message;}
  }
  changes(source:string) {return this.store.db.prepare('SELECT * FROM owner_memory_history WHERE source=? ORDER BY id').all(source) as MemoryChange[];}
  /** Until about-me.md has been answered (or the owner asked for the intro again). */
  introNeeded() {
    this.ensure();
    const since=Number(this.store.get('memory-intro-after')??0);
    return !this.store.db.prepare("SELECT 1 FROM owner_memory_history WHERE path=? AND source NOT IN ('setup','undo') AND id>? LIMIT 1").get(ABOUT_ME,since);
  }
  /** True once the owner (or a save from their own words) has written at least one routing rule. */
  collaborates(){return (this.read(COLLABORATION)??'').split('\n').some(l=>/^[-*]\s+\S/.test(l));}
  restartIntro(){const last=this.store.db.prepare('SELECT max(id) AS id FROM owner_memory_history').get() as {id:number|null};this.store.set('memory-intro-after',String(last.id??0));}
  /** What every model call starts with: the index and about-me. Other files are read through the tool. */
  always(){this.ensure();return Object.fromEntries(ALWAYS.map(p=>[p,this.read(p)??'']));}
  view() {
    return {dir:this.dir,always:ALWAYS,files:this.paths().map(path=>({path,content:this.read(path)??'',always:ALWAYS.includes(path)})),history:this.history(),intro:this.introNeeded()?'pending':'done'};
  }
}
