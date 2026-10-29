import {crc32,inflateSync} from 'node:zlib';

// A deliberately narrow PNG subset. Unknown chunks, custom color profiles,
// animation, interlacing and non-8-bit pixels are not silently reinterpreted.
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

/** Return a valid metadata-stripped PNG, or undefined for malformed/unsupported data. */
export function sanitizeProofPng(input:Uint8Array):Buffer|undefined {
  try {
    if(!(input instanceof Uint8Array)||input.byteLength<45||input.byteLength>maxBytes)return;
    const data=Buffer.from(input);if(!data.subarray(0,8).equals(signature))return;
    let offset=8,count=0,width=0,height=0,color=-1,palette=0,seenData=false,dataEnded=false,seenEnd=false,gamma:number|undefined,chroma:number[]|undefined;
    const seen=new Set<string>(),image:Buffer[]=[],compressed:Buffer[]=[ ];
    while(offset+12<=data.length&&count++<1024){
      const length=data.readUInt32BE(offset),end=offset+length+12;if(end>data.length)return;
      const type=data.toString('ascii',offset+4,offset+8),body=data.subarray(offset+8,offset+8+length);
      if(!/^[A-Za-z]{4}$/.test(type)||type[2]!==type[2].toUpperCase()||crc32(data.subarray(offset+4,offset+8+length))!==data.readUInt32BE(offset+8+length))return;
      if(seenEnd)return;
      if(offset===8){
        if(type!=='IHDR'||length!==13)return;
        width=body.readUInt32BE(0);height=body.readUInt32BE(4);color=body[9];
        if(!width||!height||width>4096||height>4096||width*height>maxPixels||body[8]!==8||![0,2,3,4,6].includes(color)||body[10]!==0||body[11]!==0||body[12]!==0)return;
        seen.add(type);image.push(data.subarray(offset,end));offset=end;continue;
      }
      if(type==='IHDR'||type==='iCCP'||type==='acTL'||type==='fcTL'||type==='fdAT')return;
      if(type!=='IDAT'&&seenData)dataEnded=true;
      if(type==='PLTE'){
        if(seen.has(type)||seenData||[0,4].includes(color)||length<3||length>768||length%3)return;
        palette=length/3;seen.add(type);image.push(data.subarray(offset,end));
      } else if(type==='IDAT'){
        if(dataEnded||color===3&&!palette)return;
        seenData=true;compressed.push(body);image.push(data.subarray(offset,end));
      } else if(type==='IEND'){
        if(length||!seenData||end!==data.length)return;
        seenEnd=true;image.push(data.subarray(offset,end));
      } else if(rendering.has(type)){
        if(seen.has(type)||seenData)return;
        if(['gAMA','cHRM','sRGB','sBIT'].includes(type)&&palette)return;
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
          const expected=({0:1,2:3,3:3,4:2,6:4} as Record<number,number>)[color];
          if(length!==expected||[...body].some(value=>value<1||value>8))return;
        }
        if(type==='tRNS'){
          if(color===0&&length!==2||color===2&&length!==6||color===3&&(!palette||length<1||length>palette)||[4,6].includes(color))return;
          if(color===0&&body.readUInt16BE(0)>255||color===2&&(body.readUInt16BE(0)>255||body.readUInt16BE(2)>255||body.readUInt16BE(4)>255))return;
        }
        if(type==='bKGD'){
          if([0,4].includes(color)&&length!==2||[2,6].includes(color)&&length!==6||color===3&&(!palette||length!==1||body[0]>=palette))return;
          if([0,4].includes(color)&&body.readUInt16BE(0)>255||[2,6].includes(color)&&(body.readUInt16BE(0)>255||body.readUInt16BE(2)>255||body.readUInt16BE(4)>255))return;
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
    // Bound decompression and validate the exact number of scanlines and their
    // filter bytes. Re-using original IDAT retains pixels and color rendering.
    const channels=({0:1,2:3,3:1,4:2,6:4} as Record<number,number>)[color],rowBytes=width*channels,expected=(rowBytes+1)*height,encoded=Buffer.concat(compressed);
    const decoded=inflateSync(encoded,{info:true,maxOutputLength:expected+1}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
    if(decoded.buffer.length!==expected||decoded.engine.bytesWritten!==encoded.length)return;
    let previous=Buffer.alloc(width),current=Buffer.alloc(width);
    for(let row=0;row<height;row++){
      const start=row*(rowBytes+1),filter=decoded.buffer[start];if(filter>4)return;
      if(color===3){
        for(let x=0;x<width;x++){
          const left=x?current[x-1]:0,above=previous[x],upperLeft=x?previous[x-1]:0;
          let predictor=0;
          if(filter===1)predictor=left;
          else if(filter===2)predictor=above;
          else if(filter===3)predictor=Math.floor((left+above)/2);
          else if(filter===4){
            const p=left+above-upperLeft,da=Math.abs(p-left),db=Math.abs(p-above),dc=Math.abs(p-upperLeft);
            predictor=da<=db&&da<=dc?left:db<=dc?above:upperLeft;
          }
          current[x]=(decoded.buffer[start+1+x]+predictor)&255;if(current[x]>=palette)return;
        }
        [previous,current]=[current,previous];
      }
    }
    return Buffer.concat([signature,...image]);
  }catch{return;}
}
