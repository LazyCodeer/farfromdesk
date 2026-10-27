import {spawn} from 'node:child_process';import {createServer} from 'node:http';import {randomBytes} from 'node:crypto';import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {RemotePasswordAccess} from '../dist/remote-desktop/access.js';import {LiveKitRemoteRoom} from '../dist/remote-desktop/livekit.js';
if(process.argv[2]!=='--local-synthetic-test')throw Error('Explicit local synthetic test flag required');
const dir=await mkdtemp(join(tmpdir(),'ffd-livekit-'));const apiKey='test-'+randomBytes(8).toString('hex'),apiSecret=randomBytes(32).toString('hex');
const lkPort=17880;const enduranceMs=process.argv.includes('--endurance')?330000:0;
const config=`port: ${lkPort}
bind_addresses: [127.0.0.1]
rtc:
  tcp_port: 0
  udp_port: 17882
  port_range_start: 0
  port_range_end: 0
  node_ip: 127.0.0.1
  use_external_ip: false
  enable_loopback_candidate: true
  interfaces:
    includes: [lo0]
  ips:
    includes: [127.0.0.1/32]
logging:
  level: error
keys:
  ${apiKey}: ${apiSecret}
`;
await writeFile(join(dir,'server.yaml'),config,{mode:0o600});
const child=spawn(resolve('build/livekit/bin/livekit-server'),['--config',join(dir,'server.yaml')],{stdio:'ignore'});let exited=false;child.once('exit',()=>exited=true);
let started=false;for(let i=0;i<50;i++){if(exited)throw Error('LiveKit startup failed or port unavailable');try{const r=await fetch(`http://127.0.0.1:${lkPort}`);if(r.ok){started=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}if(!started)throw Error('LiveKit not ready');
let record;const access=new RemotePasswordAccess({load:()=>record,save:r=>record=r});const fixturePassword='Only a disposable local test password';await access.setPassword(fixturePassword);access.enable(true);access.setReady(true);
const room=new LiveKitRemoteRoom({url:`ws://127.0.0.1:${lkPort}`,apiKey,apiSecret});
const sdk=await readFile('node_modules/livekit-client/dist/livekit-client.umd.js');let origin='';
const html=`<!doctype html><html><head><meta charset="utf-8"><title>FarFromDesk LiveKit local test</title></head><body><h1>FarFromDesk LiveKit transport test</h1><p>Local synthetic video only. No camera, microphone or desktop is captured.</p><button id="run">Run password and video test</button><pre id="status">Ready</pre><canvas id="source" width="640" height="360"></canvas><video id="remote" autoplay muted playsinline width="640"></video><script src="/sdk.js"></script><script src="/test.js"></script></body></html>`;
const js=`const status=document.getElementById('status');const output=x=>status.textContent=x;const post=async(path,data)=>{const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const d=await r.json();if(!r.ok)throw Error(d.error);return d;};
document.getElementById('run').onclick=async()=>{document.getElementById('run').disabled=true;let host,viewer,stream,timer;try{
output('Testing password protection...');let refused=false;try{await post('/join',{password:'wrong'});}catch{refused=true;}if(!refused)throw Error('Wrong password accepted');
const creds=await post('/join',{password:'Only a disposable local test password'});
host=new LivekitClient.Room();viewer=new LivekitClient.Room();let subscribed=false,disconnected=false;
viewer.on(LivekitClient.RoomEvent.TrackSubscribed,(track)=>{if(track.kind==='video'){track.attach(document.getElementById('remote'));subscribed=true;}});viewer.on(LivekitClient.RoomEvent.Disconnected,()=>disconnected=true);
await host.connect(creds.url,creds.host,{rtcConfig:{iceServers:[]}});await viewer.connect(creds.url,creds.viewer,{rtcConfig:{iceServers:[]}});
const c=document.getElementById('source'),ctx=c.getContext('2d');let frame=0;timer=setInterval(()=>{ctx.fillStyle=frame%2?'#204050':'#402050';ctx.fillRect(0,0,640,360);ctx.fillStyle='white';ctx.font='28px sans-serif';ctx.fillText('FarFromDesk frame '+(++frame),40,160);},100);stream=c.captureStream(10);
await host.localParticipant.publishTrack(stream.getVideoTracks()[0],{source:LivekitClient.Track.Source.ScreenShare});
output('Connected. Checking received video frames...');let decoded=0;for(let i=0;i<120;i++){await new Promise(r=>setTimeout(r,100));const v=document.getElementById('remote');decoded=v.getVideoPlaybackQuality?.().totalVideoFrames||0;if(subscribed&&decoded>=20)break;}
if(!subscribed||decoded<20)throw Error('Video did not decode: '+decoded);
const enduranceStart=Date.now();while(Date.now()-enduranceStart<${enduranceMs}){if(host.state!=='connected'||viewer.state!=='connected')throw Error('Connection ended during endurance test');output('Live video remains connected: '+Math.floor((Date.now()-enduranceStart)/1000)+' seconds. Testing beyond the old five-minute limit.');await new Promise(r=>setTimeout(r,1000));}
const durationSeconds=Math.floor((Date.now()-enduranceStart)/1000);
await post('/stop',{});for(let i=0;i<30&&!disconnected;i++)await new Promise(r=>setTimeout(r,100));if(!disconnected)throw Error('Stop did not disconnect receiver');
const result={success:true,durationSeconds,wrongPasswordRejected:true,subscribed,decodedFrames:decoded,stopDisconnected:disconnected,source:'synthetic canvas; not desktop'};await post('/result',result);output(JSON.stringify(result,null,2));
}catch(e){output('FAILED: '+e.message);await post('/result',{success:false,error:e.message}).catch(()=>{});}finally{clearInterval(timer);stream?.getTracks().forEach(t=>t.stop());await host?.disconnect();await viewer?.disconnect();}};`;
const server=createServer(async(req,res)=>{res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; connect-src 'self' ws://127.0.0.1:${lkPort}; media-src 'self' blob:; style-src 'self'; frame-ancestors 'none'`);const send=(n,d)=>{res.writeHead(n,{'Content-Type':'application/json'});res.end(JSON.stringify(d));};
try{if(req.headers.host!==new URL(origin).host||req.headers.origin&&req.headers.origin!==origin)return send(403,{error:'ORIGIN_REFUSED'});
if(req.method==='GET'){const content=req.url==='/sdk.js'?sdk:req.url==='/test.js'?js:html;res.setHeader('Content-Type',req.url?.endsWith('.js')?'text/javascript':'text/html');res.end(content);return;}
if(req.method!=='POST'||req.headers.origin!==origin)return send(403,{error:'ORIGIN_REQUIRED'});let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)throw Error('BODY_TOO_LARGE');}const d=JSON.parse(body||'{}');
if(req.url==='/join'){await access.authenticate(d.password);const h=await room.token('host'),v=await room.token('viewer');send(200,{url:h.url,host:h.token,viewer:v.token});}
else if(req.url==='/stop'){access.stop();await room.stop();send(200,{stopped:true});}
else if(req.url==='/result'){const result={success:d.success===true,wrongPasswordRejected:d.wrongPasswordRejected===true,subscribed:d.subscribed===true,decodedFrames:Number(d.decodedFrames)||0,durationSeconds:Number(d.durationSeconds)||0,stopDisconnected:d.stopDisconnected===true,source:'synthetic canvas',error:typeof d.error==='string'?d.error.slice(0,200):undefined};await mkdir('docs/evidence/livekit',{recursive:true});await writeFile('docs/evidence/livekit/transport.json',JSON.stringify(result,null,2));send(200,{saved:true});}
else send(404,{error:'NOT_FOUND'});
}catch(e){send(409,{error:/^[A-Z_]+$/.test(e.message)?e.message:'TEST_FAILED'});}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;console.log(origin);
const stop=()=>{access.stop();server.close();child.kill('SIGTERM');void rm(dir,{recursive:true,force:true});};process.once('SIGTERM',stop);process.once('SIGINT',stop);setTimeout(stop,15*60_000).unref();
