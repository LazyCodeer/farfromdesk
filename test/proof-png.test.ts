import test from 'node:test';
import assert from 'node:assert/strict';
import {crc32,deflateSync,inflateSync} from 'node:zlib';
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
function readChunk(data:Buffer,name:string){
  for(let offset=8;offset+12<=data.length;){const size=data.readUInt32BE(offset),type=data.toString('latin1',offset+4,offset+8);if(type===name)return data.subarray(offset+8,offset+8+size);offset+=size+12;}
  return undefined;
}
function disguisedType(source:Buffer,name:string){
  const out=Buffer.from(source);
  for(let offset=8;offset+12<=out.length;){
    const size=out.readUInt32BE(offset);if(out.toString('latin1',offset+4,offset+8)===name){
      out[offset+4]|=0x80;out.writeUInt32BE(crc32(out.subarray(offset+4,offset+8+size)),offset+8+size);return out;
    }offset+=size+12;
  }
  throw new Error('chunk not found');
}

test('PNG text, EXIF, timestamp and resolution metadata are removed without changing pixels',()=>{
  const exif=Buffer.concat([Buffer.from([73,73,42,0,8,0,0,0,0,0,0,0,0,0]),Buffer.from('private location')]);
  const compressed=Buffer.concat([Buffer.from('Comment\0'),Buffer.from([0]),deflateSync(Buffer.from('compressed private text'))]);
  const international=Buffer.concat([Buffer.from('Comment\0'),Buffer.from([0,0]),Buffer.from('en\0Keyword\0international private text')]);
  const original=png(),source=png({before:[chunk('tEXt',Buffer.from('Comment\0private user data')),chunk('zTXt',compressed),chunk('iTXt',international),chunk('eXIf',exif),chunk('pHYs',Buffer.from([0,0,0,1,0,0,0,1,1]))],after:[chunk('tIME',Buffer.from([7,234,1,2,3,4,5]))]});
  const sanitized=sanitizeProofPng(source);assert.deepEqual(sanitized,sanitizeProofPng(original));assert.ok(!sanitized!.includes(Buffer.from('private')));
});

test('color-rendering chunks are retained while zero-alpha colors are normalized',()=>{
  const rgba=png({before:[chunk('sRGB',Buffer.from([0])),chunk('gAMA',Buffer.from([0,0,177,143]))],raw:Buffer.from([0,10,20,30,0])});
  const sanitized=sanitizeProofPng(rgba);assert.ok(sanitized);
  assert.deepEqual(readChunk(sanitized,'sRGB'),readChunk(rgba,'sRGB'));assert.deepEqual(readChunk(sanitized,'gAMA'),readChunk(rgba,'gAMA'));
  assert.deepEqual(inflateSync(readChunk(sanitized,'IDAT')!),Buffer.from([0,0,0,0,0]));
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

test('non-ASCII chunk bytes fail closed even with a valid CRC',()=>{
  const source=png({before:[chunk('tEXt',Buffer.from('key\0value'))]});
  // Node's ASCII decoder masks the high bit. These malformed bytes must not
  // be accepted as IHDR, IDAT, or a known ancillary chunk.
  for(const name of ['IHDR','IDAT','tEXt','IEND'])assert.equal(sanitizeProofPng(disguisedType(source,name)),undefined);
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

test('indexed-color images fail closed for both valid and invalid palette indexes',()=>{
  const palette=chunk('PLTE',Buffer.from([255,0,0,0,0,255]));
  const valid=png({width:2,color:3,before:[palette],raw:Buffer.from([1,1,255])}); // reconstructed indexes [1,0]
  const invalid=png({width:2,color:3,before:[palette],raw:Buffer.from([1,1,1])}); // reconstructed indexes [1,2]
  assert.equal(sanitizeProofPng(valid),undefined);assert.equal(sanitizeProofPng(invalid),undefined);
});

test('all indexed PNG filters fail closed',()=>{
  const palette=chunk('PLTE',Buffer.from([1,2,3,4,5,6,7,8,9,10,11,12]));
  for(const [filter,encoded] of [[0,[2,3]],[1,[2,1]],[2,[2,2]],[3,[2,2]],[4,[2,1]]] as const){
    const source=png({width:2,height:2,color:3,before:[palette],raw:Buffer.from([0,0,1,filter,...encoded])});
    assert.equal(sanitizeProofPng(source),undefined,`filter ${filter}`);
  }
});

test('indexed PNGs with unused palette or background entries fail closed',()=>{
  const colors=Buffer.concat([Buffer.from([10,20,30,40,50,60,70,80,90]),Buffer.from('hidden123')]);
  const alpha=Buffer.from([255,200,100,11,22,33]);
  const source=png({width:2,color:3,before:[chunk('PLTE',colors),chunk('tRNS',alpha),chunk('bKGD',Buffer.from([2]))],raw:Buffer.from([0,0,1])});
  assert.equal(sanitizeProofPng(source),undefined);
});

test('an indexed palette without a background also fails closed',()=>{
  const source=png({color:3,before:[chunk('PLTE',Buffer.from([1,2,3,4,5,6]))],raw:Buffer.from([0,0])});
  assert.equal(sanitizeProofPng(source),undefined);
});

test('duplicate palette indexes cannot carry hidden text through the image',()=>{
  const bytes=Buffer.from('SECRET','ascii'),indexes=[...bytes].flatMap(byte=>Array.from({length:8},(_,i)=>(byte>>(7-i))&1));
  const identical=chunk('PLTE',Buffer.from([40,50,60,40,50,60]));
  const source=png({width:indexes.length,color:3,before:[identical],raw:Buffer.from([0,...indexes])});
  // Every index has the same visible RGB color but the choice of index encodes
  // the text. Without a proven canonical indexed-color conversion, reject it.
  assert.equal(sanitizeProofPng(source),undefined);
});

test('ordinary 8-bit RGB, RGBA and grayscale screenshots remain supported',()=>{
  for(const [color,raw] of [
    [0,[0,42]], [2,[0,42,84,126]], [4,[0,42,255]], [6,[0,42,84,126,255]],
  ] as const){
    const source=png({color,raw:Buffer.from(raw)}),result=sanitizeProofPng(source);
    assert.ok(result,`color type ${color}`);assert.deepEqual(inflateSync(readChunk(result,'IDAT')!),Buffer.from(raw));
  }
});

test('a suggested true-color palette is rejected rather than leaking unused bytes',()=>{
  const source=png({color:2,before:[chunk('PLTE',Buffer.from('hidden123'))],raw:Buffer.from([0,1,2,3])});
  assert.equal(sanitizeProofPng(source),undefined);
});

test('equivalent pixels with different filters and deflate encodings have the same sanitized bytes',()=>{
  const pixels=Buffer.from([10,20,30,255]),raw0=Buffer.concat([Buffer.from([0]),pixels]),raw1=Buffer.concat([Buffer.from([1]),pixels]);
  const first=png({raw:raw0}),second=png({encoded:deflateSync(raw1,{level:0})});
  assert.notDeepEqual(first,second);
  const sanitized=sanitizeProofPng(first);assert.ok(sanitized);assert.deepEqual(sanitizeProofPng(second),sanitized);
  assert.deepEqual(inflateSync(readChunk(sanitized,'IDAT')!),raw0);
});

test('nonzero DEFLATE padding bits do not survive canonical re-encoding',()=>{
  const raw=Buffer.from([0,10,20,30,255]),ordinary=deflateSync(raw,{level:0}),padded=Buffer.from(ordinary);
  // In the first uncompressed block, the high bits after BFINAL/BTYPE are
  // ignored padding. Both streams decode identically, but one carries bits.
  assert.equal(ordinary[2]&7,1);padded[2]|=0xf8;assert.deepEqual(inflateSync(padded),raw);
  const first=png({encoded:ordinary}),second=png({encoded:padded});assert.notDeepEqual(first,second);
  const sanitized=sanitizeProofPng(first);assert.ok(sanitized);assert.deepEqual(sanitizeProofPng(second),sanitized);
});

test('multi-channel filter reconstruction keeps visible RGB pixels unchanged',()=>{
  const expected=Buffer.from([0,10,20,30,40,50,60,0,15,25,35,45,55,65]);
  const source=png({width:2,height:2,color:2,raw:Buffer.from([1,10,20,30,30,30,30,2,5,5,5,5,5,5])});
  const result=sanitizeProofPng(source);assert.ok(result);assert.deepEqual(inflateSync(readChunk(result,'IDAT')!),expected);
});

test('zero-alpha RGB and gray data are normalized while visible colors remain',()=>{
  const source=png({width:2,raw:Buffer.from([0,65,66,67,0,10,20,30,128])}),result=sanitizeProofPng(source);assert.ok(result);
  assert.deepEqual(inflateSync(readChunk(result,'IDAT')!),Buffer.from([0,0,0,0,0,10,20,30,128]));
  const composite=(pixel:number[],background:number[])=>pixel.slice(0,3).map((c,i)=>Math.round((c*pixel[3]+background[i]*(255-pixel[3]))/255));
  for(const background of [[0,0,0],[255,255,255],[20,40,60]]){
    assert.deepEqual(composite([65,66,67,0],background),composite([0,0,0,0],background));
    assert.deepEqual(composite([10,20,30,128],background),composite([10,20,30,128],background));
  }
  const gray=png({width:2,color:4,raw:Buffer.from([0,99,0,33,255])}),clean=sanitizeProofPng(gray);assert.ok(clean);
  assert.deepEqual(inflateSync(readChunk(clean,'IDAT')!),Buffer.from([0,0,0,33,255]));
});

test('normalizing a transparent row does not change later pixels that filter against it',()=>{
  // The second row uses Up filtering against nonzero RGB in the transparent
  // first row. Decoding must use the original row before normalizing it.
  const source=png({width:1,height:2,raw:Buffer.from([0,100,120,140,0,2,166,156,146,255])});
  const result=sanitizeProofPng(source);assert.ok(result);
  assert.deepEqual(inflateSync(readChunk(result,'IDAT')!),Buffer.from([0,0,0,0,0,0,10,20,30,255]));
});

test('fully transparent indexed colors fail closed even with a declared background',()=>{
  const colors=Buffer.from([65,66,67,10,20,30]),alpha=Buffer.from([0,255]),raw=Buffer.from([0,0,1]);
  const source=png({width:2,color:3,before:[chunk('PLTE',colors),chunk('tRNS',alpha)],raw});assert.equal(sanitizeProofPng(source),undefined);
  const bg=png({width:2,color:3,before:[chunk('PLTE',colors),chunk('tRNS',alpha),chunk('bKGD',Buffer.from([0]))],raw});assert.equal(sanitizeProofPng(bg),undefined);
});

test('an unneeded background and color-key transparency do not pass hidden data through',()=>{
  const source=png({color:6,before:[chunk('bKGD',Buffer.from([0,1,0,2,0,3]))],raw:Buffer.from([0,4,5,6,255])}),result=sanitizeProofPng(source);assert.ok(result);
  assert.equal(readChunk(result,'bKGD'),undefined);assert.deepEqual(inflateSync(readChunk(result,'IDAT')!),Buffer.from([0,4,5,6,255]));
  assert.equal(sanitizeProofPng(png({color:2,before:[chunk('tRNS',Buffer.from([0,1,0,2,0,3]))],raw:Buffer.from([0,1,2,3])})),undefined);
  assert.equal(sanitizeProofPng(png({color:0,before:[chunk('tRNS',Buffer.from([0,1]))],raw:Buffer.from([0,1])})),undefined);
});
