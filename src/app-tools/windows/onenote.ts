import type { AppPack, AppTool } from '../types.js';
import { NOTES_PACK } from '../packs/notes.js';
import { checked, retarget, say, win, wholeNumber } from './plans.js';

/**
 * Notes on Windows are OneNote pages.
 *
 * Why OneNote and not Sticky Notes: OneNote for Windows (the Microsoft 365 desktop app) has a
 * documented COM interface (`OneNote.Application`: GetHierarchy, GetPageContent, CreateNewPage,
 * UpdatePageContent, DeleteHierarchy) that reads and writes pages without a window. Sticky Notes
 * has no scripting interface at all: its notes live in the app's private, cloud-synced store, and
 * writing that store behind the app's back risks losing the owner's notes. So the tools name
 * OneNote, and when only the Store OneNote or no OneNote is installed the helper says so.
 *
 * A note's name is its page title. A new note goes to the section OneNote uses for quick notes
 * (the one Win+Alt+N writes to). Replacing a page's whole text is not offered on Windows: a
 * OneNote page can hold ink, images and tables that a text rewrite would drop. Deleting a page
 * sends it to the notebook's own recycle bin, where OneNote keeps it for 60 days.
 */

const mac = (name: string): AppTool => {
  const found = NOTES_PACK.tools.find(candidate => candidate.name === name);
  if (!found) throw new Error(`The ${name} tool is missing from the notes pack.`);
  return found;
};

const WORDS: [string | RegExp, string][] = [
  ['the folder Apple Notes uses by default', 'the section OneNote uses for quick notes'],
  ['the folder it landed in', 'the section it landed in'],
  ['Apple Notes', 'OneNote'],
];

const recent = mac('notes_recent');
const read = mac('notes_read');
const find = mac('notes_find');
const create = mac('notes_create_note');
const append = mac('notes_append');
const remove = mac('notes_delete');

const notesTools: AppTool[] = [
  retarget(recent, {
    app: 'OneNote', extraKeywords: ['onenote', 'page', 'pages'],
    description:
      'List the pages in OneNote, newest first, and return each page\'s name, its notebook and ' +
      'section, when it was last changed and the page\'s own text. Use this when the owner asks to ' +
      'summarise their notes, asks for a summary of all the notes, asks what they have written ' +
      'recently, or asks to see, show or list their notes. Do not use this when the owner wants one ' +
      'named note read in full, or wants to search every note for a word: reading one note and ' +
      'searching are separate tools. It returns at most 20 pages and stops once it has sent about ' +
      '60000 characters, saying so rather than quietly dropping pages, and it never creates, changes ' +
      'or deletes a page. Returns one block per page, newest first.',
    plan: args => checked(recent, args, () => {
      const limit = wholeNumber(args.limit, 20, 20) ?? 20;
      return win('notes-recent', { limit, budget: 60000 }, { outputChars: 64000 });
    }),
  }),
  retarget(read, {
    app: 'OneNote', pairs: WORDS, extraKeywords: ['onenote', 'page'],
    plan: args => checked(read, args, () => {
      const chars = wholeNumber(args.chars, 4000, 40000) ?? 4000;
      return win('notes-read', { name: String(args.name ?? '').trim(), id: String(args.id ?? '').trim(), chars }, { outputChars: chars + 600 });
    }),
  }),
  retarget(find, {
    app: 'OneNote', extraKeywords: ['onenote', 'page'],
    description:
      'Look through OneNote for pages whose title or text mentions a word or phrase, and list their ' +
      'titles. Use this when the owner asks to find, search or look for a note, asks where a note ' +
      'went, or asks what they wrote about something. This tool only reads: it never creates, edits, ' +
      'deletes, opens or moves a page, and it never types. It uses OneNote\'s own search and falls ' +
      'back to the page titles when that search is not available, and returns at most 8 titles, not ' +
      'the page text; if the owner needs the words of one note, reading that note is the better tool.',
    plan: args => {
      const query = String(args.query ?? '').trim();
      if (!query) return say('I need a word or phrase to look for in your notes.');
      return win('notes-find', { query, max: 8 }, { outputChars: 3000 });
    },
  }),
  retarget(create, {
    app: 'OneNote', pairs: WORDS, extraKeywords: ['onenote', 'page'],
    plan: args => checked(create, args, () => win('notes-create', { body: String(args.body ?? '') }, { outputChars: 600 })),
  }),
  retarget(append, {
    app: 'OneNote', extraKeywords: ['onenote', 'page'],
    description:
      'Add text to the end of a page that already exists in OneNote, keeping everything that is ' +
      'already on it. Use this when the owner asks to add to, append to, or add more to a note they ' +
      'already have. Do not use this when the note does not exist yet: this only adds. It changes ' +
      'the page, so it finds it first, refuses when several pages share the name, adds the text as ' +
      'new lines after the page\'s first block of text and reads the page back afterwards. Returns ' +
      'the page\'s name and its new length as proof, and says plainly when it refused to change anything.',
    plan: args => checked(append, args, () => win('notes-append', { name: String(args.name ?? '').trim(), text: String(args.text ?? '') }, { outputChars: 800 })),
  }),
  retarget(remove, {
    app: 'OneNote', extraKeywords: ['onenote', 'page'],
    description:
      'Delete one page from OneNote, but only when the owner has confirmed that exact page name. Use ' +
      'this when the owner asks to delete, remove or get rid of one note they have named. Do not use ' +
      'this when the owner wants to delete a section, a notebook, several notes, or a note they have ' +
      'not named: this deletes exactly one named page and is not usable for bulk deletion. It finds ' +
      'the page first, requires the confirm argument to be identical to the page\'s name, and refuses ' +
      'when the name is missing, shared by several pages, or not confirmed. OneNote keeps a deleted ' +
      'page in the notebook\'s recycle bin. Returns the deleted page\'s name and its length as proof.',
    plan: args => checked(remove, args, () => win('notes-delete', { name: String(args.name ?? '').trim(), confirm: String(args.confirm ?? '').trim() }, { outputChars: 600 })),
  }),
];

export const ONENOTE_PACK: AppPack = {
  id: 'notes',
  app: 'OneNote',
  summary: 'List, read, find, add to and delete pages in OneNote, so questions about note content are answered from the page text.',
  tools: notesTools,
};
