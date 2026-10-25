import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, normalize } from 'node:path';
import type { Store, Binding } from './store.js';

export const MAX_ARTIFACT_BYTES=10*1024*1024;
const types:Record<string,string>={html:'text/html',pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',txt:'text/plain',md:'text/markdown',csv:'text/csv'};
export function validateArtifact(filename:unknown,data:Buffer) {
  if(typeof filename!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/.test(filename)||filename.includes('..'))throw new Error('Use a simple document filename without paths (maximum 120 characters).');
  const ext=filename.split('.').pop()!.toLowerCase(),mime=types[ext];
  if(!mime||!data.length||data.length>MAX_ARTIFACT_BYTES)throw new Error('Supported documents: HTML, PDF, PNG, JPEG, TXT, MD, CSV; 1 byte to 10 MiB.');
  if(ext==='pdf'&&!data.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Error('Invalid PDF signature.');
  if(ext==='png'&&!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Invalid PNG signature.');
  if(['jpg','jpeg'].includes(ext)&&!data.subarray(0,3).equals(Buffer.from([255,216,255])))throw new Error('Invalid JPEG signature.');
  if(['html','txt','md','csv'].includes(ext)) {
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{throw new Error('Text documents must be UTF-8.');}
    if(text.includes('\0'))throw new Error('Binary data is not a text document.');
    if(ext==='html'&&!/^\s*(?:<!doctype html[^>]*>\s*)?<html[\s>]/i.test(text))throw new Error('Expected a complete HTML document.');
  }
  return {filename,mime,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};
}
// Only the local, admin-authorized CLI reads paths. The service and scoped workers
// accept immutable artifact IDs, never paths, URLs, globs or directories.
export function readLocalArtifact(path:string) {
  if(!isAbsolute(path)||normalize(path)!==path||realpathSync(path)!==path)throw new Error('Use an absolute canonical file path without symlinks or traversal.');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>MAX_ARTIFACT_BYTES)throw new Error('Select a regular, unlinked document of at most 10 MiB.');
    const bytes=Buffer.alloc(MAX_ARTIFACT_BYTES+1);let size=0,read=0;
    do{read=readSync(fd,bytes,size,bytes.length-size,null);size+=read;}while(read&&size<bytes.length);
    const data=bytes.subarray(0,size);return {...validateArtifact(basename(path),data),data};
  }finally{closeSync(fd);}
}
export class Artifacts {
  constructor(private store:Store){}
  prepare(b:Binding,requestId:string,filename:unknown,base64:unknown,destinationMode:unknown='request') {
    const job=this.request(b,requestId);
    if(!['request','self'].includes(destinationMode as string))throw new Error('Documents can only use the original request or the linked owner self-chat.');
    const owner=this.store.get('whatsapp-owner');
    const destination=destinationMode==='self'?owner:job.destination??owner;
    if(!owner||!destination)throw new Error('Pair WhatsApp first.');
    if(typeof base64!=='string'||base64.length>Math.ceil(MAX_ARTIFACT_BYTES/3)*4)throw new Error('Invalid document encoding or size.');
    const data=Buffer.from(base64,'base64');if(data.toString('base64')!==base64)throw new Error('Invalid document encoding.');
    const meta=validateArtifact(filename,data);
    const prior=this.store.db.prepare('SELECT id FROM artifacts WHERE binding_id=? AND request_id=? AND sha256=? AND filename=? AND destination=?').get(b.id,requestId,meta.sha256,meta.filename,destination) as any;
    if(prior)return {artifactId:prior.id,...meta};
    const usage=this.store.db.prepare('SELECT COALESCE(SUM(length(data)),0) AS bytes FROM artifacts').get() as any;
    if(usage.bytes+data.length>100*1024*1024)throw new Error('Artifact storage limit reached (100 MiB). Remove old prepared artifacts locally.');
    const id=randomUUID();
    this.store.db.prepare('INSERT INTO artifacts(id,binding_id,request_id,filename,mime,sha256,data,created_at,destination) VALUES(?,?,?,?,?,?,?,?,?)').run(id,b.id,requestId,meta.filename,meta.mime,meta.sha256,data,Date.now(),destination);
    return {artifactId:id,...meta};
  }
  request(b:Binding,id:string) {
    const job=typeof id==='string'?this.store.job(id):undefined;
    if(!b.enabled||!job||job.binding_id!==b.id)throw new Error('Document request does not belong to this enabled session.');
    if(job.status==='replaced')throw new Error('This request was closed when its master was replaced.');
    return job;
  }
  reply(b:Binding,requestId:string,artifactId:string,caption:string) {
    const job=this.request(b,requestId);
    if(typeof caption!=='string'||caption.length>1000)throw new Error('Document caption must be at most 1,000 characters.');
    const artifact=this.store.db.prepare('SELECT * FROM artifacts WHERE id=? AND binding_id=? AND request_id=?').get(artifactId,b.id,requestId) as any;
    if(!artifact)throw new Error('Prepare this exact artifact locally for this session and request first.');
    const source=`document:${b.id}:${requestId}:${artifactId}`;
    const prior=this.store.db.prepare('SELECT id,body FROM outbox WHERE source=?').get(source) as any;
    if(prior){if(prior.body!==caption)throw new Error('This artifact was already queued with a different caption.');return this.status(b,prior.id);}
    const owner=this.store.get('whatsapp-owner'),destination=artifact.destination??job.destination??owner;
    if(!owner||!destination)throw new Error('Pair WhatsApp first.');
    const id=randomUUID();
    this.store.db.prepare('INSERT INTO outbox(id,binding_id,body,source,wa_id,created_at,destination,artifact_id) VALUES(?,?,?,?,?,?,?,?)').run(id,b.id,caption,source,`3EB0${randomUUID().replaceAll('-','').toUpperCase()}`,Date.now(),destination,artifactId);
    // A file is a progress delivery. Only the worker's explicit final text closes work.
    return this.status(b,id);
  }
  status(b:Binding,id:string) {
    const row=this.store.db.prepare('SELECT id,status,attempts,error,artifact_id FROM outbox WHERE id=? AND binding_id=? AND artifact_id IS NOT NULL').get(id,b.id);
    if(!row)throw new Error('Delivery does not belong to this session.');return row;
  }
}
