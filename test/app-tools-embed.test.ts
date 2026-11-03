import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { allPackTools } from '../src/app-tools/packs.js';
import { buildIndex, selectTools, shortlistTools } from '../src/app-tools/retrieve.js';
import { embedBinaryPath, embedRank, embeddingsAvailable, embedDocs, embedStats, resetEmbedStats, resetEmbedCache } from '../src/app-tools/embed.js';
import { GOLDEN } from '../src/app-tools/golden.js';
import { PARAPHRASES } from '../src/app-tools/golden-paraphrase.js';

/**
 * What the embedding layer is allowed to do, and the proof that it does it.
 *
 * It may widen a shortlist for the app the owner is in. It may not rerank: measured on the
 * same golden set, embedding reranking dropped recall@1 from 15/15 to 11/15, and as a
 * standalone ranker it scored 14/15 with no score threshold separating right from wrong. These
 * tests hold that line, and they skip (not pass) when the compiled helper is absent so a
 * fresh checkout without Xcode still runs the rest of the suite.
 */
const tools = allPackTools();
const index = buildIndex(tools);
const haveHelper = existsSync(embedBinaryPath());

test('the helper is honest about being unavailable', async (t) => {
  if (haveHelper) return;
  t.skip('native/tool-embed is not built on this machine');
  assert.equal(await embeddingsAvailable(), false);
  assert.equal(await embedRank('anything', embedDocs(tools)), null);
});

test('an embedding search answers one hit per tool, best line first', async (t) => {
  if (!haveHelper) return t.skip('native/tool-embed is not built on this machine');
  const ranked = await embedRank('block out an hour for the dentist on Friday', embedDocs(tools), 3);
  assert.ok(ranked && ranked.length > 0, 'the helper answered nothing');
  const names = ranked.map(hit => hit.id);
  assert.equal(new Set(names).size, names.length, 'a tool must appear once, not once per line');
  assert.equal(names[0], 'calendar_create_event');
});

test('the shortlist keeps the golden set at recall@5 and lifts the paraphrases', async (t) => {
  if (!haveHelper) return t.skip('native/tool-embed is not built on this machine');
  let goldenLexical = 0;
  let goldenUnion = 0;
  for (const row of GOLDEN) {
    if (!row.tool) continue;
    if (selectTools(row.text, { app: row.app, index, k: 5 }).some(m => m.tool.name === row.tool)) goldenLexical += 1;
    if ((await shortlistTools(row.text, { app: row.app, index, k: 5 })).some(e => e.tool.name === row.tool)) goldenUnion += 1;
  }
  // Every golden row that expects a tool must keep it, and the count comes from the set itself:
  // it dropped from 15 to 12 when the unreviewed Notes search tool was removed.
  const goldenWanted = GOLDEN.filter(row => row.tool).length;
  assert.ok(goldenWanted >= 10);
  assert.equal(goldenLexical, goldenWanted);
  assert.equal(goldenUnion, goldenWanted);

  let lexical = 0;
  let union = 0;
  for (const row of PARAPHRASES) {
    if (selectTools(row.text, { app: row.app, index, k: 5 }).some(m => m.tool.name === row.tool)) lexical += 1;
    const shortlist = await shortlistTools(row.text, { app: row.app, index, k: 5 });
    if (shortlist.some(e => e.tool.name === row.tool)) union += 1;
    else assert.fail(`no shortlist for "${row.text}": ${shortlist.map(e => e.tool.name).join(', ')}`);
  }
  // The paraphrase set exists to stay harder than the words alone: if the lexical pass ever
  // lifted every row on its own this set would stop testing the embedding layer at all. The
  // count is a floor, not a target: it was 6 when the set was written, 8 after the intent and
  // pack rules, and 9 after read/write polarity, while the union has to stay complete.
  assert.ok(lexical >= 8, `the lexical pass lost ground: ${lexical}/${PARAPHRASES.length}`);
  assert.ok(lexical < PARAPHRASES.length, 'the paraphrase set is no longer harder than words alone');
  assert.equal(union, PARAPHRASES.length);
});

test('the lexical order is never rearranged by the embedding layer', async (t) => {
  if (!haveHelper) return t.skip('native/tool-embed is not built on this machine');
  for (const row of [...GOLDEN, ...PARAPHRASES]) {
    const lexical = selectTools(row.text, { app: row.app, index, k: 5 }).map(m => m.tool.name);
    const union = (await shortlistTools(row.text, { app: row.app, index, k: 5 })).map(e => e.tool.name);
    assert.deepEqual(union.slice(0, lexical.length), lexical, `order changed for "${row.text}"`);
    const extras = union.slice(lexical.length);
    for (const name of extras) {
      assert.equal(tools.find(tool => tool.name === name)?.app, row.app, `${name} came from another app`);
    }
  }
});

test('no app in front means no embedding candidates at all', async (t) => {
  if (!haveHelper) return t.skip('native/tool-embed is not built on this machine');
  // The measured win came from requests made while the owner is in the app. Without that
  // anchor, "add a retry to the sync loop" could be widened into another app's tools.
  assert.deepEqual(await shortlistTools('remind me to buy milk later', { index }), []);
  assert.deepEqual(await shortlistTools('add a retry to the sync loop', { app: 'Cursor', index }), []);
});
test('the pack docs are embedded once per tool set, not once per turn', async (t) => {
  if (!haveHelper) return t.skip('native/tool-embed is not built on this machine');
  resetEmbedCache();
  resetEmbedStats();
  await shortlistTools('remind me to buy milk later', { app: 'Notes', index });
  const cold = embedStats();
  assert.ok(cold.docsEmbedded > 5, `a cold turn should embed the pack's lines, not ${cold.docsEmbedded}`);
  assert.equal(cold.cacheHits, 0, 'nothing to hit on the first turn');
  await shortlistTools('save this for later: invoice 442', { app: 'Notes', index });
  const warm = embedStats();
  assert.equal(warm.cacheHits, 1, 'the second turn should reuse the cached doc vectors');
  assert.equal(warm.docsEmbedded - cold.docsEmbedded, 1, 'a warm turn embeds the owner words and nothing else');
});

test('a changed tool set is embedded again instead of reusing stale vectors', async (t) => {
  if (!haveHelper) return t.skip('native/tool-embed is not built on this machine');
  resetEmbedStats();
  const edited = buildIndex(tools.map(tool => (tool.name === 'notes_create_note' ? { ...tool, keywords: [...tool.keywords, 'plumber'] } : tool)));
  await shortlistTools('remind me to buy milk later', { app: 'Notes', index: edited });
  const stats = embedStats();
  assert.equal(stats.cacheHits, 0, 'edited tool text must not be scored against the old vectors');
  assert.ok(stats.docsEmbedded > 5, `an edited tool set should be embedded again, not ${stats.docsEmbedded}`);
});
