import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,existsSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RTCPeerConnection} from 'werift';
import {RemotePasswordAccess,type PasswordRecord} from '../src/remote-desktop/access.js';
import {P2PHost} from '../src/remote-p2p/host.js';
import {CONTROL_CHANNEL,FRAME_CHANNEL,FrameAssembler,type MacMessage} from '../src/remote-p2p/protocol.js';
import {decodeSignal,encodeSignal,sdpToSignal,signalToSdp} from '../src/remote-p2p/signal-codec.js';
import {WindowsDesktopBackend} from '../src/remote-p2p/windows-desktop.js';
import {windowsPowerShell} from '../src/power.js';

/**
 * Live phone screen control on this Windows PC, end to end: a WebRTC "phone" logs in to the real
 * host, receives real screen frames, and clicks and types into a test window this test opens itself.
 * It moves the mouse and types for a few seconds, so it runs only when asked:
 *   FFD_LIVE_DESKTOP=1 npm run test:file -- test/remote-windows-live.test.ts
 */
const live=process.platform==='win32'&&process.env.FFD_LIVE_DESKTOP==='1';
/** Title of the foreground window and the cursor position, in real pixels. */
function foreground():Promise<{title:string;x:number;y:number}>{
 const code=`Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public struct P { public int X; public int Y; } public static class F { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n); [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p); }'; [F]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null; $s = New-Object Text.StringBuilder 256; [F]::GetWindowText([F]::GetForegroundWindow(), $s, 256) | Out-Null; $p = New-Object P; [F]::GetCursorPos([ref]$p) | Out-Null; @{ title = $s.ToString(); x = $p.X; y = $p.Y } | ConvertTo-Json -Compress`;
 return new Promise((resolve,reject)=>{const c=spawn(windowsPowerShell(),['-NoLogo','-NoProfile','-Command',code],{stdio:['ignore','pipe','ignore'],windowsHide:true});let out='';c.stdout.on('data',d=>out+=d);c.on('exit',()=>{try{resolve(JSON.parse(out));}catch(e){reject(e);}});});
}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

// A small top-most text box that reports where it is (real pixels) and what it holds.
const TARGET=String.raw`
param([string]$Dir)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i); }'
[Dpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
$f = New-Object System.Windows.Forms.Form
$f.Text = 'FarFromDesk remote test'; $f.TopMost = $true; $f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point(160, 160); $f.Size = New-Object System.Drawing.Size(700, 320)
# RichTextBox: a multiline TextBox ignores Ctrl+A, ordinary apps do not.
$t = New-Object System.Windows.Forms.RichTextBox
$t.Dock = 'Fill'; $t.Font = New-Object System.Drawing.Font('Segoe UI', 16)
$f.Controls.Add($t)
$t.add_TextChanged({ [IO.File]::WriteAllText((Join-Path $Dir 'text.txt'), $t.Text, [Text.Encoding]::UTF8) })
$f.add_Shown({
  $f.Activate()
  $r = $t.RectangleToScreen($t.ClientRectangle)
  $o = @{ left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom; width = [Dpi]::GetSystemMetrics(0); height = [Dpi]::GetSystemMetrics(1) } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText((Join-Path $Dir 'rect.json'), $o)
})
[System.Windows.Forms.Application]::Run($f)
`;

test('live: a phone controls this PC over WebRTC (frames, click, type, shortcuts)',{skip:!live&&'set FFD_LIVE_DESKTOP=1 on Windows to run',timeout:90_000},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ffd-remote-live-')),script=join(dir,'target.ps1');writeFileSync(script,TARGET);
 const target=spawn(windowsPowerShell(),['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-STA','-File',script,dir],{stdio:'ignore'});
 let record:PasswordRecord|undefined;
 const access=new RemotePasswordAccess({load:()=>record,save:r=>{record=r;}});await access.setPassword('synthetic live password');access.enable(true);
 const host=new P2PHost({access,backend:()=>new WindowsDesktopBackend(),stun:[]});
 const pc=new RTCPeerConnection({iceServers:[{urls:[]}]} as any);
 try{
  for(let i=0;i<100&&!existsSync(join(dir,'rect.json'));i++)await sleep(100);
  const rect=JSON.parse(readFileSync(join(dir,'rect.json'),'utf8').replace(/^﻿/,''));
  const typed=()=>existsSync(join(dir,'text.txt'))?readFileSync(join(dir,'text.txt'),'utf8').replace(/^﻿/,''):'';
  const offer=await host.createOffer(),o=decodeSignal(offer.code);
  const control=pc.createDataChannel(CONTROL_CHANNEL.label,{negotiated:true,id:CONTROL_CHANNEL.id,ordered:true});
  const frames=pc.createDataChannel(FRAME_CHANNEL.label,{negotiated:true,id:FRAME_CHANNEL.id,ordered:true});
  await pc.setRemoteDescription({type:'offer',sdp:signalToSdp(o)});await pc.setLocalDescription(await pc.createAnswer());
  while(pc.iceGatheringState!=='complete')await sleep(20);
  const messages:MacMessage[]=[],shown:{frameId:number;width:number;height:number;jpeg:Uint8Array}[]=[],asm=new FrameAssembler();
  control.onMessage.subscribe(d=>messages.push(JSON.parse(String(d))));
  frames.onMessage.subscribe(d=>{const f=asm.push(d as Buffer);if(f)shown.push(f);});
  const wait=async(pred:()=>unknown,ms=10_000)=>{const end=Date.now()+ms;while(!pred()){if(Date.now()>end)throw Error('timeout');await sleep(25);}};
  const send=(m:unknown)=>control.send(JSON.stringify(m));
  const text=()=>typed().replace(/\r\n?/g,'\n');
  const holds=(want:string)=>wait(()=>text()===want).catch(e=>{t.diagnostic(`box holds ${JSON.stringify(text())}, wanted ${JSON.stringify(want)}`);throw e;});
  await host.acceptAnswer(encodeSignal(sdpToSignal(pc.localDescription!.sdp,'answer',o.s)));
  await wait(()=>control.readyState==='open');
  send({t:'auth',password:'synthetic live password'});
  await wait(()=>messages.some(m=>m.t==='auth-ok')&&shown.length>0);
  const ok=messages.find(m=>m.t==='auth-ok') as any;
  assert.equal(ok.os,'windows');
  assert.equal(Buffer.from(shown[0]!.jpeg.subarray(0,2)).toString('hex'),'ffd8');
  // The frame is the whole primary screen, scaled: same shape as the screen.
  assert.ok(Math.abs(shown[0]!.width/shown[0]!.height-rect.width/rect.height)<0.01,'frame keeps the screen shape');
  // Pull ten frames the way the page does, and time them.
  const started=Date.now();
  for(let i=0;i<10;i++){const last=shown.at(-1)!.frameId;send({t:'ready',frameId:last});await wait(()=>shown.at(-1)!.frameId>last);}
  const fps=10/((Date.now()-started)/1000);t.diagnostic(`${fps.toFixed(1)} frames per second, ${shown.at(-1)!.width}x${shown.at(-1)!.height}, ${shown.at(-1)!.jpeg.length} bytes`);
  assert.ok(fps>2,'at least 2 frames a second');
  let n=0;
  const act=async(input:Record<string,unknown>)=>{
   const id=`live-input-${String(++n).padStart(4,'0')}`;send({t:'input',id,frameId:shown.at(-1)!.frameId,...input});
   await wait(()=>messages.some(m=>m.t==='ack'&&(m as any).id===id));
   const ack=messages.find(m=>m.t==='ack'&&(m as any).id===id) as any;assert.equal(ack.ok,true,`${input.kind}: ${ack.error}`);
  };
  // Tap the middle of the test box: fractions of the frame are fractions of the screen.
  await act({kind:'click',x:((rect.left+rect.right)/2)/rect.width,y:((rect.top+rect.bottom)/2)/rect.height});
  // Never type unless the tap really focused the test window: otherwise keys land in whatever is in front.
  const front=await foreground();t.diagnostic(`after tap: ${JSON.stringify(front)}, box ${JSON.stringify(rect)}`);
  assert.equal(front.title,'FarFromDesk remote test','the tap focused the test window');
  await act({kind:'type',text:'ffd remote ✓ 123'});
  await holds('ffd remote ✓ 123');
  await act({kind:'key',key:'a',modifiers:['cmd']});           // ⌘A selects all, as Ctrl+A
  await act({kind:'type',text:'replaced'});
  await holds('replaced');
  await act({kind:'key',key:'delete'});                        // Backspace
  await holds('replace');
  await act({kind:'key',key:'return'});
  await act({kind:'type',text:'line two'});
  await holds('replace\nline two');
  await act({kind:'scroll',x:((rect.left+rect.right)/2)/rect.width,y:((rect.top+rect.bottom)/2)/rect.height,direction:'up',amount:2});
  assert.equal(host.status.state,'connected');
 }finally{host.stop('STOPPED');await pc.close().catch(()=>{});target.kill();await sleep(300);rmSync(dir,{recursive:true,force:true});}
});
