import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, lstatSync, readFileSync, rmSync, copyFileSync, constants, chmodSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { boundedMediaDownload } from './media-transport.js';
import { MAX_FILE_BYTES, safeFilename, validateFile } from './file-types.js';
import { digestFileSync } from './large-file.js';
import { privateMediaRoot, privateDirectory, requireDiskSpace, recoverDownloads, streamMediaDownload, isDownloadedMedia, type DownloadedMedia } from './media-download.js';
import type { Store, Binding } from './store.js';

export type AttachmentKind='image'|'document';
export type IncomingFile={kind:AttachmentKind;filename:string;sha256:string} & ({data:Buffer;download?:never}|{data?:never;download:DownloadedMedia});
export type AttachmentRef={id:string;filename:string;mime:string;bytes:number;sha256:string;kind:AttachmentKind;path?:string};
const digest=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const imageExtensions:Record<string,string>={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'};
export function incomingMetadata(media:any,kind:AttachmentKind) {
  const mime=String(media?.mimetype??'').split(';')[0].trim().toLowerCase();
  if(kind==='image'&&!imageExtensions[mime])throw new Error('Unsupported image type. Send JPEG, PNG, WebP or GIF as a document.');
  const filename=kind==='image'?`image.${imageExtensions[mime]}`:safeFilename(media?.fileName);
  // An incoming image has already passed WhatsApp's per-type runtime gate.
  // Do not pretend the document ceiling or our model's image-input budget is its limit.
  const max=kind==='document'?MAX_FILE_BYTES:Number.MAX_SAFE_INTEGER,size=Number(media?.fileLength??0);
  if(!Number.isSafeInteger(size)||size<0||size>max)throw new Error('Attachment exceeds the WhatsApp document limit or has an invalid declared size.');
  return {filename,max,size,mime};
}
export async function downloadAttachment(media:any,kind:AttachmentKind,signal?:AbortSignal,download=boundedMediaDownload,root=privateMediaRoot()):Promise<IncomingFile> {
  const meta=incomingMetadata(media,kind),file=await streamMediaDownload(media,kind,meta.filename,meta.max,signal,download,root);
  return {kind,filename:meta.filename,sha256:file.sha256,download:file};
}
export function disposeIncoming(file?:IncomingFile){file?.download?.dispose();}

/** Immutable disk bytes and metadata, bound to both request and exact native session. */
export class Attachments {
  private root:string;
  private allowRecovery:boolean;
  constructor(private store:Store,root?:string) {
    this.root=root??privateMediaRoot();
    const database=store.db.prepare('PRAGMA database_list').all().find((r:any)=>r.name==='main') as any;
    this.allowRecovery=root!==undefined||Boolean(database?.file&&resolve(dirname(database.file))===resolve(this.root));
    store.db.exec(`CREATE TABLE IF NOT EXISTS incoming_files(
      id TEXT PRIMARY KEY,binding_id TEXT NOT NULL REFERENCES bindings(id),request_id TEXT NOT NULL REFERENCES inbox(id),
      filename TEXT NOT NULL,mime TEXT NOT NULL,kind TEXT NOT NULL,sha256 TEXT NOT NULL,data BLOB,bytes INTEGER NOT NULL,
      owner TEXT NOT NULL,native_id TEXT NOT NULL,destination TEXT NOT NULL,created_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'ready');
      CREATE TABLE IF NOT EXISTS media_inbox(id TEXT PRIMARY KEY,destination TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL);`);
    if(!store.db.prepare('PRAGMA table_info(incoming_files)').all().some((c:any)=>c.name==='storage_key'))store.db.exec('ALTER TABLE incoming_files ADD COLUMN storage_key TEXT');
  }
  download(media:any,kind:AttachmentKind,signal?:AbortSignal){return downloadAttachment(media,kind,signal,undefined,this.root);}
  private request(b:Binding,requestId:string){
    const job=this.store.job(requestId),owner=this.store.ownerFor(job?.destination),current=this.store.binding(b.id);
    if(!current?.enabled||current.native_id!==b.native_id||!job||job.binding_id!==b.id||!owner||!job.destination||['replaced','cancelled','reviewed','auto_closed'].includes(job.status))throw new Error('Attachment request must belong to this enabled session and owner.');
    return {job,owner};
  }
  private directory(b:Binding,requestId:string,id:string,create=false) {
    if(!/^[a-f0-9-]{36}$/i.test(b.id)||!/^[a-f0-9-]{36}$/i.test(id))throw new Error('Invalid attachment identity.');
    return privateDirectory(this.root,['incoming',b.id,createHash('sha256').update(requestId).digest('hex'),id],create);
  }
  private stageBytes(b:Binding,requestId:string,file:{filename:string;kind:AttachmentKind;sha256:string;bytes:number;mime:string},source:Buffer|string) {
    const {job,owner}=this.request(b,requestId),id=randomUUID(),dir=this.directory(b,requestId,id,true),path=join(dir,safeFilename(file.filename));
    try {
      requireDiskSpace(dir,file.bytes);
      if(Buffer.isBuffer(source))writeFileSync(path,source,{flag:'wx',mode:0o400});
      else {copyFileSync(source,path,constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);chmodSync(path,0o400);}
      const checked=digestFileSync(path,file.filename,file.kind==='document'?MAX_FILE_BYTES:Number.MAX_SAFE_INTEGER);
      if(checked.bytes!==file.bytes||checked.sha256!==file.sha256)throw new Error('Attachment staging integrity check failed.');
      this.request(b,requestId);
      this.store.db.prepare("INSERT INTO incoming_files(id,binding_id,request_id,filename,mime,kind,sha256,data,bytes,owner,native_id,destination,created_at,storage_key) VALUES(?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)")
        .run(id,b.id,requestId,file.filename,file.mime,file.kind,file.sha256,file.bytes,owner,b.native_id,job.destination!,Date.now(),id);
      return id;
    }catch(e){rmSync(dir,{recursive:true,force:true});throw e;}
  }
  stage(b:Binding,requestId:string,file:IncomingFile) {
    this.request(b,requestId);
    if(!['image','document'].includes(file.kind))throw new Error('Attachment integrity or type check failed.');
    let meta:{filename:string;mime:string;bytes:number},source:Buffer|string;
    if(file.download){
      if(!isDownloadedMedia(file.download)||file.download.filename!==file.filename||file.download.sha256!==file.sha256)throw new Error('Attachment download identity is invalid.');
      meta=file.download;source=file.download.path;
      const checked=digestFileSync(source,file.filename,file.kind==='document'?MAX_FILE_BYTES:Number.MAX_SAFE_INTEGER);
      if(checked.sha256!==file.sha256||checked.bytes!==meta.bytes)throw new Error('Attachment integrity check failed.');
    }else{meta=validateFile(file.filename,file.data,file.kind==='document'?MAX_FILE_BYTES:Number.MAX_SAFE_INTEGER);source=file.data;if(digest(source)!==file.sha256)throw new Error('Attachment integrity check failed.');}
    if(file.kind==='image'&&!imageExtensions[meta.mime])throw new Error('Attachment integrity or type check failed.');
    return this.stageBytes(b,requestId,{...meta,kind:file.kind,sha256:file.sha256},source);
  }
  private rows(b:Binding,requestId:string) {
    const job=this.store.job(requestId);
    if(!this.store.binding(b.id)?.enabled||!job||job.binding_id!==b.id||['replaced','cancelled','reviewed','auto_closed'].includes(job.status))throw new Error('Attachment request is inactive or belongs to another session.');
    const rows=this.store.db.prepare('SELECT * FROM incoming_files WHERE binding_id=? AND request_id=? ORDER BY created_at,id').all(b.id,requestId) as any[];
    for(const row of rows){
      if(row.status!=='ready'||row.owner!==this.store.ownerFor(row.destination)||row.native_id!==b.native_id||row.destination!==job.destination)throw new Error('Attachment is unavailable or failed its owner, session or integrity check.');
      if(row.storage_key){
        if(row.storage_key!==row.id)throw new Error('Attachment storage integrity check failed.');
        const path=join(this.directory(b,requestId,row.id),safeFilename(row.filename));
        const checked=digestFileSync(path,row.filename,row.kind==='document'?MAX_FILE_BYTES:Number.MAX_SAFE_INTEGER);
        if(checked.bytes!==row.bytes||checked.sha256!==row.sha256)throw new Error('Attachment staging integrity check failed.');row.path=path;
      }else if(!row.data||row.bytes!==row.data.length||digest(row.data)!==row.sha256)throw new Error('Attachment is unavailable or failed its integrity check.');
    }
    return rows;
  }
  references(b:Binding,requestId:string,materialize=false):AttachmentRef[] {
    return this.rows(b,requestId).map(row=>{
      const ref:AttachmentRef={id:row.id,filename:row.filename,mime:row.mime,bytes:row.bytes,sha256:row.sha256,kind:row.kind};
      if(!materialize)return ref;
      if(row.path){ref.path=row.path;return ref;}
      // Backward compatibility for small BLOBs prepared by the older backend.
      const file=join(this.directory(b,requestId,row.id,true),safeFilename(row.filename));
      try{writeFileSync(file,row.data,{flag:'wx',mode:0o400});}catch(e:any){if(e.code!=='EEXIST')throw e;}
      const check=digestFileSync(file,row.filename);if(check.bytes!==row.bytes||check.sha256!==row.sha256)throw new Error('Attachment staging integrity check failed.');
      ref.path=file;return ref;
    });
  }
  imageInputs(b:Binding,requestId:string) {
    return this.rows(b,requestId).filter(row=>row.bytes<=5*1024*1024&&imageExtensions[row.mime])
      .map(row=>({type:'image' as const,source:{type:'base64' as const,media_type:row.mime,data:(row.path?readFileSync(row.path):Buffer.from(row.data)).toString('base64')}}));
  }
  forward(parent:Binding,parentId:string,child:Binding,childId:string,ids:string[]) {
    if(!Array.isArray(ids)||ids.length>10||new Set(ids).size!==ids.length)throw new Error('Choose up to ten distinct attachment IDs from this owner request.');
    const rows=this.rows(parent,parentId),chosen=ids.map(id=>rows.find(row=>row.id===id));
    if(chosen.some(row=>!row))throw new Error('Attachment does not belong to the original owner request.');
    for(const row of chosen)this.stageBytes(child,childId,row,row.path??Buffer.from(row.data));
  }
  cleanupOrphans(){
    // Never inspect real default state from an unrelated/in-memory database.
    if(!this.allowRecovery)return;
    // Called after transaction rollback or startup, when no synchronous stage is active.
    let root:string;try{root=privateDirectory(this.root,['incoming']);}catch(e:any){if(e.code==='ENOENT')return;throw e;}
    for(const b of readdirSync(root))if(/^[a-f0-9-]{36}$/.test(b)){
      const bp=join(root,b);if(lstatSync(bp).isSymbolicLink()||!lstatSync(bp).isDirectory())continue;
      for(const request of readdirSync(bp))if(/^[a-f0-9]{64}$/.test(request)){
        const rp=join(bp,request);if(lstatSync(rp).isSymbolicLink()||!lstatSync(rp).isDirectory())continue;
        for(const id of readdirSync(rp))if(/^[a-f0-9-]{36}$/.test(id)&&!this.store.db.prepare('SELECT 1 FROM incoming_files WHERE id=?').get(id))rmSync(join(rp,id),{recursive:true,force:true});
      }
    }
  }
  interrupt(message:string) {
    if(this.allowRecovery)recoverDownloads(this.root);this.cleanupOrphans();
    for(const row of this.store.db.prepare("SELECT * FROM media_inbox WHERE status='processing'").all() as any[]) {
      const origin=this.store.recordedIncomingInput(row.id);
      if(origin&&origin.destination===row.destination)this.store.incomingOwnerContext.run(origin,()=>{if(this.store.incomingOwnerCurrent())this.store.output(undefined,message,`media-error:${row.id}`,row.destination);});
      this.store.remember(row.id);
      this.store.db.prepare("UPDATE media_inbox SET status='interrupted' WHERE id=?").run(row.id);
    }
  }
  cancel(b:Binding,requestId:string) {
    const job=this.store.job(requestId);if(!job||job.binding_id!==b.id)throw new Error('Attachment request belongs to another session.');this.remove(b,requestId);
  }
  private remove(b:Binding,requestId:string) {
    for(const row of this.store.db.prepare('SELECT id FROM incoming_files WHERE binding_id=? AND request_id=?').all(b.id,requestId) as any[]) {
      try{rmSync(this.directory(b,requestId,row.id),{recursive:true,force:true});}catch(e:any){if(e.code!=='ENOENT')throw e;}
    }
    this.store.db.prepare("UPDATE incoming_files SET data=NULL,storage_key=NULL,status='removed' WHERE binding_id=? AND request_id=?").run(b.id,requestId);
  }
  cleanup(now=Date.now()) {
    const rows=this.store.db.prepare(`SELECT DISTINCT f.binding_id,f.request_id FROM incoming_files f JOIN inbox i ON i.id=f.request_id
      WHERE f.status='ready' AND (i.status IN ('replaced','cancelled') OR (i.status IN ('completed','reviewed','auto_closed') AND COALESCE(i.updated_at,i.created_at)<?))`).all(now-24*3600000) as any[];
    for(const row of rows){const b=this.store.binding(row.binding_id);if(b)this.remove(b,row.request_id);}return rows.length;
  }
}
