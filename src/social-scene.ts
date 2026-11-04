import {vectorSceneSvg,type VectorScene} from './social-vector.js';
import sharp,{type OverlayOptions} from 'sharp';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
export const socialIllustrations=['cart','channels','knowledge','rules','review'] as const;
export type SocialIllustration=typeof socialIllustrations[number];
const asset=(name:string)=>fileURLToPath(new URL('../skills/ffd-social-creative/assets/'+name,import.meta.url));
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
export async function renderSocialScene(brand:{name:string;accent:string;background:string;foreground:string;logo?:'spliceai'},s:{headline:string;body?:string;eyebrow?:string;illustration?:SocialIllustration;drawing?:VectorScene;tone?:'dark'|'light';footer?:string},index:number,count:number){
 if(!s.drawing&&(!s.illustration||!socialIllustrations.includes(s.illustration)))throw Error('Choose a bundled illustration.');
 const light=s.tone==='light',bg=light?'#f6f7fb':brand.background,fg=light?'#0f172a':brand.foreground;
 const overlays:OverlayOptions[]=[];
 const put=async(value:string,x:number,y:number,w:number,h:number,size:number,color=fg,bold=false)=>{
  for(let f=size;f>=Math.min(size,Math.max(22,size-14));f-=2){
   const fontfile=asset(bold?'BricolageGrotesque-Bold.ttf':'InstrumentSans-Regular.ttf');
   const out=await sharp({text:{text:`<span foreground="${color}">${escape(value)}</span>`,font:`${bold?'Bricolage Grotesque Bold':'Instrument Sans'} ${f}`,fontfile,width:w,rgba:true,wrap:'word',spacing:0}}).png().toBuffer({resolveWithObject:true});
   if(out.info.height<=h&&out.info.width<=w){overlays.push({input:out.data,left:x,top:y});return out.info.height;}
  }
  throw Error('Illustration copy does not fit. Shorten or split this slide.');
 };
 let brandX=64;
 if(brand.logo==='spliceai'){
  const icon=await sharp(readFileSync(asset('spliceai-icon.svg'))).resize(48,48).png().toBuffer();overlays.push({input:icon,left:64,top:48});brandX=128;
 }
 await put(brand.name,brandX,55,460,48,32,fg,true);
 if(s.eyebrow)await put(s.eyebrow,620,62,396,40,26,fg);
 await put(s.headline,64,173,952,250,99,fg,true);
 if(s.body)await put(s.body,68,437,936,98,36,fg);
 // Only bundled artwork, never model markup, paths, remote URLs or process execution.
 const bytes=s.drawing?vectorSceneSvg(s.drawing):readFileSync(asset('illustrations/'+s.illustration+'.svg'));
 const art=await sharp(bytes,{limitInputPixels:4_000_000}).resize(948,575,{fit:'contain',background:'#00000000'}).png().toBuffer();
 overlays.push({input:art,left:66,top:555});
 if(s.footer)await put(s.footer,68,1176,940,77,34,fg,true);
 await put(brand.name,68,1280,700,40,24,fg);
 await put(`${String(index+1).padStart(2,'0')} / ${String(count).padStart(2,'0')}`,900,1280,120,40,24,fg);
 const shapes=`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350"><defs><radialGradient id="halo"><stop stop-color="${brand.accent}" stop-opacity="${light?'.12':'.3'}"/><stop offset="1" stop-color="${brand.accent}" stop-opacity="0"/></radialGradient></defs><rect width="1080" height="1350" fill="${bg}"/><ellipse cx="570" cy="836" rx="590" ry="400" fill="url(#halo)"/><path d="M64 126H1016M64 1148H1016M64 1260H1016" stroke="${fg}" stroke-opacity=".15"/></svg>`;
 const output=await sharp(Buffer.from(shapes)).composite(overlays).jpeg({quality:94,chromaSubsampling:'4:4:4'}).toBuffer();
 if(output.length>2_000_000)throw Error('Rendered slide is too large.');
 const thumbnail=await sharp(output).resize(360,450).jpeg({quality:85,chromaSubsampling:'4:4:4'}).toBuffer();
 return {base64:output.toString('base64'),thumbnail:thumbnail.toString('base64'),sha256:createHash('sha256').update(output).digest('hex'),alt:[s.headline,s.body,s.footer].filter(Boolean).join(' ')};
}
