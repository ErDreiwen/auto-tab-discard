import test from 'node:test';
import assert from 'node:assert/strict';

test('resumes an awake takeover without sweeping ordinary claimed tabs at MV3 restart', async () => {
  const sessionState = {
    __discardOwnership: {
      1: {
        state: 'takeover-awake',
        attemptId: 'dead-worker-attempt',
        updatedAt: 1
      },
      2: {
        state: 'owned',
        source: 'claimed',
        attemptId: null,
        updatedAt: 1
      }
    }
  };
  const liveTab = {
    id: 1,
    windowId: 1,
    index: 1,
    active: false,
    discarded: false,
    status: 'loading',
    url: 'https://restart-recovery.example/'
  };
  const claimedTab = {
    id: 2,
    windowId: 1,
    index: 2,
    active: false,
    discarded: true,
    status: 'unloaded',
    url: 'https://ordinary-claimed.example/'
  };
  const updatedListeners = [];
  const calls = [];
  const event = () => ({addListener() {}});

  globalThis.chrome = {
    runtime: {
      lastError: null
    },
    storage: {
      managed: {
        get(defaults, callback) {
          callback(defaults);
        }
      },
      local: {
        get(defaults, callback) {
          callback(defaults);
        }
      },
      session: {
        get(defaults, callback) {
          callback({...defaults, ...sessionState});
        },
        set(values, callback) {
          Object.assign(sessionState, values);
          callback();
        },
        remove(key, callback) {
          delete sessionState[key];
          callback();
        }
      },
      onChanged: {
        addListener() {}
      }
    },
    tabs: {
      query(options, callback) {
        callback(options.active === false || Object.keys(options).length === 0 ? [
          {...liveTab},
          {...claimedTab}
        ] : []);
      },
      get(id, callback) {
        callback(id === liveTab.id ? {...liveTab} : id === claimedTab.id ? {...claimedTab} : undefined);
      },
      reload() {
        assert.fail('an already-awake takeover recovery must not reload again');
      },
      discard(id, callback) {
        assert.equal(id, liveTab.id, 'startup must not discard an ordinary claimed tab');
        calls.push(`discard:${id}`);
        liveTab.discarded = true;
        liveTab.status = 'unloaded';
        updatedListeners.forEach(listener => listener(id, {discarded: true}, {...liveTab}));
        callback({...liveTab});
      },
      onUpdated: {
        addListener(listener) {
          updatedListeners.push(listener);
        }
      },
      onCreated: event(),
      onAttached: event(),
      onRemoved: event(),
      onReplaced: event()
    }
  };

  try {
    const [{discard}, {ownership}] = await Promise.all([
      import('../v3/worker/core/discard.mjs'),
      import('../v3/worker/core/ownership.mjs')
    ]);
    discard.nativeTimeout = 100;
    discard.getTimeout = 100;
    discard.takeoverTimeout = 100;
    discard.takeoverFenceTimeout = 100;
    discard.takeoverPoll = 0;
    discard.takeoverRetries = 1;

    assert.equal((await ownership.status(1)).marker.state, 'takeover-awake');
    await ownership.start(1, 0);
    assert.equal((await ownership.status(1)).marker.state, 'takeover-recovery');
    assert.equal((await ownership.status(2)).marker.source, 'claimed');

    assert.deepEqual(await discard.recoverTakeovers(), [true]);
    assert.deepEqual(calls, ['discard:1']);
    assert.equal(liveTab.discarded, true);
    const finalState = await ownership.status(1);
    assert.equal(finalState.marker.state, 'owned');
    assert.equal(finalState.marker.source, 'self');
    assert.equal(claimedTab.discarded, true);
    assert.equal((await ownership.status(2)).marker.source, 'claimed');
  }
  finally {
    delete globalThis.chrome;
  }
});
