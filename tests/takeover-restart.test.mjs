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
      },
      3: {
        state: 'late-native',
        source: 'self-pending',
        attemptId: 'late-native-from-dead-worker',
        expiresAt: Date.now() + 60000,
        visual: {complete: true, favicon: false, repair: true, title: true},
        updatedAt: 1
      },
      4: {
        state: 'takeover-queued',
        source: 'requested',
        attemptId: 'queued-by-dead-worker',
        updatedAt: 1
      },
      5: {
        state: 'takeover-waking',
        attemptId: 'pre-wake-dead-worker-attempt',
        updatedAt: 1
      }
    }
  };
  const liveTab = {
    id: 1,
    windowId: 1,
    incognito: false,
    index: 1,
    active: false,
    discarded: false,
    status: 'loading',
    url: 'https://restart-recovery.example/'
  };
  const claimedTab = {
    id: 2,
    windowId: 1,
    incognito: false,
    index: 2,
    active: false,
    discarded: true,
    status: 'unloaded',
    url: 'https://ordinary-claimed.example/'
  };
  const lateNativeTab = {
    id: 3,
    windowId: 1,
    incognito: false,
    index: 3,
    active: false,
    discarded: true,
    status: 'unloaded',
    url: 'https://late-native-restart.example/'
  };
  const queuedTab = {
    id: 4,
    windowId: 1,
    incognito: false,
    index: 4,
    active: false,
    discarded: true,
    status: 'unloaded',
    url: 'https://queued-restart.example/'
  };
  const preWakeTab = {
    id: 5,
    windowId: 1,
    incognito: false,
    index: 5,
    active: false,
    discarded: true,
    status: 'unloaded',
    url: 'https://pre-wake-restart.example/'
  };
  const takeoverTab = id => id === liveTab.id ? liveTab :
    id === queuedTab.id ? queuedTab : id === preWakeTab.id ? preWakeTab : undefined;
  const updatedListeners = [];
  const calls = [];
  const event = () => ({addListener() {}});

  globalThis.chrome = {
    runtime: {
      lastError: null
    },
    scripting: {
      executeScript({target}) {
        const tab = takeoverTab(target.tabId);
        assert.ok(tab);
        calls.push(`stop:${target.tabId}`);
        tab.status = 'complete';
        tab.title = '💤 test';
        updatedListeners.forEach(listener => listener(target.tabId, {status: 'complete'}, {...tab}));
        return Promise.resolve([{result: {stopped: true, title: '💤 test'}}]);
      }
    },
    storage: {
      managed: {
        get(query, callback) {
          callback({});
        }
      },
      local: {
        get(defaults, callback) {
          callback(Array.isArray(defaults) ? {} : defaults);
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
    windows: {
      get(id, callback) {
        callback({id, incognito: false, type: 'normal'});
      }
    },
    tabs: {
      query(options, callback) {
        callback(options.active === false || Object.keys(options).length === 0 ? [
          {...liveTab},
          {...claimedTab},
          {...lateNativeTab},
          {...queuedTab},
          {...preWakeTab}
        ] : []);
      },
      get(id, callback) {
        callback(id === liveTab.id ? {...liveTab} :
          id === claimedTab.id ? {...claimedTab} :
            id === lateNativeTab.id ? {...lateNativeTab} :
              id === queuedTab.id ? {...queuedTab} :
                id === preWakeTab.id ? {...preWakeTab} : undefined);
      },
      reload(id, options, callback) {
        const tab = takeoverTab(id);
        assert.ok(tab && id !== liveTab.id, 'an already-awake takeover recovery must not reload again');
        calls.push(`reload:${id}`);
        tab.discarded = false;
        tab.status = 'loading';
        updatedListeners.forEach(listener => listener(id, {
          discarded: false,
          status: 'loading'
        }, {...tab}));
        callback();
      },
      async discard(id) {
        const tab = takeoverTab(id);
        assert.ok(tab, 'startup must not discard an ordinary claimed tab');
        calls.push(`discard:${id}`);
        tab.discarded = true;
        tab.status = 'unloaded';
        updatedListeners.forEach(listener => listener(id, {discarded: true}, {...tab}));
        return {...tab};
      },
      onUpdated: {
        addListener(listener) {
          updatedListeners.push(listener);
        },
        removeListener(listener) {
          const index = updatedListeners.indexOf(listener);
          if (index !== -1) {
            updatedListeners.splice(index, 1);
          }
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
    discard.quiesceDwell = 0;
    discard.reloadStartGrace = 0;

    assert.equal((await ownership.status(1)).marker.state, 'takeover-awake');
    await ownership.start(1, 0);
    assert.equal((await ownership.status(1)).marker.state, 'takeover-recovery');
    assert.equal((await ownership.status(2)).marker.source, 'claimed');
    assert.equal((await ownership.status(3)).marker.source, 'self');
    assert.equal((await ownership.status(5)).marker.state, 'takeover-queued');

    assert.deepEqual(await discard.recoverTakeovers(), [true, true, true]);
    assert.equal(calls.filter(call => call === 'stop:1').length, 2);
    assert.equal(calls.filter(call => call === 'discard:1').length, 1);
    for (const id of [4, 5]) {
      assert.equal(calls.filter(call => call === `reload:${id}`).length, 1);
      assert.equal(calls.filter(call => call === `stop:${id}`).length, 2);
      assert.equal(calls.filter(call => call === `discard:${id}`).length, 1);
    }
    assert.equal(liveTab.discarded, true);
    const finalState = await ownership.status(1);
    assert.equal(finalState.marker.state, 'owned');
    assert.equal(finalState.marker.source, 'self');
    assert.equal(claimedTab.discarded, true);
    assert.equal((await ownership.status(2)).marker.source, 'claimed');
    assert.equal((await ownership.status(3)).marker.source, 'self');
    assert.equal((await ownership.status(4)).marker.source, 'self');
    assert.equal((await ownership.status(5)).marker.source, 'self');
  }
  finally {
    delete globalThis.chrome;
  }
});
