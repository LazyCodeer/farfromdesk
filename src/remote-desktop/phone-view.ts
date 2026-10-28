/** These assets are served only by the dedicated phone listener, never the admin API. */
export const phoneHtml=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><title>FarFromDesk Remote</title><link rel="stylesheet" href="/view.css"><main>
<header><div><small>FARFROMDESK</small><h1>Your Mac window</h1></div><button id="stop" disabled>Stop</button></header>
<section id="login"><p class="hint">Same Wi-Fi only. You control one window you picked on your Mac.</p><label>Remote access password<input id="password" type="password" autocomplete="current-password" maxlength="256"></label><button id="connect">Connect</button></section>
<p id="status" role="status">Use the password you set in FarFromDesk on your Mac.</p>
<section id="session" hidden>
<div class="screen"><img id="screen" alt="Selected Mac window" draggable="false"></div>
<p class="hint">Tap to click. Double tap to double-click. Hold for a right-click. Swipe to scroll.</p>
<label class="inline"><input id="lock" type="checkbox"> View only</label>
<form id="typeform" class="row"><input id="text" autocomplete="off" autocapitalize="off" maxlength="2000" placeholder="Type into the field you tapped"><button>Send</button></form>
<div class="keys"><button data-key="return">Return</button><button data-key="delete">Delete</button><button data-key="tab">Tab</button><button data-key="escape">Esc</button><button data-key="left">Left</button><button data-key="up">Up</button><button data-key="down">Down</button><button data-key="right">Right</button><button data-key="a" data-mod="cmd">Cmd A</button><button data-key="c" data-mod="cmd">Cmd C</button><button data-key="v" data-mod="cmd">Cmd V</button><button data-key="z" data-mod="cmd">Cmd Z</button><button data-key="f" data-mod="cmd">Cmd F</button></div>
</section></main><script src="/view.js"></script></html>`;
export const phoneCss=`:root{font:16px system-ui;color:#e8eeee;background:#10191b;color-scheme:dark}body{margin:0}main{max-width:980px;margin:auto;padding:16px}header,.row{display:flex;align-items:center;justify-content:space-between;gap:10px}small{letter-spacing:.14em;color:#98cbb9}h1{font-size:22px;margin:4px 0}button,input{font:inherit;border:1px solid #526166;border-radius:10px;padding:10px 12px;box-sizing:border-box}button{background:#d4f0e3;color:#132b24;cursor:pointer;min-height:44px}button:disabled{opacity:.45}#stop{background:#4d2428;color:#ffdadd}label{display:block;margin:12px 0}input:not([type=checkbox]){display:block;width:100%;margin-top:6px}.row input{margin:0}.inline{display:flex;align-items:center;gap:8px}.screen{position:relative}#screen{display:block;width:100%;height:auto;border-radius:8px;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;background:#000}.keys{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.keys button{flex:1 0 22%;padding:8px}#status{border:1px solid #354447;padding:10px;border-radius:10px;font-size:14px}.hint{color:#b0c0c2;font-size:14px;line-height:1.5;margin:8px 0}[hidden]{display:none!important}`;
export const phoneJs=`const $=id=>document.getElementById(id);let frame=null,ended=false,chain=Promise.resolve(),pending=0;const say=t=>$('status').textContent=t;
async function api(path,data={}){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(15000)});const d=await r.json();if(!r.ok)throw Error(d.error);return d;}
function end(message){ended=true;frame=null;$('screen').removeAttribute('src');$('stop').disabled=true;say(message);}
// One request at a time: the Mac handles a frame or an action, never both at once.
function queue(fn){pending++;const run=chain.then(async()=>{if(ended)return;try{await fn();}catch(e){if(/^(STALE|BUSY|INVALID|CHOOSE|WAIT|INCORRECT|TOO_MANY|TEXT_FIELD)/.test(e.message)){say(e.message+'. Nothing was retried.');frame=null;}else end(e.message+'. Nothing was retried. Start again from your Mac.');}finally{pending--;}});chain=run;return run;}
async function refresh(){const d=await api('/frame');if(ended)return;frame={...d,at:Date.now()};$('screen').src='data:'+(d.mime||'image/png')+';base64,'+d.png;}
function loop(){if(ended)return;if(document.hidden||pending){setTimeout(loop,400);return;}queue(refresh).then(()=>setTimeout(loop,250));}
function act(data){if($('lock').checked&&data.kind!=='key'&&data.kind!=='type'){say('View only is on.');return;}queue(async()=>{if(!frame||Date.now()-frame.at>3500)await refresh();await api('/action',{id:crypto.randomUUID(),frameId:frame.frameId,...data});frame=null;say('Sent. The view updates in a moment.');});}
$('connect').onclick=()=>queue(async()=>{const password=$('password').value;$('password').value='';await api('/login',{password});$('login').hidden=true;$('session').hidden=false;$('stop').disabled=false;say('Connected.');setTimeout(loop,0);});
const point=e=>{const r=$('screen').getBoundingClientRect();return {x:Math.min(.999,Math.max(0,(e.clientX-r.left)/r.width)),y:Math.min(.999,Math.max(0,(e.clientY-r.top)/r.height))};};
let down=null,hold=null,lastTap=0,tapTimer=null;
$('screen').addEventListener('pointerdown',e=>{if(!frame)return;e.preventDefault();down={...point(e),cx:e.clientX,cy:e.clientY,moved:false};hold=setTimeout(()=>{if(down&&!down.moved){act({kind:'right',x:down.x,y:down.y});down=null;}},550);});
$('screen').addEventListener('pointermove',e=>{if(!down)return;const dx=e.clientX-down.cx,dy=e.clientY-down.cy;if(Math.hypot(dx,dy)>24){down.moved=true;clearTimeout(hold);}});
$('screen').addEventListener('pointerup',e=>{clearTimeout(hold);if(!down)return;const d=down;down=null;const dx=e.clientX-d.cx,dy=e.clientY-d.cy;
 if(d.moved){const vertical=Math.abs(dy)>=Math.abs(dx),dist=vertical?dy:dx;act({kind:'scroll',x:d.x,y:d.y,direction:vertical?(dist<0?'down':'up'):(dist<0?'right':'left'),amount:Math.min(20,Math.max(1,Math.round(Math.abs(dist)/40)))});return;}
 const now=Date.now();if(now-lastTap<350){clearTimeout(tapTimer);lastTap=0;act({kind:'double',x:d.x,y:d.y});return;}
 lastTap=now;tapTimer=setTimeout(()=>act({kind:'click',x:d.x,y:d.y}),300);});
$('screen').addEventListener('pointercancel',()=>{clearTimeout(hold);down=null;});
$('screen').addEventListener('contextmenu',e=>e.preventDefault());
$('typeform').onsubmit=e=>{e.preventDefault();const text=$('text').value;if(!text)return;$('text').value='';act({kind:'type',text});};
document.querySelectorAll('[data-key]').forEach(b=>b.onclick=()=>act({kind:'key',key:b.dataset.key,modifiers:b.dataset.mod?[b.dataset.mod]:[]}));
$('stop').onclick=async()=>{const was=ended;end('Stopping. Input already sent may have taken effect.');if(was)return;try{await api('/stop');say('Stopped. Start again from your Mac.');}catch{say('Stop could not be confirmed. Press Stop in FarFromDesk on your Mac.');}};
setInterval(async()=>{if(ended||$('session').hidden)return;try{await api('/heartbeat');}catch{end('Connection ended. Start again from your Mac.');}},3000);`;
