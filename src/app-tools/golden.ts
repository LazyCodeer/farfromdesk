import type { AppTool } from './types.js';

/**
 * The utterances retrieval is measured against.
 *
 * Every entry is either a sentence the owner actually sent (the live companion transcripts of
 * 3 November 2026), a sentence in the same shape, or a coding request that must not pick up a
 * Mac tool. It is deliberately small while there are four tools, and it grows with the packs:
 * a golden set that is never read is decoration, so `test/app-tools-retrieval.test.ts` fails
 * the build when recall drops.
 */
export type GoldenUtterance = {
  text: string;
  /** The app in front when the owner said it, when that is known. */
  app?: string;
  /** The tool that must be chosen, or null when nothing should be. */
  tool: string | null;
  /** Why this entry is here. */
  note: string;
};

export const GOLDEN: GoldenUtterance[] = [
  // Live: "Write a notes about tomorrow meeting at 10pm woth ashitosh"
  { text: 'Write a notes about tomorrow meeting at 10pm woth ashitosh', tool: 'notes_create_note', note: 'live transcript' },
  { text: 'write a note that the roof is leaking', tool: 'notes_create_note', note: 'plain ask' },
  { text: 'Could you write a note that the roof is leaking', tool: 'notes_create_note', note: 'courteous lead-in' },
  { text: 'jot this in notes: call the plumber on monday', tool: 'notes_create_note', note: 'pack named' },
  { text: 'now write the notes', app: 'Notes', tool: 'notes_create_note', note: 'live transcript, app in front' },
  { text: 'note that the roof is leaking', tool: 'notes_create_note', note: 'no app named, note named' },

  // These were quiet while finding a note had no reviewed tool: the failed search sequence typed
  // into the open note body on 2026-11-03 and the note's text had to be put back by hand, so the
  // tool was removed rather than shipped. `notes_find` reads through AppleScript and touches no
  // keystroke, so they expect it now. The other half of the rule still holds in each entry: the
  // answer must never be a second note.
  { text: 'find my note about the roof', tool: 'notes_find', note: 'read-only search; must not create a note' },
  { text: 'look for the note with the plumber number', tool: 'notes_find', note: 'read-only search; must not create a note' },
  { text: 'search my notes for the invoice', tool: 'notes_find', note: 'read-only search; must not create a note' },

  { text: 'put a meeting on my calendar tomorrow at 5', tool: 'calendar_create_event', note: 'pack named' },
  { text: 'add a meeting with ashitosh tomorrow at 5pm', app: 'Calendar', tool: 'calendar_create_event', note: 'live transcript, app in front' },
  { text: 'schedule a call at 9 tomorrow morning', tool: 'calendar_create_event', note: 'plain ask' },

  { text: 'what is coming up this week', app: 'Calendar', tool: 'calendar_list_events', note: 'app in front' },
  { text: 'am I free tomorrow', app: 'Calendar', tool: 'calendar_list_events', note: 'app in front' },
  { text: 'what is on my calendar today', tool: 'calendar_list_events', note: 'pack named' },

  // Coding work shares the verbs ("add", "write", "create", "show") and must stay out.
  { text: 'fix the failing unit test', tool: null, note: 'coding request' },
  { text: 'add a retry to the sync loop', tool: null, note: 'coding request' },
  { text: 'add a retry to the sync loop', app: 'Cursor', tool: null, note: 'coding request, coding app in front' },
  { text: 'add a checks column to task_contracts', tool: null, note: 'coding request' },
  { text: 'where is the router contract code', tool: null, note: 'coding request' },
  { text: 'write the failing test', tool: null, note: 'coding write, no note named' },
  { text: 'create a new session for this', tool: null, note: 'coding request' },
  { text: 'open the PR', tool: null, note: 'looks like open_app, resolves to nothing' },
  { text: 'add a dark theme to the settings page', tool: null, note: 'coding request' },
  { text: 'notes', tool: null, note: 'a bare app name is not a request' },
  { text: 'add oat milk to my reminders', tool: 'reminders_add', note: 'names the app' },
  { text: 'put call the plumber on my reminders list for friday at 9am', tool: 'reminders_add', note: 'names the list it belongs in' },
  { text: 'what reminders do i have open', tool: 'reminders_list', note: 'asks for the lists, not for one reminder' },
];

/** The tool names the set refers to, for a pack-coverage check. */
export function goldenToolNames(golden: GoldenUtterance[] = GOLDEN): string[] {
  return [...new Set(golden.map(entry => entry.tool).filter((name): name is string => Boolean(name)))];
}

/** Every pack tool should appear in the set at least once. */
export function uncoveredTools(tools: AppTool[], golden: GoldenUtterance[] = GOLDEN): string[] {
  const covered = new Set(goldenToolNames(golden));
  return tools.map(tool => tool.name).filter(name => !covered.has(name));
}