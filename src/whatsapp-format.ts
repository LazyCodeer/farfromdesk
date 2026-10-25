// Conservative Markdown-to-WhatsApp conversion. Code spans/fences are opaque.
export function toWhatsApp(text:string) {
  const protectedParts:string[]=[];
  // A per-message sentinel cannot collide with literal user text.
  let prefix='\uE000FFD';while(text.includes(prefix))prefix+='X';
  const hold=(value:string)=>`${prefix}${protectedParts.push(value)-1}\uE001`;
  let value=text.replace(/```[^\n`]*\n[\s\S]*?```|`[^`\n]+`/g,block=>hold(block.startsWith('```')?block.replace(/^```[^\n]*\n/,'```\n'):block));
  value=value.replace(/!?\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,(_,label,url)=>label===url?hold(url):`${label} — ${hold(url)}`);
  value=value.replace(/https?:\/\/[^\s<>]+/g,url=>hold(url));
  value=value.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*$/gm,(_,title)=>`*${title.replace(/^\*\*|\*\*$/g,'')}*`)
    .replace(/\*\*([^*\n]+)\*\*/g,'*$1*').replace(/__([^_\n]+)__/g,'*$1*').replace(/~~([^~\n]+)~~/g,'~$1~')

    .replace(/^[ \t]*[•]\s+/gm,'- ');
  const lines=value.split('\n'),out:string[]=[];
  const cells=(line:string)=>line.trim().replace(/^\||\|$/g,'').split(/(?<!\\)\|/).map(x=>x.trim().replace(/\\\|/g,'|'));
  for(let i=0;i<lines.length;i++) {
    if(lines[i].includes('|')&&i+1<lines.length&&/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i+1])) {
      const headings=cells(lines[i]);i+=2;
      for(;i<lines.length&&lines[i].includes('|');i++) {
        const row=cells(lines[i]);out.push('- '+row.map((cell,n)=>`${headings[n]??`Column ${n+1}`}: ${cell}`).join(' · '));
      }
      i--;continue;
    }
    out.push(lines[i]);
  }
  let result=out.join('\n');
  protectedParts.forEach((part,index)=>{result=result.split(`${prefix}${index}\uE001`).join(part);});
  return result;
}
