import type { AppPack, AppTool } from '../types.js';
import {
  dateOrDay,
  formatEventSearch,
  formatEventWrite,
  formatEvents,
  formatOneEvent,
  helper,
  refusal,
} from '../adapters/eventkit.js';

/**
 * The Calendar pack: find, read, add, move and delete events in Apple Calendar.
 *
 * Calendar is a daily app and the riskiest one in the reviewed set: an event can carry other
 * people, and deleting or moving one can reach them without the owner asking. The routing between
 * the pack and Calendar now goes through the bundled EventKit helper (`native/eventkit-helper.swift`)
 * instead of hand-written AppleScript, because EventKit is the app's own model and it is the only
 * route that can be tested as an argument array. This file never parses the helper's JSON: that
 * lives in `src/app-tools/adapters/eventkit.ts`, which also owns the refusal sentences the helper
 * answers with ("no match", "more than one match", "it repeats", "other people are on it").
 *
 * What is still ours is the policy: every write names exactly one event, every delete repeats the
 * title as `--confirm`, and every argument is validated here: a malformed time throws
 * `invalidArgument` (packTool turns that into APP_TOOL_ARGUMENT_INVALID, "I could not use those
 * details"), while an answer about the data is a `refusal` sentence. Nothing in this pack ever sends, invites or emails anyone,
 * and nothing here converts a time zone — all times are the Mac's local time.
 */

/**
 * The sentences a refused write returns before the helper is ever called. They are exported so a
 * test can assert the exact refusal path instead of matching prose. They are plain return values:
 * the data answered the question and the answer is "no" or "you have to be exact".
 *
 * A malformed time is a different thing, and is NOT one of these: it is an argument error, so it
 * throws through `invalidArgument` below and packTool reports APP_TOOL_ARGUMENT_INVALID ("I could
 * not use those details, so I did nothing"). That keeps a bad date from starting osascript just to
 * print a sentence, which is the contract test/desktop-assist.test.ts pins for this pack.
 */
export const NO_SUMMARY_REFUSAL = 'I need the exact event title before I can touch an event.';
export const NO_TITLE_REFUSAL = 'I need the title of the event before I can add it.';
export const EMPTY_CHANGE_REFUSAL =
  'There is nothing to change: give a new title, start, end or location, and try again.';
export const BAD_DAYS_REFUSAL = 'The number of days has to be a whole number, for example 7.';
export const END_BEFORE_START_REFUSAL = 'The end time has to be after the start time.';

/** The confirm mismatch sentence, built with the event name so the owner sees what to type. */
export function confirmRefusal(summary: string): string {
  return `To delete "${summary}" I need the confirm argument to say exactly "${summary}". Nothing was deleted.`;
}

/**
 * The wanted shape for a time argument. `dateTime` wants `YYYY-MM-DD HH:MM:SS` and `dateOnly`
 * wants `YYYY-MM-DD`; both are accepted, so the refusal names both.
 */
export function dateRefusal(value: string): string {
  return `A date has to look like 2026-11-04 09:00:00 or 2026-11-04, not "${value}".`;
}

/**
 * A malformed argument throws rather than returning a sentence, so `packTool` answers with
 * APP_TOOL_ARGUMENT_INVALID and no helper, no osascript and no driver step is ever started.
 */
export function invalidArgument(sentence: string): never {
  throw new Error(sentence);
}

/** A validated date, or the readable refusal that says what the shape should be. */
function dayOf(value: string): { day: string } | { refusalSentence: string } {
  const valid = dateOrDay(value);
  return valid ? { day: valid.slice(0, 10) } : { refusalSentence: dateRefusal(value) };
}

/** Today's local date, so an empty window still has a real left edge. */
function today(): string {
  const now = new Date();
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A local date moved by whole days; the helper's `--from`/`--to` only take a day. */
function addDays(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const moved = new Date(year, month - 1, date);
  moved.setDate(moved.getDate() + days);
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${moved.getFullYear()}-${pad(moved.getMonth() + 1)}-${pad(moved.getDate())}`;
}

/** The helper's own event window is bounded, so one huge account cannot flood the answer. */
const SCAN_LIMIT = 300;

const calendarFindEvents: AppTool = {
  name: 'calendar_find_events',
  pack: 'calendar',
  app: 'Calendar',
  bundleId: 'com.apple.iCal',
  description:
    'Search Apple Calendar for events whose title, location or notes mention some text, and/or ' +
    'whose start falls in a date range, across every calendar or one named calendar. Use this ' +
    'when the owner asks to find, search or show events, or asks what is on a particular day, and ' +
    'gave a date range or a word to match rather than asking what is coming up soon. It only reads: ' +
    'it never creates, moves, deletes, invites or emails anyone, and it never opens a window. It ' +
    'checks at most 300 events and returns at most 12 matches, so it says in its answer how much ' +
    'it scanned when the scan hit that cap. Times are the Mac\'s local time; no time zone is ' +
    'converted. Returns one line per match with the title, start, end and calendar name.',
  args: [
    { name: 'query', description: 'Text to look for in the event title, location or notes. Leave empty to match every event in the date range.' },
    { name: 'start', description: 'The earliest day to include, as YYYY-MM-DD HH:MM:SS or YYYY-MM-DD in local time.' },
    { name: 'end', description: 'The latest day to include, as YYYY-MM-DD HH:MM:SS or YYYY-MM-DD in local time. Leave empty for a year ahead.' },
    { name: 'calendar', description: 'Only search this calendar by its exact name. Leave empty to search every calendar.' },
  ],
  examples: [
    'find the meeting with the team',
    'what events do i have on friday',
    'search my calendar for the dentist',
    'show me events between monday and thursday',
  ],
  keywords: ['calendar', 'find', 'search', 'events', 'meeting', 'appointment', 'between', 'range', 'show', 'happening', 'look'],
  // A request to write, move or delete must not be answered by a search. The polarity rule
  // already drops it for the usual opening verbs; these cover the sentences that do not start
  // with one.
  notFor: ['add an event', 'create an event', 'schedule an event', 'move an event', 'delete an event'],
  writes: false,
  plan: args => {
    const query = String(args.query ?? '').trim();
    const calendar = String(args.calendar ?? '').trim();
    const rawStart = String(args.start ?? '').trim();
    const rawEnd = String(args.end ?? '').trim();
    // The helper's window is day-granular, so a time of day is validated and then unwrapped to
    // its day. A bad date is a refusal before any helper runs.
    let from = today();
    if (rawStart) {
      const start = dayOf(rawStart);
      if ('refusalSentence' in start) invalidArgument(start.refusalSentence);
      from = start.day;
    }
    let to = addDays(from, 365);
    if (rawEnd) {
      const end = dayOf(rawEnd);
      if ('refusalSentence' in end) invalidArgument(end.refusalSentence);
      to = end.day;
    }
    if (to < from) invalidArgument('The end of the window has to be on or after its start.');
    const argv = ['events', '--from', from, '--to', to];
    if (calendar) argv.push('--calendar', calendar);
    argv.push('--limit', String(SCAN_LIMIT));
    return helper(argv, { outputChars: 8000, format: raw => formatEventSearch(raw, query, 12) });
  },
};

const calendarReadEvent: AppTool = {
  name: 'calendar_read_event',
  pack: 'calendar',
  app: 'Calendar',
  bundleId: 'com.apple.iCal',
  description:
    'Read the full detail of one Apple Calendar event: its title, start, end, location, notes, ' +
    'calendar, all-day flag and recurrence. Use this when the owner asks for the details of a ' +
    'specific event, where it is, what the notes say, or what time it really starts, and the ' +
    'title and start time identify it. It only reads: it never creates, edits, moves, deletes, ' +
    'invites or emails anyone. It must match exactly one event by title and start time; when ' +
    'there is none, or more than one, it says so instead of guessing. Times are the Mac\'s local time.',
  args: [
    { name: 'summary', description: 'The exact title of the event, as it is written in Calendar.', required: true },
    { name: 'start', description: 'The event\'s start time as YYYY-MM-DD HH:MM:SS in local time.', required: true },
  ],
  examples: [
    'what time exactly is the standup',
    'give me the details of my dentist appointment',
    'where is the team meeting',
    'what are the details of the standup',
  ],
  keywords: ['calendar', 'event', 'meeting', 'appointment', 'details', 'read', 'where', 'location', 'notes', 'what time', 'standup'],
  // Reading one event must not be the answer to a search or to a change.
  notFor: ['find an event', 'search my calendar', 'move an event', 'delete an event'],
  writes: false,
  plan: args => {
    const summary = String(args.summary ?? '').trim();
    if (!summary) return refusal(NO_SUMMARY_REFUSAL);
    const rawStart = String(args.start ?? '').trim();
    let start = '';
    if (rawStart) {
      const valid = dateOrDay(rawStart);
      if (!valid) invalidArgument(dateRefusal(rawStart));
      start = valid;
    }
    // The helper's title (+/- 90 seconds of `--start`) match is the same one `update` and
    // `delete` use, so a single-event read resolves exactly the way a write does: zero matches
    // and more than one matches both refuse in words inside the helper, never a guess.
    const argv = ['event-by-title', '--title', summary];
    if (start) argv.push('--start', start);
    return helper(argv, { outputChars: 4000, format: formatOneEvent });
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
    const text = String(args.days ?? '').trim();
    const parsed = text ? Number(text) : 7;
    const span = Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 60) : 7;
    if (text && !/^\d+$/.test(text)) invalidArgument(BAD_DAYS_REFUSAL);
    const from = today();
    return helper(['events', '--from', from, '--to', addDays(from, span), '--limit', String(SCAN_LIMIT)], {
      outputChars: 8000,
      format: formatEvents,
    });
  },
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
  // 'block out' and 'set aside' are how people ask for time to be created, not moved: the
  // update tool owns move, reschedule, push and change.
  keywords: ['calendar', 'event', 'meeting', 'schedule', 'book', 'appointment', 'add', 'put', 'block out', 'set aside', 'tomorrow', 'invite'],
  writes: true,
  plan: args => {
    const title = String(args.title ?? '').trim();
    const calendar = String(args.calendar ?? '').trim();
    if (!title) return refusal(NO_TITLE_REFUSAL);
    const start = dateOrDay(String(args.start ?? '').trim());
    if (!start) invalidArgument(dateRefusal(String(args.start ?? '').trim()));
    const end = dateOrDay(String(args.end ?? '').trim());
    if (!end) invalidArgument(dateRefusal(String(args.end ?? '').trim()));
    if (end <= start) invalidArgument(END_BEFORE_START_REFUSAL);
    const argv = ['create', '--title', title, '--start', start, '--end', end];
    if (calendar) argv.push('--calendar', calendar);
    return helper(argv, { outputChars: 4000, format: raw => formatEventWrite(raw, 'added') });
  },
};

const calendarUpdateEvent: AppTool = {
  name: 'calendar_update_event',
  pack: 'calendar',
  app: 'Calendar',
  bundleId: 'com.apple.iCal',
  description:
    'Change the time, title or location of one Apple Calendar event that the tool can identify ' +
    'exactly by its current title and start time. Use this when the owner asks to move, ' +
    'reschedule, push back, rename or update an event. It first reads the matching event and ' +
    'refuses when there is no match, when more than one event matches, when the event repeats, ' +
    'or when other people are on it, because changing it could reach them. It never sends, ' +
    'invites or emails anyone, and it never creates or deletes an event. Give at least one new ' +
    'value; when only a new start is given the end moves by the same amount. Times are ' +
    'YYYY-MM-DD HH:MM:SS in the Mac\'s local time. Returns the event\'s new title, start, end ' +
    'and location read back after the change.',
  args: [
    { name: 'summary', description: 'The exact current title of the event, as it is written in Calendar.', required: true },
    { name: 'start', description: 'The event\'s current start time as YYYY-MM-DD HH:MM:SS in local time.', required: true },
    { name: 'new_summary', description: 'The new title, if the title changes. Leave empty to keep it.' },
    { name: 'new_start', description: 'The new start time as YYYY-MM-DD HH:MM:SS in local time. Leave empty to keep it.' },
    { name: 'new_end', description: 'The new end time as YYYY-MM-DD HH:MM:SS in local time. Leave empty to keep it or to shift it with the start.' },
    { name: 'new_location', description: 'The new location text, if the location changes. Leave empty to keep it.' },
  ],
  examples: [
    'move my dentist appointment to 6pm',
    'reschedule the standup to friday morning',
    'change the location of the team meeting',
    'push the standup back to 4pm',
  ],
  keywords: ['calendar', 'event', 'meeting', 'appointment', 'move', 'reschedule', 'change', 'push', 'update', 'later', 'earlier', 'shift'],
  // A delete is not an update; it has its own tool with its own confirm.
  notFor: ['delete an event', 'remove an event', 'cancel an event'],
  writes: true,
  plan: args => {
    const summary = String(args.summary ?? '').trim();
    if (!summary) return refusal(NO_SUMMARY_REFUSAL);
    const newSummary = String(args.new_summary ?? '').trim();
    const rawNewStart = String(args.new_start ?? '').trim();
    const rawNewEnd = String(args.new_end ?? '').trim();
    const newLocation = String(args.new_location ?? '').trim();
    if (!newSummary && !rawNewStart && !rawNewEnd && !newLocation) return refusal(EMPTY_CHANGE_REFUSAL);
    const start = dateOrDay(String(args.start ?? '').trim());
    if (!start) invalidArgument(dateRefusal(String(args.start ?? '').trim()));
    let newStart = '';
    if (rawNewStart) {
      newStart = dateOrDay(rawNewStart) ?? '';
      if (!newStart) invalidArgument(dateRefusal(rawNewStart));
    }
    let newEnd = '';
    if (rawNewEnd) {
      newEnd = dateOrDay(rawNewEnd) ?? '';
      if (!newEnd) invalidArgument(dateRefusal(rawNewEnd));
    }
    if (newStart && newEnd && newEnd <= newStart) invalidArgument(END_BEFORE_START_REFUSAL);
    const argv = ['update', '--title', summary, '--start', start];
    if (newSummary) argv.push('--new-title', newSummary);
    if (newStart) argv.push('--new-start', newStart);
    if (newEnd) argv.push('--new-end', newEnd);
    if (newLocation) argv.push('--location', newLocation);
    return helper(argv, { outputChars: 4000, format: raw => formatEventWrite(raw, 'changed') });
  },
};

const calendarDeleteEvent: AppTool = {
  name: 'calendar_delete_event',
  pack: 'calendar',
  app: 'Calendar',
  bundleId: 'com.apple.iCal',
  description:
    'Delete one Apple Calendar event that the tool can identify exactly by its title and start ' +
    'time, but only when the confirm argument equals the title exactly. Use this when the owner ' +
    'clearly asks to delete, remove or cancel a specific one-off event and has repeated its name ' +
    'back. It refuses when confirm does not match, when there is no match, when more than one ' +
    'event matches, when the event repeats, and when other people are on the event, because ' +
    'removing it could reach them without the owner meaning to. It never sends, invites or emails ' +
    'anyone, and it never deletes a series. It reads the event first and returns what was ' +
    'deleted. This is the riskiest tool in the pack: check the title and time before calling it.',
  args: [
    { name: 'summary', description: 'The exact title of the event to delete, as it is written in Calendar.', required: true },
    { name: 'start', description: 'The event\'s start time as YYYY-MM-DD HH:MM:SS in local time.', required: true },
    { name: 'confirm', description: 'The same exact title again, typed out to confirm the deletion.', required: true },
  ],
  examples: [
    'delete the event called standup confirm standup',
    'cancel my dentist appointment',
    'remove the team meeting from my calendar',
    'delete the standup at 9 on friday',
  ],
  keywords: ['calendar', 'delete', 'remove', 'cancel', 'drop', 'event', 'meeting', 'appointment', 'standup', 'clear'],
  // A change is not a delete; ask for a change with its own tool.
  notFor: ['move an event', 'reschedule an event', 'change an event'],
  writes: true,
  plan: args => {
    const summary = String(args.summary ?? '').trim();
    if (!summary) return refusal(NO_SUMMARY_REFUSAL);
    const confirm = String(args.confirm ?? '').trim();
    // The client-side confirm gate runs before the helper, and the same exact title is also
    // passed as `--confirm` so the helper refuses a mismatch too. Never a bulk delete.
    if (confirm !== summary) return refusal(confirmRefusal(summary));
    const start = dateOrDay(String(args.start ?? '').trim());
    if (!start) invalidArgument(dateRefusal(String(args.start ?? '').trim()));
    return helper(['delete', '--title', summary, '--start', start, '--confirm', summary], {
      outputChars: 4000,
      format: raw => formatEventWrite(raw, 'deleted'),
    });
  },
};

export const CALENDAR_PACK: AppPack = {
  id: 'calendar',
  app: 'Calendar',
  bundleId: 'com.apple.iCal',
  summary: 'Find, read, add, move and delete events in Apple Calendar, with the risky changes guarded.',
  // Reads are declared before writes: retrieval breaks score ties by declaration order, and a
  // reading request should never lose to the tool that changes something.
  tools: [calendarFindEvents, calendarReadEvent, calendarListEvents, calendarCreateEvent, calendarUpdateEvent, calendarDeleteEvent],
};

export default CALENDAR_PACK;