import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const event = () => ({
  addListener() {},
  removeListener() {}
});

const storageArea = state => ({
  clear(callback) {
    for (const key of Object.keys(state)) delete state[key];
    callback?.();
  },
  get(defaults, callback) {
    const value = Array.isArray(defaults) ? Object.fromEntries(defaults
      .filter(key => Object.hasOwn(state, key)).map(key => [key, state[key]])) :
      typeof defaults === 'string' ? {[defaults]: state[defaults]} :
        {...(defaults || {}), ...state};
    callback?.(structuredClone(value));
    return Promise.resolve(structuredClone(value));
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

const createBrowser = () => {
  const state = {
    local: {
      './plugins/blank/core.js': false,
      './plugins/focus/core.js': false,
      './plugins/force/core.js': false,
      './plugins/new/core.js': false,
      './plugins/next/core.js': false,
      './plugins/previous/core.js': false,
      './plugins/trash/core.js': false,
      './plugins/unloaded/core.js': false,
      './plugins/youtube/core.js': false
    },
    metadata: new Map(),
    metadataFailures: new Set(),
    metadataHangs: new Set(),
    metadataCalls: [],
    queryCalls: [],
    session: {},
    tabs: []
  };
  const changed = event();
  const managed = storageArea({});
  const local = storageArea(state.local);
  const session = storageArea(state.session);
  const query = (options, callback) => {
    state.queryCalls.push(structuredClone(options));
    let tabs = state.tabs.map(tab => ({...tab}));
    if (options.url) {
      tabs = tabs.filter(tab => /^https?:/i.test(tab.url || ''));
    }
    for (const key of ['active', 'audible', 'discarded', 'pinned']) {
      if (typeof options[key] === 'boolean') {
        tabs = tabs.filter(tab => tab[key] === options[key]);
      }
    }
    if (options.lastFocusedWindow === true) {
      tabs = tabs.filter(tab => tab.lastFocusedWindow === true);
    }
    callback?.(tabs);
    return Promise.resolve(tabs);
  };
  const chrome = {
    action: {
      setBadgeBackgroundColor() {},
      setBadgeText() {},
      setIcon() {},
      setTitle(options, callback) { callback?.(); }
    },
    alarms: {
      clear(name, callback) { callback?.(true); return Promise.resolve(true); },
      create() {},
      get(name, callback) { callback?.(); },
      getAll(callback) { callback?.([]); },
      onAlarm: event()
    },
    commands: {onCommand: event()},
    contextMenus: {onClicked: event()},
    idle: {
      IdleState: {IDLE: 'idle'},
      onStateChanged: event(),
      queryState(timeout, callback) { callback('idle'); }
    },
    notifications: {create() {}},
    runtime: {
      getManifest: () => ({name: 'Targeted number test'}),
      getURL: path => `chrome-extension://test/${path}`,
      id: 'number-targeted-test',
      lastError: null,
      onInstalled: event(),
      onMessage: event(),
      onStartup: event(),
      sendMessage() { return Promise.resolve(); }
    },
    scripting: {
      executeScript(details) {
        const id = details.target?.tabId;
        if (details.files?.includes('/data/inject/meta.js')) {
          state.metadataCalls.push(id);
          if (state.metadataHangs.has(id)) {
            return new Promise(() => {});
          }
          if (state.metadataFailures.has(id)) {
            return Promise.reject(Error(`metadata denied for ${id}`));
          }
          const value = state.metadata.get(id);
          return Promise.resolve(value === null ? [] : [{
            documentId: `document-${id}`,
            frameId: 0,
            result: value || {
              audible: false,
              forms: false,
              paused: false,
              permission: false,
              ready: true,
              time: 0
            }
          }]);
        }
        if (typeof details.func === 'function') {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      }
    },
    storage: {local, managed, onChanged: changed, session},
    tabs: {
      create(options, callback) { callback?.({id: 9000, ...options}); },
      discard(id, callback) { callback?.(state.tabs.find(tab => tab.id === id)); },
      get(id, callback) { callback?.(state.tabs.find(tab => tab.id === id)); },
      onActivated: event(),
      onAttached: event(),
      onCreated: event(),
      onMoved: event(),
      onRemoved: event(),
      onReplaced: event(),
      onUpdated: event(),
      query,
      reload(id, options, callback) { callback?.(); },
      remove(id, callback) { callback?.(); },
      sendMessage() { return Promise.resolve(); },
      update(id, changes, callback) {
        const tab = state.tabs.find(tab => tab.id === id);
        if (tab) Object.assign(tab, changes);
        callback?.(tab);
        return Promise.resolve(tab);
      }
    },
    windows: {
      WINDOW_ID_NONE: -1,
      get(id, callback) { callback?.({focused: true, id}); },
      onCreated: event(),
      onFocusChanged: event(),
      update(id, changes, callback) { callback?.({id, ...changes}); }
    }
  };
  return {chrome, state};
};

const target = (id, changes = {}) => ({
  active: false,
  audible: false,
  autoDiscardable: true,
  discarded: false,
  frozen: false,
  id,
  lastAccessed: 0,
  pinned: false,
  splitViewId: -1,
  status: 'complete',
  url: `https://target-${id}.example/`,
  windowId: 1,
  ...changes
});

const safeOptions = Object.freeze({
  audio: false,
  battery: false,
  'exclude-active': false,
  form: false,
  'icon-update': false,
  idle: false,
  'ignore.meta.data': true,
  'ignore.ready.state': false,
  'max.single.discard': 0,
  'memory-enabled': false,
  mode: 'time-based',
  'notification.permission': false,
  number: 0,
  online: false,
  paused: false,
  period: 0,
  pinned: false,
  'split-view': false,
  whitelist: [],
  'whitelist-url': []
});

test('targeted checks retain every restricted and excluded target with a precise terminal reason', async t => {
  const browser = createBrowser();
  globalThis.chrome = browser.chrome;
  t.after(() => delete globalThis.chrome);
  const {number, pluginFilters} = await import(
    `../v3/worker/modes/number.mjs?targeted-contract=${Date.now()}`
  );
  const {ownership} = await import('../v3/worker/core/ownership.mjs');

  const run = async (tabs, options = {}, configure = () => {}) => {
    browser.state.tabs = tabs.map(tab => ({...tab}));
    browser.state.metadata.clear();
    browser.state.metadataFailures.clear();
    browser.state.metadataHangs.clear();
    browser.state.queryCalls.length = 0;
    configure(browser.state);
    const result = await number.check(tabs, {...safeOptions, ...options}, 'test/targeted');
    const outcomes = [...result.succeeded, ...result.failed, ...result.protected, ...result.unsupported];
    assert.deepEqual(outcomes.map(entry => entry.tab.id).toSorted((a, b) => a - b),
      tabs.map(tab => tab.id).toSorted((a, b) => a - b));
    assert.equal(outcomes.every(entry => entry.reason || result.succeeded.includes(entry)), true);
    assert.deepEqual(browser.state.queryCalls[0], {}, 'explicit scope must not use the renderer URL mask');
    return result;
  };

  const restricted = await run([
    target(1, {url: 'file:///restricted.html'}),
    target(2, {url: 'chrome://version/'}),
    target(3, {url: 'mailto:user@example.test'})
  ]);
  assert.deepEqual(restricted.protected.map(entry => entry.tab.id), [1, 2]);
  assert.deepEqual(restricted.unsupported.map(entry => entry.tab.id), [3]);
  assert.match(restricted.protected[0].reason, /renderer/i);
  assert.match(restricted.unsupported[0].reason, /unsupported tab scheme/i);

  const missing = await run([target(4)], {}, state => {
    state.tabs = [];
  });
  assert.match(missing.unsupported[0].reason, /no longer available/i);

  const early = await run([
    target(10, {active: true}),
    target(11, {pinned: true}),
    target(12, {audible: true}),
    target(13, {discarded: true})
  ], {audio: true, 'exclude-active': true, pinned: true});
  assert.deepEqual(early.protected.map(entry => entry.tab.id), [10, 11, 12, 13]);
  assert.match(early.protected.find(entry => entry.tab.id === 10).reason, /active/i);
  assert.match(early.protected.find(entry => entry.tab.id === 11).reason, /pinned/i);
  assert.match(early.protected.find(entry => entry.tab.id === 12).reason, /audible/i);
  assert.match(early.protected.find(entry => entry.tab.id === 13).reason, /already discarded/i);

  pluginFilters.targetedTest = {prepare: async () => {}, check: tab => tab.id !== 20};
  const policy = await run([
    target(20),
    target(21, {url: 'https://whitelist.example/'}),
    target(22, {splitViewId: 7}),
    target(23, {active: true, lastFocusedWindow: true, splitViewId: 7})
  ], {
    'exclude-active': false,
    'split-view': true,
    whitelist: ['whitelist.example']
  });
  delete pluginFilters.targetedTest;
  assert.match(policy.protected.find(entry => entry.tab.id === 20).reason, /plug-in filter/i);
  assert.match(policy.protected.find(entry => entry.tab.id === 21).reason, /whitelist/i);
  assert.match(policy.protected.find(entry => entry.tab.id === 22).reason, /split view/i);
  assert.match(policy.protected.find(entry => entry.tab.id === 23).reason, /split view/i);

  // Edge can report an accepted direct native discard as inactive with both
  // physical flags false. The automatic/targeted metadata path must consult
  // the durable intent before any executeScript call reaches that renderer.
  const transitional = target(24, {discarded: false, frozen: false});
  browser.state.tabs = [transitional];
  browser.state.metadataCalls.length = 0;
  assert.ok(await ownership.beginDirectNative(transitional));
  const blocked = await number.check(
    [transitional],
    {...safeOptions, 'max.single.discard': 1},
    'test/direct-native-transition'
  );
  assert.deepEqual(browser.state.metadataCalls, []);
  assert.deepEqual(blocked.protected.map(entry => entry.tab.id), [transitional.id]);
  assert.match(blocked.protected[0].reason, /direct native discard.*settling/i);
  await ownership.invalidate(transitional.id);

  // A peer metadata probe can keep the bounded scan open after this tab's
  // renderer lease has already ended. If a direct native discard settles in
  // that window, the completed metadata is stale: candidate processing must
  // refresh physical/ownership state before doing any later renderer or
  // native operation, and it must leave the new self marker intact.
  const stale = target(25);
  const held = target(26);
  browser.state.tabs = [stale, held].map(tab => ({...tab}));
  browser.state.metadata.clear();
  browser.state.metadataCalls.length = 0;
  browser.state.metadata.set(stale.id, {
    audible: false,
    forms: false,
    paused: false,
    permission: false,
    ready: true,
    time: 0
  });
  browser.state.metadata.set(held.id, {
    audible: false,
    forms: false,
    paused: false,
    permission: false,
    ready: false,
    time: 0
  });

  const originalExecuteScript = browser.chrome.scripting.executeScript;
  const originalNativeDiscard = browser.chrome.tabs.discard;
  let releaseHeldMetadata;
  const heldMetadataGate = new Promise(resolve => releaseHeldMetadata = resolve);
  let staleMetadataReturned;
  const staleMetadataDone = new Promise(resolve => staleMetadataReturned = resolve);
  let heldMetadataStarted;
  const heldMetadataReady = new Promise(resolve => heldMetadataStarted = resolve);
  let ownershipSettled = false;
  let staleRendererCallsAfterOwnership = 0;
  let staleNativeCallsAfterOwnership = 0;

  browser.chrome.scripting.executeScript = details => {
    const id = details.target?.tabId;
    if (id === stale.id && ownershipSettled) {
      staleRendererCallsAfterOwnership += 1;
    }
    if (details.files?.includes('/data/inject/meta.js') && id === held.id) {
      heldMetadataStarted();
      return heldMetadataGate.then(() => originalExecuteScript(details));
    }
    const operation = originalExecuteScript(details);
    if (details.files?.includes('/data/inject/meta.js') && id === stale.id) {
      return Promise.resolve(operation).then(value => {
        staleMetadataReturned();
        return value;
      });
    }
    return operation;
  };
  browser.chrome.tabs.discard = (id, ...args) => {
    if (id === stale.id && ownershipSettled) {
      staleNativeCallsAfterOwnership += 1;
    }
    return originalNativeDiscard(id, ...args);
  };

  let staleScan;
  try {
    staleScan = number.check(
      [stale, held],
      {...safeOptions, 'max.single.discard': 2},
      'test/stale-metadata-after-direct-native'
    );
    await Promise.all([staleMetadataDone, heldMetadataReady]);
    // Let frameMetadata.collect finish and release A's renderer guard while B
    // remains blocked inside its own metadata call.
    await new Promise(resolve => setImmediate(resolve));

    const attemptId = await ownership.beginDirectNative(stale);
    assert.equal(typeof attemptId, 'string');
    const physical = {...stale, discarded: true, status: 'unloaded'};
    browser.state.tabs = [physical, {...held}];
    assert.equal(await ownership.finish(physical, attemptId, 'self', {
      allowClaimed: false,
      directNative: true,
      visual: {
        complete: false,
        favicon: false,
        physicalOnly: true,
        repair: false,
        title: false
      }
    }), true);
    ownershipSettled = true;

    releaseHeldMetadata();
    const result = await staleScan;
    assert.equal(result.scan.completed, 2);
    assert.equal(staleRendererCallsAfterOwnership, 0);
    assert.equal(staleNativeCallsAfterOwnership, 0);
    const retained = (await ownership.status(stale.id)).marker;
    assert.equal(retained?.source, 'self');
    assert.equal(retained?.state, 'owned');
    assert.equal(retained?.visual?.physicalOnly, true);
  }
  finally {
    releaseHeldMetadata?.();
    await staleScan?.catch(() => {});
    browser.chrome.scripting.executeScript = originalExecuteScript;
    browser.chrome.tabs.discard = originalNativeDiscard;
    await ownership.invalidate(stale.id);
  }
});

test('targeted renderer decisions expose metadata, policy, age, and limit reasons without fallback skips', async t => {
  const browser = createBrowser();
  globalThis.chrome = browser.chrome;
  t.after(() => delete globalThis.chrome);
  const {number} = await import(
    `../v3/worker/modes/number.mjs?targeted-metadata=${Date.now()}`
  );

  const runOne = async (tab, options, metadata, configure = () => {}) => {
    browser.state.tabs = [{...tab}];
    browser.state.metadata.clear();
    browser.state.metadataFailures.clear();
    browser.state.metadataHangs.clear();
    browser.state.metadata.set(tab.id, metadata);
    configure(browser.state);
    const warn = console.warn;
    console.warn = () => {};
    let result;
    try {
      result = await number.check([tab], {...safeOptions, ...options}, 'test/metadata');
    }
    finally {
      console.warn = warn;
    }
    const outcomes = [...result.succeeded, ...result.failed, ...result.protected, ...result.unsupported];
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].tab.id, tab.id);
    assert.doesNotMatch(outcomes[0].reason || '', /ended without an authoritative/i);
    return outcomes[0];
  };
  const meta = changes => ({
    audible: false,
    forms: false,
    paused: false,
    permission: false,
    ready: true,
    time: 0,
    ...changes
  });

  assert.match((await runOne(target(30), {}, meta({ready: false}))).reason, /not ready/i);
  assert.match((await runOne(target(31), {audio: true}, meta({audible: true}))).reason,
    /audio|picture-in-picture/i);
  assert.match((await runOne(target(32), {paused: true}, meta({paused: true}))).reason, /paused/i);
  assert.match((await runOne(target(33), {form: true}, meta({forms: true}))).reason, /form/i);
  assert.match((await runOne(target(34), {'notification.permission': true},
    meta({permission: true}))).reason, /notification/i);
  assert.match((await runOne(target(35, {autoDiscardable: false}), {}, meta())).reason,
    /not automatically discardable/i);
  assert.match((await runOne(target(36), {period: 60}, meta({time: Date.now()}))).reason,
    /younger|age/i);
  assert.match((await runOne(target(37), {}, meta(), state => {
    state.metadataFailures.add(37);
  })).reason, /metadata scan failed/i);
  assert.match((await runOne(target(38), {}, null)).reason, /no inspectable document/i);
  assert.match((await runOne(target(39), {'max.single.discard': 0}, meta())).reason,
    /discard limit/i);

  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) =>
    nativeSetTimeout(callback, Math.min(Number(delay) || 0, 2), ...args);
  try {
    assert.match((await runOne(target(40), {}, meta(), state => {
      state.metadataHangs.add(40);
    })).reason, /metadata scan deadline/i);
  }
  finally {
    globalThis.setTimeout = nativeSetTimeout;
  }
});

test('automatic scans retain their renderer URL optimization', async t => {
  const source = await readFile(new URL('../v3/worker/modes/number.mjs', import.meta.url), 'utf8');
  assert.match(source, /renderer metadata scan deadline was reached before the tab could be inspected/);
  assert.match(source, /if \(targeted\)[\s\S]*?const live = await query\(\{\}\)/);
  assert.match(source, /else \{\s*tbs = await query\(options\);\s*\}/);
  assert.match(source, /const options = \{\s*url: '\*:\/\/\*\/\*'/);

  const browser = createBrowser();
  globalThis.chrome = browser.chrome;
  t.after(() => delete globalThis.chrome);
  const {number} = await import(
    `../v3/worker/modes/number.mjs?automatic-query=${Date.now()}`
  );
  browser.state.tabs = [target(50)];
  await number.check(undefined, {...safeOptions, number: 1}, 'test/automatic');
  assert.equal(browser.state.queryCalls[0].url, '*://*/*');
});
