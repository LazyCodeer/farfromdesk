/**
 * The brain eval harness.
 *
 * Two questions, one command:
 *   1. Does retrieval put the right reviewed tool in front of the model, and does it stay
 *      quiet when the request is not a Mac request at all?
 *   2. Do the live transcripts still route the way they were fixed to route?
 *
 * The first is scored here. The second runs as tests, because a transcript is a sequence and
 * a sequence needs a store, a router and a brain, not a number. The gate is the exit code:
 * a regression in either half makes this command fail, which is what a build should check.
 *
 * Embeddings are scored in two passes. The lexical pass is the baseline that must never get
 * worse; the widened pass is what the app actually sends. Measured on 3 November: embeddings
 * as a reranker made the paraphrases worse (15/15 -> 11/15) and as a widener made them better
 * (8/10 -> 10/10), which is why the widened pass may add tools and may never reorder them.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allPackTools } from '../src/app-tools/packs.js';
import { buildIndex, shortlistTools, type ShortlistEntry } from '../src/app-tools/retrieve.js';
import { describeReport, evaluateRetrieval } from '../src/app-tools/metrics.js';
import { GOLDEN, type GoldenUtterance } from '../src/app-tools/golden.js';
import { PARAPHRASES } from '../src/app-tools/golden-paraphrase.js';

const tools = allPackTools();
const index = buildIndex(tools);

type Widened = { eligible: number; quiet: number; recall1: number; recall5: number; wrong: string[]; missed: string[] };

/** The same scoring as `evaluateRetrieval`, over the shortlist the app actually builds. */
async function widened(set: GoldenUtterance[], k = 5): Promise<Widened> {
  let eligible = 0, quiet = 0, hit1 = 0, hit5 = 0;
  const wrong: string[] = [], missed: string[] = [];
  for (const entry of set) {
    let got: string[] = [];
    try {
      got = (await shortlistTools(entry.text, { app: entry.app, index, k })).map((hit: ShortlistEntry) => hit.tool.name);
    } catch { got = []; }
    if (entry.tool) {
      eligible += 1;
      if (got[0] === entry.tool) hit1 += 1;
      if (got.slice(0, k).includes(entry.tool)) hit5 += 1;
      else missed.push(`${entry.text} -> wanted ${entry.tool}, got [${got.join(', ')}]`);
      if (got[0] && got[0] !== entry.tool) wrong.push(`${entry.text} -> wanted ${entry.tool}, first was ${got[0]}`);
    } else {
      quiet += 1;
      if (got[0]) wrong.push(`${entry.text} -> nothing expected, got ${got[0]}`);
    }
  }
  const round = (n: number) => Math.round((n / Math.max(1, eligible)) * 1000) / 1000;
  return { eligible, quiet, recall1: round(hit1), recall5: round(hit5), wrong, missed };
}

const line = (label: string, text: string) => console.log(`${label.padEnd(34)} ${text}`);

line('tools', `${tools.length} reviewed (${[...new Set(tools.map(t => t.app))].join(', ')})`);

const lexicalGolden = evaluateRetrieval(GOLDEN, index);
line('golden, lexical', describeReport(lexicalGolden));
const wideGolden = await widened(GOLDEN);
line('golden, with embeddings', `recall@1 ${wideGolden.recall1}, recall@5 ${wideGolden.recall5}, wrong-first ${wideGolden.wrong.length}`);

const lexicalShort = evaluateRetrieval(PARAPHRASES, index);
line('paraphrases, lexical', describeReport(lexicalShort));
const wideShort = await widened(PARAPHRASES);
line('paraphrases, embeddings', `recall@1 ${wideShort.recall1}, recall@5 ${wideShort.recall5}, wrong-first ${wideShort.wrong.length}`);

for (const [name, report] of [['golden', wideGolden], ['paraphrases', wideShort]] as const) {
  for (const row of report.wrong) console.log(`  wrong (${name}): ${row}`);
  for (const row of report.missed) console.log(`  missed (${name}): ${row}`);
}

const files = [
  'test/app-tools-retrieval.test.ts',
  'test/app-tools-embed.test.ts',
  'test/brain-conversation.test.ts',
  'test/brain-sessions.test.ts',
];
const root = fileURLToPath(new URL('..', import.meta.url));
console.log('');
line('transcripts', files.map(file => file.replace('test/', '')).join(', '));
const run = spawnSync('npx', ['tsx', '--test', ...files], { cwd: root, encoding: 'utf8' });
const counts = /# tests (\d+)[\s\S]{0,80}?# pass (\d+)\n# fail (\d+)/.exec(run.stdout ?? '');
if (counts) line('transcripts result', `${counts[1]} tests, ${counts[2]} pass, ${counts[3]} fail`);
else { console.log(run.stdout ?? ''); console.error(run.stderr ?? ''); }

// The gates. A shortlist may never lose the tool the owner asked for, and the numbers that
// were measured on 3 November are the floor: lexical recall@5 on the golden set is 1, the
// paraphrases reach 1 only with embeddings, and nothing may be answered that should be quiet.
const failures: string[] = [];
if (lexicalGolden.recall5 < 1) failures.push(`lexical golden recall@5 fell to ${lexicalGolden.recall5}`);
if (lexicalGolden.wrong.length) failures.push(`${lexicalGolden.wrong.length} quiet request(s) matched a tool`);
if (wideGolden.recall5 < 1) failures.push(`widened golden recall@5 fell to ${wideGolden.recall5}`);
if (wideShort.recall5 < lexicalShort.recall5) failures.push(`embeddings made the paraphrases worse: ${lexicalShort.recall5} -> ${wideShort.recall5}`);
// The paraphrase set is the one that keeps the embedding layer honest, so it is gated too, not
// just printed. Three of its rows were wrong-first before read/write polarity; one is left, the
// Ashitosh sentence that the note and calendar tools genuinely share.
if (lexicalShort.recall1 < 0.8) failures.push(`lexical paraphrase recall@1 fell to ${lexicalShort.recall1}`);
if (wideShort.recall1 < 0.8) failures.push(`widened paraphrase recall@1 fell to ${wideShort.recall1}`);
if (wideShort.recall5 < 1) failures.push(`widened paraphrase recall@5 fell to ${wideShort.recall5}`);
if (wideShort.wrong.length > 2) failures.push(`${wideShort.wrong.length} paraphrase requests answered with the wrong tool`);
if (run.status !== 0) failures.push('a transcript eval failed');
console.log('');
if (failures.length) { for (const failure of failures) console.error(`FAIL ${failure}`); process.exitCode = 1; }
else console.log('gate: pass');