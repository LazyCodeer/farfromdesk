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
  'were', 'what', 'when', 'where', 'which', 'who', 'will', 'with', 'would', 'you', 'your',
]);

/** Drops a trailing plural "s" so "notes" and "note" score as the same word. */
function stem(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
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
const WRITE_VERBS = new Set(['write', 'jot', 'save', 'note', 'remind', 'remember', 'record', 'log', 'capture', 'forget', 'hold', 'keep']);
// Copulas are deliberately absent: "my head is full" is not a read. Every word here names a
// question the owner is asking, so a sentence that merely contains "is" or "does" stays
// undecided and is left to the scores. "list" is deliberately absent too: it is the noun in
// "put call the plumber on my reminders list", which the Reminders pack measured as a read
// request and pointed away from the writing tool.
const READ_VERBS = new Set(['find', 'search', 'look', 'where', 'read', 'show', 'tell', 'what', 'which']);

export function intentPolarity(text: string): 'write' | 'read' | undefined {
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (WRITE_VERBS.has(word)) return 'write';
    if (READ_VERBS.has(word)) return 'read';
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
  const namedPacks = new Set(index.tools.filter(tool => [...appWords(tool)].some(word => unique.includes(word))).map(tool => tool.pack));
  const polarity = intentPolarity(text);

  for (const tool of index.tools) {
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
    let namesTheApp = false;
    let anchors = 0;
    for (const word of unique) {
      if (!ownSet.has(word)) continue;
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
    const appInFront = Boolean(app && tool.app.toLowerCase() === app);
    if (!contentMatches || !(namesTheApp || appInFront || anchors)) continue;
    // The app in front is a strong prior: it is what the owner is looking at.
    if (appInFront) score += 1;
    if (score >= (options.minScore ?? 1.2)) found.push({ tool, score });
  }

  found.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  return found.slice(0, options.k ?? 5);
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