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
export async function embedRank(query: string, docs: { id: string; text: string }[], k = 3): Promise<EmbedHit[] | null> {
  const binary = embedBinaryPath();
  if (!existsSync(binary)) return null;
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
 */
export async function embedExtras(text: string, tools: AppTool[], options: { app?: string; k?: number; already?: string[] } = {}): Promise<string[]> {
  const app = options.app?.trim().toLowerCase();
  if (!app) return [];
  const ranked = await embedRank(text, embedDocs(tools), options.k ?? 3);
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