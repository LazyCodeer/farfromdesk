import type { AppPack, AppTool } from './types.js';

/**
 * Turns a value into an AppleScript string literal. Owner text goes into scripts, so quotes
 * and backslashes have to be escaped rather than trusted.
 */
export function asStr(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** AppleScript only accepts `date "YYYY-MM-DD HH:MM:SS"`; anything else is refused by us. */
export function appleDate(value: string): string {
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    throw new Error(`A date has to look like 2026-11-04 09:00:00, not "${value}".`);
  }
  return `date ${asStr(text)}`;
}

const notesCreate: AppTool = {
  name: 'notes_create_note',
  pack: 'notes',
  app: 'Notes',
  bundleId: 'com.apple.Notes',
  description:
    'Create a new note in Apple Notes and put the given text in its body. Use this when the owner ' +
    'asks to write, note down, jot, save or take down something and the destination is Notes. ' +
    'It always creates a new note in the folder that is already open; it does not append to an ' +
    'existing note and it does not edit the note that is on screen. It also does not use the ' +
    'search field, so the text can never land in a search box. Returns the driver result, which ' +
    'is only reported as success when the new note body actually received the text.',
  args: [
    { name: 'body', description: "The owner's words for the note body, written out in full.", required: true },
  ],
  examples: [
    'write a note that the roof is leaking',
    'note down tomorrow meeting at 5pm',
    'jot this in notes: call the plumber on monday',
  ],
  keywords: ['note', 'notes', 'write', 'jot', 'save', 'remember', 'take down', 'note down', 'memo'],
  writes: true,
  plan: args => ({
    kind: 'steps',
    steps: [
      // Escape first: if the owner left Notes in search, the caret is in the search field and
      // the first keystrokes would filter the list instead of writing a note.
      { press_key: { key: 'escape' } },
      // Role is required: "New Note" also names a menu item, and a name-only click is refused
      // as ambiguous (measured 2026-11-03: two elements matched).
      { click: { role: 'AXButton', name: 'New Note' } },
      { type_text: { role: 'AXTextArea', text: String(args.body ?? '') } },
    ],
  }),
};

const notesSearch: AppTool = {
  name: 'notes_search',
  pack: 'notes',
  app: 'Notes',
  bundleId: 'com.apple.Notes',
  description:
    'Type a phrase into the Notes search field so the note list is filtered down to matching ' +
    'notes. Use this when the owner asks to find, look for or show a note they already have. ' +
    'It only filters what Notes shows; it does not read the note out and it does not create ' +
    'anything. Read the window afterwards when the owner wants to know what the note says.',
  args: [{ name: 'query', description: 'The words to search the note list for.', required: true }],
  examples: ['find my note about the roof', 'look for the note with the plumber number', 'show my notes about the invoice'],
  keywords: ['find', 'search', 'look for', 'note', 'notes', 'where', 'show me'],
  writes: false,
  // Not exercised live yet; the click focuses the field and the untargeted type_text goes to
  // whatever holds focus, which is the same convention the phone typing path uses.
  plan: args => ({
    kind: 'steps',
    steps: [
      { press_key: { key: 'escape' } },
      { click: { role: 'AXTextField', name: 'Search' } },
      { type_text: { text: String(args.query ?? '') } },
    ],
  }),
};

const calendarCreateEvent: AppTool = {
  name: 'calendar_create_event',
  pack: 'calendar',
  app: 'Calendar',
  bundleId: 'com.apple.iCal',
  description:
    'Add an event to a calendar in Apple Calendar with a title, a start and an end. Use this ' +
    'when the owner asks to schedule, book, add or set up something at a time. It creates the ' +
    'event on the owner\'s own calendar and does not invite anyone, does not email anyone and ' +
    'does not create a new calendar. Both times must be written as YYYY-MM-DD HH:MM:SS, so work ' +
    'out the real date and time before calling it. Returns the summary Calendar reports back.',
  args: [
    { name: 'title', description: 'What the event is called, for example "Meeting with Ashitosh".', required: true },
    { name: 'start', description: 'Start time as YYYY-MM-DD HH:MM:SS.', required: true },
    { name: 'end', description: 'End time as YYYY-MM-DD HH:MM:SS.', required: true },
    { name: 'calendar', description: 'Which calendar to add it to. Leave empty to use the first calendar.' },
  ],
  examples: [
    'add a meeting with ashitosh tomorrow at 5pm',
    'put a reminder on my calendar for the dentist on friday at 10',
    'schedule a call at 9 tomorrow morning',
  ],
  keywords: ['calendar', 'event', 'meeting', 'schedule', 'book', 'appointment', 'add', 'put', 'tomorrow', 'invite'],
  writes: true,
  plan: args => {
    const target = args.calendar?.trim()
      ? `tell calendar ${asStr(args.calendar.trim())}`
      : 'tell calendar 1';
    return {
      kind: 'osascript',
      script:
        `set d1 to ${appleDate(String(args.start ?? ''))}\n` +
        `set d2 to ${appleDate(String(args.end ?? ''))}\n` +
        `tell application "Calendar"\n` +
        `  ${target}\n` +
        `    set newEvent to make new event at end of events with properties {summary:${asStr(String(args.title ?? ''))}, start date:d1, end date:d2}\n` +
        `    return summary of newEvent & " from " & (start date of newEvent as string)\n` +
        `  end tell\n` +
        `end tell\n`,
    };
  },
};

const calendarListEvents: AppTool = {
  name: 'calendar_list_events',
  pack: 'calendar',
  app: 'Calendar',
  bundleId: 'com.apple.iCal',
  description:
    'List the events in Apple Calendar between now and the given number of days ahead, with the ' +
    'title and start time of each. Use this when the owner asks what is on their calendar, what ' +
    'is coming up, or whether they are free. It only reads; it never creates, moves or deletes an ' +
    'event and it never opens a window. Returns one line per event, or an empty result when the ' +
    'next days are clear.',
  args: [{ name: 'days', description: 'How many days ahead to look, for example 1 for today or 7 for the week.' }],
  examples: ['what is on my calendar today', 'what is coming up this week', 'am I free tomorrow'],
  keywords: ['calendar', 'events', 'today', 'tomorrow', 'week', 'coming up', 'free', 'busy', 'schedule'],
  writes: false,
  plan: args => {
    const days = Number(args.days ?? '7');
    const span = Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 60) : 7;
    return {
      kind: 'osascript',
      script:
        `set t0 to current date\n` +
        `set t1 to t0 + (${span} * days)\n` +
        `tell application "Calendar"\n` +
        `  set lines to {}\n` +
        `  repeat with c in calendars\n` +
        `    repeat with e in (every event of c whose start date is greater than or equal to t0 and start date is less than or equal to t1)\n` +
        `      set end of lines to (summary of e) & " at " & (start date of e as string)\n` +
        `    end repeat\n` +
        `  end repeat\n` +
        `  return lines\n` +
        `end tell\n`,
    };
  },
};

export const PACKS: AppPack[] = [
  {
    id: 'notes',
    app: 'Notes',
    bundleId: 'com.apple.Notes',
    summary: 'Write and search notes in Apple Notes without touching the search box by mistake.',
    tools: [notesCreate, notesSearch],
  },
  {
    id: 'calendar',
    app: 'Calendar',
    bundleId: 'com.apple.iCal',
    summary: 'Add an event and read what is coming up in Apple Calendar.',
    tools: [calendarCreateEvent, calendarListEvents],
  },
];

export function allPackTools(): AppTool[] {
  return PACKS.flatMap(pack => pack.tools);
}

export function packFor(app: string): AppPack | undefined {
  const wanted = app.trim().toLowerCase();
  return PACKS.find(pack => pack.app.toLowerCase() === wanted);
}

export function toolByName(name: string): AppTool | undefined {
  const wanted = name.trim().toLowerCase();
  return allPackTools().find(tool => tool.name.toLowerCase() === wanted);
}