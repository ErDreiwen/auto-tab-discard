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

test('pinned popup navigation ignores a later focus switch to another window', async () => {
  const updates = [];
  const queries = [];
  const sessionState = {};
  const localState = {};
  const tabs = [{
    active: true, discarded: false, id: 11, incognito: false, index: 0, windowId: 10
  }, {
    active: false, discarded: false, id: 12, incognito: false, index: 1, windowId: 10
  }, {
    active: true, discarded: false, id: 21, incognito: false, index: 0, windowId: 20
  }, {
    active: false, discarded: false, id: 22, incognito: false, index: 1, windowId: 20
  }];
  globalThis.chrome = {
    runtime: {lastError: null},
    storage: {
      local: storageArea(localState), managed: {get(query, callback) { callback({}); }},
      onChanged: event(), session: storageArea(sessionState)
    },
    tabs: {
      get(id, callback) { callback(tabs.find(tab => tab.id === id)); },
      onActivated: event(), onAttached: event(), onCreated: event(), onRemoved: event(),
      onReplaced: event(), onUpdated: event(),
      query(options, callback) {
        queries.push(structuredClone(options));
        const windowId = Number.isInteger(options.windowId) ? options.windowId : 20;
        callback(tabs.filter(tab => tab.windowId === windowId).map(tab => ({...tab})));
      },
      remove(id, callback) { callback(); },
      update(id, properties, callback) {
        updates.push({id, properties: structuredClone(properties)});
        callback({...tabs.find(tab => tab.id === id), ...properties});
      }
    }
  };

  try {
    const {navigate} = await import(`../v3/worker/core/navigate.mjs?pinned=${Date.now()}`);
    assert.equal(await navigate('move-next', false, {
      incognito: false,
      tabId: 11,
      windowId: 10
    }), true);
    assert.deepEqual(updates, [{id: 12, properties: {active: true}}]);
    assert.equal(queries.length, 2, 'the target is re-read immediately before mutation');
    assert.equal(queries.every(options => options.windowId === 10 && !options.currentWindow), true);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('pinned navigation rejects an active-tab race before mutating', async () => {
  const updates = [];
  let reads = 0;
  const sessionState = {};
  const localState = {};
  globalThis.chrome = {
    runtime: {lastError: null},
    storage: {
      local: storageArea(localState), managed: {get(query, callback) { callback({}); }},
      onChanged: event(), session: storageArea(sessionState)
    },
    tabs: {
      get(id, callback) { callback(undefined); },
      onActivated: event(), onAttached: event(), onCreated: event(), onRemoved: event(),
      onReplaced: event(), onUpdated: event(),
      query(options, callback) {
        reads += 1;
        callback(reads === 1 ? [{
          active: true, discarded: false, id: 31, incognito: false, index: 0, windowId: 30
        }, {
          active: false, discarded: false, id: 32, incognito: false, index: 1, windowId: 30
        }] : [{
          active: false, discarded: false, id: 31, incognito: false, index: 0, windowId: 30
        }, {
          active: true, discarded: false, id: 32, incognito: false, index: 1, windowId: 30
        }]);
      },
      remove(id, callback) { callback(); },
      update(id, properties, callback) { updates.push(id); callback(); }
    }
  };

  try {
    const {navigate} = await import(`../v3/worker/core/navigate.mjs?race=${Date.now()}`);
    await assert.rejects(navigate('move-next', false, {
      incognito: false,
      tabId: 31,
      windowId: 30
    }), /navigation target changed/i);
    assert.deepEqual(updates, []);
    assert.equal(reads, 2);
  }
  finally {
    delete globalThis.chrome;
  }
});
