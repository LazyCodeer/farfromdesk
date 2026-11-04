import type { AppTool } from './types.js';
import { allPackTools } from './packs.js';
import { embedExtras } from './embed.js';

/**
 * Intent to tool retrieval.
 *
 * Why this exists: the driver exposes 62 tools and the research on tool selection is
 * consistent that accuracy collapses past roughly 30 tools in one prompt ("degrades once you
 * exceed 30-50 available tools", OpenAI: "aim for fewer than 20 functions available at the
 * start of a turn"). So the companion must send a small, chosen set: the app the owner is in,
 * plus a handful of tools that match what they said.
 *
 * Stage 2 replaces the lexical scorer below with on-device embeddings over the same text. The
 * text is already the thing that is scored (name, pack, app, description, arg names and
 * descriptions, examples, keywords), so swapping the scorer does not change the index.
 */

const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'could', 'do', 'does', 'for',
  'from', 'get', 'give', 'had', 'has', 'have', 'how', 'i', 'in', 'into', 'is', 'it', 'its',
  'just', 'me', 'my', 'of', 'on', 'or', 'our', 'out', 'please', 'so', 'some', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'up', 'us', 'was', 'we',
  'were', 'what', 'when', 'which', 'who', 'will', 'with', 'would', 'you', 'your',
]);

/** Drops a trailing plural "s" so "notes" and "note" score as the same word. */
function stem(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/**
 * How owners actually spell the apps over chat. Measured 4 November 2026 on Local: "Check my
 * calender" matched nothing, so the companion answered "I could not read Calendar" without ever
 * offering the Calendar tools. Whole words only, so a word inside another word is never rewritten.
 */
const SPELLINGS: Record<string, string> = {
  calender: 'calendar', calandar: 'calendar', calander: 'calendar', calendr: 'calendar', calnder: 'calendar', agenda: 'calendar today',
  email: 'mail', emails: 'mail', mails: 'mail', inbox: 'mail', gmail: 'mail',
  ntoes: 'notes', noets: 'notes', notse: 'notes', nots: 'notes',
  remiders: 'reminders', reminers: 'reminders', remainders: 'reminders', remindrs: 'reminders', todos: 'reminders', todo: 'reminders',
  chek: 'check', chk: 'check', cehck: 'check', chck: 'check', whats: 'what', wat: 'what',
  msgs: 'messages', imessage: 'messages', imessages: 'messages', texts: 'messages',
  playing: 'music', song: 'music', songs: 'music',
  sumarise: 'summarise', summarize: 'summarise', sumarize: 'summarise', summery: 'summary',
};
const APP_NAMES = ['notes', 'calendar', 'reminders', 'mail', 'finder', 'safari', 'music', 'messages'];

/** One edit apart (insert, delete, substitute or swap two neighbours). */
function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** Rewrites known misspellings and near-misses of an app name, word by word. */
export function normalizeRequest(text: string): string {
  return text.toLowerCase().replace(/[a-z]+/g, word => SPELLINGS[word] ?? (word.length >= 5 && !APP_NAMES.some(name => word === name || word === name + 's' || word + 's' === name) ? APP_NAMES.find(name => oneEditApart(word, name)) ?? word : word));
}

export function tokenize(text: string): string[] {
  return normalizeRequest(text)
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 1 && !STOP.has(word))
    .map(stem);
}

/** Everything about a tool that a person could have said, in the order it matters. */
export function toolText(tool: AppTool): string {
  return [
    tool.pack,
    tool.name.replace(/_/g, ' '),
    tool.app,
    tool.description,
    ...tool.args.map(arg => `${arg.name} ${arg.description}`),
    ...tool.examples,
    ...tool.keywords,
  ].join('\n');
}

export interface ToolIndex {
  tools: AppTool[];
  /** Inverse document frequency per token, so "calendar" counts for less than "leaking". */
  idf: Map<string, number>;
  tokens: Map<string, string[]>;
}

export function buildIndex(tools: AppTool[] = allPackTools()): ToolIndex {
  const tokens = new Map<string, string[]>();
  const df = new Map<string, number>();
  for (const tool of tools) {
    const words = new Set(tokenize(toolText(tool)));
    tokens.set(tool.name, [...words]);
    for (const word of words) df.set(word, (df.get(word) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [word, count] of df) idf.set(word, Math.log(1 + tools.length / count));
  return { tools, idf, tokens };
}

/**
 * Verbs and pronouns that coding requests use too.
 *
 * A match on one of these is not enough to put an app's tools in play, because "add a retry to
 * the sync loop" matches the calendar pack on "add" and "write the failing test" matches the
 * notes pack on "write". The app name, the app in front, or a word that belongs to that app
 * ("schedule", "note", "meeting") is what does it.
 */
const GENERIC = new Set([
  'add', 'create', 'do', 'find', 'get', 'give', 'go', 'list', 'look', 'make', 'new', 'open',
  'put', 'run', 'save', 'search', 'set', 'show', 'take', 'use', 'write', 'day', 'today',
  'tomorrow', 'week', 'time', 'name', 'text', 'body', 'query', 'days', 'title', 'start', 'end',
]);

/** Words that only name the app or the pack: they cannot carry the intent on their own. */
function appWords(tool: AppTool): Set<string> {
  return new Set([...tokenize(tool.app), ...tokenize(tool.pack)]);
}

export interface ToolMatch {
  tool: AppTool;
  score: number;
}

/**
 * The owner's opening verb, when it settles read against write.
 *
 * Reading a note and writing one share almost every word, which is how "save this for later:
 * invoice 442" matched the note-searching tool on the words of its own example. The first verb
 * the owner says is the signal: "find" and "what did I write" are reads even though the second
 * contains "write", and "remind me" and "jot this down" are writes. Words that are neither are
 * skipped, so "add a meeting", "put a meeting" and "schedule a call" stay undecided rather than
 * being forced into a half-guessed mode.
 */
const WRITE_VERBS = new Set(['add', 'write', 'jot', 'save', 'note', 'remind', 'remember', 'record', 'log', 'capture', 'forget', 'hold', 'keep']);
// Copulas are deliberately absent: "my head is full" is not a read. Every word here names a
// question the owner is asking, so a sentence that merely contains "is" or "does" stays
// undecided and is left to the scores. "list" is deliberately absent too: it is the noun in
// "put call the plumber on my reminders list", which the Reminders pack measured as a read
// request and pointed away from the writing tool.
const READ_VERBS = new Set(['find', 'search', 'look', 'where', 'read', 'show', 'tell', 'what', 'which', 'check', 'see', 'view', 'any', 'recent', 'latest', 'summarise', 'summary']);

/**
 * The tool that answers "check my <app>" when the owner names the app and nothing else.
 *
 * Measured 4 November 2026 on Local: "check my reminders" and "check my mails" matched no tool,
 * because "check" is in no tool's text and an app name alone carries no intent. Asking to check
 * an app is a request for what is in it, so the pack's own overview read answers it.
 */
const OVERVIEW: Record<string, string> = {
  notes: 'notes_recent', calendar: 'calendar_list_events', reminders: 'reminders_open', mail: 'mail_recent',
  finder: 'finder_recent', safari: 'safari_tabs', music: 'music_current', messages: 'messages_recent',
};
/** Words that only ask to look, so a request made of them plus an app name is an overview. */
const LOOK_WORDS = new Set(['check', 'see', 'view', 'show', 'any', 'recent', 'latest', 'new', 'all', 'last', 'summarise', 'summary', 'what', 'read', 'tell', 'whats', 'today', 'tomorrow', 'week']);

/**
 * A write verb the owner also uses as an ordinary noun, and the words that tell the two apart.
 *
 * "do I have a note about the dentist" is a read, but "note" is the first verb-shaped word in it,
 * so the plain scan below called it a write and switched every reading tool off. A determiner or
 * a possessive in front of the word is what separates the two: "a note", "my note" and "the note
 * about the dentist" are things, while "note that the roof is leaking" is an instruction. Only
 * the write verbs are checked this way, because the damage is one-sided: mistaking a read for a
 * write hides every reading tool, and the owner asked for a read.
 */
const NOUN_AMBIGUOUS_WRITE_VERBS = new Set(['note', 'record', 'log', 'capture', 'hold', 'keep']);
const DETERMINERS = new Set(['a', 'an', 'the', 'my', 'your', 'our', 'their', 'his', 'her', 'its', 'this', 'that', 'these', 'those', 'any', 'one', 'another', 'each', 'every', 'no']);

export function intentPolarity(text: string): 'write' | 'read' | undefined {
  let previous = '';
  for (const word of normalizeRequest(text).split(/[^a-z0-9]+/)) {
    if (!word) continue;
    const asNoun = NOUN_AMBIGUOUS_WRITE_VERBS.has(word) && DETERMINERS.has(previous);
    if (!asNoun) {
      if (WRITE_VERBS.has(word)) return 'write';
      if (READ_VERBS.has(word)) return 'read';
    }
    previous = word;
  }
  return undefined;
}

export interface SelectOptions {
  /** The app in front of the owner, if it is known. */
  app?: string;
  k?: number;
  /** Below this the request is not a tool request at all. */
  minScore?: number;
  index?: ToolIndex;
}

/**
 * Ranks tools for one request. Deliberately conservative: a request that only names an app
 * ("open Notes") scores nothing, because opening an app is not a tool call.
 */
export function selectTools(text: string, options: SelectOptions = {}): ToolMatch[] {
  const index = options.index ?? buildIndex();
  const wanted = tokenize(text);
  if (!wanted.length) return [];
  const unique = [...new Set(wanted)];
  const app = options.app?.trim().toLowerCase();
  const found: ToolMatch[] = [];
  // When the owner names an app or a pack, only that app's tools are in play. Measured: "look
  // for the note with the plumber number" reached the calendar list tool on the incidental
  // words "look" and "number" once the notes tool was removed. A request about notes is not a
  // request about the calendar, whatever words the two descriptions happen to share.
  // A word earns the narrowing only if it belongs to one app and no other app's tools use it.
  // "notes" names Notes, but it is also the notes field of a calendar event, so "what are the
  // notes on the standup" is a Calendar question: narrowing on "notes" left it with nothing to
  // answer with. Measured the same way for "message", which is the Messages app and the ordinary
  // noun for a Mail message, where narrowing dropped Mail's own tool before it was scored. The
  // word still counts as the app's own text when the score is worked out.
  const claimed = new Map<string, string[]>();
  for (const tool of index.tools) {
    for (const word of appWords(tool)) {
      const packs = claimed.get(word) ?? [];
      if (!packs.includes(tool.pack)) packs.push(tool.pack);
      claimed.set(word, packs);
    }
  }
  const namedPacks = new Set<string>();
  for (const word of unique) {
    const owners = claimed.get(word);
    if (!owners) continue;
    if (index.tools.some(tool => !owners.includes(tool.pack) && (index.tokens.get(tool.name) ?? []).includes(word))) continue;
    for (const pack of owners) namedPacks.add(pack);
  }
  // "my notes", "check notes" and "remind me" name their app even though the word is shared:
  // measured 4 November 2026, "Check my recent notes" ranked calendar_find_events first on the
  // word "notes" (an event field) and "remind me to call mom at 5" reached the Notes tool. The
  // shared-word rule above is about a word used as a field ("the notes on the standup"); a
  // possessive or a look verb in front of it makes it the app. With Notes in front, "remind me"
  // stays a note, which is what the paraphrase set pins.
  const polarity = intentPolarity(text);
  const raw = normalizeRequest(text).split(/[^a-z0-9]+/).filter(Boolean);
  raw.forEach((word, i) => {
    const before = raw[i - 1] ?? '';
    const owners = claimed.get(stem(word));
    // "message" is the ordinary word for an email as much as for a text, so it never names Messages here.
    if (stem(word) === 'message') return;
    if (!owners || owners.length !== 1 || !(before === 'my' || before === 'our' || READ_VERBS.has(before) || LOOK_WORDS.has(before))) return;
    // With Mail in front, "my recent messages" is the inbox: the app in front still decides a
    // word that its own tools use too.
    if (app && index.tools.some(tool => tool.app.toLowerCase() === app && tool.pack !== owners[0] && (index.tokens.get(tool.name) ?? []).includes(stem(word)))) return;
    namedPacks.add(owners[0]);
  });
  const remindOwned = raw.includes('remind') && (!app || app === 'reminders');
  if (remindOwned) namedPacks.add('reminders');
  // A meeting, an appointment or an event is a calendar thing when no app was named at all.
  if (!namedPacks.size && !app && polarity !== 'write' && !unique.some(word => claimed.has(word) && word !== 'calendar') && raw.some(word => /^(meeting|appointment|event)s?$/.test(word))) namedPacks.add('calendar');
  // "remind me to call mom at 5" is the plainest reminder there is, and its words (call, mom, 5)
  // are in no tool's text, so the scorer below cannot find the adding tool on its own.
  if (remindOwned && /\bremind me (to|about)\b/.test(raw.join(' '))) {
    const add = index.tools.find(tool => tool.name === 'reminders_add');
    if (add) return [{ tool: add, score: 10 }];
  }
  const overview = namedPacks.size === 1 ? OVERVIEW[[...namedPacks][0]] : undefined;
  if (overview && unique.every(word => claimed.has(word) || LOOK_WORDS.has(word) || (overview === 'calendar_list_events' && /^(meeting|appointment|event)$/.test(word))) && raw.some(word => LOOK_WORDS.has(word))) {
    const tool = index.tools.find(candidate => candidate.name === overview);
    if (tool) return [{ tool, score: 10 }];
  }
  // A request made only of app words is not a request. "notes" and "calendar" on their own name
  // a window, not a question about data, and opening an app is not a tool call; whatever app is
  // in front, the owner has to say what they want from it.
  if (unique.every(word => claimed.has(word))) return [];

  for (const tool of index.tools) {
    const appInFront = Boolean(app && tool.app.toLowerCase() === app);
    // A named pack narrows the search, but the app in front is still a prior: with Mail open,
    // "find the message from the bank" named the Messages pack on the word "message" and every
    // Mail tool was dropped before it was scored at all.
    // Deliberately NOT exempting the app in front here. Measured 4 November: with the exemption,
    // "notes" said while Calendar is in front reached calendar_find_events on the word "notes" in
    // its own argument description ("the event title, location or notes"), so a bare app name
    // became a calendar read. Naming another app's word is a request about that app; the app in
    // front is a prior, not a permission to override what the owner just said.
    if (namedPacks.size && !namedPacks.has(tool.pack)) continue;
    // A read request must not be answered by a writing tool and the other way round. Measured:
    // this moved the paraphrase set's wrong-first answers off the note-searching tool for
    // "save this for later" and off the calendar-creating tool for "what does my Friday look
    // like" and "is anything booked on Friday".
    if (polarity === 'write' && !tool.writes) continue;
    if (polarity === 'read' && tool.writes) continue;
    // A tool that declares requests it must never serve is skipped when one of them is what
    // the owner said. This is checked before scoring, so a near-miss cannot outrank it. A
    // phrase counts only when at least two of its words carry meaning: measured here, a
    // one-word phrase like "where is that note" reduces to ["note"] and would switch the tool
    // off for every note request, which is the opposite of what it is for.
    if (tool.notFor?.some(phrase => { const words = tokenize(phrase); return words.length >= 2 && words.every(word => unique.includes(word)); })) continue;
    const own = index.tokens.get(tool.name) ?? [];
    const ownSet = new Set(own);
    const names = appWords(tool);
    let score = 0;
    let contentMatches = 0;
    let matched = 0;
    let namesTheApp = false;
    let anchors = 0;
    for (const word of unique) {
      if (!ownSet.has(word)) continue;
      matched += 1;
      const weight = index.idf.get(word) ?? 0;
      score += weight;
      if (names.has(word)) namesTheApp = true;
      else {
        contentMatches += 1;
        if (!GENERIC.has(word)) anchors += 1;
      }
    }
    // A tool is only in play when the owner named the app or the pack, when the app is the one
    // in front of them, or when a word that belongs to that app was said. Without the third
    // clause "schedule a call at 9 tomorrow morning" was dropped, and without the whole gate
    // "add a retry to the sync loop" pulled in a calendar tool on the word "add".
    if (!contentMatches || !(namesTheApp || appInFront || anchors)) continue;
    // One matched word is not enough on its own. Measured 2026-11-04, at eleven tools: the word
    // "call" appears once in an example of every create tool, and a single rare-word match scored
    // 1.32, so "don't let me forget to call Ashitosh" put the calendar and the reminders create
    // tools in play beside the note tool. Two matched words, or one while the owner is looking at
    // that app, is the signal; one shared English word is not. The app in front is a prior, not a
    // permission, so it lowers the count but does not remove the floor below it.
    if (matched < 2 && !appInFront) continue;
    // The app in front is a strong prior: it is what the owner is looking at.
    if (appInFront) score += 1;
    if (score >= (options.minScore ?? 1.2)) found.push({ tool, score });
  }

  // Ties go to the tool the pack declares first, not to whichever name sorts first. Measured
  // 2026-11-04: notes_read's example "read my note about the plumber" and notes_find's "find my
  // note about the plumber" match the same four words and scored 4.01 each, so the alphabetical
  // tie-break sent "read my note about the plumber" to the titles-only search. Each pack declares
  // the reading a request wants before the writing, so declaration order is the better tie-break.
  found.sort((a, b) => b.score - a.score || index.tools.indexOf(a.tool) - index.tools.indexOf(b.tool));
  // Only the tools that are in the same league as the best one are worth sending. Measured
  // 4 November, with thirty-two tools: "read the article i have open" matched eleven tools,
  // because one weak word ("page", "read", "open") is in every pack's description. A request
  // that pulls in eleven tools is the prompt bloat this layer exists to prevent, so a tool has
  // to reach seventy per cent of the best score to stay in play. The ranking is untouched, so a request the
  // scorer already answered is answered with exactly the same first tool.
  const best = found[0]?.score ?? 0;
  return found.filter(match => match.score >= best * 0.7).slice(0, options.k ?? 5);
}

/** One line per tool, for the model prompt or for telling the owner what a pack can do. */
export function describeTools(tools: AppTool[]): string {
  return tools
    .map(tool => `- ${tool.name} (${tool.app}, ${tool.writes ? 'changes things' : 'read only'}): ${tool.description.split('. ')[0]}.`)
    .join('\n');
}

export interface ShortlistEntry {
  tool: AppTool;
  score: number;
  /** Which layer put it here, so a live retrieval log says whether embeddings earned their keep. */
  via: 'lexical' | 'embedding';
}

/**
 * The tools to send for one request: the lexical shortlist, then anything an on-device
 * embedding search adds for the app the owner is in.
 *
 * Order is preserved and size is capped at `k`, so a request that the lexical scorer already
 * handles is answered with exactly the same list as before. Measured: this union keeps the
 * golden set at recall@5 15/15 and lifts a paraphrase set that names neither the app nor its
 * words from 8/10 to 10/10.
 */
/**
 * A stable text hash of the tool set, so the embedding cache is keyed by exactly the text it
 * holds: a pack change changes this and the cached vectors are left behind.
 */
export function indexSignature(tools: AppTool[]): string {
  return tools.map(tool => `${tool.name}:${tool.description.length}:${tool.examples.join('|')}:${tool.keywords.join('|')}`).join('\n');
}

export async function shortlistTools(text: string, options: SelectOptions = {}): Promise<ShortlistEntry[]> {
  const index = options.index ?? buildIndex();
  const k = options.k ?? 5;
  const lexical = selectTools(text, { ...options, index, k });
  const entries: ShortlistEntry[] = lexical.map(match => ({ tool: match.tool, score: match.score, via: 'lexical' }));
  if (entries.length >= k) return entries;
  const polarity = intentPolarity(text);
  const extras = await embedExtras(text, polarity ? index.tools.filter(tool => polarity === 'write' ? tool.writes : !tool.writes) : index.tools, { app: options.app, k: k - entries.length, already: entries.map(entry => entry.tool.name), signature: indexSignature(index.tools) });
  for (const name of extras) {
    const tool = index.tools.find(candidate => candidate.name === name);
    if (tool) entries.push({ tool, score: 0, via: 'embedding' });
  }
  return entries.slice(0, k);
}

/**
 * The overview read for "check my notes", "my agenda" or "chek my mails", when that is all the
 * owner said. Such a request has one honest answer and no arguments to fill, so the brain runs it
 * in code instead of asking the model, the same way it runs "open Notes".
 */
export function overviewTool(text: string, options: SelectOptions = {}): AppTool | undefined {
  const [first] = selectTools(text, options);
  if (!first || first.score !== 10 || first.tool.writes || first.tool.args.some(arg => arg.required)) return undefined;
  return OVERVIEW[first.tool.pack] === first.tool.name ? first.tool : undefined;
}
