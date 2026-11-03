import type { AppTool } from './types.js';
import { selectTools, type ToolIndex } from './retrieve.js';
import { GOLDEN, type GoldenUtterance } from './golden.js';

/**
 * What retrieval is scored on.
 *
 * The research on tool selection is consistent about the two numbers that matter: recall@k
 * (was the right tool in the shortlist we would hand the model) and wrong-tool@1 (did we put
 * a confidently wrong tool first). Recall@k is the ceiling for the model that picks from the
 * shortlist, and wrong-tool@1 is the failure the owner sees.
 */
export type RetrievalReport = {
  total: number;
  /** Entries that expect a tool. Recall is measured over these, not over the nulls. */
  eligible: number;
  /** Entries where nothing must be returned: a coding request, or a bare app name. */
  quiet: number;
  recall1: number;
  recall3: number;
  recall5: number;
  /** Names of the entries whose top result is not the expected one. */
  wrong: string[];
  /** Entries whose expected tool is not in the top five at all. */
  missed: string[];
  /** Per-entry detail, for a failure message that says what to fix. */
  rows: { text: string; app?: string; want: string | null; got: string[] }[];
};

export function evaluateRetrieval(golden: GoldenUtterance[], index: ToolIndex, k = 5): RetrievalReport {
  const rows: RetrievalReport['rows'] = [];
  let eligible = 0, quiet = 0, hit1 = 0, hit3 = 0, hit5 = 0;
  const wrong: string[] = [], missed: string[] = [];
  for (const entry of golden) {
    const got = selectTools(entry.text, { app: entry.app, index, k }).map(match => match.tool.name);
    rows.push({ text: entry.text, app: entry.app, want: entry.tool, got });
    if (entry.tool) {
      eligible += 1;
      if (got[0] === entry.tool) hit1 += 1;
      if (got.slice(0, 3).includes(entry.tool)) hit3 += 1;
      if (got.slice(0, 5).includes(entry.tool)) hit5 += 1;
      else missed.push(`${entry.text} -> wanted ${entry.tool}, got [${got.join(', ')}]`);
    } else {
      quiet += 1;
      if (got[0]) wrong.push(`${entry.text} -> nothing expected, got ${got[0]}`);
    }
    if (entry.tool && got[0] && got[0] !== entry.tool) wrong.push(`${entry.text} -> wanted ${entry.tool}, first was ${got[0]}`);
  }
  const round = (n: number) => Math.round((n / Math.max(1, eligible)) * 1000) / 1000;
  return { total: golden.length, eligible, quiet, recall1: round(hit1), recall3: round(hit3), recall5: round(hit5), wrong, missed, rows };
}

/** One line for the test output, so the measured numbers are in the evidence. */
export function describeReport(report: RetrievalReport): string {
  return `golden ${report.total} (${report.eligible} with a tool, ${report.quiet} that must stay quiet): recall@1 ${report.recall1}, recall@3 ${report.recall3}, recall@5 ${report.recall5}, wrong-first ${report.wrong.length}`;
}

/** A stable text hash, so an embedding index can be reused until the tool text changes. */
export function indexSignature(tools: AppTool[]): string {
  return tools.map(tool => `${tool.name}:${tool.description.length}:${tool.examples.join('|')}:${tool.keywords.join('|')}`).join('\n');
}