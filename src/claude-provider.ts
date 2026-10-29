import { createHash } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const providerVariable = /^(ANTHROPIC_|CLAUDE_CODE_(OAUTH_TOKEN|USE_|SUBAGENT_MODEL)|AWS_|GOOGLE_|GCLOUD_|AZURE_|CLOUD_ML_)/;
const providerSettings = new Set(['model', 'fallbackModel', 'modelOverrides', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'forceLoginMethod', 'forceLoginOrgUUID', 'allowedApiProviders']);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function claudeProviderEnvironment(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(Object.keys(env).filter(key => providerVariable.test(key)).sort().map(key => [key, env[key]]));
}

/** Reads only bounded regular JSON files. Never executes credential helpers or returns secrets. */
async function providerFile(path: string, global = false): Promise<unknown> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await handle.stat();
    const limit = global ? 16 * 1024 * 1024 : 2 * 1024 * 1024;
    if (!stat.isFile() || stat.size > limit) throw new Error('Invalid configuration file');
    const buffer = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > stat.size) throw new Error('Configuration changed while checking');
    const data = JSON.parse(buffer.subarray(0, used).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid configuration');
    // The native global config can contain a Console API key. Ignore history and OAuth refresh data.
    if (global) return data.primaryApiKey ? hash(data.primaryApiKey) : null;
    const fields = Object.fromEntries(Object.keys(data).filter(key => providerSettings.has(key)).sort().map(key => [key, data[key]]));
    return hash({ ...fields, env: data.env && typeof data.env === 'object' ? claudeProviderEnvironment(data.env) : {} });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('Claude provider configuration could not be checked. Review its settings and retry.');
  } finally { await handle?.close(); }
}

/** Pin configuration, not access to a provider. Claude still resolves settings and authenticates. */
export async function claudeProviderFingerprint(cwd: string, env: NodeJS.ProcessEnv = process.env,
  options: { home?: string; managedRoot?: string; configDirectory?: string } = {}) {
  const home = options.home ?? homedir();
  const root = options.configDirectory ?? env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
  const managed = options.managedRoot ?? (process.platform === 'win32' ? join(env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode') : process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code');
  let dropins: string[];
  try { dropins = (await readdir(join(managed, 'managed-settings.d'))).filter(name => !name.startsWith('.') && name.endsWith('.json')).sort(); }
  catch (error: any) {
    if (error?.code !== 'ENOENT') throw new Error('Claude managed provider configuration could not be checked.');
    dropins = [];
  }
  if (dropins.length > 128) throw new Error('Claude managed provider configuration could not be checked.');
  const files = [join(root, 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json'),
    join(managed, 'managed-settings.json'), ...dropins.map(name => join(managed, 'managed-settings.d', name))];
  // The preview runs in the home directory, where user and project paths can be
  // the same file. A newly created coordinator with no overrides must pin identically.
  const sources = files.map(path => { try { return realpathSync(path); } catch { return path; } });
  const settings = (await Promise.all([...new Set(sources)].map(path => providerFile(path))))
    .filter(value => value !== null && value !== hash({ env: {} }));
  const global = await providerFile(env.CLAUDE_CONFIG_DIR ? join(root, '.claude.json') : join(home, '.claude.json'), true);
  return hash([claudeProviderEnvironment(env), settings, global]);
}
