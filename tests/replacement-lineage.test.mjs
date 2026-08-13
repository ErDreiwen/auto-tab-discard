import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pruneReplacementLineage,
  recordReplacement,
  resolveReplacement
} from '../v3/worker/core/replacement-lineage.mjs';

test('100,000 replacements retain O(live tabs plus exact active jobs)', () => {
  const edges = new Map();
  const liveIds = new Set();
  const referencedIds = new Set();
  const chains = 100;
  const replacements = 100_000;

  for (let index = 0; index < replacements; index += 1) {
    const chain = index % chains;
    const removedId = chain + index * 2 + 1;
    const addedId = removedId + chains * 2;
    if (index < chains) {
      liveIds.add(removedId);
      if (chain < 7) {
        referencedIds.add(removedId);
      }
    }
    liveIds.delete(removedId);
    liveIds.add(addedId);
    recordReplacement(edges, addedId, removedId);
  }

  assert.equal(edges.size > 90_000, true, 'the synthetic history must actually be large');
  const retained = pruneReplacementLineage(edges, {liveIds, referencedIds});
  assert.equal(retained, referencedIds.size);
  assert.equal(edges.size <= liveIds.size + referencedIds.size, true);
  for (const id of referencedIds) {
    assert.equal(liveIds.has(resolveReplacement(edges, id)), true);
  }

  referencedIds.clear();
  assert.equal(pruneReplacementLineage(edges, {liveIds, referencedIds}), 0);
});

test('a reused live id is never treated as a historical predecessor', () => {
  const edges = new Map();
  recordReplacement(edges, 2, 1);
  recordReplacement(edges, 3, 2);
  recordReplacement(edges, 1, 9);
  assert.equal(resolveReplacement(edges, 1), 1);
  assert.equal(resolveReplacement(edges, 9), 1);
});
