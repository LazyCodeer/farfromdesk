import {lookup as systemLookup} from 'node:dns/promises';
import {connect,type ConnectionOptions} from 'node:tls';
import {isIP} from 'node:net';
import ipaddr from 'ipaddr.js';

type Resolved={address:string;family:number};
type Resolver=(hostname:string)=>Promise<Resolved[]>;
const privateRanges:Record<string,number>[]=[{'192.0.0.0':24},{'192.88.99.0':24},{'198.18.0.0':15}];
export function isPublicMailAddress(value:string){
  try{let ip=ipaddr.parse(value);if(ip.kind()==='ipv6'&&(ip as ipaddr.IPv6).isIPv4MappedAddress())ip=(ip as ipaddr.IPv6).toIPv4Address();
    if(ip.range()!=='unicast')return false;
    if(ip.kind()==='ipv6'){const v=ip as ipaddr.IPv6;if(!v.match(ipaddr.IPv6.parse('2000::'),3)||v.match(ipaddr.IPv6.parse('2001::'),23)||v.match(ipaddr.IPv6.parse('2002::'),16)||v.match(ipaddr.IPv6.parse('3fff::'),20))return false;}
    if(ip.kind()==='ipv4'&&privateRanges.some(entry=>{const [network,bits]=Object.entries(entry)[0];return (ip as ipaddr.IPv4).match(ipaddr.IPv4.parse(network),bits);}))return false;
    return true;
  }catch{return false;}
}
/** Resolve and pin the address used by TLS; never fall back to private or mixed DNS answers. */
export function publicMailConnector(resolve:Resolver=host=>systemLookup(host,{all:true,verbatim:true})){
  return (options:ConnectionOptions)=>{if(typeof options.host!=='string'||isIP(options.host))throw new Error('Mail destination unavailable.');return connect({...options,autoSelectFamily:false,lookup:(hostname,_options,callback)=>{
    void resolve(hostname).then(addresses=>{
      if(!addresses.length||addresses.some(a=>!isPublicMailAddress(a.address)||!([4,6].includes(a.family))))throw Error('mail destination unavailable');
      callback(null,addresses[0].address,addresses[0].family);
    }).catch(()=>callback(new Error('Mail destination unavailable.'),'',4));
  }} as ConnectionOptions);};
}
