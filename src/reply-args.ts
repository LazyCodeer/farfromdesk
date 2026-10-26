export type ReplyArgs={alias:string;requestId:string;kind:'progress'|'final';turnId?:string;outcome?:string};
/** Desktop chats do not inherit the bridge process's environment. Bind their
 * commands to the originating instance, without putting credentials in prompts. */
export function scopedBridgeCommand(node:string,cli:string,stateDir:string,port:string) {
  if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535)throw new Error('Invalid bridge port');
  const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;
  return ['/usr/bin/env',`WSB_STATE_DIR=${stateDir}`,`WSB_PORT=${port}`,node,cli].map(quote).join(' ');
}
const usage='Usage: respond NAME REQUEST-ID [progress|final] [--turn-id ID] [--outcome done|blocked|reviewed|cancelled], with the reply text on stdin.';
/** Validates respond arguments before anything is read or sent, so a mistyped kind never becomes a final reply. */
export function parseRespondArgs(argv:string[]):ReplyArgs {
  const rest:string[]=[],flags:Record<string,string>={};
  for(let i=0;i<argv.length;i++) {
    const a=argv[i];
    if(a==='--turn-id'||a==='--outcome') {
      const value=argv[++i];
      if(value===undefined||value.startsWith('--'))throw new Error(`${a} needs a value. ${usage}`);
      flags[a]=value;
    }
    else if(a.startsWith('-'))throw new Error(`Unknown option ${a}; nothing was sent. For an interim update write the bare word progress (not --progress). ${usage}`);
    else rest.push(a);
  }
  const [alias,requestId,kind,...extra]=rest;
  if(!alias||!requestId)throw new Error(`A session name and request ID are required; nothing was sent. ${usage}`);
  if(kind!==undefined&&kind!=='progress'&&kind!=='final')throw new Error(`Unknown reply kind "${kind}"; nothing was sent. Use progress or final, and put the reply text on stdin. ${usage}`);
  if(extra.length)throw new Error(`Unexpected argument "${extra[0]}"; nothing was sent. Put the reply text on stdin, not on the command line. ${usage}`);
  return {alias,requestId,kind:kind??'final',turnId:flags['--turn-id'],outcome:flags['--outcome']};
}
