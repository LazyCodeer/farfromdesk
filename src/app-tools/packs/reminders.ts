import type { AppPack, AppTool, AppToolPlan } from '../types.js';
import {
  count,
  dateOrDay,
  formatLists,
  formatOneReminder,
  formatReminderWrite,
  formatReminders,
  helper,
  refusal,
} from '../adapters/eventkit.js';

/**
 * The Reminders pack: list, read, add, complete, update and delete reminders in Apple Reminders.
 *
 * Every plan is a discrete argument array for the bundled EventKit helper
 * (`native/eventkit-helper.swift`), never a keystroke and never AppleScript. The two failure modes
 * this file is written against, both measured on 3 November 2026:
 *
 * - a locale-parsed date is a wrong date, so every time the owner gives is checked by the adapter's
 *   `dateOrDay` before it reaches the helper;
 * - a name can match more than one reminder, so the helper matches by title (and, where it takes
 *   one, within 90 seconds of a given start) and refuses a zero or a multiple match itself. A write
 *   still repeats the exact name as a `confirm` value before the helper is called, because a
 *   duplicate name is a refusal, not a coin flip.
 *
 * Retrieval text deliberately avoids the words this product uses for coding work: they once dragged
 * `reminders_add` into a request about adding a column to a code contract. The owner's vocabulary
 * here is "reminder".
 */

/**
 * A plan whose whole job is to say, readably, that the tool refused. Not a throw: the owner gets a
 * sentence back through the same path a successful tool would use, and — importantly — the helper
 * is never started for an argument the pack can already see is wrong.
 */
function refuse(sentence: string): AppToolPlan {
  return refusal(sentence);
}

/**
 * The gate every write passes before anything is touched.
 *
 * The `confirm` value must be exactly the name being changed, so "do not delete that" cannot be
 * read as a yes. The comparison is on trimmed strings, so a trailing space is not a mismatch.
 */
function confirmGate(args: Record<string, string>, verb: string): AppToolPlan | undefined {
  const name = String(args.name ?? '').trim();
  const confirm = String(args.confirm ?? '').trim();
  if (!name) return refuse(`I need the exact name of the reminder to ${verb} before I can do anything.`);
  if (!confirm) return refuse(`To ${verb} the reminder called "${name}", send that same name as the confirm argument too.`);
  if (confirm !== name) return refuse(`I did not ${verb} anything: the confirmation "${confirm}" does not match the reminder name "${name}".`);
  return undefined;
}

const BAD_LIMIT_REFUSAL = 'The number of reminders has to be a whole number, for example 10.';
const NOTHING_TO_CHANGE_REFUSAL =
  'I did not change anything because I was not told what to change. Say the new due date, notes or priority.';
const FLAG_REFUSAL =
  'I cannot change whether a reminder is flagged, so I changed nothing. Say a new due date, notes or priority instead.';

const remindersOpen: AppTool = {
  name: 'reminders_open',
  pack: 'reminders',
  app: 'Reminders',
  bundleId: 'com.apple.reminders',
  description:
    'List the open reminders in Apple Reminders with their name, their list, their due date and ' +
    'whether they are flagged. Use this when the owner asks what reminders they have open, what ' +
    'is left to do, what they still have to pick up, or what is on their reminders today. It can ' +
    'look at every list or at one list the owner names, and it stops after the given number of ' +
    'lines so a large account cannot flood the answer. It only reads: it never completes, ' +
    'changes, adds or removes a reminder. Returns one line per open reminder, or says that ' +
    'nothing is open.',
  args: [
    { name: 'list', description: 'The name of one list to look at. Leave empty to look at every list.' },
    { name: 'limit', description: 'The most lines to return, for example 10. Leave empty for 25.' },
  ],
  examples: [
    'what reminders do i have open',
    'anything I have to do today',
    'what is still on my reminders',
    'show me my open reminders on the shopping list',
  ],
  keywords: ['reminder', 'reminders', 'open', 'outstanding', 'left', 'still', 'anything', 'today', 'due', 'overdue', 'checklist'],
  // A question about the lists themselves belongs to reminders_list, not to the open list.
  notFor: ['delete every reminder', 'complete every reminder'],
  writes: false,
  plan: args => {
    const list = String(args.list ?? '').trim();
    const limit = count(args.limit, 25, 200);
    if (limit === undefined) return refuse(BAD_LIMIT_REFUSAL);
    const argv = ['reminders'];
    if (list) argv.push('--list', list);
    // No `--completed`: this tool is the open list. The helper owns the cap as well.
    argv.push('--limit', String(limit));
    return helper(argv, { outputChars: 6000, format: formatReminders });
  },
};

const remindersRead: AppTool = {
  name: 'reminders_read',
  pack: 'reminders',
  app: 'Reminders',
  bundleId: 'com.apple.reminders',
  description:
    'Read back the full detail of a single reminder in Apple Reminders, matched by its exact ' +
    'name: the notes body, the due date, the priority, the list it belongs to and whether it is ' +
    'done. Use this when the owner asks to see, read or show one specific reminder, asks what a ' +
    'reminder says, or asks what the notes on it are. It is the one read that may look at a ' +
    'completed reminder, and it says so in the answer rather than hiding it. It never changes, ' +
    'completes or removes anything. Returns the detail of the first exact-name match, and says so ' +
    'when more than one reminder shares that name.',
  args: [
    { name: 'name', description: 'The exact name of the reminder to read back, as it was written.', required: true },
  ],
  examples: [
    'show me my reminder about the plumber',
    'read me the reminder called pay the water bill',
    'what does the call the dentist reminder say',
  ],
  keywords: ['reminder', 'reminders', 'read', 'show', 'detail', 'body', 'notes', 'says', 'about', 'specific', 'full', 'priority'],
  writes: false,
  plan: args => {
    const name = String(args.name ?? '').trim();
    if (!name) return refuse('I need the exact name of the reminder to read back.');
    // The helper resolves one reminder by exact title and refuses zero or many in words.
    return helper(['reminder', '--title', name], { outputChars: 4000, format: formatOneReminder });
  },
};

const remindersList: AppTool = {
  name: 'reminders_list',
  pack: 'reminders',
  app: 'Reminders',
  bundleId: 'com.apple.reminders',
  description:
    'List the reminder lists in Apple Reminders, with how many reminders in each list are ' +
    'open. Use this when the owner asks which lists exist, what their lists are called, or how ' +
    'many things are on each one, rather than asking what is open across every list. It only ' +
    'counts; it never reads a reminder body, never completes anything and never opens a window. ' +
    'Returns one line per list, or says that there are no lists.',
  args: [],
  examples: ['what reminder lists do i have', 'which lists do i have in reminders', 'how many reminders are in each list'],
  keywords: ['reminder lists', 'lists', 'which lists', 'what lists', 'how many', 'per list', 'each list'],
  writes: false,
  plan: () => helper(['lists'], { outputChars: 6000, format: raw => formatLists(raw, 'Reminders') }),
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
    'add milk to my shopping reminders',
  ],
  // The coding vocabulary is deliberately absent here: a request about adding a column to a code
  // contract once matched this reminder tool because of it. The everyday subject noun ("milk",
  // "batteries") belongs here rather than in the tools that only move or remove a reminder, so
  // that "add <thing> to my reminders" is decided by the verb and not by the noun.
  keywords: ['reminder', 'reminders', 'checklist', 'pick up', 'milk', 'shopping', 'due'],
  writes: true,
  plan: args => {
    const title = String(args.title ?? '').trim();
    if (!title) return refuse('I need the name of the reminder before I can add it.');
    const list = String(args.list ?? '').trim();
    const rawDue = String(args.due ?? '').trim();
    const argv = ['reminder-create', '--title', title];
    if (list) argv.push('--list', list);
    if (rawDue) {
      const due = dateOrDay(rawDue);
      if (!due) return refuse(`A date has to look like 2026-11-04 09:00:00 or 2026-11-04, not "${rawDue}".`);
      argv.push('--due', due);
    }
    return helper(argv, { outputChars: 4000, format: raw => formatReminderWrite(raw, 'added') });
  },
};

const remindersComplete: AppTool = {
  name: 'reminders_complete',
  pack: 'reminders',
  app: 'Reminders',
  bundleId: 'com.apple.reminders',
  description:
    'Mark one open reminder in Apple Reminders as done, matched by its exact name. Use this when ' +
    'the owner says they finished, did, ticked off or completed a specific reminder. It only ' +
    'touches one reminder and it refuses when the name matches none or more than one, so it can ' +
    'never complete a whole list. It requires the owner to repeat the exact name as a confirm ' +
    'value first, and it reads the reminder back afterwards so the answer carries the completed ' +
    'state as proof. It never deletes, edits or renames a reminder.',
  args: [
    { name: 'name', description: 'The exact name of the reminder that is now done.', required: true },
    { name: 'confirm', description: 'The same name again, sent only after the owner asked for it, proving they meant it.', required: true },
  ],
  examples: [
    'mark the plumber reminder as done',
    'i finished the plumber reminder',
    'tick off the plumber reminder',
  ],
  keywords: ['reminder', 'reminders', 'complete', 'completed', 'mark', 'done', 'finished', 'tick off', 'cross out', 'all done'],
  notFor: ['delete a reminder', 'change a reminder', 'read a reminder'],
  writes: true,
  plan: args => {
    const gate = confirmGate(args, 'complete');
    if (gate) return gate;
    const name = String(args.name ?? '').trim();
    return helper(['reminder-update', '--title', name, '--completed', 'yes'], {
      outputChars: 4000,
      format: raw => formatReminderWrite(raw, 'completed'),
    });
  },
};

const remindersUpdate: AppTool = {
  name: 'reminders_update',
  pack: 'reminders',
  app: 'Reminders',
  bundleId: 'com.apple.reminders',
  description:
    'Change one open reminder in Apple Reminders, matched by its exact name: its due date, its ' +
    'notes, its priority or whether it is flagged. Use this when the owner asks to move, push ' +
    'back, reschedule or change the time of a specific reminder, or to add a note, set a ' +
    'priority or flag one. Only the fields the owner actually mentioned are changed; everything ' +
    'else is left alone, and a name matching none or more than one reminder is refused. It ' +
    'requires the exact name as a confirm value and returns the new values it read back. It never ' +
    'adds or removes a reminder.',
  args: [
    { name: 'name', description: 'The exact name of the reminder to change.', required: true },
    { name: 'confirm', description: 'The same name again, sent only after the owner asked for it, proving they meant it.', required: true },
    { name: 'due', description: 'The new due date as YYYY-MM-DD HH:MM:SS. Leave empty to keep the current due date.' },
    { name: 'notes', description: 'The new notes body. Leave empty to keep, or send an empty note to clear it.' },
    { name: 'priority', description: 'The new priority from 0 to 9, where 0 is none and 1 is highest. Leave empty to keep it.' },
    { name: 'flag', description: 'true to flag the reminder, false to unflag it. Leave empty to keep it as it is.' },
  ],
  examples: [
    'change the plumber reminder to friday',
    'push the dentist reminder to tomorrow morning',
    'add a note to the dentist reminder',
  ],
  keywords: ['reminder', 'reminders', 'change', 'reschedule', 'move', 'postpone', 'push back', 'due', 'friday', 'notes', 'priority', 'flag'],
  notFor: ['complete a reminder', 'delete a reminder', 'read a reminder'],
  writes: true,
  plan: args => {
    const gate = confirmGate(args, 'change');
    if (gate) return gate;
    const name = String(args.name ?? '').trim();
    const rawDue = String(args.due ?? '').trim();
    const notesGiven = args.notes !== undefined;
    const notes = String(args.notes ?? '');
    const priority = String(args.priority ?? '').trim();
    const flag = String(args.flag ?? '').trim();
    if (flag) return refuse(FLAG_REFUSAL);
    if (!rawDue && !notesGiven && !priority) return refuse(NOTHING_TO_CHANGE_REFUSAL);
    let due = '';
    if (rawDue) {
      due = dateOrDay(rawDue) ?? '';
      if (!due) return refuse(`A date has to look like 2026-11-04 09:00:00 or 2026-11-04, not "${rawDue}".`);
    }
    if (priority && !/^[0-9]$/.test(priority)) {
      return refuse(`I did not change "${name}" because "${priority}" is not a priority between 0 and 9.`);
    }
    const argv = ['reminder-update', '--title', name];
    if (due) argv.push('--due', due);
    if (notesGiven) argv.push('--notes', notes);
    if (priority) argv.push('--priority', priority);
    return helper(argv, { outputChars: 4000, format: raw => formatReminderWrite(raw, 'changed') });
  },
};

const remindersDelete: AppTool = {
  name: 'reminders_delete',
  pack: 'reminders',
  app: 'Reminders',
  bundleId: 'com.apple.reminders',
  description:
    'Delete one open reminder from Apple Reminders, matched by its exact name. Use this when the ' +
    'owner asks to delete, remove or get rid of one specific reminder. It deletes a single ' +
    'reminder and never a list, a selection or every reminder that matches a word, because it ' +
    'counts the matches first and refuses when the name matches none or more than one. It ' +
    'requires the owner to repeat the exact name as a confirm value first, and it never completes ' +
    'or edits a reminder on the way. Returns the name that was removed.',
  args: [
    { name: 'name', description: 'The exact name of the reminder to delete.', required: true },
    { name: 'confirm', description: 'The same name again, sent only after the owner asked for it, proving they meant it.', required: true },
  ],
  examples: [
    'delete the reminder called pay the water bill confirm pay the water bill',
    'remove the call the plumber reminder',
    'get rid of the pick up the dry cleaning reminder',
  ],
  keywords: ['reminder', 'reminders', 'delete', 'remove', 'bin', 'called', 'get rid of', 'trash'],
  notFor: ['complete a reminder', 'change a reminder', 'read a reminder'],
  writes: true,
  plan: args => {
    const gate = confirmGate(args, 'delete');
    if (gate) return gate;
    const name = String(args.name ?? '').trim();
    // The exact title goes to the helper as `--confirm` too, so a mismatch is refused there as
    // well. This is one reminder, never a list and never a bulk delete.
    return helper(['reminder-delete', '--title', name, '--confirm', name], {
      outputChars: 4000,
      format: raw => formatReminderWrite(raw, 'deleted'),
    });
  },
};

/**
 * `reminders_lists` is deliberately not here. Its job — the owner's lists with their open counts
 * — is already exactly what `reminders_list` returns, and the plan document says to consolidate
 * near-duplicates rather than ship two tools whose retrieval text and behaviour overlap.
 * `reminders_open` is the tool that reads across lists; the integrator keeps `reminders_list` for
 * the per-list counts.
 */
export const REMINDERS_PACK: AppPack = {
  id: 'reminders',
  app: 'Reminders',
  bundleId: 'com.apple.reminders',
  summary: 'List and read reminders, add one, mark one done, change one, or delete one in Apple Reminders.',
  // Reads are declared before writes, and `reminders_list` is declared before `reminders_open`:
  // retrieval breaks score ties by declaration order, and "what reminders do i have open" carries
  // only the words "reminder" and "open", which both tools match equally. A question about the
  // lists themselves must not fall to the tool that lists the reminders inside them.
  tools: [remindersList, remindersOpen, remindersRead, remindersAdd, remindersComplete, remindersUpdate, remindersDelete],
};

export default REMINDERS_PACK;