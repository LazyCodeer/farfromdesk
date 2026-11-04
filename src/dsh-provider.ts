import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * DeepSeek Harness runs a profile, and the profile decides which provider route and model a run
 * uses. The shipped default on this machine is `deepseek-official` / `deepseek-flash`, and a
 * headless run does not inherit the desktop app's credential: the GUI resolves it through its own
 * credential service, while a child process sees nothing and exits 1 with
 * `MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"`.
 *
 * Both halves of the fix were measured on 4 November 2026:
 *
 * - `DEEPSEEK_API_KEY=<key> dsh --profile headless --json -` moves past that error and fails with
 *   the provider's own `AUTH` 401, so the child environment is the whole mechanism.
 * - `dsh --profile headless --patch <file>` composes an `agent-default-model` overlay
 *   (`provider`, `model`, `reasoningEffort`), so the route and model are settable per run without
 *   editing the owner's profile.
 *
 * This module turns the owner's settings into (a) the child environment and (b) that patch file, for
 * any provider route rather than DeepSeek alone. It is deliberately free of I/O except for the one
 * `writePatch` helper, so the rules are testable without a CLI.
 */

export type DshSettingsSource = (key: string) => string | undefined;

export interface DshProviderSettings {
  route: string;
  model: string;
  reasoningEffort?: string;
  /** The environment variable the route reads its key from; the owner may name it explicitly. */
  keyEnv: string;
  /** The stored key, when the owner saved one in the app. */
  key?: string;
}

export const DEFAULT_DSH_ROUTE = 'deepseek-official';
export const DEFAULT_DSH_MODEL = 'deepseek-flash';

/** Where a run's key came from, in the order the app looks: explicit choice, inherited, DSH store. */
export type DshKeySource = 'settings' | 'environment' | 'credentials' | 'none';

/**
 * Routes whose key variable we can name with confidence, and the variable each one reads. A route
 * that is not listed still works: the owner names the variable in the settings.
 */
export const ROUTE_KEY_ENV: Record<string, string> = {
  'deepseek-official': 'DEEPSEEK_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  'azure-openai': 'AZURE_OPENAI_API_KEY',
  azure: 'AZURE_OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  xai: 'XAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
};

export function defaultKeyEnv(route: string): string | undefined {
  return ROUTE_KEY_ENV[route.trim().toLowerCase()];
}

/** The owner's settings, with the shipped defaults filled in. Empty strings mean "not set". */
export function dshSettings(get: DshSettingsSource, profile?: DshProfile | null): DshProviderSettings {
  const route = (get('deepseek-provider') ?? '').trim() || profile?.route || DEFAULT_DSH_ROUTE;
  const model = (get('deepseek-model') ?? '').trim() || profile?.model || DEFAULT_DSH_MODEL;
  const effort = (get('deepseek-reasoning-effort') ?? '').trim() || profile?.reasoningEffort || '';
  const keyEnv = (get('deepseek-key-env') ?? '').trim() || profile?.keyEnv || defaultKeyEnv(route) || '';
  const key = (get('deepseek-api-key') ?? '').trim();
  return {route, model, ...(effort ? {reasoningEffort: effort} : {}), keyEnv, ...(key ? {key} : {})};
}

/**
 * The environment overrides a run needs. The stored key wins over an inherited variable so the
 * owner's explicit choice is not silently ignored, and nothing is written when neither exists: the
 * run then fails with the CLI's own credential error, which the caller reports as-is.
 */
export function keyEnvironment(settings: DshProviderSettings, env: NodeJS.ProcessEnv = process.env, refs?: (name: string) => string | undefined): {
  env: Record<string, string>;
  source: DshKeySource;
} {
  if (!settings.keyEnv) return {env: {}, source: 'none'};
  if (settings.key) return {env: {[settings.keyEnv]: settings.key}, source: 'settings'};
  if ((env[settings.keyEnv] ?? '').trim()) return {env: {}, source: 'environment'};
  const stored = refs?.(settings.keyEnv);
  if (stored) return {env: {[settings.keyEnv]: stored}, source: 'credentials'};
  return {env: {}, source: 'none'};
}

/** One YAML scalar. Provider and model names are simple, but quoting keeps a stray value safe. */
function scalar(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The `--patch` overlay for a run, or null when the profile's own defaults should stand. A patch
 * replaces the whole config of the entry it names, so every field the entry needs is written here.
 */
export function patchYaml(settings: DshProviderSettings): string | null {
  if (!settings.route || !settings.model) return null;
  const lines = [
    '- id: agent-default-model',
    '  config:',
    `    provider: ${scalar(settings.route)}`,
    `    model: ${scalar(settings.model)}`,
  ];
  if (settings.reasoningEffort) lines.push(`    reasoningEffort: ${scalar(settings.reasoningEffort)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * The desktop profile decides which provider the app itself uses. A headless run starts from the
 * shipped `headless` profile, which knows nothing about that choice, so a route the owner configured
 * in the app is unknown to the CLI ("pi-ai provider \"azure-deepseek\" has no configured model").
 * Mirroring the owner's own patch entry is what makes "it is set in the settings" true for a run.
 * Measured on 4 November 2026: with the owner's `llm-pi-ai` block and the Azure deployment name, the
 * headless run answered; without it, UNKNOWN_MODEL.
 */
export interface DshProfile {
  route?: string;
  model?: string;
  reasoningEffort?: string;
  /** The key variable the owner's provider block names. */
  keyEnv?: string;
  /** The owner's `llm-pi-ai` entry, verbatim, so no provider field is lost in a rewrite. */
  providers?: string;
}

function quoted(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One top-level patch entry, by id: `- id: name` up to the next top-level `- `. */
export function entryById(text: string, id: string): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex(line => new RegExp(`^-\\s*id:\\s*${quoted(id)}\\s*$`).test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^-\s/.test(lines[index])) { end = index; break; }
  }
  return lines.slice(start, end).join('\n').replace(/\s+$/, '');
}

/** A scalar anywhere inside an entry, so a nested `config:` block still reads. */
export function entryScalar(entry: string, key: string): string | undefined {
  const match = new RegExp(`^\\s+${quoted(key)}:\\s*(.+?)\\s*$`, 'm').exec(entry);
  if (!match) return undefined;
  const raw = match[1].trim().replace(/^['"]|['"]$/g, '');
  return raw || undefined;
}

export function parseProfile(text: string): DshProfile | null {
  const agent = entryById(text, 'agent-default-model');
  const providers = entryById(text, 'llm-pi-ai');
  if (!agent && !providers) return null;
  const profile: DshProfile = {};
  if (agent) {
    profile.route = entryScalar(agent, 'provider');
    profile.model = entryScalar(agent, 'model');
    profile.reasoningEffort = entryScalar(agent, 'reasoningEffort');
  }
  if (providers) {
    profile.providers = providers;
    profile.keyEnv = entryScalar(providers, 'apiKeyEnv');
  }
  return profile;
}

/** The owner's own profile patch, or null when there is none to read. Never throws. */
export function readProfile(dshHome: string): DshProfile | null {
  try {
    return parseProfile(readFileSync(join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'));
  } catch {
    return null;
  }
}

/** Whether the mirrored provider already lists this model id. */
export function modelListed(providers: string, model: string): boolean {
  // The list entries are indented under `models:` and the entry itself under `providers.<name>`.
  return new RegExp(`^\\s*-\\s*id:\\s*${quoted(model)}\\s*$`, 'm').test(providers);
}

/**
 * Add the run's model to the mirrored provider list when it is not there. The owner's profile may
 * list only a dated model id while the deployment it actually calls is the plain name, and the CLI
 * refuses a model that its provider block does not declare (UNKNOWN_MODEL, measured).
 */
export function withModel(providers: string, model: string): string {
  if (!model || modelListed(providers, model)) return providers;
  const lines = providers.split('\n');
  const at = lines.findIndex(line => /^\s*models:\s*$/.test(line));
  const indent = `${(lines[at]?.match(/^\s*/)?.[0] ?? '        ')}  `;
  const entry = [`${indent}- id: ${model}`, `${indent}  name: ${model}`];
  if (at < 0) return `${providers}\n${indent.replace(/  $/, '')}models:\n${entry.join('\n')}`;
  lines.splice(at + 1, 0, ...entry);
  return lines.join('\n');
}

/** The provider block declares reasoning-effort support; without it the CLI refuses the effort. */
export function reasoningSupported(providers: string): boolean {
  return /^\s+reasoningEfforts?:/m.test(providers);
}

export interface ComposedPatch {
  text: string;
  /** Things a person should know about the patch, such as an effort that had to be dropped. */
  notes: string[];
}

/**
 * The patch a run gets: the route and model this run uses, plus the owner's own provider definition
 * when there is one. Returns null when there is nothing to say.
 */
export function composePatch(settings: DshProviderSettings, profile?: DshProfile | null): ComposedPatch | null {
  if (!settings.route || !settings.model) return null;
  const notes: string[] = [];
  const lines = [
    '- id: agent-default-model',
    '  config:',
    `    provider: ${scalar(settings.route)}`,
    `    model: ${scalar(settings.model)}`,
  ];
  if (settings.reasoningEffort) {
    if (!profile?.providers || reasoningSupported(profile.providers)) {
      lines.push(`    reasoningEffort: ${scalar(settings.reasoningEffort)}`);
    } else {
      notes.push(`The provider does not declare reasoning-effort support, so this run does not set "${settings.reasoningEffort}".`);
    }
  }
  const blocks = [lines.join('\n')];
  if (profile?.providers) blocks.push(withModel(profile.providers, settings.model));
  return {text: `${blocks.join('\n')}\n`, notes};
}

/**
 * A key the DSH credential store holds a reference for. The desktop app resolves its own key
 * through its credential service, which a child process cannot open; the store's `refs` map is the
 * part a child can read, and it is where a key set in the app settings lands. Returns nothing when
 * the file is missing or the value looks like a placeholder rather than a key.
 */
export function credentialRef(dshHome: string, keyEnv: string): string | undefined {
  if (!keyEnv) return undefined;
  let text = '';
  try {
    text = readFileSync(join(dshHome, '.credentials.yaml'), 'utf8');
  } catch {
    return undefined;
  }
  const match = new RegExp(`^\\s+${quoted(keyEnv)}:\\s*(\\S+)\\s*$`, 'm').exec(text);
  const value = match?.[1];
  return value && value.length > 8 ? value : undefined;
}

/**
 * Write the patch beside the app's own state and return its path, or null when the profile's own
 * defaults should stand. A stable path is deliberate: the owner can read exactly what was applied,
 * and a repeated run rewrites the same file instead of littering.
 */
export function writePatch(directory: string, settings: DshProviderSettings, profile?: DshProfile | null): string | null {
  const text = profile ? composePatch(settings, profile)?.text ?? null : patchYaml(settings);
  if (!text) return null;
  const path = join(directory, 'deepseek-provider.yml');
  try {
    mkdirSync(directory, {recursive: true});
    writeFileSync(path, text, 'utf8');
  } catch {
    return null;
  }
  return path;
}

export interface DshStatus {
  configured: boolean;
  route: string;
  model: string;
  keyEnv: string;
  keySource: DshKeySource;
  /** One line a person can act on; never contains the key. */
  hint: string;
}

/** What the owner is shown before a run, with no secret in it. */
export function dshStatus(settings: DshProviderSettings, env: NodeJS.ProcessEnv = process.env, refs?: (name: string) => string | undefined): DshStatus {
  const {source} = keyEnvironment(settings, env, refs);
  const configured = source !== 'none';
  const hint = configured
    ? `DeepSeek runs ${settings.route} with ${settings.model} in this folder.`
    : settings.keyEnv
      ? `DeepSeek needs an API key for ${settings.route}. Store it in the app, or export ${settings.keyEnv} before launching FarFromDesk.`
      : `I do not know which environment variable the provider route ${settings.route} reads. Name it in the DeepSeek settings, or export the key the route expects.`;
  return {configured, route: settings.route, model: settings.model, keyEnv: settings.keyEnv, keySource: source, hint};
}

/**
 * A credential failure is the one DeepSeek error a person can act on from here, and the CLI's own
 * wording ("Authentication Fails, Your api key **** is invalid") is not a next step. Any other
 * failure is returned untouched, because guessing at someone else's error hides the real one.
 */
export function credentialHint(message: string, status: DshStatus): string | null {
  const looksLikeCredentials =
    /MISSING_CREDENTIAL|no api key for provider route|Authentication Fails|invalid api key|incorrect api key|\b401\b/i.test(message);
  return looksLikeCredentials ? status.hint : null;
}