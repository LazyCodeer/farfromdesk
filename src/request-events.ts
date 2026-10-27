// Diagnostics deliberately exclude message content, arbitrary paths and provider errors.
export type RequestOutcome='done'|'blocked'|'reviewed'|'cancelled';
export type ReplyContext={requestId?:string;kind?:'progress'|'final'|'hook'|'system';turnId?:string;outcome?:RequestOutcome;origin?:'agent'|'hook'|'system'};
export type VoiceStage='download'|'decode'|'transcribe'|'route';
export type VoiceStageEvent={stage:VoiceStage;state:'started'|'completed'|'failed';durationMs?:number;code?:string;audioSeconds?:number;engine?:string;model?:string};
export function errorCode(error:unknown) {
  const text=error instanceof Error?error.message:String(error??'');
  if(/Missing environment variable|not configured|Configure existing/.test(text))return 'configuration_missing';
  if(/unauthorized|authentication|not logged in|expired.*(?:token|login)|invalid.*api.?key/i.test(text))return 'authentication_required';
  if(/timed? ?out|timeout/i.test(text))return 'timeout';
  if(/abort|cancelled|canceled/i.test(text))return 'cancelled';
  if(/No clear speech|silence|empty audio/i.test(text))return 'no_speech';
  if(/integrity|checksum|tamper/i.test(text))return 'integrity_failed';
  if(/unsupported|format/i.test(text))return 'unsupported_format';
  if(/permission|read.only|not approved/i.test(text))return 'permission_required';
  if(/session.*(?:paused|missing)|selected session changed|not been connected/i.test(text))return 'routing_unavailable';
  return 'unknown';
}
const codes=new Set(['configuration_missing','authentication_required','timeout','cancelled','no_speech','integrity_failed','unsupported_format','permission_required','routing_unavailable','unknown']);
export function safeEventDetails(input:Record<string,unknown>={}) {
  const result:Record<string,string|number|boolean>={};
  for(const key of ['durationMs','audioSeconds','inputTokens','outputTokens','costUsd']) {
    const value=input[key];if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1e12)result[key]=value;
  }
  if(typeof input.code==='string')result.code=codes.has(input.code)?input.code:'unknown';
  for(const [key,values] of Object.entries({stage:['download','decode','transcribe','route'],outcome:['done','blocked','reviewed','cancelled'],provider:['codex','claude'],state:['started','completed','failed'],engine:['whisper.cpp','deepgram','assemblyai','meta'],model:['bundled','custom']})) {
    if(typeof input[key]==='string'&&values.includes(input[key] as string))result[key]=input[key] as string;
  }
  return result;
}
