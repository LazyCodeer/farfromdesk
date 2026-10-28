import {decodeSignal,encodeSignal,sdpToSignal,signalToSdp} from './signal-codec.js';
import {SIGNAL_PREFIX,STUN_URLS,CONTROL_CHANNEL,FRAME_CHANNEL,FrameAssembler} from './protocol.js';

const $=id=>document.getElementById(id);
const NEW_LINK="Send 'control my screen' to FarFromDesk for a new link.";
const EXPIRED='This link has expired. '+NEW_LINK,EXPIRED_SUB="Links work for a few minutes. Send 'control my screen' to FarFromDesk for a new one.";
const ERRORS={
  INCORRECT_PASSWORD:'That password is not right. Try again.',
  WAIT_BEFORE_RETRY:'Too many tries. Wait a minute, then try again.',
  MAC_UNAVAILABLE:'Your Mac is not ready for remote control. Open FarFromDesk on it and try again.',
  STALE_FRAME:'The screen changed before your tap arrived. Nothing was done.',
  ACTION_REFUSED:"Your Mac didn't do that. Nothing changed, try again.",
  NO_REPLY:'Your Mac did not reply. Check the screen before trying again.',
};
const explain=code=>ERRORS[code]||`Your Mac said: ${code}`;
const ENDS={
  STOPPED_BY_PHONE:'You ended the session. Anything already sent may have happened, so check your Mac when you are back.',
  STOPPED:'Your Mac ended the session. '+NEW_LINK,
  NEW_LINK:'A newer link replaced this one. Open the newest link.',
  REPLACED:'A newer link replaced this one. Open the newest link.',
  OFFER_REPLACED:'A newer link replaced this one. Open the newest link.',
  OFFER_EXPIRED:EXPIRED,
  ACCESS_ENDED:'Remote access was turned off on your Mac.',
  TOO_MANY_ATTEMPTS:'Too many wrong passwords. '+NEW_LINK,
  DESKTOP_UNAVAILABLE:'FarFromDesk lost Accessibility or Screen Recording permission on your Mac. '+NEW_LINK,
  LOGIN_TIMEOUT:'The password was not entered within 2 minutes. '+NEW_LINK,
  IDLE_TIMEOUT:'Closed because this phone was left unused, so nobody else can use your Mac from it. '+NEW_LINK,
  ACTION_FAILED:"An action may not have finished, so the session stopped to be safe. Check your Mac, then send 'control my screen' for a new link.",
};

// ---- Reconnect: the Mac hands out a one-time secret after the password. Kept on this phone only.
const KEEP='ffd-remote-resume',USED='ffd-remote-used',PAUSED='ffd-remote-paused',KEEP_MS=10*60_000;
const store={
  get(k){try{return JSON.parse(localStorage.getItem(k)??'null');}catch{return null;}},
  set(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch{}},
  drop(k){try{localStorage.removeItem(k);}catch{}},
};
// Set while a session is paused, so a reload or a reopened tab says so instead of starting over. Holds no secret.
const wasPaused=()=>{const r=store.get(PAUSED);return !!r&&Date.now()-r.at<KEEP_MS;};
const kept=()=>{const r=store.get(KEEP);return r&&typeof r.secret==='string'&&Date.now()-r.alive<KEEP_MS?r.secret:null;};

// ---- Setup screen: one layout, filled in per state. Scene = badge, link style, tone of the illustration.
const SCENES={
  code:['code','dashed',''],lock:['lock','solid',''],wrong:['lock','solid','bad'],resume:['key','dashed','good'],back:['check','solid','good'],
  dropped:['code','broken','warn'],ended:['check','dashed','quiet'],expired:['clock','broken','bad'],used:['x','broken','bad'],failed:['x','broken','bad'],
};
function paint({scene,kicker='',title,sub='',done=0,show=null,acts=null,center=false}){
  const [badge,link,tone]=SCENES[scene];
  $('badge').setAttribute('href','#b-'+badge);$('art').dataset.link=link;
  const c=$('content');c.dataset.tone=tone;c.classList.toggle('center',center);
  $('progress').hidden=!done;$('progress').dataset.done=done;
  $('kicker').textContent=kicker;$('kicker').hidden=!kicker;
  $('title').textContent=title;$('sub').textContent=sub;$('sub').hidden=!sub;
  for(const s of ['answer','login','nextsteps'])$(s).hidden=s!==show;
  for(const a of ['sendacts','connect','openacts'])$(a).hidden=a!==acts;
  $('status').hidden=true;
}
function say(text,tone='wait'){$('statustext').textContent=text;$('status').dataset.tone=tone;$('status').hidden=false;}
// Screens with nothing left to do here: the next step happens in the chat.
function finish(kind,message){
  stopVoice(true);
  const open={acts:'openacts',center:true};
  if(kind==='ended')paint({scene:'ended',title:'Session ended',sub:message,center:true});
  else if(kind==='dropped')paint({scene:'dropped',kicker:'Connection dropped',title:'Your Mac is sending a new link',
    sub:paused?'Open the new link in your chat and enter your remote password to carry on.':'Nothing is lost. Open the new link in your chat and you will be back in, no password needed.',show:'nextsteps',...open});
  else if(kind==='expired')paint({scene:'expired',kicker:'Link expired',title:'This link has timed out',sub:message,...open});
  else if(kind==='used')paint({scene:'used',kicker:'Link already used',title:'Open the newest link',sub:message,...open});
  else paint({scene:'failed',kicker:'Disconnected',title:'The session stopped',sub:message,...open});
}
paint({scene:'code',done:1,title:'Control your Mac'});say('Getting ready…');

// epoch: bumped on every pause, so a decode, tap or ack from before it can't land after it.
let pc=null,control=null,ended=false,authed=false,live=false,paused=false,epoch=0,offerId=null,aliveTimer=null,wake=null;
const send=m=>{if(!ended&&control?.readyState==='open')control.send(JSON.stringify(m));};

function end(message,kind='failed'){
  if(ended)return;ended=true;live=false;
  for(const w of waiting.values())w({ok:false,error:'ENDED'});waiting.clear();
  clearInterval(aliveTimer);clearInterval(idleTimer);$('idle').hidden=true;$('paused').hidden=true;wake?.release().catch(()=>{});wake=null;
  try{pc?.close();}catch{}
  $('session').hidden=true;$('setup').hidden=false;$('cancel').hidden=true;
  finish(kind,message);
}

function readOffer(){
  let raw=location.hash.slice(1);
  try{raw=decodeURIComponent(raw);}catch{}
  if(!raw)return null;
  try{const s=decodeSignal(raw.trim());return s.r==='offer'&&typeof s.e==='number'&&s.e>Date.now()?s:null;}catch{return null;}
}

async function start(){
  const offer=readOffer();
  if((!offer||store.get(USED)===offer.s)&&wasPaused())return paint({scene:'dropped',kicker:'Session paused',title:'Open the newest link',center:true,
    sub:'Your Mac sent a new link in your chat. Open it and enter your remote password to pick up where you left off.',acts:'openacts'});
  if(!offer)return finish('expired',EXPIRED_SUB);
  if(store.get(USED)===offer.s)return finish('used',kept()?'Each link works once. If you got disconnected, FarFromDesk has already sent you a newer one.':'Each link works once. '+NEW_LINK);
  if(!window.RTCPeerConnection)return finish('failed','This browser cannot connect. Open the link in Safari or Chrome.');
  offerId=offer.s;
  pc=new RTCPeerConnection({iceServers:[{urls:STUN_URLS}]});
  control=pc.createDataChannel(CONTROL_CHANNEL.label,{negotiated:true,id:CONTROL_CHANNEL.id});
  const frames=pc.createDataChannel(FRAME_CHANNEL.label,{negotiated:true,id:FRAME_CHANNEL.id});
  frames.binaryType='arraybuffer';
  control.onopen=onOpen;control.onclose=()=>dropped();control.onmessage=e=>onMessage(e.data);
  frames.onmessage=e=>onChunk(e.data);
  pc.onconnectionstatechange=()=>{
    const st=pc.connectionState;
    if(st==='failed'||st==='closed')dropped();
    else if(st==='disconnected'&&live){liveStatus('Reconnecting','warn');$('banner').hidden=false;}
    else if(st==='connected'&&live){liveStatus('Live','good');$('banner').hidden=true;}
  };
  // Chrome skips public (STUN) candidates when the offer already lists the Mac's, which breaks
  // connections across networks. So apply the offer without them, gather fully, then add them.
  const bare=signalToSdp(offer).split('\r\n').filter(l=>!l.startsWith('a=candidate:')&&l!=='a=end-of-candidates').join('\r\n');
  await pc.setRemoteDescription({type:'offer',sdp:bare});
  await pc.setLocalDescription(await pc.createAnswer());
  await new Promise(done=>{
    if(pc.iceGatheringState==='complete')return done();
    const t=setTimeout(done,5000);
    pc.addEventListener('icegatheringstatechange',()=>{if(pc.iceGatheringState==='complete'){clearTimeout(t);done();}});
  });
  for(const c of offer.c)await pc.addIceCandidate({candidate:'candidate:'+c,sdpMid:'0',sdpMLineIndex:0}).catch(()=>{});
  const code=SIGNAL_PREFIX+encodeSignal(sdpToSignal(pc.localDescription.sdp,'answer',offer.s));
  $('code').value=code;
  const text=encodeURIComponent(code);
  $('whatsapp').href=`https://wa.me/?text=${text}`;
  $('telegram').href=`https://t.me/share/url?url=%20&text=${text}`;
  if(navigator.share){$('share').hidden=false;$('share').onclick=()=>navigator.share({text:code}).catch(()=>{});}
  $('copy').onclick=$('copyicon').onclick=async()=>{
    try{await navigator.clipboard.writeText(code);}catch{$('code').select();document.execCommand('copy');}
    $('copy').textContent='Copied';setTimeout(()=>{$('copy').textContent='Copy code';},2000);
  };
  if(kept())paint({scene:'resume',kicker:'Welcome back',title:'Send this code to carry on',
    sub:'You signed in a few minutes ago, so no password is needed this time.',show:'answer',acts:'sendacts'});
  else paint({scene:'code',kicker:'Step 2 of 3',done:2,title:'Send this code to your Mac',
    sub:'Your Mac is waiting in your chat. Send the code back there and it connects.',show:'answer',acts:'sendacts'});
  $('cancel').hidden=false;say('Waiting for your Mac…');
  setTimeout(()=>{if(!ended&&control.readyState!=='open')say('Still waiting. Send the whole code in the same chat, and check your Mac is awake and online.');},60_000);
}

function dropped(){
  if(ended)return;
  end('The connection to your Mac ended. '+NEW_LINK,authed&&(paused||kept())?'dropped':'failed');
}

function onOpen(){
  store.set(USED,offerId);
  const secret=kept();
  if(secret){
    send({t:'resume',secret});
    paint({scene:'back',kicker:'Reconnecting',title:'Getting your screen back',sub:'Your Mac recognised this phone. The screen appears in a moment.',center:true});
    say('Reconnecting…','good');return;
  }
  askPassword();say('Connected to your Mac.','good');
}
function askPassword(scene='lock'){
  const back=wasPaused();
  paint({scene,kicker:back?'Session paused':'Step 3 of 3',done:3,title:back?'Enter your password to resume':'Enter your remote password',
    sub:'The one you set in FarFromDesk on your Mac, not your Mac login.',show:'login',acts:'connect'});
  $('login').toggleAttribute('data-bad',scene==='wrong');$('password').focus();
}
$('password').oninput=()=>$('login').removeAttribute('data-bad');
$('reveal').onclick=()=>{
  const shown=$('password').type==='text';$('password').type=shown?'password':'text';
  $('reveal').firstElementChild.firstElementChild.setAttribute('href',shown?'#i-eye-off':'#i-eye');
  $('reveal').setAttribute('aria-label',shown?'Show password':'Hide password');
};
$('login').onsubmit=e=>{
  e.preventDefault();const password=$('password').value;$('password').value='';
  if(!password||authed)return;
  send({t:'auth',password});say('Checking…');
};
$('cancel').onclick=()=>{send({t:'stop'});setTimeout(()=>end('You cancelled. '+NEW_LINK,'ended'),200);};

function onMessage(data){
  let m;try{m=JSON.parse(data);}catch{return;}
  if(m.t==='auth-ok'){
    authed=true;paused=false;store.drop(PAUSED);$('paused').hidden=true;$('session').classList.remove('paused');canList=m.desktops===true;setVoice(m.voice);idleMs=typeof m.idle==='number'?m.idle:0;showLocked(m.locked===true);
    if(typeof m.resume==='string')store.set(KEEP,{secret:m.resume,alive:Date.now()});
    goLive();
  }
  else if(m.t==='auth-fail'){
    if(paused){$('pausemsg').textContent=explain(m.error);$('pausemsg').hidden=false;$('resumepw').focus();return;}
    askPassword('wrong');say(explain(m.error),'bad');
  }
  else if(m.t==='resume-fail'){store.drop(KEEP);askPassword();say('Enter your remote password to continue.','wait');}
  else if(m.t==='desktops')showDesktops(m);
  else if(m.t==='locked')showLocked(m.locked);
  else if(m.t==='voice-text'||m.t==='voice-fail')heard(m);
  else if(m.t==='ack'){const w=waiting.get(m.id);if(w){waiting.delete(m.id);w(m);}}
  else if(m.t==='ended'){
    if(m.reason!=='CONNECTION_LOST'){store.drop(KEEP);store.drop(PAUSED);}
    const r=m.reason;
    end(r==='OFFER_EXPIRED'?EXPIRED_SUB:ENDS[r]??'Your Mac ended the session. '+NEW_LINK,
      r==='STOPPED_BY_PHONE'||r==='IDLE_TIMEOUT'?'ended':r==='OFFER_EXPIRED'?'expired':/REPLACED|NEW_LINK/.test(r)?'used':'failed');
  }
}

// ---- Live view.
function liveStatus(text,tone){$('livetext').textContent=text;$('livetext').parentElement.dataset.tone=tone;}
async function keepAwake(){try{wake=await navigator.wakeLock?.request('screen');}catch{}}
function goLive(){
  live=true;$('setup').hidden=true;$('session').hidden=false;
  liveStatus(shown===null?'Loading screen…':'Live',shown===null?'warn':'good');requestAnimationFrame(layout);
  keepAwake();
  lastTouch=Date.now();clearInterval(idleTimer);idleTimer=setInterval(idleTick,1000);
  // Lets this phone come back after a dropped connection.
  clearInterval(aliveTimer);aliveTimer=setInterval(()=>{const r=store.get(KEEP);if(r)store.set(KEEP,{...r,alive:Date.now()});},20_000);
}
document.addEventListener('visibilitychange',()=>{
  if(!live)return;
  if(document.hidden)return pause();
  if(!wake)keepAwake();
  idleTick(); // background timers are throttled, so catch up the moment the page is back
  if(parked!==null){const id=parked;parked=null;send({t:'ready',frameId:id});}
});
// Screen off or page in the background: the Mac logs this phone out but keeps the connection.
// Coming back needs the password, so whoever picks up this phone can't carry on from it.
function pause(){
  if(paused||!authed)return;paused=true;epoch++;shown=null;
  for(const w of waiting.values())w({ok:false,error:'ENDED'});waiting.clear();
  store.drop(KEEP);store.set(PAUSED,{at:Date.now()});send({t:'pause'});
  // Wipe the picture, not just cover it: nothing of the Mac's screen stays on this phone while it is logged out.
  canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);previews.clear();$('session').classList.add('paused');
  stopVoice(true);clearInterval(idleTimer);$('idle').hidden=true;wake?.release().catch(()=>{});wake=null;parked=null;
  $('pausemsg').hidden=true;$('paused').hidden=false;liveStatus('Paused','warn');
}
$('resumeform').onsubmit=e=>{
  e.preventDefault();const password=$('resumepw').value;$('resumepw').value='';if(!password)return;
  // 'pause' first: if it never reached the Mac (sent as the screen went off), the Mac logs out before checking the password.
  send({t:'pause'});send({t:'auth',password});$('pausemsg').textContent='Checking…';$('pausemsg').hidden=false;
};
$('pauseend').onclick=()=>{store.drop(PAUSED);send({t:'stop'});setTimeout(()=>end(ENDS.STOPPED_BY_PHONE,'ended'),200);};
addEventListener('beforeunload',e=>{if(live){e.preventDefault();e.returnValue='';}});
// A reload or a closed tab pauses too: the Mac sends a new link and the password brings the session back.
// Ending is only ever the End button, or the 10 minute pause limit.
addEventListener('pagehide',()=>pause());

let toastTimer=null;
function toast(text){const t=$('toast');t.textContent=text;t.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{t.hidden=true;},3500);}

// Frames are drawn on a canvas (the CSP blocks blob: images). Pull based: ask for the next one once this is on screen.
const assembler=new FrameAssembler(),canvas=$('screen'),viewport=$('viewport'),stage=$('stage');
let shown=null,parked=null;
// Pull the next frame only while this page is visible, so a locked phone doesn't keep the Mac capturing.
const pull=id=>{if(document.hidden)parked=id;else send({t:'ready',frameId:id});};
async function onChunk(data){
  const f=assembler.push(data);if(!f||ended||paused)return;
  const e=epoch;let bmp;
  try{bmp=await createImageBitmap(new Blob([f.jpeg],{type:'image/jpeg'}));}catch{if(e===epoch)pull(f.frameId);return;}
  if(ended||paused||e!==epoch){bmp.close();return;}
  if(canvas.width!==bmp.width||canvas.height!==bmp.height){canvas.width=bmp.width;canvas.height=bmp.height;layout();}
  canvas.getContext('2d').drawImage(bmp,0,0);bmp.close();
  if(shown===null)liveStatus('Live','good');
  shown=f.frameId;
  pull(f.frameId);
}

// ---- Zoom and pan. The stage is the screen at "fit" size; view = scale + offset on top of that.
const view={z:1,x:0,y:0},MAX_ZOOM=5;
let fitW=0,fitH=0;
function layout(){
  const vw=viewport.clientWidth,vh=viewport.clientHeight,ratio=canvas.width/canvas.height||1.6;
  fitW=Math.min(vw,vh*ratio);fitH=fitW/ratio;
  stage.style.width=fitW+'px';stage.style.height=fitH+'px';
  apply();
}
function clampView(){
  const vw=viewport.clientWidth,vh=viewport.clientHeight,w=fitW*view.z,h=fitH*view.z;
  view.x=w<=vw?(vw-w)/2:Math.min(0,Math.max(vw-w,view.x));
  view.y=h<=vh?(vh-h)/2:Math.min(0,Math.max(vh-h,view.y));
}
function apply(){
  clampView();
  stage.style.transform=`translate(${view.x}px,${view.y}px) scale(${view.z})`;
  $('zoom').textContent=Math.round(view.z*100)+'%';
}
function zoomAt(z,cx,cy){
  const nz=Math.min(MAX_ZOOM,Math.max(1,z)),px=(cx-view.x)/view.z,py=(cy-view.y)/view.z;
  view.z=nz;view.x=cx-px*nz;view.y=cy-py*nz;apply();
}
const fit=()=>{view.z=1;apply();};
addEventListener('resize',layout);
$('fit').onclick=fit;
$('zoom').onclick=()=>{const next=view.z<1.5?2:view.z<2.5?3:1;zoomAt(next,viewport.clientWidth/2,viewport.clientHeight/2);};

// ---- Input. One input in flight; the next waits for the ack.
const waiting=new Map();let chain=Promise.resolve(),viewOnly=false;
const POINTER=new Set(['click','double','right','scroll']);
/** Resolves with the Mac's ack, or null when nothing was sent. */
function act(data){
  if(ended||!authed)return Promise.resolve(null);
  if(viewOnly&&POINTER.has(data.kind)){toast('View only is on. Turn it off to click or scroll.');return Promise.resolve(null);}
  if(shown===null){toast('Wait for the screen to appear.');return Promise.resolve(null);}
  const frameId=shown,e=epoch;
  return chain=chain.then(async()=>{
    if(ended||paused||e!==epoch)return null;
    const id=crypto.randomUUID();
    const ack=new Promise(r=>{waiting.set(id,r);setTimeout(()=>{if(waiting.delete(id))r({ok:false,error:'NO_REPLY'});},15_000);});
    send({t:'input',id,frameId,...data});
    const a=await ack;
    if(!ended&&e===epoch&&!a.ok&&a.error!=='ENDED')toast(explain(a.error));
    return a;
  });
}
function ripple(cx,cy,kind){
  const r=document.createElement('span');r.className='ripple'+(kind==='right'?' right':'');
  const box=viewport.getBoundingClientRect();r.style.left=(cx-box.left)+'px';r.style.top=(cy-box.top)+'px';
  $('ripples').append(r);setTimeout(()=>r.remove(),500);
}
// Position on the Mac screen, 0..1. The canvas rect already includes zoom and pan.
const point=(cx,cy)=>{const r=canvas.getBoundingClientRect();return {x:Math.min(.999,Math.max(0,(cx-r.left)/r.width)),y:Math.min(.999,Math.max(0,(cy-r.top)/r.height))};};
const inside=(cx,cy)=>{const r=canvas.getBoundingClientRect();return cx>=r.left&&cx<=r.right&&cy>=r.top&&cy<=r.bottom;};

// One finger: tap clicks, double tap double-clicks, hold right-clicks, swipe scrolls.
// Two fingers: pinch to zoom and drag to pan, nothing is sent to the Mac.
const touches=new Map();let one=null,hold=null,lastTap=0,tapTimer=null,pinch=null,settle=false;
const mid=()=>{const [a,b]=[...touches.values()];return {x:(a.x+b.x)/2,y:(a.y+b.y)/2,d:Math.hypot(a.x-b.x,a.y-b.y)||1};};
viewport.addEventListener('pointerdown',e=>{
  if(shown===null)return;
  e.preventDefault();viewport.setPointerCapture(e.pointerId);
  touches.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(touches.size===1&&!settle){
    if(!inside(e.clientX,e.clientY))return;
    one={cx:e.clientX,cy:e.clientY,moved:false};
    hold=setTimeout(()=>{if(one&&!one.moved){const p=point(one.cx,one.cy);ripple(one.cx,one.cy,'right');act({kind:'right',...p});one=null;}},550);
  }else if(touches.size===2){
    clearTimeout(hold);one=null;settle=true;
    const m=mid(),box=viewport.getBoundingClientRect();
    pinch={d:m.d,x:m.x-box.left,y:m.y-box.top,z:view.z,vx:view.x,vy:view.y};
  }
});
viewport.addEventListener('pointermove',e=>{
  if(!touches.has(e.pointerId))return;
  touches.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(pinch&&touches.size>=2){
    const m=mid(),box=viewport.getBoundingClientRect(),cx=m.x-box.left,cy=m.y-box.top;
    const z=Math.min(MAX_ZOOM,Math.max(1,pinch.z*m.d/pinch.d));
    const px=(pinch.x-pinch.vx)/pinch.z,py=(pinch.y-pinch.vy)/pinch.z;
    view.z=z;view.x=cx-px*z;view.y=cy-py*z;apply();
  }else if(one&&Math.hypot(e.clientX-one.cx,e.clientY-one.cy)>24){one.moved=true;clearTimeout(hold);}
});
function lift(e){
  if(!touches.delete(e.pointerId))return;
  if(touches.size<2)pinch=null;
  if(touches.size===0)settle=false;
  clearTimeout(hold);
  if(!one||e.type==='pointercancel'){one=null;return;}
  const d=one;one=null;const dx=e.clientX-d.cx,dy=e.clientY-d.cy,p=point(d.cx,d.cy);
  if(d.moved){
    const vertical=Math.abs(dy)>=Math.abs(dx),dist=(vertical?dy:dx)/view.z;
    act({kind:'scroll',...p,direction:vertical?(dist<0?'down':'up'):(dist<0?'right':'left'),amount:Math.min(20,Math.max(1,Math.round(Math.abs(dist)/40)))});
    return;
  }
  const now=Date.now();
  if(now-lastTap<350){clearTimeout(tapTimer);lastTap=0;ripple(d.cx,d.cy);act({kind:'double',...p});return;}
  lastTap=now;ripple(d.cx,d.cy);tapTimer=setTimeout(()=>act({kind:'click',...p}),300);
}
viewport.addEventListener('pointerup',lift);
viewport.addEventListener('pointercancel',lift);
viewport.addEventListener('contextmenu',e=>e.preventDefault());
// Trackpad or mouse wheel zoom when the page is opened on a computer.
viewport.addEventListener('wheel',e=>{if(!e.ctrlKey)return;e.preventDefault();const box=viewport.getBoundingClientRect();zoomAt(view.z*Math.exp(-e.deltaY/200),e.clientX-box.left,e.clientY-box.top);},{passive:false});

// ---- Dock: keyboard, shortcuts, view only.
function toggle(button,sheet){
  const open=sheet.hidden;for(const [b,s] of [['kbd','keyboard'],['keysbtn','shortcuts'],['deskbtn','desktops']]){$(s).hidden=true;$(b).setAttribute('aria-pressed','false');}
  sheet.hidden=!open;button.setAttribute('aria-pressed',String(open));
  requestAnimationFrame(layout);
  if(open&&sheet.id==='keyboard')$('text').focus();
}
$('kbd').onclick=()=>toggle($('kbd'),$('keyboard'));
$('keysbtn').onclick=()=>toggle($('keysbtn'),$('shortcuts'));
$('lock').onclick=()=>{viewOnly=!viewOnly;$('lock').setAttribute('aria-pressed',String(viewOnly));toast(viewOnly?'View only. Taps and swipes are not sent.':'Control is back on.');};
$('typeform').onsubmit=e=>{e.preventDefault();const text=$('text').value;if(!text)return;$('text').value='';act({kind:'type',text}).then(a=>{if(a?.ok&&macLocked)act({kind:'key',key:'return'});});};
// ---- Locked Mac. The lock screen stays live; the password goes in through Type like any other text.
let macLocked=false;
const MASKABLE=CSS.supports('-webkit-text-security','disc');
function showLocked(on){
  if(on===macLocked)return;macLocked=on;$('lockbar').hidden=!on;
  // Hidden as typed, and Return is sent after it, so one tap unlocks.
  // The mic goes away while locked: the Mac password is only ever typed, never spoken or sent to a transcriber.
  if(on)stopVoice(true);showMic();
  // Cleared both ways: half-typed text must not become a password, and a password must not stay in the field.
  // Masked with CSS rather than type=password, so the browser never offers to save the Mac password for this site.
  const t=$('text');t.value='';t.classList.toggle('masked',on);if(!MASKABLE)t.type=on?'password':'text';t.placeholder=on?'Your Mac password':'Type into the field you tapped';t.enterKeyHint=on?'go':'send';
  if(!on){if(!$('keyboard').hidden)toggle($('kbd'),$('keyboard'));toast('Your Mac is unlocked');}
}
$('locktype').onclick=()=>{if($('keyboard').hidden)toggle($('kbd'),$('keyboard'));else $('text').focus();};
// ---- Voice typing: the Mac transcribes with the owner's own voice setup, and the text lands here to check before sending.
let voiceMode=null,rec=null,discard=false,voiceId='',voiceTimer;
const VOICE_MAX_MS=120_000,PIECE=6000; // 6000 bytes is 8000 base64 characters, the Mac's limit per piece.
function setVoice(mode){
  voiceMode=(mode==='local'||mode==='cloud')&&navigator.mediaDevices?.getUserMedia&&window.MediaRecorder?mode:null;showMic();
  $('voicefact').hidden=!voiceMode;
  $('voicetext').textContent=voiceMode==='local'?'Sent over this connection and transcribed on your Mac. It never leaves your devices. Off while your Mac is locked.':'Your Mac sends it to your own voice provider with your key, over HTTPS. Off while your Mac is locked, so your Mac password never goes there.';
}
function showMic(){$('mic').hidden=!voiceMode||macLocked;}
function stopVoice(drop){if(!rec)return;discard=drop;clearTimeout(voiceTimer);try{rec.stop();}catch{}}
function micState(listening,busy){$('mic').setAttribute('aria-pressed',String(listening));$('mic').disabled=busy;$('mic').setAttribute('aria-label',listening?'Stop and transcribe':'Speak');
  $('text').placeholder=listening?'Listening… tap the mic to stop':busy?'Transcribing…':macLocked?'Your Mac password':'Type into the field you tapped';}
$('mic').onclick=async()=>{
  if(rec){stopVoice(false);return;}
  if(macLocked)return;
  let stream;try{stream=await navigator.mediaDevices.getUserMedia({audio:true});}catch{toast('Allow the microphone for this page to use voice typing.');return;}
  const type=['audio/webm','audio/mp4'].find(t=>MediaRecorder.isTypeSupported(t));
  const chunks=[];rec=new MediaRecorder(stream,type?{mimeType:type}:undefined);discard=false;
  rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
  rec.onstop=async()=>{
    const r=rec;rec=null;stream.getTracks().forEach(t=>t.stop());
    if(discard||macLocked||!chunks.length){micState(false,false);return;}
    micState(false,true);
    const mime=(r.mimeType||type||'audio/webm').split(';')[0],bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());
    voiceId=crypto.randomUUID();const n=Math.ceil(bytes.length/PIECE);
    for(let seq=0;seq<n;seq++){let bin='';for(const b of bytes.subarray(seq*PIECE,(seq+1)*PIECE))bin+=String.fromCharCode(b);send({t:'voice',id:voiceId,seq,mime,data:btoa(bin),last:seq===n-1});}
  };
  rec.start();micState(true,false);voiceTimer=setTimeout(()=>stopVoice(false),VOICE_MAX_MS);
};
function heard(m){
  if(m.id!==voiceId)return;voiceId='';micState(false,false);
  if(m.t==='voice-fail'){toast(m.error==='MAC_LOCKED'?'Voice is off while your Mac is locked. Type your password instead.':m.error==='VOICE_BUSY'?'Still transcribing your last recording. Try again in a moment.':m.message||'Could not transcribe that. Try again or type it.');return;}
  const t=$('text');t.value=(t.value&&!/\s$/.test(t.value)?t.value+' ':t.value)+m.text.trim();t.focus();
}
// ---- Idle lock. The page keeps the phone screen on, so an unattended phone must not stay in control.
// Any touch, key, scroll or pinch counts. The Mac closes on its own at 75s; 'active' tells it the owner is still here.
const IDLE_WARN=30_000,IDLE_COUNT=15_000;
let idleMs=0,lastTouch=Date.now(),lastActiveSent=0,idleTimer=null;
function touched(e){
  // Presses inside the dialog belong to its buttons; hiding it on finger-down would swallow their click.
  if(!live||paused||e&&$('idle').contains(e.target))return;lastTouch=Date.now();$('idle').hidden=true;
  if(idleMs&&lastTouch-lastActiveSent>5_000){lastActiveSent=lastTouch;send({t:'active'});}
}
for(const ev of ['pointerdown','pointermove','touchstart','touchmove','keydown','input','wheel','scroll','gesturechange'])addEventListener(ev,touched,{capture:true,passive:true});
function idleTick(){
  if(!live||paused)return;const idle=Date.now()-lastTouch;
  if(idle<IDLE_WARN){$('idle').hidden=true;return;}
  const left=Math.ceil((IDLE_WARN+IDLE_COUNT-idle)/1000);
  if(left<=0){send({t:'stop',idle:true});end(ENDS.IDLE_TIMEOUT,'ended');return;}
  $('idlesecs').textContent=left;$('idle').hidden=false; // no focus move: the notice must not pull the keyboard or the screen around
}
$('idlestay').onclick=()=>touched();
$('idleend').onclick=()=>{send({t:'stop'});end(ENDS.STOPPED_BY_PHONE,'ended');};
// ---- How the connection is protected.
const security=$('security');
const openSecurity=()=>{security.hidden=false;security.firstElementChild.scrollTop=0;$('secclose').focus({preventScroll:true});};
$('secure').onclick=$('howsecure').onclick=openSecurity;
$('secclose').onclick=()=>{security.hidden=true;};
security.onclick=e=>{if(e.target===security)security.hidden=true;};
addEventListener('keydown',e=>{if(e.key==='Escape'&&!security.hidden)security.hidden=true;});
// ---- Desktops on the main display. A preview exists only for desktops seen during this session.
const previews=new Map();let desk={count:0,current:0},canList=false;
function snapshot(i){
  if(!i||shown===null)return;
  const c=previews.get(i)??document.createElement('canvas');c.width=320;c.height=Math.round(320*canvas.height/canvas.width)||180;
  c.getContext('2d').drawImage(canvas,0,0,c.width,c.height);previews.set(i,c);
}
function showDesktops(m){
  desk={count:m.count|0,current:m.current|0};snapshot(desk.current);
  const list=$('desklist');list.replaceChildren();
  for(let i=1;i<=Math.min(desk.count,16);i++){
    const b=document.createElement('button');b.type='button';b.className='deskcard';b.setAttribute('aria-current',String(i===desk.current));
    const art=previews.get(i);
    if(art)b.append(art);else{const blank=document.createElement('span');blank.className='blank';blank.textContent='Preview after first visit';b.append(blank);}
    const label=document.createElement('span');label.className='label';label.textContent='Desktop '+i;
    if(i===desk.current){const chip=document.createElement('span');chip.className='chip';chip.textContent='Current';label.append(chip);}
    b.append(label);b.onclick=()=>goDesktop(i,b);list.append(b);
  }
  const note=!desk.count?'Your Mac did not list its desktops. Use Show all windows instead.':!desk.current?'A full-screen app is showing. Pick a desktop to leave it.':'';
  $('desknote').textContent=note;$('desknote').hidden=!note;
}
async function goDesktop(i,card){
  if(i===desk.current){toggle($('deskbtn'),$('desktops'));return;}
  snapshot(desk.current);card.classList.add('busy');
  const a=await act({kind:'desktop',index:i});card.classList.remove('busy');
  if(a?.ok){desk.current=i;toggle($('deskbtn'),$('desktops'));toast('Now on Desktop '+i);}
}
// A Mac without desktop support ends the session on an unknown message, so it only gets Mission Control.
$('deskbtn').onclick=()=>{if(!canList){act({kind:'overview'});return;}toggle($('deskbtn'),$('desktops'));if(!$('desktops').hidden){$('desklist').replaceChildren();$('desknote').hidden=true;send({t:'desktops'});}};
$('overview').onclick=()=>{toggle($('deskbtn'),$('desktops'));act({kind:'overview'});};
document.querySelectorAll('[data-key]').forEach(b=>{b.onclick=()=>act({kind:'key',key:b.dataset.key,modifiers:b.dataset.mod?[b.dataset.mod]:[]});});

$('stop').onclick=()=>{
  store.drop(KEEP);store.drop(PAUSED);send({t:'stop'});
  // Give the stop message a moment to leave before closing the connection.
  const was=control;setTimeout(()=>end('You ended the session. Anything already sent may have happened, so check your Mac when you are back.','ended'),was?.readyState==='open'?300:0);
  $('stop').disabled=true;
};

start().catch(e=>{console.error(e);/INVALID_SIGNAL/.test(e?.message)?end(EXPIRED_SUB,'expired'):end('Could not set up the connection. '+NEW_LINK);});
