/**
 * Per-app tool packs.
 *
 * A pack is a small, reviewed set of deterministic tools for one app. The point is that the
 * exact click, the exact menu item and the exact field are written down once, with the reason
 * they are written that way, instead of being rediscovered from the accessibility tree on
 * every request. Measured on 2026-11-03: "write a notes about tomorrow meeting" typed into
 * the Notes *search field* and the owner was told it was typed into Notes.
 *
 * Descriptions follow what the tool-selection research says actually moves accuracy:
 * three to five sentences covering what it does, when to use it, when NOT to use it, and what
 * it returns. They are also the text the retrieval index embeds, so they must contain the
 * owner's vocabulary ("note it down", "put it on my calendar"), not API vocabulary.
 */

/** How a tool is executed. Kept declarative so it can be tested without touching an app. */
export type AppToolPlan =
  /** Accessibility steps run against the app's window by the desktop driver. */
  | { kind: 'steps'; steps: Record<string, unknown>[] }
  /** An AppleScript program. Needs Automation consent for the app, once. */
  | { kind: 'osascript'; script: string; outputChars?: number }
  /**
   * A bundled, code-signed helper under the app's `Resources/backend/native/`, run with an
   * argument array (never a shell string). Used where a scripting dictionary cannot reach the
   * data: EventKit for Calendar and Reminders.
   *
   * The helper answers in JSON, so the plan may carry a `format` that turns that JSON into the
   * readable lines the model is given. Parsing lives in `src/app-tools/adapters/<app>.ts` and
   * must never throw: a reply it cannot read becomes a sentence, the same way a refusal does.
   */
  | {
      kind: 'cli';
      binary: string;
      args: string[];
      timeoutMs?: number;
      outputChars?: number;
      format?: (raw: string) => string;
    }
  /**
   * Windows: one operation of the bundled `native/app-tools-windows.ps1`, which reaches Outlook
   * and OneNote over COM and the system media controls over WinRT. The payload is JSON, passed
   * as base64 so no shell or quoting ever sees owner text. `format` works as it does for `cli`.
   */
  | {
      kind: 'windows';
      op: string;
      payload: Record<string, unknown>;
      timeoutMs?: number;
      outputChars?: number;
      format?: (raw: string) => string;
    }
  /** Work done in this process (file listings over Node's fs). Never spawns a shell. */
  | { kind: 'local'; run: (signal: AbortSignal) => Promise<string>; outputChars?: number }
  /** A sentence and nothing else: a refusal decided before any app is touched. */
  | { kind: 'text'; text: string };

export interface AppToolArg {
  name: string;
  /** One line. Written for the model, not for a programmer. */
  description: string;
  required?: boolean;
}

export interface AppTool {
  /** App-prefixed snake_case, so similar tools never look alike: `notes_create_note`. */
  name: string;
  /** Pack id: `notes`, `calendar`, ... */
  pack: string;
  /** Display name of the app the tool acts on. */
  app: string;
  bundleId?: string;
  description: string;
  args: AppToolArg[];
  /** Real owner phrasings. They are embedded with the description. */
  examples: string[];
  /** Extra retrieval vocabulary: synonyms and the words the owner actually types. */
  keywords: string[];
  /**
   * Requests this tool must never be offered for.
   *
   * A near-miss is expensive in a way a plain miss is not: measured live on 2026-11-03, the
   * only Notes tool left was "create a note", and "find my note about the roof" shares the
   * words note and roof with it. Writing a second note when the owner asked to find the first
   * is a wrong write, not a wrong answer. Each phrase is matched as a set of its meaningful
   * words, so "find my note" also covers "find the note about the roof".
   */
  notFor?: string[];
  /**
   * True when the tool changes something the owner would have to undo by hand. The caller
   * decides what that means for confirmation; the pack only declares it.
   */
  writes: boolean;
  plan: (args: Record<string, string>) => AppToolPlan;
}

export interface AppPack {
  id: string;
  app: string;
  bundleId?: string;
  /** Who the pack is for, in one line, shown when the owner asks what it can do. */
  summary: string;
  tools: AppTool[];
}