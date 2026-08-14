import test from 'node:test';
import assert from 'node:assert/strict';

const RESET_LOCK = Object.freeze({
  lockManager: {
    request(name, options, callback) {
      return Promise.resolve(callback({mode: 'exclusive', name}));
    }
  }
});

const event = () => {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    },
    fire(...args) {
      for (const listener of [...listeners]) listener(...args);
    }
  };
};

const storageArea = state => ({
  clear(callback) {
    for (const key of Object.keys(state)) delete state[key];
    callback?.();
  },
  get(defaults, callback) {
    const result = Array.isArray(defaults) ? Object.fromEntries(defaults
      .filter(key => Object.hasOwn(state, key)).map(key => [key, state[key]])) :
      typeof defaults === 'string' ? {[defaults]: state[defaults]} :
        {...(defaults || {}), ...state};
    callback?.(structuredClone(result));
    return Promise.resolve(structuredClone(result));
  },
  remove(keys, callback) {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    callback?.();
  },
  set(values, callback) {
    Object.assign(state, structuredClone(values));
    callback?.();
    return Promise.resolve();
  }
});

test('reset drains queued, renderer-pre-native, and native ordinary work without journal resurrection', async t => {
  const localState = {
    favicon: false,
    prepends: 'sleep:',
    'simultaneous-jobs': 2
  };
  const createdAt = Date.now() - 1000;
  const sessionState = {
    __ordinaryDiscardIntents: {
      nextSequence: 1,
      records: {
        'restart-intent': {
          createdAt,
          expiresAt: createdAt + 5 * 60_000,
          id: 'restart-intent',
          incognito: false,
          sequence: 1,
          status: 'queued',
          tabId: 5,
          updatedAt: createdAt,
          windowId: 1
        }
      },
      version: 2
    }
  };
  const liveTabs = new Map(Array.from({length: 5}, (_, index) => {
    const id = index + 1;
    return [id, {
      active: false,
      audible: false,
      autoDiscardable: true,
      discarded: false,
      frozen: false,
      id,
      incognito: false,
      status: 'complete',
      url: `https://reset-${id}.example/`,
      windowId: 1
    }];
  }));
  const events = {
    activated: event(),
    attached: event(),
    created: event(),
    moved: event(),
    removed: event(),
    replaced: event(),
    updated: event()
  };
  const nativeCalls = [];
  let finishNative;
  let finishSecondPreparation;
  let secondPreparationStarted;
  const secondPreparation = new Promise(resolve => secondPreparationStarted = resolve);

  globalThis.chrome = {
    runtime: {lastError: null},
    scripting: {
      executeScript(details) {
        const id = details.target?.tabId;
        if (details.func?.name === 'restoreDocumentMarker') {
          return Promise.resolve([{result: {restored: true}}]);
        }
        if (id === 2) {
          secondPreparationStarted();
          return new Promise(resolve => finishSecondPreparation = () => resolve([{result: {
            complete: true,
            faviconApplied: true,
            stopped: true,
            titleApplied: true,
            top: true
          }}]));
        }
        return Promise.resolve([{result: {
          complete: true,
          faviconApplied: true,
          stopped: true,
          titleApplied: true,
          top: true
        }}]);
      }
    },
    storage: {
      local: storageArea(localState),
      managed: storageArea({}),
      onChanged: event(),
      session: storageArea(sessionState)
    },
    tabs: {
      discard(id, callback) {
        nativeCalls.push(id);
        const operation = new Promise(resolve => {
          const settle = () => {
            const settled = {...liveTabs.get(id), discarded: true, status: 'unloaded'};
            liveTabs.set(id, settled);
            events.updated.fire(id, {discarded: true, status: 'unloaded'}, {...settled});
            resolve({...settled});
          };
          if (id === 5) queueMicrotask(settle);
          else finishNative = settle;
        });
        operation.then(tab => callback?.(tab));
        return operation;
      },
      get(id, callback) { callback(liveTabs.get(id) && {...liveTabs.get(id)}); },
      onActivated: events.activated,
      onAttached: events.attached,
      onCreated: events.created,
      onMoved: events.moved,
      onRemoved: events.removed,
      onReplaced: events.replaced,
      onUpdated: events.updated,
      query(options, callback) { callback([...liveTabs.values()].map(tab => ({...tab}))); }
    },
    windows: {
      get(id, callback) { callback({focused: true, id, incognito: false, type: 'normal'}); }
    }
  };
  t.after(() => delete globalThis.chrome);

  const [{discard, inprogress}, {ownership}, {resetExtensionState}, {KEY}] = await Promise.all([
    import(`../v3/worker/core/discard.mjs?global-reset=${Date.now()}`),
    import('../v3/worker/core/ownership.mjs'),
    import('../v3/worker/core/reset.mjs'),
    import('../v3/worker/core/ordinary-intents.mjs')
  ]);
  discard.getTimeout = 100;
  discard.nativeTimeout = 1000;
  discard.nativeStableDwell = 0;
  discard.prepareTimeout = 1000;
  discard.releaseNativeFenceTimeout = 1000;

  const recovered = await discard.recoverOrdinaryDiscards({
    revalidate: async tabs => {
      assert.deepEqual(tabs.map(tab => tab.id), [5]);
      return new Set([5]);
    }
  });
  assert.deepEqual(recovered.map(({status, tabId}) => ({status, tabId})), [
    {status: 'completed', tabId: 5}
  ]);
  assert.deepEqual(nativeCalls, [5],
    'the real structured discard outcome must be converted into recovery success');

  const native = discard({...liveTabs.get(1)});
  while (!nativeCalls.includes(1)) await new Promise(resolve => setImmediate(resolve));
  const preNative = discard({...liveTabs.get(2)});
  await secondPreparation;
  const queued = discard({...liveTabs.get(3)});
  while (discard.tabs.length !== 1) await new Promise(resolve => setImmediate(resolve));
  assert.ok(sessionState[KEY], 'admitted ordinary work must be journaled before reset');

  const reset = resetExtensionState(
    ownership,
    chrome.storage.local,
    discard.cancelTakeovers,
    undefined,
    discard.beginReset,
    RESET_LOCK
  );
  const rejectedDuringReset = await discard({...liveTabs.get(4)});
  assert.equal(rejectedDuringReset.status, 'skipped');
  assert.match(rejectedDuringReset.reason, /reset/i);

  finishSecondPreparation();
  finishNative();
  const [nativeResult, preNativeResult, queuedResult, resetResult] = await Promise.all([
    native,
    preNative,
    queued,
    reset
  ]);

  assert.equal(nativeResult.status, 'succeeded');
  assert.equal(preNativeResult.status, 'skipped');
  assert.equal(queuedResult.status, 'skipped');
  assert.equal(resetResult.reconciled, true);
  assert.deepEqual(nativeCalls, [5, 1],
    'pre-native and queued work must never reach tabs.discard');
  assert.equal(sessionState[KEY], undefined, 'the ordinary journal must be removed last');
  assert.equal(discard.tabs.length, 0);
  assert.equal(discard.count, 0);
  assert.equal(inprogress.size, 0);
  assert.deepEqual(discard.takeoverSnapshot(), []);

  // Lifecycle noise delivered after completion cannot recreate an intent.
  events.updated.fire(1, {discarded: true}, {...liveTabs.get(1)});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sessionState[KEY], undefined);
});
