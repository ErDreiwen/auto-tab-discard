import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FROZEN_CAPABILITY,
  frozenCapability,
  isDiscardedTab,
  isFrozenTab,
  isLoadedTab,
  isSuspendedTab,
  suspensionState
} from '../v3/worker/core/browser-state.mjs';
import {prepareDiscardTargets} from '../v3/worker/core/command-scope.mjs';

test('covers every supported and drifted frozen/discarded combination', () => {
  const cases = [
    [{id: 1, active: false, discarded: false}, FROZEN_CAPABILITY.ABSENT, 'loaded'],
    [{id: 1, active: false, discarded: false, frozen: false}, FROZEN_CAPABILITY.FALSE, 'loaded'],
    [{id: 1, active: false, discarded: false, frozen: true}, FROZEN_CAPABILITY.TRUE, 'frozen'],
    [{id: 1, active: false, discarded: true, frozen: false}, FROZEN_CAPABILITY.FALSE, 'discarded'],
    [{id: 1, active: true, discarded: false, frozen: false}, FROZEN_CAPABILITY.FALSE, 'loaded'],
    [{id: 1, active: true, discarded: false, frozen: true}, FROZEN_CAPABILITY.TRUE, 'active'],
    [{id: 1, active: false, discarded: false, frozen: null, status: 'loading'},
      FROZEN_CAPABILITY.TRANSITIONAL, 'unknown'],
    [{id: 1, active: false, discarded: false, frozen: 'sleeping'}, FROZEN_CAPABILITY.UNKNOWN, 'unknown'],
    [{id: 1, active: false, discarded: undefined, frozen: false}, FROZEN_CAPABILITY.FALSE, 'unknown']
  ];
  for (const [tab, capability, kind] of cases) {
    assert.equal(frozenCapability(tab), capability);
    assert.equal(suspensionState(tab).kind, kind);
  }
});

test('all state consumers share exact adapter predicates', () => {
  const loaded = {id: 1, active: false, discarded: false, frozen: false};
  const frozen = {...loaded, id: 2, frozen: true};
  const discarded = {...loaded, id: 3, discarded: true};
  const unknown = {...loaded, id: 4, frozen: 'sleeping'};
  assert.equal(isLoadedTab(loaded), true);
  assert.equal(isFrozenTab(frozen), true);
  assert.equal(isDiscardedTab(discarded), true);
  assert.equal(isSuspendedTab(frozen), true);
  assert.equal(isSuspendedTab(discarded), true);
  assert.equal(isSuspendedTab(unknown), false);
});

test('unknown suspension states fail closed without ownership, wake, or discard candidates', async () => {
  const result = await prepareDiscardTargets('discard-tabs', [
    {id: 1, active: false, discarded: false, frozen: 'sleeping', url: 'https://example.test/'},
    {id: 2, active: true, discarded: false, frozen: true, url: 'https://example.test/'}
  ], async () => assert.fail('unknown state must not read ownership'));
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.takeovers, []);
  assert.deepEqual(result.unknownSuspension.map(entry => entry.tab.id), [1]);
});
