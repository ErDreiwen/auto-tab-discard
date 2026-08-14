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
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      delete state[key];
    }
    callback();
  },
  set(values, callback = () => {}) {
    Object.assign(state, clone(values));
    callback();
  }
});

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

const install = () => {
  const events = createEvents();
  const session = {};
  const local = {};
  const managed = {};
  const live = new Map();
  const mutations = {discard: 0, reload: 0, script: 0};
  globalThis.chrome = {
    runtime: {lastError: null},
    scripting: {
      executeScript() {
        mutations.script += 1;
        assert.fail('an orphan fence must never execute renderer code');
      }
    },
    storage: {
      local: createStorageArea(local),
      managed: createStorageArea(managed),
      onChanged: events.event('storage.changed'),
      session: createStorageArea(session)
    },
    tabs: {
      discard() {
        mutations.discard += 1;
        assert.fail('an orphan fence must never issue another native discard');
      },
      get(id, callback) {
        callback(live.has(id) ? clone(live.get(id)) : undefined);
      },
      query(options, callback) {
        callback([...live.values()].map(clone));
      },
      reload() {
        mutations.reload += 1;
        assert.fail('an orphan fence must never reload an inferred successor');
      },
      onActivated: events.event('tabs.activated'),
      onAttached: events.event('tabs.attached'),
      onCreated: events.event('tabs.created'),
      onRemoved: events.event('tabs.removed'),
      onReplaced: events.event('tabs.replaced'),
      onUpdated: events.event('tabs.updated')
    }
  };
  return {events, live, mutations, session};
};

const importOwnership = async label => {
  const url = new URL('../v3/worker/core/ownership.mjs', import.meta.url);
  url.searchParams.set('direct-native-orphan', `${label}-${Date.now()}-${Math.random()}`);
  return (await import(url)).ownership;
};

const seedLostPredecessor = async (environment, original) => {
  environment.live.set(original.id, original);
  const deadWorker = await importOwnership('dead-worker');
  const attemptId = await deadWorker.beginDirectNative(original);
  assert.equal(typeof attemptId, 'string');
  assert.equal((await deadWorker.status(original.id)).marker?.state, 'direct-native-pending');
  environment.events.clear();
  return attemptId;
};

test('replacement before recovered-worker import creates one nonce-only global orphan fence', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const original = {
    active: false,
    discarded: false,
    frozen: true,
    id: 101,
    index: 4,
    status: 'complete',
    title: 'private predecessor title',
    url: 'https://private-predecessor.example/path',
    windowId: 7
  };
  const attemptId = await seedLostPredecessor(environment, original);

  // Edge replaced the predecessor while no MV3 listener existed. None of the
  // live shapes can prove which row, if any, is the physical successor.
  const candidates = [
    {...original, discarded: true, frozen: false, id: 202, status: 'unloaded'},
    {...original, discarded: true, frozen: false, id: 203, status: 'unloaded'},
    {...original, discarded: false, frozen: true, id: 204, status: 'complete'},
    {...original, discarded: false, frozen: false, id: 205, status: 'complete'}
  ];
  environment.live.delete(original.id);
  for (const tab of candidates) {
    environment.live.set(tab.id, tab);
  }

  const recovered = await importOwnership('recovered-no-event');
  assert.equal(await recovered.start(1, 0), 0);
  const state = await recovered.snapshot();
  assert.deepEqual(Object.keys(state), [String(original.id)]);
  assert.deepEqual(state[original.id], {
    attemptId,
    state: 'direct-native-orphan',
    updatedAt: state[original.id].updatedAt
  });
  assert.equal(Number.isFinite(state[original.id].updatedAt), true);
  assert.deepEqual(Object.keys(state[original.id]).sort(), ['attemptId', 'state', 'updatedAt']);
  const serialized = JSON.stringify(state);
  for (const privateValue of [original.url, original.title]) {
    assert.equal(serialized.includes(privateValue), false);
  }
  for (const forbiddenKey of ['expiresAt', 'favicon', 'index', 'title', 'url', 'visual', 'windowId']) {
    assert.equal(Object.hasOwn(state[original.id], forbiddenKey), false, forbiddenKey);
  }

  for (const candidate of candidates) {
    const status = await recovered.status(candidate.id);
    assert.equal(status.nativeOrphan, true);
    assert.equal(status.marker, undefined,
      'no guessed candidate receives the missing predecessor nonce or an inferred owner');
    assert.equal(await recovered.hasBlockingNativeIntent(candidate.id), true);
    const fresh = await recovered.resolveFresh(candidate);
    assert.equal(fresh.nativeOrphan, true);
    assert.equal(fresh.state, 'direct-native-orphan');
    assert.equal(fresh.marker, undefined);
    assert.equal(fresh.tab.id, candidate.id);
  }

  // Every direct entry point rechecks the serialized global fence. Repeats do
  // not script, reload, start a takeover, or issue a second native operation.
  assert.equal(await recovered.begin(candidates[3]), null);
  assert.equal(await recovered.beginDirectNative(candidates[2]), null);
  assert.equal(await recovered.queueTakeover(candidates[2]), false);
  assert.deepEqual(await recovered.adopt(candidates[0]), {busy: true, nativeOrphan: true});
  await recovered.invalidate(original.id);
  environment.events.emit('tabs.removed', original.id, {isWindowClosing: false});
  environment.events.emit('tabs.activated', {tabId: candidates[3].id, windowId: candidates[3].windowId});
  assert.equal((await recovered.snapshot())[original.id].state, 'direct-native-orphan',
    'ordinary invalidation, activation, and removal cannot clear a lost nonce');

  const releaseUrl = new URL('../v3/worker/core/release.mjs', import.meta.url);
  releaseUrl.searchParams.set('direct-native-orphan-release', `${Date.now()}-${Math.random()}`);
  const {createReleaseHelper} = await import(releaseUrl);
  const {releaseTab} = createReleaseHelper({
    cancelTakeover: async () => true,
    getStatus: id => recovered.status(id),
    invalidate: id => recovered.invalidate(id),
    reserveRelease: () => ({release() {}}),
    resolveId: id => recovered.resolveId(id),
    runtime: () => chrome.runtime,
    tabs: () => chrome.tabs,
    takeoverSnapshot: () => []
  });
  await assert.rejects(releaseTab(candidates[0]), error => {
    assert.equal(error.code, 'TAB_RELEASE_NATIVE_PENDING');
    assert.equal(error.disposition, 'native-pending');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.deepEqual(environment.mutations, {discard: 0, reload: 0, script: 0});

  const originalNow = Date.now;
  Date.now = () => originalNow() + 365 * 24 * 60 * 60 * 1000;
  try {
    await recovered.reconcile();
  }
  finally {
    Date.now = originalNow;
  }
  assert.equal((await recovered.snapshot())[original.id].state, 'direct-native-orphan',
    'the session fence has no wall-clock expiry');

  // Even a full query can land between predecessor disappearance and successor
  // enumeration, so absence is not causal cleanup authority.
  environment.live.clear();
  environment.live.set(999, {
    active: true,
    discarded: false,
    frozen: false,
    id: 999,
    status: 'complete'
  });
  assert.equal(await recovered.reconcile(), 0);
  assert.equal((await recovered.snapshot())[original.id].state, 'direct-native-orphan');
  assert.equal(await recovered.hasBlockingNativeIntent(999), true);

  // Explicit settings reset is an authorized session-state boundary.
  await recovered.reset();
  assert.deepEqual(await recovered.snapshot(), {});
  assert.equal(await recovered.hasBlockingNativeIntent(999), false);
});

test('a late actual onReplaced event alone transfers the orphan nonce to its settled successor', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const original = {
    active: false,
    discarded: false,
    frozen: true,
    id: 301,
    status: 'complete'
  };
  const attemptId = await seedLostPredecessor(environment, original);
  const successor = {
    ...original,
    discarded: true,
    frozen: false,
    id: 302,
    status: 'unloaded'
  };
  const unrelated = {
    ...successor,
    id: 303
  };
  environment.live.delete(original.id);
  environment.live.set(successor.id, successor);
  environment.live.set(unrelated.id, unrelated);

  const recovered = await importOwnership('recovered-late-event');
  await recovered.reconcile();
  let state = await recovered.snapshot();
  assert.equal(state[original.id].state, 'direct-native-orphan');
  assert.equal(state[successor.id], undefined);
  assert.equal(state[unrelated.id], undefined);

  environment.events.emit('tabs.replaced', successor.id, original.id);
  state = await recovered.snapshot();
  assert.equal(state[original.id], undefined);
  assert.deepEqual(state[successor.id], {
    attemptId,
    source: 'physical-only',
    state: 'owned',
    updatedAt: state[successor.id].updatedAt
  });
  assert.equal(state[unrelated.id], undefined,
    'the real lineage event transfers authority to exactly one successor');
  assert.equal((await recovered.status(successor.id)).nativeOrphan, undefined);
  assert.equal((await recovered.status(successor.id)).marker.attemptId, attemptId);
  assert.equal((await recovered.status(unrelated.id)).marker, undefined);
  assert.equal(recovered.resolveId(original.id), successor.id);
  assert.deepEqual(environment.mutations, {discard: 0, reload: 0, script: 0});
});

test('a late replacement transfers a transitional successor into the ordinary per-tab pending fence', async t => {
  const environment = install();
  t.after(() => delete globalThis.chrome);
  const original = {
    active: false,
    discarded: false,
    frozen: true,
    id: 401,
    status: 'complete'
  };
  const attemptId = await seedLostPredecessor(environment, original);
  const transitional = {
    ...original,
    frozen: false,
    id: 402
  };
  environment.live.delete(original.id);
  environment.live.set(transitional.id, transitional);

  const recovered = await importOwnership('recovered-transitional-event');
  await recovered.reconcile();
  assert.equal((await recovered.snapshot())[original.id].state, 'direct-native-orphan');

  environment.events.emit('tabs.replaced', transitional.id, original.id);
  let state = await recovered.snapshot();
  assert.equal(state[original.id], undefined);
  assert.deepEqual(state[transitional.id], {
    attemptId,
    state: 'direct-native-pending',
    updatedAt: state[transitional.id].updatedAt
  });
  assert.equal((await recovered.status(transitional.id)).nativeOrphan, undefined);
  assert.equal(await recovered.hasBlockingNativeIntent(transitional.id), true);
  assert.equal((await recovered.resolveFresh(transitional)).state, 'direct-native-pending');
  assert.equal(await recovered.beginDirectNative(transitional), null);

  const settled = {
    ...transitional,
    discarded: true,
    status: 'unloaded'
  };
  environment.live.set(settled.id, settled);
  environment.events.emit('tabs.updated', settled.id, {
    discarded: true,
    status: 'unloaded'
  }, clone(settled));
  state = await recovered.snapshot();
  assert.equal(state[settled.id].state, 'owned');
  assert.equal(state[settled.id].source, 'physical-only');
  assert.equal(state[settled.id].attemptId, attemptId);
  assert.deepEqual(environment.mutations, {discard: 0, reload: 0, script: 0});
});
