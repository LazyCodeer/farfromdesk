import type { AppTool, AppToolArg, AppToolPlan } from '../types.js';
import { EVENTKIT_HELPER } from '../adapters/eventkit.js';

/**
 * Shared pieces of the Windows packs.
 *
 * The Windows packs reuse the macOS packs wherever the owner-facing contract is the same: the
 * tool name, its arguments, its examples and, above all, its argument checks and refusal
 * sentences. Only the engine changes. A macOS plan is one of three things here:
 *   - a refusal (`return "<sentence>"` in AppleScript) becomes a `text` plan, so the owner gets
 *     the same sentence without anything being started;
 *   - an EventKit helper call becomes the same argument array sent to the Windows helper's
 *     `eventkit` operation, which answers Calendar and Reminders from Outlook in EventKit's JSON
 *     shape, so the macOS formatters read it unchanged;
 *   - anything else has no Windows engine and is never offered (see `packs.ts`).
 */

/** The bundled script under `native/` that every `windows` plan runs. */
export const WINDOWS_HELPER = 'app-tools-windows.ps1';

/** Outlook and OneNote can take a few seconds to start in the background the first time. */
export const WINDOWS_TIMEOUT_MS = 45000;

export function say(text: string): AppToolPlan {
  return { kind: 'text', text };
}

export function win(op: string, payload: Record<string, unknown>, options: { timeoutMs?: number; outputChars?: number; format?: (raw: string) => string } = {}): AppToolPlan {
  return { kind: 'windows', op, payload, timeoutMs: options.timeoutMs ?? WINDOWS_TIMEOUT_MS, outputChars: options.outputChars, format: options.format };
}

/** The sentence inside a one-line AppleScript refusal, or undefined when the plan is real work. */
export function refusalText(plan: AppToolPlan): string | undefined {
  if (plan.kind === 'text') return plan.text;
  if (plan.kind !== 'osascript') return undefined;
  const match = /^return "((?:[^"\\]|\\.)*)"\s*$/.exec(plan.script);
  return match ? match[1].replace(/\\(.)/g, '$1') : undefined;
}

/** A macOS plan, carried over to Windows. Throws for a plan that has no Windows engine. */
export function onWindows(plan: AppToolPlan): AppToolPlan {
  const refusal = refusalText(plan);
  if (refusal !== undefined) return say(refusal);
  if (plan.kind === 'windows' || plan.kind === 'local') return plan;
  if (plan.kind === 'cli' && plan.binary === EVENTKIT_HELPER) {
    return win('eventkit', { argv: plan.args }, { timeoutMs: Math.max(plan.timeoutMs ?? 0, WINDOWS_TIMEOUT_MS), outputChars: plan.outputChars, format: plan.format });
  }
  throw new Error('That step has no Windows version yet, so nothing was done.');
}

/**
 * Runs the macOS plan only for its checks: when it refuses, the refusal is the answer; when it
 * would do real work, the Windows plan is built instead. A malformed argument still throws, so
 * packTool reports it exactly as it does on macOS.
 */
export function checked(mac: AppTool, args: Record<string, string>, build: () => AppToolPlan): AppToolPlan {
  const refusal = refusalText(mac.plan(args));
  return refusal !== undefined ? say(refusal) : build();
}

/** Plain string replacement over a tool's owner-facing text. */
export function reword(text: string, pairs: [string | RegExp, string][]): string {
  return pairs.reduce((out, [from, to]) => out.replace(typeof from === 'string' ? new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : from, to), text);
}

/** The macOS tool with a Windows app name, wording and plan. Name, arguments and examples stay. */
export function retarget(mac: AppTool, change: { app: string; pairs?: [string | RegExp, string][]; description?: string; args?: AppToolArg[]; plan?: (args: Record<string, string>) => AppToolPlan; extraKeywords?: string[] }): AppTool {
  const pairs = change.pairs ?? [];
  const { bundleId: _drop, ...rest } = mac;
  return {
    ...rest,
    app: change.app,
    description: change.description ?? reword(mac.description, pairs),
    args: change.args ?? mac.args.map(arg => ({ ...arg, description: reword(arg.description, pairs) })),
    keywords: [...mac.keywords, ...(change.extraKeywords ?? [])],
    plan: change.plan ?? (args => onWindows(mac.plan(args))),
  };
}

/** A whole positive number, clamped, or undefined when it is not one. */
export function wholeNumber(value: unknown, fallback: number, max: number): number | undefined {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1) return undefined;
  return Math.min(n, max);
}

/**
 * The app in front, in the names the Windows tools use. A window reports its program's own
 * description ("Microsoft Outlook", "Windows Explorer"), and the shortlist matches the app in front
 * against a tool's app by name, so the two have to agree.
 */
export function windowsToolApp(app: string, process?: string): string | undefined {
  const name = String(app ?? '').trim();
  const exe = String(process ?? '').trim().toLowerCase();
  if (exe === 'outlook' || /^(microsoft )?outlook$/i.test(name)) return 'Outlook';
  if (exe === 'onenote' || /^(microsoft )?onenote/i.test(name)) return 'OneNote';
  if (exe === 'explorer' || /^(windows|file) explorer$/i.test(name)) return 'File Explorer';
  if (/^(spotify|zune|microsoft\.media\.player|wmplayer)$/.test(exe) || /^(spotify|media player|windows media player)$/i.test(name)) return 'Media';
  return name || undefined;
}
