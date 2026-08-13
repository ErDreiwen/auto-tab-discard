import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RECORD_PREFIX,
  ROOT_SCHEMA,
  ROOT_VERSION,
  STORAGE_KEY,
  createOwnershipPersistence,
  recordKey,
  validateMarker
} from '../v3/worker/core/ownership-persistence.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const marker = (source = 'claimed') => ({
  attemptId: null,
  source,
  state: 'owned',
  updatedAt: 1
});
const readyRoot = (phase = 'ready') => ({
  phase,
  schema: ROOT_SCHEMA,
  version: ROOT_VERSION
});
const envelope = (id, value) => ({
  id,
  marker: value,
  schema: 'auto-tab-discard/ownership-marker',
  version: 1
});

const createStorage = (initial = {}, {quota = Infinity} = {}) => {
  const state = clone(initial);
  const control = {
    failNextSet: undefined,
    maxStoredBytes: 0,
    partialNextSet: undefined,
    removeCalls: 0,
    setCalls: 0
  };
  const entryBytes = new Map();
  let storedBytes = 0;
  const sizeOf = (key, value) => bytes({[key]: value});
  for (const [key, value] of Object.entries(state)) {
    const size = sizeOf(key, value);
    entryBytes.set(key, size);
    storedBytes += size;
  }
  control.maxStoredBytes = storedBytes;

  const selected = query => {
    if (query === null || query === undefined) {
      return clone(state);
    }
    if (typeof query === 'string') {
      return query in state ? {[query]: clone(state[query])} : {};
    }
    if (Array.isArray(query)) {
      return Object.fromEntries(query.filter(key => key in state).map(key => [key, clone(state[key])]));
    }
    const result = clone(query);
    for (const key of Object.keys(query)) {
      if (key in state) {
        result[key] = clone(state[key]);
      }
    }
    return result;
  };

  const area = {
    get(query, callback) {
      callback(selected(query));
    },
    remove(keys, callback) {
      control.removeCalls += 1;
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        storedBytes -= entryBytes.get(key) || 0;
        entryBytes.delete(key);
        delete state[key];
      }
      callback();
    },
    set(values, callback) {
      control.setCalls += 1;
      if (control.partialNextSet) {
        const partial = control.partialNextSet;
        control.partialNextSet = undefined;
        const selected = Object.entries(values).slice(0, Math.max(0, partial.entries || 0));
        for (const [key, value] of selected) {
          storedBytes -= entryBytes.get(key) || 0;
          const copy = clone(value);
          const size = sizeOf(key, copy);
          state[key] = copy;
          entryBytes.set(key, size);
          storedBytes += size;
        }
        control.maxStoredBytes = Math.max(control.maxStoredBytes, storedBytes);
        chrome.runtime.lastError = {message: partial.message || 'deterministic partial set failure'};
        callback();
        chrome.runtime.lastError = null;
        return;
      }
      if (control.failNextSet) {
        chrome.runtime.lastError = {message: control.failNextSet};
        control.failNextSet = undefined;
        callback();
        chrome.runtime.lastError = null;
        return;
      }
      let proposed = storedBytes;
      for (const [key, value] of Object.entries(values)) {
        proposed -= entryBytes.get(key) || 0;
        proposed += sizeOf(key, value);
      }
      if (proposed > quota) {
        chrome.runtime.lastError = {message: 'QUOTA_BYTES quota exceeded'};
        callback();
        chrome.runtime.lastError = null;
        return;
      }
      for (const [key, value] of Object.entries(values)) {
        const copy = clone(value);
        const size = sizeOf(key, copy);
        state[key] = copy;
        entryBytes.set(key, size);
      }
      storedBytes = proposed;
      control.maxStoredBytes = Math.max(control.maxStoredBytes, storedBytes);
      callback();
    }
  };
  return {area, control, state};
};

const persistenceApi = (session, local) => ({
  runtime: {lastError: null},
  storage: {local, session}
});

test('migrates a legacy root into versioned marker and phase envelopes exactly once', async () => {
  const first = marker('self');
  first.attemptId = 'legacy-self';
  const storage = createStorage({
    [STORAGE_KEY]: {7: first, 8: marker()}
  });
  globalThis.chrome = persistenceApi(storage.area, undefined);

  try {
    const persistence = createOwnershipPersistence(chrome);
    assert.deepEqual(await persistence.load(), {7: first, 8: marker()});
    assert.deepEqual(storage.state[STORAGE_KEY], readyRoot());
    assert.deepEqual(storage.state[recordKey(7)], envelope(7, first));
    assert.deepEqual(storage.state[recordKey(8)], envelope(8, marker()));
    assert.equal(Object.keys(storage.state).filter(key => key.startsWith(RECORD_PREFIX)).length, 2);
    assert.equal(persistence.diagnostics().migrations, 1);

    const restarted = createOwnershipPersistence(chrome);
    assert.deepEqual(await restarted.load(), {7: first, 8: marker()});
    assert.equal(Object.keys(storage.state).filter(key => key.startsWith(RECORD_PREFIX)).length, 2);
    assert.equal(restarted.diagnostics().migrations, 0);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('a partial record migration preserves its legacy authority and retries every marker', async () => {
  const first = {
    attemptId: 'partial-migration-one',
    state: 'direct-native-pending',
    updatedAt: 1
  };
  const second = {
    attemptId: 'partial-migration-two',
    state: 'direct-native-pending',
    updatedAt: 2
  };
  const legacy = {1: first, 2: second};
  const storage = createStorage({[STORAGE_KEY]: legacy});
  storage.control.partialNextSet = {
    entries: 1,
    message: 'deterministic partial migration record set'
  };
  globalThis.chrome = persistenceApi(storage.area, undefined);

  try {
    const interrupted = createOwnershipPersistence(chrome);
    await assert.rejects(interrupted.load(), /partial migration record set/);
    assert.deepEqual(storage.state[STORAGE_KEY], legacy,
      'the legacy root must remain authoritative until every record succeeds');
    assert.deepEqual(storage.state[recordKey(1)], envelope(1, first));
    assert.equal(storage.state[recordKey(2)], undefined,
      'the adapter deliberately applied only the first record');

    const restarted = createOwnershipPersistence(chrome);
    assert.deepEqual(await restarted.load(), legacy);
    assert.deepEqual(storage.state[STORAGE_KEY], readyRoot());
    assert.deepEqual(storage.state[recordKey(1)], envelope(1, first));
    assert.deepEqual(storage.state[recordKey(2)], envelope(2, second));
    assert.equal(restarted.diagnostics().migrations, 1);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('a partial fallback migration leaves the fallback authoritative until retry completes', async () => {
  const first = {
    attemptId: 'partial-fallback-one',
    state: 'direct-native-pending',
    updatedAt: 1
  };
  const second = {
    attemptId: 'partial-fallback-two',
    state: 'direct-native-pending',
    updatedAt: 2
  };
  const legacy = {11: first, 12: second};
  const session = createStorage({});
  const fallback = createStorage({[STORAGE_KEY]: legacy});
  session.control.partialNextSet = {
    entries: 1,
    message: 'deterministic partial fallback record set'
  };
  globalThis.chrome = persistenceApi(session.area, fallback.area);

  try {
    const interrupted = createOwnershipPersistence(chrome);
    await assert.rejects(interrupted.load(), /partial fallback record set/);
    assert.equal(session.state[STORAGE_KEY], undefined,
      'a partial destination must remain an untrusted rootless orphan set');
    assert.deepEqual(session.state[recordKey(11)], envelope(11, first));
    assert.equal(session.state[recordKey(12)], undefined);
    assert.deepEqual(fallback.state[STORAGE_KEY], legacy,
      'the complete fallback must survive until the primary root is ready');

    const restarted = createOwnershipPersistence(chrome);
    assert.deepEqual(await restarted.load(), legacy);
    assert.deepEqual(session.state[STORAGE_KEY], readyRoot());
    assert.deepEqual(session.state[recordKey(11)], envelope(11, first));
    assert.deepEqual(session.state[recordKey(12)], envelope(12, second));
    assert.equal(fallback.state[STORAGE_KEY], undefined);
    assert.equal(Object.keys(fallback.state).some(key => key.startsWith(RECORD_PREFIX)), false);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('resumes a torn migration and rejects malformed or future envelopes without partial trust', async () => {
  const storage = createStorage({
    [STORAGE_KEY]: readyRoot('migrating'),
    [recordKey(1)]: envelope(1, marker('self')),
    [recordKey(2)]: {...envelope(2, marker()), version: 99},
    [`${RECORD_PREFIX}not-an-id`]: envelope(3, marker())
  });
  globalThis.chrome = persistenceApi(storage.area, undefined);

  try {
    const persistence = createOwnershipPersistence(chrome);
    assert.deepEqual(await persistence.load(), {1: marker('self')});
    assert.deepEqual(storage.state[STORAGE_KEY], readyRoot());
    assert.equal(storage.state[recordKey(2)], undefined);
    // A malformed suffix is still under our private namespace and must expire.
    assert.equal(storage.state[`${RECORD_PREFIX}not-an-id`], undefined);
    assert.equal(persistence.diagnostics().rejectedRecords, 2);

    storage.state[STORAGE_KEY] = {...readyRoot(), version: ROOT_VERSION + 1};
    storage.state[recordKey(4)] = envelope(4, marker('self'));
    const future = createOwnershipPersistence(chrome);
    assert.deepEqual(await future.load(), {});
    assert.deepEqual(storage.state[STORAGE_KEY], readyRoot());
    assert.equal(Object.keys(storage.state).some(key => key.startsWith(RECORD_PREFIX)), false);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('migrates a local fallback without duplication and makes a valid session authoritative', async () => {
  const session = createStorage({});
  const local = createStorage({
    [STORAGE_KEY]: {12: marker('self')},
    preference: 'untouched'
  });
  globalThis.chrome = persistenceApi(session.area, local.area);

  try {
    const persistence = createOwnershipPersistence(chrome);
    assert.deepEqual(await persistence.load(), {12: marker('self')});
    assert.deepEqual(session.state[STORAGE_KEY], readyRoot());
    assert.deepEqual(session.state[recordKey(12)], envelope(12, marker('self')));
    assert.equal(local.state[STORAGE_KEY], undefined);
    assert.equal(local.state.preference, 'untouched');

    local.state[STORAGE_KEY] = {12: marker('adopted')};
    const restarted = createOwnershipPersistence(chrome);
    assert.deepEqual(await restarted.load(), {12: marker('self')});
    assert.equal(local.state[STORAGE_KEY], undefined, 'a stale local duplicate must not override session');
    assert.equal(Object.keys(session.state).filter(key => key.startsWith(RECORD_PREFIX)).length, 1);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('marker validation fails closed for unknown fields and invalid ownership phases', () => {
  assert.equal(validateMarker(marker()).ok, true);
  assert.equal(validateMarker({...marker(), url: 'https://private.example/'}).ok, false);
  assert.equal(validateMarker({...marker(), source: 'future-owner'}).ok, false);
  assert.equal(validateMarker({
    attemptId: 'queued',
    source: 'requested',
    state: 'takeover-queued',
    updatedAt: 1
  }).ok, true);
  assert.equal(validateMarker({
    attemptId: 'queued',
    source: 'self',
    state: 'takeover-queued',
    updatedAt: 1
  }).ok, false);
  const orphan = {
    attemptId: 'lost-direct-native-nonce',
    state: 'direct-native-orphan',
    updatedAt: 1
  };
  assert.deepEqual(validateMarker(orphan), {ok: true, marker: orphan});
  for (const privateOrExpiringField of [
    {expiresAt: Date.now() + 60000},
    {source: 'physical-only'},
    {url: 'https://private.example/'},
    {visual: {complete: true, favicon: false, repair: false, title: false}},
    {windowId: 4}
  ]) {
    assert.equal(validateMarker({...orphan, ...privateOrExpiringField}).ok, false);
  }
});

const event = () => ({addListener() {}});
const installOwnershipChrome = (storage, tabs, {query} = {}) => {
  globalThis.chrome = {
    runtime: {lastError: null},
    storage: {
      local: {},
      session: storage.area
    },
    tabs: {
      discard() {
        assert.fail('reconciliation must never perform a native discard');
      },
      get(id, callback) {
        callback(tabs.find(tab => tab.id === id));
      },
      query(options, callback) {
        if (query) {
          query(options, callback);
        }
        else {
          callback(tabs.map(clone));
        }
      },
      reload() {
        assert.fail('reconciliation must never wake or reload a tab');
      },
      onAttached: event(),
      onCreated: event(),
      onRemoved: event(),
      onReplaced: event(),
      onUpdated: event()
    }
  };
};

test('session loss and a future schema reconcile live discards as claimed without a wake sweep', async () => {
  const tabs = [
    {active: false, discarded: true, id: 31, status: 'unloaded'},
    {active: false, discarded: false, id: 32, status: 'complete'}
  ];
  const storage = createStorage({
    [STORAGE_KEY]: {...readyRoot(), version: ROOT_VERSION + 1},
    [recordKey(31)]: envelope(31, marker('self'))
  });
  installOwnershipChrome(storage, tabs);

  try {
    const url = new URL('../v3/worker/core/ownership.mjs', import.meta.url);
    url.searchParams.set('session-loss', `${Date.now()}-${Math.random()}`);
    const {ownership} = await import(url);
    assert.equal(await ownership.start(1, 0), 1);
    const state = await ownership.snapshot();
    assert.equal(state[31].source, 'claimed');
    assert.equal(state[32], undefined);
    assert.deepEqual(storage.state[STORAGE_KEY], readyRoot());
    assert.equal(storage.state[recordKey(31)].marker.source, 'claimed');
  }
  finally {
    delete globalThis.chrome;
  }
});

test('a quota rejection is measured but does not withhold the normal native-operation token', async () => {
  const tab = {active: false, discarded: false, id: 41, status: 'complete'};
  const storage = createStorage({});
  installOwnershipChrome(storage, [tab]);
  storage.control.failNextSet = 'QUOTA_BYTES quota exceeded';

  try {
    const url = new URL('../v3/worker/core/ownership.mjs', import.meta.url);
    url.searchParams.set('quota', `${Date.now()}-${Math.random()}`);
    const {ownership} = await import(url);
    const attemptId = await ownership.begin(tab);
    assert.equal(typeof attemptId, 'string', 'best-effort ownership cannot block the native operation');
    let nativeCalls = 0;
    if (attemptId) {
      nativeCalls += 1;
    }
    assert.equal(nativeCalls, 1);
    const diagnostics = await ownership.persistenceDiagnostics();
    assert.equal(diagnostics.quotaFailures, 1);
    assert.equal(diagnostics.storageFailures, 1);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('an overlapping mutation rejects behind a failed durability boundary without replaying its task', async () => {
  const id = 51;
  const storage = createStorage({[STORAGE_KEY]: readyRoot()});
  installOwnershipChrome(storage, []);
  storage.control.failNextSet = 'QUOTA_BYTES deterministic overlap failure';

  try {
    const url = new URL('../v3/worker/core/ownership.mjs', import.meta.url);
    url.searchParams.set('overlap-failure', `${Date.now()}-${Math.random()}`);
    const {ownership} = await import(url);
    const results = await Promise.allSettled([
      ownership.deferTakeover(id),
      ownership.deferTakeover(id)
    ]);

    assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
    for (const result of results) {
      assert.match(result.reason.message, /quota/i);
    }
    assert.equal(storage.control.setCalls, 1, 'the dependent patch must not be persisted after failure');
    assert.equal(storage.state[recordKey(id)], undefined);

    const recovered = await ownership.deferTakeover(id);
    assert.equal(recovered.source, 'contended');
    assert.equal(storage.state[recordKey(id)].marker.source, 'contended');
    const diagnostics = await ownership.persistenceDiagnostics();
    assert.equal(diagnostics.quotaFailures, 1);
    assert.equal(diagnostics.storageFailures, 1);
    assert.equal(diagnostics.mutationBatches, 1, 'only the recovered mutation reached durable success');
    assert.equal(diagnostics.mutationsPersisted, 1);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('same-tab adjacent updates keep a durable authority boundary and resolve in order', async () => {
  const id = 52;
  const storage = createStorage({[STORAGE_KEY]: readyRoot()});
  installOwnershipChrome(storage, []);

  try {
    const url = new URL('../v3/worker/core/ownership.mjs', import.meta.url);
    url.searchParams.set('overlap-order', `${Date.now()}-${Math.random()}`);
    const {ownership} = await import(url);
    const [markerResult, invalidated] = await Promise.all([
      ownership.deferTakeover(id),
      ownership.invalidate(id)
    ]);

    assert.equal(markerResult.source, 'contended');
    assert.equal(invalidated, true);
    assert.equal(storage.control.setCalls, 1, 'the ownership marker is durable before its caller resolves');
    assert.equal(storage.control.removeCalls, 1, 'the later invalidation is a separate ordered boundary');
    assert.equal(storage.state[recordKey(id)], undefined);
    assert.deepEqual(await ownership.snapshot(), {});
    const diagnostics = await ownership.persistenceDiagnostics();
    assert.equal(diagnostics.mutationBatches, 2);
    assert.equal(diagnostics.mutationsPersisted, 2);
    assert.equal(diagnostics.coalescedMutations, 0);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('an asynchronous reconciliation cannot withhold an earlier direct-native marker', async () => {
  const tab = {active: false, discarded: false, id: 53, status: 'complete'};
  const storage = createStorage({[STORAGE_KEY]: readyRoot()});
  let releaseQuery;
  installOwnershipChrome(storage, [tab], {
    query(options, callback) {
      releaseQuery = () => callback([clone(tab)]);
    }
  });

  try {
    const url = new URL('../v3/worker/core/ownership.mjs', import.meta.url);
    url.searchParams.set('async-barrier', `${Date.now()}-${Math.random()}`);
    const {ownership} = await import(url);
    let beginSettled = false;
    const beginning = ownership.beginDirectNative(tab).then(value => {
      beginSettled = true;
      return value;
    });
    const reconciling = ownership.reconcile();

    // Let the bounded queue snapshot both adjacent calls. Reconciliation is
    // deliberately held at tabs.query; the earlier native nonce must already
    // be persisted and released to its caller before that browser read starts.
    await new Promise(resolve => setImmediate(resolve));
    const settledBeforeQuery = beginSettled;
    const durableBeforeQuery = storage.state[recordKey(tab.id)]?.marker;
    assert.equal(typeof releaseQuery, 'function');
    releaseQuery();
    const [attemptId] = await Promise.all([beginning, reconciling]);

    assert.equal(settledBeforeQuery, true);
    assert.equal(durableBeforeQuery?.state, 'direct-native-pending');
    assert.equal(durableBeforeQuery?.attemptId, attemptId);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('2,000-tab churn stays constant-sized, ordered, fast, and below a bounded quota', async t => {
  const count = 2000;
  const quota = 2 * 1024 * 1024;
  const tabs = Array.from({length: count}, (_, index) => ({
    active: false,
    discarded: true,
    id: 10000 + index,
    status: 'unloaded'
  }));
  const storage = createStorage({}, {quota});
  installOwnershipChrome(storage, tabs);

  try {
    const url = new URL('../v3/worker/core/ownership.mjs', import.meta.url);
    url.searchParams.set('churn', `${Date.now()}-${Math.random()}`);
    const {ownership} = await import(url);
    const startedAt = performance.now();
    await Promise.all(tabs.map(tab => ownership.claim(tab)));
    await Promise.all(tabs.map(tab => ownership.invalidate(tab.id)));
    assert.deepEqual(await ownership.snapshot(), {});
    const elapsedMs = performance.now() - startedAt;
    const diagnostics = await ownership.persistenceDiagnostics();
    const result = {
      bytesWritten: diagnostics.bytesWritten,
      coalescedMutations: diagnostics.coalescedMutations,
      elapsedMs: Number(elapsedMs.toFixed(3)),
      maxBatchMutations: diagnostics.maxBatchMutations,
      maxQueueLatencyMs: Number(diagnostics.maxQueueLatencyMs.toFixed(3)),
      maxStoredBytes: storage.control.maxStoredBytes,
      maxWriteBytes: diagnostics.maxWriteBytes,
      mutationBatches: diagnostics.mutationBatches,
      quota,
      removeCalls: diagnostics.removeCalls,
      setCalls: diagnostics.setCalls
    };
    t.diagnostic(`ownership-churn ${JSON.stringify(result)}`);

    assert.equal(diagnostics.recordsWritten, count);
    assert.equal(diagnostics.recordsRemoved, count);
    const expectedBatchesPerPhase = Math.ceil(count / 64);
    assert.equal(diagnostics.setCalls, expectedBatchesPerPhase + 1,
      'one root write plus bounded adjacent claim batches');
    assert.equal(diagnostics.removeCalls, expectedBatchesPerPhase,
      'adjacent removals use bounded per-tab key batches');
    assert.equal(diagnostics.mutationBatches, expectedBatchesPerPhase * 2);
    assert.equal(diagnostics.mutationsPersisted, count * 2);
    assert.equal(diagnostics.coalescedMutations, count * 2 - expectedBatchesPerPhase * 2);
    assert.equal(diagnostics.maxBatchMutations, 64);
    assert.equal(diagnostics.quotaFailures, 0);
    assert.ok(diagnostics.maxWriteBytes < 32 * 1024,
      `max write ${diagnostics.maxWriteBytes} must stay below the 32 KiB batch limit`);
    assert.ok(diagnostics.bytesWritten < 1024 * 1024, `writes used ${diagnostics.bytesWritten} bytes`);
    assert.ok(storage.control.maxStoredBytes < quota / 2,
      `peak storage ${storage.control.maxStoredBytes} must stay below half the ${quota}-byte test quota`);
    assert.ok(diagnostics.maxQueueLatencyMs < 5000,
      `max queue latency ${diagnostics.maxQueueLatencyMs}ms exceeded 5s`);
    assert.ok(elapsedMs < 10000, `2,000-tab churn took ${elapsedMs}ms`);
    assert.deepEqual(Object.keys(storage.state), [STORAGE_KEY]);
  }
  finally {
    delete globalThis.chrome;
  }
});
