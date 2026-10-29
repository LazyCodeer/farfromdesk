/** Calendar operations use the schedule's recorded IANA zone, not the host zone. */
export type Recurrence='once'|'daily'|'weekdays';
type Parts={year:number;month:number;day:number;hour:number;minute:number};
function formatter(zone:string) {
  return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
}
export function validZone(zone:string) {try{formatter(zone).format(0);return true;}catch{return false;}}
function parts(ms:number,zone:string,fmt=formatter(zone)):Parts {
  const values=Object.fromEntries(fmt.formatToParts(ms).map(p=>[p.type,p.value]));
  return {year:Number(values.year),month:Number(values.month),day:Number(values.day),hour:Number(values.hour),minute:Number(values.minute)};
}
function dateParts(date:string):{year:number;month:number;day:number} {
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(date);if(!m)throw new Error('Choose a valid date.');
  const year=+m[1],month=+m[2],day=+m[3],check=new Date(Date.UTC(year,month-1,day));
  if(year<2020||year>2100||check.getUTCFullYear()!==year||check.getUTCMonth()!==month-1||check.getUTCDate()!==day)throw new Error('Choose a valid date.');
  return {year,month,day};
}
export function localDate(ms:number,zone:string) {const p=parts(ms,zone);return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;}
export function addDay(date:string) {const p=dateParts(date),d=new Date(Date.UTC(p.year,p.month-1,p.day+1));return d.toISOString().slice(0,10);}
function isWeekday(date:string){const p=dateParts(date),day=new Date(Date.UTC(p.year,p.month-1,p.day)).getUTCDay();return day!==0&&day!==6;}
/** Return both instants for a repeated DST time; none for a missing time. */
export function localInstants(date:string,time:string,zone:string):number[] {
  if(!validZone(zone))throw new Error('Choose a valid time zone.');
  const d=dateParts(date),m=/^(\d{2}):(\d{2})$/.exec(time);if(!m||+m[1]>23||+m[2]>59)throw new Error('Choose a valid time.');
  const wanted={...d,hour:+m[1],minute:+m[2]},nominal=Date.UTC(d.year,d.month-1,d.day,+m[1],+m[2]);
  // Modern IANA UTC offsets use 15 minute increments, including half- and quarter-hour zones.
  const found:number[]=[],fmt=formatter(zone);
  for(let offset=-14*60;offset<=14*60;offset+=15){const ms=nominal-offset*60000,p=parts(ms,zone,fmt);if(Object.keys(wanted).every(k=>p[k as keyof Parts]===wanted[k as keyof Parts]))found.push(ms);}
  return [...new Set(found)].sort((a,b)=>a-b);
}
/** Find the next due instant; nonexistent recurring wall times skip that date. */
export function nextOccurrence(date:string,time:string,zone:string,repeat:Recurrence,after:number):number|undefined {
  for(let i=0;i<370;i++,date=addDay(date)) {
    if(repeat==='once'&&i>0)return;
    if(repeat==='weekdays'&&!isWeekday(date))continue;
    const times=localInstants(date,time,zone);
    if(times.length>1&&repeat==='once')throw new Error('That local time occurs twice. Please include an unambiguous time.');
    // A recurring wall time fires once on a repeated-clock day, at its first occurrence.
    const first=times[0];if(first!==undefined&&first>after)return first;
  }
  return;
}
