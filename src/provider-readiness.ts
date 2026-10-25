/** Read the same effective project config used by the native app-server.
 * This checks locally knowable prerequisites; it never proves account/model access.
 * No config values or credentials are returned or logged.
 */
export async function checkCodexEnvironment(runtime:{request:(method:string,params:any)=>Promise<any>},cwd:string,env:NodeJS.ProcessEnv=process.env) {
  const response=await runtime.request('config/read',{cwd,includeLayers:false});
  const config=response?.config;
  if(!config||typeof config!=='object')throw new Error('Native Codex configuration could not be checked. Update the native CLI and retry this exact setup.');
  const definitions=config.model_providers,selected=typeof config.model_provider==='string'?config.model_provider:'openai';
  const provider=definitions&&typeof definitions==='object'?definitions[selected]:undefined;
  if(provider?.env_key!==undefined&&provider.env_key!==null) {
    if(typeof provider.env_key!=='string'||!provider.env_key.length||provider.env_key.length>200)throw new Error('Native Codex provider configuration is invalid. Review it in the native CLI.');
    if(!env[provider.env_key]?.trim())throw new Error('Missing environment variable required by the configured Codex provider. Configure it for the bridge process, then recover the same session.');
  }
}
