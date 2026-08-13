import test from 'node:test';
import assert from 'node:assert/strict';

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
    holdNextSessionWrite = true;
    const lateClaim = ownership.claim(liveTabs[0]);
    while (!releaseSessionWrite) {
      await new Promise(resolve => setTimeout(resolve));
    }
    const resetPending = resetExtensionState(ownership);
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
    }), /local clear failed/);
    assert.equal(ownershipReset, false);
    assert.equal(takeoversCancelled, false);
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
    /resetExtensionState\(\s*ownership,\s*chrome\.storage\.local,\s*discard\.cancelTakeovers,\s*releaseTab\s*\)/);
});
