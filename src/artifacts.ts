import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, normalize } from 'node:path';
import type { Store, Binding } from './store.js';
import { MAX_INLINE_BYTES, validateFile } from './file-types.js';
import { DiskArtifacts } from './disk-artifacts.js';

export const MAX_ARTIFACT_BYTES=MAX_INLINE_BYTES;
export function validateArtifact(filename:unknown,data:Buffer) {
  return {...validateFile(filename,data,MAX_INLINE_BYTES),sha256:createHash('sha256').update(data).digest('hex')};
}
// Only the local, admin-authorized CLI reads paths. The service and scoped workers
// accept immutable artifact IDs, never paths, URLs, globs or directories.
export function readLocalArtifact(path:string) {
  if(!isAbsolute(path)||normalize(path)!==path||realpathSync(path)!==path)throw new Error('Use an absolute canonical file path without symlinks or traversal.');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>MAX_ARTIFACT_BYTES)throw new Error('Select a regular, unlinked file of at most 25 MiB.');
    const bytes=Buffer.alloc(MAX_ARTIFACT_BYTES+1);let size=0,read=0;
    do{read=readSync(fd,bytes,size,bytes.length-size,null);size+=read;}while(read&&size<bytes.length);
    const after=fstatSync(fd);if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw new Error('Selected file changed while preparing it. Review it and try again.');
    const data=bytes.subarray(0,size);return {...validateArtifact(basename(path),data),data};
  }finally{closeSync(fd);}
}
export class Artifacts {
  disk:DiskArtifacts;
  constructor(private store:Store,root?:string){
    for(const column of ['owner','native_id','removed_at'])if(!store.db.prepare('PRAGMA table_info(artifacts)').all().some((c:any)=>c.name===column))store.db.exec(`ALTER TABLE artifacts ADD COLUMN ${column} TEXT`);
    this.disk=new DiskArtifacts(store,root);
  }
  prepare(b:Binding,requestId:string,filename:unknown,base64:unknown,destinationMode:unknown='request') {
    const job=this.request(b,requestId);
    if(!['request','self'].includes(destinationMode as string))throw new Error('Documents can only use the original request or the linked owner self-chat.');
    const owner=this.store.get('whatsapp-owner');
    const destination=destinationMode==='self'?owner:job.destination??owner;
    if(!owner||!destination)throw new Error('Pair WhatsApp first.');
    if(typeof base64!=='string'||base64.length>Math.ceil(MAX_ARTIFACT_BYTES/3)*4)throw new Error('Legacy JSON preparation is limited to 25 MiB; use prepare-file streaming for larger documents.');
    const data=Buffer.from(base64,'base64');if(data.toString('base64')!==base64)throw new Error('Invalid document encoding.');
    const meta=validateArtifact(filename,data);
    const prior=this.store.db.prepare('SELECT id FROM artifacts WHERE binding_id=? AND request_id=? AND sha256=? AND filename=? AND destination=? AND removed_at IS NULL').get(b.id,requestId,meta.sha256,meta.filename,destination) as any;
    if(prior)return {artifactId:prior.id,...meta};
    const id=randomUUID();
    this.store.db.prepare('INSERT INTO artifacts(id,binding_id,request_id,filename,mime,sha256,data,created_at,destination,owner,native_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,b.id,requestId,meta.filename,meta.mime,meta.sha256,data,Date.now(),destination,owner,b.native_id);
    return {artifactId:id,...meta};
  }
  request(b:Binding,id:string) {
    const job=typeof id==='string'?this.store.job(id):undefined;
    const current=this.store.binding(b.id);
    if(!current?.enabled||current.native_id!==b.native_id||!job||job.binding_id!==b.id)throw new Error('Document request does not belong to this enabled session.');
    if(['replaced','reviewed','auto_closed','cancelled'].includes(job.status))throw new Error('This request was closed when its master was replaced.');
    return job;
  }
  reply(b:Binding,requestId:string,artifactId:string,caption:string) {
    const job=this.request(b,requestId);
    if(typeof caption!=='string'||caption.length>1000)throw new Error('Document caption must be at most 1,000 characters.');
    const artifact=this.store.db.prepare('SELECT * FROM artifacts WHERE id=? AND binding_id=? AND request_id=?').get(artifactId,b.id,requestId) as any;
    if(!artifact||artifact.removed_at||artifact.owner&&artifact.owner!==this.store.get('whatsapp-owner')||artifact.native_id&&artifact.native_id!==b.native_id)throw new Error('Prepare this exact artifact locally for this session and request first.');
    const source=`document:${b.id}:${requestId}:${artifactId}`;
    const prior=this.store.db.prepare('SELECT id,body FROM outbox WHERE source=?').get(source) as any;
    if(prior){if(prior.body!==caption)throw new Error('This artifact was already queued with a different caption.');return this.status(b,prior.id);}
    const owner=this.store.get('whatsapp-owner'),destination=artifact.destination??job.destination??owner;
    if(!owner||!destination)throw new Error('Pair WhatsApp first.');
    const id=randomUUID();
    this.store.db.prepare('INSERT INTO outbox(id,binding_id,body,source,wa_id,created_at,destination,artifact_id,request_id,reply_kind) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,b.id,caption,source,`3EB0${randomUUID().replaceAll('-','').toUpperCase()}`,Date.now(),destination,artifactId,requestId,'progress');
    this.store.event(requestId,'document_queued');
    // A file is a progress delivery. Only the worker's explicit final text closes work.
    return this.status(b,id);
  }
  cancel(b:Binding,id:string) {
    const row=this.store.db.prepare('SELECT * FROM artifacts WHERE id=? AND binding_id=?').get(id,b.id) as any;
    if(!row)throw new Error('Artifact does not belong to this session.');
    this.store.db.prepare("UPDATE outbox SET status='failed',error='Artifact cancelled locally' WHERE artifact_id=? AND status='queued'").run(id);
    this.store.db.prepare("UPDATE artifacts SET data=X'',removed_at=? WHERE id=?").run(String(Date.now()),id);
    if(row.storage_key&&this.disk.remove(row.storage_key))this.store.db.prepare('UPDATE artifacts SET storage_key=NULL WHERE id=?').run(id);
    return {cancelled:true};
  }
  cleanup(now=Date.now()) {
    this.disk.expire(now);
    for(const row of this.store.db.prepare('SELECT id,storage_key FROM artifacts WHERE removed_at IS NOT NULL AND storage_key IS NOT NULL').all() as any[])
      if(this.disk.remove(row.storage_key))this.store.db.prepare('UPDATE artifacts SET storage_key=NULL WHERE id=?').run(row.id);
    const rows=this.store.db.prepare(`SELECT a.id,a.binding_id FROM artifacts a JOIN inbox i ON i.id=a.request_id
      WHERE a.removed_at IS NULL AND (i.status IN ('replaced','cancelled') OR (i.status IN ('completed','reviewed','auto_closed') AND COALESCE(i.updated_at,i.created_at)<?
      AND NOT EXISTS(SELECT 1 FROM outbox o WHERE o.artifact_id=a.id AND o.status='queued')))` ).all(now-24*3600000) as any[];
    for(const row of rows){const b=this.store.binding(row.binding_id);if(b)this.cancel(b,row.id);}
    return rows.length;
  }
  status(b:Binding,id:string) {
    const row=this.store.db.prepare('SELECT id,status,attempts,error,artifact_id FROM outbox WHERE id=? AND binding_id=? AND artifact_id IS NOT NULL').get(id,b.id);
    if(!row)throw new Error('Delivery does not belong to this session.');return row;
  }
}
