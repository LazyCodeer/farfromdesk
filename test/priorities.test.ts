import test from 'node:test';
import assert from 'node:assert/strict';
import { afterQuiet, parsePriorities, priorityRank, statedUrgent } from '../src/priorities.js';

test('priorities.md orders work and holds non-urgent reminders through quiet hours', () => {
  const p = parsePriorities(`# Priorities\n\n## Top priorities\n- Splice AI (this week)\n- Acme\n\n## Notes\n- not a priority line\nQuiet hours: 22:30-07:30\n`);
  assert.deepEqual(p.top, ['Splice AI', 'Acme']);
  assert.deepEqual(p.quiet, { from: 22 * 60 + 30, to: 7 * 60 + 30 });
  assert.equal(priorityRank(p, 'Fix the splice ai login bug'), 0);
  assert.equal(priorityRank(p, 'Call ACME back'), 1);
  assert.equal(priorityRank(p, 'Acmeville trip'), -1, 'whole words only');
  // 23:00 IST is inside quiet hours; it waits until 07:30 IST the next morning.
  const at = Date.parse('2026-11-06T23:00:00+05:30');
  assert.equal(afterQuiet(p, at, 'Asia/Kolkata'), Date.parse('2026-11-07T07:30:00+05:30'));
  const noon = Date.parse('2026-11-06T12:00:00+05:30');
  assert.equal(afterQuiet(p, noon, 'Asia/Kolkata'), noon);
  assert.equal(afterQuiet(parsePriorities(''), at, 'Asia/Kolkata'), at);
  assert.ok(statedUrgent('urgent: server down') && !statedUrgent('not urgent: tidy up'));
});
