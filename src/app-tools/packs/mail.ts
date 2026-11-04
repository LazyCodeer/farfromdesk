import type { AppPack, AppTool, AppToolArg, AppToolPlan } from '../types.js';
import { asStr } from '../applescript.js';

/**
 * The Mail pack: the owner's messages as a read/write API.
 *
 * Why this file exists: "summarise my mail" was answered from the accessibility labels of
 * whatever Mail window happened to be showing, because pointing and clicking can read the chrome
 * but not the message text. Every tool here goes through Mail's scripting dictionary, so an answer
 * about what a message says is built from what the message actually says. The rule the other packs
 * hold also holds here: an answer must come from a read that could have produced it.
 *
 * Measured facts about this app's dictionary (macOS 27.0.1, Mail.sdef):
 * - the application class carries `inbox` and `drafts mailbox` (both read-only mailbox
 *   properties) and a `mailbox` element, so a named mailbox resolves as `mailbox "Name"`.
 * - a `message` has `subject`, `sender`, `content` (rich text, read-only) and `date received`.
 * - an `outgoing message` is created with `make new outgoing message with properties {subject,
 *   content, visible}`, has `to recipients` elements, and is the only class the `send` command
 *   accepts. This pack never calls that command.
 * - reading `content` of many messages in one `whose` expression is unreliable on macOS 26+, so
 *   every body read here walks the mailbox one message at a time and reads `content` per message.
 *
 * Traps this file encodes, not just documents:
 * - the word "send" never appears in a script. `mail_draft` creates and reads back a draft; the
 *   owner is the one who sends. The tests assert the script cannot carry the send verb.
 * - Mail can take a moment to show a brand new draft, so `mail_draft` reads the front of the
 *   drafts mailbox and reports what it found, and says so honestly when the draft is not visible
 *   yet instead of claiming success it cannot prove.
 * - an unbounded scan of a large mailbox holds the turn open, so the scans are capped and
 *   `mail_recent` reads a slice of each body rather than every body in full.
 */

/** Messages one search may look at. An unbounded walk of a large mailbox holds the turn open. */
const SCAN_CAP = 300;
/** Newest messages `mail_recent` returns unless the caller asks for fewer. */
const DEFAULT_LIMIT = 10;
/** The most `mail_recent` will ever return. */
const MAX_LIMIT = 25;
/** Characters of each message body `mail_recent` carries. */
const BODY_SLICE = 400;
/** Matches one search may return. */
const MATCH_CAP = 12;
/** Characters of message text `mail_read` returns unless the caller asks for another cap. */
const DEFAULT_READ = 4000;
/** The most `mail_read` will ever return. */
const MAX_READ = 40000;

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
 * The lines that pick a mailbox inside a script. The inbox is Mail's own `inbox` property; any
 * other name is resolved with `mailbox "Name"`. A name that does not resolve leaves `box` as
 * `missing value` and the script returns a sentence instead of walking nothing.
 */
function pickMailbox(boxName: string): string {
  return (
    `set boxName to ${asStr(boxName)}\n` +
    `tell application "Mail"\n` +
    `\tset box to missing value\n` +
    `\tif boxName is "INBOX" then\n` +
    `\t\tset box to inbox\n` +
    `\telse\n` +
    `\t\ttry\n` +
    `\t\t\tset box to mailbox boxName\n` +
    `\t\tend try\n` +
    `\tend if\n` +
    `\tif box is missing value then return "I could not find a mailbox called " & boxName & " in Mail."\n`
  );
}

/** Joins a list of lines into one readable report. */
function report(lines: string): string {
  return (
    `set report to ""\n` +
    `repeat with lineRef in ${lines}\n` +
    `\tset report to report & (contents of lineRef) & return\n` +
    `end repeat\n`
  );
}

const recentArgs: AppToolArg[] = [
  {
    name: 'limit',
    description: `How many of the newest messages to return, for example 10. Leave empty for ${DEFAULT_LIMIT}, which is also the most allowed (${MAX_LIMIT}).`,
  },
  {
    name: 'mailbox',
    description: 'The mailbox to read by its exact name. Leave empty for the inbox, INBOX.',
  },
];

const mailRecent: AppTool = {
  name: 'mail_recent',
  pack: 'mail',
  app: 'Mail',
  bundleId: 'com.apple.mail',
  description:
    'List the newest messages in a Mail mailbox, the inbox unless another mailbox is named, and ' +
    'return the sender, the subject and the start of each message\'s own text. Use this when the ' +
    'owner asks to summarise their mail, asks for a summary of their inbox, asks what is new or ' +
    'recent in their mail, or asks to see or list the messages they have. Do not use this when ' +
    'the owner wants to search for one message by a word, or wants a single message read in ' +
    'full: finding and reading are separate tools. It reads only the newest messages Mail ' +
    'returns, stops after ' + SCAN_CAP + ' of them and returns at most ' + DEFAULT_LIMIT + ', and ' +
    'it is read only: it never sends, composes, moves, deletes, marks or opens a message. Returns ' +
    'one block per message, newest first, each with the sender, the subject and the start of the ' +
    'message text.',
  args: recentArgs,
  examples: [
    'summarise my mail',
    'give me a summary of my inbox',
    'what is new in my mail',
    'show me my recent messages',
  ],
  keywords: [
    'mail',
    'message',
    'inbox',
    'summarise my mail',
    'summary of my inbox',
    'recent messages',
    'new mail',
    'what is in my mail',
  ],
  // A question about one message's text is the read tool's job, so this one stands down for those.
  notFor: ['read the whole message', 'what does the message say'],
  writes: false,
  plan: args => {
    const limit = wholeNumber(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
    if (limit === undefined) {
      return refuse('The limit has to be a whole number of messages, like 10, or left empty for the newest messages.');
    }
    const boxName = String(args.mailbox ?? '').trim() || 'INBOX';
    return {
      kind: 'osascript',
      // The answer is built from the message texts, so it carries a slice of each one.
      outputChars: (BODY_SLICE + 400) * limit + 2000,
      script:
        `set cap to ${limit}\n` +
        `set slice to ${BODY_SLICE}\n` +
        `set out to {}\n` +
        pickMailbox(boxName) +
        `\tset total to count of messages of box\n` +
        `\tset i to 1\n` +
        `\trepeat while (i is less than or equal to total) and ((count of out) is less than cap)\n` +
        `\t\tset msg to message i of box\n` +
        `\t\tset whoLine to sender of msg\n` +
        `\t\tset subjLine to subject of msg\n` +
        `\t\tif subjLine is "" then set subjLine to "(no subject)"\n` +
        `\t\tset bodyText to ""\n` +
        `\t\ttry\n` +
        `\t\t\tset bodyText to (content of msg) as text\n` +
        `\t\tend try\n` +
        `\t\tset shown to bodyText\n` +
        `\t\tset cut to false\n` +
        `\t\tif (length of bodyText) is greater than slice then\n` +
        `\t\t\tset shown to text 1 thru slice of bodyText\n` +
        `\t\t\tset cut to true\n` +
        `\t\tend if\n` +
        `\t\tset block to "- from: " & whoLine & return & "  subject: " & subjLine & return & "  text: " & shown\n` +
        `\t\tif cut then set block to block & " [cut off here: the message continues]"\n` +
        `\t\tset end of out to block\n` +
        `\t\tset i to i + 1\n` +
        `\tend repeat\n` +
        `end tell\n` +
        `if (count of out) is 0 then return "There are no messages in " & boxName & " in Mail."\n` +
        report('out') +
        `return "Showing " & (count of out) & " newest message(s) in " & boxName & ", with the sender, the subject and the start of each message text:" & return & report\n`,
    };
  },
};

const findArgs: AppToolArg[] = [
  { name: 'query', description: 'The word or short phrase to look for in the subject or the sender, as the owner said it.', required: true },
  {
    name: 'mailbox',
    description: 'The mailbox to search by its exact name. Leave empty for the inbox, INBOX.',
  },
];

const mailFind: AppTool = {
  name: 'mail_find',
  pack: 'mail',
  app: 'Mail',
  bundleId: 'com.apple.mail',
  description:
    'Search the messages in a Mail mailbox for a word or phrase that appears in the subject or ' +
    'the sender, and list the sender, the subject and the date of each match. Use this when the ' +
    'owner asks to find, search or look for a message, asks who sent something, or asks which ' +
    'message mentions a word, and does not need the bodies. It only reads lines: it never returns ' +
    'message text, never moves, deletes or marks a message, and never sends, composes or drafts ' +
    'anything. It looks at no more than ' + SCAN_CAP + ' messages, returns no more than ' +
    MATCH_CAP + ' matches, and says in its answer how many messages it looked at. Returns one ' +
    'line per match with the sender, the subject and the date received.',
  args: findArgs,
  examples: [
    'find the message from the bank',
    'search my mail for the invoice',
    'who sent the message about the delivery',
    'find the message from the plumber',
  ],
  keywords: [
    'mail',
    'message',
    'find a message',
    'search my mail',
    'sender',
    'subject line',
    'which message',
    'look for a message',
  ],
  // Searching answers with lines; a request to summarise or to read one message is a different job.
  notFor: ['summarise my mail', 'what does the message say'],
  writes: false,
  plan: args => {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return refuse('I need a word or phrase to look for in the subject or the sender, so tell me what to search for.');
    }
    const boxName = String(args.mailbox ?? '').trim() || 'INBOX';
    return {
      kind: 'osascript',
      script:
        `set q to ${asStr(query)}\n` +
        `set scanCap to ${SCAN_CAP}\n` +
        `set matchCap to ${MATCH_CAP}\n` +
        `set out to {}\n` +
        `set seen to 0\n` +
        pickMailbox(boxName) +
        `\tset total to count of messages of box\n` +
        `\tset i to 1\n` +
        `\trepeat while (i is less than or equal to total) and (seen is less than scanCap) and ((count of out) is less than matchCap)\n` +
        `\t\tset msg to message i of box\n` +
        `\t\tset seen to seen + 1\n` +
        `\t\tset subjLine to subject of msg\n` +
        `\t\tset whoLine to sender of msg\n` +
        `\t\tif (subjLine contains q) or (whoLine contains q) then\n` +
        `\t\t\tset end of out to "- from: " & whoLine & " | subject: " & subjLine & " | date: " & ((date received of msg) as string)\n` +
        `\t\tend if\n` +
        `\t\tset i to i + 1\n` +
        `\tend repeat\n` +
        `end tell\n` +
        `if (count of out) is 0 then return "No message in " & boxName & " had " & q & " in its subject or its sender, after looking at " & seen & " message(s)."\n` +
        report('out') +
        `return "Found " & (count of out) & " message(s) with " & q & " in the subject or the sender, after looking at " & seen & " message(s); the sender, subject and date only:" & return & report\n`,
    };
  },
};

const readArgs: AppToolArg[] = [
  { name: 'subject', description: 'The subject of the message to read, as it appears in Mail.', required: true },
  { name: 'sender', description: 'The sender of the message, or enough of the sender to tell it apart from the others.', required: true },
  {
    name: 'chars',
    description: `How many characters of the message to return, at most ${MAX_READ}. Leave empty for ${DEFAULT_READ}.`,
  },
];

const mailRead: AppTool = {
  name: 'mail_read',
  pack: 'mail',
  app: 'Mail',
  bundleId: 'com.apple.mail',
  description:
    'Read one message in the inbox, found by its subject together with its sender, and return ' +
    'the message\'s own text. Use this when the owner asks what a message says, what the last ' +
    'message about something said, or asks for the details or the words of one message. It only ' +
    'reads: it never sends, composes, replies, forwards, moves, deletes or marks anything. It ' +
    'refuses when nothing matches or when more than one message matches the subject and sender, ' +
    'and asks for a more exact sender instead of guessing. Returns the subject, the sender and ' +
    'the message text, cut off at the character limit the caller asked for.',
  args: readArgs,
  examples: [
    'what did the last message about the invoice say',
    'read the message from the bank about the statement',
    'what does the message about the delivery say',
  ],
  keywords: [
    'read a message',
    'message text',
    'what does the message say',
    'the last message',
    'message about the invoice',
    'open a message',
    'message content',
    'sender and subject',
  ],
  // Reading one message in full is not searching and not a summary across messages.
  notFor: ['summarise my mail', 'list my inbox'],
  writes: false,
  plan: args => {
    const subject = String(args.subject ?? '').trim();
    if (!subject) {
      return refuse('I need the subject of the message to read, so tell me which message you mean.');
    }
    const sender = String(args.sender ?? '').trim();
    if (!sender) {
      return refuse('I need the sender of the message too, so tell me who the message is from.');
    }
    const chars = wholeNumber(args.chars, DEFAULT_READ, MAX_READ);
    if (chars === undefined) {
      return refuse(`The character limit has to be a whole number, or left empty for the first ${DEFAULT_READ} characters.`);
    }
    return {
      kind: 'osascript',
      script:
        `set soughtSubject to ${asStr(subject)}\n` +
        `set soughtSender to ${asStr(sender)}\n` +
        `set cap to ${chars}\n` +
        `set scanCap to ${SCAN_CAP}\n` +
        `set out to {}\n` +
        `set seen to 0\n` +
        `tell application "Mail"\n` +
        `\tset box to inbox\n` +
        `\tset total to count of messages of box\n` +
        `\tset i to 1\n` +
        `\trepeat while (i is less than or equal to total) and (seen is less than scanCap) and ((count of out) is less than 2)\n` +
        `\t\tset msg to message i of box\n` +
        `\t\tset seen to seen + 1\n` +
        `\t\tif ((subject of msg) is soughtSubject) and ((sender of msg) contains soughtSender) then\n` +
        `\t\t\tset end of out to msg\n` +
        `\t\tend if\n` +
        `\t\tset i to i + 1\n` +
        `\tend repeat\n` +
        `end tell\n` +
        `if (count of out) is 0 then return "No message in the inbox has the subject " & soughtSubject & " from a sender matching " & soughtSender & ", after looking at " & seen & " message(s)."\n` +
        `if (count of out) is greater than 1 then return "More than one message in the inbox has the subject " & soughtSubject & " and a sender matching " & soughtSender & ", so I did not guess: name the sender more exactly."\n` +
        `set msg to item 1 of out\n` +
        `set subjLine to subject of msg\n` +
        `set whoLine to sender of msg\n` +
        `set bodyText to ""\n` +
        `try\n` +
        `\tset bodyText to (content of msg) as text\n` +
        `end try\n` +
        `set totalChars to length of bodyText\n` +
        `set lead to "The message " & subjLine & " from " & whoLine\n` +
        `if totalChars is 0 then return lead & " is empty: it has no text."\n` +
        `if totalChars is greater than cap then return lead & " has " & totalChars & " characters; the first " & cap & " are:" & return & (text 1 thru cap of bodyText)\n` +
        `return lead & " has " & totalChars & " characters:" & return & bodyText\n`,
    };
  },
};

const draftArgs: AppToolArg[] = [
  { name: 'to', description: 'The recipient\'s email address for the draft.', required: true },
  { name: 'subject', description: 'The subject line of the draft.', required: true },
  { name: 'body', description: 'The words of the message body, written out in full.', required: true },
];

const mailDraft: AppTool = {
  name: 'mail_draft',
  pack: 'mail',
  app: 'Mail',
  bundleId: 'com.apple.mail',
  description:
    'Create a draft message in Mail with a recipient, a subject and a body, and leave it in the ' +
    'drafts mailbox without sending anything. Use this when the owner asks to draft, compose or ' +
    'write up a message to someone and wants it ready but not sent. It never sends, never asks ' +
    'the mail server to deliver and never touches a message that already exists: the owner is ' +
    'still the one who presses the button when they are ready. It needs a recipient, a subject ' +
    'and a body, and refuses when any of the three is empty. Returns proof read back from the ' +
    'front of the drafts mailbox, the subject and the word count of the body, or an honest note ' +
    'that the new draft was not visible there yet.',
  args: draftArgs,
  examples: [
    'draft a reply to the landlord saying the rent is paid',
    'compose a message to the plumber about the boiler',
    'write up a short message for the bank',
  ],
  keywords: [
    'draft a reply',
    'compose an email',
    'write a message',
    'new mail',
    'draft a message',
    'reply to the landlord',
    'mail',
    'message',
  ],
  // A request to read or summarise existing mail must never create a new draft.
  notFor: ['read my mail', 'summarise my mail'],
  writes: true,
  plan: args => {
    const to = String(args.to ?? '').trim();
    const subject = String(args.subject ?? '').trim();
    const body = String(args.body ?? '');
    if (!to) return refuse('I need a recipient for the draft, so tell me who the message is for.');
    if (!subject) return refuse('I need a subject for the draft, so tell me what the message is about.');
    if (!body.trim()) return refuse('I need a body for the draft, so tell me what the message should say.');
    return {
      kind: 'osascript',
      script:
        `set rcpt to ${asStr(to)}\n` +
        `set subjText to ${asStr(subject)}\n` +
        `set bodyText to ${asStr(body)}\n` +
        `tell application "Mail"\n` +
        `\tset m to make new outgoing message with properties {subject:subjText, content:bodyText, visible:false}\n` +
        `\ttry\n` +
        `\t\tmake new to recipient at end of to recipients of m with properties {address:rcpt}\n` +
        `\tend try\n` +
        `\tset madeSubject to subject of m\n` +
        `\tset madeWords to count of words of ((content of m) as text)\n` +
        `\tdelay 1\n` +
        `\tset sawIt to false\n` +
        `\tset seenSubject to ""\n` +
        `\tset seenWords to 0\n` +
        `\ttry\n` +
        `\t\tset topDraft to message 1 of drafts mailbox\n` +
        `\t\tset seenSubject to subject of topDraft\n` +
        `\t\tset seenWords to count of words of ((content of topDraft) as text)\n` +
        `\t\tif seenSubject is subjText then set sawIt to true\n` +
        `\tend try\n` +
        `end tell\n` +
        `if sawIt then return "Created a draft in Mail and it was not sent: the front of the drafts mailbox now shows the subject " & seenSubject & " with " & seenWords & " word(s) in its body, so the draft is really there."\n` +
        `return "Created a draft in Mail with the subject " & madeSubject & " and " & madeWords & " word(s) in its body, and it was not sent, but it was not at the front of the drafts mailbox when I looked; Mail can take a moment to show a new draft, so I cannot yet prove it saved."\n`,
    };
  },
};

export const MAIL_PACK: AppPack = {
  id: 'mail',
  app: 'Mail',
  bundleId: 'com.apple.mail',
  summary: 'Read the newest messages, search them and read one in full, and draft a new message without ever sending it.',
  tools: [mailRecent, mailFind, mailRead, mailDraft],
};

export default MAIL_PACK;