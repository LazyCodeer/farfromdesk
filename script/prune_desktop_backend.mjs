import {existsSync, lstatSync, readdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';

function bytes(path) {
  const stat=lstatSync(path);
  if(stat.isSymbolicLink())throw new Error('Unexpected symlink in optional SDK package');
  return stat.isDirectory()?readdirSync(path).reduce((sum,name)=>sum+bytes(join(path,name)),0):stat.size;
}

// Our ClaudeSDKSession always supplies pathToClaudeCodeExecutable from the
// owner's installed CLI. Keep SDK JavaScript and its dependencies, but do not
// ship the SDK's unused fallback CLI (~260 MiB per platform) a second time.
export function pruneDesktopBackend(root) {
  const scope=join(root,'node_modules','@anthropic-ai');
  if(!existsSync(scope))return {removedBytes:0,packages:[]};
  if(lstatSync(scope).isSymbolicLink())throw new Error('SDK package scope must be a real directory');
  const packages=readdirSync(scope).filter(name=>/^claude-agent-sdk-(?:darwin-(?:arm64|x64)|linux-(?:arm64|x64)(?:-musl)?|win32-(?:arm64|x64))$/.test(name));
  const removedBytes=packages.reduce((sum,name)=>sum+bytes(join(scope,name)),0);
  for(const name of packages)rmSync(join(scope,name),{recursive:true,force:true});
  return {removedBytes,packages};
}
