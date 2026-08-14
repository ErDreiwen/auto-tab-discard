#!/usr/bin/env node

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import process from 'node:process';
import {pathToFileURL} from 'node:url';

import {
  runDirectDiscardCommand,
  runScopedCommand
} from '../v3/worker/core/command-scope.mjs';

const DEFAULT_SEED = 0x50524f44;
const DEFAULT_SCENARIOS = 24;
const MAX_SCENARIOS = 128;
// ownership.mjs debounces replacement-lineage reconciliation for 250 ms. The
// harness must keep its browser mock alive until that callback has entered the
// native serializer, then queue one explicit reconcile behind it.
const OWNERSHIP_LINEAGE_DRAIN_DELAY = 300;

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const legacyOwnershipFixture = JSON.parse(await readFile(
  new URL('../tests/fixtures/migrations/ownership-legacy.json', import.meta.url),
  'utf8'
));

const createEvent = () => {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    emit(...args) {
      for (const listener of [...listeners]) {
        listener(...args.map(clone));
      }
    },
    removeListener(listener) {
      listeners.delete(listener);
    }
  };
};

const xorshift32 = seed => {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
};

const shuffled = (values, random) => {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = random() % (index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
};

const waitFor = async (predicate, label) => {
  // This is only a harness-observation deadline. Keep it comfortably above
  // production's async storage/native turns so host load cannot turn a valid
  // schedule into a timing test, while still bounding a lost callback.
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(Boolean(predicate()), true, `${label} did not reach its production boundary`);
};

const createChromeHarness = () => {
  const events = Object.fromEntries([
    'activated', 'attached', 'created', 'moved', 'removed', 'replaced', 'updated'
  ].map(name => [name, createEvent()]));
  const storageChanged = createEvent();
  const liveTabs = new Map();
  const replacements = new Map();
  const sessionState = {
    // This is deliberately the pre-v2 single-root format. Importing the real
    // ownership worker must migrate and reconcile it before any mutation runs.
    __discardOwnership: {
      ...Object.fromEntries(legacyOwnershipFixture.cases.map(item => [
        item.tab.id,
        clone(item.marker)
      ])),
      999999: {
        attemptId: 'dead-worker-missing-attempt',
        state: 'pending',
        updatedAt: 1
      }
    }
  };
  const localState = {
    favicon: false,
    prepends: '',
    'simultaneous-jobs': 4
  };
  const nativePending = new Map();
  const heldNativeIds = new Set();
  const nativeCalls = [];
  let maximumNativeInFlight = 0;
  let nativeInFlight = 0;
  let storageFailures = 0;
  let storageFailureMode = 'before';

  const resolveId = id => {
    const seen = new Set();
    while (Number.isInteger(replacements.get(id)) && !seen.has(id)) {
      seen.add(id);
      id = replacements.get(id);
    }
    return id;
  };

  const storageWrite = (apply, callback) => {
    if (storageFailures > 0) {
      storageFailures -= 1;
      if (storageFailureMode === 'after') {
        apply();
      }
      chrome.runtime.lastError = {message: `injected ${storageFailureMode}-apply session storage failure`};
      callback();
      chrome.runtime.lastError = null;
      return;
    }
    apply();
    callback();
  };

  const area = state => ({
    clear(callback) {
      storageWrite(() => {
        for (const key of Object.keys(state)) {
          delete state[key];
        }
      }, callback);
    },
    get(query, callback) {
      if (query === null) {
        callback(clone(state));
        return;
      }
      if (Array.isArray(query)) {
        callback(Object.fromEntries(query.filter(key => key in state).map(key => [key, clone(state[key])])));
        return;
      }
      if (typeof query === 'string') {
        callback(query in state ? {[query]: clone(state[query])} : {});
        return;
      }
      callback({...clone(query || {}), ...clone(state)});
    },
    remove(keys, callback) {
      storageWrite(() => {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          delete state[key];
        }
      }, callback);
    },
    set(values, callback) {
      storageWrite(() => Object.assign(state, clone(values)), callback);
    }
  });

  const session = area(sessionState);
  const local = area(localState);
  const managed = {
    get(query, callback) {
      callback({});
    }
  };

  const tabFor = id => clone(liveTabs.get(resolveId(id)));
  const queryTabs = options => [...liveTabs.values()].filter(tab => {
    if (typeof options?.active === 'boolean' && tab.active !== options.active) {
      return false;
    }
    if (Number.isInteger(options?.windowId) && tab.windowId !== options.windowId) {
      return false;
    }
    if (options?.currentWindow === false && tab.windowId === 1) {
      return false;
    }
    return options?.windowType === undefined || options.windowType === 'normal';
  }).map(clone);

  const settleNative = callId => {
    const pending = nativePending.get(callId);
    assert.ok(pending, `native discard ${callId} is not pending`);
    nativePending.delete(callId);
    const currentId = resolveId(callId);
    let tab = liveTabs.get(currentId);
    if (tab && tab.active !== true) {
      tab = {...tab, discarded: true, frozen: false, status: 'unloaded'};
      liveTabs.set(currentId, tab);
      events.updated.emit(currentId, {
        discarded: true,
        frozen: false,
        status: 'unloaded'
      }, tab);
    }
    nativeInFlight -= 1;
    pending.callback?.(clone(tab));
    pending.resolve(clone(tab));
  };

  const chromeApi = {
    runtime: {
      lastError: null
    },
    scripting: {
      executeScript() {
        throw Error('the production conformance fixture disables visual markers');
      }
    },
    storage: {
      local,
      managed,
      onChanged: storageChanged,
      session
    },
    tabs: {
      discard(id, callback) {
        nativeCalls.push(id);
        nativeInFlight += 1;
        maximumNativeInFlight = Math.max(maximumNativeInFlight, nativeInFlight);
        if (heldNativeIds.delete(id)) {
          return new Promise(resolve => {
            nativePending.set(id, {callback, resolve});
          });
        }
        return new Promise(resolve => {
          nativePending.set(id, {callback, resolve});
          // Let every microtask admitted by the production queue publish its
          // browser call before this turn settles the native boundaries.
          setTimeout(() => settleNative(id), 0);
        });
      },
      get(id, callback) {
        callback(tabFor(id));
      },
      onActivated: events.activated,
      onAttached: events.attached,
      onCreated: events.created,
      onMoved: events.moved,
      onRemoved: events.removed,
      onReplaced: events.replaced,
      onUpdated: events.updated,
      query(options, callback) {
        callback(queryTabs(options || {}));
      },
      reload(id, options, callback) {
        const currentId = resolveId(id);
        const current = liveTabs.get(currentId);
        if (current) {
          const loaded = {...current, discarded: false, frozen: false, status: 'complete'};
          liveTabs.set(currentId, loaded);
          events.updated.emit(currentId, {
            discarded: false,
            frozen: false,
            status: 'complete'
          }, loaded);
        }
        callback?.();
      },
      sendMessage(id, message, callback) {
        callback?.();
      }
    },
    windows: {
      get(id, callback) {
        callback({id, incognito: false, type: 'normal'});
      }
    }
  };

  const add = (tab, {emit = true} = {}) => {
    const value = {
      active: false,
      discarded: false,
      frozen: false,
      incognito: false,
      index: tab.id,
      status: 'complete',
      url: `https://production-conformance.invalid/${tab.id}`,
      windowId: 1,
      ...tab
    };
    liveTabs.set(value.id, value);
    if (emit) {
      events.created.emit(value);
    }
    return clone(value);
  };

  const activate = id => {
    id = resolveId(id);
    for (const [candidateId, tab] of liveTabs) {
      liveTabs.set(candidateId, {...tab, active: candidateId === id});
    }
    events.activated.emit({tabId: id, windowId: liveTabs.get(id)?.windowId});
    return tabFor(id);
  };

  const close = id => {
    id = resolveId(id);
    const existed = liveTabs.delete(id);
    if (existed) {
      events.removed.emit(id, {isWindowClosing: false, windowId: 1});
    }
  };

  const replace = (removedId, addedId) => {
    const removed = liveTabs.get(resolveId(removedId));
    assert.ok(removed, `replacement predecessor ${removedId} is missing`);
    liveTabs.delete(resolveId(removedId));
    const successor = {...removed, id: addedId, index: addedId};
    liveTabs.set(addedId, successor);
    replacements.set(removedId, addedId);
    events.replaced.emit(addedId, removedId);
    return clone(successor);
  };

  return {
    activate,
    add,
    chrome: chromeApi,
    close,
    failStorage(count, mode) {
      storageFailures = count;
      storageFailureMode = mode;
    },
    get maximumNativeInFlight() {
      return maximumNativeInFlight;
    },
    get nativeCalls() {
      return [...nativeCalls];
    },
    get nativeInFlight() {
      return nativeInFlight;
    },
    get nativePending() {
      return nativePending;
    },
    holdNative(id) {
      heldNativeIds.add(id);
    },
    liveTabs,
    queryTabs,
    replace,
    resolveId,
    sessionState,
    settleNative,
    tabFor
  };
};

const assertProductionInvariants = async ({discard, harness, inprogress, ownership}) => {
  const state = await ownership.snapshot();
  const liveIds = new Set(harness.liveTabs.keys());
  const attemptIds = [];

  for (const [key, marker] of Object.entries(state)) {
    const id = Number(key);
    assert.equal(liveIds.has(id), true, `cleanup invariant: marker ${id} has no live tab`);
    const tab = harness.liveTabs.get(id);
    assert.equal(tab?.discarded === true, true,
      `cleanup invariant: loaded tab ${id} retained ${marker?.state || 'unknown'} ownership`);
    if (typeof marker?.attemptId === 'string') {
      attemptIds.push(marker.attemptId);
    }
  }

  assert.equal(new Set(attemptIds).size, attemptIds.length,
    'unique ownership invariant: one nonce was attached to multiple live identities');
  for (const tab of harness.liveTabs.values()) {
    if (tab.active === true) {
      assert.equal(tab.discarded, false, `active safety invariant: tab ${tab.id} is discarded`);
    }
  }

  const diagnostics = await ownership.diagnostics();
  assert.equal(diagnostics.attempts, 0, 'bounded operation invariant: an attempt leaked');
  assert.equal(diagnostics.observedDiscards, 0, 'bounded operation invariant: an observation leaked');
  assert.equal(diagnostics.replacements, 0, 'cleanup invariant: replacement lineage leaked');
  assert.equal(diagnostics.takeoverAttempts, 0, 'bounded operation invariant: a takeover attempt leaked');
  assert.ok(diagnostics.generations <= liveIds.size,
    `bounded operation invariant: ${diagnostics.generations} generations exceed ${liveIds.size} live tabs`);
  assert.equal(discard.count, 0, 'bounded operation invariant: the discard counter leaked');
  assert.equal(discard.tabs.length, 0, 'bounded operation invariant: the discard queue leaked');
  assert.equal(discard.takeoverSnapshot().length, 0,
    'bounded operation invariant: the native/takeover registry leaked');
  assert.equal(inprogress.size, 0, 'bounded operation invariant: an in-progress id leaked');
  assert.equal(harness.nativePending.size, 0,
    'bounded operation invariant: a mocked browser-native completion leaked');
  assert.equal(harness.nativeInFlight, 0,
    'bounded operation invariant: a mocked browser-native call remained in flight');
};

const runProductionLifecycleConformance = async ({
  scenarioCount = DEFAULT_SCENARIOS,
  seed = DEFAULT_SEED
} = {}) => {
  assert.ok(Number.isSafeInteger(seed), 'seed must be a safe integer');
  assert.ok(Number.isSafeInteger(scenarioCount) && scenarioCount > 0 && scenarioCount <= MAX_SCENARIOS,
    `scenarioCount must be between 1 and ${MAX_SCENARIOS}`);

  const originalChrome = globalThis.chrome;
  const harness = createChromeHarness();
  globalThis.chrome = harness.chrome;
  let ownership;
  const coverage = Object.fromEntries([
    'activation', 'cleanup', 'close', 'command-scope', 'replacement', 'restart', 'storage-failure'
  ].map(name => [name, 0]));

  try {
    const [{discard, inprogress}, ownershipModule] = await Promise.all([
      import('../v3/worker/core/discard.mjs'),
      import('../v3/worker/core/ownership.mjs')
    ]);
    ownership = ownershipModule.ownership;
    // Shorter than browser defaults, but long enough that this conformance
    // gate tests lifecycle ordering rather than scheduler speed under CI load.
    discard.getTimeout = 2000;
    discard.nativeSettleTimeout = 2000;
    discard.nativeStableDwell = 0;
    discard.nativeTimeout = 2000;
    discard.prepareTimeout = 2000;
    discard.takeoverFenceTimeout = 2000;
    discard.takeoverPoll = 0;

    harness.add({id: 1, active: true}, {emit: false});
    for (const item of legacyOwnershipFixture.cases) {
      harness.add({
        ...item.tab,
        status: item.tab.discarded === true ? 'unloaded' : 'complete'
      }, {emit: false});
    }

    // Simulate the first turn of a restarted worker against durable state left
    // by an older worker. The real persistence migration and reconciliation
    // must retain the live sleeper and remove the missing pending operation.
    assert.notEqual(await ownership.start(1, 0), false);
    const restarted = await ownership.snapshot();
    for (const item of legacyOwnershipFixture.cases) {
      if (item.expected === null) {
        assert.equal(restarted[item.tab.id], undefined, item.id);
        continue;
      }
      for (const [key, value] of Object.entries(item.expected)) {
        assert.deepEqual(restarted[item.tab.id]?.[key], value, `${item.id}: ${key}`);
      }
    }
    assert.equal(restarted[999999], undefined);
    coverage.restart += 1;

    // Direct selected/group commands have a separate keeper path. Exercise its
    // real active guard once so the campaign is not relying only on query's
    // active:false filter.
    const noKeeper = harness.add({id: 3, active: false});
    harness.activate(noKeeper.id);
    const nativeBeforeNoKeeper = harness.nativeCalls.length;
    const blocked = await runDirectDiscardCommand({
      activate: async () => assert.fail('a one-tab window has no safe keeper'),
      allTabs: [harness.tabFor(noKeeper.id)],
      command: 'discard-tab',
      commitScope: async () => ({
        allTabs: [harness.tabFor(noKeeper.id)],
        selected: harness.tabFor(noKeeper.id),
        targets: [harness.tabFor(noKeeper.id)],
        valid: true
      }),
      discard,
      hasBlockingNativeIntent: id => ownership.hasBlockingNativeIntent(id),
      inProgress: () => false,
      notifyNoKeeper() {},
      refresh: async tab => harness.tabFor(tab.id),
      resolveFresh: tab => ownership.resolveFresh(tab),
      selected: harness.tabFor(noKeeper.id),
      shiftKey: true,
      suspendedPolicy: async () => true,
      takeover: tab => discard.takeover(tab, {manual: true}),
      targets: [harness.tabFor(noKeeper.id)]
    });
    assert.equal(blocked.blocked, true);
    assert.equal(harness.nativeCalls.length, nativeBeforeNoKeeper);
    harness.close(noKeeper.id);
    harness.activate(1);
    await ownership.reconcile();
    coverage.activation += 1;
    coverage['command-scope'] += 1;

    const random = xorshift32(seed);
    const actions = [
      'activation', 'close', 'command-scope', 'replacement', 'storage-failure'
    ];

    for (let scenario = 0; scenario < scenarioCount; scenario += 1) {
      const scenarioSeed = random();
      const scenarioRandom = xorshift32(scenarioSeed);
      const base = 1000 + scenario * 20;

      for (const action of shuffled(actions, scenarioRandom)) {
        try {
          if (action === 'command-scope') {
            // The configured production limit is four. Six targets force the
            // real discard queue to admit a bounded wave and then drain it.
            const targets = Array.from({length: 6}, (_, index) =>
              harness.add({id: base + 10 + index}));
            const result = await runScopedCommand({
              cancelTakeover: tab => discard.cancelTakeover(tab.id),
              check: async tab => discard(tab),
              command: 'discard-tabs',
              discard,
              hasBlockingNativeIntent: id => ownership.hasBlockingNativeIntent(id),
              query: async options => {
                assert.deepEqual(options, {active: false, windowType: 'normal'});
                return targets.map(tab => harness.tabFor(tab.id));
              },
              refresh: async tab => harness.tabFor(tab.id),
              reload: async () => assert.fail('a discard command cannot reload'),
              resolveFresh: tab => ownership.resolveFresh(tab),
              selected: harness.tabFor(1),
              shiftKey: true,
              suspendedPolicy: async () => true,
              takeover: tab => discard.takeover(tab, {manual: true})
            });
            assert.deepEqual(
              result.succeeded.map(entry => entry.tab?.id).sort((a, b) => a - b),
              targets.map(tab => tab.id)
            );
            for (const target of targets) {
              assert.equal((await ownership.status(target.id)).marker?.source, 'self');
              harness.close(target.id);
            }
            await ownership.reconcile();
          }
          else if (action === 'replacement') {
            const predecessor = harness.add({id: base + 3});
            const successorId = base + 4;
            harness.holdNative(predecessor.id);
            const operation = discard.perform(predecessor);
            await waitFor(() => harness.nativePending.has(predecessor.id), 'replacement native call');
            harness.replace(predecessor.id, successorId);
            harness.settleNative(predecessor.id);
            const result = await operation;
            assert.equal(result.status, 'succeeded', result.reason);
            assert.equal(result.tab.id, successorId);
            const state = await ownership.snapshot();
            assert.equal(state[predecessor.id], undefined);
            assert.equal(state[successorId]?.source, 'self');
            assert.equal(ownership.resolveId(predecessor.id), successorId);
            harness.close(successorId);
            await ownership.reconcile();
          }
          else if (action === 'activation') {
            const target = harness.add({id: base + 5});
            harness.holdNative(target.id);
            const operation = discard.perform(target);
            await waitFor(() => harness.nativePending.has(target.id), 'activation native call');
            harness.activate(target.id);
            harness.settleNative(target.id);
            const result = await operation;
            assert.notEqual(result.status, 'succeeded');
            assert.equal(harness.tabFor(target.id).discarded, false);
            assert.equal((await ownership.status(target.id)).marker, undefined);
            harness.close(target.id);
            harness.activate(1);
            await ownership.reconcile();
          }
          else if (action === 'close') {
            const target = harness.add({id: base + 7});
            harness.holdNative(target.id);
            const operation = discard.perform(target);
            await waitFor(() => harness.nativePending.has(target.id), 'close native call');
            harness.close(target.id);
            harness.settleNative(target.id);
            const result = await operation;
            assert.notEqual(result.status, 'succeeded');
            await ownership.reconcile();
            assert.equal((await ownership.snapshot())[target.id], undefined);
          }
          else if (action === 'storage-failure') {
            const target = harness.add({
              id: base + 9,
              discarded: true,
              status: 'unloaded'
            }, {emit: false});
            const nativeBefore = harness.nativeCalls.length;
            harness.failStorage(32, scenario % 2 ? 'after' : 'before');
            const result = await runScopedCommand({
              cancelTakeover: async () => assert.fail('unknown ownership cannot be released'),
              check: async () => assert.fail('unknown ownership cannot enter the checked discard path'),
              command: 'discard-tabs',
              discard: async () => assert.fail('unknown ownership cannot invoke native discard'),
              hasBlockingNativeIntent: id => ownership.hasBlockingNativeIntent(id),
              query: async () => [harness.tabFor(target.id)],
              refresh: async tab => harness.tabFor(tab.id),
              reload: async () => assert.fail('unknown ownership cannot reload'),
              resolveFresh: tab => ownership.resolveFresh(tab),
              selected: harness.tabFor(1),
              shiftKey: false,
              suspendedPolicy: async () => true,
              takeover: async () => assert.fail('unknown ownership cannot start takeover')
            }).catch(error => error.result);
            assert.equal(harness.nativeCalls.length, nativeBefore);
            assert.ok(result?.failed?.length || result?.unknownOwnership?.length ||
              result?.protected?.length,
            'storage failure must remain a visible failed, unknown, or protected outcome');
            harness.failStorage(0, 'before');
            await ownership.reconcile();
            assert.equal((await ownership.status(target.id)).marker?.source, 'claimed');
            harness.close(target.id);
            await ownership.reconcile();
          }
          coverage[action] += 1;
          coverage.cleanup += 1;
          await assertProductionInvariants({discard, harness, inprogress, ownership});
        }
        catch (error) {
          error.productionConformance = {
            action,
            scenario,
            scenarioSeed,
            seed
          };
          throw error;
        }
      }
    }

    assert.deepEqual(Object.fromEntries(Object.entries(coverage).map(([name, count]) => [name, count > 0])), {
      activation: true,
      cleanup: true,
      close: true,
      'command-scope': true,
      replacement: true,
      restart: true,
      'storage-failure': true
    });
    assert.ok(harness.maximumNativeInFlight <= 4,
      `bounded operation invariant: ${harness.maximumNativeInFlight} native calls overlapped`);

    return {
      coverage,
      invariants: ['active-safety', 'unique-ownership', 'bounded-operation', 'cleanup'],
      maximumNativeInFlight: harness.maximumNativeInFlight,
      nativeCalls: harness.nativeCalls.length,
      ok: true,
      productionModules: [
        'v3/worker/core/command-scope.mjs',
        'v3/worker/core/discard.mjs',
        'v3/worker/core/ownership.mjs'
      ],
      scenarioCount,
      seed
    };
  }
  finally {
    if (ownership) {
      await new Promise(resolve => setTimeout(resolve, OWNERSHIP_LINEAGE_DRAIN_DELAY));
      // The debounce callback does not expose its Promise. Queueing this call
      // on the same production serializer proves that callback and its storage
      // work have settled before the mock browser is removed.
      await ownership.reconcile();
    }
    if (originalChrome === undefined) {
      delete globalThis.chrome;
    }
    else {
      globalThis.chrome = originalChrome;
    }
  }
};

const parseOptions = argv => {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw Error('Usage: production-lifecycle-conformance.mjs [--seed N] [--scenarios N]');
    }
    options[name.slice(2)] = Number(value);
  }
  return {
    scenarioCount: options.scenarios ?? DEFAULT_SCENARIOS,
    seed: options.seed ?? DEFAULT_SEED
  };
};

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  try {
    const report = await runProductionLifecycleConformance(parseOptions(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  catch (error) {
    process.stderr.write(`${JSON.stringify({
      error: error?.message || String(error),
      ok: false,
      productionConformance: error?.productionConformance,
      stack: error?.stack
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

export {
  DEFAULT_SCENARIOS,
  DEFAULT_SEED,
  runProductionLifecycleConformance
};
