import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTitleMarker,
  MAX_MARKER_CODEPOINTS,
  normalizeTitleMarker,
  restoreTitleMarker,
  titleMarkerSnapshot,
  stripTitleMarker
} from '../v3/worker/core/marker-title.mjs';

test('title markers normalize Unicode, whitespace, direction controls, and length', () => {
  assert.equal(normalizeTitleMarker('  sleep\n\t tab  '), 'sleep tab');
  assert.equal(normalizeTitleMarker('e\u0301'), 'é');
  assert.equal(normalizeTitleMarker('\u202e  💤  \u202c'), '💤');
  assert.equal([...normalizeTitleMarker('💤'.repeat(100))].length, MAX_MARKER_CODEPOINTS);
});

test('title marking is idempotent and collapses legacy duplicate prefixes', () => {
  assert.equal(applyTitleMarker('Page', '💤'), '💤 Page');
  assert.equal(applyTitleMarker('💤 Page', '💤'), '💤 Page');
  assert.equal(applyTitleMarker('💤  💤\tPage', '💤'), '💤 Page');
  assert.equal(applyTitleMarker('', '💤'), '💤');
  assert.equal(applyTitleMarker('Page', ''), 'Page');
});

test('release-side stripping removes only an exact normalized marker boundary', () => {
  assert.equal(stripTitleMarker('💤 Page', '💤'), 'Page');
  assert.equal(stripTitleMarker('💤💤 Page', '💤'), '💤💤 Page');
  assert.equal(stripTitleMarker('نوم مرحبا', 'نوم'), 'مرحبا');
});

test('title snapshots restore exact page content only while our marked value is unchanged', () => {
  const combining = 'Cafe\u0301';
  const snapshot = titleMarkerSnapshot(combining, '💤');
  assert.equal(snapshot.original, combining);
  assert.equal(snapshot.written, '💤 Café');
  assert.equal(restoreTitleMarker(snapshot.written, snapshot), combining);

  // A page update after preparation owns the title. Rollback is an exact
  // compare-and-swap and must not clobber it.
  assert.equal(restoreTitleMarker('Live page update', snapshot), 'Live page update');

  const empty = titleMarkerSnapshot('', '\u202e 💤 \u202c', 'https://example.test/');
  assert.equal(empty.original, '');
  assert.equal(empty.written, '💤 https://example.test/');
  assert.equal(restoreTitleMarker(empty.written, empty), '');
});
