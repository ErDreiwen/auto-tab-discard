import test from 'node:test';
import assert from 'node:assert/strict';

const clone = value => structuredClone(value);

const deferred = () => {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return {promise, reject, resolve};
};

const createEvents = () => {
  const listeners = new Map();
  const event = name => ({
    addListener(listener) {
      const entries = listeners.get(name) || new Set();
      entries.add(listener);
      listeners.set(name, entries);
    },
    removeListener(listener) {
      listeners.get(name)?.delete(listener);
    }
  });

  return {
    clear() {
      listeners.clear();
    },
    emit(name, ...args) {
      for (const listener of [...listeners.get(name) || []]) {
        listener(...args);
      }
    },
    event
  };
};

const createStorageArea = (state, trace) => ({
  get(keys, callback) {
    if (keys === null || keys === undefined) {
      callback(clone(state));
      return;
    }
    if (typeof keys === 'string') {
      callback(keys in state ? {[keys]: clone(state[keys])} : {});
      return;
    }
    if (Array.isArray(keys)) {
      callback(Object.fromEntries(keys.filter(key => key in state)
        .map(key => [key, clone(state[key])])));
      return;
    }
    callback(Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
      key,
      key in state ? clone(state[key]) : clone(fallback)
    ])));
  },
  remove(keys, callback = () => {}) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      delete state[key];
    }
    callback();
  },
  set(values, callback = () => {}) {
    if (Object.values(values).some(value => value?.marker?.state === 'direct-native-orphan')) {
      trace.push('orphan-persisted');
    }
    Object.assign(state, clone(values));
    callback();
  }
});

const install = () => {
  const events = createEvents();
  const live = new Map();
  const local = {};
  const session = {};
  const trace = [];
  let queryGate;

  const holdNextQuery = () => {
    assert.equal(queryGate, undefined, 'only one tabs.query gate may be active');
    const started = deferred();
    queryGate = {
      callback: undefined,
      release(tabs) {
        assert.equal(typeof queryGate?.callback, 'function', 'held tabs.query must start before release');
        const callback = queryGate.callback;
        queryGate = undefined;
        callback(clone(tabs ?? [...live.values()]));
      },
      started
    };
    return {
      release: tabs => queryGate.release(tabs),
      started: started.promise
    };
  };

  globalThis.chrome = {
    runtime: {lastError: null},
    storage: {
      local: createStorageArea(local, trace),
      onChanged: events.event('storage.changed'),
      session: createStorageArea(session, trace)
    },
    tabs: {
      get(id, callback) {
        callback(live.has(id) ? clone(live.get(id)) : undefined);
      },
      query(options, callback) {
        if (queryGate) {
          assert.equal(queryGate.callback, undefined, 'only the selected tabs.query may be held');
          queryGate.callback = callback;
          queryGate.started.resolve();
          return;
        }
        callback([...live.values()].map(clone));
      },
      onActivated: events.event('tabs.activated'),
      onAttached: events.event('tabs.attached'),
      onCreated: events.event('tabs.created'),
      onRemoved: events.event('tabs.removed'),
      onReplaced: events.event('tabs.replaced'),
      onUpdated: events.event('tabs.updated')
    }
  };

  return {events, holdNextQuery, live, session, trace};
};

const importOwnership = async label => {
  const url = new URL('../v3/worker/core/ownership.mjs', import.meta.url);
  url.searchParams.set('native-mutation-guard', `${label}-${Date.now()}-${Math.random()}`);
  return (await import(url)).ownership;
};

const seedPendingWorkerLoss = async (environment, original) => {
  environment.live.set(original.id, original);
  const deadWorker = await importOwnership('dead-worker');
  const attemptId = await deadWorker.beginDirectNative(original);
  assert.equal(typeof attemptId, 'string');
  assert.equal((await deadWorker.status(original.id)).marker?.state, 'direct-native-pending');
  environment.events.clear();
  return attemptId;
};

const assertOrphanBlocked = error => {
  assert.equal(error?.code, 'DIRECT_NATIVE_ORPHAN_BLOCKED');
  return true;
};

const pendingTab = id => ({
  active: false,
  discarded: false,
  frozen: true,
  id,
  status: 'complete',
  windowId: 1
});

test('guard reconciles a lost predecessor before ownership.start and never invokes the task', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const predecessor = pendingTab(101);
  const attemptId = await seedPendingWorkerLoss(environment, predecessor);
  environment.live.delete(predecessor.id);
  environment.live.set(102, {
    ...predecessor,
    discarded: true,
    frozen: false,
    id: 102,
    status: 'unloaded'
  });

  const recovered = await importOwnership('pre-start-reconcile');
  let invocations = 0;
  await assert.rejects(recovered.withNativeMutationGuard(() => {
    invocations += 1;
  }), assertOrphanBlocked);

  assert.equal(invocations, 0);
  const state = await recovered.snapshot();
  assert.equal(state[predecessor.id].state, 'direct-native-orphan');
  assert.equal(state[predecessor.id].attemptId, attemptId);
  assert.equal(state[102], undefined, 'reconciliation must not guess the successor');
});

test('a predecessor removal queued first creates the orphan before a later guard can run', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const predecessor = pendingTab(201);
  await seedPendingWorkerLoss(environment, predecessor);

  const recovered = await importOwnership('remove-first');
  assert.equal(await recovered.start(1, 0), 0);
  environment.live.delete(predecessor.id);

  environment.events.emit('tabs.removed', predecessor.id, {isWindowClosing: false});
  let invocations = 0;
  await assert.rejects(recovered.withNativeMutationGuard(() => {
    invocations += 1;
  }), assertOrphanBlocked);

  assert.equal(invocations, 0);
  assert.equal((await recovered.snapshot())[predecessor.id].state, 'direct-native-orphan');
});

test('a removal delivered before a queued guard reaches its callback cancels that callback', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const predecessor = pendingTab(301);
  await seedPendingWorkerLoss(environment, predecessor);

  const recovered = await importOwnership('guard-first');
  assert.equal(await recovered.start(1, 0), 0);
  environment.trace.length = 0;

  let firstInvocations = 0;
  const first = recovered.withNativeMutationGuard(() => {
    firstInvocations += 1;
    environment.trace.push('browser-callback');
  }, predecessor.id);

  environment.live.delete(predecessor.id);
  environment.events.emit('tabs.removed', predecessor.id, {isWindowClosing: false});
  let laterInvocations = 0;
  const later = recovered.withNativeMutationGuard(() => {
    laterInvocations += 1;
  });

  await assert.rejects(first, assertOrphanBlocked);
  await assert.rejects(later, assertOrphanBlocked);
  assert.equal(firstInvocations, 0);
  assert.equal(laterInvocations, 0);
  assert.equal((await recovered.snapshot())[predecessor.id].state, 'direct-native-orphan');
});

test('a removal delivered while guard preflight is awaiting storage cancels the browser callback', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const predecessor = pendingTab(351);
  await seedPendingWorkerLoss(environment, predecessor);

  const recovered = await importOwnership('remove-during-preflight');
  const query = environment.holdNextQuery();
  let invocations = 0;
  const guarded = recovered.withNativeMutationGuard(() => {
    invocations += 1;
  }, predecessor.id);
  await query.started;

  environment.live.delete(predecessor.id);
  environment.events.emit('tabs.removed', predecessor.id, {isWindowClosing: false});
  query.release([]);

  await assert.rejects(guarded, assertOrphanBlocked);
  assert.equal(invocations, 0);
  assert.equal((await recovered.snapshot())[predecessor.id].state, 'direct-native-orphan');
});

test('direct-native authority lost while its guarded browser call is queued cannot invoke the call', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const target = pendingTab(381);
  environment.live.set(target.id, target);

  const ownership = await importOwnership('lost-own-authority');
  assert.equal(await ownership.start(1, 0), 0);
  const attemptId = await ownership.beginDirectNative(target);
  assert.equal(typeof attemptId, 'string');

  const query = environment.holdNextQuery();
  const reconciliation = ownership.reconcile();
  await query.started;
  let invocations = 0;
  const guarded = ownership.withNativeMutationGuard(() => {
    invocations += 1;
  }, target.id, attemptId);

  environment.live.set(target.id, {...target, active: true, frozen: false});
  environment.events.emit('tabs.activated', {tabId: target.id, windowId: target.windowId});
  query.release([{...target, active: true, frozen: false}]);

  await reconciliation;
  await assert.rejects(guarded, assertOrphanBlocked);
  assert.equal(invocations, 0);
  assert.equal((await ownership.status(target.id)).marker, undefined);
});

test('a queued reset invalidates guards from the preceding ownership epoch', {timeout: 5000}, async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const ownership = await importOwnership('queued-reset');
  assert.equal(await ownership.start(1, 0), 0);

  const query = environment.holdNextQuery();
  const oldReconciliation = ownership.reconcile();
  await query.started;

  let invocations = 0;
  const staleGuard = ownership.withNativeMutationGuard(() => {
    invocations += 1;
  });
  const resetting = ownership.reset();
  query.release();

  await oldReconciliation;
  await assert.rejects(staleGuard, assertOrphanBlocked);
  await resetting;
  assert.equal(invocations, 0);
  assert.deepEqual(await ownership.snapshot(), {});
});

test('a guard requested while reset is active cannot run after the reset completes', {timeout: 5000}, async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const ownership = await importOwnership('active-reset');
  assert.equal(await ownership.start(1, 0), 0);

  const query = environment.holdNextQuery();
  const resetting = ownership.reset();
  await query.started;

  let invocations = 0;
  const duringReset = ownership.withNativeMutationGuard(() => {
    invocations += 1;
  });
  query.release();

  await resetting;
  await assert.rejects(duringReset, assertOrphanBlocked);
  assert.equal(invocations, 0);
  assert.deepEqual(await ownership.snapshot(), {});
});
