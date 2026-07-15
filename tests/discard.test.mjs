import test from 'node:test';
import assert from 'node:assert/strict';

test('waits for tabs.discard before releasing the next queued job', async () => {
  let active = 0;
  let maximum = 0;
  const completed = [];

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
            prepends: '',
            favicon: false,
            'simultaneous-jobs': 1
          });
        }
      },
      session: {
        get(defaults, callback) {
          callback(defaults);
        }
      },
      onChanged: {
        addListener() {}
      }
    },
    tabs: {
      discard(id, callback) {
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

    chrome.tabs.discard = (id, callback) => callback();
    chrome.tabs.get = (id, callback) => callback({id, discarded: true});
    assert.equal(await discard.perform({id: 3}), true);
  }
  finally {
    delete globalThis.chrome;
  }
});
