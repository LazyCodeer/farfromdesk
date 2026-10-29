import test from 'node:test';
import assert from 'node:assert/strict';
import {crc32,deflateSync} from 'node:zlib';
import {sanitizeProofPng} from '../src/proof-png.js';

const signature=Buffer.from([137,80,78,71,13,10,26,10]);
function chunk(type:string,payload:Buffer){
  const label=Buffer.from(type,'ascii'),size=Buffer.alloc(4),crc=Buffer.alloc(4);
  size.writeUInt32BE(payload.length);crc.writeUInt32BE(crc32(Buffer.concat([label,payload])));
  return Buffer.concat([size,label,payload,crc]);
}
function png(options:{width?:number;height?:number;color?:number;depth?:number;interlace?:number;raw?:Buffer;encoded?:Buffer;before?:Buffer[];after?:Buffer[]}={}){
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(options.width??1,0);ihdr.writeUInt32BE(options.height??1,4);
  ihdr[8]=options.depth??8;ihdr[9]=options.color??6;ihdr[12]=options.interlace??0;
  const encoded=options.encoded??deflateSync(options.raw??Buffer.from([0,10,20,30,255]));
  return Buffer.concat([signature,chunk('IHDR',ihdr),...(options.before??[]),chunk('IDAT',encoded),...(options.after??[]),chunk('IEND',Buffer.alloc(0))]);
}

test('PNG text, EXIF, timestamp and resolution metadata are removed without changing pixels',()=>{
  const exif=Buffer.concat([Buffer.from([73,73,42,0,8,0,0,0,0,0,0,0,0,0]),Buffer.from('private location')]);
  const compressed=Buffer.concat([Buffer.from('Comment\0'),Buffer.from([0]),deflateSync(Buffer.from('compressed private text'))]);
  const international=Buffer.concat([Buffer.from('Comment\0'),Buffer.from([0,0]),Buffer.from('en\0Keyword\0international private text')]);
  const original=png(),source=png({before:[chunk('tEXt',Buffer.from('Comment\0private user data')),chunk('zTXt',compressed),chunk('iTXt',international),chunk('eXIf',exif),chunk('pHYs',Buffer.from([0,0,0,1,0,0,0,1,1]))],after:[chunk('tIME',Buffer.from([7,234,1,2,3,4,5]))]});
  const sanitized=sanitizeProofPng(source);assert.deepEqual(sanitized,original);assert.ok(!sanitized!.includes(Buffer.from('private')));
});

test('supported color-rendering chunks and transparent pixels are retained byte-for-byte',()=>{
  const rgba=png({before:[chunk('sRGB',Buffer.from([0])),chunk('gAMA',Buffer.from([0,0,177,143]))],raw:Buffer.from([0,10,20,30,0])});
  assert.deepEqual(sanitizeProofPng(rgba),rgba);
  const palette=png({color:3,before:[chunk('PLTE',Buffer.from([255,0,0,0,0,255])),chunk('tRNS',Buffer.from([255,0]))],raw:Buffer.from([0,1])});
  assert.deepEqual(sanitizeProofPng(palette),palette);
});

test('unsupported color profiles, animation, interlacing and unknown chunks fail closed',()=>{
  for(const source of [png({before:[chunk('iCCP',Buffer.from('profile'))]}),png({before:[chunk('acTL',Buffer.alloc(8))]}),
    png({before:[chunk('vpAg',Buffer.from('unknown'))]}),png({interlace:1}),png({depth:16}),
    png({before:[chunk('sRGB',Buffer.from([0])),chunk('gAMA',Buffer.from([0,0,0,1]))]})])assert.equal(sanitizeProofPng(source),undefined);
});

test('corrupt CRC, malformed ordering, truncated or oversized PNGs fail closed',()=>{
  const corrupt=png({before:[chunk('tEXt',Buffer.from('key\0value'))]});corrupt[45]^=1;
  const latePalette=png({color:3,before:[],after:[chunk('PLTE',Buffer.from([0,0,0]))],raw:Buffer.from([0,0])});
  const duplicate=png({before:[chunk('sRGB',Buffer.from([0])),chunk('sRGB',Buffer.from([0]))]});
  const lateData=png({after:[chunk('tEXt',Buffer.from('key\0value')),chunk('IDAT',Buffer.alloc(0))]});
  for(const source of [corrupt,latePalette,duplicate,lateData,png().subarray(0,-1),Buffer.alloc(4*1024*1024+1),png({width:4097})])assert.equal(sanitizeProofPng(source),undefined);
});

test('malformed metadata is rejected before it can be stripped',()=>{
  for(const metadata of [chunk('tEXt',Buffer.from('missing separator')),chunk('zTXt',Buffer.from('Comment\0\0not-zlib')),
    chunk('iTXt',Buffer.from('Comment\0\0\0bad')),chunk('eXIf',Buffer.from('not-tiff')),chunk('tIME',Buffer.from([7,234,2,30,0,0,0]))]){
    assert.equal(sanitizeProofPng(png({before:[metadata]})),undefined);
  }
});

test('invalid deflate streams, scanline sizes, filters and palette indexes fail closed',()=>{
  const extra=Buffer.concat([deflateSync(Buffer.from([0,10,20,30,255])),Buffer.from('extra')]);
  const invalidPalette=png({color:3,before:[chunk('PLTE',Buffer.from([0,0,0]))],raw:Buffer.from([0,1])});
  for(const source of [png({encoded:Buffer.from('not-zlib')}),png({encoded:extra}),png({raw:Buffer.from([5,10,20,30,255])}),
    png({raw:Buffer.from([0,10,20,30])}),invalidPalette])assert.equal(sanitizeProofPng(source),undefined);
});

test('palette delta filters are decoded before index validation',()=>{
  const palette=chunk('PLTE',Buffer.from([255,0,0,0,0,255]));
  const valid=png({width:2,color:3,before:[palette],raw:Buffer.from([1,1,255])}); // reconstructed indexes [1,0]
  const invalid=png({width:2,color:3,before:[palette],raw:Buffer.from([1,1,1])}); // reconstructed indexes [1,2]
  assert.deepEqual(sanitizeProofPng(valid),valid);assert.equal(sanitizeProofPng(invalid),undefined);
});
