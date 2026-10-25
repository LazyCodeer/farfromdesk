import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, normalize } from 'node:path';
import { fileType, MAX_OUTGOING_DOCUMENT_BYTES, textTypes, validateFileHeader } from './file-types.js';

export const FILE_CHUNK_BYTES=64*1024;
/** Validates all text incrementally; keeps only a bounded header and hash state. */
export class FileDigest {
  private hash=createHash('sha256');
  private header=Buffer.alloc(0);
  private decoder?:TextDecoder;
  private bytes=0;
  private meta:ReturnType<typeof fileType>;
  constructor(filename:unknown,private limit=MAX_OUTGOING_DOCUMENT_BYTES) {
    this.meta=fileType(filename);
    if(textTypes.has(this.meta.ext))this.decoder=new TextDecoder('utf-8',{fatal:true});
  }
  add(chunk:Buffer) {
    this.bytes+=chunk.length;if(this.bytes>this.limit)throw new Error('Document exceeds the WhatsApp document limit (2,097,152,000 bytes).');
    this.hash.update(chunk);
    if(this.header.length<FILE_CHUNK_BYTES)this.header=Buffer.concat([this.header,chunk.subarray(0,FILE_CHUNK_BYTES-this.header.length)]);
    if(this.decoder){let text:string;try{text=this.decoder.decode(chunk,{stream:true});}catch{throw new Error('Text files must be UTF-8.');}if(text.includes('\0'))throw new Error('Binary data is not a text document.');}
  }
  finish() {
    if(!this.bytes)throw new Error('Documents must not be empty.');
    if(this.decoder){try{this.decoder.decode();}catch{throw new Error('Text files must be UTF-8.');}}
    validateFileHeader(this.meta.filename,this.header);
    if(this.meta.ext==='html'&&!/^\s*(?:<!doctype html[^>]*>\s*)?<html[\s>]/i.test(this.header.toString('utf8')))throw new Error('Expected a complete HTML document with its opening tag in the first 64 KiB.');
    return {filename:this.meta.filename,mime:this.meta.mime,bytes:this.bytes,sha256:this.hash.digest('hex')};
  }
}
export async function digestHandle(handle:FileHandle,filename:string,signal?:AbortSignal) {
  const check=new FileDigest(filename),buffer=Buffer.alloc(FILE_CHUNK_BYTES);let offset=0;
  for(;;){signal?.throwIfAborted();const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);if(!bytesRead)break;check.add(buffer.subarray(0,bytesRead));offset+=bytesRead;}
  return check.finish();
}
/** Local admin only. Returns the same descriptor for streaming the reviewed bytes. */
export async function inspectLocalArtifact(path:string) {
  if(!isAbsolute(path)||normalize(path)!==path||await realpath(path)!==path)throw new Error('Use an absolute canonical file path without symlinks or traversal.');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before=await handle.stat();
    if(!before.isFile()||before.nlink!==1||before.size<1||before.size>MAX_OUTGOING_DOCUMENT_BYTES)throw new Error('Select a regular, unlinked file of 1 byte to 2,097,152,000 bytes.');
    const meta=await digestHandle(handle,basename(path));
    const after=await handle.stat();
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('Selected file changed during review. Review it and try again.');
    return {handle,...meta};
  }catch(e){await handle.close();throw e;}
}

/** A bounded positional stream that never takes ownership of the caller's descriptor. */
export function streamHandle(handle:FileHandle,bytes:number) {
  async function* chunks() {
    const buffer=Buffer.alloc(FILE_CHUNK_BYTES);let offset=0;
    while(offset<bytes){const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,bytes-offset),offset);if(!bytesRead)throw new Error('Document became shorter during upload.');offset+=bytesRead;yield Buffer.from(buffer.subarray(0,bytesRead));}
  }
  return Readable.from(chunks(),{highWaterMark:FILE_CHUNK_BYTES,objectMode:false});
}

/** Bounded synchronous verification for the existing synchronous routing transaction. */
export function digestFileSync(path:string,filename:string,limit=MAX_OUTGOING_DOCUMENT_BYTES) {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before=fstatSync(fd);if(!before.isFile()||before.nlink!==1||before.size<1||before.size>limit)throw new Error('Attachment staging integrity or size check failed.');
    const check=new FileDigest(filename,limit),buffer=Buffer.alloc(FILE_CHUNK_BYTES);let offset=0;
    for(;;){const read=readSync(fd,buffer,0,buffer.length,offset);if(!read)break;check.add(buffer.subarray(0,read));offset+=read;}
    const after=fstatSync(fd);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('Attachment changed during integrity verification.');return check.finish();
  }finally{closeSync(fd);}
}
