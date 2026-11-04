import type { AppPack, AppTool, AppToolPlan } from '../types.js';
import { asStr } from '../applescript.js';

/**
 * The Messages pack: what was said in a conversation, and where a word appears in the history.
 *
 * Why this file exists: "what did they say" is a question about the words in a conversation, and
 * the labels on the Messages window answer it with button names. Messages' scripting dictionary
 * exposes `chat` with its `participants` (each carrying `name`, `handle` and `full name`), so the
 * conversation can at least be found by the person's name or handle.
 *
 * Read-only, emphatically: `send` is the one genuinely dangerous command in this dictionary, and
 * it appears nowhere in this pack, nor does any way of marking something as read. Nothing here
 * writes a single byte anywhere.
 *
 * Measured notes about this app (macOS 27.0.1, /System/Applications/Messages.app):
 * - the shipped dictionary defines exactly four classes: `participant`, `account`, `chat` and
 *   `file transfer`. There is NO `message` class and no `messages` element of a chat: Apple
 *   removed message contents from the scripting interface years ago, and this version does not
 *   restore them (the dictionary was dumped with `/usr/bin/sdef` and read in full).
 * - `messages of c`, `text of m` and `sender of m` nevertheless COMPILE, because AppleScript does
 *   not type-check a property name against an untyped object reference. They are expected to fail
 *   at runtime, which is why every read here is wrapped so that the failure arrives as a sentence
 *   naming the automation permission and this limitation rather than as a raw error number.
 * - `name of c`, `participants of c`, `name of p` and `handle of p` are declared properties and
 *   are the only reads this pack can honestly promise.
 */

/** Conversations scanned in one history search. */
const CHAT_SCAN_CAP = 40;
/** Messages read per conversation in one history search. */
const PER_CHAT_SCAN_CAP = 150;
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

const limitArg = {
  name: 'limit',
  description: `How many messages to return, for example 10. Leave empty for ${DEFAULT_LIMIT}; ${MAX_LIMIT} is the most allowed.`,
};

/**
 * The sentence every failure path returns. It names the permission the owner has to grant and the
 * dictionary gap that can make the read impossible even afterwards, because a bare "error -1728"
 * tells the owner nothing they can act on.
 */
const PERMISSION_NOTE =
  'Reading a conversation needs the one-time Automation permission for Messages, granted in ' +
  'System Settings under Privacy and Security, Automation. On this version of macOS the Messages ' +
  'scripting dictionary no longer lists message contents at all, so this read can also be refused ' +
  'after permission is granted. Nothing was sent and nothing was changed.';

const messagesRecent: AppTool = {
  name: 'messages_recent',
  pack: 'messages',
  app: 'Messages',
  bundleId: 'com.apple.MobileSMS',
  description:
    'Read the most recent messages in one Messages conversation, identified by the other ' +
    "person's name or their number or handle, and return the sender and the words of each " +
    'message. Use this when the owner asks what someone said, asks to read their last messages ' +
    'with a person, or asks what the conversation says. It is read only: it never sends, replies, ' +
    'reacts to or forwards anything, never marks anything as read, and never changes the ' +
    'conversation in any way. It reads one conversation at a time, taken from the end of the ' +
    'history, and returns at most ' +
    MAX_LIMIT +
    ' messages. Reading history requires Messages to have been granted automation permission, so ' +
    'when the read is refused the tool returns a sentence explaining what to grant and what the ' +
    'app will not give up. Returns one line per message with the sender and the text.',
  args: [
    {
      name: 'with',
      description: 'The other person in the conversation, as a name they go by, a number or a handle, as the owner said it.',
      required: true,
    },
    limitArg,
  ],
  examples: [
    'what did they say in messages',
    'read my last messages with a friend',
    'what are my most recent messages',
    'show the last messages in that conversation',
  ],
  keywords: [
    'messages',
    'recent messages',
    'conversation',
    'chat',
    'what did they say',
    'text messages',
    'message history',
  ],
  // Sending, reading the whole history and the other tools of this app are different jobs.
  notFor: ['send a message', 'reply to the message', 'search all messages'],
  writes: false,
  plan: args => {
    const who = String(args['with'] ?? '').trim();
    if (!who) {
      return refuse(
        'I need the name, number or handle of the other person in the conversation before I can read any messages, so nothing was read.',
      );
    }
    const limit = wholeNumber(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
    if (limit === undefined) {
      return refuse(`The limit has to be a whole number of messages, like 10, or left empty for the last ${DEFAULT_LIMIT}.`);
    }
    return {
      kind: 'osascript',
      script:
        `set q to ${asStr(who)}\n` +
        `set cap to ${limit}\n` +
        `set permNote to ${asStr(PERMISSION_NOTE)}\n` +
        `set msLines to {}\n` +
        `set matches to 0\n` +
        `set refused to ""\n` +
        `tell application "Messages"\n` +
        `\ttry\n` +
        `\t\trepeat with c in chats\n` +
        `\t\t\tset hit to false\n` +
        `\t\t\ttry\n` +
        `\t\t\t\tif (name of c contains q) then set hit to true\n` +
        `\t\t\tend try\n` +
        `\t\t\ttry\n` +
        `\t\t\t\trepeat with k in participants of c\n` +
        `\t\t\t\t\tset p to contents of k\n` +
        `\t\t\t\t\tset nm to ""\n` +
        `\t\t\t\t\tset hd to ""\n` +
        `\t\t\t\t\tset fl to ""\n` +
        `\t\t\t\t\ttry\n` +
        `\t\t\t\t\t\tset nm to name of p\n` +
        `\t\t\t\t\tend try\n` +
        `\t\t\t\t\ttry\n` +
        `\t\t\t\t\t\tset hd to handle of p\n` +
        `\t\t\t\t\tend try\n` +
        `\t\t\t\t\ttry\n` +
        `\t\t\t\t\t\tset fl to full name of p\n` +
        `\t\t\t\t\tend try\n` +
        `\t\t\t\t\tif (nm contains q) or (hd contains q) or (fl contains q) then set hit to true\n` +
        `\t\t\t\tend repeat\n` +
        `\t\t\tend try\n` +
        `\t\t\tif hit then\n` +
        `\t\t\t\tset matches to matches + 1\n` +
        `\t\t\t\ttry\n` +
        `\t\t\t\t\tset msgs to messages of c\n` +
        `\t\t\t\t\tset n to count of msgs\n` +
        `\t\t\t\t\tif n > 0 then\n` +
        `\t\t\t\t\t\tset startAt to n - cap + 1\n` +
        `\t\t\t\t\t\tif startAt < 1 then set startAt to 1\n` +
        `\t\t\t\t\t\trepeat with i from startAt to n\n` +
        `\t\t\t\t\t\t\tset m to item i of msgs\n` +
        `\t\t\t\t\t\t\tset tx to ""\n` +
        `\t\t\t\t\t\t\tset sd to "unknown sender"\n` +
        `\t\t\t\t\t\t\ttry\n` +
        `\t\t\t\t\t\t\t\tset tx to text of m\n` +
        `\t\t\t\t\t\t\tend try\n` +
        `\t\t\t\t\t\t\ttry\n` +
        `\t\t\t\t\t\t\t\tset sd to sender of m as string\n` +
        `\t\t\t\t\t\t\tend try\n` +
        `\t\t\t\t\t\t\tif tx is not "" then set end of msLines to (sd & ": " & tx)\n` +
        `\t\t\t\t\t\tend repeat\n` +
        `\t\t\t\t\tend if\n` +
        `\t\t\t\ton error errMsg number errNum\n` +
        `\t\t\t\t\tif refused is "" then set refused to "error " & errNum & ": " & errMsg\n` +
        `\t\t\t\tend try\n` +
        `\t\t\tend if\n` +
        `\t\tend repeat\n` +
        `\ton error errMsg number errNum\n` +
        `\t\treturn "Messages would not answer at all (error " & errNum & ": " & errMsg & "). " & permNote\n` +
        `\tend try\n` +
        `end tell\n` +
        `if matches is 0 then return "No Messages conversation matching " & q & " was found."\n` +
        `if refused is not "" then return permNote & " (" & refused & ")"\n` +
        `if (count of msLines) is 0 then return "The conversation matching " & q & " had no readable messages."\n` +
        `set {oldDelims, AppleScript's text item delimiters} to {AppleScript's text item delimiters, return}\n` +
        `set body to msLines as text\n` +
        `set AppleScript's text item delimiters to oldDelims\n` +
        `return "Last " & (count of msLines) & " message(s) with " & q & ":" & return & body\n`,
    };
  },
};

const messagesFind: AppTool = {
  name: 'messages_find',
  pack: 'messages',
  app: 'Messages',
  bundleId: 'com.apple.MobileSMS',
  description:
    'Search Message text across conversations for a word or phrase the owner says, and return ' +
    'the conversation and the message each time it appears. Use this when the owner asks where ' +
    'something was said, asks who mentioned a word, or asks to find a message they remember. It ' +
    'is read only: it never sends, replies, forwards or reacts, never marks anything as read, and ' +
    'never changes a conversation. It scans a bounded slice of the most recent history, the last ' +
    'messages of the first conversations, and returns at most ' +
    MAX_LIMIT +
    ' matches, so an old message far back in a long conversation may not be reached. Searching ' +
    'history requires Messages to have been granted automation permission, and when the search is ' +
    'refused the tool returns a sentence explaining what to grant. Returns one line per match ' +
    'with the conversation and the text.',
  args: [
    { name: 'query', description: 'The word or short phrase to look for inside the message text, as the owner said it.', required: true },
    limitArg,
  ],
  examples: [
    'where did someone mention the address',
    'find the message about the meeting time',
    'search my messages for that word',
    'who said something about the train',
  ],
  keywords: [
    'search messages',
    'find a message',
    'message history',
    'where was it said',
    'conversations',
    'text messages',
    'mentioned',
  ],
  // Sending is a change, and one conversation at a time is the other tool's job.
  notFor: ['send a message', 'reply to the message', 'read my last messages'],
  writes: false,
  plan: args => {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return refuse('I need the word or phrase to look for in the message history, so nothing was searched.');
    }
    const limit = wholeNumber(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
    if (limit === undefined) {
      return refuse(`The limit has to be a whole number of matches, like 10, or left empty for the first ${DEFAULT_LIMIT}.`);
    }
    return {
      kind: 'osascript',
      script:
        `set q to ${asStr(query)}\n` +
        `set cap to ${limit}\n` +
        `set chatCap to ${CHAT_SCAN_CAP}\n` +
        `set msgCap to ${PER_CHAT_SCAN_CAP}\n` +
        `set permNote to ${asStr(PERMISSION_NOTE)}\n` +
        `set msLines to {}\n` +
        `set scanned to 0\n` +
        `set refused to ""\n` +
        `tell application "Messages"\n` +
        `\ttry\n` +
        `\t\trepeat with c in chats\n` +
        `\t\t\tif (count of msLines) < cap then\n` +
        `\t\t\t\tset scanned to scanned + 1\n` +
        `\t\t\t\tif scanned > chatCap then exit repeat\n` +
        `\t\t\t\tset who to ""\n` +
        `\t\t\t\ttry\n` +
        `\t\t\t\t\tset who to name of c\n` +
        `\t\t\t\tend try\n` +
        `\t\t\t\ttry\n` +
        `\t\t\t\t\trepeat with k in participants of c\n` +
        `\t\t\t\t\t\tset p to contents of k\n` +
        `\t\t\t\t\t\tif who is "" then\n` +
        `\t\t\t\t\t\t\ttry\n` +
        `\t\t\t\t\t\t\t\tset who to name of p\n` +
        `\t\t\t\t\t\t\tend try\n` +
        `\t\t\t\t\t\tend if\n` +
        `\t\t\t\t\t\tif who is "" then\n` +
        `\t\t\t\t\t\t\ttry\n` +
        `\t\t\t\t\t\t\t\tset who to handle of p\n` +
        `\t\t\t\t\t\t\tend try\n` +
        `\t\t\t\t\t\tend if\n` +
        `\t\t\t\t\tend repeat\n` +
        `\t\t\t\tend try\n` +
        `\t\t\t\tif who is "" then set who to "an unnamed conversation"\n` +
        `\t\t\t\ttry\n` +
        `\t\t\t\t\tset msgs to messages of c\n` +
        `\t\t\t\t\tset n to count of msgs\n` +
        `\t\t\t\t\tif n > 0 then\n` +
        `\t\t\t\t\t\tset startAt to n - msgCap + 1\n` +
        `\t\t\t\t\t\tif startAt < 1 then set startAt to 1\n` +
        `\t\t\t\t\t\trepeat with i from startAt to n\n` +
        `\t\t\t\t\t\t\tset m to item i of msgs\n` +
        `\t\t\t\t\t\t\tset tx to ""\n` +
        `\t\t\t\t\t\t\ttry\n` +
        `\t\t\t\t\t\t\t\tset tx to text of m\n` +
        `\t\t\t\t\t\t\tend try\n` +
        `\t\t\t\t\t\t\tif tx contains q then\n` +
        `\t\t\t\t\t\t\t\tset end of msLines to (who & " - " & tx)\n` +
        `\t\t\t\t\t\t\t\tif (count of msLines) is greater than or equal to cap then exit repeat\n` +
        `\t\t\t\t\t\t\tend if\n` +
        `\t\t\t\t\t\tend repeat\n` +
        `\t\t\t\t\tend if\n` +
        `\t\t\t\ton error errMsg number errNum\n` +
        `\t\t\t\t\tif refused is "" then set refused to "error " & errNum & ": " & errMsg\n` +
        `\t\t\t\tend try\n` +
        `\t\t\tend if\n` +
        `\t\tend repeat\n` +
        `\ton error errMsg number errNum\n` +
        `\t\treturn "Messages would not answer at all (error " & errNum & ": " & errMsg & "). " & permNote\n` +
        `\tend try\n` +
        `end tell\n` +
        `if refused is not "" and (count of msLines) is 0 then return permNote & " (" & refused & ")"\n` +
        `if (count of msLines) is 0 then return "No message in the scanned conversations contains " & q & "."\n` +
        `set {oldDelims, AppleScript's text item delimiters} to {AppleScript's text item delimiters, return}\n` +
        `set body to msLines as text\n` +
        `set AppleScript's text item delimiters to oldDelims\n` +
        `return "Showing " & (count of msLines) & " message(s) containing " & q & ":" & return & body\n`,
    };
  },
};

export const MESSAGES_PACK: AppPack = {
  id: 'messages',
  app: 'Messages',
  bundleId: 'com.apple.MobileSMS',
  summary: 'Read the last messages of one conversation and search message text, without ever sending anything.',
  tools: [messagesRecent, messagesFind],
};

export default MESSAGES_PACK;