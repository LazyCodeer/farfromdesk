// Deliberately limited public geography vocabulary. Unknown free-form answers,
// including names and medical information, remain in the selected session.
const regions=new Set(['india','bangalore','bengaluru','delhi','mumbai','hyderabad','pune','chennai','kolkata','london','new york','san francisco','singapore','australia','canada','united states','usa','united kingdom','uk','europe','germany','france','japan']);
export function publicLocation(value:string):string|undefined{
 const answer=value.trim().replace(/^(?:in|near)\s+/i,'').replace(/[.!]$/,'').trim();
 return regions.has(answer.toLowerCase())?answer:undefined;
}
