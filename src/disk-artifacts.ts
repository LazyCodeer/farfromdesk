import { randomUUID } from 'node:crypto';
import { constants, lstatSync, mkdirSync, realpathSync, rmSync, statfsSync } from 'node:fs';
import { open, rename, chmod, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { defaultStateDirectory } from './platform.js';
import { fileType, MAX_OUTGOING_DOCUMENT_BYTES } from './file-types.js';
import { digestHandle, FILE_CHUNK_BYTES, FileDigest } from './large-file.js';
import type { Binding, Store } from './store.js';

export const PREPARATION_TIMEOUT_MS=60*60_000;
export const DISK_HEADROOM_BYTES=128*1024*1024;
type Snapshot={binding_id:string;request_id:string;native_id:string;owner:string;destination:string};
// Shared between the HTTP service and the flusher's Artifacts instances.
const controllers=new Map<string,AbortController>();
export class DiskArtifacts {
  constructor(private store:Store,private root=process.env.WSB_STATE_DIR??defaultStateDirectory(),private freeBytes=(path:string)=>{const s=statfsSync(path);return s.bavail*s.bsize;}) {
    for(const [column,type] of [['storage_key','TEXT'],['bytes','INTEGER']])if(!store.db.prepare('PRAGMA table_info(artifacts)').all().some((c:any)=>c.name===column))store.db.exec(`ALTER TABLE artifacts ADD COLUMN ${column} ${type}`);
    store.db.exec(`CREATE TABLE IF NOT EXISTS artifact_uploads(id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,request_id TEXT NOT NULL,filename TEXT NOT NULL,mime TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,owner TEXT NOT NULL,native_id TEXT NOT NULL,destination TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  }
  private key(id:string){return `${this.root}:${id}`;}
  private directory(id?:string,create=false) {
    if(id!==undefined&&!/^[a-f0-9-]{36}$/i.test(id))throw new Error('Invalid staged artifact identity.');
    if(create)mkdirSync(this.root,{recursive:true,mode:0o700});
    let path=realpathSync(this.root);
    for(const part of ['artifact-files',...(id?[id]:[])]) {
      path=join(path,part);if(create){try{mkdirSync(path,{mode:0o700});}catch(e:any){if(e.code!=='EEXIST')throw e;}}
      const stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Artifact storage directory integrity check failed.');
    }
    return path;
  }
  private assertCurrent(snapshot:Snapshot) {
    const b=this.store.binding(snapshot.binding_id),job=this.store.job(snapshot.request_id);
    if(!b?.enabled||b.native_id!==snapshot.native_id||this.store.ownerFor(snapshot.destination)!==snapshot.owner||!job||job.binding_id!==b.id||['replaced','reviewed','auto_closed','cancelled'].includes(job.status)||![job.destination??snapshot.owner,snapshot.owner].includes(snapshot.destination))throw new Error('Artifact owner, session or request changed. Preparation/delivery stopped.');
  }
  usage() {
    const a=this.store.db.prepare('SELECT COALESCE(SUM(CASE WHEN storage_key IS NOT NULL THEN bytes ELSE length(data) END),0) n FROM artifacts').get() as any;
    const u=this.store.db.prepare("SELECT COALESCE(SUM(bytes),0) n FROM artifact_uploads WHERE state IN ('reserved','writing')").get() as any;
    return Number(a.n)+Number(u.n);
  }
  reserve(b:Binding,requestId:string,input:{filename:unknown;bytes:unknown;sha256:unknown},destinationMode:unknown='request') {
    const type=fileType(input.filename);
    if(!Number.isSafeInteger(input.bytes)||Number(input.bytes)<1||Number(input.bytes)>MAX_OUTGOING_DOCUMENT_BYTES||typeof input.sha256!=='string'||!/^[0-9a-f]{64}$/.test(input.sha256))throw new Error('An exact SHA-256 and size from 1 byte to 2,097,152,000 bytes are required.');
    if(destinationMode!=='request'&&destinationMode!=='self')throw new Error('Use the original request or linked owner self-chat.');
    const job=this.store.job(requestId),owner=this.store.ownerFor(job?.destination);
    if(!owner||!job)throw new Error('An existing owner request is required.');
    const snapshot={binding_id:b.id,request_id:requestId,native_id:b.native_id,owner,destination:destinationMode==='self'?owner:job.destination??owner};
    this.assertCurrent(snapshot);
    if(snapshot.destination.startsWith('tg:')&&Number(input.bytes)>50_000_000)throw new Error('Telegram documents must be at most 50 MB.');
    const prior=this.store.db.prepare('SELECT id,filename,mime,COALESCE(bytes,length(data)) bytes,sha256 FROM artifacts WHERE binding_id=? AND request_id=? AND filename=? AND sha256=? AND destination=? AND owner=? AND native_id=? AND COALESCE(bytes,length(data))=? AND removed_at IS NULL').get(b.id,requestId,type.filename,input.sha256,snapshot.destination,owner,b.native_id,Number(input.bytes)) as any;
    if(prior)return {artifactId:prior.id,filename:prior.filename,mime:prior.mime,bytes:prior.bytes,sha256:prior.sha256};
    this.expire();
    // One durable reservation bounds both disk use and concurrent stream buffers.
    if(this.store.db.prepare("SELECT 1 FROM artifact_uploads WHERE state IN ('reserved','writing')").get())throw new Error('Another document is being prepared. Finish or cancel it first.');
    const dir=this.directory(undefined,true);
    if(this.freeBytes(dir)<Number(input.bytes)*2+64+DISK_HEADROOM_BYTES||this.freeBytes(tmpdir())<Number(input.bytes)+64+DISK_HEADROOM_BYTES)throw new Error('Not enough free disk space for staging and encrypted upload.');
    const id=randomUUID();
    this.store.db.prepare("INSERT INTO artifact_uploads VALUES(?,?,?,?,?,?,?,?,?,?,'reserved',?)").run(id,b.id,requestId,type.filename,type.mime,input.sha256,Number(input.bytes),owner,b.native_id,snapshot.destination,Date.now());
    return {uploadId:id,bytes:input.bytes,sha256:input.sha256};
  }
  async receive(id:string,source:AsyncIterable<Uint8Array>,contentLength:number,signal?:AbortSignal) {
    const row=this.store.db.prepare('SELECT * FROM artifact_uploads WHERE id=?').get(id) as any;
    if(!row||row.state!=='reserved'||contentLength!==row.bytes)throw new Error('Unknown, already used or size-mismatched document upload.');
    if(Date.now()-row.created_at>PREPARATION_TIMEOUT_MS)throw new Error('Document preparation expired. Start a new preparation.');
    this.assertCurrent(row);
    this.store.db.prepare("UPDATE artifact_uploads SET state='writing' WHERE id=?").run(id);
    const controller=new AbortController(),abort=AbortSignal.any([controller.signal,AbortSignal.timeout(PREPARATION_TIMEOUT_MS),...(signal?[signal]:[])]);
    controllers.set(this.key(id),controller);
    // Cancellation may arrive during the file open, before iteration installs its handler.
    if(source instanceof Readable)source.on('error',()=>{});
    const abortSource=()=>{if(source instanceof Readable)source.destroy(new Error('Document upload cancelled or timed out.'));};
    abort.addEventListener('abort',abortSource,{once:true});
    let handle:FileHandle|undefined;
    try {
      const dir=this.directory(id,true),partial=join(dir,'partial');handle=await open(partial,'wx',0o600);
      const digest=new FileDigest(row.filename);let bytes=0,checkpoint=0;
      for await(const raw of source){abort.throwIfAborted();const chunk=Buffer.from(raw);bytes+=chunk.length;if(bytes>row.bytes)throw new Error('Document exceeds declared size.');if(bytes>=checkpoint){if(this.freeBytes(dir)<row.bytes-bytes+chunk.length+DISK_HEADROOM_BYTES)throw new Error('Not enough free disk space to finish staging this file.');checkpoint=bytes+8*1024*1024;}digest.add(chunk);await handle.writeFile(chunk);}
      abort.throwIfAborted();
      const meta=digest.finish();if(bytes!==row.bytes||meta.sha256!==row.sha256)throw new Error('Document size or integrity check failed.');
      this.assertCurrent(row);
      await handle.sync();await handle.close();handle=undefined;
      await chmod(partial,0o400);await rename(partial,join(dir,'data'));
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        this.assertCurrent(row);abort.throwIfAborted();
        this.store.db.prepare("INSERT INTO artifacts(id,binding_id,request_id,filename,mime,sha256,data,created_at,destination,owner,native_id,storage_key,bytes) VALUES(?,?,?,?,?,?,X'',?,?,?,?,?,?)")
          .run(id,row.binding_id,row.request_id,meta.filename,meta.mime,meta.sha256,Date.now(),row.destination,row.owner,row.native_id,id,meta.bytes);
        this.store.db.prepare("UPDATE artifact_uploads SET state='prepared' WHERE id=?").run(id);
        this.store.db.exec('COMMIT');
      }catch(e){this.store.db.exec('ROLLBACK');throw e;}
      return {artifactId:id,...meta};
    }catch(e){await handle?.close().catch(()=>{});this.store.db.prepare("UPDATE artifact_uploads SET state='failed' WHERE id=?").run(id);this.remove(id);throw e;}
    finally{abort.removeEventListener('abort',abortSource);controllers.delete(this.key(id));}
  }
  cancelUpload(id:string) {
    controllers.get(this.key(id))?.abort();
    const row=this.store.db.prepare('SELECT state FROM artifact_uploads WHERE id=?').get(id) as any;
    if(!row)throw new Error('Unknown document preparation.');
    if(row.state==='prepared')throw new Error('Use cancel-file for an already prepared artifact.');
    this.store.db.prepare("UPDATE artifact_uploads SET state='cancelled' WHERE id=?").run(id);
    if(!controllers.has(this.key(id)))this.remove(id);
    return {cancelled:true};
  }
  status(id:string) {
    const row=this.store.db.prepare('SELECT id,state,filename,mime,bytes,sha256 FROM artifact_uploads WHERE id=?').get(id) as any;
    if(!row)throw new Error('Unknown document preparation.');
    if(row.state==='prepared'&&this.store.db.prepare('SELECT removed_at FROM artifacts WHERE id=?').get(id)?.removed_at)row.state='cancelled';
    return {...row,artifactId:row.state==='prepared'?row.id:undefined};
  }
  remove(id:string) {
    controllers.get(this.key(id))?.abort();
    try{rmSync(this.directory(id),{recursive:true,force:true});return true;}catch(e:any){if(e.code==='ENOENT')return true;if(['EPERM','EBUSY','EACCES'].includes(e.code))return false;throw e;}
  }
  recover() {
    // Called once on service startup; no old upload is blindly resumed.
    for(const row of this.store.db.prepare("SELECT id FROM artifact_uploads WHERE state IN ('reserved','writing','failed','cancelled')").all() as any[]){if(controllers.has(this.key(row.id)))continue;this.remove(row.id);this.store.db.prepare("UPDATE artifact_uploads SET state='interrupted' WHERE id=? AND state IN ('reserved','writing')").run(row.id);}
  }
  expire(now=Date.now()) {
    for(const row of this.store.db.prepare("SELECT id FROM artifact_uploads WHERE state IN ('reserved','writing') AND created_at<?").all(now-PREPARATION_TIMEOUT_MS) as any[])this.cancelUpload(row.id);
  }
  abortAll(){for(const [key,controller] of controllers)if(key.startsWith(this.root+':'))controller.abort();}
  async openForDelivery(row:any) {
    this.assertCurrent(row);
    if(row.removed_at||!row.storage_key||row.storage_key!==row.id||row.bytes<1||row.bytes>MAX_OUTGOING_DOCUMENT_BYTES)throw new Error('Prepared document is unavailable.');
    const path=join(this.directory(row.storage_key),'data');
    if(lstatSync(path).isSymbolicLink())throw new Error('Staged document must not be a link.');
    const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(PREPARATION_TIMEOUT_MS)]);controllers.set(this.key(row.id),controller);
    let stream:Readable|undefined;
    const valid=()=>{signal.throwIfAborted();this.assertCurrent(row);if(this.store.db.prepare('SELECT removed_at FROM artifacts WHERE id=?').get(row.id)?.removed_at)throw new Error('Prepared document was cancelled.');};
    try {
      const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size!==row.bytes)throw new Error('Prepared document integrity check failed.');
      if(this.freeBytes(tmpdir())<row.bytes+64+DISK_HEADROOM_BYTES)throw new Error('Not enough temporary disk space for encrypted upload.');
      const meta=await digestHandle(handle,row.filename,signal);if(meta.sha256!==row.sha256)throw new Error('Prepared document integrity check failed.');
      valid();
      // A second streaming hash covers modifications between preflight and encryption.
      async function* verified() {
        const check=new FileDigest(row.filename),buffer=Buffer.alloc(FILE_CHUNK_BYTES);let offset=0;
        for(;;){valid();const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);if(!bytesRead)break;const chunk=Buffer.from(buffer.subarray(0,bytesRead));check.add(chunk);offset+=bytesRead;yield chunk;}
        const final=check.finish();if(final.bytes!==row.bytes||final.sha256!==row.sha256)throw new Error('Prepared document changed during encryption.');valid();
      }
      stream=Readable.from(verified(),{highWaterMark:FILE_CHUNK_BYTES,objectMode:false});
      const stop=()=>stream?.destroy(new Error('Document delivery cancelled.'));stream.on('error',()=>{});signal.addEventListener('abort',stop,{once:true});
      // A cancellation may arrive while Baileys is uploading already encrypted data.
      // The caller must call valid() again before relaying a message to the recipient.
      return {stream,signal,valid,close:async()=>{signal.removeEventListener('abort',stop);stream?.destroy();controllers.delete(this.key(row.id));await handle.close().catch(()=>{});}};
    }catch(e){controllers.delete(this.key(row.id));await handle.close().catch(()=>{});throw e;}
  }
}
