import type { AppPack, AppTool, AppToolArg, AppToolPlan } from '../types.js';
import { asStr } from '../applescript.js';

/**
 * The Notes pack: the owner's notes as a read/write API.
 *
 * Why this file exists (roadmap: docs/app-tool-apis.md): the owner asked "Give me summary of
 * all the notes" and the companion answered with the accessibility labels of the visible Notes
 * window, because pointing and clicking can read chrome but not content. Every tool here goes
 * through the Notes scripting dictionary, so an answer about what a note says can be built from
 * what the note actually says. The rule from the plan holds: an answer must come from a read
 * that could have produced it.
 *
 * Measured notes about this app (macOS 27.0.1, dictionary at /tmp/sdef_Notes.xml):
 * - the application class carries `note`, `folder` and `account` elements; a note has `name`,
 *   `id`, `body` (writable, HTML), `plaintext` (read-only, the text a person sees),
 *   `modification date` and `container` (its folder).
 * - `every note`, `note "Name"`, `notes of folder "X"` all work; `make new note at folder "X"
 *   with properties {name, body}` works.
 * - reading uses `plaintext`, because the owner asks about what a note says; the write tools
 *   set `body`, which is the writable property, then read `plaintext` back to prove the change.
 * - a plain `every note` on a large library is slow, so the list scan is capped at SCAN_CAP and
 *   the description says so.
 * - a missing Automation grant surfaces as error -1743 / "not authorised"; the caller maps that
 *   to a permission sentence, so these scripts only have to fail honestly.
 *
 * Traps this file encodes, not just documents:
 * - `plaintext` is read-only and `body` is HTML. A write reads the old body first and refuses
 *   when the note carries something the round trip would destroy (an attachment, a checklist, a
 *   native tag): writing an HTML body back from `plaintext` would bake the image placeholders
 *   in as text.
 * - Notes writes can land more than twenty seconds late, or never, so every write tool reads
 *   the note back and reports what it found instead of assuming the change took.
 * - `every note` probes the whole library, so the plaintext of only the newest few is fetched
 *   (the scan collects names and ntDates first, sorts those, then reads the bodies it will send).
 */

/** Notes read in one scan. An unbounded `every note` on a large library holds the turn open. */
const SCAN_CAP = 300;
/** Notes whose text one answer is built from. The owner asked for "all the notes"; this is the
 *  most that can be sent without turning the answer into a dump. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 20;
/** Characters of note text one `notes_recent` answer may carry, in total. */
const BODY_BUDGET = 60000;
const DEFAULT_READ = 4000;
const MAX_READ = 40000;
/** Characters of the changed text quoted back as proof of a write. */
const PROOF_CHARS = 40;

/**
 * A plan that changes nothing and says why, in a sentence the owner can read.
 *
 * Argument validation is a refusal, not a thrown exception: a model that passed "lots" for a
 * limit should get a readable sentence back from the tool, the same as a live refusal, rather
 * than a crash in the caller. `plan()` therefore never throws for a bad argument.
 */
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
 * Newest first, over the three parallel lists the scan builds.
 *
 * `every note` is not ordered by modification date, so the ntDates, the rendered ntHeaders and the
 * note references are kept in three lists and sorted together here. The ntDates were already read
 * from Notes, so the sort does no more work in the app. A bubble sort is deliberate: AppleScript
 * has no list sort built in and the list is capped. The `total > 1` guard is not optional:
 * `repeat with i from 1 to total - 1` counts *down* when the end is below the start, so a
 * one-note or empty library would try `item 0` of an empty list.
 */
function sortNewestFirst(): string {
  return (
    `set total to count of ntDates\n` +
    `if total > 1 then\n` +
    `\trepeat with i from 1 to total - 1\n` +
    `\t\trepeat with j from 1 to total - i\n` +
    `\t\t\tif (item j of ntDates) < (item (j + 1) of ntDates) then\n` +
    `\t\t\t\tset keepDate to item j of ntDates\n` +
    `\t\t\t\tset item j of ntDates to item (j + 1) of ntDates\n` +
    `\t\t\t\tset item (j + 1) of ntDates to keepDate\n` +
    `\t\t\t\tset keepLine to item j of ntHeaders\n` +
    `\t\t\t\tset item j of ntHeaders to item (j + 1) of ntHeaders\n` +
    `\t\t\t\tset item (j + 1) of ntHeaders to keepLine\n` +
    `\t\t\t\tset keepRef to item j of ntRefs\n` +
    `\t\t\t\tset item j of ntRefs to item (j + 1) of ntRefs\n` +
    `\t\t\t\tset item (j + 1) of ntRefs to keepRef\n` +
    `\t\t\tend if\n` +
    `\t\tend repeat\n` +
    `\tend repeat\n` +
    `end if\n`
  );
}

/** The lines that find exactly one named note, or return a refusal sentence. */
function findOneNamedNote(name: string): string {
  return (
    `set sought to ${asStr(name)}\n` +
    `set hits to (every note whose name is sought)\n` +
    // `every note` includes the Recently Deleted folder, and a name that exists only in the trash
    // is not a note this can read, change or delete. Comparing the container object is what
    // survives a library where the folder is not called "Recently Deleted" in English.
    `set deadFolder to missing value\n` +
    `try\n` +
    `\tset deadFolder to first folder whose name is "Recently Deleted"\n` +
    `end try\n` +
    `set liveHits to {}\n` +
    `repeat with h in hits\n` +
    `\ttry\n` +
    `\t\tset r to contents of h\n` +
    `\t\tif deadFolder is missing value or (container of r) is not deadFolder then set end of liveHits to r\n` +
    `\tend try\n` +
    `end repeat\n` +
    `if (count of liveHits) is 0 then return "There is no note called " & sought & ", so nothing was changed."\n` +
    `if (count of liveHits) is greater than 1 then return "There are " & (count of liveHits) & " notes called " & sought & ", so nothing was changed: say which one you mean."\n` +
    `set n to item 1 of liveHits\n`
  );
}

/** The first line of a body is what Apple Notes shows as the note's name. */
function noteTitle(text: string): string {
  const first = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0);
  const title = (first ?? text.trim()).slice(0, 120);
  return title || 'Untitled note';
}

/**
 * Refuse a body write when the note carries something the HTML round trip would destroy.
 *
 * `body` is HTML and `plaintext` is not: writing `plaintext` back as the body loses the parts
 * that have no plain text. Rather than silently flatten a note that holds an image, a checklist
 * or a native tag, the script stops before it writes anything and says why.
 */
function refuseLossyBody(): string {
  return (
    `\tcopy (body of n) to oldB\n` +
    `\tif (length of oldB) > 400000 then return "That note is very large (" & (length of oldB) & " characters of HTML), so nothing was changed: this tool will not rewrite a note whose body looks like it holds an attachment or an image."\n` +
    `\tif (oldB contains "<img") or (oldB contains "<table") or (oldB contains "<object") or (oldB contains "attachment") then return "That note holds an attachment, a checklist, an image or an embedded object, so nothing was changed: rewriting the text here would drop it."\n`
  );
}

const recentArgs: AppToolArg[] = [
  {
    name: 'limit',
    description: `How many of the newest notes to return, for example 10. Leave empty for ${DEFAULT_LIMIT}, which is also the most allowed.`,
  },
];

const notesRecent: AppTool = {
  name: 'notes_recent',
  pack: 'notes',
  app: 'Notes',
  bundleId: 'com.apple.Notes',
  description:
    'List the notes in Apple Notes, newest first, and return each note\'s name, its folder, when ' +
    'it was last changed and the note\'s own text. Use this when the owner asks to summarise ' +
    'their notes, asks for a summary of all the notes, asks what they have written recently, or ' +
    'asks to see, show or list their notes. Do not use this when the owner wants one named note ' +
    'read in full, or wants to search every note for a word: reading one note and searching are ' +
    'separate tools. It reads at most the first ' + SCAN_CAP + ' notes, returns at most ' +
    DEFAULT_LIMIT + ' notes and stops once it has sent about ' + BODY_BUDGET + ' characters, ' +
    'saying so rather than quietly dropping notes, and it never creates, changes or deletes a ' +
    'note. Returns one block per note, newest first.',
  args: recentArgs,
  examples: [
    'summarise all my notes',
    'give me a summary of all the notes',
    'show me my notes',
    'what notes do I have',
  ],
  keywords: [
    'notes',
    'summary',
    'summarise my notes',
    'all my notes',
    'list my notes',
    'show my notes',
    'what did i write',
    'everything i wrote',
  ],
  // The list answers across notes; a question about one note's text belongs to the read tool.
  notFor: ['read the whole note', 'what does the note say'],
  writes: false,
  plan: args => {
    const limit = wholeNumber(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
    if (limit === undefined) {
      return refuse('The limit has to be a whole number of notes, like 10, or left empty for the most recent notes.');
    }
    return {
      kind: 'osascript',
      // The answer is built from the note texts, so it carries them: 600 characters would be
      // three notes and the summary the owner asked for could not be made from it.
      outputChars: BODY_BUDGET + 2000,
      script:
        `set cap to ${limit}\n` +
        `set scanCap to ${SCAN_CAP}\n` +
        `set budget to ${BODY_BUDGET}\n` +
        `set ntDates to {}\n` +
        `set ntHeaders to {}\n` +
        `set ntRefs to {}\n` +
        `set seen to 0\n` +
        `tell application "Notes"\n` +
        `\trepeat with n in notes\n` +
        `\t\tset seen to seen + 1\n` +
        `\t\tif seen > scanCap then exit repeat\n` +
        `\t\tset r to contents of n\n` +
        `\t\tcopy (name of r) to nm\n` +
        `\t\tif nm is "" then set nm to "untitled note"\n` +
        `\t\tset fd to missing value\n` +
        `\t\ttry\n` +
        `\t\t\tset cA to container of r\n` +
        `\t\t\tset fd to name of cA\n` +
        `\t\tend try\n` +
        // `every note` includes the ones the owner deleted: they sit in the Recently Deleted
        // folder and would otherwise show up in "summarise all my notes" (measured live
        // 2026-11-04: 3 of 14 notes were trash). Reading a trashed note's container fails, so a
        // note whose folder cannot be read is left out too rather than shown as "unknown folder".
        `\t\tif fd is not missing value and fd is not "Recently Deleted" then\n` +
        `\t\t\tset end of ntDates to modification date of r\n` +
        `\t\t\tset end of ntHeaders to "### " & nm & " (folder: " & fd & ", modified: " & (modification date of r as string) & ")"\n` +
        `\t\t\tset end of ntRefs to r\n` +
        `\t\tend if\n` +
        `\tend repeat\n` +
        sortNewestFirst() +
        `\tset out to {}\n` +
        `\tset used to 0\n` +
        `\tif total > 0 then\n` +
        `\t\trepeat with k from 1 to total\n` +
        `\t\t\tif (count of out) is greater than or equal to cap then exit repeat\n` +
        `\t\t\tset ln to item k of ntHeaders & return\n` +
        `\t\t\tset room to budget - used - (length of ln)\n` +
        `\t\t\tif room is less than 1 then exit repeat\n` +
        `\t\t\tcopy (plaintext of (item k of ntRefs)) to tx\n` +
        `\t\t\tif (length of tx) is 0 then\n` +
        `\t\t\t\tset ln to ln & "(empty note)"\n` +
        `\t\t\telse if (length of tx) is greater than room then\n` +
        `\t\t\t\tset ln to ln & (text 1 thru room of tx) & " [cut off here: the note continues]"\n` +
        `\t\t\telse\n` +
        `\t\t\t\tset ln to ln & tx\n` +
        `\t\t\tend if\n` +
        `\t\t\tset used to used + (length of ln)\n` +
        `\t\t\tset end of out to ln\n` +
        `\t\tend repeat\n` +
        `\tend if\n` +
        `end tell\n` +
        `if (count of out) is 0 then return "There are no notes in the first " & scanCap & " notes of Apple Notes."\n` +
        `set {oldDelims, AppleScript's text item delimiters} to {AppleScript's text item delimiters, return}\n` +
        `set body to out as text\n` +
        `set AppleScript's text item delimiters to oldDelims\n` +
        `return "Showing " & (count of out) & " note(s), newest first, with their text, out of the first " & scanCap & " scanned:" & return & body\n`,
    };
  },
};

const readArgs: AppToolArg[] = [
  {
    name: 'name',
    description: 'The note\'s name, normally its first line, exactly as the owner calls it.',
  },
  {
    name: 'id',
    description: 'The note\'s id, when it is known. Use instead of the name when the name is ambiguous.',
  },
  {
    name: 'chars',
    description: `How many characters of the note to return, at most ${MAX_READ}. Leave empty for ${DEFAULT_READ}.`,
  },
];

const notesRead: AppTool = {
  name: 'notes_read',
  pack: 'notes',
  app: 'Notes',
  bundleId: 'com.apple.Notes',
  description:
    'Read the text of one note in Apple Notes, found by its name or its id, and return what it ' +
    'actually says. Use this when the owner asks what a note says, what they wrote about ' +
    'something, or asks for the content or the details of one note. Do not use this when the ' +
    'owner wants a list of notes, or a summary across many notes: this reads one note at a time. ' +
    'It only reads; it never creates, changes or deletes a note, and it never touches a folder. ' +
    'Returns the note\'s name and its text (up to the character limit the caller asked for), and ' +
    'says plainly when the note is empty rather than returning an empty result.',
  args: readArgs,
  examples: [
    'what did I write about the roof',
    'read my note about the plumber',
    'what does the note about the invoice say',
  ],
  keywords: [
    'read my note',
    'note content',
    'what did i write',
    'what does my note say',
    'note text',
    'full text',
    'read a note',
    'the whole note',
  ],
  // A summary across notes is the list tool's job, not one note's text.
  notFor: ['summarise all my notes', 'add to my note', 'delete my note'],
  writes: false,
  plan: args => {
    const byName = String(args.name ?? '').trim();
    const byId = String(args.id ?? '').trim();
    if (!byName && !byId) {
      return refuse('I need the name or the id of the note to read. Tell me which note you mean.');
    }
    const chars = wholeNumber(args.chars, DEFAULT_READ, MAX_READ);
    if (chars === undefined) {
      return refuse(`The character limit has to be a whole number, or left empty for the first ${DEFAULT_READ} characters.`);
    }
    // The id is the stronger key, so it wins when both are given.
    const key = byId ? 'id' : 'name';
    const sought = byId || byName;
    const lead =
      key === 'id'
        ? `"The note with id " & sought`
        : `"The note called " & nm`;
    return {
      kind: 'osascript',
      script:
        `set sought to ${asStr(sought)}\n` +
        `set cap to ${chars}\n` +
        `tell application "Notes"\n` +
        `\tset hits to (every note whose ${key} is sought)\n` +
        `\tif (count of hits) is 0 then return ${key === 'id' ? `"There is no note with id " & sought & "."` : `"There is no note called " & sought & "."`}\n` +
        `\tset n to item 1 of hits\n` +
        `\tcopy (name of n) to nm\n` +
        `\tcopy (plaintext of n) to tx\n` +
        `\tset total to length of tx\n` +
        `\tset lead to ${lead}\n` +
        `\tif (count of hits) is greater than 1 then set lead to "(first of " & (count of hits) & ") " & lead\n` +
        `\tif total is 0 then return lead & " is empty: it has no text."\n` +
        `\tif total is greater than cap then\n` +
        `\t\tset shown to text 1 thru cap of tx\n` +
        `\t\treturn lead & " has " & total & " characters; the first " & cap & " are:" & return & shown\n` +
        `\tend if\n` +
        `\treturn lead & " has " & total & " characters:" & return & tx\n` +
        `end tell\n`,
    };
  },
};

/**
 * `notes_create_note` moved here from `packs.ts` by the integrator so this app's tools live in
 * one file. The name is unchanged: retrieval, the golden rows and the live transcripts all use it.
 */
const notesCreate: AppTool = {
  name: 'notes_create_note',
  pack: 'notes',
  app: 'Notes',
  bundleId: 'com.apple.Notes',
  description:
    'Create a new note in Apple Notes and put the given text in its body. Use this when the owner ' +
    'asks to write, note down, jot, save or take down something and the destination is Notes. ' +
    'It always creates a new note, in the folder Apple Notes uses by default; it does not append ' +
    'to an existing note and it does not type into the note that is on screen. It creates through ' +
    'Apple Notes itself rather than keystrokes, so the text can never land in a search box or in ' +
    'the wrong note. Returns the name of the note it created and the folder it landed in.',
  args: [
    { name: 'body', description: "The owner's words for the note body, written out in full.", required: true },
  ],
  examples: [
    'write a note that the roof is leaking',
    'note down tomorrow meeting at 5pm',
    'jot this in notes: call the landlord on tuesday',
  ],
  keywords: ['note', 'notes', 'write', 'jot', 'save', 'remember', 'take down', 'note down', 'memo', 'remind me to', 'keep a record'],
  // Asking to find a note is not asking to write one: the words overlap completely, and a
  // wrong write is worse than a wrong answer. Live on 2026-11-03 the only Notes tool was
  // create, so this is what keeps "find my note about the roof" from making a second note.
  notFor: ['find a note', 'look for a note', 'search my notes', 'show my notes'],
  writes: true,
  plan: args => {
    const text = String(args.body ?? '');
    if (!text.trim()) return refuse('There is nothing to write, so no note was created. Tell me what the note should say.');
    // Measured 2026-11-04 on this Mac: `make new note with properties {body:...}` lands in the
    // default folder, but the note's `name` then reads back as the whole body flattened onto one
    // line, so setting `name` explicitly is what keeps the note addressable by what it says.
    const title = noteTitle(text);
    return {
      kind: 'osascript',
      script:
        `set theText to ${asStr(text)}\n` +
        `tell application "Notes"\n` +
        `\tset fresh to make new note with properties {body:theText}\n` +
        `\tset name of fresh to ${asStr(title)}\n` +
        // The container is read in two steps and through a try: reading `name of container of fresh`
        // in one expression failed live on 2026-11-04 (-1728) right after the note was made.
        `\tset folderName to "Notes"\n` +
        `\ttry\n` +
        `\t\tset freshFolder to container of fresh\n` +
        `\t\tset folderName to name of freshFolder\n` +
        `\tend try\n` +
        `\tset freshId to id of fresh\n` +
        `end tell\n` +
        `return "Wrote the note " & ${asStr(title)} & " in " & folderName & "."\n`,
    };
  },
};

/** `notes_find` moved here from `packs.ts` by the integrator; the name is unchanged. */
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
    'not the note bodies; if the owner needs the words of one note, reading that note is the ' +
    'better tool.',
  args: [
    { name: 'query', description: 'The single word or short phrase to look for, as the owner said it.', required: true },
  ],
  examples: [
    // Deliberately not the create tool's "the roof is leaking" sentence: sharing an example
    // sentence made a write request match this read tool, which is the same collision that put
    // the Ashitosh calendar sentence in front of the note tool.
    'find my note about the plumber',
    'find the note about the roof',
    'search my notes for invoice 442',
    'do I have a note about the dentist',
  ],
  keywords: ['note', 'notes', 'find', 'search', 'look for', 'where is', 'titles that mention', 'did i write'],
  // A request to see or list the notes wants the notes themselves, which is the recent tool's
  // job: this one answers with matching titles only, so it stands down for those words.
  notFor: ['show my notes', 'list my notes'],
  // Read only, and it says so: the previous search tool drove the interface and typed into the
  // note that happened to be open. This one sends one AppleScript read and touches no keystroke.
  writes: false,
  plan: args => ({
    kind: 'osascript',
    // Titles and bodies are compared with `whose`, which Apple Notes answers itself: the manual
    // 300-note scan this replaced timed out at 20s live (2026-11-04). `notes` at the application
    // level is real: /tmp/sdef_Notes.xml:49 lists <element type="note"> on the application class.
    script:
      `set q to ${asStr(String(args.query ?? ''))}\n` +
      `set hits to {}\n` +
      `tell application "Notes"\n` +
      `\tset deadFolder to missing value\n` +
      `\ttry\n` +
      `\t\tset deadFolder to first folder whose name is "Recently Deleted"\n` +
      `\tend try\n` +
      `\tset byName to every note whose name contains q\n` +
      `\tset byBody to every note whose body contains q\n` +
      `\trepeat with n in byName\n` +
      `\t\tset r to contents of n\n` +
      `\t\tif deadFolder is missing value or (container of r) is not deadFolder then\n` +
      `\t\t\tset t to (name of r)\n` +
      `\t\t\tif t is "" then set t to "untitled note"\n` +
      `\t\t\tset end of hits to t\n` +
      `\t\tend if\n` +
      `\t\tif (count of hits) is greater than or equal to 8 then exit repeat\n` +
      `\tend repeat\n` +
      `\tif (count of hits) is less than 8 then\n` +
      `\t\trepeat with n in byBody\n` +
      `\t\t\tset r to contents of n\n` +
      `\t\t\tif deadFolder is missing value or (container of r) is not deadFolder then\n` +
      `\t\t\t\tset t to (name of r)\n` +
      `\t\t\t\tif t is "" then set t to "untitled note"\n` +
      `\t\t\t\tif hits does not contain t then set end of hits to t\n` +
      `\t\t\tend if\n` +
      `\t\t\tif (count of hits) is greater than or equal to 8 then exit repeat\n` +
      `\t\tend repeat\n` +
      `\tend if\n` +
      `end tell\n` +
      `if (count of hits) is 0 then return "no note mentions " & q\n` +
      `return hits\n`,
  }),
};

const writeArgs: AppToolArg[] = [
  { name: 'name', description: 'The name of the note to change, normally its first line.', required: true },
  { name: 'text', description: 'The words to put into the note, written out in full.', required: true },
];

const notesAppend: AppTool = {
  name: 'notes_append',
  pack: 'notes',
  app: 'Notes',
  bundleId: 'com.apple.Notes',
  description:
    'Add text to the end of a note that already exists in Apple Notes, keeping everything that ' +
    'is already in it. Use this when the owner asks to add to, append to, or add more to a note ' +
    'they already have. Do not use this when the note does not exist yet, or when the owner ' +
    'wants to replace what the note says: this only adds, and replacing the text is a separate ' +
    'tool. It changes the note, so it reads the note first, refuses when several notes share the name or ' +
    'the note holds an attachment or checklist, and reads the note back afterwards. Returns the ' +
    'note\'s name, its new length and the start of the new text as proof, and says plainly when ' +
    'it refused to change anything.',
  args: writeArgs,
  examples: [
    'add to my note about the roof: the builder starts tuesday',
    'append the invoice number to my shopping note',
    'add these lines to the meeting note',
  ],
  keywords: [
    'append',
    'add to my note',
    'add more',
    'add to the note',
    'append to note',
    'continue the note',
    'add these lines',
    'notes',
  ],
  // Adding is not reading, replacing or deleting, and the words overlap heavily.
  notFor: ['read my note', 'update my note', 'delete my note'],
  writes: true,
  plan: args => {
    const name = String(args.name ?? '').trim();
    const text = String(args.text ?? '');
    if (!name) return refuse('I need the name of the note to add to. Tell me which note you mean.');
    if (!text.trim()) return refuse('There is no text to add, so nothing was added. Tell me what to add.');
    return {
      kind: 'osascript',
      script:
        `set extra to ${asStr(text)}\n` +
        `tell application "Notes"\n` +
        findOneNamedNote(name) +
        refuseLossyBody() +
        `\tcopy (plaintext of n) to beforeText\n` +
        `\tcopy (name of n) to nm\n` +
        `\tset newB to oldB & "<div><br></div><div>" & extra & "</div>"\n` +
        `\tset body of n to newB\n` +
        // Setting the body makes the note's `name` read back as the whole text flattened onto one
        // line (measured 2026-11-04), which would leave the note unaddressable by the name the
        // owner knows. The name was read before the write, and setting it back keeps it findable.
        `\tset name of n to nm\n` +
        `\tcopy (plaintext of n) to nowText\n` +
        `\tset total to length of nowText\n` +
        `\tset shown to nowText\n` +
        `\tif total > ${PROOF_CHARS} then set shown to text 1 thru ${PROOF_CHARS} of nowText\n` +
        `\tif total is (length of beforeText) then return "The add to " & nm & " did not take: the note is still " & total & " characters."\n` +
        `\treturn "Added to " & nm & ": it now has " & total & " characters and starts " & shown\n` +
        `end tell\n`,
    };
  },
};

const notesUpdate: AppTool = {
  name: 'notes_update',
  pack: 'notes',
  app: 'Notes',
  bundleId: 'com.apple.Notes',
  description:
    'Replace the whole text of a note that already exists in Apple Notes with new text. Use this ' +
    'when the owner asks to update, change, rewrite, correct or replace what a note says. Do not ' +
    'use this when the owner only wants to add something and leave the old text in place: this ' +
    'discards what the note said before, and adding is a separate tool. It changes the note, so it reads the ' +
    'current text first, refuses when several notes share the name or the note holds an ' +
    'attachment or checklist, and reads the note back afterwards. Returns the note\'s name, its ' +
    'old and new lengths and the start of the new text as proof, and says plainly when it ' +
    'refused to change anything.',
  args: writeArgs,
  examples: [
    'update my note about the roof to say the leak is fixed',
    'rewrite my shopping note',
    'change the meeting note to tuesday at 4',
  ],
  keywords: [
    'update my note',
    'change my note',
    'rewrite the note',
    'replace the note',
    'edit the note',
    'correct the note',
    'overwrite the note',
    'notes',
  ],
  // Replacing a note is not adding to it, reading it or deleting it.
  notFor: ['add to my note', 'read my note', 'delete my note'],
  writes: true,
  plan: args => {
    const name = String(args.name ?? '').trim();
    const text = String(args.text ?? '');
    if (!name) return refuse('I need the name of the note to update. Tell me which note you mean.');
    if (!text.trim()) return refuse('The new text is empty, so nothing was replaced. Tell me what the note should say.');
    return {
      kind: 'osascript',
      script:
        `set replacement to ${asStr(text)}\n` +
        `tell application "Notes"\n` +
        findOneNamedNote(name) +
        refuseLossyBody() +
        `\tcopy (name of n) to nm\n` +
        `\tcopy (plaintext of n) to beforeText\n` +
        `\tset body of n to replacement\n` +
        // The note's name follows the first line of its body, and setting the body makes the name
        // read back as the whole flattened text (measured 2026-11-04). Setting the title from the
        // new first line is what keeps the note addressable by what it now says.
        `\tset name of n to ${asStr(noteTitle(text))}\n` +
        `\tcopy (plaintext of n) to afterText\n` +
        `\tset total to length of afterText\n` +
        `\tif total is 0 then return "The update did not take: " & nm & " is now empty."\n` +
        `\tset shown to afterText\n` +
        `\tif total > ${PROOF_CHARS} then set shown to text 1 thru ${PROOF_CHARS} of afterText\n` +
        `\treturn "Updated " & nm & " from " & (length of beforeText) & " to " & total & " characters; it now starts " & shown\n` +
        `end tell\n`,
    };
  },
};

const notesDelete: AppTool = {
  name: 'notes_delete',
  pack: 'notes',
  app: 'Notes',
  bundleId: 'com.apple.Notes',
  description:
    'Delete one note from Apple Notes, but only when the owner has confirmed that exact note ' +
    'name. Use this when the owner asks to delete, remove or get rid of one note they have ' +
    'named. Do not use this when the owner wants to delete a folder, several notes, or a note ' +
    'they have not named: this deletes exactly one named note, never a folder and never a group, ' +
    'and it is not usable for bulk deletion. It reads the note first, requires the confirm ' +
    'argument to be identical to the note\'s name, and refuses when the name is missing, shared ' +
    'by several notes, or not confirmed. Returns the deleted note\'s name and its length as ' +
    'proof, and says plainly when nothing was deleted.',
  args: [
    { name: 'name', description: 'The name of the single note to delete, normally its first line.', required: true },
    { name: 'confirm', description: 'The same note name again, typed by the owner, to prove the deletion is intended.', required: true },
  ],
  examples: [
    'delete the note called shopping list',
    'delete my note about the old roof quote',
    'remove the note called meeting minutes',
  ],
  keywords: [
    'delete note',
    'remove note',
    'delete my note',
    'get rid of the note',
    'trash a note',
    'discard the note',
    'delete a note',
    'notes',
  ],
  // Bulk deletion is not a thing this tool does, and a folder is never a note.
  notFor: ['delete all notes', 'delete the folder', 'add to my note'],
  writes: true,
  plan: args => {
    const name = String(args.name ?? '').trim();
    const confirm = String(args.confirm ?? '').trim();
    if (!name) return refuse('I need the name of the single note to delete. Tell me which note you mean.');
    if (!confirm) return refuse('Nothing was deleted: a delete needs the note name typed again as the confirmation.');
    if (confirm !== name) {
      return refuse(`Nothing was deleted: the confirmation "${confirm}" does not match the note name "${name}".`);
    }
    return {
      kind: 'osascript',
      script:
        `set confirmation to ${asStr(confirm)}\n` +
        `set sought to ${asStr(name)}\n` +
        `if confirmation is not sought then return "Nothing was deleted: the confirmation does not match the note name."\n` +
        `tell application "Notes"\n` +
        findOneNamedNote(name) +
        `\tcopy (name of n) to nm\n` +
        `\tcopy (plaintext of n) to tx\n` +
        // `size` is a class in Notes' own dictionary (measured live 2026-11-04: `Can't set size to 36`),
        // so the local that reports the deleted note's length cannot be called that.
        `\tset ntSize to length of tx\n` +
        `\tdelete n\n` +
        `end tell\n` +
        `return "Deleted the note " & nm & " (" & ntSize & " characters)."\n`,
    };
  },
};

export const NOTES_PACK: AppPack = {
  id: 'notes',
  app: 'Notes',
  bundleId: 'com.apple.Notes',
  summary: 'List, read, find, add, update and delete notes in Apple Notes, so questions about note content are answered from the note text.',
  tools: [notesRecent, notesRead, notesFind, notesCreate, notesAppend, notesUpdate, notesDelete],
};

export default NOTES_PACK;