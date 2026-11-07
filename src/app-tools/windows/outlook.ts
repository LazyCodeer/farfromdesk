import type { AppPack, AppTool } from '../types.js';
import { CALENDAR_PACK } from '../packs/calendar.js';
import { REMINDERS_PACK } from '../packs/reminders.js';
import { MAIL_PACK } from '../packs/mail.js';
import { checked, retarget, win, wholeNumber } from './plans.js';

/**
 * Calendar, tasks and mail on Windows, through classic Outlook on this PC.
 *
 * The owner chose Outlook desktop because it is already signed in to their accounts and it is
 * scriptable over COM; Microsoft 365 through Graph is a later step. Each call runs
 * `native/app-tools-windows.ps1` once (see that file for why it is one process per call). When
 * Outlook has no account set up, or only the new Outlook app is installed, the helper answers
 * with a sentence saying so instead of failing.
 *
 * Calendar and Reminders keep the macOS tools' names, arguments, checks and formatters: the
 * helper's `eventkit` operation takes the same argument array as the EventKit helper and answers
 * in the same JSON. Reminders are Outlook tasks (the Tasks folder and its subfolders, which is
 * also what Microsoft To Do syncs into for a work or Microsoft account).
 */

const tool = (pack: AppPack, name: string): AppTool => {
  const found = pack.tools.find(candidate => candidate.name === name);
  if (!found) throw new Error(`The ${name} tool is missing from the ${pack.id} pack.`);
  return found;
};

const CALENDAR_WORDS: [string | RegExp, string][] = [
  ['Search Apple Calendar', 'Search the Outlook calendars'],
  ['Apple Calendar', 'Outlook calendar'],
  ["the Mac's local time", "the PC's local time"],
  ['as it is written in Calendar', 'as it is written in Outlook'],
  ['Returns the summary Calendar reports back.', 'Returns the event Outlook reports back.'],
];

const calendarTools = CALENDAR_PACK.tools.map(mac => retarget(mac, { app: 'Outlook', pairs: CALENDAR_WORDS, extraKeywords: ['outlook'] }));

export const OUTLOOK_CALENDAR_PACK: AppPack = {
  id: 'calendar',
  app: 'Outlook',
  summary: 'Find, read, add, move and delete events in the Outlook calendar, with the risky changes guarded.',
  tools: calendarTools,
};

const TASK_WORDS: [string | RegExp, string][] = [
  [' and whether they are flagged', ''],
  [' or whether it is flagged', ''],
  [', set a priority or flag one', ' or set a priority'],
  ['Apple Reminders', 'Outlook Tasks'],
  ['the app is Reminders', 'the app is Outlook Tasks or To Do'],
  ['Returns the name Reminders reports back.', 'Returns the task Outlook reports back. Outlook keeps only the day of a due date.'],
  ['reminder lists', 'task folders'],
];

const taskTools = REMINDERS_PACK.tools.map(mac => retarget(mac, { app: 'Outlook', pairs: TASK_WORDS, extraKeywords: ['task', 'tasks', 'to do', 'outlook'] }));

export const OUTLOOK_TASKS_PACK: AppPack = {
  id: 'reminders',
  app: 'Outlook',
  summary: 'List and read tasks, add one, mark one done, change one, or delete one in Outlook Tasks.',
  tools: taskTools,
};

const MAIL_WORDS: [string | RegExp, string][] = [
  ['in a Mail mailbox', 'in an Outlook mail folder'],
  ['a Mail mailbox', 'an Outlook mail folder'],
  ['Create a draft message in Mail', 'Create a draft message in Outlook'],
  ['the newest messages Mail returns', 'the newest messages Outlook returns'],
  ['drafts mailbox', 'Drafts folder'],
  ['as it appears in Mail', 'as it appears in Outlook'],
  ['Mail can take a moment', 'Outlook can take a moment'],
  ['mailbox', 'mail folder'],
  ['INBOX', 'Inbox'],
];

const MAIL_SCAN = 300;
const mailRecent = tool(MAIL_PACK, 'mail_recent');
const mailFind = tool(MAIL_PACK, 'mail_find');
const mailRead = tool(MAIL_PACK, 'mail_read');
const mailDraft = tool(MAIL_PACK, 'mail_draft');

const mailTools: AppTool[] = [
  retarget(mailRecent, {
    app: 'Outlook', pairs: MAIL_WORDS, extraKeywords: ['outlook', 'email'],
    plan: args => checked(mailRecent, args, () => {
      const limit = wholeNumber(args.limit, 10, 25) ?? 10;
      return win('mail-recent', { limit, folder: String(args.mailbox ?? '').trim(), scan: MAIL_SCAN, slice: 400 }, { outputChars: 800 * limit + 2000 });
    }),
  }),
  retarget(mailFind, {
    app: 'Outlook', pairs: MAIL_WORDS, extraKeywords: ['outlook', 'email'],
    plan: args => checked(mailFind, args, () => win('mail-find', { query: String(args.query ?? '').trim(), folder: String(args.mailbox ?? '').trim(), scan: MAIL_SCAN, max: 12 }, { outputChars: 4000 })),
  }),
  retarget(mailRead, {
    app: 'Outlook', pairs: MAIL_WORDS, extraKeywords: ['outlook', 'email'],
    plan: args => checked(mailRead, args, () => {
      const chars = wholeNumber(args.chars, 4000, 40000) ?? 4000;
      return win('mail-read', { subject: String(args.subject ?? '').trim(), sender: String(args.sender ?? '').trim(), chars, scan: MAIL_SCAN }, { outputChars: chars + 600 });
    }),
  }),
  retarget(mailDraft, {
    app: 'Outlook', pairs: MAIL_WORDS, extraKeywords: ['outlook', 'email'],
    plan: args => checked(mailDraft, args, () => win('mail-draft', { to: String(args.to ?? '').trim(), subject: String(args.subject ?? '').trim(), body: String(args.body ?? '') }, { outputChars: 1000 })),
  }),
];

export const OUTLOOK_MAIL_PACK: AppPack = {
  id: 'mail',
  app: 'Outlook',
  summary: 'Read the newest Outlook messages, search them and read one in full, and draft a new message without ever sending it.',
  tools: mailTools,
};
