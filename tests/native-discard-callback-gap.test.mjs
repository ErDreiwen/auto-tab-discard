import assert from 'node:assert/strict';
import test from 'node:test';

const event = () => {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...args) {
      listeners.forEach(listener => listener(...args));
    },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    }
  };
};

const area = state => ({
  get(keys, callback) {
    if (keys === null) {
      callback({...state});
    }
    else if (typeof keys === 'object') {
      callback({...keys, ...state});
    }
    else {
      callback({[keys]: state[keys]});
    }
  },
  remove(keys, callback = () => {}) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      delete state[key];
    }
    callback();
  },
  set(values, callback = () => {}) {
    Object.assign(state, values);
    callback();
  }
});

test('an accepted Chromium discard waits through its inactive callback gap', async () => {
  const id = 91;
  const localState = {};
  const sessionState = {};
  const updated = event();
  const tab = {
    active: false,
    discarded: false,
    frozen: false,
    id,
    status: 'complete',
    url: 'https://callback-gap.example/'
  };
  let live = {...tab};
  let readsAfterCallback = 0;
  let callbackReturned = false;

  globalThis.chrome = {
    runtime: {lastError: null},
    storage: {
      local: area(localState),
      managed: {
        get(defaults, callback) {
          callback(defaults);
        }
      },
      onChanged: event(),
      session: area(sessionState)
    },
    tabs: {
      discard(tabId, callback) {
        assert.equal(tabId, id);
        callbackReturned = true;
        // Chromium can acknowledge tabs.discard() before tabs.get exposes the
        // physical transition. The callback clone is provenance, not proof.
        callback({...live});
        setTimeout(() => {
          live = {...live, discarded: true, status: 'unloaded'};
          updated.emit(id, {discarded: true, status: 'unloaded'}, {...live});
        }, 5);
      },
      get(tabId, callback) {
        assert.equal(tabId, id);
        if (callbackReturned) {
          readsAfterCallback += 1;
        }
        callback({...live});
      },
      onUpdated: updated,
      query(options, callback) {
        callback([{...live}]);
      }
    }
  };

  try {
    const [{discard}, {ownership}] = await Promise.all([
      import('../v3/worker/core/discard.mjs'),
      import('../v3/worker/core/ownership.mjs')
    ]);
    discard.getTimeout = 100;
    discard.nativeSettleTimeout = 100;
    discard.nativeStableDwell = 1;
    discard.takeoverPoll = 1;

    const result = await discard.perform({...tab});

    assert.equal(result.status, 'succeeded');
    assert.equal(result.ok, true);
    assert.equal((await ownership.status(id)).marker?.source, 'self');
    assert.ok(readsAfterCallback >= 2,
      'the accepted operation must be re-read instead of failing on its first inactive loaded snapshot');
  }
  finally {
    delete globalThis.chrome;
  }
});
