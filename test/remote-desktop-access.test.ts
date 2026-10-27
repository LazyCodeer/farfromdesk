import test from 'node:test';import assert from 'node:assert/strict';
import {RemotePasswordAccess,type PasswordRecord} from '../src/remote-desktop/access.js';
import {LiveKitRemoteRoom,validateLiveKitConfig} from '../src/remote-desktop/livekit.js';
import {TokenVerifier} from 'livekit-server-sdk';
function fixture(){let record:PasswordRecord|undefined;let now=100;const access=new RemotePasswordAccess({load:()=>record,save:r=>record=r},()=>now);return {access,advance:(ms:number)=>now+=ms,record:()=>record};}
test('password verifier persists without plaintext; connection has no five-minute or 24-hour timeout',async()=>{
 const f=fixture(),a=f.access;await a.setPassword('a long fixture password');assert(!JSON.stringify(f.record()).includes('fixture password'));a.enable(true);a.setReady(true);
 const token=await a.authenticate('a long fixture password');f.advance(7*24*3600_000);a.authorize(token);assert.equal(a.status.durationLimitMinutes,null);
 a.disconnect(token);assert.throws(()=>a.authorize(token),/ACCESS_ENDED/);await assert.rejects(a.authenticate('wrong'),/INCORRECT_PASSWORD/);
});
test('lock, Stop, replacement connection and password change revoke access',async()=>{
 const a=fixture().access;await a.setPassword('original fixture password');a.enable(true);a.setReady(true);
 let t=await a.authenticate('original fixture password');await a.authenticate('original fixture password');assert.throws(()=>a.authorize(t));
 t=await a.authenticate('original fixture password');a.setReady(false);assert.throws(()=>a.authorize(t));a.setReady(true);
 t=await a.authenticate('original fixture password');a.stop();assert.throws(()=>a.authorize(t));a.enable(true);
 t=await a.authenticate('original fixture password');await a.setPassword('replacement fixture password');assert.throws(()=>a.authorize(t));assert.equal(a.status.enabled,false);
});
test('password failures are throttled globally, including across new callers',async()=>{
 const f=fixture(),a=f.access;await a.setPassword('a long fixture password');a.enable(true);a.setReady(true);
 for(let i=0;i<5;i++)await assert.rejects(a.authenticate('wrong'),/INCORRECT_PASSWORD/);
 await assert.rejects(a.authenticate('a long fixture password'),/WAIT_BEFORE_RETRY/);f.advance(30001);assert(await a.authenticate('a long fixture password'));
});
test('LiveKit viewer cannot publish media or send control; only loopback may use unencrypted transport',async()=>{
 const c={url:'ws://127.0.0.1:7880',apiKey:'test-key',apiSecret:'x'.repeat(40)};
 assert.throws(()=>validateLiveKitConfig({...c,url:'ws://example.com'}));
 const room=new LiveKitRemoteRoom(c),v=await room.token('viewer');const claims=await new TokenVerifier(c.apiKey,c.apiSecret).verify(v.token);
 assert.equal(claims.video?.canPublish,false);assert.equal(claims.video?.canPublishData,false);assert.equal(claims.video?.room,room.room);
});

test('saved availability survives reopening but never bypasses fresh runtime readiness and password',async()=>{
 let record:PasswordRecord|undefined,enabled=false;const store={load:()=>record,save:(r:PasswordRecord)=>record=r,loadEnabled:()=>enabled,saveEnabled:(v:boolean)=>enabled=v};
 const first=new RemotePasswordAccess(store);await first.setPassword('persistent fixture password');first.enable(true);first.setReady(true);const token=await first.authenticate('persistent fixture password');
 const reopened=new RemotePasswordAccess(store);assert.equal(reopened.status.enabled,true);assert.equal(reopened.status.ready,false);assert.throws(()=>reopened.authorize(token));await assert.rejects(reopened.authenticate('persistent fixture password'),/MAC_UNAVAILABLE/);
 reopened.setReady(true);assert(await reopened.authenticate('persistent fixture password'));
});

test('Stop during password verification cannot create a late authenticated session',async()=>{
 const a=fixture().access;await a.setPassword('inflight fixture password');a.enable(true);a.setReady(true);
 const pending=a.authenticate('inflight fixture password');a.stop();await assert.rejects(pending,/MAC_UNAVAILABLE/);assert.equal(a.status.connected,false);
});
