import {constants,crc32,deflateSync,inflateSync} from 'node:zlib';

// A deliberately narrow PNG subset. Unknown chunks, custom color profiles,
// animation, indexed color, interlacing and non-8-bit pixels are not silently reinterpreted.
// Ancillary text/EXIF metadata is discarded; pixel data is not redacted.
const signature=Buffer.from([137,80,78,71,13,10,26,10]);
const maxBytes=4*1024*1024,maxPixels=8_000_000;
const metadata=new Set(['tEXt','zTXt','iTXt','eXIf','tIME','pHYs']);
const rendering=new Set(['gAMA','cHRM','sRGB','sBIT','bKGD','tRNS']);

function validKeyword(value:Buffer) {
  return value.length>0&&value.length<=79&&value[0]!==32&&value[value.length-1]!==32&&
    !value.some((byte,index)=>byte===32&&value[index+1]===32||byte<32||byte>126&&byte<161);
}
function textData(value:Buffer) {
  // Node's `info:true` runtime result includes the engine; older @types/node
  // versions incorrectly declare only a Buffer for this overload.
  try {const out=inflateSync(value,{info:true,maxOutputLength:1024*1024}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};return out.engine.bytesWritten===value.length?out.buffer:undefined;}catch{return;}
}
function validMetadata(type:string,body:Buffer) {
  if(type==='eXIf'){
    if(body.length<14)return false;
    const little=body.subarray(0,2).equals(Buffer.from('II')),big=body.subarray(0,2).equals(Buffer.from('MM'));
    if(!little&&!big)return false;
    const read16=(offset:number)=>little?body.readUInt16LE(offset):body.readUInt16BE(offset);
    const read32=(offset:number)=>little?body.readUInt32LE(offset):body.readUInt32BE(offset);
    if(read16(2)!==42)return false;
    const ifd=read32(4);if(ifd<8||ifd+2>body.length)return false;
    return ifd+2+read16(ifd)*12+4<=body.length;
  }
  if(type==='tIME'){
    if(body.length!==7)return false;
    const year=body.readUInt16BE(0),month=body[2],day=body[3],hour=body[4],minute=body[5],second=body[6];
    if(year<100||month<1||month>12||day<1||hour>23||minute>59||second>60)return false;
    return new Date(Date.UTC(year,month,0)).getUTCDate()>=day;
  }
  if(type==='pHYs')return body.length===9&&body[8]<=1;
  const zero=body.indexOf(0);if(zero<1||!validKeyword(body.subarray(0,zero)))return false;
  if(type==='tEXt')return !body.subarray(zero+1).includes(0);
  if(type==='zTXt')return zero+2<body.length&&body[zero+1]===0&&!!textData(body.subarray(zero+2));
  if(type==='iTXt'){
    if(zero+3>body.length||body[zero+1]>1||body[zero+2]!==0)return false;
    const langEnd=body.indexOf(0,zero+3);if(langEnd<0)return false;
    const keywordEnd=body.indexOf(0,langEnd+1);if(keywordEnd<0)return false;
    if([...body.subarray(zero+3,langEnd)].some(byte=>byte!==45&&(byte<48||byte>57)&&(byte<65||byte>90)&&(byte<97||byte>122)))return false;
    try {
      const decoder=new TextDecoder('utf-8',{fatal:true});decoder.decode(body.subarray(langEnd+1,keywordEnd));
      const text=body[zero+1]===1?textData(body.subarray(keywordEnd+1)):body.subarray(keywordEnd+1);
      if(!text||text.includes(0))return false;
      decoder.decode(text);return true;
    }catch{return false;}
  }
  return false;
}

function chunk(type:string,body:Buffer) {
  const size=Buffer.alloc(4),name=Buffer.from(type,'ascii'),checksum=Buffer.alloc(4);
  size.writeUInt32BE(body.length);checksum.writeUInt32BE(crc32(Buffer.concat([name,body])));
  return Buffer.concat([size,name,body,checksum]);
}

/** Return a valid metadata-stripped PNG, or undefined for malformed/unsupported data. */
export function sanitizeProofPng(input:Uint8Array):Buffer|undefined {
  try {
    if(!(input instanceof Uint8Array)||input.byteLength<45||input.byteLength>maxBytes)return;
    const data=Buffer.from(input);if(!data.subarray(0,8).equals(signature))return;
    let offset=8,count=0,width=0,height=0,color=-1,backgroundChunk=-1,idatChunk=-1,seenData=false,dataEnded=false,seenEnd=false,gamma:number|undefined,chroma:number[]|undefined;
    const seen=new Set<string>(),image:Buffer[]=[],compressed:Buffer[]=[ ];
    while(offset+12<=data.length&&count++<1024){
      const length=data.readUInt32BE(offset),end=offset+length+12;if(end>data.length)return;
      const typeBytes=data.subarray(offset+4,offset+8),body=data.subarray(offset+8,offset+8+length);
      // Node's 'ascii' decoder masks the high bit, so validate raw bytes
      // before decoding rather than accepting an invalid disguised chunk.
      if([...typeBytes].some(byte=>(byte<65||byte>90)&&(byte<97||byte>122)))return;
      const type=typeBytes.toString('latin1');
      if(type[2]!==type[2].toUpperCase()||crc32(data.subarray(offset+4,offset+8+length))!==data.readUInt32BE(offset+8+length))return;
      if(seenEnd)return;
      if(offset===8){
        if(type!=='IHDR'||length!==13)return;
        width=body.readUInt32BE(0);height=body.readUInt32BE(4);color=body[9];
        // Indexed colors permit invisible data in choices between duplicate
        // palette entries. Reject them rather than claiming safe normalization.
        if(!width||!height||width>4096||height>4096||width*height>maxPixels||body[8]!==8||![0,2,4,6].includes(color)||body[10]!==0||body[11]!==0||body[12]!==0)return;
        seen.add(type);image.push(data.subarray(offset,end));offset=end;continue;
      }
      if(type==='IHDR'||type==='iCCP'||type==='acTL'||type==='fcTL'||type==='fdAT')return;
      if(type!=='IDAT'&&seenData)dataEnded=true;
      if(type==='PLTE'){
        // Suggested palettes on true-color images are also outside the safe subset.
        return;
      } else if(type==='IDAT'){
        if(dataEnded)return;
        if(!seenData){idatChunk=image.length;image.push(Buffer.alloc(0));}
        seenData=true;compressed.push(body);
      } else if(type==='IEND'){
        if(length||!seenData||end!==data.length)return;
        seenEnd=true;image.push(data.subarray(offset,end));
      } else if(rendering.has(type)){
        if(seen.has(type)||seenData)return;
        if(type==='gAMA'){
          if(length!==4||body.readUInt32BE(0)===0||body.readUInt32BE(0)>1_000_000)return;
          gamma=body.readUInt32BE(0);
        }
        if(type==='cHRM'){
          if(length!==32)return;
          for(let i=0;i<32;i+=8)if(body.readUInt32BE(i)+body.readUInt32BE(i+4)>100_000)return;
          chroma=Array.from({length:8},(_,i)=>body.readUInt32BE(i*4));
        }
        if(type==='sRGB'&&(length!==1||body[0]>3))return;
        if(type==='sBIT'){
          const expected=({0:1,2:3,4:2,6:4} as Record<number,number>)[color];
          if(length!==expected||[...body].some(value=>value<1||value>8))return;
        }
        if(type==='tRNS'){
          // Color-key transparency can hide RGB/grayscale bytes. Converting it
          // safely needs a separate color-model transformation, so fail closed.
          return;
        }
        if(type==='bKGD'){
          if([0,4].includes(color)&&length!==2||[2,6].includes(color)&&length!==6)return;
          if([0,4].includes(color)&&body.readUInt16BE(0)>255||[2,6].includes(color)&&(body.readUInt16BE(0)>255||body.readUInt16BE(2)>255||body.readUInt16BE(4)>255))return;
          backgroundChunk=image.length;
        }
        seen.add(type);image.push(data.subarray(offset,end));
      } else if(metadata.has(type)){
        if(['eXIf','tIME','pHYs'].includes(type)&&seen.has(type))return;
        if(type==='pHYs'&&seenData||!validMetadata(type,body))return;
        seen.add(type);
      } else return;
      offset=end;
    }
    if(!seenEnd||offset!==data.length)return;
    // When sRGB is present, the PNG specification requires its accompanying
    // gamma and chromaticity values to match the sRGB color space.
    if(seen.has('sRGB')&&(gamma!==undefined&&gamma!==45455||chroma&&chroma.some((value,i)=>value!==[31270,32900,64000,33000,30000,60000,15000,6000][i])))return;
    // Bound decompression and fully undo the PNG filters. Never reuse original
    // IDAT bytes: their deflate padding and filter choices can contain hidden
    // data unrelated to the decoded image.
    const channels=({0:1,2:3,4:2,6:4} as Record<number,number>)[color],rowBytes=width*channels,expected=(rowBytes+1)*height,encoded=Buffer.concat(compressed);
    const decoded=inflateSync(encoded,{info:true,maxOutputLength:expected+1}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
    if(decoded.buffer.length!==expected||decoded.engine.bytesWritten!==encoded.length)return;
    let previous=Buffer.alloc(rowBytes),current=Buffer.alloc(rowBytes),hasTransparency=false;
    const canonical=Buffer.alloc(expected);
    for(let row=0;row<height;row++){
      const start=row*(rowBytes+1),filter=decoded.buffer[start];if(filter>4)return;
      for(let x=0;x<rowBytes;x++){
        const left=x>=channels?current[x-channels]:0,above=previous[x],upperLeft=x>=channels?previous[x-channels]:0;
        let predictor=0;
        if(filter===1)predictor=left;
        else if(filter===2)predictor=above;
        else if(filter===3)predictor=Math.floor((left+above)/2);
        else if(filter===4){
          const p=left+above-upperLeft,da=Math.abs(p-left),db=Math.abs(p-above),dc=Math.abs(p-upperLeft);
          predictor=da<=db&&da<=dc?left:db<=dc?above:upperLeft;
        }
        current[x]=(decoded.buffer[start+1+x]+predictor)&255;
      }
      // Filter 0 is fixed rather than selected from the untrusted input.
      current.copy(canonical,start+1);
      for(let x=0;x<width;x++){
        if(color===4||color===6){
          const alpha=current[x*channels+channels-1];if(alpha<255)hasTransparency=true;
          // Fully transparent color channels do not affect composited pixels;
          // canonicalize them so they cannot carry invisible text.
          if(alpha===0)canonical.fill(0,start+1+x*channels,start+x*channels+channels);
        }
      }
      [previous,current]=[current,previous];
    }
    if(backgroundChunk>=0&&!hasTransparency)image[backgroundChunk]=Buffer.alloc(0);
    // A fixed filter and compression strategy produce bytes determined by the
    // normalized pixels, rather than by the source's encoding choices.
    image[idatChunk]=chunk('IDAT',deflateSync(canonical,{level:9,strategy:constants.Z_FIXED,maxOutputLength:maxBytes}));
    const output=Buffer.concat([signature,...image]);return output.length<=maxBytes?output:undefined;
  }catch{return;}
}
