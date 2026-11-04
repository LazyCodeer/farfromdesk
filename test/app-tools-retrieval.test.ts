import test from 'node:test';
import assert from 'node:assert/strict';
import { allPackTools } from '../src/app-tools/packs.js';
import { buildIndex, selectTools } from '../src/app-tools/retrieve.js';
import { GOLDEN, uncoveredTools } from '../src/app-tools/golden.js';
import { PARAPHRASE_COVERAGE } from '../src/app-tools/golden-paraphrase.js';
import { describeReport, evaluateRetrieval } from '../src/app-tools/metrics.js';

/**
 * The gate on retrieval quality.
 *
 * Recall@5 is the ceiling for whatever picks from the shortlist next (today the deterministic
 * scorer, later the model), so it has to stay perfect while there are four tools. Wrong-first
 * is the number the owner actually feels: a coding request that pulls up a Mac tool starts an
 * action nobody asked for. Both are asserted, not just printed.
 */
const tools = allPackTools();
const index = buildIndex(tools);
const report = evaluateRetrieval(GOLDEN, index, 5);

test('retrieval holds on the golden set', () => {
  // Printed on purpose: the measured numbers belong in the test log, not only in a doc.
  console.log(describeReport(report));
  for (const line of report.wrong) console.log('  wrong-first: ' + line);
  for (const line of report.missed) console.log('  missed: ' + line);
  assert.equal(report.wrong.length, 0, `a wrong first choice is a bug: ${report.wrong.join(' | ')}`);
  assert.equal(report.recall5, 1, `every request must have its tool in the top five: ${report.missed.join(' | ')}`);
  assert.ok(report.recall1 >= 0.9, `recall@1 ${report.recall1}`);
  assert.ok(report.recall3 >= 0.95, `recall@3 ${report.recall3}`);
});

test('every reviewed tool is covered by at least one golden utterance', () => {
  assert.deepEqual(uncoveredTools(tools, GOLDEN), [], 'a tool with no golden utterance cannot regress visibly');
  assert.ok(GOLDEN.length >= tools.length * 3, 'the set has to be wider than the tool list');
});

test('every reviewed tool has a paraphrase of its own, and every one lands first', () => {
  // A golden row is a sentence the tool was built from, so it can pass on the words its own
  // description shares. The paraphrase set is the owner's phrasing instead: it is what catches a
  // pack whose examples are the only sentences that work.
  assert.deepEqual(uncoveredTools(tools, PARAPHRASE_COVERAGE), [], 'a tool with no paraphrase of its own is only reachable by its own example sentences');
  const coverage = evaluateRetrieval(PARAPHRASE_COVERAGE, index, 5);
  console.log(describeReport(coverage));
  for (const line of coverage.wrong) console.log('  wrong-first: ' + line);
  assert.equal(coverage.wrong.length, 0, `a wrong first choice is a bug: ${coverage.wrong.join(' | ')}`);
  assert.equal(coverage.recall1, 1, `every paraphrase must land on its tool: ${coverage.missed.join(' | ')}`);
});

test('the two failures this gate was built from stay fixed', () => {
  // "schedule a call at 9 tomorrow morning" was dropped because no app was named and every
  // matched word looked generic; a real calendar request has to survive that.
  assert.equal(selectTools('schedule a call at 9 tomorrow morning', { index })[0]?.tool.name, 'calendar_create_event');
  // "add a retry to the sync loop" matched the calendar pack on "add" before the anchor rule.
  assert.deepEqual(selectTools('add a retry to the sync loop', { index }), []);
  assert.deepEqual(selectTools('write the failing test', { index }), []);
});

test('a bare app name is not a request, whatever app is in front', () => {
  for (const app of ['Notes', 'Calendar', 'Cursor']) assert.deepEqual(selectTools('notes', { app, index }), []);
});

test('the app in front is a prior, not a blanket permission', () => {
  // In Calendar, "am I free tomorrow" is a calendar question.
  assert.equal(selectTools('am I free tomorrow', { app: 'Calendar', index })[0]?.tool.name, 'calendar_list_events');
  // In Cursor, the same words are not a Mac action at all.
  assert.deepEqual(selectTools('add a retry to the sync loop', { app: 'Cursor', index }), []);
});

test('the shortlist stays small enough to send', () => {
  const widest = Math.max(...GOLDEN.map(entry => selectTools(entry.text, { app: entry.app, index, k: 20 }).length));
  // The research is blunt about prompt bloat: 15-20 tools is the ceiling for one turn. Four
  // tools in reach today, so this guards the shape, not the current size.
  assert.ok(widest <= 5, `a single request returned ${widest} tools`);
});
// Regression from the owner's own chat (4 November 2026): these were answered from window chrome,
// by the wrong app, or not at all. Typos are the owner's.
test('a bare check of an app runs that app overview read, typos included', async () => {
  const { overviewTool, normalizeRequest } = await import('../src/app-tools/retrieve.js');
  const cases: [string, string | undefined][] = [
    ['Check my recent notes', 'notes_recent'], ['Check my calender', 'calendar_list_events'], ['chek my notes', 'notes_recent'],
    ['check my reminders', 'reminders_open'], ['check my mails', 'mail_recent'], ['my agenda', 'calendar_list_events'],
    ['any meetings tomorrow', 'calendar_list_events'], ['Open notes', undefined], ['notes', undefined], ['remind me to call mom at 5', undefined],
    ['add a retry to the sync loop', undefined],
  ];
  for (const [text, want] of cases) assert.equal(overviewTool(text)?.name, want, text);
  assert.equal(normalizeRequest('Check my calender'), 'check my calendar');
  assert.equal(normalizeRequest('the calendars'), 'the calendars', 'a correct plural is never rewritten');
});
