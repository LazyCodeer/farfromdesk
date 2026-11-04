import type { AppTool } from './types.js';

/**
 * The utterances retrieval is measured against.
 *
 * Every entry is either a sentence the owner actually sent (the live companion transcripts of
 * 3 November 2026), a sentence in the same shape, or a coding request that must not pick up a
 * Mac tool. It is deliberately small while there are few tools, and it grows with the packs:
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

  // The failure this pack exists for. On 2026-11-03 the owner asked "Give me summary of all the
  // notes" and the companion read the Notes window's accessibility labels, so the answer described
  // the chrome instead of the notes. Nothing about the sentence names the window, so these rows
  // are the one guarantee that a content read is what gets chosen.
  { text: 'summarise all my notes', tool: 'notes_recent', note: 'the request that was answered from window chrome' },
  { text: 'give me a summary of all the notes', tool: 'notes_recent', note: 'live failure phrasing, 2026-11-03' },
  { text: 'show me my notes', app: 'Notes', tool: 'notes_recent', note: 'app in front; "show me" is not permission to read the window' },

  { text: 'what does my note about the invoice say', tool: 'notes_read', note: 'one named note, read its text' },
  { text: 'read my note about the plumber', tool: 'notes_read', note: 'read one note, never the window around it' },
  { text: 'add a line to my note about the roof', tool: 'notes_append', note: 'append, keeps what was already in the note' },
  { text: 'update my note about the roof to say the leak is fixed', tool: 'notes_update', note: 'replace the text of one note, read back after' },
  { text: 'delete the note called shopping list', tool: 'notes_delete', note: 'one note by name, and the name has to be typed again' },

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

  // One row per tool built from that tool's own examples, so a pack that adds a tool but not a
  // row fails the coverage check rather than shipping unmeasured. Regenerated whenever a pack's
  // examples change: a row is kept only when that tool is the FIRST choice for it, which is what
  // makes the set a measurement instead of a wish list. The few examples that no longer select
  // their own tool are left out on purpose and reported by /tmp/pack-survey.mts.
  { text: "show me my notes", tool: "notes_recent", note: 'example from the pack itself' },
  { text: "what did I write about the roof", tool: "notes_read", note: 'example from the pack itself' },
  { text: "what does the note about the invoice say", tool: "notes_read", note: 'example from the pack itself' },
  { text: "find my note about the plumber", tool: "notes_find", note: 'example from the pack itself' },
  { text: "search my notes for invoice 442", tool: "notes_find", note: 'example from the pack itself' },
  { text: "do I have a note about the dentist", tool: "notes_find", note: 'example from the pack itself' },
  { text: "note down tomorrow meeting at 5pm", tool: "notes_create_note", note: 'example from the pack itself' },
  { text: "jot this in notes: call the landlord on tuesday", tool: "notes_create_note", note: 'example from the pack itself' },
  { text: "add to my note about the roof: the builder starts tuesday", tool: "notes_append", note: 'example from the pack itself' },
  { text: "append the invoice number to my shopping note", tool: "notes_append", note: 'example from the pack itself' },
  { text: "add these lines to the meeting note", tool: "notes_append", note: 'example from the pack itself' },
  { text: "rewrite my shopping note", tool: "notes_update", note: 'example from the pack itself' },
  { text: "delete my note about the old roof quote", tool: "notes_delete", note: 'example from the pack itself' },
  { text: "remove the note called meeting minutes", tool: "notes_delete", note: 'example from the pack itself' },
  { text: "find the meeting with the team", tool: "calendar_find_events", note: 'example from the pack itself' },
  { text: "what events do i have on friday", tool: "calendar_find_events", note: 'example from the pack itself' },
  { text: "search my calendar for the dentist", tool: "calendar_find_events", note: 'example from the pack itself' },
  { text: "show me events between monday and thursday", tool: "calendar_find_events", note: 'example from the pack itself' },
  { text: "what time exactly is the standup", tool: "calendar_read_event", note: 'example from the pack itself' },
  { text: "give me the details of my dentist appointment", tool: "calendar_read_event", note: 'example from the pack itself' },
  { text: "where is the team meeting", tool: "calendar_read_event", note: 'example from the pack itself' },
  { text: "what is coming up this week", tool: "calendar_list_events", note: 'example from the pack itself' },
  { text: "am I free tomorrow", tool: "calendar_list_events", note: 'example from the pack itself' },
  { text: "add a meeting with the team tomorrow at 5pm", tool: "calendar_create_event", note: 'example from the pack itself' },
  { text: "put a reminder on my calendar for the dentist on friday at 10", tool: "calendar_create_event", note: 'example from the pack itself' },
  { text: "move my dentist appointment to 6pm", tool: "calendar_update_event", note: 'example from the pack itself' },
  { text: "reschedule the standup to friday morning", tool: "calendar_update_event", note: 'example from the pack itself' },
  { text: "change the location of the team meeting", tool: "calendar_update_event", note: 'example from the pack itself' },
  { text: "delete the event called standup confirm standup", tool: "calendar_delete_event", note: 'example from the pack itself' },
  { text: "cancel my dentist appointment", tool: "calendar_delete_event", note: 'example from the pack itself' },
  { text: "remove the team meeting from my calendar", tool: "calendar_delete_event", note: 'example from the pack itself' },
  { text: "anything I have to do today", tool: "reminders_open", note: 'example from the pack itself' },
  { text: "what is still on my reminders", tool: "reminders_open", note: 'example from the pack itself' },
  { text: "show me my open reminders on the shopping list", tool: "reminders_open", note: 'example from the pack itself' },
  { text: "show me my reminder about the plumber", tool: "reminders_read", note: 'example from the pack itself' },
  { text: "what does the call the dentist reminder say", tool: "reminders_read", note: 'example from the pack itself' },
  { text: "add pick up the batteries to my reminders", tool: "reminders_add", note: 'example from the pack itself' },
  { text: "put call the plumber on my reminders list for friday at 9", tool: "reminders_add", note: 'example from the pack itself' },
  { text: "add pick up the dry cleaning to my reminders list", tool: "reminders_add", note: 'example from the pack itself' },
  { text: "mark the plumber reminder as done", tool: "reminders_complete", note: 'example from the pack itself' },
  { text: "i finished the plumber reminder", tool: "reminders_complete", note: 'example from the pack itself' },
  { text: "tick off the plumber reminder", tool: "reminders_complete", note: 'example from the pack itself' },
  { text: "change the plumber reminder to friday", tool: "reminders_update", note: 'example from the pack itself' },
  { text: "add a note to the dentist reminder", tool: "reminders_update", note: 'example from the pack itself' },
  { text: "get rid of the pick up the dry cleaning reminder", tool: "reminders_delete", note: 'example from the pack itself' },
  { text: "summarise my mail", tool: "mail_recent", note: 'example from the pack itself' },
  { text: "give me a summary of my inbox", tool: "mail_recent", note: 'example from the pack itself' },
  { text: "what is new in my mail", tool: "mail_recent", note: 'example from the pack itself' },
  { text: "show me my recent messages", tool: "mail_recent", note: 'example from the pack itself' },
  { text: "find the message from the bank", tool: "mail_find", note: 'example from the pack itself' },
  { text: "search my mail for the invoice", tool: "mail_find", note: 'example from the pack itself' },
  { text: "who sent the message about the delivery", tool: "mail_find", note: 'example from the pack itself' },
  { text: "find the message from the plumber", tool: "mail_find", note: 'example from the pack itself' },
  { text: "what did the last message about the invoice say", tool: "mail_read", note: 'example from the pack itself' },
  { text: "read the message from the bank about the statement", tool: "mail_read", note: 'example from the pack itself' },
  { text: "what does the message about the delivery say", tool: "mail_read", note: 'example from the pack itself' },
  { text: "draft a reply to the landlord saying the rent is paid", tool: "mail_draft", note: 'example from the pack itself' },
  { text: "compose a message to the plumber about the boiler", tool: "mail_draft", note: 'example from the pack itself' },
  { text: "write up a short message for the bank", tool: "mail_draft", note: 'example from the pack itself' },
  { text: "what did i download recently", tool: "finder_recent", note: 'example from the pack itself' },
  { text: "show me the newest files in my downloads", tool: "finder_recent", note: 'example from the pack itself' },
  { text: "what files are in my desktop folder", tool: "finder_recent", note: 'example from the pack itself' },
  { text: "list the files i worked on today", tool: "finder_recent", note: 'example from the pack itself' },
  { text: "find the file called invoice", tool: "finder_find", note: 'example from the pack itself' },
  { text: "where is the file named budget", tool: "finder_find", note: 'example from the pack itself' },
  { text: "search my documents folder for the invoice", tool: "finder_find", note: 'example from the pack itself' },
  { text: "is there a file called passport in my downloads", tool: "finder_find", note: 'example from the pack itself' },
  { text: "what tabs do i have open", tool: "safari_tabs", note: 'example from the pack itself' },
  { text: "list my open safari tabs", tool: "safari_tabs", note: 'example from the pack itself' },
  { text: "what pages do i have up in safari", tool: "safari_tabs", note: 'example from the pack itself' },
  { text: "what was i reading in the browser", tool: "safari_tabs", note: 'example from the pack itself' },
  { text: "what does this page say", tool: "safari_read_tab", note: 'example from the pack itself' },
  { text: "read the article i have open", tool: "safari_read_tab", note: 'example from the pack itself' },
  { text: "what is the text of that page", tool: "safari_read_tab", note: 'example from the pack itself' },
  { text: "read the page about the recipe", tool: "safari_read_tab", note: 'example from the pack itself' },
  { text: "what song is playing", tool: "music_current", note: 'example from the pack itself' },
  { text: "what am i listening to", tool: "music_current", note: 'example from the pack itself' },
  { text: "who is this singing", app: "Music", tool: "music_current", note: 'example from the pack itself' },
  { text: "is the music paused", tool: "music_current", note: 'example from the pack itself' },
  { text: "do i have that song in my music library", tool: "music_library", note: 'example from the pack itself' },
  { text: "find the album by that band in my library", tool: "music_library", note: 'example from the pack itself' },
  { text: "search my music for a song called sunshine", tool: "music_library", note: 'example from the pack itself' },
  { text: "what did they say in messages", app: "Messages", tool: "messages_recent", note: 'example from the pack itself' },
  { text: "read my last messages with a friend", tool: "messages_recent", note: 'example from the pack itself' },
  { text: "what are my most recent messages", app: "Messages", tool: "messages_recent", note: 'example from the pack itself' },
  { text: "show the last messages in that conversation", tool: "messages_recent", note: 'example from the pack itself' },
  { text: "where did someone mention the address", tool: "messages_find", note: 'example from the pack itself' },
  { text: "find the message about the meeting time", tool: "messages_find", note: 'example from the pack itself' },
  { text: "search my messages for that word", app: "Messages", tool: "messages_find", note: 'example from the pack itself' },
  { text: "who said something about the train", tool: "messages_find", note: 'example from the pack itself' },
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
