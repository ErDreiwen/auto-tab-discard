import test from 'node:test';
import assert from 'node:assert/strict';

import {createOrdinaryIntents, KEY} from '../v3/worker/core/ordinary-intents.mjs';

const storageFixture = () => {
  const state = {};
  globalThis.chrome = {runtime: {lastError: null}};
  return {
    area: {
      get(defaults, callback) { callback({...defaults, ...structuredClone(state)}); },
      remove(key, callback) { delete state[key]; callback(); },
      set(values, callback) { Object.assign(state, structuredClone(values)); callback(); }
    },
    state
  };
};

test('gives duplicate pending work one stable intent and follows replacement', async () => {
  const {area} = storageFixture();
  const queue = createOrdinaryIntents({area, now: () => 1000});
  const first = await queue.enqueue({id: 1, windowId: 7});
  assert.equal(await queue.enqueue({id: 1, windowId: 7}), first);
  await queue.replace(1, 2);
  assert.equal((await queue.snapshot())[0].tabId, 2);
  await queue.removed(2);
  assert.equal((await queue.snapshot())[0].status, 'lost');
});

test('twenty jobs receive one terminal outcome after worker restart without duplicate discard', async () => {
  const {area} = storageFixture();
  const beforeDeath = createOrdinaryIntents({area, now: () => 1000});
  for (let id = 1; id <= 20; id += 1) {
    await beforeDeath.enqueue({id, windowId: id <= 10 ? 1 : 2});
  }

  const live = new Map(Array.from({length: 20}, (_, index) => {
    const id = index + 1;
    return [id, {
      id,
      active: false,
      autoDiscardable: true,
      discarded: id <= 10,
      frozen: false
    }];
  }));
  const nativeCalls = new Map();
  const afterRestart = createOrdinaryIntents({area, now: () => 2000});
  const outcomes = await afterRestart.recover({
    getTab: async id => live.get(id),
    resume: async tab => {
      nativeCalls.set(tab.id, (nativeCalls.get(tab.id) || 0) + 1);
      tab.discarded = true;
      return true;
    }
  });
  assert.equal(outcomes.length, 20);
  assert.equal(new Set(outcomes.map(outcome => outcome.tabId)).size, 20);
  assert.deepEqual([...nativeCalls.keys()], [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.ok([...nativeCalls.values()].every(count => count === 1));
  assert.ok((await afterRestart.snapshot()).every(record => record.status === 'completed'));
});

test('restart revalidation cancels active, frozen, or newly protected tabs', async () => {
  const {area, state} = storageFixture();
  const queue = createOrdinaryIntents({area, now: () => 1000});
  for (let id = 1; id <= 3; id += 1) await queue.enqueue({id});
  const tabs = new Map([
    [1, {id: 1, active: true, discarded: false, frozen: false, autoDiscardable: true}],
    [2, {id: 2, active: false, discarded: false, frozen: true, autoDiscardable: true}],
    [3, {id: 3, active: false, discarded: false, frozen: false, autoDiscardable: false}]
  ]);
  const outcomes = await queue.recover({
    getTab: async id => tabs.get(id),
    resume: async () => assert.fail('unsafe job must not resume')
  });
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['cancelled', 'cancelled', 'cancelled']);
  assert.equal(Object.keys(state[KEY].records).length, 3);
});

test('malformed and future envelopes are discarded fail-closed', async () => {
  const {area, state} = storageFixture();
  state[KEY] = {version: 99, records: {bad: {tabId: 1}}};
  const queue = createOrdinaryIntents({area});
  assert.deepEqual(await queue.snapshot(), []);
  assert.equal(state[KEY], undefined);
});
