import test from 'node:test';
import assert from 'node:assert/strict';

const clone = value => structuredClone(value);

const createStorageArea = state => ({
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
    for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    callback();
  },
  set(values, callback = () => {}) {
    Object.assign(state, clone(values));
    callback();
  }
});

const createEventRegistry = () => {
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
  const emit = (name, ...args) => {
    for (const listener of [...listeners.get(name) || []]) listener(...args);
  };
  const clear = () => {
    for (const entries of listeners.values()) entries.clear();
  };
  return {clear, emit, event};
};

test('worker-loss pending intent reconciles a physical replacement and releases it loaded', async t => {
  const events = createEventRegistry();
  const sessionState = {};
  const localState = {};
  const managedState = {};
  const live = new Map();
  const lifecycle = [];
  let productionNativeDiscards = 0;
  let releaseReloads = 0;
  let releaseReload;

  const emitReplaced = (addedId, removedId) => {
    lifecycle.push(`replaced:${addedId}<-${removedId}`);
    events.emit('tabs.replaced', addedId, removedId);
  };
  const emitUpdated = (tab, changeInfo) => {
    lifecycle.push(`updated:${tab.id}:${tab.status}:${tab.discarded}`);
    events.emit('tabs.updated', tab.id, changeInfo, clone(tab));
  };

  globalThis.chrome = {
    runtime: {lastError: null},
    storage: {
      local: createStorageArea(localState),
      managed: createStorageArea(managedState),
      onChanged: events.event('storage.changed'),
      session: createStorageArea(sessionState)
    },
    tabs: {
      discard() {
        productionNativeDiscards += 1;
        assert.fail('reconciliation and release must not issue a second native discard');
      },
      get(id, callback) {
        callback(live.has(id) ? clone(live.get(id)) : undefined);
      },
      query(options, callback) {
        callback([...live.values()].map(clone));
      },
      reload(id, options, callback) {
        return releaseReload(id, options, callback);
      },
      onActivated: events.event('tabs.activated'),
      onAttached: events.event('tabs.attached'),
      onCreated: events.event('tabs.created'),
      onRemoved: events.event('tabs.removed'),
      onReplaced: events.event('tabs.replaced'),
      onUpdated: events.event('tabs.updated')
    },
    windows: {
      onFocusChanged: events.event('windows.focusChanged')
    }
  };
  t.after(() => delete globalThis.chrome);

  const original = {
    active: false,
    discarded: false,
    frozen: true,
    id: 101,
    index: 1,
    status: 'complete',
    url: 'https://worker-loss-release.example/',
    windowId: 7
  };
  live.set(original.id, original);

  // This queried module represents the worker that dies after persisting its
  // intent but before it can receive any native callback or lifecycle event.
  const deadModuleUrl = new URL('../v3/worker/core/ownership.mjs', import.meta.url);
  deadModuleUrl.searchParams.set('worker', 'lost-before-native-callback');
  const {ownership: deadWorker, STORAGE_KEY} = await import(deadModuleUrl);
  const attemptId = await deadWorker.beginDirectNative(original);
  assert.equal(typeof attemptId, 'string');
  assert.equal((await deadWorker.status(original.id)).marker?.state, 'direct-native-pending');
  assert.equal(sessionState[`${STORAGE_KEY}:tab:${original.id}`]?.marker?.attemptId, attemptId,
    'the dead worker persisted its native intent before loss');

  // Drop every listener owned by that module. Storage and live browser state
  // remain, accurately modelling an MV3 worker instance disappearing.
  events.clear();

  const {ownership: recoveredWorker} = await import('../v3/worker/core/ownership.mjs');
  assert.equal(await recoveredWorker.start(1, 0), 0);
  const restarted = await recoveredWorker.status(original.id);
  assert.equal(restarted.attemptId, undefined,
    'the replacement worker has no in-memory authority from the dead attempt');
  assert.equal(restarted.marker?.state, 'direct-native-pending');

  // An isolated/native authority physically discards the target. Edge may
  // implement that operation as a new tab identity followed by an unloaded
  // update. Production code observes these events but does not call discard.
  const physical = {
    ...original,
    discarded: true,
    frozen: false,
    id: 202,
    status: 'unloaded'
  };
  live.delete(original.id);
  live.set(physical.id, physical);
  emitReplaced(physical.id, original.id);
  emitUpdated(physical, {discarded: true, status: 'unloaded'});

  assert.equal(await recoveredWorker.reconcile(), 1);
  const reconciled = await recoveredWorker.snapshot();
  assert.deepEqual(Object.keys(reconciled), [String(physical.id)]);
  assert.equal(reconciled[physical.id].state, 'owned');
  assert.equal(reconciled[physical.id].source, 'physical-only',
    'worker loss forbids guessing that the physical completion was source:self');
  assert.equal(reconciled[physical.id].attemptId, attemptId);
  assert.equal(productionNativeDiscards, 0);

  // Use the real exported release singleton. During its one public reload,
  // model another Edge identity replacement plus loading/complete updates.
  const {releaseTab} = await import('../v3/worker/core/release.mjs');
  releaseTab.interval = 0;
  releaseTab.polls = 20;
  releaseTab.stableReads = 2;
  const loadedSuccessorId = 303;
  releaseReload = (id, options, callback) => {
    releaseReloads += 1;
    assert.equal(id, physical.id);
    assert.deepEqual(options, {bypassCache: false});
    const loading = {
      ...live.get(id),
      discarded: false,
      frozen: false,
      id: loadedSuccessorId,
      status: 'loading'
    };
    live.delete(id);
    live.set(loading.id, loading);
    emitReplaced(loading.id, id);
    emitUpdated(loading, {discarded: false, status: 'loading'});
    callback();
    queueMicrotask(() => {
      const complete = {...loading, status: 'complete'};
      live.set(complete.id, complete);
      emitUpdated(complete, {status: 'complete'});
    });
  };

  const released = await releaseTab(physical);
  assert.deepEqual({
    active: released.active,
    discarded: released.discarded,
    frozen: released.frozen,
    id: released.id,
    status: released.status
  }, {
    active: false,
    discarded: false,
    frozen: false,
    id: loadedSuccessorId,
    status: 'complete'
  });
  assert.equal(releaseReloads, 1, 'public release issues exactly one reload');
  assert.equal(productionNativeDiscards, 0, 'release never repeats the native discard');
  assert.equal(recoveredWorker.resolveId(physical.id), loadedSuccessorId);

  await new Promise(resolve => setImmediate(resolve));
  const stableReads = Array.from({length: 3}, () => clone(live.get(loadedSuccessorId)));
  assert.equal(stableReads.every(tab => tab.discarded === false && tab.frozen === false &&
    tab.status === 'complete' && tab.active === false), true,
  'the public result remains loaded and stable after lifecycle settlement');
  assert.deepEqual(await recoveredWorker.snapshot(), {},
    'the verified loaded successor has no stale ownership marker');
  assert.deepEqual(lifecycle, [
    'replaced:202<-101',
    'updated:202:unloaded:true',
    'replaced:303<-202',
    'updated:303:loading:false',
    'updated:303:complete:false'
  ]);
});
