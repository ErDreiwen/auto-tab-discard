import test from 'node:test';
import assert from 'node:assert/strict';

test('keeps a popup command alive through native tab discard completion', async () => {
  let finishDiscard;

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
          callback(defaults);
        }
      },
      onChanged: {
        addListener() {}
      }
    },
    tabs: {
      discard(id, callback) {
        finishDiscard = () => callback({id, discarded: true});
      }
    }
  };

  try {
    const [{discard}, {dispatchPopup, respondAsync}] = await Promise.all([
      import('../v3/worker/core/discard.mjs'),
      import('../v3/worker/core/respond.mjs')
    ]);
    const active = {id: 1, active: true};
    const background = {id: 2, active: false, discarded: false};
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

    while (!finishDiscard) {
      await new Promise(resolve => setTimeout(resolve));
    }
    assert.equal(responded, false);

    finishDiscard();
    assert.deepEqual(await response, {ok: true, value: true});
  }
  finally {
    delete globalThis.chrome;
  }
});
