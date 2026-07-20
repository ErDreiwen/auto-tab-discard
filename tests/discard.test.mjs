import test from 'node:test';
import assert from 'node:assert/strict';

test('waits for tabs.discard before releasing the next queued job', async () => {
  let active = 0;
  let maximum = 0;
  const completed = [];
  let prepends = '';
  const sessionState = {};
  const pendingAtNativeCall = [];
  const tabListeners = {
    replaced: [],
    updated: []
  };

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
          tabListeners.updated.push(listener);
        }
      },
      onReplaced: {
        addListener(listener) {
          tabListeners.replaced.push(listener);
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
    const [{discard, inprogress}, {ownership}] = await Promise.all([
      import('../v3/worker/core/discard.mjs'),
      import('../v3/worker/core/ownership.mjs')
    ]);

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
      tabListeners.updated.forEach(listener => listener(id, {discarded: true}, {
        id,
        windowId: 1,
        url: 'https://timeout.example/',
        discarded: true
      }));
    };
    chrome.tabs.get = () => {};
    assert.equal(await discard.perform({
      id: 5,
      windowId: 1,
      url: 'https://timeout.example/',
      discarded: false
    }), false);
    assert.equal(sessionState.__discardOwnership[5].source, 'claimed');

    const edgeOriginal = {
      id: 6,
      windowId: 2,
      active: false,
      discarded: false,
      status: 'complete',
      url: 'https://edge-perform.example/'
    };
    const edgeSuccessor = {...edgeOriginal, id: 60, discarded: true, status: 'unloaded'};
    const edgeTabs = new Map([[edgeOriginal.id, edgeOriginal]]);
    chrome.tabs.get = (id, callback) => callback(edgeTabs.get(id));
    chrome.tabs.discard = (id, callback) => {
      assert.equal(id, edgeOriginal.id);
      edgeTabs.delete(edgeOriginal.id);
      edgeTabs.set(edgeSuccessor.id, edgeSuccessor);
      tabListeners.replaced.forEach(listener => listener(edgeSuccessor.id, edgeOriginal.id));
      tabListeners.updated.forEach(listener => listener(
        edgeSuccessor.id,
        {discarded: true, status: 'unloaded'},
        edgeSuccessor
      ));
      callback(edgeSuccessor);
    };
    discard.nativeTimeout = 100;
    discard.getTimeout = 100;
    assert.equal(await discard.perform(edgeOriginal), true);
    assert.equal(ownership.resolveId(edgeOriginal.id), edgeSuccessor.id);
    assert.equal((await ownership.status(edgeOriginal.id)).marker.source, 'self');
    assert.equal(sessionState.__discardOwnership[edgeOriginal.id], undefined);
    assert.equal(sessionState.__discardOwnership[edgeSuccessor.id].source, 'self');
  }
  finally {
    delete globalThis.chrome;
  }
});
