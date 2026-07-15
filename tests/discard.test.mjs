import test from 'node:test';
import assert from 'node:assert/strict';

test('waits for tabs.discard before releasing the next queued job', async () => {
  let active = 0;
  let maximum = 0;
  const completed = [];
  let prepends = '';
  const sessionState = {};
  const pendingAtNativeCall = [];
  const tabListeners = {};

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
          callback({
            ...defaults,
            prepends,
            favicon: false,
            'simultaneous-jobs': 1
          });
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
      onUpdated: {
        addListener(listener) {
          tabListeners.updated = listener;
        }
      },
      discard(id, callback) {
        pendingAtNativeCall.push(sessionState.__discardOwnership?.[id]?.state);
        active += 1;
        maximum = Math.max(maximum, active);
        setTimeout(() => {
          active -= 1;
          completed.push(id);
          callback({id, discarded: true});
        }, 10);
      }
    }
  };

  try {
    const {discard, inprogress} = await import('../v3/worker/core/discard.mjs');

    const results = await Promise.all([
      discard({id: 1, active: false, discarded: false}),
      discard({id: 2, active: false, discarded: false})
    ]);

    assert.deepEqual(completed, [1, 2]);
    assert.deepEqual(results, [true, true]);
    assert.equal(maximum, 1);
    assert.equal(discard.count, 0);
    assert.equal(inprogress.size, 0);
    assert.deepEqual(pendingAtNativeCall, ['pending', 'pending']);
    assert.equal(sessionState.__discardOwnership[1].source, 'self');
    assert.equal(sessionState.__discardOwnership[2].source, 'self');

    chrome.tabs.discard = (id, callback) => callback();
    chrome.tabs.get = (id, callback) => callback({id, discarded: true});
    assert.equal(await discard.perform({id: 3}), true);
    assert.equal(sessionState.__discardOwnership[3].source, 'claimed');

    prepends = 'sleep:';
    discard.prepareTimeout = 10;
    chrome.scripting = {
      executeScript: async () => [{result: 'async'}]
    };
    chrome.tabs.sendMessage = () => {};
    assert.equal(await discard({id: 4, active: false, discarded: false}), true);
    assert.equal(inprogress.size, 0);

    discard.nativeTimeout = 10;
    discard.getTimeout = 10;
    chrome.tabs.discard = id => {
      tabListeners.updated(id, {discarded: true}, {
        id,
        windowId: 1,
        url: 'https://timeout.example/',
        discarded: true
      });
    };
    chrome.tabs.get = () => {};
    assert.equal(await discard.perform({
      id: 5,
      windowId: 1,
      url: 'https://timeout.example/',
      discarded: false
    }), false);
    assert.equal(sessionState.__discardOwnership[5].source, 'claimed');
  }
  finally {
    delete globalThis.chrome;
  }
});
