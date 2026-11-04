import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AppTool } from './types.js';

/**
 * On-device embeddings, used to widen a shortlist and nothing else.
 *
 * Measured on 3 November 2026 against the golden set and a paraphrase set, with the helper in
 * `native/tool-embed.swift` (NLEmbedding sentence embeddings, 512 dimensions, no network):
 *
 *   golden set (15 requests that name the app or use its words)   lexical recall@5 15/15
 *                                                                with embeddings  15/15
 *   paraphrase set (10 requests that name neither, app in front)  lexical recall@5 8/10
 *                                                                with embeddings 10/10
 *
 * Embeddings also lost when they were asked to do more than widen: as a standalone ranker they
 * scored 14/15 on the golden set, and reranking the lexical shortlist by embedding similarity
 * dropped it from 15/15 to 11/15. So the lexical order is never changed here. Extras are only
 * appended, only for an app the owner is actually in, and the shortlist keeps its size.
 *
 * The helper is optional: when it is missing or refuses, retrieval falls back to the lexical
 * shortlist alone. Nothing about the owner's Mac request depends on an embedding being present.
 */

const EMBED_TIMEOUT_MS = 5000;
const EMBED_MAX_OUTPUT = 4 * 1024 * 1024;

/** One request in, one answer out. `execFile` has no stdin, so this spawns directly. */
function runWithInput(binary: string, input: string, timeoutMs = EMBED_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    let settled = false;
    const finish = (error: Error | null, value = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('the embedding helper did not answer in time'));
    }, timeoutMs);
    child.on('error', error => finish(error));
    child.on('close', () => finish(null, out));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      if (out.length > EMBED_MAX_OUTPUT) {
        child.kill();
        finish(new Error('the embedding helper answered too much'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Where the packaged app keeps the compiled helper. */
export function embedBinaryPath(): string {
  return process.env.FFD_TOOL_EMBED ?? fileURLToPath(new URL('../../native/tool-embed', import.meta.url));
}

/** Answers once per process whether the helper can actually embed on this machine. */
let available: Promise<boolean> | undefined;
export async function embeddingsAvailable(): Promise<boolean> {
  if (!available) {
    available = (async () => {
      const binary = embedBinaryPath();
      if (!existsSync(binary)) return false;
      try {
        const stdout = await runWithInput(binary, JSON.stringify({ query: 'notes', docs: [{ id: 'probe', text: 'a note' }], k: 1 }));
        return (JSON.parse(stdout) as { ok?: boolean })?.ok === true;
      } catch {
        return false;
      }
    })();
  }
  return await available;
}

export interface EmbedHit {
  id: string;
  score: number;
}

/**
 * Cheap counters, so a test can prove the cache does what the comment claims: a warm turn on
 * the same tool set embeds the owner's words and nothing else.
 */
let calls = 0, docsEmbedded = 0, cacheHits = 0;
export function embedStats(): { calls: number; docsEmbedded: number; cacheHits: number } {
  return { calls, docsEmbedded, cacheHits };
}
export function resetEmbedStats(): void {
  calls = 0; docsEmbedded = 0; cacheHits = 0;
}

/** FNV-1a over the tool text, so the cache key stays short. */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(16);
}

/**
 * Doc vectors per tool set. The tool text only changes when a pack changes, and a pack change
 * changes the signature, so this is a cache with an honest key rather than a guess.
 */
const DOC_CACHE_MAX = 4;
const docCache = new Map<string, { texts: string[]; vectors: number[][] }>();

/** Tests only: the cache is process-wide, so a test that counts embeddings starts clean. */
export function resetEmbedCache(): void {
  docCache.clear();
}

/** One call, many texts: the vectors mode of `native/tool-embed`. */
async function vectorize(binary: string, texts: string[]): Promise<number[][] | null> {
  if (!texts.length) return [];
  calls += 1;
  docsEmbedded += texts.length;
  try {
    const stdout = await runWithInput(binary, JSON.stringify({ texts }));
    const parsed = JSON.parse(stdout) as { ok?: boolean; vectors?: number[][] };
    if (!parsed?.ok || !Array.isArray(parsed.vectors) || parsed.vectors.length !== texts.length) return null;
    for (const vector of parsed.vectors) if (!Array.isArray(vector) || !vector.length) return null;
    return parsed.vectors;
  } catch {
    return null;
  }
}

function dot(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let total = 0;
  for (let index = 0; index < length; index += 1) total += a[index] * b[index];
  return total;
}

/** One vector per thing a person could have said, so a bad line cannot dilute a good one. */
export function embedDocs(tools: AppTool[]): { id: string; text: string }[] {
  const docs: { id: string; text: string }[] = [];
  for (const tool of tools) {
    for (const example of tool.examples) docs.push({ id: tool.name, text: example });
    for (const keyword of tool.keywords) docs.push({ id: tool.name, text: keyword });
    docs.push({ id: tool.name, text: `${tool.app}: ${tool.description.split('. ')[0]}` });
  }
  return docs;
}

/**
 * Ranks the owner's words against the tool texts, one hit per tool (its best matching line).
 * Answers null instead of throwing: a missing helper is a reason to use the lexical scorer,
 * not a reason to fail the owner's request.
 */
/** Best score per tool, biggest first. The caller's cosine is a dot product of unit vectors. */
function rank(docs: { id: string; text: string }[], queryVector: number[], vectors: number[][], k: number): EmbedHit[] {
  const best = new Map<string, number>();
  for (let index = 0; index < docs.length; index += 1) {
    const id = docs[index].id;
    const score = dot(queryVector, vectors[index] ?? []);
    if (!best.has(id) || score > (best.get(id) as number)) best.set(id, score);
  }
  return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id, score]) => ({ id, score }));
}

/**
 * Rank the docs for one query.
 *
 * With a `signature` the pack's doc vectors are cached under it, so a later turn on the same
 * tool set sends only the owner's words to the helper: measured here, 32 doc lines embedded on
 * the first turn and 1 on the next. Without a signature (or when the helper refuses the
 * vectors mode) this falls back to the single call that scores the docs inside the helper.
 */
export async function embedRank(query: string, docs: { id: string; text: string }[], k = 3, signature?: string): Promise<EmbedHit[] | null> {
  const binary = embedBinaryPath();
  if (!existsSync(binary)) return null;
  const texts = docs.map(doc => doc.text);
  const key = signature ? hash(signature) : '';
  const cached = key ? docCache.get(key) : undefined;
  if (cached && cached.texts.length === texts.length && cached.texts.every((text, index) => text === texts[index])) {
    cacheHits += 1;
    const queryVectors = await vectorize(binary, [query]);
    if (!queryVectors?.length) return null;
    return rank(docs, queryVectors[0], cached.vectors, k);
  }
  if (key && texts.length) {
    const vectors = await vectorize(binary, [query, ...texts]);
    if (vectors?.length === texts.length + 1) {
      docCache.set(key, { texts, vectors: vectors.slice(1) });
      while (docCache.size > DOC_CACHE_MAX) {
        const oldest = docCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        docCache.delete(oldest);
      }
      return rank(docs, vectors[0], vectors.slice(1), k);
    }
  }
  try {
    const stdout = await runWithInput(binary, JSON.stringify({ query, docs, k: docs.length }));
    const parsed = JSON.parse(stdout) as { ok?: boolean; ranked?: EmbedHit[] };
    if (!parsed?.ok || !Array.isArray(parsed.ranked)) return null;
    const best = new Map<string, number>();
    for (const hit of parsed.ranked) {
      if (typeof hit?.id !== 'string' || typeof hit?.score !== 'number') continue;
      if (!best.has(hit.id) || hit.score > (best.get(hit.id) as number)) best.set(hit.id, hit.score);
    }
    return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id, score]) => ({ id, score }));
  } catch {
    return null;
  }
}

/**
 * The extra tools an embedding search would add to a lexical shortlist.
 *
 * Only ever the app the owner is in: the measured win came from requests that name neither the
 * app nor its words, and without that restriction a coding request in one app could pull in
 * another app's tools. An empty answer means the shortlist is unchanged.
 *
 * `signature` identifies the tool text the docs came from. When it is given, the pack's doc
 * vectors are cached under it, so later turns on the same tool set embed only the owner's own
 * words: measured here, a turn went from embedding 32 doc lines to embedding 1 query.
 */
export async function embedExtras(text: string, tools: AppTool[], options: { app?: string; k?: number; already?: string[]; signature?: string } = {}): Promise<string[]> {
  const app = options.app?.trim().toLowerCase();
  if (!app) return [];
  const ranked = await embedRank(text, embedDocs(tools), options.k ?? 3, options.signature);
  if (!ranked?.length) return [];
  const already = new Set(options.already ?? []);
  const extras: string[] = [];
  for (const hit of ranked) {
    if (already.has(hit.id) || extras.includes(hit.id)) continue;
    const tool = tools.find(candidate => candidate.name === hit.id);
    if (!tool || tool.app.toLowerCase() !== app) continue;
    extras.push(hit.id);
  }
  return extras;
}