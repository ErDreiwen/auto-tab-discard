import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {
  createHelperRegistry,
  STORAGE_KEY,
  TRANSACTIONS_KEY
} from '../v3/worker/core/helper-registry.mjs';
import {createBlankPreparer} from '../v3/worker/core/blank-helper.mjs';

const area = state => ({
  get(defaults, callback) {
    callback({...defaults, ...state});
  },
  remove(key, callback) {
    delete state[key];
    callback();
  },
  set(values, callback) {
    Object.assign(state, values);
    callback();
  }
});

const tab = (id, windowId, options = {}) => ({
  active: false,
  discarded: false,
  frozen: false,
  highlighted: false,
  id,
  index: id,
  status: 'complete',
  url: `https://tab-${id}.example/`,
  windowId,
  ...options
});

const browserHarness = (initial, {currentWindow = 1, queryHook} = {}) => {
  const state = {};
  const tabs = new Map(initial.map(value => [value.id, {...value}]));
  const activated = [];
  const queries = [];
  const removed = [];
  let sequence = 0;
  const activateTab = async id => {
    const target = tabs.get(id);
    if (!target) {
      throw Error('No tab with id');
    }
    for (const current of tabs.values()) {
      if (current.windowId === target.windowId) {
        current.active = current.id === id;
      }
    }
    activated.push(id);
    return {...target};
  };
  const registry = createHelperRegistry({
    activateTab,
    area: () => area(state),
    getTab: async id => tabs.get(id) && {...tabs.get(id)},
    removeTab: async id => {
      if (!tabs.has(id)) {
        throw Error('No tab with id');
      }
      removed.push(id);
      tabs.delete(id);
    },
    transactionId: () => `transaction-${++sequence}`
  });
  const read = async options => {
    queries.push({...options});
    await queryHook?.(options, tabs);
    let values = [...tabs.values()];
    if (Number.isInteger(options.windowId)) {
      values = values.filter(value => value.windowId === options.windowId);
    }
    if (options.currentWindow === false) {
      values = values.filter(value => value.windowId !== currentWindow);
    }
    if (typeof options.windowType === 'string') {
      values = values.filter(value => (value.windowType || 'normal') === options.windowType);
    }
    if (typeof options.active === 'boolean') {
      values = values.filter(value => value.active === options.active);
    }
    return values.map(value => ({...value}));
  };
  return {activateTab, activated, queries, read, registry, removed, state, tabs};
};

const helperCreator = (browser, {failAt = Infinity} = {}) => {
  const helpers = [];
  return {
    helpers,
    create: async (opener, options) => {
      if (helpers.length + 1 === failAt) {
        throw Error('injected helper creation failure');
      }
      const helper = tab(100 + helpers.length, opener.windowId, {
        active: options.active,
        index: opener.index,
        url: `chrome-extension://test/worker/plugins/blank/blank.html#nonce-${helpers.length}`
      });
      if (options.active) {
        for (const current of browser.tabs.values()) {
          if (current.windowId === opener.windowId) {
            current.active = false;
          }
        }
      }
      browser.tabs.set(helper.id, helper);
      await browser.registry.add(helper, {
        transactionId: options.transactionId,
        openerTabId: opener.id
      });
      helpers.push(helper);
      return {...helper};
    }
  };
};

test('helper registry persists commits and cleans expired or orphaned helpers', async () => {
  const state = {};
  const tabs = new Map([
    [1, {id: 1, windowId: 1}],
    [10, {id: 10, openerTabId: 1, windowId: 1}],
    [11, {id: 11, openerTabId: 99, windowId: 1}],
    [12, {id: 12, openerTabId: 1, windowId: 1}]
  ]);
  const removed = [];
  let clock = 1_000;
  globalThis.chrome = {runtime: {lastError: null}};
  try {
    const registry = createHelperRegistry({
      activateTab: async () => {},
      area: () => area(state),
      getTab: async id => tabs.get(id),
      now: () => clock,
      removeTab: async id => {
        removed.push(id);
        tabs.delete(id);
      }
    });
    registry.ttl = 100;
    await registry.add(tabs.get(10), {openerTabId: 1});
    await registry.add(tabs.get(11), {openerTabId: 99});
    await registry.add(tabs.get(12), {openerTabId: 1, ttl: 10});
    await registry.commit(10);
    clock += 20;

    assert.deepEqual(await registry.cleanup(), [11, 12]);
    assert.deepEqual(removed, [11, 12]);
    assert.equal(state[STORAGE_KEY][10].state, 'committed');

    clock += 200;
    assert.deepEqual(await registry.cleanup(), []);
    assert.equal(state[STORAGE_KEY][10].state, 'committed');
    tabs.delete(1);
    assert.deepEqual(await registry.cleanup(), [10]);
    assert.equal(state[STORAGE_KEY], undefined);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('startup recovery rolls back session-backed focus and partial helper state', async () => {
  globalThis.chrome = {runtime: {lastError: null}};
  try {
    const originalA = tab(1, 1, {active: false});
    const originalB = tab(2, 2, {active: false});
    const helper = tab(100, 1, {active: true});
    const keeper = tab(200, 2, {active: true});
    const browser = browserHarness([originalA, originalB, helper, keeper]);
    const id = await browser.registry.begin();
    await browser.registry.recordOriginal(id, originalA);
    await browser.registry.recordOriginal(id, originalB);
    await browser.registry.add(helper, {openerTabId: originalA.id, transactionId: id});

    assert.equal(stateHasPending(browser.state), true);
    assert.deepEqual(await browser.registry.cleanup(), [100]);
    assert.deepEqual(browser.removed, [100]);
    assert.deepEqual(browser.activated, [1, 2]);
    assert.equal(browser.tabs.get(1).active, true);
    assert.equal(browser.tabs.get(2).active, true);
    assert.equal(browser.state[STORAGE_KEY], undefined);
  }
  finally {
    delete globalThis.chrome;
  }
});

const stateHasPending = state => Object.keys(state[STORAGE_KEY]?.[TRANSACTIONS_KEY] || {}).length > 0;

test('direct preparation revalidates immediately before create and excludes existing helper pages', async () => {
  globalThis.chrome = {runtime: {lastError: null}};
  try {
    let windowReads = 0;
    const selected = tab(1, 1, {active: true, index: 0});
    const staleHelper = tab(2, 1, {
      index: 1,
      url: 'chrome-extension://test/worker/plugins/blank/blank.html'
    });
    const browser = browserHarness([selected, staleHelper], {
      queryHook(options, tabs) {
        if (options.windowId === 1 && ++windowReads === 3) {
          tabs.set(3, tab(3, 1, {index: 2}));
        }
      }
    });
    const creator = helperCreator(browser);
    const prepare = createBlankPreparer({
      activate: value => browser.activateTab(value.id),
      create: creator.create,
      isHelper: value => value.url?.includes('/worker/plugins/blank/blank.html'),
      read: browser.read,
      registry: browser.registry,
      sendMessage() {}
    });

    // The stale extension helper is never selected. A real keeper appears on
    // the first read of the final pre-create revalidation, so no tab is made.
    assert.equal(await prepare({menuItemId: 'discard-tab'}, selected), undefined);
    assert.deepEqual(creator.helpers, []);
    assert.equal(stateHasPending(browser.state), false);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('mixed keeper states are rejected and the shared predicate is rerun before activation', async () => {
  globalThis.chrome = {runtime: {lastError: null}};
  try {
    let windowReads = 0;
    const original = tab(10, 2, {active: true, index: 0});
    const browser = browserHarness([
      tab(1, 1, {active: true}),
      original,
      tab(11, 2, {discarded: true}),
      tab(12, 2, {frozen: true}),
      tab(13, 2, {highlighted: true}),
      tab(14, 2, {status: 'unloaded'}),
      tab(15, 2),
      tab(16, 2, {url: 'chrome-extension://test/worker/plugins/blank/blank.html'}),
      tab(17, 2)
    ], {
      queryHook(options, tabs) {
        if (options.windowId === 2 && ++windowReads === 2) {
          tabs.get(17).frozen = true;
          tabs.set(18, tab(18, 2));
        }
      }
    });
    const creator = helperCreator(browser);
    const prepare = createBlankPreparer({
      activate: value => browser.activateTab(value.id),
      create: creator.create,
      inProgress: id => id === 15,
      isHelper: value => value.id === 16,
      read: browser.read,
      registry: browser.registry,
      sendMessage() {}
    });

    const transaction = await prepare({menuItemId: 'discard-tabs'}, tab(1, 1));
    assert.deepEqual(browser.activated, [18]);
    assert.deepEqual(creator.helpers, []);
    await transaction.commit({succeeded: [{tab: original}]});
    assert.equal(browser.tabs.get(18).active, true);
    assert.equal(stateHasPending(browser.state), false);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('discard-other-windows prepares only same-privacy normal windows outside the selected window', async () => {
  globalThis.chrome = {runtime: {lastError: null}};
  try {
    const selected = tab(1, 1, {active: true});
    const backgroundOriginal = tab(10, 2, {active: true});
    const backgroundKeeper = tab(11, 2);
    const minimizedOriginal = tab(20, 3, {active: true});
    const incognitoOriginal = tab(30, 4, {active: true, incognito: true});
    const incognitoKeeper = tab(31, 4, {incognito: true});
    const popupOriginal = tab(40, 5, {active: true, windowType: 'popup'});
    const browser = browserHarness([
      selected,
      tab(2, 1),
      backgroundOriginal,
      backgroundKeeper,
      minimizedOriginal,
      incognitoOriginal,
      incognitoKeeper,
      popupOriginal
    ]);
    const creator = helperCreator(browser);
    const prepare = createBlankPreparer({
      activate: value => browser.activateTab(value.id),
      create: creator.create,
      read: browser.read,
      registry: browser.registry,
      sendMessage() {}
    });

    const transaction = await prepare({menuItemId: 'discard-other-windows'}, selected);

    assert.deepEqual(browser.queries[0], {active: true, windowType: 'normal'});
    assert.deepEqual(browser.activated, [backgroundKeeper.id]);
    assert.deepEqual(creator.helpers.map(value => value.windowId), [minimizedOriginal.windowId]);
    assert.equal(browser.tabs.get(selected.id).active, true);
    assert.equal(browser.tabs.get(incognitoOriginal.id).active, true);
    assert.equal(browser.tabs.get(popupOriginal.id).active, true);
    assert.equal([...browser.tabs.values()].some(value =>
      value.windowId === incognitoOriginal.windowId && value.id >= 100), false);
    assert.equal([...browser.tabs.values()].some(value =>
      value.windowId === popupOriginal.windowId && value.id >= 100), false);

    await transaction.commit({
      succeeded: [{tab: backgroundOriginal}, {tab: minimizedOriginal}]
    });
    assert.equal(stateHasPending(browser.state), false);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('discard-tabs keeps selected, incognito, and popup active tabs outside helper preparation', async () => {
  globalThis.chrome = {runtime: {lastError: null}};
  try {
    const selected = tab(1, 1, {active: true});
    const selectedKeeper = tab(2, 1);
    const otherOriginal = tab(10, 2, {active: true});
    const incognitoOriginal = tab(20, 3, {active: true, incognito: true});
    const popupOriginal = tab(30, 4, {active: true, windowType: 'popup'});
    const browser = browserHarness([
      selected,
      selectedKeeper,
      otherOriginal,
      incognitoOriginal,
      tab(21, 3, {incognito: true}),
      popupOriginal
    ]);
    const creator = helperCreator(browser);
    const prepare = createBlankPreparer({
      activate: value => browser.activateTab(value.id),
      create: creator.create,
      read: browser.read,
      registry: browser.registry,
      sendMessage() {}
    });

    const transaction = await prepare({menuItemId: 'discard-tabs'}, selected);

    assert.deepEqual(browser.queries[0], {active: true, windowType: 'normal'});
    assert.deepEqual(browser.activated, []);
    assert.deepEqual(creator.helpers.map(value => value.windowId), [otherOriginal.windowId]);
    assert.equal(browser.tabs.get(selected.id).active, true);
    assert.equal(browser.tabs.get(selectedKeeper.id).active, false);
    assert.equal(browser.tabs.get(incognitoOriginal.id).active, true);
    assert.equal(browser.tabs.get(popupOriginal.id).active, true);

    await transaction.commit({succeeded: [{tab: otherOriginal}]});
    assert.equal(stateHasPending(browser.state), false);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('partial creation failure closes helpers and restores every affected window', async () => {
  globalThis.chrome = {runtime: {lastError: null}};
  try {
    const first = tab(10, 2, {active: true});
    const second = tab(20, 3, {active: true});
    const browser = browserHarness([tab(1, 1, {active: true}), first, second]);
    const creator = helperCreator(browser, {failAt: 2});
    const prepare = createBlankPreparer({
      activate: value => browser.activateTab(value.id),
      create: creator.create,
      read: browser.read,
      registry: browser.registry,
      sendMessage() {}
    });

    await assert.rejects(
      prepare({menuItemId: 'discard-tabs'}, tab(1, 1)),
      /injected helper creation failure/
    );
    assert.deepEqual(browser.removed, [100]);
    assert.deepEqual(browser.activated, [10, 20]);
    assert.equal(browser.tabs.get(10).active, true);
    assert.equal(browser.tabs.get(20).active, true);
    assert.equal(stateHasPending(browser.state), false);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('commit retains only helpers whose opener succeeded and restores protected or zero-target windows', async () => {
  globalThis.chrome = {runtime: {lastError: null}};
  try {
    const first = tab(10, 2, {active: true});
    const second = tab(20, 3, {active: true});
    const browser = browserHarness([tab(1, 1, {active: true}), first, second]);
    const creator = helperCreator(browser);
    const prepare = createBlankPreparer({
      activate: value => browser.activateTab(value.id),
      create: creator.create,
      read: browser.read,
      registry: browser.registry,
      sendMessage() {}
    });

    const transaction = await prepare({menuItemId: 'discard-tabs'}, tab(1, 1));
    assert.equal(creator.helpers.length, 2);
    await transaction.commit({
      protected: [{tab: second}],
      succeeded: [{tab: first}]
    });

    assert.equal(browser.tabs.has(100), true);
    assert.equal(browser.state[STORAGE_KEY][100].state, 'committed');
    assert.equal(browser.tabs.has(101), false);
    assert.deepEqual(browser.removed, [101]);
    assert.deepEqual(browser.activated, [20]);
    assert.equal(browser.tabs.get(20).active, true);
    assert.equal(stateHasPending(browser.state), false);

    // A second command that reaches commit without one effective target uses
    // the same rollback semantics instead of leaving a focus artifact.
    browser.tabs.set(30, tab(30, 4, {active: true}));
    const zero = await prepare({menuItemId: 'discard-tabs'}, tab(1, 1));
    await zero.commit({succeeded: []});
    assert.equal(browser.tabs.get(30).active, true);
    assert.equal(stateHasPending(browser.state), false);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('issue 20: popup cancellation rolls back every helper and restores deterministic focus', async () => {
  globalThis.chrome = {runtime: {lastError: null}};
  try {
    const selected = tab(1, 1, {active: true});
    const otherOriginal = tab(20, 2, {active: true});
    const browser = browserHarness([selected, otherOriginal]);
    const creator = helperCreator(browser);
    const prepare = createBlankPreparer({
      activate: value => browser.activateTab(value.id),
      create: creator.create,
      read: browser.read,
      registry: browser.registry,
      sendMessage() {}
    });

    const transaction = await prepare({menuItemId: 'discard-tabs'}, selected);
    assert.equal(creator.helpers.length, 1);
    assert.equal(browser.tabs.get(otherOriginal.id).active, false);
    assert.equal(browser.tabs.get(creator.helpers[0].id).active, true);
    assert.ok(browser.state[STORAGE_KEY]?.[TRANSACTIONS_KEY]?.['transaction-1']);

    const cancellation = Error('popup command was cancelled');
    cancellation.code = 'POPUP_CANCELLED';
    await transaction.rollback(cancellation);

    assert.deepEqual(browser.removed, [creator.helpers[0].id]);
    assert.equal(browser.tabs.has(creator.helpers[0].id), false);
    assert.equal(browser.tabs.get(otherOriginal.id).active, true);
    assert.deepEqual(browser.activated, [otherOriginal.id]);
    assert.equal(stateHasPending(browser.state), false);
    assert.equal(browser.state[STORAGE_KEY], undefined,
      'cancellation must leave neither helper records nor a transaction envelope');

    // Rollback is idempotent when both a command catch boundary and later
    // cancellation cleanup observe the same terminal result.
    await transaction.rollback(cancellation);
    assert.deepEqual(browser.removed, [creator.helpers[0].id]);
    assert.deepEqual(browser.activated, [otherOriginal.id]);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('commit keeps a helper when Edge replaces its successful opener id', async () => {
  globalThis.chrome = {runtime: {lastError: null}};
  try {
    const opener = tab(40, 5, {active: true});
    const browser = browserHarness([tab(1, 1, {active: true}), opener]);
    const creator = helperCreator(browser);
    const lineage = new Map();
    const prepare = createBlankPreparer({
      activate: value => browser.activateTab(value.id),
      create: creator.create,
      read: browser.read,
      registry: browser.registry,
      resolveId: id => lineage.get(id) || id,
      sendMessage() {}
    });

    const transaction = await prepare({menuItemId: 'discard-tabs'}, tab(1, 1));
    assert.equal(creator.helpers.length, 1);
    lineage.set(opener.id, 140);
    browser.tabs.delete(opener.id);
    browser.tabs.set(140, tab(140, 5, {active: false, discarded: true, status: 'unloaded'}));
    await transaction.commit({succeeded: [{tab: {id: 140}}]});

    assert.equal(browser.tabs.has(100), true);
    assert.equal(browser.state[STORAGE_KEY][100].state, 'committed');
    assert.deepEqual(browser.removed, []);
    assert.deepEqual(browser.activated, []);
    assert.equal(stateHasPending(browser.state), false);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('menu wraps only discard and release execution in the generic helper transaction', async () => {
  const source = await readFile(new URL('../v3/worker/menu.mjs', import.meta.url), 'utf8');
  assert.match(source, /pluginTransaction = await interrupts\['before-menu-click'\]/);
  assert.match(source, /pluginTransaction\?\.commit\?\.\(result\)/);
  assert.match(source, /pluginTransaction\?\.rollback\?\.\(error\)/);
  assert.match(source, /return runCommandTransaction\(\(\) => runDirectDiscardCommand\(\{/);
  assert.match(source, /return runCommandTransaction\(\(\) => runScopedCommand\(\{/);
  assert.doesNotMatch(source, /runCommandTransaction\(\(\) => chrome\.tabs\.(?:create|update)/);
});
