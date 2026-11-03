import { z } from 'zod';
import type { AssistPlan } from './desktop-control.js';

/**
 * The owner brain's device vocabulary.
 *
 * One action per message on purpose. A plan states what the owner asked for, so
 * nothing here loops, retries or chains a second guess onto a failed first one:
 * a refused action is reported as refused and the owner decides what happens next.
 */
export const DevicePlan = z.object({
  action: z.enum(['open_app', 'read_window', 'click', 'type', 'press_key']),
  app: z.string().min(1).max(120).optional(),
  window: z.string().max(160).optional(),
  role: z.string().max(40).optional(),
  name: z.string().max(160).optional(),
  text: z.string().max(1200).refine(v => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v), 'Control characters are not supported').optional(),
  key: z.enum(['return', 'tab', 'escape', 'up', 'down', 'left', 'right']).optional(),
}).strict();
export type DevicePlan = z.infer<typeof DevicePlan>;

/** Structural slice this module needs, so tests inject a fake and never a driver. */
export type DeviceControl = {
  assist(scope: string, plan: AssistPlan, authorize?: () => void): Promise<any>;
  targets(maxAgeMs?: number): Promise<{ name: string; bundleId: string; windows: string[] }[]>;
};

/** What each action cannot do without. A missing field is a refusal, not a crash. */
export function devicePlanIssue(plan: DevicePlan): string | null {
  if (!plan.app) return plan.action === 'press_key' ? 'Which app should I press a key in?' : plan.action === 'open_app' ? 'Which app should I open?' : `Which app should I ${plan.action === 'read_window' ? 'read' : 'use'}?`;
  if (plan.action === 'press_key') return plan.key ? null : 'Which key should I press?';
  if (plan.action === 'type') return plan.text ? null : 'What should I type?';
  if (plan.action === 'click' && !plan.name && !plan.role) return 'What should I click?';
  return null;
}

/**
 * Bounded, and never the owner's own words. Only what has a window right now, so
 * the model names something that exists instead of guessing.
 */
export async function deviceTargets(control: DeviceControl): Promise<{ name: string; bundleId: string; windows: string[] }[]> {
  return await control.targets(10000).catch(() => []);
}

export type DeviceOutcome = {
  ok: boolean;
  /** Deterministic, factual, and true whatever the model says afterwards. */
  line: string;
  /** Evidence for the composer: what was read, or what changed. */
  evidence: string | null;
};

/**
 * Turn the driver's markdown tree into something readable on a phone.
 *
 * Roles, element ids and indentation are dropped: the owner wants the labels, and
 * accessibility vocabulary in a chat message is noise. Order is preserved because
 * it is the only thing that hints at layout.
 */
export function summarizeTree(markdown: string, limit = 14): string {
  const rows = String(markdown).split('\n')
    .map(line => line.replace(/^\s*-\s*\[\d+\]\s*/, '').trim())
    .filter(line => line && !/^AX(Group|Unknown|Splitter|Window)\b/.test(line))
    .map(line => line.replace(/^AX\w+\s*/, '').replace(/\s*\[actions=.*$/, '').replace(/\s*\(.*\)$/, '').replace(/^"|"$/g, '').trim())
    .filter(line => line.length > 1);
  const seen = new Set<string>(); const out: string[] = [];
  for (const row of rows) { if (seen.has(row)) continue; seen.add(row); out.push(row); if (out.length >= limit) break; }
  return out.join('; ').slice(0, 700);
}

/** One factual sentence. The composer may rephrase it; it may not contradict it. */
export function deviceOutcome(plan: DevicePlan, result: any): DeviceOutcome {
  const app = String(result?.app ?? plan.app ?? 'the app');
  if (plan.action === 'open_app') {
    if (result?.windowReady) return { ok: true, line: `Opened ${app}.`, evidence: null };
    if (result?.running) return { ok: true, line: `Opened ${app}. It is running but has not drawn a window yet.`, evidence: null };
    return { ok: false, line: `${app} did not open.`, evidence: null };
  }
  if (plan.action === 'read_window') {
    if (!result?.tree) return { ok: false, line: `I could not read ${app}.`, evidence: null };
    return { ok: true, line: `I read ${app}${result?.window ? ` (${result.window})` : ''}.`, evidence: summarizeTree(result.tree) };
  }
  if (!result?.ok) return { ok: false, line: `I could not do that in ${app}: ${result?.observation ?? 'the driver refused it'}.`, evidence: result?.diff ?? null };
  const what = plan.action === 'click' ? 'Clicked' : plan.action === 'type' ? 'Typed' : `Pressed ${plan.key}`;
  return { ok: true, line: `${what} in ${app}.`, evidence: result?.diff ?? result?.observation ?? null };
}

/**
 * A refusal has to name the exact missing grant. "It did not work" sends the owner
 * looking in the wrong place, and the two macOS grants belong to different binaries.
 */
export function deviceRefusal(error: unknown): string {
  const message = String((error as Error)?.message ?? error);
  if (message.startsWith('ACCESSIBILITY_PERMISSION_REQUIRED')) return 'I cannot control apps yet: Accessibility is not granted to FarFromDesk Local. Open Settings, Remote control, allow Accessibility, then ask me again.';
  if (message.startsWith('MAC_CONTROL_DISABLED')) return 'Desktop control is switched off in Settings. Turn on Remote control, then ask me again.';
  if (message.startsWith('SENSITIVE_TARGET')) return 'I am not allowed to drive System Settings, keychain or password apps.';
  if (message.startsWith('DESKTOP_APP_NOT_RUNNING')) return 'That app is running but has no open window, so there is nothing to read yet.';
  if (message.startsWith('DESKTOP_MACOS_ONLY')) return 'I can only control apps on macOS.';
  return `I could not do that on your Mac: ${message.slice(0, 200)}`;
}

/** Execute one plan and report facts, never a claim the driver did not make. */
export async function runDevicePlan(control: DeviceControl, plan: DevicePlan, scope: string, authorize: () => void): Promise<DeviceOutcome> {
  const issue = devicePlanIssue(plan);
  if (issue) return { ok: false, line: issue, evidence: null };
  const assist: AssistPlan = { action: plan.action, ...(plan.app ? { app: plan.app } : {}), ...(plan.window ? { window: plan.window } : {}), ...(plan.role ? { role: plan.role } : {}), ...(plan.name ? { name: plan.name } : {}), ...(plan.text ? { text: plan.text } : {}), ...(plan.key ? { key: plan.key } : {}) };
  try {
    const result = await control.assist(scope, assist, authorize);
    return deviceOutcome(plan, result);
  } catch (error) {
    return { ok: false, line: deviceRefusal(error), evidence: null };
  }
}