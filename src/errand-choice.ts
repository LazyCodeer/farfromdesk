/** A short reference identifies the exact shortlist; collisions fail closed. */
export function shortlistReference(missionId:string){return missionId.replace(/-/g,'').slice(0,8).toLowerCase();}

export function parseErrandChoice(text:string):{number:number;reference?:string}|undefined {
  const match=/^\s*(?:please\s+)?draft\s+([1-5])(?:\s+([0-9a-f]{8}))?\s*[.!?]*\s*$/i.exec(text);
  return match?{number:Number(match[1]),...(match[2]?{reference:match[2].toLowerCase()}:{})}:undefined;
}
