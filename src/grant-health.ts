import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

/**
 * Why "Accessibility is on in System Settings" and "FarFromDesk cannot control this Mac"
 * can both be true at once, and how the app says so instead of just "Not allowed".
 *
 * tccd records the grant against the app bundle (`AUTHREQ_SUBJECT` names the app, not the
 * helper or the vendored driver, which are only the accessing processes). Release builds
 * are ad-hoc signed, so the stored requirement is a bare cdhash and belongs to those exact
 * bytes. Install another build (an update, a reinstall, a copy from another Mac) and the
 * row in System Settings stays switched on while matching nothing: every check fails. Only
 * removing the row and allowing again fixes it, which needs the owner. This never changes a
 * permission by itself; `reset` runs only from the owner's own click.
 */
type Exec=(file:string,args:string[])=>Promise<{stdout:string;stderr:string}>;
type Prefs={get(key:string):string|undefined;set(key:string,value:string):void};
export type AppSignature={app:string;bundleId:string;cdhash:string;adhoc:boolean;quarantined:boolean};
export type GrantDiagnosis={kind:'stale'|'unconfirmed';bundleId:string;app:string;summary:string;steps:string[];resetServices:string[]};

const run:Exec=promisify(execFile) as unknown as Exec;
// dist/grant-health.js -> backend -> Resources -> Contents -> FarFromDesk.app
const bundled=fileURLToPath(new URL('../../../../',import.meta.url)).replace(/\/$/,'');
const native=['FarFromDesk Accessibility.app/Contents/MacOS/ffd-accessibility','cua-driver/cua-driver'];
export const WORKING_CDHASH='accessibility-grant-cdhash';

export async function readAppSignature(app=bundled,exec:Exec=run):Promise<AppSignature|null>{
  if(!app.endsWith('.app'))return null;
  try{
    const {stderr}=await exec('/usr/bin/codesign',['-dv','--verbose=4',app]);
    const field=(name:string)=>new RegExp(`^${name}=(.+)$`,'m').exec(stderr)?.[1]?.trim();
    const bundleId=field('Identifier'),cdhash=field('CDHash');
    if(!bundleId||!cdhash)return null;
    // A quarantined helper or driver can be refused at launch, which reads exactly like a missing grant.
    const marks=await Promise.all(native.map(p=>exec('/usr/bin/xattr',['-p','com.apple.quarantine',`${app}/Contents/Resources/backend/native/${p}`]).then(()=>true,()=>false)));
    return {app,bundleId,cdhash,adhoc:field('Signature')==='adhoc'||field('TeamIdentifier')==='not set',quarantined:marks.some(Boolean)};
  }catch{return null;}
}

export function diagnoseGrant(signature:AppSignature|null,works:boolean|null,captureTrusted:boolean|null,lastWorking?:string):GrantDiagnosis|null{
  if(!signature||works!==false||(!signature.adhoc&&!signature.quarantined))return null;
  const {bundleId,app}=signature;
  const stale=signature.adhoc&&!!lastWorking&&lastWorking!==signature.cdhash;
  const summary=stale
    ?'Accessibility worked for an earlier copy of FarFromDesk. This copy has a different signature, so macOS no longer matches it to the FarFromDesk switch in System Settings, even though that switch still shows on.'
    :'FarFromDesk cannot use Accessibility. If System Settings already shows FarFromDesk switched on, that entry most likely belongs to an earlier copy of the app and no longer matches this one.';
  const steps=[
    ...(signature.quarantined?[`Clear the download quarantine in Terminal: xattr -dr com.apple.quarantine "${app}", then reopen FarFromDesk.`]:[]),
    `Press Reset and re-allow, or open System Settings > Privacy & Security > Accessibility, select FarFromDesk and remove it with the minus button. The same reset in Terminal: tccutil reset Accessibility ${bundleId}`,
    'Allow FarFromDesk when macOS asks, or add it back with the plus button and switch it on.',
    `If screenshots fail too, do the same under Screen Recording (tccutil reset ScreenCapture ${bundleId}).`,
    'Test again here. If it still fails, quit and reopen FarFromDesk.',
  ];
  return {kind:stale?'stale':'unconfirmed',bundleId,app,summary,steps,resetServices:captureTrusted===true?['Accessibility']:['Accessibility','ScreenCapture']};
}

export const NO_RESET='There is no permission to reset on this computer: only macOS keeps a per-app grant that can go stale.';

export class GrantHealth {
  private signature?:Promise<AppSignature|null>;
  private last:GrantDiagnosis|null=null;
  constructor(private prefs:Prefs,private read:()=>Promise<AppSignature|null>=()=>readAppSignature(),private exec:Exec=run,private platform=process.platform){}
  /** `works` is true when any check reached the desktop, false when all failed, null when unknown. */
  async check(works:boolean|null,captureTrusted:boolean|null=null){
    const signature=await (this.signature??=this.platform==='darwin'?this.read():Promise.resolve(null));
    if(signature&&works===true)this.prefs.set(WORKING_CDHASH,signature.cdhash);
    if(works!==null)this.last=diagnoseGrant(signature,works,captureTrusted,this.prefs.get(WORKING_CDHASH));
    return this.last;
  }
  view(){return this.last;}
  /** Owner-initiated only: clears this app's own stale rows so macOS can ask again. */
  async reset(){
    // Only macOS keeps per-app privacy grants that can go stale; Windows and Linux have none to clear.
    if(this.platform!=='darwin')throw new Error(NO_RESET);
    const diagnosis=this.last;
    if(!diagnosis)throw new Error('Nothing to reset: FarFromDesk has no stale permission to clear.');
    for(const service of diagnosis.resetServices)await this.exec('/usr/bin/tccutil',['reset',service,diagnosis.bundleId]);
    return diagnosis.resetServices;
  }
}
