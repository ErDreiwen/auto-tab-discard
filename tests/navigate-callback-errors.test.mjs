import test from 'node:test';
import assert from 'node:assert/strict';

const event = () => ({addListener() {}});

const storageArea = state => ({
  get(query, callback) {
    if (query === null) {
      callback(structuredClone(state));
      return;
    }
    const result = Array.isArray(query) ? Object.fromEntries(query
      .filter(key => Object.hasOwn(state, key))
      .map(key => [key, structuredClone(state[key])])) : {
        ...(query || {}),
        ...Object.fromEntries(Object.keys(query || {}).filter(key => Object.hasOwn(state, key))
          .map(key => [key, structuredClone(state[key])]))
      };
    callback(result);
  },
  remove(keys, callback) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      delete state[key];
    }
    callback();
  },
  set(values, callback) {
    Object.assign(state, structuredClone(values));
    callback();
  }
});

test('Firefox compatibility update failure cannot fall through to closing the active tab', async () => {
  const removed = [];
  const sessionState = {};
  const localState = {};
  const tabs = [{
    active: true,
    discarded: false,
    id: 1,
    index: 0,
    windowId: 10
  }, {
    active: false,
    discarded: false,
    id: 2,
    index: 1,
    windowId: 10
  }];
  globalThis.chrome = {
    runtime: {lastError: null},
    storage: {
      local: storageArea(localState),
      managed: {get(query, callback) { callback({}); }},
      onChanged: event(),
      session: storageArea(sessionState)
    },
    tabs: {
      get(id, callback) {
        callback(tabs.find(tab => tab.id === id));
      },
      onActivated: event(),
      onAttached: event(),
      onCreated: event(),
      onRemoved: event(),
      onReplaced: event(),
      onUpdated: event(),
      query(options, callback) {
        callback(tabs.map(tab => ({...tab})));
      },
      remove(id, callback) {
        removed.push(id);
        callback();
      },
      update(id, properties, callback) {
        callback(undefined, Error('Firefox activation denied'));
      }
    }
  };

  try {
    const {navigate} = await import(
      `../v3/worker/core/navigate.mjs?callback-error=${Date.now()}`
    );
    await assert.rejects(navigate('close'), /Firefox activation denied/);
    assert.deepEqual(removed, [],
      'the old active tab must remain open when successor activation fails');
  }
  finally {
    delete globalThis.chrome;
  }
});
