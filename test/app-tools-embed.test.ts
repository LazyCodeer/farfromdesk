import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { allPackTools } from '../src/app-tools/packs.js';
import { buildIndex, selectTools, shortlistTools } from '../src/app-tools/retrieve.js';
import { embedBinaryPath, embedRank, embeddingsAvailable, embedDocs } from '../src/app-tools/embed.js';
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
  // 11 of the 15 golden rows carry the app, and the other four name it, so embeddings are the
  // only extra layer here and must change nothing.
  assert.equal(goldenLexical, 15);
  assert.equal(goldenUnion, 15);

  let lexical = 0;
  let union = 0;
  for (const row of PARAPHRASES) {
    if (selectTools(row.text, { app: row.app, index, k: 5 }).some(m => m.tool.name === row.tool)) lexical += 1;
    const shortlist = await shortlistTools(row.text, { app: row.app, index, k: 5 });
    if (shortlist.some(e => e.tool.name === row.tool)) union += 1;
    else assert.fail(`no shortlist for "${row.text}": ${shortlist.map(e => e.tool.name).join(', ')}`);
  }
  assert.equal(lexical, 8, 'the paraphrase set is only useful while it is harder than the words alone');
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