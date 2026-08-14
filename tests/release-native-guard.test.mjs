import test from 'node:test';
import assert from 'node:assert/strict';

const clone = value => structuredClone(value);

const deferred = () => {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return {promise, resolve};
};

const event = () => ({
  addListener() {},
  removeListener() {}
});

const storageArea = state => ({
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

test('release preflight remains inside the production native guard across reset', {timeout: 5000}, async t => {
  const local = {};
  const session = {};
  const live = new Map();
  const tab = {
    active: false,
    discarded: true,
    frozen: false,
    id: 701,
    incognito: false,
    status: 'unloaded',
    windowId: 7
  };
  const expectedScope = Object.freeze({
    incognito: false,
    windowId: tab.windowId,
    windowType: 'normal'
  });
  live.set(tab.id, clone(tab));

  let heldWindowRead;
  let holdGuardPreflight = true;
  let invalidations = 0;
  let reloads = 0;
  let windowReads = 0;
  const preflightStarted = deferred();

  globalThis.chrome = {
    runtime: {lastError: null},
    storage: {
      local: storageArea(local),
      managed: storageArea({}),
      onChanged: event(),
      session: storageArea(session)
    },
    tabs: {
      get(id, callback) {
        callback(live.has(id) ? clone(live.get(id)) : undefined);
      },
      query(options, callback) {
        callback([...live.values()].map(clone));
      },
      reload(id, options, callback) {
        reloads += 1;
        assert.deepEqual(options, {bypassCache: false});
        live.set(id, {
          ...live.get(id),
          discarded: false,
          frozen: false,
          status: 'complete'
        });
        callback();
      },
      onActivated: event(),
      onAttached: event(),
      onCreated: event(),
      onMoved: event(),
      onRemoved: event(),
      onReplaced: event(),
      onUpdated: event()
    },
    windows: {
      get(id, callback) {
        windowReads += 1;
        if (holdGuardPreflight && windowReads === 4) {
          heldWindowRead = () => callback({id, incognito: false, type: 'normal'});
          preflightStarted.resolve();
          return;
        }
        callback({id, incognito: false, type: 'normal'});
      },
      onFocusChanged: event()
    }
  };
  t.after(() => delete globalThis.chrome);

  const releaseUrl = new URL('../v3/worker/core/release.mjs', import.meta.url);
  releaseUrl.searchParams.set('native-guard-regression', `${Date.now()}-${Math.random()}`);
  const {
    TAB_RELEASE_NATIVE_PENDING,
    createReleaseHelper
  } = await import(releaseUrl);
  const {ownership} = await import('../v3/worker/core/ownership.mjs');

  assert.equal(await ownership.start(1, 0), 1);
  const {releaseTab} = createReleaseHelper({
    cancelTakeover: async () => false,
    getStatus: id => ownership.status(id),
    invalidate: async id => {
      invalidations += 1;
      return ownership.invalidate(id);
    },
    reserveRelease: () => ({release() {}}),
    resolveId: id => ownership.resolveId(id),
    takeoverSnapshot: () => [],
    withNativeMutationGuard: (task, id, allowedAttemptId, preflight) =>
      ownership.withNativeMutationGuard(task, id, allowedAttemptId, preflight)
  });
  releaseTab.interval = 0;
  releaseTab.polls = 10;
  releaseTab.stableReads = 2;

  const staleRelease = releaseTab(clone(tab), {expectedScope});
  await preflightStarted.promise;
  assert.equal(windowReads, 4, 'the held read is the guard preflight, after three admission reads');
  assert.equal(reloads, 0, 'reload cannot run while authoritative preflight is unresolved');

  const resetting = ownership.reset();
  assert.equal(typeof heldWindowRead, 'function');
  heldWindowRead();

  await assert.rejects(staleRelease, error => {
    assert.equal(error?.code, TAB_RELEASE_NATIVE_PENDING);
    return true;
  });
  await resetting;
  assert.equal(reloads, 0, 'a reset that advances the native fence cancels the stale reload');
  assert.equal(invalidations, 0, 'a reset-rejected release cannot erase ownership afterward');

  // The rejected attempt must not poison a later, freshly admitted release.
  // Reconcile the still-suspended tab, then prove the same production helper
  // invokes exactly one reload and one matching ownership invalidation.
  holdGuardPreflight = false;
  heldWindowRead = undefined;
  windowReads = 0;
  assert.equal(await ownership.start(1, 0), 1);
  const released = await releaseTab(clone(live.get(tab.id)), {expectedScope});

  assert.equal(released.id, tab.id);
  assert.equal(released.discarded, false);
  assert.equal(released.status, 'complete');
  assert.equal(reloads, 1);
  assert.equal(invalidations, 1);
  assert.deepEqual(await ownership.snapshot(), {});
});
