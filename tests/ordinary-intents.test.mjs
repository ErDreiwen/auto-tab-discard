import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createOrdinaryIntents,
  KEY,
  PENDING_TTL
} from '../v3/worker/core/ordinary-intents.mjs';

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
  const first = await queue.enqueue({id: 1, incognito: false, windowId: 7});
  assert.equal(await queue.enqueue({id: 1, incognito: false, windowId: 7}), first);
  await queue.replace(1, 2);
  assert.equal((await queue.snapshot())[0].tabId, 2);
  await queue.removed(2);
  assert.equal((await queue.snapshot())[0].status, 'lost');
});

test('rejects incomplete tab identity and privacy scope without creating a journal', async () => {
  const {area, state} = storageFixture();
  const queue = createOrdinaryIntents({area, now: () => 1000});
  assert.equal(await queue.enqueue({id: 1, windowId: 7}), undefined);
  assert.equal(await queue.enqueue({id: 1, incognito: false}), undefined);
  assert.equal(await queue.enqueue({id: 1, incognito: 'false', windowId: 7}), undefined);
  assert.equal(state[KEY], undefined);
});

test('twenty jobs receive one terminal outcome after worker restart without duplicate discard', async () => {
  const {area} = storageFixture();
  const beforeDeath = createOrdinaryIntents({area, now: () => 1000});
  for (let id = 1; id <= 20; id += 1) {
    await beforeDeath.enqueue({id, incognito: false, windowId: id <= 10 ? 1 : 2});
  }

  const live = new Map(Array.from({length: 20}, (_, index) => {
    const id = index + 1;
    return [id, {
      id,
      active: false,
      autoDiscardable: true,
      discarded: id <= 10,
      frozen: false,
      incognito: false,
      windowId: id <= 10 ? 1 : 2
    }];
  }));
  const nativeCalls = new Map();
  const afterRestart = createOrdinaryIntents({area, now: () => 2000});
  const outcomes = await afterRestart.recover({
    getTab: async id => live.get(id),
    revalidate: async tabs => new Set(tabs.map(tab => tab.id)),
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
  for (let id = 1; id <= 3; id += 1) {
    await queue.enqueue({id, incognito: false, windowId: 1});
  }
  const tabs = new Map([
    [1, {id: 1, active: true, discarded: false, frozen: false, autoDiscardable: true, incognito: false, windowId: 1}],
    [2, {id: 2, active: false, discarded: false, frozen: true, autoDiscardable: true, incognito: false, windowId: 1}],
    [3, {id: 3, active: false, discarded: false, frozen: false, autoDiscardable: false, incognito: false, windowId: 1}]
  ]);
  const outcomes = await queue.recover({
    getTab: async id => tabs.get(id),
    resume: async () => assert.fail('unsafe job must not resume')
  });
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['cancelled', 'cancelled', 'cancelled']);
  assert.equal(Object.keys(state[KEY].records).length, 3);
});

test('expired pending work is deleted before recovery and never resumed', async () => {
  const {area, state} = storageFixture();
  let clock = 1000;
  const beforeDeath = createOrdinaryIntents({area, now: () => clock});
  await beforeDeath.enqueue({id: 9, incognito: false, windowId: 3});
  clock += PENDING_TTL + 1;

  const afterRestart = createOrdinaryIntents({area, now: () => clock});
  let revalidated = false;
  let resumed = false;
  assert.deepEqual(await afterRestart.recover({
    getTab: async () => ({
      active: false,
      autoDiscardable: true,
      discarded: false,
      frozen: false,
      id: 9,
      incognito: false,
      windowId: 3
    }),
    revalidate: async () => {
      revalidated = true;
      return new Set([9]);
    },
    resume: async () => {
      resumed = true;
      return true;
    }
  }), []);
  assert.equal(revalidated, false);
  assert.equal(resumed, false);
  assert.equal(state[KEY], undefined);
});

test('restart resumes only IDs approved by full live policy and fails closed on policy errors', async () => {
  const {area} = storageFixture();
  const beforeDeath = createOrdinaryIntents({area, now: () => 1000});
  for (const id of [20, 21, 22]) {
    await beforeDeath.enqueue({id, incognito: false, windowId: 4});
  }
  const live = id => ({
    active: false,
    autoDiscardable: true,
    discarded: false,
    frozen: false,
    id,
    incognito: false,
    windowId: 4
  });
  const resumed = [];
  const afterRestart = createOrdinaryIntents({area, now: () => 2000});
  const outcomes = await afterRestart.recover({
    getTab: async id => live(id),
    revalidate: async tabs => {
      assert.deepEqual(tabs.map(tab => tab.id), [20, 21, 22]);
      return new Set([21]);
    },
    resume: async tab => {
      resumed.push(tab.id);
      return true;
    }
  });
  assert.deepEqual(resumed, [21]);
  assert.deepEqual(outcomes.map(({status, tabId}) => ({status, tabId})), [
    {status: 'cancelled', tabId: 20},
    {status: 'completed', tabId: 21},
    {status: 'cancelled', tabId: 22}
  ]);

  const {area: failedArea} = storageFixture();
  const failedBefore = createOrdinaryIntents({area: failedArea, now: () => 1000});
  await failedBefore.enqueue({id: 30, incognito: false, windowId: 5});
  const failedAfter = createOrdinaryIntents({area: failedArea, now: () => 2000});
  const failed = await failedAfter.recover({
    getTab: async () => live(30),
    revalidate: async () => {
      throw Error('managed policy unavailable');
    },
    resume: async () => assert.fail('policy read failure must not resume')
  });
  assert.equal(failed[0].status, 'cancelled');
});

test('restart rejects window or privacy drift before policy or native work', async () => {
  const {area} = storageFixture();
  const queue = createOrdinaryIntents({area, now: () => 1000});
  await queue.enqueue({id: 40, incognito: true, windowId: 8});
  await queue.enqueue({id: 41, incognito: false, windowId: 9});
  let checked = false;
  const outcomes = await queue.recover({
    getTab: async id => ({
      active: false,
      autoDiscardable: true,
      discarded: false,
      frozen: false,
      id,
      incognito: id === 40 ? false : false,
      windowId: id === 41 ? 10 : 8
    }),
    revalidate: async () => {
      checked = true;
      return new Set([40, 41]);
    },
    resume: async () => assert.fail('scope drift must not resume')
  });
  assert.equal(checked, false);
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['cancelled', 'cancelled']);
});

test('restart rechecks expiry and exact scope after the full policy pass', async () => {
  const {area} = storageFixture();
  let clock = 1000;
  const queue = createOrdinaryIntents({area, now: () => clock});
  await queue.enqueue({id: 50, incognito: false, windowId: 10});
  await queue.enqueue({id: 51, incognito: false, windowId: 10});
  const reads = new Map();
  const live = id => ({
    active: false,
    autoDiscardable: true,
    discarded: false,
    frozen: false,
    id,
    incognito: false,
    windowId: id === 51 && (reads.get(id) || 0) > 1 ? 11 : 10
  });
  const resumed = [];
  const outcomes = await queue.recover({
    getTab: async id => {
      reads.set(id, (reads.get(id) || 0) + 1);
      return live(id);
    },
    revalidate: async tabs => {
      assert.deepEqual(tabs.map(tab => tab.id), [50, 51]);
      clock += PENDING_TTL + 1;
      return new Set([50, 51]);
    },
    resume: async tab => {
      resumed.push(tab.id);
      return true;
    }
  });
  assert.deepEqual(resumed, []);
  assert.deepEqual(outcomes.map(({status, tabId}) => ({status, tabId})), [
    {status: 'cancelled', tabId: 50},
    {status: 'cancelled', tabId: 51}
  ]);

  // Exercise the post-policy scope refresh independently of the expiry gate.
  clock = 1000;
  const {area: movedArea} = storageFixture();
  const movedQueue = createOrdinaryIntents({area: movedArea, now: () => clock});
  await movedQueue.enqueue({id: 52, incognito: false, windowId: 10});
  let read = 0;
  const moved = await movedQueue.recover({
    getTab: async () => ({
      active: false,
      autoDiscardable: true,
      discarded: false,
      frozen: false,
      id: 52,
      incognito: false,
      windowId: ++read === 1 ? 10 : 11
    }),
    revalidate: async () => new Set([52]),
    resume: async () => assert.fail('post-policy window drift must not resume')
  });
  assert.equal(moved[0].status, 'cancelled');
});

test('tab read errors fail while confirmed absence is lost', async () => {
  const {area} = storageFixture();
  const queue = createOrdinaryIntents({area, now: () => 1000});
  await queue.enqueue({id: 60, incognito: false, windowId: 1});
  await queue.enqueue({id: 61, incognito: false, windowId: 1});
  const outcomes = await queue.recover({
    getTab: async id => {
      if (id === 60) throw Error('tabs.get transport failed');
      return undefined;
    },
    revalidate: async () => assert.fail('no unreadable or missing tab may reach policy'),
    resume: async () => assert.fail('no unreadable or missing tab may resume')
  });
  assert.deepEqual(outcomes.map(({status, tabId}) => ({status, tabId})), [
    {status: 'failed', tabId: 60},
    {status: 'lost', tabId: 61}
  ]);
});

test('reset pause invalidates pending mutations and removes the journal last without resurrection', async () => {
  const state = {};
  let holdSet = false;
  let setStarted;
  let releaseSet;
  globalThis.chrome = {runtime: {lastError: null}};
  const area = {
    get(defaults, callback) { callback({...defaults, ...structuredClone(state)}); },
    remove(key, callback) { delete state[key]; callback(); },
    set(values, callback) {
      const apply = () => {
        Object.assign(state, structuredClone(values));
        callback();
      };
      if (holdSet) {
        holdSet = false;
        setStarted?.();
        releaseSet = apply;
      }
      else {
        apply();
      }
    }
  };
  const queue = createOrdinaryIntents({area, now: () => 1000});
  const id = await queue.enqueue({id: 70, incognito: false, windowId: 1});
  holdSet = true;
  const started = new Promise(resolve => setStarted = resolve);
  const lateTransition = queue.transition(id, 'running');
  await started;

  const reset = queue.beginReset();
  assert.ok(reset);
  assert.equal(await queue.enqueue({id: 71, incognito: false, windowId: 1}), undefined);
  assert.equal(await queue.transition(id, 'completed'), false);
  const cleared = reset.clear();
  releaseSet();
  await lateTransition;
  await cleared;
  assert.equal(state[KEY], undefined);

  reset.complete();
  assert.equal(typeof await queue.enqueue({id: 72, incognito: false, windowId: 1}), 'string');
  assert.deepEqual(Object.values(state[KEY].records).map(record => record.tabId), [72]);
});

test('malformed and future envelopes are discarded fail-closed', async () => {
  const {area, state} = storageFixture();
  state[KEY] = {version: 99, records: {bad: {tabId: 1}}};
  const queue = createOrdinaryIntents({area});
  assert.deepEqual(await queue.snapshot(), []);
  assert.equal(state[KEY], undefined);
});
