import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {installFirefoxCompatibility} from '../v3/firefox/compatibility.mjs';

const compatibilitySource = await readFile(
  new URL('../v3/firefox/compatibility.mjs', import.meta.url),
  'utf8'
);

const event = () => {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    emit(...args) {
      return [...listeners].map(listener => listener(...args));
    },
    listeners
  };
};

const createSession = initial => {
  const values = {...initial};
  const writes = [];
  return {
    area: {
      get(keys, callback) {
        const result = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          if (Object.hasOwn(values, key)) {
            result[key] = structuredClone(values[key]);
          }
        }
        queueMicrotask(() => callback(result));
      },
      set(update, callback) {
        Object.assign(values, structuredClone(update));
        writes.push(structuredClone(update));
        queueMicrotask(() => callback());
      }
    },
    values,
    writes
  };
};

const backgroundChrome = ({session = createSession()} = {}) => {
  const removed = event();
  const replaced = event();
  const messages = event();
  const source = new Map([
    [1, {id: 1, active: false, status: 'complete', title: 'one', windowId: 10}],
    [2, {id: 2, active: false, status: 'loading', title: 'two', windowId: 10}],
    [3, {id: 3, active: true, status: 'complete', title: 'three', windowId: 10}],
    [8, {id: 8, active: false, status: 'complete', title: 'replacement', windowId: 10}]
  ]);
  const calls = {get: [], query: [], update: []};
  const control = {getError: undefined, queryError: undefined, updateError: undefined};
  const runtime = {
    id: 'atd@example.test',
    lastError: undefined,
    getURL(path = '') {
      return `moz-extension://atd-test${path.startsWith('/') ? path : `/${path}`}`;
    },
    onMessage: messages
  };
  const callbackWith = (error, callback, value) => queueMicrotask(() => {
    runtime.lastError = error;
    callback(value);
    runtime.lastError = undefined;
  });
  const tabs = {
    onRemoved: removed,
    onReplaced: replaced,
    get(id, callback) {
      calls.get.push(id);
      callbackWith(control.getError, callback, source.has(id) ? {...source.get(id)} : undefined);
    },
    query(queryInfo, callback) {
      calls.query.push({...queryInfo});
      callbackWith(control.queryError, callback,
        [...source.values()].map(tab => ({...tab})));
    },
    update(id, properties, callback) {
      calls.update.push({id, properties: {...properties}});
      const next = {...source.get(id), ...properties};
      source.set(id, next);
      callbackWith(control.updateError, callback, {...next});
    }
  };
  return {
    calls,
    chrome: {runtime, storage: {session: session.area}, tabs},
    control,
    messages,
    removed,
    replaced,
    runtime,
    session,
    source
  };
};

const popupChrome = fixture => {
  let localCalls = 0;
  const runtime = {
    id: fixture.runtime.id,
    lastError: undefined,
    getURL: fixture.runtime.getURL,
    sendMessage(request, callback) {
      let keptAlive = false;
      let answered = false;
      const respond = response => {
        if (!answered) {
          answered = true;
          queueMicrotask(() => callback(response));
        }
      };
      for (const listener of fixture.messages.listeners) {
        keptAlive = listener(request, {
          id: fixture.runtime.id,
          url: fixture.runtime.getURL('/data/popup/index.html')
        }, respond) === true || keptAlive;
      }
      if (!keptAlive && !answered) {
        queueMicrotask(() => {
          runtime.lastError = {message: 'No internal receiver accepted the message'};
          callback(undefined);
          runtime.lastError = undefined;
        });
      }
    }
  };
  return {
    chrome: {
      runtime,
      tabs: {
        query() {
          localCalls += 1;
        },
        update() {
          localCalls += 1;
        }
      }
    },
    get localCalls() {
      return localCalls;
    }
  };
};

test('Firefox emulated-only autoDiscardable updates settle for Promise and callback callers', async () => {
  const fixture = backgroundChrome();
  installFirefoxCompatibility(fixture.chrome, {popup: false});

  const promiseProperties = {autoDiscardable: false};
  const protectedTab = await fixture.chrome.tabs.update(1, promiseProperties);
  assert.deepEqual(promiseProperties, {autoDiscardable: false}, 'caller update properties must not be mutated');
  assert.equal(protectedTab.autoDiscardable, false);
  assert.equal(fixture.calls.update.length, 0, 'emulated-only update must not call native tabs.update');
  assert.deepEqual(fixture.calls.get, [1]);

  const callbackTab = await new Promise((resolve, reject) => {
    const returned = fixture.chrome.tabs.update(2, {autoDiscardable: false}, (value, error) =>
      error ? reject(error) : resolve(value));
    assert.equal(returned, undefined, 'callback form must keep the callback API return shape');
  });
  assert.equal(callbackTab.autoDiscardable, false);
  assert.equal(fixture.calls.update.length, 0);

  const restored = await new Promise((resolve, reject) => {
    fixture.chrome.tabs.update(2, {autoDiscardable: true}, (value, error) =>
      error ? reject(error) : resolve(value));
  });
  assert.equal(restored.autoDiscardable, true);
});

test('Firefox update proxy strips only emulated fields and preserves native update completion', async () => {
  const fixture = backgroundChrome();
  installFirefoxCompatibility(fixture.chrome, {popup: false});

  const properties = {active: true, autoDiscardable: false};
  const updated = await fixture.chrome.tabs.update(1, properties);

  assert.deepEqual(properties, {active: true, autoDiscardable: false});
  assert.deepEqual(fixture.calls.update, [{id: 1, properties: {active: true}}]);
  assert.equal(updated.active, true);
  assert.equal(updated.autoDiscardable, false);
});

test('Firefox query proxy supports emulated filters without mutating the query', async () => {
  const fixture = backgroundChrome();
  installFirefoxCompatibility(fixture.chrome, {popup: false});
  await fixture.chrome.tabs.update(1, {autoDiscardable: false});

  const protectedQuery = {autoDiscardable: false, status: 'complete'};
  const protectedTabs = await fixture.chrome.tabs.query(protectedQuery);
  assert.deepEqual(protectedQuery, {autoDiscardable: false, status: 'complete'});
  assert.deepEqual(fixture.calls.query.at(-1), {}, 'Firefox-native query must not receive emulated filters');
  assert.deepEqual(protectedTabs.map(tab => tab.id), [1]);
  assert.equal(protectedTabs[0].autoDiscardable, false);

  const discardableTabs = await new Promise((resolve, reject) => {
    const returned = fixture.chrome.tabs.query(
      {autoDiscardable: true, status: 'complete'},
      (value, error) => error ? reject(error) : resolve(value)
    );
    assert.equal(returned, undefined);
  });
  assert.deepEqual(discardableTabs.map(tab => tab.id), [3, 8]);
});

test('private Firefox popup uses a validated internal bridge, never getBackgroundPage', async () => {
  const fixture = backgroundChrome();
  const background = installFirefoxCompatibility(fixture.chrome, {popup: false});
  await background.ready();
  const popup = popupChrome(fixture);
  assert.equal(popup.chrome.runtime.getBackgroundPage, undefined);
  installFirefoxCompatibility(popup.chrome, {popup: true});

  const updated = await popup.chrome.tabs.update(1, {autoDiscardable: false});
  assert.equal(updated.autoDiscardable, false);
  const protectedTabs = await new Promise((resolve, reject) => {
    const returned = popup.chrome.tabs.query({active: false, currentWindow: true},
      (value, error) => error ? reject(error) : resolve(value));
    assert.equal(returned, undefined);
  });
  assert.equal(protectedTabs.find(tab => tab.id === 1).autoDiscardable, false);
  assert.equal(popup.localCalls, 0, 'popup must not bypass the background compatibility cache');

  let unauthorizedResponse = false;
  const [accepted] = fixture.messages.emit({
    method: 'firefox-tabs-compat',
    operation: 'query',
    queryInfo: {active: true, currentWindow: true}
  }, {
    id: fixture.runtime.id,
    url: fixture.runtime.getURL('/data/options/index.html')
  }, () => {
    unauthorizedResponse = true;
  });
  assert.equal(accepted, undefined);
  assert.equal(unauthorizedResponse, false, 'non-popup extension pages must not access the bridge');
});

test('production Firefox compatibility has no popup background-page dependency', () => {
  assert.doesNotMatch(compatibilitySource, /getBackgroundPage/);
  assert.match(compatibilitySource, /const BRIDGE_METHOD = 'firefox-tabs-compat'/);
  assert.match(compatibilitySource, /chromeApi\.storage\?\.session/);
  assert.match(compatibilitySource, /tabs\.onReplaced\?\.addListener/);
});

test('session-protected IDs hydrate serially, migrate on replacement, and prune on close', async () => {
  const session = createSession({'firefox.protectedTabIds': [1, 1]});
  const fixture = backgroundChrome({session});
  const state = installFirefoxCompatibility(fixture.chrome, {popup: false});
  await state.ready();
  assert.deepEqual((await fixture.chrome.tabs.query({autoDiscardable: false})).map(tab => tab.id), [1]);

  fixture.replaced.emit(8, 1);
  await state.ready();
  assert.deepEqual(session.values['firefox.protectedTabIds'], [8]);
  assert.deepEqual((await fixture.chrome.tabs.query({autoDiscardable: false})).map(tab => tab.id), [8]);

  fixture.removed.emit(8);
  await state.ready();
  assert.deepEqual(session.values['firefox.protectedTabIds'], []);

  await fixture.chrome.tabs.update(2, {autoDiscardable: false});
  const restarted = backgroundChrome({session});
  const restartedState = installFirefoxCompatibility(restarted.chrome, {popup: false});
  await restartedState.ready();
  assert.deepEqual((await restarted.chrome.tabs.query({autoDiscardable: false})).map(tab => tab.id), [2]);
});

test('replacement and close events serialize behind in-flight session hydration', async () => {
  const session = createSession({'firefox.protectedTabIds': [1]});
  const fixture = backgroundChrome({session});
  const state = installFirefoxCompatibility(fixture.chrome, {popup: false});
  fixture.replaced.emit(8, 1);
  fixture.removed.emit(8);
  await state.ready();
  assert.deepEqual(session.values['firefox.protectedTabIds'], []);
  assert.deepEqual(await fixture.chrome.tabs.query({autoDiscardable: false}), []);
});

test('Firefox native tab API failures reject promises and callbacks explicitly', async () => {
  const fixture = backgroundChrome();
  installFirefoxCompatibility(fixture.chrome, {popup: false});
  fixture.control.queryError = {code: 'QUERY_DENIED', message: 'query denied'};

  await assert.rejects(fixture.chrome.tabs.query({active: false}), error =>
    error.code === 'QUERY_DENIED' && /query denied/.test(error.message));
  const callbackFailure = await new Promise(resolve => {
    fixture.chrome.tabs.query({active: false}, (tabs, error) => resolve({error, tabs}));
  });
  assert.equal(callbackFailure.tabs, undefined);
  assert.equal(callbackFailure.error.code, 'QUERY_DENIED');
});

test('Firefox popup bridge propagates tab API failures and rejects malformed requests', async () => {
  const fixture = backgroundChrome();
  installFirefoxCompatibility(fixture.chrome, {popup: false});
  const popup = popupChrome(fixture);
  installFirefoxCompatibility(popup.chrome, {popup: true});
  fixture.control.queryError = {code: 'QUERY_DENIED', message: 'query denied'};

  await assert.rejects(popup.chrome.tabs.query({active: false, currentWindow: true}), error =>
    error.code === 'QUERY_DENIED');
  const callbackFailure = await new Promise(resolve => {
    popup.chrome.tabs.query({active: false, currentWindow: true},
      (tabs, error) => resolve({error, tabs}));
  });
  assert.equal(callbackFailure.tabs, undefined);
  assert.equal(callbackFailure.error.code, 'QUERY_DENIED');
  await assert.rejects(popup.chrome.tabs.query({url: '<all_urls>'}), /Invalid Firefox popup/);
  await assert.rejects(popup.chrome.tabs.update(1, {active: true}), /Invalid Firefox popup/);
});

test('malformed protected-tab session state fails closed', async () => {
  const fixture = backgroundChrome({
    session: createSession({'firefox.protectedTabIds': ['not-a-tab']})
  });
  const state = installFirefoxCompatibility(fixture.chrome, {popup: false});
  await assert.rejects(state.ready(), /session state is malformed/);
  await assert.rejects(fixture.chrome.tabs.query({active: false}), /session state is malformed/);
});

test('Firefox background proxies accept Promise-shaped native tab APIs', async () => {
  const source = new Map([[7, {id: 7, active: false, status: 'complete', windowId: 10}]]);
  const chromeApi = {
    runtime: {},
    storage: {session: createSession().area},
    tabs: {
      onRemoved: event(),
      onReplaced: event(),
      get(id) {
        return Promise.resolve({...source.get(id)});
      },
      query() {
        return Promise.resolve([...source.values()].map(tab => ({...tab})));
      },
      update(id, properties) {
        const next = {...source.get(id), ...properties};
        source.set(id, next);
        return Promise.resolve({...next});
      }
    }
  };
  installFirefoxCompatibility(chromeApi, {popup: false});

  const updated = await new Promise((resolve, reject) => {
    chromeApi.tabs.update(7, {active: true, autoDiscardable: false}, (value, error) =>
      error ? reject(error) : resolve(value));
  });
  assert.deepEqual(updated, {
    active: true,
    autoDiscardable: false,
    id: 7,
    status: 'complete',
    windowId: 10
  });
  assert.deepEqual(await chromeApi.tabs.query({autoDiscardable: false}), [updated]);
});
