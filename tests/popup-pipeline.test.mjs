import test from 'node:test';
import assert from 'node:assert/strict';

test('keeps a popup command alive through native tab discard completion', async () => {
  let finishDiscard;
  const event = {addListener() {}, removeListener() {}};
  const sessionState = {};
  const storedMarker = id => sessionState[`__discardOwnership:tab:${id}`]?.marker;
  const background = {id: 2, active: false, discarded: false, status: 'complete'};

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
          callback({...defaults, prepends: '', favicon: false});
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
    const active = {id: 1, active: true};
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
