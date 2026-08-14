import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = relative => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

test('worker and popup exchange safe takeover snapshots for release availability and execution', async () => {
  const [discard, menu, popup] = await Promise.all([
    source('v3/worker/core/discard.mjs'),
    source('v3/worker/menu.mjs'),
    source('v3/data/popup/index.mjs')
  ]);

  assert.match(discard, /discard\.takeoverSnapshot = takeoverSnapshot;/);
  assert.doesNotMatch(discard, /discard\.takeoverJobs = takeoverJobs;/);
  assert.match(menu, /takeoverSnapshot: discard\.takeoverSnapshot,/);
  assert.match(menu, /request\.method === 'takeover-snapshot'/);
  assert.match(menu, /authorizePopupRequest\(request, query\)/);
  assert.match(menu, /filterPopupTakeoverSnapshot\(discard\.takeoverSnapshot\(\), selected\)/);
  assert.match(popup, /method: 'takeover-snapshot',[\s\S]*tabId: selected\?\.id,[\s\S]*windowId: selected\?\.windowId/);
  assert.match(popup, /releaseAvailability\(queryTabs, tab, \(\) => queryTakeoverSnapshot\(tab\)\)/);
});
