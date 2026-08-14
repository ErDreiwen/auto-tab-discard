import test from 'node:test';
import assert from 'node:assert/strict';

test('keeps a popup command alive through native tab discard completion', async () => {
  let finishDiscard;
  const event = {addListener() {}, removeListener() {}};
  const readArea = (state, query) => {
    if (query === null || query === undefined) {
      return {...state};
    }
    if (Array.isArray(query)) {
      return Object.fromEntries(query
        .filter(key => Object.prototype.hasOwnProperty.call(state, key))
        .map(key => [key, state[key]]));
    }
    if (typeof query === 'string') {
      return Object.prototype.hasOwnProperty.call(state, query) ?
        {[query]: state[query]} : {};
    }
    return {...query, ...state};
  };
  const localState = {prepends: '', favicon: false};
  const sessionState = {};
  const storedMarker = id => sessionState[`__discardOwnership:tab:${id}`]?.marker;
  const background = {
    id: 2,
    active: false,
    discarded: false,
    incognito: false,
    status: 'complete',
    windowId: 1
  };

  globalThis.chrome = {
    runtime: {
      lastError: null
    },
    storage: {
      managed: {
        get(query, callback) {
          callback(readArea({}, query));
        }
      },
      local: {
        get(query, callback) {
          callback(readArea(localState, query));
        },
        remove(keys, callback) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete localState[key];
          }
          callback();
        },
        set(values, callback) {
          Object.assign(localState, values);
          callback();
        }
      },
      session: {
        get(query, callback) {
          callback(readArea(sessionState, query));
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
      get(id, callback) {
        callback(id === background.id ? {...background} : undefined);
      },
      query(options, callback) {
        callback([{...background}]);
      },
      discard(id) {
        return new Promise(resolve => {
          finishDiscard = () => {
            background.discarded = true;
            background.status = 'unloaded';
            resolve({...background});
          };
        });
      },
      onActivated: event,
      onAttached: event,
      onCreated: event,
      onRemoved: event,
      onReplaced: event,
      onUpdated: event
    }
  };

  try {
    const [{discard}, {dispatchPopup, respondAsync}] = await Promise.all([
      import('../v3/worker/core/discard.mjs'),
      import('../v3/worker/core/respond.mjs')
    ]);
    const active = {id: 1, active: true, incognito: false, windowId: 1};
    let responded = false;
    const response = new Promise(resolve => {
      const keepAlive = respondAsync(() => dispatchPopup(
        {cmd: 'discard-tabs'},
        async () => [active],
        async () => discard(background)
      ), value => {
        responded = true;
        resolve(value);
      });
      assert.equal(keepAlive, true);
    });

    const deadline = Date.now() + 2000;
    while (!finishDiscard && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve));
    }
    assert.equal(typeof finishDiscard, 'function',
      'the popup pipeline must reach the mocked native discard boundary');
    assert.equal(responded, false);

    finishDiscard();
    const result = await response;
    assert.equal(result.ok, true);
    assert.equal(result.value.status, 'succeeded');
    assert.equal(result.value.ok, true);
    assert.equal(result.value.reason, 'native discard settled');
    assert.equal(storedMarker(2).source, 'self');
  }
  finally {
    delete globalThis.chrome;
  }
});
