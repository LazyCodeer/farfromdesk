import type { AppTool } from './types.js';
import { allPackTools } from './packs.js';

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

/** Words that only name the app or the pack: they cannot carry the intent on their own. */
function appWords(tool: AppTool): Set<string> {
  return new Set([...tokenize(tool.app), ...tokenize(tool.pack)]);
}

export interface ToolMatch {
  tool: AppTool;
  score: number;
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

  for (const tool of index.tools) {
    const own = index.tokens.get(tool.name) ?? [];
    const ownSet = new Set(own);
    const names = appWords(tool);
    let score = 0;
    let contentMatches = 0;
    let namesTheApp = false;
    for (const word of unique) {
      if (!ownSet.has(word)) continue;
      const weight = index.idf.get(word) ?? 0;
      score += weight;
      if (names.has(word)) namesTheApp = true;
      else contentMatches += 1;
    }
    // A tool is only in play when the owner named the app or the pack, or when the app is the
    // one in front of them. Without that, "add a retry to the sync loop" would match a
    // calendar tool on the word "add" alone.
    const appInFront = Boolean(app && tool.app.toLowerCase() === app);
    if (!contentMatches || !(namesTheApp || appInFront)) continue;
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