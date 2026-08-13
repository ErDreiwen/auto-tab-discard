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

const createStorageArea = (state, trace, control = {}) => ({
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
    const selected = Array.isArray(keys) ? keys : [keys];
    if (control.failNextRemove) {
      control.failNextRemove = false;
      chrome.runtime.lastError = {message: 'deterministic replacement remove failure'};
      callback();
      chrome.runtime.lastError = null;
      return;
    }
    if (control.failNextPartialRemove && selected.length > 1) {
      control.failNextPartialRemove = false;
      delete state[selected[0]];
      chrome.runtime.lastError = {message: 'deterministic partial remove failure'};
      callback();
      chrome.runtime.lastError = null;
      return;
    }
    for (const key of selected) {
      delete state[key];
    }
    callback();
  },
  set(values, callback = () => {}) {
    const writesOrphan = Object.values(values)
      .some(value => value?.marker?.state === 'direct-native-orphan');
    if (writesOrphan && control.failNextOrphanSet) {
      control.failNextOrphanSet = false;
      chrome.runtime.lastError = {message: 'deterministic orphan persistence failure'};
      callback();
      chrome.runtime.lastError = null;
      return;
    }
    if (writesOrphan) {
      trace.push('orphan-persisted');
    }
    if (control.applyNextSetThenFail) {
      control.applyNextSetThenFail = false;
      Object.assign(state, clone(values));
      chrome.runtime.lastError = {message: 'deterministic applied set failure'};
      callback();
      chrome.runtime.lastError = null;
      return;
    }
    if (control.failNextSet) {
      control.failNextSet = false;
      chrome.runtime.lastError = {message: 'deterministic replacement set failure'};
      callback();
      chrome.runtime.lastError = null;
      return;
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
  const storageControl = {
    applyNextSetThenFail: false,
    failNextOrphanSet: false,
    failNextPartialRemove: false,
    failNextRemove: false,
    failNextSet: false
  };
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
      session: createStorageArea(session, trace, storageControl)
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

  return {events, holdNextQuery, live, session, storageControl, trace};
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

test('a failed orphan write keeps unrelated native guards closed until durable reconciliation', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const predecessor = pendingTab(371);
  const attemptId = await seedPendingWorkerLoss(environment, predecessor);

  const recovered = await importOwnership('failed-orphan-write');
  assert.equal(await recovered.start(1, 0), 0);
  const unrelated = pendingTab(372);
  environment.live.set(unrelated.id, unrelated);
  environment.storageControl.failNextOrphanSet = true;
  environment.live.delete(predecessor.id);

  // The event listener cannot await storage. Queue the guard immediately after
  // it so this proves serializer ordering as well as eventual recovery.
  const warn = console.warn;
  console.warn = () => {};
  environment.events.emit('tabs.removed', predecessor.id, {isWindowClosing: false});
  let invocations = 0;
  try {
    assert.equal(await recovered.hasBlockingNativeIntent(unrelated.id), true,
      'command preflight must repair and expose the global orphan before renderer work');
    await assert.rejects(recovered.withNativeMutationGuard(() => {
      invocations += 1;
    }, unrelated.id), assertOrphanBlocked);
  }
  finally {
    console.warn = warn;
  }

  assert.equal(invocations, 0, 'storage ambiguity must never reopen native mutation');
  const state = await recovered.snapshot();
  assert.equal(state[predecessor.id].state, 'direct-native-orphan');
  assert.equal(state[predecessor.id].attemptId, attemptId);
  assert.equal(environment.trace.filter(value => value === 'orphan-persisted').length, 1,
    'the guard must force exactly one successful reconciliation after the failed write');
});

test('a partial batched removal is reconciled before status can trust a surviving marker', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const first = pendingTab(373);
  const second = pendingTab(374);
  environment.live.set(first.id, first);
  environment.live.set(second.id, second);

  const ownership = await importOwnership('partial-remove-recovery');
  assert.equal(await ownership.start(1, 0), 0);
  assert.equal(typeof await ownership.beginDirectNative(first), 'string');
  assert.equal(typeof await ownership.beginDirectNative(second), 'string');
  // Activation is authoritative wake/cancellation evidence. Both invalidations
  // are synchronous, disjoint record mutations and therefore share one remove.
  environment.live.set(first.id, {...first, active: true, frozen: false});
  environment.live.set(second.id, {...second, active: true, frozen: false});
  environment.storageControl.failNextPartialRemove = true;

  const invalidations = await Promise.allSettled([
    ownership.invalidate(first.id),
    ownership.invalidate(second.id)
  ]);
  assert.deepEqual(invalidations.map(result => result.status), ['rejected', 'rejected']);
  assert.match(invalidations[0].reason.message, /partial remove failure/);
  assert.match(invalidations[1].reason.message, /partial remove failure/);

  const query = environment.holdNextQuery();
  let statusSettled = false;
  const status = ownership.status(second.id).then(value => {
    statusSettled = true;
    return value;
  });
  await query.started;
  assert.equal(statusSettled, false,
    'status must not expose a surviving half-batch before live reconciliation');
  query.release();

  assert.deepEqual(await status, {
    attemptId: undefined,
    marker: undefined,
    takeover: false
  });
  assert.equal(await ownership.hasBlockingNativeIntent(second.id), false,
    'an authoritative wake must not remain permanently blocked by a partial remove');
  assert.deepEqual(await ownership.snapshot(), {});
});

test('a failed single-tab activation invalidation cannot strand native intent', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const target = pendingTab(391);
  environment.live.set(target.id, target);

  const ownership = await importOwnership('single-activation-remove-recovery');
  assert.equal(await ownership.start(1, 0), 0);
  assert.equal(typeof await ownership.beginDirectNative(target), 'string');
  environment.live.set(target.id, {...target, active: true, frozen: false});
  environment.storageControl.failNextRemove = true;

  await assert.rejects(ownership.invalidate(target.id), /remove failure/);
  assert.deepEqual(await ownership.status(target.id), {
    attemptId: undefined,
    marker: undefined,
    takeover: false
  });
  assert.equal(await ownership.hasBlockingNativeIntent(target.id), false);
  assert.deepEqual(await ownership.snapshot(), {});
});

test('an applied-then-failed direct-native begin cannot create a false native blocker', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const target = pendingTab(390);
  environment.live.set(target.id, target);

  const ownership = await importOwnership('applied-direct-begin-failure');
  assert.equal(await ownership.start(1, 0), 0);
  environment.storageControl.applyNextSetThenFail = true;
  await assert.rejects(ownership.beginDirectNative(target), /applied set failure/);
  assert.equal(environment.session['__discardOwnership:tab:390']?.marker.state,
    'direct-native-pending', 'the adapter must model an ambiguous applied write');

  assert.deepEqual(await ownership.status(target.id), {
    attemptId: undefined,
    marker: undefined,
    takeover: false
  });
  assert.equal(await ownership.hasBlockingNativeIntent(target.id), false);
  assert.deepEqual(await ownership.snapshot(), {});
});

test('a failed definitive native cancellation retires only its exact pending nonce', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const target = pendingTab(392);
  environment.live.set(target.id, target);

  const ownership = await importOwnership('single-native-cancel-recovery');
  assert.equal(await ownership.start(1, 0), 0);
  const attemptId = await ownership.beginDirectNative(target);
  const authority = ownership.lateAuthority(target.id);
  assert.equal(await ownership.finish(target, attemptId, undefined, {
    allowClaimed: false,
    directNative: true,
    lateNative: true
  }), false);
  environment.storageControl.failNextRemove = true;

  await assert.rejects(ownership.cancelDirectNative(authority, attemptId), /remove failure/);
  assert.deepEqual(await ownership.status(target.id), {
    attemptId: undefined,
    marker: undefined,
    takeover: false
  });
  assert.equal(await ownership.hasBlockingNativeIntent(target.id), false);
});

test('callback-first native cancellation finds its exact predecessor nonce after replacement', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const predecessor = pendingTab(404);
  environment.live.set(predecessor.id, predecessor);

  const ownership = await importOwnership('cancel-before-replacement-drain');
  assert.equal(await ownership.start(1, 0), 0);
  const attemptId = await ownership.beginDirectNative(predecessor);
  const authority = ownership.lateAuthority(predecessor.id);
  assert.equal(await ownership.finish(predecessor, attemptId, undefined, {
    allowClaimed: false,
    directNative: true,
    lateNative: true
  }), false);
  const successor = {...predecessor, id: 405};
  environment.live.delete(predecessor.id);
  environment.live.set(successor.id, successor);

  const cancelled = ownership.cancelDirectNative(authority, attemptId);
  environment.events.emit('tabs.replaced', successor.id, predecessor.id);
  assert.equal(await cancelled, true);
  await ownership.diagnostics();
  assert.deepEqual(await ownership.snapshot(), {});
  assert.equal(await ownership.hasBlockingNativeIntent(successor.id), false);
});

test('a failed queued-takeover cleanup cannot resurrect completed requested work', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const target = pendingTab(393);
  environment.live.set(target.id, target);

  const ownership = await importOwnership('single-queue-cleanup-recovery');
  assert.equal(await ownership.start(1, 0), 0);
  const queueId = await ownership.queueTakeover(target, {cancelled: false});
  assert.equal(typeof queueId, 'string');
  environment.storageControl.failNextRemove = true;

  await assert.rejects(ownership.clearQueuedTakeover(target.id, queueId), /remove failure/);
  assert.equal((await ownership.status(target.id)).marker, undefined);
  assert.deepEqual(await ownership.snapshot(), {});
});

test('queued-takeover cleanup finds its exact predecessor anchor after replacement', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const predecessor = pendingTab(406);
  environment.live.set(predecessor.id, predecessor);

  const ownership = await importOwnership('queue-cleanup-before-replacement-drain');
  assert.equal(await ownership.start(1, 0), 0);
  const queueId = await ownership.queueTakeover(predecessor, {cancelled: false});
  const successor = {...predecessor, id: 407};
  environment.live.delete(predecessor.id);
  environment.live.set(successor.id, successor);

  const cleared = ownership.clearQueuedTakeover(predecessor.id, queueId);
  environment.events.emit('tabs.replaced', successor.id, predecessor.id);
  assert.equal(await cleared, true);
  await ownership.diagnostics();
  assert.deepEqual(await ownership.snapshot(), {});
});

test('destructive entries rejected behind an earlier failed boundary still retire exact authority', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const activated = pendingTab(394);
  const rejected = pendingTab(395);
  const queued = pendingTab(396);
  for (const tab of [activated, rejected, queued]) {
    environment.live.set(tab.id, tab);
  }

  const ownership = await importOwnership('rejected-destructive-followers');
  assert.equal(await ownership.start(1, 0), 0);
  assert.equal(typeof await ownership.beginDirectNative(activated), 'string');
  const rejectedAttempt = await ownership.beginDirectNative(rejected);
  const rejectedAuthority = ownership.lateAuthority(rejected.id);
  assert.equal(await ownership.finish(rejected, rejectedAttempt, undefined, {
    allowClaimed: false,
    directNative: true,
    lateNative: true
  }), false);
  const queueId = await ownership.queueTakeover(queued, {cancelled: false});
  assert.equal(typeof queueId, 'string');

  environment.live.set(activated.id, {...activated, active: true, frozen: false});
  environment.storageControl.failNextRemove = true;
  const results = await Promise.allSettled([
    ownership.invalidate(activated.id),
    ownership.cancelDirectNative(rejectedAuthority, rejectedAttempt),
    ownership.clearQueuedTakeover(queued.id, queueId)
  ]);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected', 'rejected']);

  assert.equal((await ownership.status(rejected.id)).marker, undefined,
    'the uninvoked exact cancellation must be completed by reconciliation');
  assert.equal((await ownership.status(queued.id)).marker, undefined,
    'the uninvoked exact queue cleanup must be completed by reconciliation');
  assert.deepEqual(await ownership.snapshot(), {});
});

test('replacement remove failure deduplicates one live direct-native nonce at runtime', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const predecessor = pendingTab(375);
  environment.live.set(predecessor.id, predecessor);
  const ownership = await importOwnership('replacement-remove-runtime');
  assert.equal(await ownership.start(1, 0), 0);
  const attemptId = await ownership.beginDirectNative(predecessor);
  assert.equal(typeof attemptId, 'string');

  const successor = {
    ...predecessor,
    discarded: true,
    frozen: false,
    id: 376,
    status: 'unloaded'
  };
  environment.live.delete(predecessor.id);
  environment.live.set(successor.id, successor);
  environment.storageControl.failNextRemove = true;
  const warn = console.warn;
  console.warn = () => {};
  try {
    environment.events.emit('tabs.replaced', successor.id, predecessor.id);
    await ownership.diagnostics();
  }
  finally {
    console.warn = warn;
  }

  const status = await ownership.status(successor.id);
  assert.equal(status.nativeOrphan, undefined);
  assert.equal(status.marker?.state, 'direct-native-pending');
  assert.equal(status.marker?.attemptId, attemptId);
  assert.equal(environment.session['__discardOwnership:tab:375'], undefined);
  assert.equal(environment.session['__discardOwnership:tab:376']?.marker.attemptId, attemptId);
});

test('replacement successor-set failure is repaired from this worker authoritative lineage', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const predecessor = pendingTab(397);
  environment.live.set(predecessor.id, predecessor);
  const ownership = await importOwnership('replacement-set-runtime');
  assert.equal(await ownership.start(1, 0), 0);
  const attemptId = await ownership.beginDirectNative(predecessor);

  const successor = {
    ...predecessor,
    discarded: true,
    frozen: false,
    id: 398,
    status: 'unloaded'
  };
  environment.live.delete(predecessor.id);
  environment.live.set(successor.id, successor);
  environment.storageControl.failNextSet = true;
  const warn = console.warn;
  console.warn = () => {};
  try {
    environment.events.emit('tabs.replaced', successor.id, predecessor.id);
    await ownership.diagnostics();
  }
  finally {
    console.warn = warn;
  }

  assert.equal((await ownership.status(successor.id)).nativeOrphan, undefined);
  const state = await ownership.snapshot();
  assert.equal(state[predecessor.id], undefined);
  assert.equal(state[successor.id].state, 'direct-native-pending',
    'the live worker retains callback authority after moving the exact nonce');
  assert.equal(state[successor.id].attemptId, attemptId);
  assert.equal(environment.session['__discardOwnership:tab:397'], undefined);
  assert.equal(environment.session['__discardOwnership:tab:398']?.marker.attemptId, attemptId);
});

test('replacement rejected behind an earlier failed boundary still repairs its exact lineage', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const unrelated = pendingTab(399);
  const predecessor = pendingTab(400);
  environment.live.set(unrelated.id, unrelated);
  environment.live.set(predecessor.id, predecessor);
  const ownership = await importOwnership('replacement-skipped-runtime');
  assert.equal(await ownership.start(1, 0), 0);
  const attemptId = await ownership.beginDirectNative(predecessor);

  const successor = {
    ...predecessor,
    discarded: true,
    frozen: false,
    id: 401,
    status: 'unloaded'
  };
  environment.live.delete(predecessor.id);
  environment.live.set(successor.id, successor);
  environment.storageControl.failNextSet = true;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const failedEarlier = ownership.deferTakeover(unrelated.id);
    environment.events.emit('tabs.replaced', successor.id, predecessor.id);
    await assert.rejects(failedEarlier, /set failure/);
    await ownership.diagnostics();
  }
  finally {
    console.warn = warn;
  }

  const status = await ownership.status(successor.id);
  assert.equal(status.nativeOrphan, undefined);
  assert.equal(status.marker?.attemptId, attemptId);
  assert.equal((await ownership.snapshot())[predecessor.id], undefined);
});

test('fresh worker stays fail-closed after predecessor-only replacement set failure', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const predecessor = pendingTab(402);
  environment.live.set(predecessor.id, predecessor);
  const deadWorker = await importOwnership('replacement-set-dead-worker');
  assert.equal(await deadWorker.start(1, 0), 0);
  const attemptId = await deadWorker.beginDirectNative(predecessor);

  const successor = {
    ...predecessor,
    discarded: true,
    frozen: false,
    id: 403,
    status: 'unloaded'
  };
  environment.live.delete(predecessor.id);
  environment.live.set(successor.id, successor);
  environment.storageControl.failNextSet = true;
  const warn = console.warn;
  console.warn = () => {};
  try {
    environment.events.emit('tabs.replaced', successor.id, predecessor.id);
    await deadWorker.diagnostics();
  }
  finally {
    console.warn = warn;
  }
  environment.events.clear();

  const recovered = await importOwnership('replacement-set-restarted-worker');
  assert.equal(await recovered.start(1, 0), 0);
  const state = await recovered.snapshot();
  assert.equal(state[predecessor.id].state, 'direct-native-orphan');
  assert.equal(state[predecessor.id].attemptId, attemptId);
  assert.equal(state[successor.id], undefined,
    'without the lost worker replacement edge, topology must not be inferred');
  assert.equal((await recovered.status(successor.id)).nativeOrphan, true);
});

test('fresh worker deduplicates a torn replacement nonce without guessing topology', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const predecessor = pendingTab(377);
  environment.live.set(predecessor.id, predecessor);
  const deadWorker = await importOwnership('replacement-remove-dead-worker');
  assert.equal(await deadWorker.start(1, 0), 0);
  const attemptId = await deadWorker.beginDirectNative(predecessor);

  const successor = {
    ...predecessor,
    discarded: true,
    frozen: false,
    id: 378,
    status: 'unloaded'
  };
  environment.live.delete(predecessor.id);
  environment.live.set(successor.id, successor);
  environment.storageControl.failNextRemove = true;
  const warn = console.warn;
  console.warn = () => {};
  try {
    environment.events.emit('tabs.replaced', successor.id, predecessor.id);
    await deadWorker.diagnostics();
  }
  finally {
    console.warn = warn;
  }
  assert.equal(environment.session['__discardOwnership:tab:377']?.marker.attemptId, attemptId);
  assert.equal(environment.session['__discardOwnership:tab:378']?.marker.attemptId, attemptId);

  environment.events.clear();
  const recovered = await importOwnership('replacement-remove-restarted-worker');
  assert.equal(await recovered.start(1, 0), 1);
  const state = await recovered.snapshot();
  assert.equal(state[predecessor.id], undefined);
  assert.equal(state[successor.id].state, 'owned');
  assert.equal(state[successor.id].source, 'physical-only');
  assert.equal(state[successor.id].attemptId, attemptId);
  assert.equal((await recovered.status(successor.id)).nativeOrphan, undefined);
  assert.equal(environment.session['__discardOwnership:tab:377'], undefined);
});

test('a reused predecessor id keeps two live records with one nonce globally fail-closed', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const predecessor = pendingTab(379);
  environment.live.set(predecessor.id, predecessor);
  const deadWorker = await importOwnership('replacement-remove-reused-dead-worker');
  assert.equal(await deadWorker.start(1, 0), 0);
  const attemptId = await deadWorker.beginDirectNative(predecessor);

  const successor = {
    ...predecessor,
    discarded: true,
    frozen: false,
    id: 380,
    status: 'unloaded'
  };
  environment.live.delete(predecessor.id);
  environment.live.set(successor.id, successor);
  environment.storageControl.failNextRemove = true;
  const warn = console.warn;
  console.warn = () => {};
  try {
    environment.events.emit('tabs.replaced', successor.id, predecessor.id);
    await deadWorker.diagnostics();
  }
  finally {
    console.warn = warn;
  }
  environment.events.clear();
  // Chromium may reuse the old integer before the next worker starts. With no
  // onCreated observation in this worker, both rows are live and neither may be
  // selected as the nonce's authoritative lineage by shape alone.
  environment.live.set(predecessor.id, {
    ...predecessor,
    frozen: false,
    status: 'complete'
  });

  const recovered = await importOwnership('replacement-remove-reused-restart');
  await recovered.start(1, 0);
  const state = await recovered.snapshot();
  assert.equal(state[predecessor.id].attemptId, attemptId);
  assert.equal(state[successor.id].attemptId, attemptId);
  assert.equal((await recovered.status(999)).nativeOrphan, true);
  assert.equal(await recovered.hasBlockingNativeIntent(999), true);
  let invocations = 0;
  await assert.rejects(recovered.withNativeMutationGuard(() => {
    invocations += 1;
  }, 999), assertOrphanBlocked);
  assert.equal(invocations, 0);
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
