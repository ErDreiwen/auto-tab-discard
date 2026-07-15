import test from 'node:test';
import assert from 'node:assert/strict';

test('hydrates preferences when a Manifest V3 worker starts for any event', async () => {
  let managedReads = 0;
  const listeners = {};

  globalThis.chrome = {
    runtime: {
      lastError: null,
      onStartup: {
        addListener(listener) {
          listeners.startup = listener;
        }
      },
      onInstalled: {
        addListener(listener) {
          listeners.installed = listener;
        }
      }
    },
    storage: {
      managed: {
        get(defaults, callback) {
          managedReads += 1;
          setTimeout(() => callback(defaults));
        }
      },
      local: {
        get(defaults, callback) {
          setTimeout(() => callback({...defaults, click: 'click.discard-tab'}));
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
    }
  };

  try {
    const {starters, browserStarters} = await import('../v3/worker/core/startup.mjs');

    while (starters.ready === false) {
      await new Promise(resolve => setTimeout(resolve));
    }

    let ran = 0;
    await starters.push(() => ran += 1);
    let browserRan = 0;
    browserStarters.push(() => browserRan += 1);

    assert.equal(managedReads, 1);
    assert.equal(ran, 1);
    assert.equal(browserRan, 0);
    assert.equal(typeof listeners.startup, 'function');
    assert.equal(typeof listeners.installed, 'function');

    await listeners.startup();
    assert.equal(browserRan, 1);
  }
  finally {
    delete globalThis.chrome;
  }
});
