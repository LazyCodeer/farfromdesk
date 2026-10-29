import {parse,type DefaultTreeAdapterTypes as HTML} from 'parse5';

// A narrow recognition of an observed layout, not proof of rendering or of
// application availability. parse5 parses HTML according to browser rules.
const MAX_HTML_BYTES=512*1024,MAX_DEPTH=128,MAX_NODES=30000,MAX_CAPTURE=1000;
const INERT=new Set(['script','style','template','noscript','iframe','object','svg','math','textarea']);
const normalized=(s:string)=>s.replace(/\s+/g,' ').trim();
function hidden(attrs:Record<string,string>){return 'hidden' in attrs||attrs['aria-hidden']?.trim().toLowerCase()==='true'||/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs.style??'');}
function matchingUrl(value:string,host:string,board:string,id:string) {
  let url:URL;try{url=new URL(value);}catch{return false;}
  if(url.protocol!=='https:'||url.hostname!==host||url.port||url.username||url.password||url.hash||url.pathname!==`/${board}/jobs/${id}`)return false;
  return !url.search||url.search===`?gh_jid=${id}`;
}
type Work={node:HTML.Node;depth:number;hidden:boolean;head:boolean;body:boolean;title:boolean;heading:boolean};
export function greenhousePageIdentity(html:string,host:string,board:string,id:string,title:string):boolean {
  if(Buffer.byteLength(html)>MAX_HTML_BYTES)return false;
  let ambiguous=false;
  const doc=parse(html,{sourceCodeLocationInfo:true,onParseError:error=>{if(error.code==='duplicate-attribute')ambiguous=true;}});
  if(ambiguous)return false;
  let titleText='',headingText='',titles=0,headings=0,meta=0,form=0,heads=0,bodies=0,nodes=0;
  const work:Work[]=[{node:doc,depth:0,hidden:false,head:false,body:false,title:false,heading:false}];
  while(work.length){
    const frame=work.pop()!;if(++nodes>MAX_NODES||frame.depth>MAX_DEPTH)return false;
    const node=frame.node;
    if(node.nodeName==='#text'){
      const text=(node as HTML.TextNode).value;
      if(frame.heading&&frame.hidden)return false;
      if(frame.title){titleText+=text;if(titleText.length>MAX_CAPTURE)return false;}
      if(frame.heading){headingText+=text;if(headingText.length>MAX_CAPTURE)return false;}
      continue;
    }
    if(!('tagName' in node)){
      if('childNodes' in node)for(let i=node.childNodes.length-1;i>=0;i--)work.push({...frame,node:node.childNodes[i],depth:frame.depth+1});
      continue;
    }
    const element=node as HTML.Element,name=element.tagName.toLowerCase();
    if(INERT.has(name))continue;
    const attrs:Record<string,string>=Object.create(null);for(const a of element.attrs)attrs[a.name.toLowerCase()]=a.value;
    const isHidden=frame.hidden||hidden(attrs),inHead=frame.head||name==='head',inBody=frame.body||name==='body';
    let inTitle=frame.title,inHeading=frame.heading;
    if(name==='head'){if(++heads!==1||!element.sourceCodeLocation)return false;}
    if(name==='body'){if(++bodies!==1||!element.sourceCodeLocation)return false;}
    if(name==='title'){
      if(!frame.head||++titles!==1||!element.sourceCodeLocation)return false;inTitle=true;
    }else if(name==='h1'&&(attrs.class??'').split(/\s+/).includes('section-header')){
      if(!frame.body||++headings!==1||isHidden||!element.sourceCodeLocation)return false;inHeading=true;
    }else if(name==='meta'&&(attrs.property??'').toLowerCase()==='og:url'){
      if(!frame.head||++meta!==1||!element.sourceCodeLocation||!matchingUrl(attrs.content??'',host,board,id))return false;
    }else if(name==='form'&&attrs.id==='application-form'){
      if(!frame.body||++form!==1||isHidden||!element.sourceCodeLocation)return false;
    }
    if(inHeading&&isHidden)return false;
    for(let i=element.childNodes.length-1;i>=0;i--)work.push({node:element.childNodes[i],depth:frame.depth+1,hidden:isHidden,head:inHead,body:inBody,title:inTitle,heading:inHeading});
  }
  const expected=normalized(title),prefix=`Job Application for ${expected} at `,actualTitle=normalized(titleText);
  return heads===1&&bodies===1&&titles===1&&headings===1&&meta===1&&form===1&&normalized(headingText)===expected&&actualTitle.startsWith(prefix)&&actualTitle.length>prefix.length;
}
