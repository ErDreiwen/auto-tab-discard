import test from 'node:test';
import assert from 'node:assert/strict';

import {installFirefoxCompatibility} from '../v3/firefox/compatibility.mjs';

const event = () => {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    emit(...args) {
      for (const listener of listeners) {
        listener(...args);
      }
    }
  };
};

const backgroundChrome = () => {
  const removed = event();
  const source = new Map([
    [1, {id: 1, active: false, status: 'complete', title: 'one'}],
    [2, {id: 2, active: false, status: 'loading', title: 'two'}],
    [3, {id: 3, active: true, status: 'complete', title: 'three'}]
  ]);
  const calls = {
    get: [],
    query: [],
    update: []
  };
  const tabs = {
    onRemoved: removed,
    get(id, callback) {
      calls.get.push(id);
      queueMicrotask(() => callback(source.has(id) ? {...source.get(id)} : undefined));
    },
    query(queryInfo, callback) {
      calls.query.push({...queryInfo});
      queueMicrotask(() => callback([...source.values()].map(tab => ({...tab}))));
    },
    update(id, properties, callback) {
      calls.update.push({id, properties: {...properties}});
      const next = {...source.get(id), ...properties};
      source.set(id, next);
      queueMicrotask(() => callback({...next}));
    }
  };
  return {
    calls,
    chrome: {
      runtime: {},
      tabs
    },
    removed,
    source
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

  const callbackTab = await new Promise(resolve => {
    const returned = fixture.chrome.tabs.update(2, {autoDiscardable: false}, resolve);
    assert.equal(returned, undefined, 'callback form must keep the callback API return shape');
  });
  assert.equal(callbackTab.autoDiscardable, false);
  assert.equal(fixture.calls.update.length, 0);

  const restored = await new Promise(resolve => {
    fixture.chrome.tabs.update(2, {autoDiscardable: true}, resolve);
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

test('Firefox query proxy supports both autoDiscardable values and status without mutating the query', async () => {
  const fixture = backgroundChrome();
  installFirefoxCompatibility(fixture.chrome, {popup: false});
  await fixture.chrome.tabs.update(1, {autoDiscardable: false});

  const protectedQuery = {autoDiscardable: false, status: 'complete'};
  const protectedTabs = await fixture.chrome.tabs.query(protectedQuery);
  assert.deepEqual(protectedQuery, {autoDiscardable: false, status: 'complete'});
  assert.deepEqual(fixture.calls.query.at(-1), {}, 'Firefox-native query must not receive emulated filters');
  assert.deepEqual(protectedTabs.map(tab => tab.id), [1]);
  assert.equal(protectedTabs[0].autoDiscardable, false);

  const discardableTabs = await new Promise(resolve => {
    const returned = fixture.chrome.tabs.query({autoDiscardable: true, status: 'complete'}, resolve);
    assert.equal(returned, undefined);
  });
  assert.deepEqual(discardableTabs.map(tab => tab.id), [3]);
  assert.equal(discardableTabs[0].autoDiscardable, true);

  fixture.removed.emit(1);
  assert.deepEqual(await fixture.chrome.tabs.query({autoDiscardable: false}), []);
});

test('Firefox popup proxies forward Promise and callback calls through the shared background cache', async () => {
  const fixture = backgroundChrome();
  installFirefoxCompatibility(fixture.chrome, {popup: false});
  const background = {chrome: fixture.chrome};
  let localCalls = 0;
  const popup = {
    runtime: {
      getBackgroundPage(callback) {
        queueMicrotask(() => callback(background));
      }
    },
    tabs: {
      query() {
        localCalls += 1;
      },
      update() {
        localCalls += 1;
      }
    }
  };
  installFirefoxCompatibility(popup, {popup: true});

  const updated = await popup.tabs.update(1, {autoDiscardable: false});
  assert.equal(updated.autoDiscardable, false);
  const protectedTabs = await new Promise(resolve => {
    const returned = popup.tabs.query({autoDiscardable: false}, resolve);
    assert.equal(returned, undefined);
  });
  assert.deepEqual(protectedTabs.map(tab => tab.id), [1]);
  assert.equal(localCalls, 0, 'popup must not bypass the background compatibility cache');
});

test('Firefox popup proxy accepts Promise-shaped getBackgroundPage', async () => {
  const fixture = backgroundChrome();
  installFirefoxCompatibility(fixture.chrome, {popup: false});
  const popup = {
    runtime: {
      getBackgroundPage() {
        return Promise.resolve({chrome: fixture.chrome});
      }
    },
    tabs: {
      query() {},
      update() {}
    }
  };
  installFirefoxCompatibility(popup, {popup: true});

  const tabs = await popup.tabs.query({status: 'complete'});
  assert.deepEqual(tabs.map(tab => tab.id), [1, 3]);
});

test('Firefox background proxies accept Promise-shaped native tab APIs', async () => {
  const source = new Map([[7, {id: 7, active: false, status: 'complete'}]]);
  const chromeApi = {
    runtime: {},
    tabs: {
      onRemoved: event(),
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

  const updated = await new Promise(resolve => {
    chromeApi.tabs.update(7, {active: true, autoDiscardable: false}, resolve);
  });
  assert.deepEqual(updated, {id: 7, active: true, status: 'complete', autoDiscardable: false});
  assert.deepEqual(await chromeApi.tabs.query({autoDiscardable: false}), [updated]);
});
