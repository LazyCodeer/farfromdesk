import './brain-fixture-isolation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { withoutPreviewCaptions } from '../src/social-preview.js';

test('the final reply drops a verbatim caption the image preview already carried', () => {
  const s = new Store(':memory:');
  try {
    s.db.exec('CREATE TABLE IF NOT EXISTS social_drafts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, json TEXT NOT NULL)');
    const caption = 'Your coding agent does not need you at your desk. It needs you reachable.';
    s.db.prepare('INSERT INTO social_drafts VALUES(?,?,?)').run('d1', 1, JSON.stringify({ requestId: 'r1', caption }));
    const out = withoutPreviewCaptions(s, 'r1', `LinkedIn post ready\n\n${caption}\n\n#AI`);
    assert.doesNotMatch(out, /needs you reachable/);
    assert.match(out, /caption is with the image above/);
    assert.match(out, /#AI/);
    assert.equal(withoutPreviewCaptions(s, 'other', `x ${caption}`), `x ${caption}`, 'another request is untouched');
  } finally { s.db.close(); }
});
