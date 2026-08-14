import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS_IMPORT_LOCK_NAME,
  SettingsImportRecoveryError,
  withSettingsImportLock
} from '../v3/worker/core/settings-import-transaction.mjs';

const immediateLockManager = {
  request(name, options, callback) {
    assert.equal(name, SETTINGS_IMPORT_LOCK_NAME);
    assert.equal(options.mode, 'exclusive');
    return Promise.resolve(callback({mode: 'exclusive', name}));
  }
};
const RESET_LOCK = Object.freeze({lockManager: immediateLockManager});

const deferred = () => {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return {promise, resolve};
};

const exclusiveLockManager = () => {
  let active = 0;
  let maxActive = 0;
  let tail = Promise.resolve();
  return {
    get maxActive() {
      return maxActive;
    },
    request(name, options, callback) {
      assert.equal(name, SETTINGS_IMPORT_LOCK_NAME);
      assert.equal(options.mode, 'exclusive');
      const previous = tail;
      const gate = deferred();
      tail = gate.promise;
      return previous.then(async () => {
        if (options.signal.aborted) {
          gate.resolve();
          throw options.signal.reason;
        }
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          return await callback({mode: 'exclusive', name});
        }
        finally {
          active -= 1;
          gate.resolve();
        }
      });
    }
  };
};

test('reset clears old authority then freshly claims only still-discarded live tabs', async () => {
  const sessionState = {};
  const localState = {period: 60};
  const listeners = {};
  let holdNextSessionWrite = false;
  let releaseSessionWrite;
  const liveTabs = [{
    id: 1,
    discarded: true,
    status: 'unloaded',
    url: 'https://discarded.example/'
  }, {
    id: 2,
    discarded: false,
    frozen: true,
    status: 'complete',
    url: 'https://frozen.example/'
  }, {
    id: 3,
    discarded: false,
    status: 'complete',
    url: 'https://loaded.example/'
  }];

  const area = state => ({
    clear(callback) {
      for (const key of Object.keys(state)) {
        delete state[key];
      }
      callback();
    },
    get(defaults, callback) {
      callback({...defaults, ...state});
    },
    remove(key, callback) {
      delete state[key];
      callback();
    },
    set(values, callback) {
      Object.assign(state, values);
      callback();
    }
  });
  const event = name => ({
    addListener(listener) {
      listeners[name] = listener;
    }
  });

  const session = area(sessionState);
  session.set = (values, callback) => {
    const apply = () => {
      Object.assign(sessionState, values);
      callback();
    };
    if (holdNextSessionWrite) {
      holdNextSessionWrite = false;
      releaseSessionWrite = apply;
    }
    else {
      apply();
    }
  };

  globalThis.chrome = {
    runtime: {lastError: null},
    storage: {
      local: area(localState),
      session
    },
    tabs: {
      get(id, callback) {
        callback(liveTabs.find(tab => tab.id === id));
      },
      query(options, callback) {
        callback(liveTabs);
      },
      onAttached: event('attached'),
      onCreated: event('created'),
      onRemoved: event('removed'),
      onReplaced: event('replaced'),
      onUpdated: event('updated')
    }
  };

  try {
    const [{ownership, STORAGE_KEY}, {resetExtensionState}] = await Promise.all([
      import('../v3/worker/core/ownership.mjs'),
      import('../v3/worker/core/reset.mjs')
    ]);

    await ownership.claim(liveTabs[0]);
    const attemptId = await ownership.begin(liveTabs[2]);
    assert.equal(typeof attemptId, 'string');
    assert.ok(sessionState[STORAGE_KEY]);

    // Hold a stale ownership write across the reset fence. Reset must wait for
    // it and then remove its result instead of allowing it to repopulate state.
    // Use a previously unseen tab id so this operation must create a record.
    // Re-claiming tab 1 only refreshes updatedAt; when both claims land in the
    // same millisecond the persistence layer correctly treats that refresh as
    // a no-op, so no session.set callback exists for this test to hold.
    holdNextSessionWrite = true;
    const lateClaim = ownership.claim({
      id: 4,
      discarded: true,
      status: 'unloaded',
      url: 'https://stale.example/'
    });
    while (!releaseSessionWrite) {
      await new Promise(resolve => setTimeout(resolve));
    }
    const resetPending = resetExtensionState(
      ownership,
      chrome.storage.local,
      undefined,
      undefined,
      undefined,
      RESET_LOCK
    );
    releaseSessionWrite();
    await lateClaim;
    const result = await resetPending;

    assert.deepEqual(localState, {});
    const resetSnapshot = await ownership.snapshot();
    assert.equal(resetSnapshot[1].state, 'owned');
    assert.equal(resetSnapshot[1].source, 'claimed');
    assert.deepEqual(Object.keys(resetSnapshot), ['1']);
    assert.deepEqual(result, {
      discarded: 1,
      frozen: 1,
      loaded: 1,
      reconciled: true,
      sleepingClaims: 1,
      tabs: [
        {id: 1, state: 'discarded'},
        {id: 2, state: 'frozen'},
        {id: 3, state: 'loaded'}
      ],
      total: 3,
      visualRepairs: {
        candidates: [],
        failed: [],
        repaired: []
      }
    });
    assert.equal(ownership.isCurrent(3, attemptId), false);
    assert.deepEqual(await ownership.status(3), {
      attemptId: undefined,
      marker: undefined,
      takeover: false
    });

    // A late completion from a cancelled job and lifecycle noise immediately
    // after reset must not recreate old self/pending authority.
    assert.equal(await ownership.finish({...liveTabs[2], discarded: true}, attemptId, 'self'), false);
    listeners.updated(1, {discarded: true}, liveTabs[0]);
    await Promise.resolve();
    assert.equal((await ownership.snapshot())[1].source, 'claimed');

    // The next explicit command reclassifies its live target afresh.
    const resolution = await ownership.resolveFresh(liveTabs[0]);
    assert.equal(resolution.state, 'discarded');
    assert.equal(resolution.marker.source, 'claimed');
    assert.equal((await ownership.status(1)).marker.source, 'claimed');
  }
  finally {
    delete globalThis.chrome;
  }
});

test('visual reset repair is selective, serial, lineage-aware, and truthful', async () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const {repairVisualMarkers, visualResetCandidates} = await import('../v3/worker/core/reset.mjs');
  const snapshot = {
    9: {source: 'claimed', state: 'owned', visual: {repair: true}},
    7: {source: 'self', state: 'owned', visual: {repair: true}},
    3: {source: 'self-pending', state: 'late-native', visual: {repair: true}},
    5: {source: 'self', state: 'owned', visual: {repair: false}}
  };
  assert.deepEqual(visualResetCandidates(snapshot), [3, 7]);

  const result = await repairVisualMarkers({
    resolveId: id => id === 7 ? 70 : id,
    snapshot: async () => snapshot
  }, async (tab, options) => {
    calls.push({id: tab.id, options});
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    active -= 1;
    if (tab.id === 3) {
      throw Error('tab vanished');
    }
    return {id: 70};
  });

  assert.equal(maxActive, 1);
  assert.deepEqual(calls, [
    {id: 3, options: undefined},
    {id: 7, options: undefined}
  ]);
  assert.deepEqual(result, {
    candidates: [3, 7],
    failed: [{id: 3, reason: 'tab vanished'}],
    repaired: [70]
  });
});

test('does not clear ownership when preference reset fails', async () => {
  let ownershipReset = false;
  let takeoversCancelled = false;
  let barrierAborted = false;
  let barrierDrained = false;
  globalThis.chrome = {
    runtime: {lastError: null},
    storage: {
      local: {
        clear(callback) {
          chrome.runtime.lastError = {message: 'local clear failed'};
          callback();
          chrome.runtime.lastError = null;
        }
      }
    }
  };

  try {
    const {resetExtensionState} = await import('../v3/worker/core/reset.mjs');
    await assert.rejects(resetExtensionState({
      reset() {
        ownershipReset = true;
      }
    }, chrome.storage.local, async () => {
      takeoversCancelled = true;
    }, undefined, () => ({
      abort() { barrierAborted = true; },
      complete() {},
      async drain() { barrierDrained = true; }
    }), RESET_LOCK), /local clear failed/);
    assert.equal(ownershipReset, false);
    assert.equal(takeoversCancelled, false);
    assert.equal(barrierDrained, false);
    assert.equal(barrierAborted, true);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('worker reset wiring cancels jobs and repairs visuals before the ownership barrier', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(
    new URL('../v3/worker/core.mjs', import.meta.url),
    'utf8'
  ));
  assert.match(source,
    /resetExtensionState\(\s*ownership,\s*chrome\.storage\.local,\s*discard\.cancelTakeovers,\s*releaseTab,\s*discard\.beginReset\s*\)/);
});

test('reset installs admission before preference clear and holds it through reconciliation', async t => {
  globalThis.chrome = {runtime: {lastError: null}};
  t.after(() => delete globalThis.chrome);
  const order = [];
  let blocked = false;
  const barrier = {
    abort() { order.push('abort'); blocked = false; },
    complete() { order.push('complete'); blocked = false; },
    async drain() {
      assert.equal(blocked, true);
      order.push('drain');
    }
  };
  const ownership = {
    async reset() {
      assert.equal(blocked, true);
      order.push('ownership');
      return {reconciled: true};
    },
    async snapshot() {
      assert.equal(blocked, true);
      order.push('visual-snapshot');
      return {};
    }
  };
  const area = {
    clear(callback) {
      assert.equal(blocked, true);
      order.push('clear');
      callback();
    }
  };
  const {resetExtensionState} = await import('../v3/worker/core/reset.mjs');
  const result = await resetExtensionState(
    ownership,
    area,
    async () => assert.fail('barrier drain replaces the legacy cancellation callback'),
    undefined,
    () => {
      order.push('begin');
      blocked = true;
      return barrier;
    },
    RESET_LOCK
  );
  assert.deepEqual(order, [
    'begin', 'clear', 'drain', 'visual-snapshot', 'ownership', 'complete'
  ]);
  assert.equal(blocked, false);
  assert.equal(result.reconciled, true);
});

test('settings import and reset serialize in both cross-context acquisition orders', async t => {
  globalThis.chrome = {runtime: {lastError: null}};
  t.after(() => delete globalThis.chrome);

  await t.test('an import already holding the lock finishes before reset clears preferences', async () => {
    const locks = exclusiveLockManager();
    const state = {period: 60};
    const order = [];
    const importEntered = deferred();
    const finishImport = deferred();
    const importer = withSettingsImportLock(locks, async () => {
      order.push('import-enter');
      importEntered.resolve();
      await finishImport.promise;
      state.period = 1200;
      order.push('import-write');
    });
    await importEntered.promise;

    const {resetExtensionState} = await import('../v3/worker/core/reset.mjs');
    const reset = resetExtensionState({
      async reset() {
        order.push('ownership');
        return {reconciled: true};
      },
      async snapshot() {
        order.push('visual-snapshot');
        return {};
      }
    }, {
      clear(callback) {
        order.push('clear');
        for (const key of Object.keys(state)) delete state[key];
        callback();
      }
    }, async () => assert.fail('barrier drain owns cancellation'), undefined, () => {
      order.push('begin');
      return {
        abort() { order.push('abort'); },
        complete() { order.push('complete'); },
        async drain() { order.push('drain'); }
      };
    }, {lockManager: locks});

    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['import-enter'],
      'reset must perform no barrier or storage mutation while import owns the lock');
    finishImport.resolve();
    await Promise.all([importer, reset]);

    assert.deepEqual(state, {}, 'the serialized reset clears the import final image');
    assert.deepEqual(order, [
      'import-enter', 'import-write', 'begin', 'clear', 'drain',
      'visual-snapshot', 'ownership', 'complete'
    ]);
    assert.equal(locks.maxActive, 1);
  });

  await t.test('an import waits through reset ownership reconciliation and barrier completion', async () => {
    const locks = exclusiveLockManager();
    const state = {period: 60};
    const order = [];
    const ownershipEntered = deferred();
    const finishOwnership = deferred();
    const {resetExtensionState} = await import('../v3/worker/core/reset.mjs');
    const reset = resetExtensionState({
      async reset() {
        order.push('ownership-enter');
        ownershipEntered.resolve();
        await finishOwnership.promise;
        order.push('ownership-exit');
        return {reconciled: true};
      },
      async snapshot() {
        order.push('visual-snapshot');
        return {};
      }
    }, {
      clear(callback) {
        order.push('clear');
        for (const key of Object.keys(state)) delete state[key];
        callback();
      }
    }, async () => assert.fail('barrier drain owns cancellation'), undefined, () => {
      order.push('begin');
      return {
        abort() { order.push('abort'); },
        complete() { order.push('complete'); },
        async drain() { order.push('drain'); }
      };
    }, {lockManager: locks});
    await ownershipEntered.promise;

    let importActive = false;
    const importer = withSettingsImportLock(locks, async () => {
      importActive = true;
      order.push('import-enter');
      state.period = 2400;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(importActive, false,
      'the contender cannot enter while ownership reconciliation is unfinished');
    assert.equal(order.includes('complete'), false,
      'the reset barrier remains active for the complete lock lifetime');

    finishOwnership.resolve();
    await Promise.all([reset, importer]);
    assert.equal(order.indexOf('complete') < order.indexOf('import-enter'), true);
    assert.deepEqual(state, {period: 2400},
      'an import acquired after reset is a valid later serial operation');
    assert.equal(locks.maxActive, 1);
  });
});

test('lock unavailability and timeout abort reset before every mutation', async t => {
  globalThis.chrome = {runtime: {lastError: null}};
  t.after(() => delete globalThis.chrome);
  const {resetExtensionState} = await import('../v3/worker/core/reset.mjs');

  const fixture = () => {
    const calls = [];
    return {
      calls,
      invoke: lockOptions => resetExtensionState({
        async reset() { calls.push('ownership'); },
        async snapshot() { calls.push('visual-snapshot'); return {}; }
      }, {
        clear(callback) { calls.push('clear'); callback(); }
      }, async () => calls.push('cancel'), async () => calls.push('release'), () => {
        calls.push('begin');
        return {
          abort() { calls.push('abort'); },
          complete() { calls.push('complete'); },
          async drain() { calls.push('drain'); }
        };
      }, lockOptions)
    };
  };

  await t.test('unavailable lock', async () => {
    const f = fixture();
    await assert.rejects(
      f.invoke({lockManager: {}}),
      error => error instanceof SettingsImportRecoveryError && error.code === 'lock-unavailable'
    );
    assert.deepEqual(f.calls, []);
  });

  await t.test('timed-out and late lock callback', async () => {
    const f = fixture();
    let lateCallback;
    const locks = {
      request(name, options, callback) {
        assert.equal(name, SETTINGS_IMPORT_LOCK_NAME);
        lateCallback = callback;
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true});
        });
      }
    };
    await assert.rejects(
      f.invoke({lockManager: locks, lockTimeoutMs: 5}),
      error => error instanceof SettingsImportRecoveryError &&
        error.code === 'lock-timeout' && error.retryable === true
    );
    assert.deepEqual(f.calls, []);
    await assert.rejects(
      lateCallback({mode: 'exclusive', name: SETTINGS_IMPORT_LOCK_NAME}),
      error => error instanceof SettingsImportRecoveryError && error.code === 'lock-timeout'
    );
    assert.deepEqual(f.calls, [], 'an aborted lock callback can never start reset later');
  });
});

test('issue 24: reset clears self, claimed, pending, and replacement authority before reload', async () => {
  const localState = {period: 600, prepends: 'REST'};
  const sessionState = {};
  const liveTabs = new Map();
  const listeners = {};
  const area = state => ({
    clear(callback) {
      Object.keys(state).forEach(key => delete state[key]);
      callback();
    },
    get(defaults, callback) {
      callback({...defaults, ...state});
    },
    remove(keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete state[key];
      }
      callback();
    },
    set(values, callback) {
      Object.assign(state, structuredClone(values));
      callback();
    }
  });
  const event = name => ({
    addListener(listener) {
      (listeners[name] ||= []).push(listener);
    }
  });
  const loaded = (id, url) => ({
    active: false,
    discarded: false,
    frozen: false,
    id,
    status: 'complete',
    url,
    windowId: 1
  });
  const self = loaded(1, 'https://self-reset.example/');
  const claimed = {...loaded(2, 'https://claimed-reset.example/'), discarded: true, status: 'unloaded'};
  const pending = loaded(3, 'https://pending-reset.example/');
  const predecessor = loaded(4, 'https://replacement-reset.example/');
  [self, claimed, pending, predecessor].forEach(tab => liveTabs.set(tab.id, tab));

  globalThis.chrome = {
    runtime: {lastError: null},
    storage: {
      local: area(localState),
      session: area(sessionState)
    },
    tabs: {
      get(id, callback) {
        callback(liveTabs.get(id));
      },
      query(options, callback) {
        callback([...liveTabs.values()]);
      },
      onActivated: event('activated'),
      onAttached: event('attached'),
      onCreated: event('created'),
      onRemoved: event('removed'),
      onReplaced: event('replaced'),
      onUpdated: event('updated')
    }
  };

  try {
    const nonce = `${Date.now()}-${Math.random()}`;
    const [{ownership, STORAGE_KEY}, {resetExtensionState}] = await Promise.all([
      import(`../v3/worker/core/ownership.mjs?reset-matrix=${nonce}`),
      import('../v3/worker/core/reset.mjs')
    ]);
    const visual = {
      complete: true,
      favicon: true,
      repair: true,
      title: true,
      titleMarker: 'REST'
    };

    const selfAttempt = await ownership.begin(self);
    const selfDiscarded = {...self, discarded: true, status: 'unloaded'};
    liveTabs.set(self.id, selfDiscarded);
    assert.equal(await ownership.finish(selfDiscarded, selfAttempt, 'self', {visual}), true);
    assert.equal((await ownership.claim(claimed)).source, 'claimed');
    const pendingAttempt = await ownership.beginTakeover(pending);
    assert.equal(typeof pendingAttempt, 'string');

    const replacementAttempt = await ownership.begin(predecessor);
    const predecessorDiscarded = {...predecessor, discarded: true, status: 'unloaded'};
    liveTabs.set(predecessor.id, predecessorDiscarded);
    assert.equal(await ownership.finish(
      predecessorDiscarded,
      replacementAttempt,
      'self',
      {visual}
    ), true);
    const successor = {...predecessorDiscarded, id: 40};
    liveTabs.delete(predecessor.id);
    liveTabs.set(successor.id, successor);
    for (const listener of listeners.replaced || []) {
      listener(successor.id, predecessor.id);
    }
    const before = await ownership.snapshot();
    assert.equal(before[self.id].source, 'self');
    assert.equal(before[claimed.id].source, 'claimed');
    assert.equal(before[pending.id].state, 'takeover-waking');
    assert.equal(before[predecessor.id], undefined);
    assert.equal(before[successor.id].source, 'self');
    assert.equal(ownership.resolveId(predecessor.id), successor.id);

    const order = [];
    const released = [];
    const result = await resetExtensionState(
      ownership,
      chrome.storage.local,
      async () => {
        order.push('cancel');
        assert.deepEqual(localState, {}, 'preferences clear before cancellation');
        assert.equal((await ownership.status(pending.id)).takeover, true,
          'active jobs must still be observable at the cancellation boundary');
        return 1;
      },
      async ({id}) => {
        order.push(`release:${id}`);
        released.push(id);
        const currentId = ownership.resolveId(id);
        const current = liveTabs.get(currentId);
        const awake = {...current, discarded: false, frozen: false, status: 'complete'};
        liveTabs.set(currentId, awake);
        return awake;
      },
      undefined,
      RESET_LOCK
    );

    assert.deepEqual(order, ['cancel', 'release:1', 'release:40']);
    assert.deepEqual(released, [1, 40], 'only repairable self markers are released serially');
    assert.deepEqual(localState, {});
    assert.equal(result.reconciled, true);
    assert.equal(result.sleepingClaims, 1);
    assert.deepEqual(result.visualRepairs, {
      candidates: [1, 40],
      failed: [],
      repaired: [1, 40]
    });
    const afterReset = await ownership.snapshot();
    assert.deepEqual(Object.keys(afterReset), [String(claimed.id)]);
    assert.equal(afterReset[claimed.id].attemptId, null);
    assert.equal(afterReset[claimed.id].source, 'claimed');
    assert.equal(afterReset[claimed.id].state, 'owned');
    assert.deepEqual(await ownership.diagnostics(), {
      attempts: 0,
      generations: 0,
      observedDiscards: 0,
      replacements: 0,
      takeoverAttempts: 0
    });
    assert.equal(ownership.resolveId(predecessor.id), predecessor.id,
      'reset must erase predecessor-to-successor authority');
    for (const id of [self.id, pending.id, predecessor.id, successor.id]) {
      assert.equal(sessionState[`${STORAGE_KEY}:tab:${id}`], undefined,
        `old session marker ${id} survived reset`);
    }
    assert.ok(sessionState[`${STORAGE_KEY}:tab:${claimed.id}`],
      'the still-discarded live tab must receive one fresh claimed record');

    // Re-importing the worker proves that the persisted reset boundary, rather
    // than this module's cache, is authoritative after service-worker reload.
    const {ownership: reloaded} = await import(
      `../v3/worker/core/ownership.mjs?reset-matrix-reload=${nonce}`
    );
    assert.equal(await reloaded.start(1, 0), 1);
    const afterReload = await reloaded.snapshot();
    assert.deepEqual(Object.keys(afterReload), [String(claimed.id)]);
    assert.equal(afterReload[claimed.id].source, 'claimed');
    assert.equal(afterReload[claimed.id].state, 'owned');
    assert.equal((await reloaded.status(pending.id)).takeover, false);
    assert.equal((await reloaded.status(successor.id)).marker, undefined);
  }
  finally {
    delete globalThis.chrome;
  }
});
