import type { AppPack, AppTool } from './types.js';

/**
 * Turns a value into an AppleScript string literal. Owner text goes into scripts, so quotes
 * and backslashes have to be escaped rather than trusted.
 */
export function asStr(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** AppleScript only accepts `date "YYYY-MM-DD HH:MM:SS"`; anything else is refused by us. */
/**
 * A validated date, written as AppleScript parts.
 *
 * A `date "2026-11-04 09:00:00"` literal is coerced using the Mac's own date settings, so the
 * same script fails on a machine set to another format. Assigning the parts is locale-proof;
 * the day is set to 1 before the month so that setting a 31-day month onto the current date
 * cannot overflow. `set time of d` takes seconds since midnight.
 */
export function appleDate(value: string): string {
  return appleDateParts(value).text;
}

/** The validated parts of `YYYY-MM-DD HH:MM:SS`, or a sentence saying what is wrong. */
export function appleDateParts(value: string): { text: string; year: number; month: number; day: number; seconds: number } {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!match) throw new Error(`A date has to look like 2026-11-04 09:00:00, not "${value}".`);
  const [, year, month, day, hour, minute, second] = match;
  const hours = Number(hour), minutes = Number(minute), seconds = Number(second);
  if (hours > 23 || minutes > 59 || seconds > 59) throw new Error(`A date has to look like 2026-11-04 09:00:00, not "${value}".`);
  return { text, year: Number(year), month: Number(month), day: Number(day), seconds: hours * 3600 + minutes * 60 + seconds };
}

/** The lines that put a validated date into an AppleScript variable. */
export function appleDateAssign(name: string, value: string): string {
  const parts = appleDateParts(value);
  return `set ${name} to current date\nset day of ${name} to 1\nset year of ${name} to ${parts.year}\nset month of ${name} to ${parts.month}\nset day of ${name} to ${parts.day}\nset time of ${name} to ${parts.seconds}\n`;
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
  // Asking to find a note is not asking to write one: the words overlap completely, and a
  // wrong write is worse than a wrong answer. Live on 2026-11-03 the only Notes tool was
  // create, so this is what keeps "find my note about the roof" from making a second note.
  notFor: ['find a note', 'look for a note', 'search my notes', 'show my notes'],
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

const notesFind: AppTool = {
  name: 'notes_find',
  pack: 'notes',
  app: 'Notes',
  bundleId: 'com.apple.Notes',
  description:
    'Look through Apple Notes for notes whose title or body mentions a word or phrase, and list ' +
    'their titles. Use this when the owner asks to find, search or look for a note, asks where a ' +
    'note went, or asks what they wrote about something. This tool only reads: it never creates, ' +
    'edits, deletes, opens or moves a note, and it never types, so it cannot leave a mark in a ' +
    'note or in the search field. It looks at the first 300 notes and returns at most 8 titles, ' +
    'not the note bodies; if the owner needs the words of one note, reading the window is the ' +
    'better tool.',
  args: [
    { name: 'query', description: 'The single word or short phrase to look for, as the owner said it.', required: true },
  ],
  examples: [
    // Deliberately not the create tool's "the roof is leaking" sentence: sharing an example
    // sentence made a write request match this read tool, which is the same collision that put
    // the Ashitosh calendar sentence in front of the note tool.
    'find my note about the plumber',
    'search my notes for invoice 442',
    'do I have a note about the dentist',
  ],
  keywords: ['note', 'notes', 'find', 'search', 'look for', 'where is', 'show my notes', 'did i write'],
  // Read only, and it says so: the previous search tool drove the interface and typed into the
  // note that happened to be open. This one sends one AppleScript read and touches no keystroke.
  writes: false,
  plan: args => ({
    kind: 'osascript',
    // Titles are compared case-insensitively by AppleScript's default, and the loop is capped
    // so a large Notes library cannot hold the turn open. `notes` at the application level is
    // real: /tmp/sdef_Notes.xml:49 lists <element type="note"> on the application class.
    script:
      `set q to ${asStr(String(args.query ?? ''))}\n` +
      `set hits to {}\n` +
      `set seen to 0\n` +
      `tell application "Notes"\n` +
      `\trepeat with n in notes\n` +
      `\t\tset seen to seen + 1\n` +
      `\t\tif seen > 300 then exit repeat\n` +
      `\t\tif (name of n contains q) or (body of n contains q) then\n` +
      `\t\t\tset t to (name of n)\n` +
      `\t\t\tif t is "" then set t to "untitled note"\n` +
      `\t\t\tset end of hits to t\n` +
      `\t\t\tif (count of hits) is greater than or equal to 8 then exit repeat\n` +
      `\t\tend if\n` +
      `\tend repeat\n` +
      `end tell\n` +
      `if (count of hits) is 0 then return "no note mentions " & q\n` +
      `return hits\n`,
  }),
};


const calendarCreateEvent: AppTool = {
  name: 'calendar_create_event',
  pack: 'calendar',
  app: 'Calendar',
  bundleId: 'com.apple.iCal',
  description:
    'Add an event to a calendar in Apple Calendar with a title, a start and an end. Use this ' +
    'when the owner asks to schedule, book, add or set up something at a time, and also when the ' +
    'owner states a plan with a day or time rather than asking, such as seeing someone on Friday. ' +
    'It creates the ' +
    'event on the owner\'s own calendar and does not invite anyone, does not email anyone and ' +
    'does not create a new calendar. Both times must be written as YYYY-MM-DD HH:MM:SS, so work ' +
    'out the real date and time before calling it. Returns the summary Calendar reports back.',
  args: [
    { name: 'title', description: 'What the event is called, for example "Dentist".', required: true },
    { name: 'start', description: 'Start time as YYYY-MM-DD HH:MM:SS.', required: true },
    { name: 'end', description: 'End time as YYYY-MM-DD HH:MM:SS.', required: true },
    { name: 'calendar', description: 'Which calendar to add it to. Leave empty to use the first calendar.' },
  ],
  examples: [
    // The owner's own sentence, with the name left out: an example carrying a person's name
    // matched an unrelated note request for that same name ("don't let me forget to call
    // Ashitosh" reached this tool first). The live sentence stays in the golden set instead.
    'add a meeting with the team tomorrow at 5pm',
    'put a reminder on my calendar for the dentist on friday at 10',
    'schedule a call at 9 tomorrow morning',
  ],
  keywords: ['calendar', 'event', 'meeting', 'schedule', 'book', 'appointment', 'add', 'put', 'tomorrow', 'invite'],
  writes: true,
  plan: args => {
    const target = args.calendar?.trim()
      ? `tell calendar ${asStr(args.calendar.trim())}`
      : 'tell calendar 1';
    // Both times are validated here, so a model that wrote "tomorrow at 5" gets a clear refusal
    // instead of an event at the wrong time. The fixed-width format compares as a string.
    const start = appleDateParts(String(args.start ?? ''));
    const end = appleDateParts(String(args.end ?? ''));
    if (end.text <= start.text) throw new Error('The end time has to be after the start time.');
    return {
      kind: 'osascript',
      script:
        appleDateAssign('d1', start.text) +
        appleDateAssign('d2', end.text) +
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
  keywords: ['calendar', 'events', 'today', 'tomorrow', 'week', 'coming up', 'free', 'busy', 'schedule', 'booked', 'look like', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
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


const remindersAdd: AppTool = {
  name: 'reminders_add',
  pack: 'reminders',
  app: 'Reminders',
  bundleId: 'com.apple.reminders',
  description:
    'Add one reminder to Apple Reminders, with a name and an optional list and due time. Use this ' +
    'when the owner asks for something to go on their reminders or checklist and the app ' +
    'is Reminders. It creates the reminder in the default list unless the owner named a list, and ' +
    'it never completes, deletes, moves or renames anything. A due time has to be written as ' +
    'YYYY-MM-DD HH:MM:SS, so work out the real date and time before calling it; leave it empty ' +
    'when the owner did not say when. Returns the name Reminders reports back.',
  args: [
    { name: 'title', description: 'What the reminder says, in the owner\'s words.', required: true },
    { name: 'list', description: 'Which list to add it to. Leave empty to use the default list.' },
    { name: 'due', description: 'When it is due, as YYYY-MM-DD HH:MM:SS. Leave empty when the owner did not say.' },
  ],
  examples: [
    'add pick up the batteries to my reminders',
    'put call the plumber on my reminders list for friday at 9',
    'add pick up the dry cleaning to my reminders list',
  ],
  // "task" and "todo" are deliberately not keywords: this product calls coding work a task, and
  // "add a checks column to task_contracts" matched the reminder tool when they were.
  keywords: ['reminder', 'reminders', 'checklist', 'pick up', 'due'],
  writes: true,
  plan: args => {
    const target = args.list?.trim() ? `list ${asStr(args.list.trim())}` : 'default list';
    const due = String(args.due ?? '').trim();
    const when = due ? appleDateAssign('d1', due) : '';
    const properties = due
      ? `{name:${asStr(String(args.title ?? ''))}, due date:d1}`
      : `{name:${asStr(String(args.title ?? ''))}}`;
    return {
      kind: 'osascript',
      script:
        when +
        `tell application "Reminders"\n` +
        `  set newReminder to make new reminder at end of reminders of ${target} with properties ${properties}\n` +
        `  return name of newReminder\n` +
        `end tell\n`,
    };
  },
};

const remindersList: AppTool = {
  name: 'reminders_list',
  pack: 'reminders',
  app: 'Reminders',
  bundleId: 'com.apple.reminders',
  description:
    'List the reminder lists in Apple Reminders with how many reminders in each are still open. ' +
    'Use this when the owner asks what is on their reminders, what they have to do, or which ' +
    'lists exist. It only counts; it never reads a reminder body, never completes anything and ' +
    'never opens a window. Returns one line per list, or says that there are no lists.',
  args: [],
  examples: ['what is on my reminders', 'what do i have to do', 'show my reminder lists'],
  keywords: ['reminders', 'lists', 'how many', 'what do i have', 'anything', 'open', 'today'],
  writes: false,
  plan: () => ({
    kind: 'osascript',
    script:
      `tell application "Reminders"\n` +
      `  set lines to {}\n` +
      `  repeat with l in lists\n` +
      `    set openCount to count of (reminders of l whose completed is false)\n` +
      `    set end of lines to (name of l) & ": " & openCount & " open"\n` +
      `  end repeat\n` +
      `  if (count of lines) is 0 then return "no reminder lists"\n` +
      `  return lines\n` +
      `end tell\n`,
  }),
};

export const PACKS: AppPack[] = [
  {
    id: 'notes',
    app: 'Notes',
    bundleId: 'com.apple.Notes',
    summary: 'Write a note in Apple Notes, and read back one that already exists.',
    tools: [notesCreate, notesFind],
  },
  {
    id: 'calendar',
    app: 'Calendar',
    bundleId: 'com.apple.iCal',
    summary: 'Add an event and read what is coming up in Apple Calendar.',
    tools: [calendarCreateEvent, calendarListEvents],
  },
  {
    id: 'reminders',
    app: 'Reminders',
    bundleId: 'com.apple.reminders',
    summary: 'Add one reminder, and count what is still open in Apple Reminders.',
    tools: [remindersAdd, remindersList],
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