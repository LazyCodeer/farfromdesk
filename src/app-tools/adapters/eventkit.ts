import type { AppToolPlan } from '../types.js';

/**
 * The Calendar and Reminders adapter: the one place that knows the EventKit helper's command
 * line and the shape of what it answers.
 *
 * Why a helper and not AppleScript. Calendar and Reminders are reachable over AppleScript, and
 * that is what these two packs used to do. What it cannot do is read or write the fields the
 * owner actually asks about (attendees, alarms, recurrence, the reminder's list and completion
 * state) without walking `whose` clauses that get slower the more data there is, and every one
 * of those reads is one Apple event away from a locale-parsed date. EventKit is the app's own
 * model. It is also the only route that can be tested as an argument array instead of as a
 * script.
 *
 * Why the plans stay declarative. A plan is data: a binary name, an argument array, a timeout
 * and an optional `format`. Everything that needs judgement — validating a date shape, choosing
 * a window, turning the helper's JSON into the lines the model reads — lives here, and the
 * helper itself does no formatting at all. That keeps the tool testable without a Mac that has
 * any data on it, and keeps every refusal a sentence rather than a throw.
 *
 * The helper (see `native/eventkit-helper.swift`) writes JSON to stdout and, on failure,
 * `Error: <sentence>` to stderr with exit 1. Access is granted to the *responsible process*, so
 * the first run shows macOS's Calendar/Reminders prompt for FarFromDesk Local itself; a process
 * with no NS*UsageDescription in its Info.plist is denied instantly and silently.
 */

/** The bundled helper's file name under `Resources/backend/native/`. */
export const EVENTKIT_HELPER = 'eventkit-helper';

export interface HelperOptions {
  timeoutMs?: number;
  outputChars?: number;
  format?: (raw: string) => string;
}

/** A plan that runs the bundled EventKit helper with a discrete argument array. */
export function helper(args: string[], options: HelperOptions = {}): AppToolPlan {
  return {
    kind: 'cli',
    binary: EVENTKIT_HELPER,
    args,
    timeoutMs: options.timeoutMs ?? 20000,
    outputChars: options.outputChars,
    format: options.format,
  };
}

/**
 * A refusal is not a helper call, and that matters: the helper may not be in this build yet, and
 * "I need the name of the note" must still arrive as that sentence rather than as "the helper is
 * missing". So a refusal is answered the way every other readable refusal in this layer is, by a
 * one-line AppleScript that returns it.
 */
export function refusal(sentence: string): AppToolPlan {
  return { kind: 'osascript', script: `return "${sentence.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n` };
}

/** `YYYY-MM-DD`, checked as a real date and not just as a shape. */
export function dateOnly(value: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return undefined;
  return realDate(Number(match[1]), Number(match[2]), Number(match[3])) ? match[0] : undefined;
}

/** `YYYY-MM-DD HH:MM:SS`, checked as a real date and time. */
export function dateTime(value: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return undefined;
  if (!realDate(Number(match[1]), Number(match[2]), Number(match[3]))) return undefined;
  if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return undefined;
  return match[0];
}

/** Either shape is accepted where the helper takes a date: a bare day means an all-day value. */
export function dateOrDay(value: string): string | undefined {
  return dateTime(value) ?? dateOnly(value);
}

function realDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** A count the owner named, bounded to what the tool promised. `undefined` means "not a count". */
export function count(value: string | undefined, fallback: number, max: number): number | undefined {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (!/^\d+$/.test(text)) return undefined;
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  return Math.min(number, max);
}

/**
 * The helper's reply, or the sentence to say instead.
 *
 * Nothing here throws. A helper that answered with something unparseable is a fault, and the
 * owner should hear about it in one readable line rather than as a crashed tool.
 */
export function parseJson(raw: string, subject: string): unknown | undefined {
  const text = String(raw ?? '').trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function unreadable(subject: string): string {
  return `I could not read ${subject}'s reply, so I have nothing to tell you from it. Nothing was changed.`;
}

interface EventJson {
  id?: unknown;
  title?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  calendar?: unknown;
  isAllDay?: unknown;
  notes?: unknown;
  location?: unknown;
  attendees?: unknown;
  recurrenceRules?: unknown;
}

interface ReminderJson {
  id?: unknown;
  title?: unknown;
  list?: unknown;
  dueDate?: unknown;
  startDate?: unknown;
  notes?: unknown;
  isCompleted?: unknown;
  priority?: unknown;
  completionDate?: unknown;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function rows(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>)[key])) {
    return (value as Record<string, unknown>)[key] as unknown[];
  }
  return [];
}

/** `2026-11-04 09:00:00` reads the way the owner says it; a bare day is an all-day value. */
function when(value: unknown): string {
  const text = str(value);
  return text ? text.replace('T', ' ').replace(/\.\d+/, '').replace(/([+-]\d{2}:?\d{2}|Z)$/, '').trim() : '';
}

/** One event, on one line, with the id the update and delete tools need to name it again. */
export function eventLine(value: unknown): string {
  const event = (value ?? {}) as EventJson;
  const title = str(event.title) || '(no title)';
  const calendar = str(event.calendar);
  const start = when(event.startDate);
  const end = when(event.endDate);
  const allDay = event.isAllDay === true;
  const place = str(event.location);
  const bits = [`- ${title}`];
  bits.push(calendar ? `in ${calendar}` : 'with no calendar');
  if (start) bits.push(allDay ? `on ${start.slice(0, 10)} (all day)` : `from ${start}${end ? ` to ${end}` : ''}`);
  if (place) bits.push(`at ${place}`);
  const people = Array.isArray(event.attendees) ? event.attendees.length : 0;
  bits.push(people ? `with ${people} other ${people === 1 ? 'person' : 'people'}` : 'with nobody else on it');
  const repeats = Array.isArray(event.recurrenceRules) ? event.recurrenceRules.length > 0 : Boolean(event.recurrenceRules);
  bits.push(repeats ? 'and it repeats' : 'and it does not repeat');
  const id = str(event.id);
  return `${bits.join(' ')} [id ${id || 'unknown'}]`;
}

/** One reminder, on one line, with its list, its due date and its id. */
export function reminderLine(value: unknown): string {
  const reminder = (value ?? {}) as ReminderJson;
  const title = str(reminder.title) || '(no title)';
  const list = str(reminder.list);
  const due = when(reminder.dueDate);
  const bits = [`- ${title}`, list ? `in ${list}` : 'with no list'];
  bits.push(due ? `due ${due}` : 'with no due date');
  bits.push(reminder.isCompleted === true ? 'and already done' : 'and still open');
  const notes = str(reminder.notes);
  if (notes) bits.push(`notes: ${notes.replace(/\s+/g, ' ').slice(0, 120)}`);
  const id = str(reminder.id);
  return `${bits.join(' ')} [id ${id || 'unknown'}]`;
}

/** A list of events inside a date window, newest first is the calendar's own order. */
export function formatEvents(raw: string): string {
  const parsed = parseJson(raw, 'Calendar');
  if (parsed === undefined) return unreadable('Calendar');
  const events = rows(parsed, 'events').filter(row => row && typeof row === 'object');
  if (!events.length) return 'There is nothing on your calendar in that window.';
  return [`${events.length} event(s):`, ...events.map(eventLine)].join('\n');
}

/**
 * Search is done here, on the helper's own JSON, and not in a second helper call.
 *
 * The window is what the helper was asked for; the words are what the owner said. Doing it in
 * this process means the cap on how much is read and the cap on how much comes back are both
 * visible in one place, and a match is never a second trip that could disagree with the first.
 */
export function formatEventSearch(raw: string, query: string, max: number): string {
  const parsed = parseJson(raw, 'Calendar');
  if (parsed === undefined) return unreadable('Calendar');
  const wanted = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const events = rows(parsed, 'events').filter(row => row && typeof row === 'object');
  const hits = events.filter(row => {
    const event = row as EventJson;
    const haystack = `${str(event.title)} ${str(event.notes)} ${str(event.location)}`.toLowerCase();
    return wanted.every(word => haystack.includes(word));
  });
  if (!hits.length) {
    return `No event in that window matches "${query}". ${events.length} event(s) were looked at.`;
  }
  const shown = hits.slice(0, max);
  const more = hits.length > shown.length ? ` (showing the first ${shown.length} of ${hits.length})` : '';
  return [`${hits.length} event(s) match "${query}"${more}:`, ...shown.map(eventLine)].join('\n');
}

/** One event, read in full: notes and who is on it are the reason to read one. */
export function formatOneEvent(raw: string): string {
  const parsed = parseJson(raw, 'Calendar');
  if (parsed === undefined) return unreadable('Calendar');
  const event = (Array.isArray(parsed) ? parsed[0] : parsed) as EventJson | undefined;
  if (!event || typeof event !== 'object') return 'I could not find that event.';
  const people = Array.isArray(event.attendees) ? event.attendees : [];
  const lines = [eventLine(event)];
  const notes = str(event.notes);
  if (notes) lines.push(`Notes: ${notes}`);
  if (people.length) {
    lines.push(`On it: ${people.map(person => {
      const row = (person ?? {}) as { name?: unknown; url?: unknown; status?: unknown };
      return `${str(row.name) || str(row.url) || 'someone'} (${str(row.status) || 'no reply yet'})`;
    }).join(', ')}`);
  }
  return lines.join('\n');
}

/** A write's proof: what the helper says it changed, in the owner's words. */
export function formatEventWrite(raw: string, verb: string): string {
  const parsed = parseJson(raw, 'Calendar');
  if (parsed === undefined) return unreadable('Calendar');
  const event = (Array.isArray(parsed) ? parsed[0] : parsed) as EventJson | undefined;
  if (!event || typeof event !== 'object') return `Calendar did not say what it ${verb}. Nothing may have changed.`;
  return `Calendar says it ${verb} this event:\n${eventLine(event)}`;
}

export function formatReminders(raw: string): string {
  const parsed = parseJson(raw, 'Reminders');
  if (parsed === undefined) return unreadable('Reminders');
  const reminders = rows(parsed, 'reminders').filter(row => row && typeof row === 'object');
  if (!reminders.length) return 'There are no reminders like that.';
  return [`${reminders.length} reminder(s):`, ...reminders.map(reminderLine)].join('\n');
}

export function formatReminderSearch(raw: string, keyword: string, max: number): string {
  const parsed = parseJson(raw, 'Reminders');
  if (parsed === undefined) return unreadable('Reminders');
  const wanted = String(keyword ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const reminders = rows(parsed, 'reminders').filter(row => row && typeof row === 'object');
  const hits = reminders.filter(row => {
    const reminder = row as ReminderJson;
    const haystack = `${str(reminder.title)} ${str(reminder.notes)}`.toLowerCase();
    return wanted.every(word => haystack.includes(word));
  });
  if (!hits.length) return `No reminder matches "${keyword}". ${reminders.length} reminder(s) were looked at.`;
  const shown = hits.slice(0, max);
  const more = hits.length > shown.length ? ` (showing the first ${shown.length} of ${hits.length})` : '';
  return [`${hits.length} reminder(s) match "${keyword}"${more}:`, ...shown.map(reminderLine)].join('\n');
}

export function formatOneReminder(raw: string): string {
  const parsed = parseJson(raw, 'Reminders');
  if (parsed === undefined) return unreadable('Reminders');
  const reminder = (Array.isArray(parsed) ? parsed[0] : parsed) as ReminderJson | undefined;
  if (!reminder || typeof reminder !== 'object') return 'I could not find that reminder.';
  const lines = [reminderLine(reminder)];
  const notes = str(reminder.notes);
  if (notes) lines.push(`Notes: ${notes}`);
  return lines.join('\n');
}

export function formatReminderWrite(raw: string, verb: string): string {
  const parsed = parseJson(raw, 'Reminders');
  if (parsed === undefined) return unreadable('Reminders');
  const reminder = (Array.isArray(parsed) ? parsed[0] : parsed) as ReminderJson | undefined;
  if (!reminder || typeof reminder !== 'object') return `Reminders did not say what it ${verb}. Nothing may have changed.`;
  return `Reminders says it ${verb} this reminder:\n${reminderLine(reminder)}`;
}

export function formatLists(raw: string, what: string): string {
  const parsed = parseJson(raw, what);
  if (parsed === undefined) return unreadable(what);
  const lists = rows(parsed, 'lists').filter(row => row && typeof row === 'object');
  if (!lists.length) return `There are no ${what === 'Calendar' ? 'calendars' : 'reminder lists'}.`;
  return lists.map(row => {
    const list = row as { title?: unknown; id?: unknown; source?: unknown; eventCount?: unknown };
    const parts = [`- ${str(list.title) || '(no title)'}`];
    if (str(list.source)) parts.push(`from ${str(list.source)}`);
    if (typeof list.eventCount === 'number') parts.push(`with ${list.eventCount} event(s)`);
    return parts.join(' ');
  }).join('\n');
}