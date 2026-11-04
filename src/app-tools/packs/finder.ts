import type { AppPack, AppTool, AppToolArg, AppToolPlan } from '../types.js';
import { asStr } from '../applescript.js';

/**
 * The Finder pack: read-only listings of a folder on this Mac.
 *
 * Why this file exists: the owner asks "what did I download today" and "where is the invoice
 * file", and the companion can answer neither from a screenshot of the desktop. Finder's own
 * scripting dictionary exposes `every item of <folder>`, and each item carries `name`, `kind`
 * and `modification date`, so a listing answer can be built from the listing itself rather than
 * from what happens to be visible.
 *
 * Read-only by construction. Finder is where a wrong write is destructive: a `delete`, a `move`
 * or a `make new` here touches the owner's real files, so no tool in this pack contains one.
 * A rename in Finder is a `set name of`, which is why the tests pin the absence of that shape
 * too.
 *
 * Measured notes about this app (macOS 27.0.1):
 * - `path to downloads folder` and the other `path to ... folder` results are aliases, and
 *   `every item of <alias>` inside `tell application "Finder"` returns the folder's contents.
 * - `POSIX file "/absolute/path"` also resolves inside Finder; `exists` reports whether it
 *   exists, so a path the owner typed can be refused in words instead of erroring.
 * - `kind of` an item is "Folder" for a folder and the document kind for a file, which is what
 *   the answer shows.
 * - an unknown folder name is refused before the app is touched, because guessing which folder
 *   the owner meant is how a listing answer turns into the wrong listing.
 */

/** Items scanned in one listing. An unbounded folder of 50,000 files holds the turn open. */
const SCAN_CAP = 400;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

/** A plan that changes nothing and says why, in a sentence the owner can read. */
function refuse(sentence: string): AppToolPlan {
  return { kind: 'osascript', script: `return ${asStr(sentence)}\n` };
}

/** A whole positive number, clamped to a safe maximum, or undefined when it is not one. */
function wholeNumber(value: unknown, fallback: number, max: number): number | undefined {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1) return undefined;
  return Math.min(n, max);
}

/**
 * The well-known folder names the owner actually says, mapped to AppleScript.
 *
 * "Music" is deliberately absent: the Music app is a separate pack, and a folder word that also
 * names an app would drag the wrong pack's tools into a Finder request.
 */
const FOLDER_ALIASES: Record<string, string> = {
  downloads: 'path to downloads folder',
  download: 'path to downloads folder',
  desktop: 'path to desktop folder',
  documents: 'path to documents folder',
  document: 'path to documents folder',
  home: 'path to home folder',
  pictures: 'path to pictures folder',
  picture: 'path to pictures folder',
  movies: 'path to movies folder',
  movie: 'path to movies folder',
  public: 'path to public folder',
};

/** The AppleScript expression for a folder the owner named, or undefined when it is unknown. */
function folderExpression(raw: string): string | undefined {
  const text = String(raw ?? '').trim();
  if (!text) return 'path to downloads folder';
  if (text.startsWith('/')) return `POSIX file ${asStr(text)}`;
  const key = text.toLowerCase().replace(/\s+folder$/, '').trim();
  return FOLDER_ALIASES[key];
}

/** How the folder reads in the answer, in the owner's terms. */
function folderLabel(raw: string): string {
  const text = String(raw ?? '').trim();
  if (!text) return 'the downloads folder';
  if (text.startsWith('/')) return `the folder at ${text}`;
  const key = text.toLowerCase().replace(/\s+folder$/, '').trim();
  return `the ${key} folder`;
}

/**
 * Newest first, over the two parallel lists a listing builds.
 *
 * `every item of` is not ordered by modification date, so dates and rendered lines are kept in
 * two lists and sorted together. A bubble sort is deliberate: AppleScript has no list sort and
 * the scan is capped. The `n > 1` guard is not optional: `repeat with i from 1 to n - 1` counts
 * down when the end is below the start, so a one-item folder would try `item 0` of an empty list.
 */
function sortNewestFirst(): string {
  return (
    `set n to count of dates\n` +
    `if n > 1 then\n` +
    `\trepeat with i from 1 to n - 1\n` +
    `\t\trepeat with j from 1 to n - i\n` +
    `\t\t\tif (item j of dates) < (item (j + 1) of dates) then\n` +
    `\t\t\t\tset keepDate to item j of dates\n` +
    `\t\t\t\tset item j of dates to item (j + 1) of dates\n` +
    `\t\t\t\tset item (j + 1) of dates to keepDate\n` +
    `\t\t\t\tset keepLine to item j of lines\n` +
    `\t\t\t\tset item j of lines to item (j + 1) of lines\n` +
    `\t\t\t\tset item (j + 1) of lines to keepLine\n` +
    `\t\t\tend if\n` +
    `\t\tend repeat\n` +
    `\tend repeat\n` +
    `end if\n`
  );
}

const folderArg: AppToolArg = {
  name: 'folder',
  description:
    'Which folder to read, either a well-known name such as Downloads, Desktop or Documents, or a full path beginning with a slash. Leave empty for the downloads folder.',
};

const finderRecent: AppTool = {
  name: 'finder_recent',
  pack: 'finder',
  app: 'Finder',
  bundleId: 'com.apple.finder',
  description:
    "List the files and folders in one folder on this Mac, newest first, and return each item's " +
    'name, its kind and when it was last changed. Use this when the owner asks what they ' +
    'downloaded recently, what is new in their downloads, or which files they have been working ' +
    'on. It reads a folder listing and nothing else: it never moves, renames, opens or deletes a ' +
    'file, and it never changes a folder. It starts in the downloads folder unless the owner ' +
    'names another folder, never looks inside subfolders, and returns at most ' +
    MAX_LIMIT +
    ' items. Returns one line per item, most recently changed first.',
  args: [folderArg, {
    name: 'limit',
    description: `How many of the newest items to return, for example 10. Leave empty for ${DEFAULT_LIMIT}; ${MAX_LIMIT} is the most allowed.`,
  }],
  examples: [
    'what did i download recently',
    'show me the newest files in my downloads',
    'what files are in my desktop folder',
    'list the files i worked on today',
  ],
  keywords: [
    'downloads',
    'download',
    'recent files',
    'newest files',
    'my files',
    'desktop',
    'folder',
    'finder',
    'what did i download',
  ],
  // A search by name is the other tool's job, and a destructive verb must never reach this one.
  notFor: ['find a file', 'search for a file', 'delete a file', 'move my files'],
  writes: false,
  plan: args => {
    const limit = wholeNumber(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
    if (limit === undefined) {
      return refuse(`The limit has to be a whole number of items, like 10, or left empty for the ${DEFAULT_LIMIT} most recent.`);
    }
    const target = folderExpression(String(args.folder ?? ''));
    if (!target) {
      return refuse('That folder name is not one I read by name. Name Downloads, Desktop, Documents, Home, Pictures, Movies or Public, or give the full path beginning with a slash.');
    }
    const label = folderLabel(String(args.folder ?? ''));
    return {
      kind: 'osascript',
      script:
        `set cap to ${limit}\n` +
        `set scanCap to ${SCAN_CAP}\n` +
        `set target to ${target}\n` +
        `tell application "Finder"\n` +
        `\ttry\n` +
        `\t\tset theItems to every item of target\n` +
        `\ton error\n` +
        `\t\treturn "That location is not a folder I can read, so nothing was read out."\n` +
        `\tend try\n` +
        `\tset total to count of theItems\n` +
        `\tif total is 0 then return "That folder is empty, so there was nothing to read out."\n` +
        `\tset scan to total\n` +
        `\tif scan > scanCap then set scan to scanCap\n` +
        `\tset dates to {}\n` +
        `\tset lines to {}\n` +
        `\trepeat with i from 1 to scan\n` +
        `\t\tset r to item i of theItems\n` +
        `\t\tset end of dates to (modification date of r)\n` +
        `\t\tset end of lines to ((name of r) & " - " & (kind of r) & " - " & (modification date of r as string))\n` +
        `\tend repeat\n` +
        sortNewestFirst() +
        `\tset out to {}\n` +
        `\trepeat with i from 1 to (count of lines)\n` +
        `\t\tif (count of out) is greater than or equal to cap then exit repeat\n` +
        `\t\tset end of out to (item i of lines)\n` +
        `\tend repeat\n` +
        `end tell\n` +
        `if (count of out) is 0 then return "Nothing was read out of that folder."\n` +
        `set {oldDelims, AppleScript's text item delimiters} to {AppleScript's text item delimiters, return}\n` +
        `set body to out as text\n` +
        `set AppleScript's text item delimiters to oldDelims\n` +
        `return "Showing " & (count of out) & " item(s) in " & ${asStr(label)} & ", most recently changed first:" & return & body\n`,
    };
  },
};

const finderFind: AppTool = {
  name: 'finder_find',
  pack: 'finder',
  app: 'Finder',
  bundleId: 'com.apple.finder',
  description:
    'Look for files and folders whose name contains a word the owner gives, inside one folder on ' +
    'this Mac, and return the name, the kind and the modified date of each match. Use this when ' +
    'the owner asks to find a file, asks where a file went, or asks whether a named file is in a ' +
    'folder. It matches the name of the item, not the words inside the file, and it looks only ' +
    'at the top level of that folder: it never looks inside subfolders, so a file buried two ' +
    'folders down is not reported. It reads listings only and never moves, opens, renames or ' +
    'deletes anything. It starts in the downloads folder unless the owner names another folder, ' +
    'and returns at most ' +
    MAX_LIMIT +
    ' matches.',
  args: [
    { name: 'query', description: 'The word or short phrase to look for in the file names, as the owner said it.', required: true },
    folderArg,
    {
      name: 'limit',
      description: `How many matches to return, for example 10. Leave empty for ${DEFAULT_LIMIT}; ${MAX_LIMIT} is the most allowed.`,
    },
  ],
  examples: [
    'find the file called invoice',
    'where is the file named budget',
    'search my documents folder for the invoice',
    'is there a file called passport in my downloads',
  ],
  keywords: [
    'find a file',
    'search files',
    'filename',
    'where is',
    'documents',
    'downloads',
    'folder',
    'file',
  ],
  // The newest-items listing and the destructive verbs are other tools or no tool at all.
  notFor: ['recent files', 'newest files', 'delete a file', 'open the file'],
  writes: false,
  plan: args => {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return refuse('I need the word or phrase to look for in the file names, so nothing was looked for.');
    }
    const limit = wholeNumber(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
    if (limit === undefined) {
      return refuse(`The limit has to be a whole number of matches, like 10, or left empty for the ${DEFAULT_LIMIT} newest.`);
    }
    const target = folderExpression(String(args.folder ?? ''));
    if (!target) {
      return refuse('That folder name is not one I read by name. Name Downloads, Desktop, Documents, Home, Pictures, Movies or Public, or give the full path beginning with a slash.');
    }
    const label = folderLabel(String(args.folder ?? ''));
    return {
      kind: 'osascript',
      script:
        `set cap to ${limit}\n` +
        `set q to ${asStr(query)}\n` +
        `set target to ${target}\n` +
        `set hits to {}\n` +
        `tell application "Finder"\n` +
        `\ttry\n` +
        `\t\tset theItems to every item of target\n` +
        `\ton error\n` +
        `\t\treturn "That location is not a folder I can search, so nothing was looked for."\n` +
        `\tend try\n` +
        `\tif (count of theItems) is 0 then return "That folder is empty, so nothing was found."\n` +
        `\trepeat with k in theItems\n` +
        `\t\tset r to contents of k\n` +
        `\t\tif (name of r contains q) then\n` +
        `\t\t\tset end of hits to ((name of r) & " - " & (kind of r) & " - " & (modification date of r as string))\n` +
        `\t\t\tif (count of hits) is greater than or equal to cap then exit repeat\n` +
        `\t\tend if\n` +
        `\tend repeat\n` +
        `end tell\n` +
        `if (count of hits) is 0 then return "No item in " & ${asStr(label)} & " has a name containing " & q & "."\n` +
        `set {oldDelims, AppleScript's text item delimiters} to {AppleScript's text item delimiters, return}\n` +
        `set body to hits as text\n` +
        `set AppleScript's text item delimiters to oldDelims\n` +
        `return "Found " & (count of hits) & " item(s) in " & ${asStr(label)} & " whose name contains " & q & ":" & return & body\n`,
    };
  },
};

export const FINDER_PACK: AppPack = {
  id: 'finder',
  app: 'Finder',
  bundleId: 'com.apple.finder',
  summary: 'Read recent files and find files by name in one folder, without ever moving or deleting anything.',
  tools: [finderRecent, finderFind],
};

export default FINDER_PACK;