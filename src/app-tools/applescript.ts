/**
 * AppleScript literal helpers, shared by every pack.
 *
 * Why this is its own file: `packs.ts` owns the registry, so a pack file that imported these
 * helpers from `packs.ts` created a cycle (packs -> pack -> packs) and, on some import orders,
 * a `ReferenceError: Cannot access 'NOTES_PACK' before initialization`. The helpers are a leaf
 * module, so every pack can import them and the registry can import every pack.
 */

/**
 * Turns a value into an AppleScript string literal. Owner text goes into scripts, so quotes
 * and backslashes have to be escaped rather than trusted.
 */
export function asStr(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

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