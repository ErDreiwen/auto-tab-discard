import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inspectDirectKeeper,
  isKeeperCandidate,
  revalidateDirectKeeper,
  selectKeeper
} from '../v3/worker/core/keeper.mjs';

const loaded = (id, overrides = {}) => ({
  id,
  index: id,
  active: false,
  discarded: false,
  frozen: false,
  highlighted: false,
  status: 'complete',
  windowId: 10,
  groupId: -1,
  ...overrides
});

test('one keeper predicate excludes every state rejected by the direct executor', () => {
  const targetIds = new Set([1, 8]);
  const inProgress = id => id === 7;
  const options = {inProgress, targetIds};
  const candidates = [
    loaded(2),
    loaded(3, {frozen: true}),
    loaded(4, {status: 'unloaded'}),
    loaded(5, {highlighted: true}),
    loaded(6, {discarded: true}),
    loaded(7),
    loaded(8)
  ];

  assert.deepEqual(candidates.filter(tab => isKeeperCandidate(tab, options)).map(tab => tab.id), [2]);
  assert.equal(selectKeeper(candidates, {index: 4}, options).id, 2);
});

test('group inspection excludes every target-group member and chooses the nearest valid outsider', () => {
  const selected = loaded(1, {active: true, groupId: 4, highlighted: true, index: 5});
  const groupChild = loaded(2, {groupId: 4, index: 4});
  const far = loaded(3, {groupId: -1, index: 1});
  const near = loaded(4, {groupId: 9, index: 6});
  const state = inspectDirectKeeper('discard-tree', [selected, groupChild, far, near], selected);

  assert.deepEqual(state.targets.map(tab => tab.id), [1, 2]);
  assert.deepEqual([...state.targetIds], [1, 2]);
  assert.equal(state.needsKeeper, true);
  assert.equal(state.keeper.id, 4);
});

test('direct keeper revalidation follows the latest frozen and in-progress state', async () => {
  const selected = loaded(1, {active: true, highlighted: true, url: 'https://target.example/'});
  const first = loaded(2, {frozen: true});
  const second = loaded(2);
  const snapshots = [[selected, first], [selected, second]];
  const appeared = await revalidateDirectKeeper(async () => snapshots.shift(), 'discard-tab', selected);
  assert.equal(appeared.previous.keeper, undefined);
  assert.equal(appeared.keeper.id, 2);

  let reads = 0;
  const becameBusy = await revalidateDirectKeeper(async () => {
    reads += 1;
    return [selected, loaded(3)];
  }, 'discard-tab', selected, {
    inProgress: id => reads === 2 && id === 3
  });
  assert.equal(becameBusy.previous.keeper.id, 3);
  assert.equal(becameBusy.keeper, undefined);
});

test('revalidation refuses to create a helper after the selected target disappears', async () => {
  const selected = loaded(1, {active: true, highlighted: true});
  const state = await revalidateDirectKeeper(
    async () => [loaded(2)],
    'discard-tree',
    selected
  );

  assert.equal(state.selected, undefined);
  assert.equal(state.keeper, undefined);
  assert.equal(state.needsKeeper, false);
  assert.deepEqual(state.targets, []);
});

test('a background-only direct target does not request an unnecessary helper', () => {
  const selected = loaded(1, {active: false, highlighted: false});
  const state = inspectDirectKeeper('discard-tab', [selected], selected);

  assert.equal(state.needsKeeper, false);
  assert.equal(state.keeper, undefined);
});
