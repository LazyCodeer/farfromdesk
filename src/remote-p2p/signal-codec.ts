/** Signal <-> code and Signal <-> SDP. Runs in Node and the phone browser: no Node imports. */
import type {Signal} from './protocol.js';

const KEYS=new Set(['v','s','r','u','p','f','c','e']);
const SESSION=/^[A-Za-z0-9_-]{16,64}$/,ICE=/^[A-Za-z0-9+/]+$/,FINGERPRINT=/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
// Only "<foundation> <component> udp <priority> <address> <port> typ <type>": nothing else reaches the SDP.
const CANDIDATE=/^[A-Za-z0-9+/]{1,32} [12] udp \d{1,10} [A-Za-z0-9.:-]{1,253} \d{1,5} typ (host|srflx|prflx|relay)$/;
const fail=():never=>{throw Error('INVALID_SIGNAL');};

export function encodeSignal(s:Signal):string{
 const bytes=new TextEncoder().encode(JSON.stringify(s));let bin='';for(const b of bytes)bin+=String.fromCharCode(b);
 return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export function decodeSignal(code:string):Signal{
 if(typeof code!=='string'||code.length>4000||!/^[A-Za-z0-9_-]+$/.test(code))fail();
 let s:any;
 try{const bin=atob(code.replace(/-/g,'+').replace(/_/g,'/'));s=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(bin,c=>c.charCodeAt(0))));}catch{fail();}
 if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).some(k=>!KEYS.has(k)))fail();
 const str=(v:unknown,re:RegExp,min:number,max:number)=>typeof v==='string'&&v.length>=min&&v.length<=max&&re.test(v);
 if(s.v!==1||!str(s.s,SESSION,16,64)||!['offer','answer'].includes(s.r)||!str(s.u,ICE,4,256)||!str(s.p,ICE,22,256)||!str(s.f,FINGERPRINT,95,95))fail();
 if(!Array.isArray(s.c)||!s.c.length||s.c.length>20||s.c.some((c:unknown)=>!str(c,CANDIDATE,1,320)))fail();
 if(s.r==='offer'?!Number.isSafeInteger(s.e)||s.e<=0:s.e!==undefined)fail();
 return s as Signal;
}

/** Candidates are trimmed to their required fields (drops generation/ufrag/network-cost) and the opaque
 * foundation becomes the candidate's index, which keeps codes short and changes nothing for ICE. */
export function sdpToSignal(sdp:string,role:'offer'|'answer',session:string,expiresAt?:number):Signal{
 const lines=sdp.split(/\r?\n/),get=(re:RegExp)=>lines.map(l=>re.exec(l)?.[1]).find(Boolean)??fail();
 const c=lines.flatMap(l=>{const m=/^a=candidate:\S+ (\d+) udp (\d+ \S+ \d+ typ \S+)/i.exec(l);return m?[`${m[1]} udp ${m[2]}`]:[];}).map((c,i)=>`${i+1} ${c}`);
 const s:Signal={v:1,s:session,r:role,u:get(/^a=ice-ufrag:(\S+)/),p:get(/^a=ice-pwd:(\S+)/),f:get(/^a=fingerprint:sha-256 (\S+)/i).toUpperCase(),c};
 if(role==='offer')s.e=expiresAt;
 return decodeSignal(encodeSignal(s)); // Same validation as the other side applies.
}
export function signalToSdp(s:Signal):string{
 return [
  'v=0','o=- 1 0 IN IP4 0.0.0.0','s=-','t=0 0','a=group:BUNDLE 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel','c=IN IP4 0.0.0.0',
  `a=ice-ufrag:${s.u}`,`a=ice-pwd:${s.p}`,`a=fingerprint:sha-256 ${s.f}`,`a=setup:${s.r==='offer'?'actpass':'active'}`,
  'a=mid:0','a=sctp-port:5000','a=max-message-size:262144',
  ...s.c.map(c=>`a=candidate:${c}`),'a=end-of-candidates',''
 ].join('\r\n');
}
