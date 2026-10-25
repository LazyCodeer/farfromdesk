/** Explicit transport types. These labels never authorize execution or extraction. */
// WhatsApp Web WAWebServerPropConstants.MAX_FILE_SIZE_BYTES (25 Oct 2026).
// Advertised as 2 GB: exactly 2000 MiB, not 2 GiB or 2,000,000,000 bytes.
export const MAX_FILE_BYTES = 2000 * 1024 * 1024;
export const MAX_OUTGOING_DOCUMENT_BYTES = MAX_FILE_BYTES;
export const MAX_INLINE_BYTES = 25 * 1024 * 1024; // Legacy JSON encoding only; use streaming for files.
export const MAX_IMAGE_BYTES = null; // Incoming images: WhatsApp's runtime per-type gate, no invented app cap.
export const fileTypes: Record<string, string> = {
  html:'text/html', pdf:'application/pdf', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', gif:'image/gif',
  txt:'text/plain', md:'text/markdown', csv:'text/csv', json:'application/json', xml:'application/xml', yaml:'application/yaml', yml:'application/yaml',
  log:'text/plain', js:'text/javascript', ts:'text/plain', tsx:'text/plain', jsx:'text/plain', css:'text/css', py:'text/plain', sh:'text/plain', sql:'text/plain', toml:'text/plain',
  zip:'application/zip', tar:'application/x-tar', gz:'application/gzip', tgz:'application/gzip', '7z':'application/x-7z-compressed',
  docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  apk:'application/vnd.android.package-archive', aab:'application/octet-stream', ipa:'application/octet-stream', dmg:'application/x-apple-diskimage',
  exe:'application/vnd.microsoft.portable-executable', msi:'application/x-msi', deb:'application/vnd.debian.binary-package', rpm:'application/x-rpm', wasm:'application/wasm', bin:'application/octet-stream', appimage:'application/octet-stream',
};
export const textTypes = new Set(['html','txt','md','csv','json','xml','yaml','yml','log','js','ts','tsx','jsx','css','py','sh','sql','toml']);
export function safeFilename(filename: unknown): string {
  if(typeof filename!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/.test(filename)||filename.includes('..')||/[. ]$/.test(filename)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(filename))
    throw new Error('Use a simple file name without paths, control characters or reserved names (maximum 120 characters).');
  return filename;
}
export function fileType(filename:unknown) {
  const name=safeFilename(filename),ext=name.split('.').pop()!.toLowerCase(),mime=fileTypes[ext];
  if(!mime)throw new Error('Unsupported file type. Use a supported document, source file, image, archive or build artifact.');
  return {filename:name,ext,mime};
}
export function validateFileHeader(filename:unknown,data:Buffer) {
  const {ext}=fileType(filename);
  const prefix=(bytes:number[]|string)=>data.subarray(0,Buffer.from(bytes).length).equals(Buffer.from(bytes));
  if(ext==='pdf'&&!prefix('%PDF-'))throw new Error('Invalid PDF signature.');
  if(ext==='png'&&!prefix([137,80,78,71,13,10,26,10]))throw new Error('Invalid PNG signature.');
  if(['jpg','jpeg'].includes(ext)&&!prefix([255,216,255]))throw new Error('Invalid JPEG signature.');
  if(ext==='webp'&&(!prefix('RIFF')||data.toString('ascii',8,12)!=='WEBP'))throw new Error('Invalid WebP signature.');
  if(ext==='gif'&&!['GIF87a','GIF89a'].includes(data.toString('ascii',0,6)))throw new Error('Invalid GIF signature.');
  if(['zip','docx','xlsx','pptx','apk','aab','ipa'].includes(ext)&&!prefix([80,75,3,4])&&!prefix([80,75,5,6]))throw new Error('Invalid ZIP container signature.');
  if(['gz','tgz'].includes(ext)&&!prefix([31,139]))throw new Error('Invalid gzip signature.');
  if(ext==='exe'&&!prefix('MZ'))throw new Error('Invalid executable signature.');
  if(ext==='wasm'&&!prefix([0,97,115,109]))throw new Error('Invalid WebAssembly signature.');
  return fileType(filename);
}
export function validateFile(filename:unknown,data:Buffer,limit=MAX_FILE_BYTES) {
  const {filename:name,ext,mime}=validateFileHeader(filename,data);
  if(!data.length||data.length>limit)throw new Error('Files must be nonempty and within the WhatsApp document limit (2,097,152,000 bytes).');
  if(textTypes.has(ext)) {
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{throw new Error('Text files must be UTF-8.');}
    if(text.includes('\0'))throw new Error('Binary data is not a text document.');
    if(ext==='html'&&!/^\s*(?:<!doctype html[^>]*>\s*)?<html[\s>]/i.test(text))throw new Error('Expected a complete HTML document.');
  }
  return {filename:name,mime,bytes:data.length};
}
