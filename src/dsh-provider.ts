import {mkdirSync, writeFileSync} from 'node:fs';
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
export function dshSettings(get: DshSettingsSource): DshProviderSettings {
  const route = (get('deepseek-provider') ?? '').trim() || DEFAULT_DSH_ROUTE;
  const model = (get('deepseek-model') ?? '').trim() || DEFAULT_DSH_MODEL;
  const effort = (get('deepseek-reasoning-effort') ?? '').trim();
  const keyEnv = (get('deepseek-key-env') ?? '').trim() || defaultKeyEnv(route) || '';
  const key = (get('deepseek-api-key') ?? '').trim();
  return {route, model, ...(effort ? {reasoningEffort: effort} : {}), keyEnv, ...(key ? {key} : {})};
}

/**
 * The environment overrides a run needs. The stored key wins over an inherited variable so the
 * owner's explicit choice is not silently ignored, and nothing is written when neither exists: the
 * run then fails with the CLI's own credential error, which the caller reports as-is.
 */
export function keyEnvironment(settings: DshProviderSettings, env: NodeJS.ProcessEnv = process.env): {
  env: Record<string, string>;
  source: 'settings' | 'environment' | 'none';
} {
  if (!settings.keyEnv) return {env: {}, source: 'none'};
  if (settings.key) return {env: {[settings.keyEnv]: settings.key}, source: 'settings'};
  if ((env[settings.keyEnv] ?? '').trim()) return {env: {}, source: 'environment'};
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
 * Write the patch beside the app's own state and return its path, or null when the profile's own
 * defaults should stand. A stable path is deliberate: the owner can read exactly what was applied,
 * and a repeated run rewrites the same file instead of littering.
 */
export function writePatch(directory: string, settings: DshProviderSettings): string | null {
  const text = patchYaml(settings);
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
  keySource: 'settings' | 'environment' | 'none';
  /** One line a person can act on; never contains the key. */
  hint: string;
}

/** What the owner is shown before a run, with no secret in it. */
export function dshStatus(settings: DshProviderSettings, env: NodeJS.ProcessEnv = process.env): DshStatus {
  const {source} = keyEnvironment(settings, env);
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