import type {MailSecretStore} from './service.js';
/** Compatible with the shared MailboxCredentialVault; the host supplies a trusted bundled helper. */
export type MailKeychainVault={read(slot:string):Promise<string|undefined>;write(slot:string,value:string):Promise<void>;remove(slot:string):Promise<void>};
/** available checks trusted helper availability, not Keychain unlock or mailbox authentication. */
export function macKeychainStore(vault:MailKeychainVault,available:()=>boolean):MailSecretStore {
  return {kind:'macos-keychain',available,read:key=>vault.read(key),save:(key,value)=>vault.write(key,value),remove:key=>vault.remove(key)};
}
/** The same broker protocol, backed by Windows Credential Manager (native/local-mail-credentials.ps1). */
export function windowsCredentialStore(vault:MailKeychainVault,available:()=>boolean):MailSecretStore {
  return {kind:'windows-credential-manager',available,read:key=>vault.read(key),save:(key,value)=>vault.write(key,value),remove:key=>vault.remove(key)};
}
