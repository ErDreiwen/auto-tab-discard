import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  focusReleaseScope,
  nextReleaseScope,
  previousReleaseScope,
  startupPinnedReleaseScope
} from '../v3/worker/plugins/release-scopes.mjs';

const event = () => ({
  addListener() {},
  removeListener() {}
});

const loadFactory = async () => {
  const storageArea = {
    get(defaults, callback) {
      callback(defaults);
    },
    remove(key, callback) {
      callback();
    },
    set(values, callback) {
      callback();
    }
  };
  globalThis.chrome = {
    runtime: {lastError: null},
    storage: {
      local: storageArea,
      managed: storageArea,
      session: storageArea,
      onChanged: event()
    },
    tabs: {
      get(id, callback) {
        callback(undefined);
      },
      onActivated: event(),
      onAttached: event(),
      onCreated: event(),
      onRemoved: event(),
      onReplaced: event(),
      onUpdated: event()
    },
    windows: {
      onFocusChanged: event()
    }
  };
  const url = new URL('../v3/worker/core/release.mjs', import.meta.url);
  url.searchParams.set('test', `${Date.now()}-${Math.random()}`);
  return (await import(url)).createReleaseHelper;
};

const fixture = (createReleaseHelper, apiStyle = 'callback') => {
  const calls = [];
  const invalidated = [];
  const liveTabs = new Map();
  const lineage = new Map();
  const resolveId = id => lineage.get(id) || id;
  const get = (id, callback) => {
    calls.push(`get:${id}`);
    const value = liveTabs.get(id);
    if (apiStyle === 'promise') {
      return Promise.resolve(value);
    }
    callback(value);
  };
  const reload = (id, options, callback) => {
    calls.push(`reload:${id}`);
    const loading = {...liveTabs.get(id), discarded: false, frozen: false, status: 'loading'};
    liveTabs.set(id, loading);
    const finish = () => liveTabs.set(id, {...loading, status: 'complete'});
    if (apiStyle === 'promise') {
      return Promise.resolve().then(finish);
    }
    callback();
    queueMicrotask(finish);
  };
  const {releaseTab, releaseTabs} = createReleaseHelper({
    cancelTakeover: async id => calls.push(`cancel:${id}`),
    getStatus: async () => ({marker: {source: 'claimed'}}),
    invalidate: async id => {
      calls.push(`invalidate:${id}`);
      invalidated.push(id);
    },
    resolveId,
    runtime: () => ({lastError: null}),
    tabs: () => ({get, reload}),
    withNativeMutationGuard: task => task(),
    unfreeze: async tab => {
      calls.push(`unfreeze:${tab.id}`);
      const loaded = {...tab, frozen: false, status: 'complete'};
      liveTabs.set(tab.id, loaded);
      return loaded;
    }
  });
  releaseTab.interval = 0;
  releaseTab.polls = 10;
  releaseTab.stableReads = 2;
  return {calls, invalidated, lineage, liveTabs, releaseTab, releaseTabs};
};

for (const apiStyle of ['callback', 'promise']) {
  test(`shared release follows ownership lineage and reloads exactly once with ${apiStyle} tab APIs`, async () => {
    const createReleaseHelper = await loadFactory();
    try {
      const f = fixture(createReleaseHelper, apiStyle);
      const original = {
        id: 1,
        discarded: true,
        status: 'unloaded',
        url: 'https://release.example/'
      };
      const successor = {...original, id: 2};
      f.lineage.set(original.id, successor.id);
      f.liveTabs.set(successor.id, successor);

      const loaded = await f.releaseTab(original);

      assert.equal(loaded.id, successor.id);
      assert.equal(loaded.discarded, false);
      assert.equal(loaded.status, 'complete');
      assert.equal(f.calls.filter(call => call === 'reload:2').length, 1);
      assert.equal(f.calls[0], 'cancel:2');
      assert.equal(f.calls.at(-1), 'invalidate:2');
      assert.deepEqual(f.invalidated, [2]);
    }
    finally {
      delete globalThis.chrome;
    }
  });
}

test('shared release cancels takeover before one wake and does not erase a concurrent rediscard', async () => {
  const createReleaseHelper = await loadFactory();
  try {
    const f = fixture(createReleaseHelper);
    const tab = {id: 7, discarded: true, status: 'unloaded'};
    f.liveTabs.set(tab.id, tab);
    let reloads = 0;
    const {releaseTab} = createReleaseHelper({
      cancelTakeover: async id => f.calls.push(`cancel:${id}`),
      getStatus: async () => ({marker: {source: 'claimed'}}),
      invalidate: async id => f.invalidated.push(id),
      resolveId: id => id,
      runtime: () => ({lastError: null}),
      withNativeMutationGuard: task => task(),
      tabs: () => ({
        get(id, callback) {
          callback(f.liveTabs.get(id));
        },
        reload(id, options, callback) {
          reloads += 1;
          f.calls.push(`reload:${id}`);
          callback();
          // Another discarder wins before a stable loaded observation.
          f.liveTabs.set(id, {...tab});
        }
      })
    });
    releaseTab.interval = 0;
    releaseTab.polls = 2;
    releaseTab.stableReads = 2;

    await assert.rejects(releaseTab(tab), /did not settle loaded/);

    assert.deepEqual(f.calls, ['cancel:7', 'reload:7']);
    assert.equal(reloads, 1);
    assert.deepEqual(f.invalidated, []);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('accepted Edge reload callback error is settled from live replacement state without retry', async () => {
  const createReleaseHelper = await loadFactory();
  try {
    const original = {id: 8, active: false, discarded: true, frozen: false, status: 'unloaded'};
    const successor = {...original, id: 18, discarded: false, status: 'loading'};
    const live = new Map([[original.id, original]]);
    const lineage = new Map();
    const calls = [];
    const runtime = {lastError: null};
    const resolveId = id => lineage.get(id) || id;
    const {releaseTab} = createReleaseHelper({
      cancelTakeover: async () => false,
      getStatus: async () => ({marker: {source: 'claimed'}}),
      invalidate: async id => calls.push(`invalidate:${id}`),
      resolveId,
      runtime: () => runtime,
      withNativeMutationGuard: task => task(),
      tabs: () => ({
        get(id, callback) {
          callback(live.get(id));
        },
        reload(id, options, callback) {
          calls.push(`reload:${id}`);
          lineage.set(id, successor.id);
          live.delete(id);
          live.set(successor.id, successor);
          runtime.lastError = {message: `No tab with id: ${id}`};
          callback();
          runtime.lastError = null;
          queueMicrotask(() => live.set(successor.id, {...successor, status: 'complete'}));
        }
      })
    });
    releaseTab.interval = 0;
    releaseTab.polls = 10;
    releaseTab.stableReads = 2;

    const loaded = await releaseTab(original);

    assert.equal(loaded.id, successor.id);
    assert.equal(loaded.status, 'complete');
    assert.deepEqual(calls.filter(call => call.startsWith('reload:')), ['reload:8']);
    assert.deepEqual(calls.filter(call => call.startsWith('invalidate:')), ['invalidate:18']);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('stable release does not invalidate a newer ownership attempt', async () => {
  const createReleaseHelper = await loadFactory();
  try {
    const live = new Map([[11, {id: 11, discarded: true, status: 'unloaded'}]]);
    const invalidated = [];
    let statusReads = 0;
    const {releaseTab} = createReleaseHelper({
      cancelTakeover: async () => false,
      getStatus: async () => ++statusReads === 1 ? {
        marker: {state: 'owned', source: 'claimed', attemptId: null, updatedAt: 1}
      } : {
        attemptId: 'newer-attempt',
        marker: {state: 'pending', attemptId: 'newer-attempt', updatedAt: 2}
      },
      invalidate: async id => invalidated.push(id),
      resolveId: id => id,
      runtime: () => ({lastError: null}),
      withNativeMutationGuard: task => task(),
      tabs: () => ({
        get(id, callback) {
          callback(live.get(id));
        },
        reload(id, options, callback) {
          live.set(id, {...live.get(id), discarded: false, status: 'complete'});
          callback();
        }
      })
    });
    releaseTab.interval = 0;
    releaseTab.stableReads = 2;

    assert.equal((await releaseTab(live.get(11))).status, 'complete');
    assert.deepEqual(invalidated, []);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('shared release reloads a freshly frozen target exactly once without activation unfreeze', async () => {
  const createReleaseHelper = await loadFactory();
  try {
    const f = fixture(createReleaseHelper);
    const frozen = {id: 9, discarded: false, frozen: true, status: 'complete'};
    f.liveTabs.set(frozen.id, frozen);

    const loaded = await f.releaseTab(frozen);

    assert.equal(loaded.frozen, false);
    assert.equal(f.calls.filter(call => call === 'reload:9').length, 1);
    assert.equal(f.calls.some(call => call === 'unfreeze:9'), false);
    assert.equal(f.calls.at(-1), 'invalidate:9');
  }
  finally {
    delete globalThis.chrome;
  }
});

test('accepted callback release reports a stable retained-frozen successor after two lineage reads', async () => {
  const createReleaseHelper = await loadFactory();
  try {
    const original = {
      active: false,
      autoDiscardable: true,
      discarded: false,
      frozen: true,
      id: 109,
      status: 'complete'
    };
    const middle = {...original, id: 119};
    const successor = {...original, id: 129};
    const live = new Map([[original.id, original]]);
    const lineage = new Map();
    const calls = [];
    const invalidated = [];
    const token = 'captured-retained-frozen';
    let postReloadReads = 0;
    const resolveId = id => lineage.get(id) || id;
    const {releaseTab} = createReleaseHelper({
      cancelTakeover: async id => calls.push(`cancel:${id}`),
      getStatus: async () => ({marker: {
        attemptId: token,
        source: 'physical-only',
        state: 'owned',
        updatedAt: 1
      }}),
      invalidate: async id => {
        calls.push(`invalidate:${id}`);
        invalidated.push(id);
      },
      resolveId,
      runtime: () => ({lastError: null}),
      withNativeMutationGuard: task => task(),
      tabs: () => ({
        get(id, callback) {
          calls.push(`get:${id}`);
          const current = live.get(id);
          callback(current);
          if (id !== original.id) {
            postReloadReads += 1;
            if (postReloadReads === 1) {
              lineage.set(original.id, successor.id);
              live.delete(middle.id);
              live.set(successor.id, successor);
            }
          }
        },
        reload(id, options, callback) {
          calls.push(`reload:${id}`);
          assert.deepEqual(options, {bypassCache: false});
          lineage.set(original.id, middle.id);
          live.delete(original.id);
          live.set(middle.id, middle);
          callback();
        },
        update() {
          assert.fail('release must never activate or mutate autoDiscardable');
        }
      })
    });
    // The production helper clamps this to the two-read safety floor.
    releaseTab.interval = 0;
    releaseTab.polls = 10;
    releaseTab.stableReads = 1;

    await assert.rejects(releaseTab(original), error => {
      assert.equal(error.code, 'TAB_RELEASE_REMAINS_FROZEN');
      assert.equal(error.disposition, 'retained-frozen');
      assert.equal(error.retryable, true);
      assert.deepEqual(error.tab, successor);
      return true;
    });

    assert.equal(postReloadReads, 3,
      'the middle identity cannot satisfy the two stable reads for its successor');
    assert.equal(calls.filter(call => call === `reload:${original.id}`).length, 1);
    assert.deepEqual(invalidated, [successor.id],
      'the captured ownership token is cleared only after retained-frozen stability');
    assert.equal(successor.active, false);
    assert.equal(successor.autoDiscardable, true);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('promise release preserves a newer owner when its successor remains frozen', async () => {
  const createReleaseHelper = await loadFactory();
  try {
    const original = {
      active: false,
      autoDiscardable: true,
      discarded: false,
      frozen: true,
      id: 209,
      status: 'complete'
    };
    const successor = {...original, id: 219};
    const live = new Map([[original.id, original]]);
    const lineage = new Map();
    const calls = [];
    let statusReads = 0;
    const resolveId = id => lineage.get(id) || id;
    const oldStatus = {marker: {
      attemptId: 'old-owner',
      source: 'physical-only',
      state: 'owned',
      updatedAt: 1
    }};
    const newerStatus = {
      attemptId: 'new-owner',
      marker: {attemptId: 'new-owner', state: 'pending', updatedAt: 2}
    };
    const {releaseTab} = createReleaseHelper({
      cancelTakeover: async id => calls.push(`cancel:${id}`),
      getStatus: async () => ++statusReads <= 2 ? oldStatus : newerStatus,
      invalidate: async id => calls.push(`invalidate:${id}`),
      resolveId,
      runtime: () => ({lastError: null}),
      withNativeMutationGuard: task => task(),
      tabs: () => ({
        get(id) {
          calls.push(`get:${id}`);
          return Promise.resolve(live.get(id));
        },
        reload(id, options) {
          calls.push(`reload:${id}`);
          assert.deepEqual(options, {bypassCache: false});
          lineage.set(original.id, successor.id);
          live.delete(original.id);
          live.set(successor.id, successor);
          return Promise.resolve();
        },
        update() {
          assert.fail('release must never activate or mutate autoDiscardable');
        }
      })
    });
    releaseTab.interval = 0;
    releaseTab.polls = 5;
    releaseTab.stableReads = 2;

    await assert.rejects(releaseTab(original), error => {
      assert.equal(error.code, 'TAB_RELEASE_REMAINS_FROZEN');
      assert.equal(error.tab.id, successor.id);
      return true;
    });

    assert.equal(calls.filter(call => call === `reload:${original.id}`).length, 1);
    assert.equal(calls.some(call => call.startsWith('invalidate:')), false,
      'retained-frozen settlement must not erase a newer ownership token');
    assert.equal(successor.active, false);
    assert.equal(successor.autoDiscardable, true);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('callback error with an unchanged frozen row fails without retry or ownership cleanup', async () => {
  const createReleaseHelper = await loadFactory();
  try {
    const frozen = {
      active: false,
      autoDiscardable: true,
      discarded: false,
      frozen: true,
      id: 309,
      status: 'complete'
    };
    const runtime = {lastError: null};
    const calls = [];
    const {releaseTab} = createReleaseHelper({
      cancelTakeover: async () => false,
      getStatus: async () => ({marker: {
        attemptId: 'unchanged-owner',
        source: 'physical-only',
        state: 'owned',
        updatedAt: 1
      }}),
      invalidate: async id => calls.push(`invalidate:${id}`),
      resolveId: id => id,
      runtime: () => runtime,
      withNativeMutationGuard: task => task(),
      tabs: () => ({
        get(id, callback) {
          callback(frozen);
        },
        reload(id, options, callback) {
          calls.push(`reload:${id}`);
          runtime.lastError = {message: 'Edge rejected unchanged frozen reload'};
          callback();
          runtime.lastError = null;
        }
      })
    });
    releaseTab.interval = 0;
    releaseTab.polls = 3;
    releaseTab.stableReads = 2;

    await assert.rejects(releaseTab(frozen), error => {
      assert.equal(error.code, 'TAB_RELEASE_NOT_ACCEPTED');
      assert.match(error.message, /made no observable progress/);
      return true;
    });
    assert.deepEqual(calls, [`reload:${frozen.id}`]);
    assert.equal(frozen.active, false);
    assert.equal(frozen.autoDiscardable, true);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('one reload settles complete with false or absent frozen capability', async () => {
  const createReleaseHelper = await loadFactory();
  try {
    for (const capability of ['false', 'absent']) {
      const calls = [];
      const original = {
        active: false,
        autoDiscardable: true,
        discarded: true,
        frozen: false,
        id: capability === 'false' ? 409 : 419,
        status: 'unloaded'
      };
      if (capability === 'absent') delete original.frozen;
      let live = {...original};
      let marker = {attemptId: `${capability}-owner`, source: 'claimed', state: 'owned', updatedAt: 1};
      const {releaseTab} = createReleaseHelper({
        cancelTakeover: async () => false,
        getStatus: async () => marker ? {marker} : {},
        invalidate: async id => {
          calls.push(`invalidate:${id}`);
          marker = undefined;
        },
        resolveId: id => id,
        runtime: () => ({lastError: null}),
        withNativeMutationGuard: task => task(),
        tabs: () => ({
          get(id, callback) {
            callback({...live});
          },
          reload(id, options, callback) {
            calls.push(`reload:${id}`);
            live = {...live, discarded: false, status: 'complete'};
            callback();
          },
          update() {
            assert.fail('release must never activate or mutate autoDiscardable');
          }
        })
      });
      releaseTab.interval = 0;
      releaseTab.polls = 5;
      releaseTab.stableReads = 2;

      const loaded = await releaseTab(original);
      assert.equal(loaded.discarded, false, capability);
      assert.equal(loaded.status, 'complete', capability);
      assert.equal(loaded.active, false, capability);
      assert.equal(loaded.autoDiscardable, true, capability);
      assert.equal(Object.hasOwn(loaded, 'frozen'), capability === 'false', capability);
      assert.deepEqual(calls, [`reload:${original.id}`, `invalidate:${original.id}`], capability);
    }
  }
  finally {
    delete globalThis.chrome;
  }
});

test('restart release fails closed for unresolved direct native intent then reloads settled state once', async () => {
  const createReleaseHelper = await loadFactory();
  try {
    for (const unresolved of [
      {id: 91, active: false, discarded: false, frozen: true, status: 'complete'},
      {id: 92, active: false, discarded: false, frozen: false, status: 'complete'}
    ]) {
      const calls = [];
      let live = {...unresolved};
      let marker = {state: 'direct-native-pending', attemptId: `direct-${unresolved.id}`};
      const {releaseTab} = createReleaseHelper({
        cancelTakeover: async () => false,
        getStatus: async () => ({marker}),
        invalidate: async () => { marker = undefined; calls.push('invalidate'); },
        resolveId: id => id,
        runtime: () => ({lastError: null}),
        withNativeMutationGuard: task => task(),
        tabs: () => ({
          get(id, callback) { callback({...live}); },
          reload(id, options, callback) {
            calls.push('reload');
            live = {...live, discarded: false, frozen: false, status: 'complete'};
            callback();
          }
        })
      });
      releaseTab.interval = 0;
      releaseTab.polls = 5;
      releaseTab.stableReads = 2;
      await assert.rejects(releaseTab(unresolved), /direct native discard is still pending/);
      assert.deepEqual(calls, []);
      assert.equal(marker.state, 'direct-native-pending');

      live = {...live, discarded: true, frozen: false, status: 'unloaded'};
      const loaded = await releaseTab(live);
      assert.equal(loaded.status, 'complete');
      assert.deepEqual(calls, ['reload', 'invalidate']);
    }
  }
  finally {
    delete globalThis.chrome;
  }
});

test('unattributed direct native orphan blocks release before any tab read or mutation', async () => {
  const createReleaseHelper = await loadFactory();
  try {
    const calls = [];
    let statusReads = 0;
    const reservation = {released: false};
    const {releaseTab} = createReleaseHelper({
      cancelTakeover: async id => calls.push(`cancel:${id}`),
      getStatus: async () => {
        statusReads += 1;
        return statusReads === 1 ? {} : {nativeOrphan: true};
      },
      invalidate: async id => calls.push(`invalidate:${id}`),
      reserveRelease: id => {
        calls.push(`reserve:${id}`);
        return {
          release() {
            reservation.released = true;
            calls.push(`release-reservation:${id}`);
          }
        };
      },
      resolveId: id => id,
      runtime: () => ({lastError: null}),
      withNativeMutationGuard: task => task(),
      tabs: () => ({
        get(id, callback) {
          calls.push(`get:${id}`);
          callback({id, active: false, discarded: true, status: 'unloaded'});
        },
        reload(id, options, callback) {
          calls.push(`reload:${id}`);
          callback();
        }
      })
    });

    await assert.rejects(
      releaseTab({id: 93, active: false, discarded: true, status: 'unloaded'}),
      error => {
        assert.equal(error.code, 'TAB_RELEASE_NATIVE_PENDING');
        assert.equal(error.disposition, 'native-pending');
        assert.equal(error.retryable, false);
        return true;
      }
    );
    assert.equal(statusReads, 2);
    assert.deepEqual(calls, [
      'reserve:93',
      'cancel:93',
      'release-reservation:93'
    ]);
    assert.equal(reservation.released, true);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('plugin release unions an awake in-flight takeover omitted by discarded queries', async () => {
  const createReleaseHelper = await loadFactory();
  try {
    const live = {id: 21, windowId: 8, index: 4, active: false, discarded: false, status: 'complete'};
    const calls = [];
    const {releaseMatching, releaseTab} = createReleaseHelper({
      cancelTakeover: async id => calls.push(`cancel:${id}`),
      getStatus: async () => ({marker: {
        attemptId: 'wake-21',
        source: 'requested',
        state: 'takeover-waking',
        updatedAt: 1
      }}),
      invalidate: async id => calls.push(`invalidate:${id}`),
      resolveId: id => id,
      runtime: () => ({lastError: null}),
      withNativeMutationGuard: task => task(),
      tabs: () => ({
        get(id, callback) {
          calls.push(`get:${id}`);
          callback({...live});
        },
        reload() {
          assert.fail('an already-awake takeover must not be reloaded');
        }
      }),
      takeoverSnapshot: () => [{id: live.id, started: true, tab: {
        id: live.id,
        index: live.index,
        windowId: live.windowId
      }}]
    });
    releaseTab.interval = 0;
    releaseTab.stableReads = 2;

    const released = await releaseMatching([], tab => tab.windowId === 8 && tab.index === 4);
    assert.deepEqual(released.map(tab => tab.id), [21]);
    assert.equal(calls.filter(call => call === 'cancel:21').length, 1);
    assert.equal(calls.filter(call => call === 'invalidate:21').length, 1);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('release plugin scopes preserve geometry while admitting awake takeover phases', () => {
  const focus = focusReleaseScope(8);
  assert.equal(focus.matches({active: true, discarded: false, windowId: 8}), true);
  assert.equal(focus.matches({active: false, discarded: true, windowId: 9}), false);
  assert.equal(focusReleaseScope(undefined), undefined);

  const next = nextReleaseScope({windowId: 8}, {index: 3, windowId: 8});
  assert.equal(next.matches({active: true, discarded: false, index: 4, windowId: 8}), true);
  assert.equal(next.matches({active: false, discarded: true, index: 5, windowId: 8}), false);
  assert.equal(nextReleaseScope({windowId: 8}, undefined), undefined);

  const previous = previousReleaseScope({windowId: 8}, {index: 1, windowId: 8});
  assert.equal(previous.matches({active: true, discarded: false, index: 0, windowId: 8}), true);
  assert.equal(previousReleaseScope({windowId: 8}, {index: 0, windowId: 8}), undefined);

  const startup = startupPinnedReleaseScope();
  assert.equal(startup.matches({active: true, discarded: false, pinned: true, url: 'https://awake.example/'}), true);
  assert.equal(startup.matches({active: false, discarded: true, pinned: false, url: 'https://peer.example/'}), false);
  assert.equal(startup.matches({active: false, discarded: true, pinned: true, url: 'file:///peer.html'}), false);
});

test('every release plugin wins deterministically over every in-flight takeover phase', async t => {
  const createReleaseHelper = await loadFactory();
  const scopeCases = [{
    expectedQuery: {active: false, windowId: 8},
    name: 'focus',
    peer: {index: 4, pinned: true, url: 'https://peer.example/', windowId: 9},
    scope: focusReleaseScope(8),
    target: {index: 4, pinned: true, url: 'https://target.example/', windowId: 8}
  }, {
    expectedQuery: {index: 4, windowId: 8},
    name: 'next',
    peer: {index: 5, pinned: true, url: 'https://peer.example/', windowId: 8},
    scope: nextReleaseScope({windowId: 8}, {index: 3, windowId: 8}),
    target: {index: 4, pinned: true, url: 'https://target.example/', windowId: 8}
  }, {
    expectedQuery: {index: 4, windowId: 8},
    name: 'previous',
    peer: {index: 3, pinned: true, url: 'https://peer.example/', windowId: 8},
    scope: previousReleaseScope({windowId: 8}, {index: 5, windowId: 8}),
    target: {index: 4, pinned: true, url: 'https://target.example/', windowId: 8}
  }, {
    expectedQuery: {url: '*://*/*', active: false, pinned: true},
    name: 'startup-pinned',
    peer: {index: 4, pinned: false, url: 'https://peer.example/', windowId: 8},
    scope: startupPinnedReleaseScope(),
    target: {index: 4, pinned: true, url: 'https://target.example/', windowId: 8}
  }];
  const phases = [{
    active: false,
    discarded: true,
    expectedReleaseWakes: 1,
    markerState: 'takeover-queued',
    name: 'queued',
    started: false,
    status: 'unloaded'
  }, {
    active: true,
    discarded: false,
    expectedReleaseWakes: 0,
    markerState: 'takeover-waking',
    name: 'waking-active-pulse',
    started: true,
    status: 'loading'
  }, {
    active: false,
    discarded: false,
    expectedReleaseWakes: 0,
    markerState: 'takeover-awake',
    name: 'awake-loaded',
    started: true,
    status: 'complete'
  }, {
    active: false,
    discarded: false,
    expectedReleaseWakes: 1,
    markerState: 'pending-native',
    name: 'native-pending-replacement',
    nativePending: true,
    started: true,
    status: 'complete'
  }];

  try {
    for (const scopeCase of scopeCases) {
      assert.deepEqual(scopeCase.scope.query, scopeCase.expectedQuery,
        `${scopeCase.name}: browser query must preserve the plugin scope`);
      assert.equal(scopeCase.scope.matches(scopeCase.target), true,
        `${scopeCase.name}: matching takeover snapshot must enter the release scope`);
      assert.equal(scopeCase.scope.matches(scopeCase.peer), false,
        `${scopeCase.name}: peer takeover snapshot must stay out of scope`);

      for (const phase of phases) {
        await t.test(`${scopeCase.name}: ${phase.name}`, async () => {
          const targetId = 100;
          const peerId = 200;
          const successorId = 101;
          const token = `${scopeCase.name}-${phase.name}`;
          const calls = [];
          const live = new Map([[
            targetId,
            {
              ...scopeCase.target,
              active: phase.active,
              discarded: phase.discarded,
              frozen: false,
              id: targetId,
              status: phase.status,
              url: 'https://release-target.example/'
            }
          ], [
            peerId,
            {
              ...scopeCase.peer,
              active: phase.active,
              discarded: phase.discarded,
              frozen: false,
              id: peerId,
              status: phase.status,
              url: 'https://release-peer.example/'
            }
          ]]);
          const lineage = new Map();
          let markerAlive = true;
          let releaseWakes = 0;
          let takeoverCancelled = false;
          const resolveId = id => lineage.get(id) || id;
          const {releaseMatching, releaseTab} = createReleaseHelper({
            cancelTakeover: async id => {
              calls.push(`cancel:${id}`);
              assert.equal(id, targetId, 'only the matching takeover may be cancelled');
              takeoverCancelled = true;
              markerAlive = false;
              const current = live.get(id);
              if (phase.name === 'waking-active-pulse') {
                live.set(id, {
                  ...current,
                  active: false,
                  discarded: false,
                  status: 'complete'
                });
              }
              else if (phase.nativePending) {
                lineage.set(id, successorId);
                live.delete(id);
                live.set(successorId, {
                  ...current,
                  active: false,
                  discarded: true,
                  id: successorId,
                  status: 'unloaded'
                });
              }
              return true;
            },
            getStatus: async () => markerAlive ? {
              attemptId: token,
              marker: {
                attemptId: token,
                source: 'requested',
                state: phase.markerState,
                updatedAt: 1
              }
            } : {},
            invalidate: async id => {
              calls.push(`invalidate:${id}`);
              markerAlive = false;
            },
            resolveId,
            runtime: () => ({lastError: null}),
            withNativeMutationGuard: task => task(),
            tabs: () => ({
              get(id, callback) {
                calls.push(`get:${id}`);
                callback(live.get(id));
              },
              reload(id, options, callback) {
                assert.equal(takeoverCancelled, true,
                  'takeover cancellation must finish before release allocates its wake');
                releaseWakes += 1;
                calls.push(`reload:${id}`);
                const loading = {...live.get(id), discarded: false, status: 'loading'};
                live.set(id, loading);
                callback();
                queueMicrotask(() => live.set(id, {...loading, status: 'complete'}));
              }
            }),
            takeoverSnapshot: () => [{
              id: targetId,
              started: phase.started,
              tab: {id: targetId, ...scopeCase.target}
            }, {
              id: peerId,
              started: phase.started,
              tab: {id: peerId, ...scopeCase.peer}
            }],
            unfreeze: async () => assert.fail('these phases never use the frozen release path')
          });
          releaseTab.interval = 0;
          releaseTab.polls = 10;
          releaseTab.stableReads = 2;

          const released = await releaseMatching([], scopeCase.scope.matches);
          const finalId = resolveId(targetId);
          // Model the old job reaching its final rediscard callback after the
          // release returns. It is allowed to mutate only when the plugin
          // failed to cancel the matching takeover first.
          if (!takeoverCancelled) {
            live.set(finalId, {
              ...live.get(finalId),
              discarded: true,
              status: 'unloaded'
            });
          }
          const final = live.get(finalId);

          assert.deepEqual(released.map(tab => tab.id), [finalId]);
          assert.equal(calls.filter(call => call === `cancel:${targetId}`).length, 1,
            'matching takeover must be cancelled exactly once before release');
          assert.equal(calls.some(call => call === `cancel:${peerId}`), false,
            'out-of-scope takeover must not be cancelled');
          assert.equal(releaseWakes, phase.expectedReleaseWakes,
            'release may allocate at most the one wake required by its post-cancel physical state');
          assert.ok(releaseWakes <= 1, 'release must never create a wake loop');
          assert.equal(takeoverCancelled, true,
            'matching takeover must be cancelled before release completes');
          assert.deepEqual({
            active: final.active,
            discarded: final.discarded,
            status: final.status
          }, {
            active: false,
            discarded: false,
            status: 'complete'
          });
          assert.equal(markerAlive, false, 'takeover cancellation must leave no stale ownership marker');
          assert.equal(calls.some(call => call.startsWith('invalidate:')), false,
            'release must not invalidate again after cancellation removed the matching attempt');
        });
      }
    }
  }
  finally {
    delete globalThis.chrome;
  }
});

test('focus, next, previous, and startup releases all use the shared helper', async () => {
  const files = [
    '../v3/worker/plugins/focus/core.mjs',
    '../v3/worker/plugins/next/core.mjs',
    '../v3/worker/plugins/previous/core.mjs',
    '../v3/worker/plugins/startup/core.mjs'
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /core\/release\.mjs/);
    assert.match(source, /releaseMatching/);
    assert.match(source, /release-scopes\.mjs/);
    assert.match(source, /scope\.query/);
    assert.match(source, /scope\.matches/);
    assert.doesNotMatch(source, /chrome\.tabs\.reload/);
  }
});

test('bulk popup release is wired to the same verified helper', async () => {
  const menu = await readFile(new URL('../v3/worker/menu.mjs', import.meta.url), 'utf8');
  const scope = await readFile(new URL('../v3/worker/core/command-scope.mjs', import.meta.url), 'utf8');
  const discardSource = await readFile(new URL('../v3/worker/core/discard.mjs', import.meta.url), 'utf8');
  assert.match(menu, /import \{releaseTab\} from '\.\/core\/release\.mjs'/);
  assert.match(menu, /release:\s*trackTabTask\(progress, releaseTab, POPUP_CODES\.TAB_RELEASED\)/);
  assert.match(scope, /await release\(tab, options\)/);
  assert.doesNotMatch(scope, /skipCancel|wakeFrozen/);
  assert.doesNotMatch(menu, /wakeFrozen|discard\.unfreeze/);
  assert.doesNotMatch(discardSource,
    /createActivationPulse|invokeOptionalUnfreeze|discard\.unfreeze|chrome\.tabs\.update\([^)]*active:\s*true/);
});
