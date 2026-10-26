import type { Store } from './store.js';

export type ChannelSwitchState='none'|'setup'|'saved'|'connected';
type Channels={whatsapp:{disconnectForSwitch:(confirmed?:boolean)=>Promise<void>;switchState?:()=>Promise<ChannelSwitchState>};telegram?:{disconnect:()=>void;switchState?:()=>ChannelSwitchState}};
const switching=new WeakSet<Store>();
export function channelChosen(store:Store){return !!(store.get('control-channel')||store.get('whatsapp-owner')||store.get('telegram-bot-id'));}
export async function channelSwitchState(store:Store,channels:Channels) {
  const channel=store.controlChannel();
  const state=channel==='telegram'?(channels.telegram?.switchState?.()??(store.get('telegram-bot-id')?'saved':'none')):
    await (channels.whatsapp.switchState?.()??Promise.resolve(channelChosen(store)?'saved':'none'));
  return {channel,state,requiresConfirmation:state!=='none'};
}
export async function switchControlChannel(store:Store,channels:Channels,input:{channel?:unknown;confirmed?:unknown;expectedChannel?:unknown}) {
  if(input.channel!=='whatsapp'&&input.channel!=='telegram')throw new Error('Choose WhatsApp or Telegram.');
  if(switching.has(store))throw new Error('A messaging switch is already in progress.');
  switching.add(store);
  try {
    const current=store.controlChannel(),chosen=channelChosen(store);
    if(chosen&&input.channel===current)return {channel:current};
    if(input.expectedChannel!==undefined&&input.expectedChannel!==current)throw new Error('Messaging selection changed. Review the current app before switching.');
    const state=await channelSwitchState(store,channels);
    if(state.requiresConfirmation&&(input.confirmed!==true||input.expectedChannel!==current))throw new Error('Confirm disconnecting the current messaging account before switching.');
    if(chosen||state.requiresConfirmation){
      // Also cancel an unconfigured in-flight attempt; selection is not connection.
      if(current==='whatsapp')await channels.whatsapp.disconnectForSwitch(input.confirmed===true);
      else {if(!channels.telegram)throw new Error('Telegram service is unavailable.');channels.telegram.disconnect();}
    }
    store.set('control-channel',input.channel);
    store.audit('control-channel-changed',undefined,`${current}:${input.channel}`);
    return {channel:input.channel};
  }finally{switching.delete(store);}
}

/** Disconnect the selected transport without changing channel or background preference. */
export async function disconnectControlChannel(store:Store,channels:Channels,input:{confirmed?:unknown;expectedChannel?:unknown}) {
  if(input.confirmed!==true||input.expectedChannel!==store.controlChannel())throw new Error('Confirm disconnecting the currently selected messaging app.');
  if(switching.has(store))throw new Error('A messaging switch is already in progress.');
  switching.add(store);
  try {
    const channel=store.controlChannel();
    if(channel==='whatsapp')await channels.whatsapp.disconnectForSwitch(true);
    else {if(!channels.telegram)throw new Error('Telegram service is unavailable.');channels.telegram.disconnect();}
    store.audit('control-channel-disconnected',undefined,channel);
    return {channel,disconnected:true};
  } finally {switching.delete(store);}
}
