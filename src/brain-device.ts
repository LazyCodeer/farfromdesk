import { z } from 'zod';
import type { AssistPlan } from './desktop-control.js';
import { toolByName } from './app-tools/packs.js';

/**
 * The owner brain's device vocabulary.
 *
 * One action per message on purpose. A plan states what the owner asked for, so
 * nothing here loops, retries or chains a second guess onto a failed first one:
 * a refused action is reported as refused and the owner decides what happens next.
 */
export const DevicePlan = z.object({
  action: z.enum(['open_app', 'read_window', 'click', 'type', 'press_key', 'app_tool']),
  /**
   * A reviewed app-pack tool (`src/app-tools`). Running one is not a new capability: it is
   * the same driver steps, written down once and named, so a request like "write a note"
   * lands in the note body instead of the search field the owner was shown.
   */
  tool: z.string().min(1).max(80).optional(),
  args: z.record(z.string(), z.string()).optional(),
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
  /** Optional so older fakes and callers keep working; an app tool needs it. */
  packTool?(scope: string, name: string, args: Record<string, string>, authorize?: () => void): Promise<any>;
  /** Optional: the app in front, used only to widen the reviewed-tool shortlist. */
  activeApp?(): Promise<string | undefined>;
};

/** What each action cannot do without. A missing field is a refusal, not a crash. */
export function devicePlanIssue(plan: DevicePlan): string | null {
  if (plan.action === 'app_tool') return plan.tool ? null : 'Which app tool should I use?';
  if (!plan.app) return plan.action === 'press_key' ? 'Which app should I press a key in?' : plan.action === 'open_app' ? 'Which app should I open?' : `Which app should I ${plan.action === 'read_window' ? 'read' : 'use'}?`;
  if (plan.action === 'press_key') return plan.key ? null : 'Which key should I press?';
  if (plan.action === 'type') return plan.text ? null : 'What should I type?';
  if (plan.action === 'click' && !plan.name && !plan.role) return 'What should I click?';
  return null;
}

/**
 * The plan for a bare "write a note ..." with no app named.
 *
 * When the app the owner was last using is Notes, the reviewed Notes tool does it, so the
 * text lands in a note. Any other app keeps the old behaviour: type the owner's own words
 * there. Keeping both paths means the general promise ("write this down where I am") does
 * not silently become Notes-only.
 */
export function notesWritePlan(app: string, body: string): DevicePlan {
  const tool = toolByName('notes_create_note');
  if (tool && app.toLowerCase() === tool.app.toLowerCase()) return { action: 'app_tool', tool: tool.name, app, args: { body } };
  return { action: 'type', app, text: body };
}

/**
 * Bounded, and never the owner's own words. Every running app, including one that has
 * not drawn a titled window yet: hiding it made the model answer "that app is not open"
 * about an app the driver had just opened. An app with no windows is open, not absent.
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
  /**
   * Why a refusal happened, as one of the diagnostic codes. Deliberately not the driver's
   * own words: request events exclude provider and driver text by design, so the owner's
   * reason and the log's reason are two different strings.
   */
  code?: string;
};

/** Classify a driver failure for the event log. Codes only, never the message. */
export function deviceFailureCode(error: unknown): string {
  const text = String((error as Error)?.message ?? error);
  if (/mcp error|connection closed|econn|socket hang|terminated/i.test(text)) return 'driver_unavailable';
  if (/ACCESSIBILITY_PERMISSION_REQUIRED|MAC_CONTROL_DISABLED|SENSITIVE_TARGET/.test(text)) return 'permission_required';
  if (text.startsWith('DESKTOP_APP_NOT_RUNNING')) return 'target_unavailable';
  if (text.startsWith('APP_TOOL_ARGUMENT_MISSING') || text.startsWith('APP_TOOL_ARGUMENT_INVALID')) return 'invalid_arguments';
  if (text.startsWith('DESKTOP_BUSY')) return 'driver_busy';
  if (text.startsWith('DESKTOP_STOPPED')) return 'cancelled';
  return text.startsWith('DESKTOP_NATIVE_REFUSED') ? 'driver_refused' : 'unknown';
}

/**
 * Window chrome. A menu bar holds no page content, and on a browser window its labels
 * were the entire summary the owner received: "Apple; Comet; File; Edit; View; ..." and
 * nothing about the page they asked to see. Only bars whose every descendant is chrome
 * belong here: a scroll area or a splitter wraps the content itself.
 */
const CHROME = /^AX(?:MenuBar|MenuBarItem|Menu|MenuItem|MenuButton|Toolbar)$/;

/**
 * Furniture inside the page: a clock or a counter ("1:13", "PM", "12"), and a control that
 * advertises its keyboard shortcut, which makes it a command rather than content. Measured
 * live on a meeting page, three of eight bullets were the clock and a shortcut.
 */
const NOISE = [/^[\d\s:.,%+/-]+$/, /^\d{1,2}:\d{2}(?:\s*[ap]m)?$/i, /\b(?:ctrl|⌘|cmd|shift|opt|alt)\s*\+/i];

/**
 * Turn the driver's markdown tree into something readable on a phone.
 *
 * Roles, element ids and indentation are dropped: the owner wants the labels, and
 * accessibility vocabulary in a chat message is noise. One label per line, because a
 * semicolon-joined run of fourteen labels is a wall to parse. Order is preserved
 * because it is the only thing that hints at layout.
 *
 * Everything under a chrome row is chrome: a toolbar's Reload button says as little about
 * the page as the menu bar does, and the tree's indentation is what carries that.
 *
 * `skip` is the window title, which the caller's own line already states: measured live,
 * the first bullet of a mail window repeated it, so one of eight slots was spent saying
 * nothing new.
 */
export function summarizeTree(markdown: string, limit = 8, skip?: string | null): string {
  return renderTree(markdown, limit, skip, true) || renderTree(markdown, limit, skip, false);
}

/**
 * The two passes behind `summarizeTree`, and the reason there are two: the chrome rule
 * reads indentation, so a tree that omits the container row between a toolbar subtree and
 * the page subtree would drop the page and leave the owner with "I read Comet." and no
 * content. A silent empty answer is worse than a menu bar, so an empty strict pass falls
 * back to a lenient one that keeps the chrome filter to the bars themselves.
 */
function renderTree(markdown: string, limit: number, skip: string | null | undefined, dropChrome: boolean): string {
  const rows: string[] = [];
  const fold = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const title = fold(String(skip ?? ''));
  let chromeIndent: number | null = null;
  for (const line of String(markdown).split('\n')) {
    // The driver numbers the interactive elements and leaves the plain text rows unnumbered:
    // measured live, a Notes list rendered its note titles as `- AXStaticText = "..."`, so
    // demanding an id marker summarised the ids around the title and dropped the title.
    const match = /^(\s*)-\s*(?:\[\d+\]\s+)?(AX\w+)\s*([\s\S]*)$/.exec(line);
    if (!match) continue;
    const indent = match[1]!.length;
    if (chromeIndent !== null) {
      if (indent > chromeIndent) continue;
      chromeIndent = null;
    }
    if (match[2] === 'AXWindow') continue;   // the caller's line already names the window
    if (CHROME.test(match[2]!)) {
      if (dropChrome) chromeIndent = indent;
      continue;
    }
    // A field carries its label and its value ("Deployment name" = "claude-fable-5-1"). On a
    // phone that becomes one readable line rather than a quoted pair. The driver's markdown
    // can also truncate the closing quote, which is the shape the live tree actually had:
    // `Deployment name" = "claude-fable-5-1`. Both forms lose the quote and the equals sign.
    const pair = /^\s*"([^"]+)"\s*=\s*"([\s\S]*)"\s*$/.exec(match[3]!);
    const label = pair ? `${pair[1]}: ${pair[2]}` : match[3]!
      .replace(/\s*\[actions=.*$/, '')
      .replace(/\s*\((?:[^()]*)\)\s*$/, '')
      .replace(/^[=:]\s*/, '')
      .replace(/"?\s*=\s*"?/g, ': ')
      .replace(/^"|"$/g, '')
      .trim();
    if (label.length < 3) continue;   // "PM", "OK", "1": never page content, always furniture
    if (NOISE.some(pattern => pattern.test(label))) continue;
    // A heading that is the window title again, with the icon the title carries and without:
    // only the containing direction, so a page whose text merely starts with the title stays.
    const folded = fold(label);
    if (title && folded.length > 8 && title.includes(folded)) continue;
    rows.push(label.length > 90 ? label.slice(0, 89).trimEnd() + '...' : label);
  }
  // The label alone is redundant once the same label arrives with its value.
  const trimmed = rows.filter((row, index) => !rows.some((later, at) => at > index && later.startsWith(`${row}: `)));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of trimmed) {
    if (seen.has(row)) continue;
    seen.add(row);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out.map(row => `- ${row}`).join('\n').slice(0, 700);
}

/**
 * Driver text is machine output. A refusal sentence has to be written, not forwarded:
 * measured live, a click that matched nothing read "I could not do that: run_steps:
 * step 1 of 1 failed; 0 step(s) ran before it, 0 not run 1..". So known phrasings become
 * owner words, machine markers become a generic cause, and only plain prose survives as
 * itself.
 */
/** A target the owner named beats a generic sentence: "I could not find "Send" in Comet." */
const MATCHED_NOTHING = 'nothing there matched that name';
/** The cause used when the helper's text is machine output, which is most of the time. */
const NO_CAUSE = 'the helper could not complete it';
const CAUSES: [RegExp, string][] = [
  [/no element|not found|no match|did not match|nothing matched|no such/i, MATCHED_NOTHING],
  [/ambiguous|more than one|multiple/i, 'more than one thing matched, so I did nothing'],
  [/not focused|not front|foreground|background/i, 'the window would not take it in the background'],
  [/denied|refused|not allowed|not permitted/i, 'the helper refused it'],
  [/timed? ?out/i, 'it took too long'],
  [/step \d+ of \d+ failed|\d+ step\(s\)|not run/i, 'the action did not complete'],
];
/**
 * Unrecognized helper text is not forwarded. It is machine output, and the strings it
 * carries are ones `brain-reply` exists to delete: a live failure was reported as
 * "I could not do that in Comet: full read (no usable earlier read of this window to diff
 * against)." A cause from the table above, or a plain refusal, is what the owner gets.
 */
export function plainCause(value: unknown): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return 'the helper did not say why';
  if (/mcp error|desktop_native|desktop_stopped|desktop_busy|\bpid\b|window_id|econn|socket hang/i.test(text)) return NO_CAUSE;
  for (const [pattern, cause] of CAUSES) if (pattern.test(text)) return cause;
  return NO_CAUSE;
}

/**
 * The sentence for a refusal the driver reported, using the owner's own target when that
 * helps. A named target is better than a cause: measured live, a click on a label that does
 * not exist produced the bare "nothing there matched that name", which leaves the owner
 * wondering what was looked for.
 */
export function refusalLine(plan: DevicePlan, message: unknown): string {
  const app = plan.app ?? 'that app';
  const cause = plainCause(message);
  if (cause === MATCHED_NOTHING) {
    if (plan.name) return `I could not find "${plan.name}" in ${app}. Nothing changed.`;
    if (plan.role) return `I could not find that ${plan.role} in ${app}. Nothing changed.`;
  }
  return `I could not do that in ${app}: ${cause}.`;
}

/** One factual sentence. The composer may rephrase it; it may not contradict it. */
export function deviceOutcome(plan: DevicePlan, result: any): DeviceOutcome {
  const app = String(result?.app ?? plan.app ?? 'the app');
  if (plan.action === 'open_app') {
    // The owner asked for an opened app to come forward, so that is the fact to report when
    // the driver confirmed it. Otherwise the honest sentence is what launch reported.
    if (result?.fronted) return { ok: true, line: `Opened ${app} and brought it to the front.`, evidence: null };
    if (result?.windowReady) return { ok: true, line: `Opened ${app}.`, evidence: null };
    if (result?.running) return { ok: true, line: `Opened ${app}. It is running but has not drawn a window yet.`, evidence: null };
    return { ok: false, line: `${app} did not open.`, evidence: null };
  }
  // A reviewed pack tool reports what the driver reported. These are the sentences the pack
  // is allowed to claim; a failure falls through to the refusal path below.
  if (plan.action === 'app_tool' && result?.ok) {
    const tool = plan.tool ?? '';
    if (tool === 'notes_create_note') return { ok: true, line: `Wrote the note in ${app}.`, evidence: null };
    if (tool === 'calendar_create_event') return { ok: true, line: `Added it to ${app}.`, evidence: null };
    if (tool === 'notes_find') {
      const output = String(result?.output ?? '').trim().slice(0, 1000);
      // An empty answer is a fact too, and the owner asked for it, so it is said plainly
      // rather than dressed up as "here is what I found".
      if (!output || /^no note mentions/i.test(output)) return { ok: true, line: `No note in ${app} mentions that.`, evidence: null };
      return { ok: true, line: `Here is what I found in ${app}:`, evidence: output };
    }
    if (tool === 'calendar_list_events') {
      const output = String(result?.output ?? '').trim().slice(0, 1500);
      return { ok: true, line: output ? `Here is ${app}:` : `${app} has nothing on that day.`, evidence: output || null };
    }
    // Every other reviewed tool answers with the sentence its own script produced, and that
    // sentence is where the content is: the note's text, the file it found, the draft it
    // made. Measured live, dropping it is what turned "summarise all my notes" into
    // "Done in Notes." with nothing behind it. A read keeps its app name in front of the
    // answer; a write already names what it did.
    const output = String(result?.output ?? '').trim();
    const reads = toolByName(tool)?.writes === false;
    if (output) {
      const line = reads ? `Here is what is in ${app}:\n${output.slice(0, 1500)}` : output.slice(0, 1500);
      return { ok: true, line, evidence: output.slice(0, 4000) };
    }
    return { ok: true, line: reads ? `${app} has nothing to show for that.` : `Done in ${app}.`, evidence: null };
  }
  if (plan.action === 'read_window') {
    if (!result?.tree) return { ok: false, line: `I could not read ${app}.`, evidence: null };
    return { ok: true, line: `I read ${app}${result?.window ? ` (${result.window})` : ''}.`, evidence: summarizeTree(result.tree, 8, result?.window) || null };
  }
  if (!result?.ok) {
    const raw = result?.observation ?? result?.message ?? '';
    // A failure reported as a result still gets a code that says what kind it was: machine
    // output from the helper means the helper could not complete it, anything else is a
    // refusal the helper chose.
    return { ok: false, line: refusalLine(plan, raw), evidence: null, code: plainCause(raw) === NO_CAUSE ? 'driver_unavailable' : 'driver_refused' };
  }
  const what = plan.action === 'click' ? 'Clicked' : plan.action === 'type' ? 'Typed' : `Pressed ${plan.key}`;
  return { ok: true, line: `${what} in ${app}.`, evidence: result?.changes ?? null };
}

/**
 * A refusal has to name the exact missing grant. "It did not work" sends the owner
 * looking in the wrong place, and the two macOS grants belong to different binaries.
 *
 * The driver's own text never goes through: measured live, a bare keypress refusal read
 * "I could not do that on your Mac: DESKTOP_NATIVE_REFUSED: [{"type":"text","text":...}]".
 */
export function deviceRefusal(error: unknown): string {
  const message = String((error as Error)?.message ?? error);
  if (message.startsWith('ACCESSIBILITY_PERMISSION_REQUIRED')) return 'I cannot control apps yet: Accessibility is not granted to FarFromDesk Local. Open Settings, Remote control, allow Accessibility, then ask me again.';
  if (message.startsWith('MAC_CONTROL_DISABLED')) return 'Desktop control is switched off in Settings. Turn on Remote control, then ask me again.';
  if (message.startsWith('SENSITIVE_TARGET')) return 'I am not allowed to drive System Settings, keychain or password apps.';
  if (message.startsWith('APP_TOOL_UNKNOWN')) return 'I do not have a reviewed tool for that app action yet, so I did nothing.';
  if (message.startsWith('APP_TOOL_ARGUMENT_MISSING')) return `I need one more detail before I can do that: ${message.slice('APP_TOOL_ARGUMENT_MISSING: '.length)}`;
  if (message.startsWith('APP_TOOL_ARGUMENT_INVALID')) return `I could not use those details, so I did nothing: ${message.slice('APP_TOOL_ARGUMENT_INVALID: '.length)}`;
  if (message.startsWith('AUTOMATION_PERMISSION_REQUIRED')) return message.slice('AUTOMATION_PERMISSION_REQUIRED: '.length) || 'macOS needs your permission before I can control that app.';
  if (message.startsWith('APP_TOOL_HELPER_MISSING')) return message.slice('APP_TOOL_HELPER_MISSING: '.length);
  if (message.startsWith('APP_TOOL_FAILED')) return `I could not do that: ${plainCause(message.slice('APP_TOOL_FAILED:'.length))}.`;
  if (message.startsWith('DESKTOP_APP_NOT_RUNNING')) return 'That app has no open window right now, so there is nothing to act on yet.';
  if (message.startsWith('DESKTOP_MACOS_ONLY')) return 'I can only control apps on macOS.';
  if (message.startsWith('DESKTOP_BUSY')) return 'I am already doing something on your Mac. Let that finish, then ask me again.';
  if (message.startsWith('DESKTOP_STOPPED')) return 'I stopped that action. Nothing else was tried.';
  if (/mcp error|connection closed|\beconn|socket hang|network|terminated/i.test(message)) return 'I lost the connection to the desktop helper just then, so I cannot say what happened. Check the app, then ask me again.';
  if (message.startsWith('DESKTOP_NATIVE_REFUSED')) return `I could not do that: ${plainCause(message.slice('DESKTOP_NATIVE_REFUSED:'.length))}.`;
  return `I could not do that on your Mac: ${plainCause(message)}.`;
}

/** Execute one plan and report facts, never a claim the driver did not make. */
export async function runDevicePlan(control: DeviceControl, plan: DevicePlan, scope: string, authorize: () => void): Promise<DeviceOutcome> {
  const issue = devicePlanIssue(plan);
  if (issue) return { ok: false, line: issue, evidence: null };
  if (plan.action === 'app_tool') {
    if (!control.packTool) return { ok: false, line: 'I can only run that through the desktop helper, and it is not available right now.', evidence: null, code: 'driver_unavailable' };
    try {
      const result = await control.packTool(scope, plan.tool!, plan.args ?? {}, authorize);
      return deviceOutcome(plan, result);
    } catch (error) {
      return { ok: false, line: deviceRefusal(error), evidence: null, code: deviceFailureCode(error) };
    }
  }
  const assist: AssistPlan = { action: plan.action, ...(plan.app ? { app: plan.app } : {}), ...(plan.window ? { window: plan.window } : {}), ...(plan.role ? { role: plan.role } : {}), ...(plan.name ? { name: plan.name } : {}), ...(plan.text ? { text: plan.text } : {}), ...(plan.key ? { key: plan.key } : {}) };
  try {
    const result = await control.assist(scope, assist, authorize);
    return deviceOutcome(plan, result);
  } catch (error) {
    // The owner gets a sentence and a code; the driver's own words stay out of both the
    // message and the event log.
    const message = String((error as Error)?.message ?? error);
    // A native refusal is the driver declining a named target, so the owner's own words give
    // the most useful sentence. A grant failure still names the switch to flip instead.
    const line = message.startsWith('DESKTOP_NATIVE_REFUSED') ? refusalLine(plan, message.slice('DESKTOP_NATIVE_REFUSED:'.length)) : deviceRefusal(error);
    return { ok: false, line, evidence: null, code: deviceFailureCode(error) };
  }
}
/**
 * Deterministic device commands.
 *
 * Measured: "open Comet" was classified correctly while "press escape in Comet" was
 * classified as coding work and turned into a task-contract review, so the model's
 * intent choice is the unreliable part. An explicit device verb on an app that is open
 * right now needs no classification at all, so this decides it in code, before the
 * model is asked, and the model is never consulted for it.
 *
 * Deliberately conservative: the app must match the live target list exactly after
 * filler is removed. "open the PR" does not match, so it still goes to the model rather
 * than being hijacked. An app that is running without a titled window IS a target: it used
 * to be dropped from the list, and "open Notes" was then left to the model.
 */
const FILLER = /\b(?:right now|at the moment|currently|for me|please|now|the)\b/g;
const tidy = (value: string) => value.toLowerCase().replace(/[.!?,;:]+$/, '').replace(FILLER, ' ').replace(/\s+/g, ' ').trim();

const PATTERNS: { action: DevicePlan['action']; pattern: RegExp }[] = [
  { action: 'press_key', pattern: /^(?:press|hit) (return|enter|escape|esc|tab|up|down|left|right)(?: (?:in|on) (.+))?$/i },
  { action: 'type', pattern: /^(?:type|enter|write) (.+?) (?:in|into|on) (.+)$/i },
  { action: 'click', pattern: /^(?:click|press|tap|hit) (.+?) (?:in|on) (.+)$/i },
  { action: 'read_window', pattern: /^(?:read|show me|what(?:'s| is) (?:in|on)) (.+)$/i },
  { action: 'open_app', pattern: /^(?:open|launch|start|switch to|go to|focus) (.+)$/i },
];
const KEYS: Record<string, string> = { enter: 'return', esc: 'escape' };
/**
 * Politeness, not content.
 *
 * The owner writes "Could you open notes" as often as "Open Notes". Measured live on
 * 2026-11-03: that exact sentence was not device-shaped, so `claimsDevice` said no and a
 * pending coding contract re-sent its review card instead of opening the app. A lead-in made
 * only of courtesies and filler is removed before the shapes are matched. Nothing that
 * carries meaning is in this list, so "open the PR" keeps its shape and then fails the
 * live-target check, which is what keeps coding requests out.
 */
const LEAD_IN = /^(?:(?:could|can|would|will|please|pls|kindly|hey|hi|hello|ok|okay|now|then|also|and|you|u)\b[,\s]+)+/i;
export function stripLeadIn(text: string): string {
  return text.trim().replace(LEAD_IN, '').trim();
}

/** Cheap shape test, no driver call: does this message open like a Mac action? */
export function deviceVerbLike(text: string): boolean {
  const raw = stripLeadIn(text);
  if (!raw || raw.startsWith('/') || raw.length > 200) return false;
  return PATTERNS.some(({ pattern }) => pattern.test(raw));
}

/**
 * Shapes that must never reach the coding-task classifier even though no plan can be
 * built from them yet.
 *
 * Measured live on 2026-11-03. "Show me opened apps" is device-shaped but resolves to no
 * plan, so `claimsDevice` said no and the task-contract flow claimed it, answering
 * "I could not update the contract" twice in a row while a contract was pending. "Write a
 * notes about tomorrow meeting" is not device-shaped at all, so the same classifier turned
 * an app request into a code review. Both are device turns however the app list is read.
 */
const APP_INVENTORY = /^(?:please\s+)?(?:show|list|what(?:'s| is| are)?|which)(?:\s+me)?(?:\s+(?:all|any|the|my|open|opened|running|available))*\s*(?:apps?|applications?)(?:\s+(?:are|is))?(?:\s+[a-z]+)*[?.!]?$/i;
// Deliberately narrow: "add", "save", "create" and "record" open coding tasks far more
// often than they write into an app, and a coding task must keep its contract review.
const AUTHORING = /^(?:(?:now|then|also|please|ok|okay|and)\s+)*(?:write|type|enter|note|jot|dictate|append)\b/i;

/** "show me opened apps", "list apps", "what apps are open": an inventory, not a task. */
export function appInventoryRequest(text: string): boolean {
  const raw = stripLeadIn(text);
  if (!raw || raw.startsWith('/') || raw.length > 200) return false;
  return APP_INVENTORY.test(raw);
}

/**
 * A request to put text somewhere. On its own it names no app, so the caller decides
 * whether the owner has just used one; only then is it answerable as a device action.
 */
export function authoringRequest(text: string): boolean {
  const raw = stripLeadIn(text);
  if (!raw || raw.startsWith('/') || raw.length > 200) return false;
  return AUTHORING.test(raw);
}

/**
 * The one bare-write shape that is claimed as a device turn: the owner names a note as
 * where the text goes.
 *
 * "write the failing test" is authoring and coding work at once. Only "notes" tells them
 * apart, so only that reaches the Mac without an app name; everything else keeps the
 * contract review it had before.
 */
export function notesAuthoringRequest(text: string): boolean {
  return authoringRequest(text) && /\bnotes?\b/i.test(text);
}

/**
 * The text a bare "write ..." asks to put into the app the owner just used, with the verb
 * and the filler removed. Kept literal: the owner's own words and typos are what they
 * asked to be written, so nothing here rewrites them.
 */
export function authoringText(text: string): string | undefined {
  const raw = stripLeadIn(text)
    .replace(/^(?:(?:now|then|also|please|ok|okay|and)\s+)*(?:write|type|enter|notes|note|jot|dictate|append)\b\s*/i, '')
    .replace(/^down\s+/i, '')
    .replace(/^(?:(?:a|an|the)\s+)?(?:notes|note)\s*(?:about|that|saying|to say|:)?\s*/i, '')
    .replace(/^(?:that\s+|:\s*)/i, '')
    .trim();
  return raw ? raw.slice(0, 1200) : undefined;
}

export function detectDevicePlan(text: string, targets: { name: string }[]): DevicePlan | null {
  const raw = stripLeadIn(text);
  if (!raw || raw.startsWith('/') || raw.length > 200) return null;
  const known = (value: string) => targets.find(x => tidy(x.name) === tidy(value))?.name;
  for (const { action, pattern } of PATTERNS) {
    // Exec against the owner's text, not a lowercased copy, so a clicked label keeps its case.
    const match = pattern.exec(raw);
    if (!match) continue;
    if (action === 'press_key') {
      const app = match[2] ? known(match[2]) : undefined;
      if (!app) return null;
      return { action, app, key: (KEYS[match[1]] ?? match[1]) as DevicePlan['key'] };
    }
    if (action === 'read_window' || action === 'open_app') {
      const app = known(match[1]);
      return app ? { action, app } : null;
    }
    const app = known(match[2]);
    if (!app) return null;
    return action === 'click' ? { action, app, name: match[1].trim().slice(0, 160) } : { action, app, text: match[1].trim().slice(0, 1200) };
  }
  return null;
}
