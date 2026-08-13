import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runDirectDiscardCommand,
  runScopedCommand,
  scopeTakeoverTabs
} from '../v3/worker/core/command-scope.mjs';
import {tabsForGroupCommand} from '../v3/worker/core/group.mjs';
import {resetExtensionState} from '../v3/worker/core/reset.mjs';

test('keeps genuine takeovers explicit, bounded, and free of reload feedback loops', async () => {
  const sessionState = {
    __discardOwnership: {
      1: {
        state: 'owned',
        source: 'claimed',
        attemptId: null,
        updatedAt: 1
      }
    }
  };
  const localState = {};
  const liveTabs = new Map([
    [1, {
      id: 1,
      windowId: 1,
      index: 2,
      active: false,
      discarded: true,
      url: 'https://external.example/'
    }]
  ]);
  const listeners = {
    activated: [],
    attached: [],
    created: [],
    removed: [],
    replaced: [],
    moved: [],
    updated: [],
    windowFocus: []
  };
  const calls = [];
  const contested = new Set();
  const heldNativeIds = new Set();
  const heldNativeResolvers = new Map();
  const nativeRejectIds = new Set();
  const nativeRejectAfterReplacementIds = new Set();
  const alarmListeners = [];
  const scheduledAlarms = new Map();
  let finishNative;
  let finishNativePhysical;
  let nativeImmediate = false;
  let nativeCallbackBeforePhysical = false;
  let ignoredStops = 1;
  let nativeFinalStatus = 'unloaded';
  let nativeReplacementId;
  let nativeWakeBeforeCallback = false;
  let missingPostDiscardGets = 0;
  let wakeOnPostDiscardGet = 0;
  let reloadMode = 'normal';
  let finishReloadCallback;
  let stopMode = 'normal';
  let finalFrameStopCalls = 0;
  let activateOnStopId;
  let afterActiveQuerySnapshot;
  let afterExtensionActivation;
  let holdActivationCallbackId;
  let activationCallbackReached;
  let releaseHeldActivation;
  let holdMarkerPreparation;
  let markerPreparationReached;
  let delayedFinalPreparation;
  let holdGetId;
  let releaseHeldGet;
  let holdLocalStorage = false;
  let localStorageReached;
  let releaseHeldLocalStorage;
  let markerRollbacks = 0;
  let pulseDocumentState = {
    focused: false,
    mediaActive: false,
    mutedMediaActive: false,
    pictureInPicture: false,
    visibility: 'hidden'
  };
  const preparationCalls = new Map();
  const delayedLoadingTimers = new Set();

  const clone = value => value && JSON.parse(JSON.stringify(value));
  const waitForNative = async label => {
    const deadline = Date.now() + 1000;
    while (typeof finishNative !== 'function' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(typeof finishNative, 'function', `${label}: native discard boundary was not reached`);
  };
  const event = name => ({
    addListener(listener) {
      listeners[name].push(listener);
    },
    removeListener(listener) {
      const index = listeners[name].indexOf(listener);
      if (index !== -1) {
        listeners[name].splice(index, 1);
      }
    }
  });
  const emitUpdated = (id, changeInfo) => {
    const tab = clone(liveTabs.get(id));
    listeners.updated.forEach(listener => listener(id, changeInfo, tab));
  };
  const activateLiveTab = id => {
    const tab = liveTabs.get(id);
    assert.ok(tab, `cannot activate missing test tab ${id}`);
    for (const candidate of liveTabs.values()) {
      if (candidate.windowId === tab.windowId) {
        candidate.active = false;
      }
    }
    tab.active = true;
    if (tab.frozen === true) {
      tab.frozen = false;
      emitUpdated(id, {frozen: false});
    }
    listeners.activated.forEach(listener => listener({tabId: id, windowId: tab.windowId}));
  };

  globalThis.chrome = {
    alarms: {
      create(name, info) {
        scheduledAlarms.set(name, {...info});
      },
      clear(name, callback) {
        const existed = scheduledAlarms.delete(name);
        callback(existed);
      },
      onAlarm: {
        addListener(listener) {
          alarmListeners.push(listener);
        }
      }
    },
    runtime: {
      lastError: null
    },
    scripting: {
      executeScript({target, func, args}) {
        if (func?.name === 'inspectDocumentPulseState') {
          return Promise.resolve([{result: clone(pulseDocumentState)}]);
        }
        if (func?.name === 'restoreDocumentMarker') {
          markerRollbacks += 1;
          const tab = liveTabs.get(target.tabId);
          if (tab) {
            tab.title = 'test';
            tab.visualMarked = false;
            tab.faviconMarked = false;
          }
          return Promise.resolve([{result: {restored: true}}]);
        }
        calls.push(`stop:${target.tabId}`);
        const tab = liveTabs.get(target.tabId);
        const preparationCall = (preparationCalls.get(target.tabId) || 0) + 1;
        preparationCalls.set(target.tabId, preparationCall);
        if (delayedFinalPreparation?.id === target.tabId && preparationCall === 2) {
          const delay = delayedFinalPreparation.delay;
          delayedFinalPreparation = undefined;
          if (tab) {
            tab.status = 'complete';
            tab.title = `${args?.[0]?.prepends || ''} test`.trim();
            tab.visualMarked = Boolean(args?.[0]?.prepends);
            tab.faviconMarked = args?.[0]?.favicon === true;
            emitUpdated(target.tabId, {status: 'complete', title: tab.title});
          }
          return new Promise(resolve => setTimeout(resolve, delay, [{result: {
            faviconApplied: true,
            stopped: true,
            title: tab?.title,
            titleApplied: true
          }}]));
        }
        if (holdMarkerPreparation?.id === target.tabId &&
            holdMarkerPreparation.call === preparationCall) {
          holdMarkerPreparation = undefined;
          if (tab) {
            tab.status = 'complete';
            tab.title = '💤 test';
            tab.visualMarked = true;
            tab.faviconMarked = args?.[0]?.favicon === true;
            emitUpdated(target.tabId, {status: 'complete', title: tab.title});
          }
          markerPreparationReached?.();
          markerPreparationReached = undefined;
          return new Promise(() => {});
        }
        if (activateOnStopId === target.tabId) {
          activateOnStopId = undefined;
          activateLiveTab(target.tabId);
        }
        if (stopMode === 'pending') {
          return new Promise(() => {});
        }
        if (stopMode === 'pending-once') {
          stopMode = 'normal';
          return new Promise(() => {});
        }
        if (stopMode === 'reject') {
          return Promise.reject(Error('injection rejected'));
        }
        if (stopMode === 'frame-removed-once') {
          stopMode = 'normal';
          return Promise.reject(Error('Frame with ID 0 was removed.'));
        }
        if (stopMode === 'frame-not-ready-once') {
          stopMode = 'normal';
          return Promise.reject(Error('Frame with ID 0 is not ready.'));
        }
        if (stopMode === 'no-frame-colon-once') {
          stopMode = 'normal';
          return Promise.reject(Error('No frame with ID: 0'));
        }
        if (stopMode === 'no-frame-tab-once') {
          stopMode = 'normal';
          return Promise.reject(Error('No frame with id 0 in tab with id 123'));
        }
        if (stopMode === 'frame-removed-final') {
          finalFrameStopCalls += 1;
          if (finalFrameStopCalls === 2) {
            stopMode = 'normal';
            return Promise.reject(Error('Frame with ID 0 was removed.'));
          }
        }
        if (stopMode === 'frame-removed-always') {
          return Promise.reject(Error('Frame with ID 0 was removed.'));
        }
        if (stopMode === 'error-page') {
          return Promise.reject(Error('Frame with ID 0 is showing error page.'));
        }
        if (stopMode === 'activate') {
          tab.active = true;
          return Promise.resolve([{result: {stopped: true, title: '💤 test'}}]);
        }
        if (stopMode === 'invalid-status') {
          tab.status = 'unloaded';
          emitUpdated(target.tabId, {status: 'unloaded'});
          return Promise.resolve([{result: {stopped: true, title: '💤 test'}}]);
        }
        if (ignoredStops > 0) {
          ignoredStops -= 1;
        }
        else if (tab) {
          tab.status = 'complete';
          emitUpdated(target.tabId, {status: 'complete'});
        }
        if (tab && tab.status === 'complete' && args?.[0]?.prepends) {
          tab.title = '💤 test';
          tab.visualMarked = true;
        }
        if (tab && tab.status === 'complete' && args?.[0]?.favicon === true) {
          tab.faviconMarked = true;
        }
        return Promise.resolve([{result: {stopped: true, title: '💤 test'}}]);
      }
    },
    storage: {
      managed: {
        get(defaults, callback) {
          callback(defaults);
        }
      },
      local: {
        get(defaults, callback) {
          if (holdLocalStorage) {
            holdLocalStorage = false;
            localStorageReached?.();
            localStorageReached = undefined;
            releaseHeldLocalStorage = () => {
              releaseHeldLocalStorage = undefined;
              callback({...defaults, ...localState});
            };
            return;
          }
          callback({...defaults, ...localState});
        }
      },
      session: {
        get(defaults, callback) {
          callback({...defaults, ...sessionState});
        },
        set(values, callback) {
          Object.assign(sessionState, values);
          callback();
        },
        remove(key, callback) {
          delete sessionState[key];
          callback();
        }
      },
      onChanged: {
        addListener() {}
      }
    },
    windows: {
      get(id, callback) {
        callback({focused: true, id});
      },
      onFocusChanged: event('windowFocus')
    },
    tabs: {
      query(options, callback) {
        const result = [...liveTabs.values()].filter(tab => {
          return (!('discarded' in options) || tab.discarded === options.discarded) &&
            (!('active' in options) || tab.active === options.active) &&
            (!('windowId' in options) || tab.windowId === options.windowId);
        }).map(clone);
        if (options.active === true && afterActiveQuerySnapshot) {
          const hook = afterActiveQuerySnapshot;
          afterActiveQuerySnapshot = undefined;
          hook(options, result);
        }
        callback(result);
      },
      get(id, callback) {
        const tab = liveTabs.get(id);
        if (id === holdGetId) {
          holdGetId = undefined;
          releaseHeldGet = () => {
            releaseHeldGet = undefined;
            callback(clone(tab));
          };
          return;
        }
        if (missingPostDiscardGets > 0 && tab?.discarded === true) {
          missingPostDiscardGets -= 1;
          callback(undefined);
          return;
        }
        if (wakeOnPostDiscardGet > 0 && tab?.discarded === true) {
          wakeOnPostDiscardGet -= 1;
          if (wakeOnPostDiscardGet === 0) {
            tab.active = true;
            tab.discarded = false;
            tab.status = 'complete';
            emitUpdated(id, {discarded: false, status: 'complete'});
          }
        }
        callback(clone(tab));
      },
      update(id, changes, callback) {
        const tab = liveTabs.get(id);
        if (changes.active === true) {
          calls.push(`activate:${id}`);
          activateLiveTab(id);
          if (afterExtensionActivation) {
            const hook = afterExtensionActivation;
            afterExtensionActivation = undefined;
            hook(id);
          }
          if (holdActivationCallbackId === id) {
            holdActivationCallbackId = undefined;
            activationCallbackReached?.();
            activationCallbackReached = undefined;
            releaseHeldActivation = () => {
              releaseHeldActivation = undefined;
              callback(clone(tab));
            };
            return;
          }
        }
        callback(clone(tab));
      },
      reload(id, options, callback) {
        calls.push(`reload:${id}:${options.bypassCache}`);
        const tab = liveTabs.get(id);
        if (reloadMode === 'callback-gap') {
          finishReloadCallback = callback;
          const timer = setTimeout(() => {
            delayedLoadingTimers.delete(timer);
            tab.discarded = false;
            tab.frozen = false;
            tab.status = 'loading';
            emitUpdated(id, {discarded: false, status: 'loading'});
          }, 5);
          delayedLoadingTimers.add(timer);
          return;
        }
        tab.discarded = false;
        tab.frozen = false;
        tab.status = reloadMode === 'delayed-loading' ? 'complete' : 'loading';
        emitUpdated(id, {
          discarded: false,
          ...(reloadMode === 'normal' && {status: 'loading'})
        });
        callback();
        if (reloadMode === 'delayed-loading') {
          const timer = setTimeout(() => {
            delayedLoadingTimers.delete(timer);
            tab.status = 'loading';
            emitUpdated(id, {status: 'loading'});
          }, 5);
          delayedLoadingTimers.add(timer);
        }
      },
      discard(id) {
        calls.push(`discard:${id}`);
        const tab = liveTabs.get(id);
        if (contested.has(id)) {
          tab.discarded = true;
          emitUpdated(id, {discarded: true});
          return Promise.reject(Error('tab is already discarded'));
        }
        return new Promise((resolve, reject) => {
          const completeNative = () => {
            heldNativeResolvers.delete(id);
            finishNative = undefined;
            if (nativeRejectIds.delete(id)) {
              reject(Error('native discard rejected after callback delay'));
              return;
            }
            const completePhysical = () => {
              finishNativePhysical = undefined;
              tab.discarded = true;
              tab.status = nativeFinalStatus;
              let resultTab = tab;
              if (Number.isInteger(nativeReplacementId)) {
                const replacementId = nativeReplacementId;
                nativeReplacementId = undefined;
                resultTab = {...tab, id: replacementId};
                liveTabs.delete(id);
                liveTabs.set(replacementId, resultTab);
                listeners.replaced.forEach(listener => listener(replacementId, id));
                emitUpdated(replacementId, {discarded: true, status: nativeFinalStatus});
              }
              else {
                emitUpdated(id, {discarded: true, status: nativeFinalStatus});
              }
              if (nativeWakeBeforeCallback) {
                nativeWakeBeforeCallback = false;
                resultTab.active = true;
                resultTab.discarded = false;
                resultTab.status = 'complete';
                emitUpdated(resultTab.id, {discarded: false, status: 'complete'});
              }
              return clone(resultTab);
            };
            if (nativeCallbackBeforePhysical) {
              nativeCallbackBeforePhysical = false;
              finishNativePhysical = completePhysical;
              resolve(clone(tab));
              return;
            }
            const result = completePhysical();
            if (nativeRejectAfterReplacementIds.delete(id)) {
              reject(Error('native discard rejected after an external replacement'));
              return;
            }
            resolve(result);
          };
          if (heldNativeIds.has(id)) {
            heldNativeResolvers.set(id, completeNative);
          }
          else {
            finishNative = completeNative;
          }
          if (nativeImmediate && !heldNativeIds.has(id)) {
            queueMicrotask(completeNative);
          }
        });
      },
      onActivated: event('activated'),
      onUpdated: event('updated'),
      onCreated: event('created'),
      onAttached: event('attached'),
      onMoved: event('moved'),
      onRemoved: event('removed'),
      onReplaced: event('replaced')
    }
  };

  try {
    const [{discard}, {ownership}, {createReleaseHelper}] = await Promise.all([
      import('../v3/worker/core/discard.mjs'),
      import('../v3/worker/core/ownership.mjs'),
      import('../v3/worker/core/release.mjs')
    ]);
    const hasTakeover = id => discard.takeoverSnapshot().some(job => job.id === id);
    discard.nativeTimeout = 200;
    discard.getTimeout = 100;
    discard.takeoverTimeout = 200;
    discard.takeoverPoll = 0;
    discard.takeoverRetries = 1;
    discard.quiesceDwell = 0;
    discard.reloadStartGrace = 0;
    const phaseTabs = {
      get: chrome.tabs.get.bind(chrome.tabs),
      reload(id, options, callback) {
        calls.push('release:' + id + ':' + options.bypassCache);
        const tab = liveTabs.get(id);
        tab.active = false;
        tab.discarded = false;
        tab.frozen = false;
        tab.status = 'complete';
        tab.title = 'test';
        tab.visualMarked = false;
        tab.faviconMarked = false;
        emitUpdated(id, {
          discarded: false,
          frozen: false,
          status: 'complete',
          title: tab.title
        });
        callback(clone(tab));
      }
    };
    const phaseReleaseHelper = createReleaseHelper({
      cancelTakeover: id => discard.cancelTakeover(id),
      getStatus: id => ownership.status(id),
      invalidate: id => ownership.invalidate(id),
      resolveId: id => ownership.resolveId(id),
      runtime: () => chrome.runtime,
      tabs: () => phaseTabs,
      takeoverSnapshot: () => discard.takeoverSnapshot()
    });
    phaseReleaseHelper.releaseTab.interval = 0;
    phaseReleaseHelper.releaseTab.polls = 20;
    phaseReleaseHelper.releaseTab.stableReads = 2;
    const releasePhaseTarget = async (target, queried = []) => {
      const released = await phaseReleaseHelper.releaseMatching(queried, tab =>
        ownership.resolveId(tab.id) === ownership.resolveId(target.id));
      assert.equal(released.length, 1, 'release phase target must resolve exactly once');
      return released[0];
    };
    const unrelatedActive = {
      id: 199,
      windowId: 199,
      index: 0,
      active: true,
      discarded: false,
      frozen: false,
      status: 'complete',
      title: 'unrelated active tab'
    };
    liveTabs.set(unrelatedActive.id, unrelatedActive);
    const assertReleaseInvariant = async (target, expectedActiveId = unrelatedActive.id) => {
      const live = liveTabs.get(ownership.resolveId(target.id));
      assert.ok(live, 'released target remains live');
      assert.equal(live.active, false);
      assert.equal(live.discarded, false);
      assert.equal(live.frozen, false);
      assert.equal(live.status, 'complete');
      assert.notEqual(live.visualMarked, true);
      assert.notEqual(live.faviconMarked, true);
      assert.equal(String(live.title || '').startsWith('💤'), false);
      assert.equal((await ownership.status(live.id)).marker, undefined);
      assert.equal(discard.waitForTakeover(live.id), undefined);
      assert.equal(liveTabs.get(expectedActiveId)?.active, true);
    };

    // Legacy builds may already have bookkeeping-only adopted markers. A
    // normal manual command must upgrade those just like fresh external claims.
    await ownership.adopt(clone(liveTabs.get(1)));
    let state = await ownership.status(1);
    assert.equal(state.marker.source, 'adopted');

    let settled = false;
    const command = runScopedCommand({
      command: 'discard-tabs',
      selected: {id: 99, index: 0},
      shiftKey: false,
      query: async () => [clone(liveTabs.get(1))],
      resolveFresh: ownership.resolveFresh,
      check: async () => assert.fail('already-discarded takeover must not use the eligibility check'),
      discard: async () => assert.fail('takeover must use its low-level native discard path'),
      takeover: tab => discard.takeover(tab, {manual: true}),
      reload: async () => assert.fail('discard command must not use the release path')
    }).then(result => {
      settled = true;
      return result;
    });

    await waitForNative('initial normal takeover');
    assert.equal(settled, false);
    assert.ok(discard.waitForTakeover(1));
    assert.deepEqual(calls, ['reload:1:false', 'stop:1', 'stop:1', 'stop:1', 'discard:1']);
    assert.deepEqual(discard.takeoverScheduler.snapshot().resources, {
      cpu: {active: 1, limit: 2},
      network: {active: 0, limit: 4}
    }, 'ordinary takeover must release the network budget before renderer/native settlement');

    finishNative();
    const result = await command;
    assert.equal(discard.waitForTakeover(1), undefined);
    assert.deepEqual(result.takeovers.map(tab => tab.id), [1]);
    assert.equal(liveTabs.get(1).discarded, true);
    assert.equal(liveTabs.get(1).title, '💤 test');
    state = await ownership.status(1);
    assert.equal(state.marker.state, 'owned');
    assert.equal(state.marker.source, 'self');

    const callCount = calls.length;
    const repeat = await runScopedCommand({
      command: 'discard-tabs',
      selected: {id: 99, index: 0},
      shiftKey: false,
      query: async () => [clone(liveTabs.get(1))],
      resolveFresh: ownership.resolveFresh,
      check: async () => {},
      discard: async () => true,
      takeover: async () => assert.fail('repeat normal command must not wake a self-owned tab'),
      reload: async () => {}
    });
    assert.deepEqual(repeat.alreadyOwned.map(tab => tab.id), [1]);
    assert.equal(calls.length, callCount);

    // Edge can replace the tab id at the successful native-discard boundary.
    // The running job, pending nonce, final verification, and stale-id callers
    // must all follow the successor instead of cancelling or becoming claimed.
    const edgeOriginal = {
      id: 60,
      windowId: 1,
      index: 10,
      active: false,
      discarded: true,
      status: 'unloaded',
      url: 'https://edge-takeover.example/'
    };
    liveTabs.set(edgeOriginal.id, edgeOriginal);
    await ownership.claim(edgeOriginal);
    const edgeCallStart = calls.length;
    const edgeTakeover = discard.takeover(clone(edgeOriginal), {manual: true});
    await waitForNative('Edge replacement takeover');
    assert.ok(discard.waitForTakeover(edgeOriginal.id));
    nativeReplacementId = 61;
    finishNative();
    assert.deepEqual(discard.takeoverSnapshot().find(job => job.id === 61)?.tab, {
      id: 61,
      index: edgeOriginal.index,
      windowId: edgeOriginal.windowId
    });
    assert.ok(discard.waitForTakeover(edgeOriginal.id));
    assert.equal(await edgeTakeover, true);
    assert.deepEqual(calls.slice(edgeCallStart), [
      'reload:60:false', 'stop:60', 'stop:60', 'discard:60'
    ]);
    assert.equal(ownership.resolveId(edgeOriginal.id), 61);
    assert.equal(discard.waitForTakeover(edgeOriginal.id), undefined);
    assert.equal(discard.waitForTakeover(61), undefined);
    assert.equal(liveTabs.has(edgeOriginal.id), false);
    assert.equal(liveTabs.get(61).discarded, true);
    assert.equal(liveTabs.get(61).title.startsWith('\u{1F4A4}'), true);
    assert.equal((await ownership.status(edgeOriginal.id)).marker.source, 'self');
    const edgeOwnership = await ownership.snapshot();
    assert.equal(edgeOwnership[edgeOriginal.id], undefined);
    assert.equal(edgeOwnership[61].source, 'self');

    // Edge Sleeping Tabs are frozen rather than discarded. Their renderer must
    // remain untouched: one native discard establishes physical ownership and
    // the visual record reports the requested title/favicon as unavailable.
    const frozen = {
      id: 62,
      windowId: 1,
      index: 11,
      active: false,
      discarded: false,
      frozen: true,
      status: 'complete',
      url: 'https://edge-frozen.example/'
    };
    const frozenKeeper = {
      id: 63,
      windowId: 1,
      index: 12,
      active: true,
      discarded: false,
      frozen: false,
      status: 'complete',
      url: 'https://edge-frozen-keeper.example/'
    };
    liveTabs.set(frozenKeeper.id, frozenKeeper);
    liveTabs.set(frozen.id, frozen);
    const frozenCallStart = calls.length;
    const frozenTakeover = discard.takeover(clone(frozen), {manual: true});
    await waitForNative('Edge frozen takeover');
    assert.deepEqual(calls.slice(frozenCallStart), ['discard:62']);
    assert.deepEqual(discard.takeoverScheduler.snapshot().resources, {
      cpu: {active: 1, limit: 2},
      network: {active: 0, limit: 4}
    }, 'direct frozen ownership must never consume the reload/network budget');
    finishNative();
    const frozenResult = await frozenTakeover;
    assert.equal(frozenResult.ok, true);
    assert.equal(frozenResult.physicalOnly, true);
    assert.equal(frozenResult.visualUnavailable, true);
    // The fixture's native callback does not synthesize Chromium's optional
    // frozen:false update; discarded+unloaded is the production postcondition.
    assert.equal(liveTabs.get(frozen.id).frozen, true);
    assert.equal(liveTabs.get(frozen.id).discarded, true);
    assert.equal(liveTabs.get(frozenKeeper.id).active, true);
    assert.notEqual(liveTabs.get(frozen.id).title?.startsWith('\u{1F4A4}'), true);
    const frozenMarker = (await ownership.status(frozen.id)).marker;
    assert.equal(frozenMarker.source, 'self');
    assert.deepEqual(frozenMarker.visual, {
      complete: false,
      favicon: false,
      physicalOnly: true,
      repair: false,
      title: false,
      titleMarker: '\u{1F4A4}'
    });
    assert.equal(calls.slice(frozenCallStart).some(call => call.startsWith('activate:')), false);

    // The in-memory reservations are synchronous. A direct takeover that wins
    // first excludes an ordinary renderer-marking discard even while its
    // persisted intent/native callback are still pending.
    const takeoverFirst = {
      id: 124,
      windowId: 31,
      index: 0,
      active: false,
      discarded: false,
      frozen: true,
      status: 'complete',
      url: 'https://direct-interlock-takeover-first.example/'
    };
    const takeoverFirstKeeper = {
      id: 125,
      windowId: 31,
      index: 1,
      active: true,
      discarded: false,
      frozen: false,
      status: 'complete',
      url: 'https://direct-interlock-keeper.example/'
    };
    liveTabs.set(takeoverFirst.id, takeoverFirst);
    liveTabs.set(takeoverFirstKeeper.id, takeoverFirstKeeper);
    const interlockCallStart = calls.length;
    const interlockedTakeover = discard.takeover(clone(takeoverFirst), {manual: true});
    const ordinaryRepeat = await discard({...clone(takeoverFirst), frozen: false});
    assert.equal(ordinaryRepeat.status, 'skipped');
    assert.equal(calls.slice(interlockCallStart).some(call => call === 'stop:124'), false);
    await waitForNative('direct takeover/ordinary renderer interlock');
    assert.deepEqual(calls.slice(interlockCallStart), ['discard:124']);
    finishNative();
    assert.equal((await interlockedTakeover).physicalOnly, true);

    // Conversely, a metadata/renderer lease that wins first prevents a direct
    // takeover from registering or issuing tabs.discard until that scan ends.
    const rendererFirst = {
      id: 126,
      windowId: 32,
      index: 0,
      active: false,
      discarded: false,
      frozen: true,
      status: 'complete',
      url: 'https://direct-interlock-renderer-first.example/'
    };
    liveTabs.set(rendererFirst.id, rendererFirst);
    let releaseRendererLease;
    const rendererLease = discard.withRendererGuard(rendererFirst.id, () => new Promise(resolve => {
      releaseRendererLease = resolve;
    }));
    const rendererFirstCallStart = calls.length;
    await assert.rejects(
      discard.takeover(clone(rendererFirst), {manual: true}),
      /conflicting|ordinary discard is already in progress/
    );
    assert.equal(calls.slice(rendererFirstCallStart).some(call => call === 'discard:126'), false);
    await Promise.resolve();
    releaseRendererLease();
    await rendererLease;

    // A release timeout after the direct native call must leave its durable
    // intent intact. Repeats issue neither script nor second discard; after the
    // original operation settles, release performs exactly one verified reload.
    const directReleaseFence = {
      id: 127,
      windowId: 33,
      index: 0,
      active: false,
      discarded: false,
      frozen: true,
      status: 'complete',
      url: 'https://direct-release-fence.example/'
    };
    const directReleaseFenceKeeper = {
      id: 128,
      windowId: 33,
      index: 1,
      active: true,
      discarded: false,
      frozen: false,
      status: 'complete',
      url: 'https://direct-release-fence-keeper.example/'
    };
    liveTabs.set(directReleaseFence.id, directReleaseFence);
    liveTabs.set(directReleaseFenceKeeper.id, directReleaseFenceKeeper);
    const savedDirectNativeTimeout = discard.nativeTimeout;
    const savedDirectTakeoverFence = discard.takeoverFenceTimeout;
    const savedDirectReleaseFence = discard.releaseNativeFenceTimeout;
    discard.nativeTimeout = 50;
    discard.takeoverFenceTimeout = 50;
    discard.releaseNativeFenceTimeout = 5;
    const directReleaseCallStart = calls.length;
    const heldDirectTakeover = discard.takeover(
      clone(directReleaseFence),
      {manual: true}
    ).catch(() => false);
    await waitForNative('direct native release fence');
    await assert.rejects(
      releasePhaseTarget(directReleaseFence),
      /native discard operation is still pending/
    );
    assert.equal((await ownership.status(directReleaseFence.id)).marker?.state,
      'direct-native-pending');
    const repeatDuringFence = await discard({...clone(directReleaseFence), frozen: false});
    assert.equal(repeatDuringFence.status, 'skipped');
    assert.deepEqual(calls.slice(directReleaseCallStart), ['discard:127']);
    finishNative();
    await heldDirectTakeover;
    discard.releaseNativeFenceTimeout = 200;
    await releasePhaseTarget(directReleaseFence, [clone(liveTabs.get(directReleaseFence.id))]);
    assert.equal(calls.slice(directReleaseCallStart).filter(
      call => call === 'discard:127'
    ).length, 1);
    assert.equal(calls.slice(directReleaseCallStart).filter(
      call => call === 'release:127:false'
    ).length, 1);
    discard.nativeTimeout = savedDirectNativeTimeout;
    discard.takeoverFenceTimeout = savedDirectTakeoverFence;
    discard.releaseNativeFenceTimeout = savedDirectReleaseFence;

    // Once a direct call crosses both timeout fences, a definitive rejection
    // clears only that call's exact pending authority. A late accepted call
    // follows the existing promotion path and retains source:self ownership.
    const lateDirectTabs = [{
      id: 216,
      windowId: 216,
      index: 0,
      active: false,
      discarded: false,
      frozen: true,
      status: 'complete',
      url: 'https://late-direct-rejected.example/'
    }, {
      id: 218,
      windowId: 218,
      index: 0,
      active: false,
      discarded: false,
      frozen: true,
      status: 'complete',
      url: 'https://late-direct-accepted.example/'
    }];
    for (const tab of lateDirectTabs) {
      liveTabs.set(tab.id, tab);
      liveTabs.set(tab.id + 1, {
        id: tab.id + 1,
        windowId: tab.windowId,
        index: 1,
        active: true,
        discarded: false,
        frozen: false,
        status: 'complete',
        url: `${tab.url}keeper`
      });
    }
    discard.nativeTimeout = 5;
    discard.takeoverFenceTimeout = 5;

    nativeRejectIds.add(lateDirectTabs[0].id);
    const rejectedLateDirect = discard.takeover(
      clone(lateDirectTabs[0]),
      {manual: true}
    ).catch(() => false);
    await waitForNative('late direct native rejection');
    assert.equal(await rejectedLateDirect, false);
    assert.equal((await ownership.status(lateDirectTabs[0].id)).marker?.state,
      'direct-native-pending');
    finishNative();
    const rejectedClearDeadline = Date.now() + 1000;
    while ((await ownership.status(lateDirectTabs[0].id)).marker &&
        Date.now() < rejectedClearDeadline) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal((await ownership.status(lateDirectTabs[0].id)).marker, undefined,
      'the exact definitively rejected native authority must be cleared');
    assert.equal(await ownership.hasBlockingNativeIntent(lateDirectTabs[0].id), false);
    assert.equal(hasTakeover(lateDirectTabs[0].id), false);
    assert.equal(liveTabs.get(lateDirectTabs[0].id).frozen, true,
      'a rejected call must leave the frozen target physically untouched');

    const acceptedLateDirect = discard.takeover(
      clone(lateDirectTabs[1]),
      {manual: true}
    ).catch(() => false);
    await waitForNative('late direct native acceptance');
    assert.equal(await acceptedLateDirect, false,
      'the caller times out before the browser reaches its physical boundary');
    assert.equal((await ownership.status(lateDirectTabs[1].id)).marker?.state,
      'direct-native-pending');
    finishNative();
    const acceptedPromotionDeadline = Date.now() + 1000;
    let acceptedMarker;
    while (Date.now() < acceptedPromotionDeadline) {
      acceptedMarker = (await ownership.status(lateDirectTabs[1].id)).marker;
      if (acceptedMarker?.state === 'owned' && acceptedMarker.source === 'self') {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(acceptedMarker?.state, 'owned');
    assert.equal(acceptedMarker?.source, 'self');
    assert.equal(await ownership.hasBlockingNativeIntent(lateDirectTabs[1].id), false);
    assert.equal(hasTakeover(lateDirectTabs[1].id), false);

    const rejectedReplacement = {
      id: 236,
      windowId: 236,
      index: 0,
      active: false,
      discarded: false,
      frozen: true,
      status: 'complete',
      url: 'https://late-direct-rejected-replacement.example/'
    };
    liveTabs.set(rejectedReplacement.id, rejectedReplacement);
    liveTabs.set(237, {
      id: 237,
      windowId: rejectedReplacement.windowId,
      index: 1,
      active: true,
      discarded: false,
      frozen: false,
      status: 'complete',
      url: 'https://late-direct-rejected-replacement-keeper.example/'
    });
    const rejectedReplacementTakeover = discard.takeover(
      clone(rejectedReplacement),
      {manual: true}
    ).catch(() => false);
    await waitForNative('late rejected direct native replacement');
    assert.equal(await rejectedReplacementTakeover, false);
    nativeReplacementId = 238;
    nativeRejectAfterReplacementIds.add(rejectedReplacement.id);
    finishNative();
    const replacementClaimDeadline = Date.now() + 1000;
    let replacementClaim;
    while (Date.now() < replacementClaimDeadline) {
      replacementClaim = (await ownership.status(238)).marker;
      if (replacementClaim?.state === 'owned') {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(replacementClaim?.state, 'owned');
    assert.equal(['physical-only', 'claimed'].includes(replacementClaim?.source), true,
      'a physically settled external replacement remains conservatively owned');
    assert.equal(await ownership.hasBlockingNativeIntent(238), false);
    assert.equal(hasTakeover(238), false);

    discard.nativeTimeout = savedDirectNativeTimeout;
    discard.takeoverFenceTimeout = savedDirectTakeoverFence;

    // Cancellation before tabs.discard is invoked clears the durable direct
    // intent. Release must classify that post-cancel state, then perform its
    // one explicit reload instead of treating the pre-cancel marker as an
    // unresolved browser operation.
    const cancelledBeforeNative = {
      id: 129,
      windowId: 34,
      index: 0,
      active: false,
      discarded: false,
      frozen: true,
      status: 'complete',
      url: 'https://direct-cancel-before-native.example/'
    };
    const cancelledBeforeNativeKeeper = {
      id: 130,
      windowId: 34,
      index: 1,
      active: true,
      discarded: false,
      frozen: false,
      status: 'complete',
      url: 'https://direct-cancel-before-native-keeper.example/'
    };
    liveTabs.set(cancelledBeforeNative.id, cancelledBeforeNative);
    liveTabs.set(cancelledBeforeNativeKeeper.id, cancelledBeforeNativeKeeper);
    const prefsHeld = new Promise(resolve => { localStorageReached = resolve; });
    holdLocalStorage = true;
    const preNativeCallStart = calls.length;
    const preNativeTakeover = discard.takeover(clone(cancelledBeforeNative), {manual: true})
      .catch(() => false);
    await prefsHeld;
    let preNativeCancelStarted;
    const preNativeCancelReached = new Promise(resolve => { preNativeCancelStarted = resolve; });
    const preNativeHelper = createReleaseHelper({
      cancelTakeover: id => {
        const operation = discard.cancelTakeover(id);
        preNativeCancelStarted();
        return operation;
      },
      getStatus: id => ownership.status(id),
      invalidate: id => ownership.invalidate(id),
      reserveRelease: id => discard.reserveRelease(id),
      resolveId: id => ownership.resolveId(id),
      runtime: () => chrome.runtime,
      tabs: () => phaseTabs,
      takeoverSnapshot: () => discard.takeoverSnapshot()
    });
    preNativeHelper.releaseTab.interval = 0;
    preNativeHelper.releaseTab.polls = 20;
    preNativeHelper.releaseTab.stableReads = 2;
    const preNativeRelease = preNativeHelper.releaseTab(clone(cancelledBeforeNative));
    await preNativeCancelReached;
    releaseHeldLocalStorage();
    await preNativeTakeover;
    await preNativeRelease;
    assert.equal(calls.slice(preNativeCallStart).some(call => call === 'discard:129'), false);
    assert.equal(calls.slice(preNativeCallStart).filter(
      call => call === 'release:129:false'
    ).length, 1);
    assert.equal((await ownership.status(cancelledBeforeNative.id)).marker, undefined);

    // Removal can land after direct-native-pending is durable but before the
    // mandatory post-persistence read issues tabs.discard(). That exact
    // never-issued nonce must clear even if onRemoved has already converted it
    // into a global orphan; an issued native operation is never cleaned here.
    const removedAfterDirectPersistence = {
      id: 239,
      windowId: 239,
      index: 0,
      active: false,
      discarded: false,
      frozen: true,
      status: 'complete',
      url: 'https://removed-after-direct-persistence.example/'
    };
    const removedAfterDirectPersistenceKeeper = {
      id: 240,
      windowId: 239,
      index: 1,
      active: true,
      discarded: false,
      frozen: false,
      status: 'complete',
      url: 'https://removed-after-direct-persistence-keeper.example/'
    };
    liveTabs.set(removedAfterDirectPersistence.id, removedAfterDirectPersistence);
    liveTabs.set(removedAfterDirectPersistenceKeeper.id, removedAfterDirectPersistenceKeeper);
    const originalBeginDirectNative = ownership.beginDirectNative;
    let removalBoundaryReached;
    const removalBoundary = new Promise(resolve => { removalBoundaryReached = resolve; });
    ownership.beginDirectNative = async tab => {
      const nonce = await originalBeginDirectNative(tab);
      liveTabs.delete(tab.id);
      listeners.removed.forEach(listener => listener(tab.id));
      removalBoundaryReached();
      return nonce;
    };
    const removedAfterPersistenceCallStart = calls.length;
    try {
      const removedAfterPersistenceTakeover = discard.takeover(
        clone(removedAfterDirectPersistence),
        {manual: true}
      ).catch(() => false);
      await removalBoundary;
      assert.equal(await removedAfterPersistenceTakeover, false);
      const orphanClearDeadline = Date.now() + 1000;
      while ((await ownership.status(removedAfterDirectPersistence.id)).marker &&
          Date.now() < orphanClearDeadline) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      const removedState = await ownership.status(removedAfterDirectPersistence.id);
      assert.equal(removedState.marker, undefined);
      assert.notEqual(removedState.nativeOrphan, true);
      assert.equal(await ownership.hasBlockingNativeIntent(removedAfterDirectPersistence.id), false);
      assert.equal(calls.slice(removedAfterPersistenceCallStart).some(
        call => call === `discard:${removedAfterDirectPersistence.id}`
      ), false, 'post-persistence removal must abort before native invocation');
      assert.equal(hasTakeover(removedAfterDirectPersistence.id), false);
    }
    finally {
      ownership.beginDirectNative = originalBeginDirectNative;
    }

    const removedAfterNativeInvocation = {
      id: 241,
      windowId: 241,
      index: 0,
      active: false,
      discarded: false,
      frozen: true,
      status: 'complete',
      url: 'https://removed-after-native-invocation.example/'
    };
    liveTabs.set(removedAfterNativeInvocation.id, removedAfterNativeInvocation);
    liveTabs.set(242, {
      id: 242,
      windowId: 241,
      index: 1,
      active: true,
      discarded: false,
      frozen: false,
      status: 'complete',
      url: 'https://removed-after-native-invocation-keeper.example/'
    });
    const savedInvokedRemovalNativeTimeout = discard.nativeTimeout;
    const savedInvokedRemovalFenceTimeout = discard.takeoverFenceTimeout;
    discard.nativeTimeout = 5;
    discard.takeoverFenceTimeout = 5;
    nativeRejectIds.add(removedAfterNativeInvocation.id);
    const invokedRemovalTakeover = discard.takeover(
      clone(removedAfterNativeInvocation),
      {manual: true}
    ).catch(() => false);
    await waitForNative('removal after native invocation');
    liveTabs.delete(removedAfterNativeInvocation.id);
    listeners.removed.forEach(listener => listener(removedAfterNativeInvocation.id));
    assert.equal(await invokedRemovalTakeover, false);
    const invokedOrphanDeadline = Date.now() + 1000;
    let invokedOrphanState;
    while (Date.now() < invokedOrphanDeadline) {
      invokedOrphanState = await ownership.status(removedAfterNativeInvocation.id);
      if (invokedOrphanState.marker?.state === 'direct-native-orphan') {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(invokedOrphanState?.marker?.state, 'direct-native-orphan',
      'issued native work must retain its fail-closed orphan authority');
    assert.equal(invokedOrphanState.nativeOrphan, true);
    assert.equal(hasTakeover(removedAfterNativeInvocation.id), true);
    finishNative();
    const invokedRejectionClearDeadline = Date.now() + 1000;
    while (((await ownership.status(removedAfterNativeInvocation.id)).marker ||
        hasTakeover(removedAfterNativeInvocation.id)) &&
        Date.now() < invokedRejectionClearDeadline) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal((await ownership.status(removedAfterNativeInvocation.id)).marker, undefined,
      'only the later definitive rejection may retire issued orphan authority');
    assert.equal(hasTakeover(removedAfterNativeInvocation.id), false);
    discard.nativeTimeout = savedInvokedRemovalNativeTimeout;
    discard.takeoverFenceTimeout = savedInvokedRemovalFenceTimeout;

    // The release reservation is acquired synchronously before cancellation.
    // Even when cancellation itself pauses, no fresh takeover may start in
    // the cancel -> live-read -> reload gap.
    const reservedRelease = {
      id: 131,
      windowId: 35,
      index: 0,
      active: false,
      discarded: false,
      frozen: true,
      status: 'complete',
      url: 'https://release-reservation.example/'
    };
    const reservedReleaseKeeper = {
      id: 132,
      windowId: 35,
      index: 1,
      active: true,
      discarded: false,
      frozen: false,
      status: 'complete',
      url: 'https://release-reservation-keeper.example/'
    };
    liveTabs.set(reservedRelease.id, reservedRelease);
    liveTabs.set(reservedReleaseKeeper.id, reservedReleaseKeeper);
    let afterReservedCancel;
    const reservedCancelReached = new Promise(resolve => { afterReservedCancel = resolve; });
    let resumeReservedCancel;
    const reservedCancelGate = new Promise(resolve => { resumeReservedCancel = resolve; });
    const reservedHelper = createReleaseHelper({
      cancelTakeover: async id => {
        await discard.cancelTakeover(id);
        afterReservedCancel();
        await reservedCancelGate;
      },
      getStatus: id => ownership.status(id),
      invalidate: id => ownership.invalidate(id),
      reserveRelease: id => discard.reserveRelease(id),
      resolveId: id => ownership.resolveId(id),
      runtime: () => chrome.runtime,
      tabs: () => phaseTabs,
      takeoverSnapshot: () => discard.takeoverSnapshot()
    });
    reservedHelper.releaseTab.interval = 0;
    reservedHelper.releaseTab.polls = 20;
    reservedHelper.releaseTab.stableReads = 2;
    const reservedCallStart = calls.length;
    const reservedPromise = reservedHelper.releaseTab(clone(reservedRelease));
    await reservedCancelReached;
    await assert.rejects(
      discard.takeover(clone(reservedRelease), {manual: true}),
      /in progress|conflicting discard or release operation/
    );
    resumeReservedCancel();
    await reservedPromise;
    assert.equal(calls.slice(reservedCallStart).some(call => call === 'discard:131'), false);
    assert.equal(calls.slice(reservedCallStart).filter(
      call => call === 'release:131:false'
    ).length, 1);

    const groupTabs = [
      {
        id: 40,
        windowId: 9,
        index: 0,
        groupId: 7,
        active: false,
        discarded: true,
        highlighted: false,
        url: 'https://group-root.example/'
      },
      {
        id: 41,
        windowId: 9,
        index: 1,
        groupId: 7,
        active: false,
        discarded: true,
        highlighted: false,
        url: 'https://group-child-one.example/'
      },
      {
        id: 42,
        windowId: 9,
        index: 2,
        groupId: 7,
        active: false,
        discarded: true,
        highlighted: true,
        url: 'https://group-child-two.example/'
      },
      {
        id: 43,
        windowId: 9,
        index: 3,
        groupId: 8,
        active: true,
        discarded: false,
        highlighted: true,
        url: 'https://outside-group.example/'
      }
    ];
    groupTabs.forEach(tab => liveTabs.set(tab.id, tab));
    await Promise.all(groupTabs.slice(0, 3).map(tab => ownership.claim(tab)));
    const groupTargets = tabsForGroupCommand(groupTabs, groupTabs[0]);
    assert.deepEqual(groupTargets.map(tab => tab.id), [40, 41, 42]);
    const groupCallStart = calls.length;
    nativeImmediate = true;
    const normalGroup = runDirectDiscardCommand({
      activate: async () => assert.fail('an all-discarded group does not need a keeper'),
      allTabs: groupTabs,
      command: 'discard-tree',
      discard: async () => assert.fail('already-discarded group members stay unloaded'),
      inProgress: () => false,
      notifyNoKeeper: () => assert.fail('an inactive discarded group is not blocked'),
      resolveFresh: ownership.resolveFresh,
      selected: groupTabs[0],
      shiftKey: false,
      takeover: tab => discard.takeover(tab, {manual: true}),
      targets: groupTargets
    });
    const normalGroupResult = await normalGroup;
    nativeImmediate = false;
    assert.deepEqual(normalGroupResult.takeovers.map(tab => tab.id), [40, 41, 42]);
    assert.equal(calls.length, groupCallStart + 12);
    for (const id of [40, 41, 42]) {
      assert.equal(calls.slice(groupCallStart).filter(call => call === `reload:${id}:false`).length, 1);
      assert.equal(calls.slice(groupCallStart).filter(call => call === `stop:${id}`).length, 2);
      assert.equal(calls.slice(groupCallStart).filter(call => call === `discard:${id}`).length, 1);
      assert.equal((await ownership.status(id)).marker.source, 'self');
      assert.equal(liveTabs.get(id).discarded, true);
      assert.equal(liveTabs.get(id).title, '💤 test');
      assert.equal(calls.filter(call => call === `reload:${id}:false`).length, 1);
    }
    assert.equal((await ownership.status(43)).marker, undefined);

    await runDirectDiscardCommand({
      activate: async () => assert.fail('repeat normal discard does not need a keeper'),
      allTabs: groupTabs,
      command: 'discard-tree',
      discard: async () => assert.fail('repeat normal discard must be a no-op'),
      inProgress: () => false,
      notifyNoKeeper: () => assert.fail('repeat normal discard is not blocked'),
      resolveFresh: ownership.resolveFresh,
      selected: groupTabs[0],
      shiftKey: false,
      takeover: async () => assert.fail('repeat normal discard must not reload'),
      targets: groupTargets
    });
    assert.equal(calls.length, groupCallStart + 12);

    const groupCallCount = calls.length;
    await runDirectDiscardCommand({
      activate: async () => assert.fail('repeat Shift does not need a keeper'),
      allTabs: groupTabs,
      command: 'discard-tree',
      discard: async () => assert.fail('repeat Shift is a no-op'),
      inProgress: () => false,
      notifyNoKeeper: () => assert.fail('repeat Shift is not blocked'),
      resolveFresh: ownership.resolveFresh,
      selected: groupTabs[0],
      shiftKey: true,
      takeover: async () => assert.fail('self-owned group members are skipped'),
      targets: groupTargets
    });
    assert.equal(calls.length, groupCallCount);

    const automatic = {
      id: 3,
      windowId: 1,
      index: 4,
      active: false,
      discarded: true,
      url: 'https://automatic.example/'
    };
    liveTabs.set(3, automatic);
    const automaticCallCount = calls.length;
    emitUpdated(3, {discarded: true});
    state = await ownership.status(3);
    assert.equal(calls.length, automaticCallCount);
    assert.equal(hasTakeover(3), false);
    assert.equal(state.marker.source, 'claimed');

    const legacyClaimed = {
      id: 4,
      windowId: 1,
      index: 5,
      active: false,
      discarded: true,
      url: 'https://legacy-claimed.example/'
    };
    liveTabs.set(4, legacyClaimed);
    await ownership.claim(legacyClaimed);
    state = await ownership.status(4);
    assert.equal(state.marker.source, 'claimed');
    const startupCallCount = calls.length;
    assert.deepEqual(await discard.recoverTakeovers(), []);
    assert.equal(calls.length, startupCallCount);
    assert.equal(liveTabs.get(4).discarded, true);
    state = await ownership.status(4);
    assert.equal(state.marker.source, 'claimed');

    const queueHead = {
      id: 7,
      windowId: 1,
      index: 8,
      active: false,
      discarded: true,
      url: 'https://queue-head.example/'
    };
    const queuedRelease = {
      id: 8,
      windowId: 1,
      index: 9,
      active: false,
      discarded: true,
      url: 'https://queued-release.example/'
    };
    liveTabs.set(7, queueHead);
    liveTabs.set(8, queuedRelease);
    await Promise.all([ownership.claim(queueHead), ownership.claim(queuedRelease)]);
    const headTakeover = discard.takeover(clone(queueHead), {manual: true});
    await waitForNative('popup takeover');
    const cancelledQueuedTakeover = discard.takeover(clone(queuedRelease), {manual: true}).catch(() => false);
    const jobs = discard.takeoverSnapshot();
    const queuedJob = jobs.find(job => job.id === queuedRelease.id);
    assert.ok(Object.isFrozen(jobs));
    assert.ok(Object.isFrozen(queuedJob));
    assert.ok(Object.isFrozen(queuedJob.tab));
    assert.equal(queuedJob.started, false);
    assert.deepEqual(queuedJob.tab, {id: 8, index: 9, windowId: 1});
    assert.equal('promise' in queuedJob, false);
    assert.equal('token' in queuedJob, false);
    assert.notStrictEqual(discard.takeoverSnapshot(), jobs);
    assert.notStrictEqual(discard.takeoverSnapshot().find(job => job.id === 8).tab, queuedJob.tab);
    listeners.attached.forEach(listener => listener(queuedRelease.id, {
      newPosition: 1,
      newWindowId: queuedRelease.windowId
    }));
    assert.equal(discard.takeoverSnapshot().find(job => job.id === queuedRelease.id).tab.index, 1);
    listeners.moved.forEach(listener => listener(queuedRelease.id, {
      fromIndex: 1,
      toIndex: 0,
      windowId: queuedRelease.windowId
    }));
    const movedJobs = discard.takeoverSnapshot();
    assert.equal(movedJobs.find(job => job.id === queuedRelease.id).tab.index, 0);
    assert.deepEqual(scopeTakeoverTabs('release-lefts', movedJobs, {
      index: 5,
      windowId: queuedRelease.windowId
    }).map(tab => tab.id), [queuedRelease.id]);
    let queuedReleaseSettled = false;
    const queuedReleaseCommand = releasePhaseTarget(queuedRelease).then(result => {
      queuedReleaseSettled = true;
      return result;
    });
    while (!queuedReleaseSettled) {
      await new Promise(resolve => setTimeout(resolve));
    }
    assert.equal(calls.at(-1), 'release:8:false');
    assert.equal(liveTabs.get(8).discarded, false);
    finishNative();
    assert.equal(await headTakeover, true);
    assert.equal(await cancelledQueuedTakeover, false);
    await queuedReleaseCommand;
    await assertReleaseInvariant(queuedRelease);

    // Removing another queued target must reject and detach it immediately,
    // without waiting for or cancelling the running same-window lock owner.
    const removalHead = {
      id: 37,
      windowId: 1,
      index: 37,
      active: false,
      discarded: true,
      status: 'unloaded',
      url: 'https://removal-head.example/'
    };
    const removedQueued = {
      ...removalHead,
      id: 38,
      index: 38,
      url: 'https://removed-queued.example/'
    };
    liveTabs.set(removalHead.id, removalHead);
    liveTabs.set(removedQueued.id, removedQueued);
    await Promise.all([ownership.claim(removalHead), ownership.claim(removedQueued)]);
    const removalHeadTakeover = discard.takeover(clone(removalHead), {manual: true});
    await waitForNative('removed queued takeover head');
    const removedQueuedTakeover = discard.takeover(clone(removedQueued), {manual: true}).catch(() => false);
    const removalQueueDeadline = Date.now() + 1000;
    while (!hasTakeover(38) && Date.now() < removalQueueDeadline) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(discard.takeoverSnapshot().find(job => job.id === 38)?.started, false);
    liveTabs.delete(38);
    listeners.removed.forEach(listener => listener(38));
    assert.equal(await removedQueuedTakeover, false);
    assert.equal(hasTakeover(38), false);
    assert.equal(hasTakeover(37), true, 'removing a queued job must not disturb the running head');
    assert.equal(discard.takeoverScheduler.snapshot().queued, 0);
    finishNative();
    assert.equal(await removalHeadTakeover, true);

    // A frozen job waiting for the CPU/API phase must retain only its recoverable
    // takeover-queued request. Persisting direct-native-pending before admission
    // would turn removal into a global orphan fence even though tabs.discard()
    // was never invoked for that target.
    const frozenCpuBlockers = [210, 211].map((id, index) => ({
      id,
      windowId: 40 + index,
      index: 0,
      active: false,
      discarded: false,
      frozen: true,
      status: 'complete',
      url: `https://frozen-cpu-blocker-${index}.example/`
    }));
    const frozenCpuKeepers = frozenCpuBlockers.map((tab, index) => ({
      id: 212 + index,
      windowId: tab.windowId,
      index: 1,
      active: true,
      discarded: false,
      frozen: false,
      status: 'complete',
      url: `https://frozen-cpu-keeper-${index}.example/`
    }));
    const removedCpuWaiter = {
      id: 214,
      windowId: 42,
      index: 0,
      active: false,
      discarded: false,
      frozen: true,
      status: 'complete',
      url: 'https://removed-frozen-cpu-waiter.example/'
    };
    const removedCpuWaiterKeeper = {
      id: 215,
      windowId: removedCpuWaiter.windowId,
      index: 1,
      active: true,
      discarded: false,
      frozen: false,
      status: 'complete',
      url: 'https://removed-frozen-cpu-waiter-keeper.example/'
    };
    for (const tab of [...frozenCpuBlockers, ...frozenCpuKeepers,
      removedCpuWaiter, removedCpuWaiterKeeper]) {
      liveTabs.set(tab.id, tab);
    }
    frozenCpuBlockers.forEach(tab => heldNativeIds.add(tab.id));
    const frozenBlockerTakeovers = frozenCpuBlockers.map(tab =>
      discard.takeover(clone(tab), {manual: true}));
    try {
      const blockerDeadline = Date.now() + 1000;
      while (heldNativeResolvers.size < frozenCpuBlockers.length && Date.now() < blockerDeadline) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      assert.equal(heldNativeResolvers.size, 2);
      assert.deepEqual(discard.takeoverScheduler.snapshot().resources, {
        cpu: {active: 2, limit: 2},
        network: {active: 0, limit: 4}
      });

      const waiterCallStart = calls.length;
      const removedWaiterTakeover = discard.takeover(
        clone(removedCpuWaiter),
        {manual: true}
      ).catch(() => false);
      const queuedDeadline = Date.now() + 1000;
      let queuedMarker;
      while (Date.now() < queuedDeadline) {
        queuedMarker = (await ownership.status(removedCpuWaiter.id)).marker;
        if (queuedMarker?.state === 'takeover-queued' &&
            discard.takeoverScheduler.snapshot().queued >= 1) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      assert.equal(queuedMarker?.state, 'takeover-queued');
      assert.equal(calls.slice(waiterCallStart).includes(`discard:${removedCpuWaiter.id}`), false);

      liveTabs.delete(removedCpuWaiter.id);
      listeners.removed.forEach(listener => listener(removedCpuWaiter.id));
      const waiterTimeout = Symbol('waiter-timeout');
      const waiterResult = await Promise.race([
        removedWaiterTakeover,
        new Promise(resolve => setTimeout(resolve, 250, waiterTimeout))
      ]);
      assert.notEqual(waiterResult, waiterTimeout,
        'removed resource-queued work must cancel before either CPU owner settles');
      assert.equal(waiterResult, false);
      assert.equal(heldNativeResolvers.size, 2,
        'cancelling the waiter must not disturb either running native owner');
      assert.equal((await ownership.status(removedCpuWaiter.id)).marker, undefined);
      assert.equal(Object.values(await ownership.snapshot()).some(marker =>
        marker.state === 'direct-native-orphan'), false);
      assert.equal(discard.takeoverSnapshot().some(job => job.id === removedCpuWaiter.id), false);
    }
    finally {
      heldNativeIds.clear();
      for (const resolve of [...heldNativeResolvers.values()]) {
        resolve();
      }
      await Promise.all(frozenBlockerTakeovers);
    }

    // Resource phases alone cannot bound memory between phases: a fast reload
    // could otherwise wake an entire batch while only two CPU jobs prepare it.
    // Four full transactions are admitted, later targets stay truly discarded,
    // and cancelling an admission-queued target consumes no transaction slot.
    const transactionTargets = Array.from({length: 6}, (_, index) => ({
      id: 220 + index,
      windowId: 220 + index,
      index: 0,
      active: false,
      discarded: true,
      frozen: false,
      status: 'unloaded',
      url: `https://transaction-admission-${index}.example/`
    }));
    const transactionKeepers = transactionTargets.map((tab, index) => ({
      id: 230 + index,
      windowId: tab.windowId,
      index: 1,
      active: true,
      discarded: false,
      frozen: false,
      status: 'complete',
      url: `https://transaction-admission-keeper-${index}.example/`
    }));
    for (const tab of [...transactionTargets, ...transactionKeepers]) {
      liveTabs.set(tab.id, tab);
    }
    const savedAdmissionNativeTimeout = discard.nativeTimeout;
    const savedAdmissionFenceTimeout = discard.takeoverFenceTimeout;
    discard.nativeTimeout = 1000;
    discard.takeoverFenceTimeout = 1000;
    transactionTargets.forEach(tab => heldNativeIds.add(tab.id));
    const admissionCallStart = calls.length;
    const transactionTakeovers = transactionTargets.map(tab =>
      discard.takeover(clone(tab), {manual: true}).catch(() => false));
    try {
      const admissionDeadline = Date.now() + 1000;
      while (Date.now() < admissionDeadline) {
        const jobs = discard.takeoverSnapshot().filter(job =>
          transactionTargets.some(tab => tab.id === job.id));
        if (jobs.filter(job => job.started).length === 4 &&
            jobs.filter(job => !job.started).length === 2 &&
            heldNativeResolvers.size === 2) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      const admissionJobs = discard.takeoverSnapshot().filter(job =>
        transactionTargets.some(tab => tab.id === job.id));
      assert.equal(admissionJobs.filter(job => job.started).length, 4);
      assert.equal(admissionJobs.filter(job => !job.started).length, 2);
      assert.deepEqual(discard.takeoverAdmission.snapshot(), {
        active: 4,
        activeKeys: 0,
        concurrency: 4,
        queued: 2
      });
      assert.deepEqual(discard.takeoverScheduler.snapshot().resources, {
        cpu: {active: 2, limit: 2},
        network: {active: 0, limit: 4}
      });
      assert.deepEqual(calls.slice(admissionCallStart).filter(call =>
        call.startsWith('reload:')).map(call => Number(call.split(':')[1])).sort((a, b) => a - b),
      transactionTargets.slice(0, 4).map(tab => tab.id));
      for (const target of transactionTargets.slice(0, 4)) {
        assert.equal(liveTabs.get(target.id).discarded, false,
          'only admitted transactions may be awake between phases');
      }
      for (const target of transactionTargets.slice(4)) {
        assert.equal(liveTabs.get(target.id).discarded, true,
          'admission-queued transactions must retain their unloaded renderer');
      }

      assert.equal(await discard.cancelTakeover(transactionTargets[4].id), true);
      assert.equal(await transactionTakeovers[4], false);
      assert.equal(liveTabs.get(transactionTargets[4].id).discarded, true);
      assert.equal(calls.slice(admissionCallStart).some(call =>
        call === `reload:${transactionTargets[4].id}:false`), false);
      assert.deepEqual(discard.takeoverAdmission.snapshot(), {
        active: 4,
        activeKeys: 0,
        concurrency: 4,
        queued: 1
      });

      let remainingSettled = false;
      const remaining = Promise.all(transactionTakeovers.filter((value, index) => index !== 4))
        .then(value => {
          remainingSettled = true;
          return value;
        });
      const drainDeadline = Date.now() + 3000;
      while (!remainingSettled && Date.now() < drainDeadline) {
        for (const resolve of [...heldNativeResolvers.values()]) {
          resolve();
        }
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      assert.equal(remainingSettled, true, 'every admitted transaction must drain in bounded waves');
      assert.equal((await remaining).every(value => value === true), true);
      assert.equal(calls.slice(admissionCallStart).filter(call =>
        call.startsWith('reload:')).length, 5);
      assert.deepEqual(discard.takeoverAdmission.snapshot(), {
        active: 0,
        activeKeys: 0,
        concurrency: 4,
        queued: 0
      });
      await new Promise(resolve => setTimeout(resolve));
      assert.deepEqual(discard.takeoverScheduler.snapshot().resources, {
        cpu: {active: 0, limit: 2},
        network: {active: 0, limit: 4}
      });
    }
    finally {
      heldNativeIds.clear();
      for (const resolve of [...heldNativeResolvers.values()]) {
        resolve();
      }
      discard.nativeTimeout = savedAdmissionNativeTimeout;
      discard.takeoverFenceTimeout = savedAdmissionFenceTimeout;
    }

    const releaseRace = {
      id: 5,
      windowId: 1,
      index: 6,
      active: false,
      discarded: true,
      url: 'https://release-race.example/'
    };
    liveTabs.set(5, releaseRace);
    await ownership.claim(releaseRace);
    const releaseRaceKeeperId = [...liveTabs.values()].find(tab =>
      tab.windowId === releaseRace.windowId && tab.active === true)?.id;
    assert.equal(Number.isInteger(releaseRaceKeeperId), true);
    const savedTakeoverFenceTimeout = discard.takeoverFenceTimeout;
    const savedReleaseNativeFenceTimeout = discard.releaseNativeFenceTimeout;
    const savedNativeSettleTimeout = discard.nativeSettleTimeout;
    discard.nativeTimeout = 5;
    discard.takeoverFenceTimeout = 5;
    discard.releaseNativeFenceTimeout = 200;
    discard.nativeSettleTimeout = 5;
    nativeCallbackBeforePhysical = true;
    const racingTakeover = discard.takeover(clone(releaseRace), {manual: true}).catch(() => false);
    await waitForNative('joined takeover');
    finishNative();
    assert.equal(typeof finishNativePhysical, 'function',
      'the browser callback may accept before the physical discard settles');
    let releaseSettled = false;
    const release = releasePhaseTarget(releaseRace).then(result => {
      releaseSettled = true;
      return result;
    });
    // Cross both caller fences and the legacy physical-settlement timeout after
    // API acceptance. The job remains live and release stays joined to the
    // authoritative physical boundary, not merely to the resolved callback.
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(releaseSettled, false,
      'release must not report success ahead of a late native discard');
    assert.equal(hasTakeover(releaseRace.id), true,
      'late native authority must remain discoverable to release scopes');
    assert.equal(calls.at(-1), 'discard:5');
    assert.equal(liveTabs.get(releaseRace.id).discarded, false,
      'release must not run ahead of delayed physical settlement');
    finishNativePhysical();
    assert.equal(await racingTakeover, false);
    await release;
    assert.equal(calls.at(-1), 'release:5:false');
    await assertReleaseInvariant(releaseRace, releaseRaceKeeperId);
    assert.equal(liveTabs.get(unrelatedActive.id).active, true);
    const postReleaseCallCount = calls.length;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls.length, postReleaseCallCount,
      'late native settlement must not trigger a second wake or re-discard');

    // Ordinary renderer-prepared discard uses the same accepted-native
    // boundary even without a takeover transaction. Its bounded caller may
    // report timeout, but release still discovers and joins the physical call.
    const ordinaryBoundary = {
      id: 221,
      windowId: 221,
      index: 0,
      active: false,
      discarded: false,
      frozen: false,
      status: 'complete',
      title: 'ordinary delayed native target',
      url: 'https://ordinary-delayed-native.example/'
    };
    const ordinaryBoundaryKeeper = {
      id: 222,
      windowId: 221,
      index: 1,
      active: true,
      discarded: false,
      frozen: false,
      status: 'complete',
      title: 'ordinary delayed native keeper',
      url: 'https://ordinary-delayed-native-keeper.example/'
    };
    liveTabs.set(ordinaryBoundary.id, ordinaryBoundary);
    liveTabs.set(ordinaryBoundaryKeeper.id, ordinaryBoundaryKeeper);
    nativeCallbackBeforePhysical = true;
    const ordinaryBoundaryCallStart = calls.length;
    const ordinaryDiscard = discard.perform(clone(ordinaryBoundary));
    await waitForNative('ordinary accepted-native boundary');
    finishNative();
    assert.equal(typeof finishNativePhysical, 'function');
    const ordinaryResult = await ordinaryDiscard;
    assert.equal(ordinaryResult.status, 'failed');
    assert.match(ordinaryResult.reason, /native discard timed out/);
    assert.equal(hasTakeover(ordinaryBoundary.id), true,
      'ordinary timed-out native work must remain in the release registry');
    let ordinaryReleaseSettled = false;
    const ordinaryRelease = releasePhaseTarget(ordinaryBoundary).then(result => {
      ordinaryReleaseSettled = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(ordinaryReleaseSettled, false);
    assert.equal(calls.slice(ordinaryBoundaryCallStart).includes('release:221:false'), false);
    finishNativePhysical();
    await ordinaryRelease;
    await assertReleaseInvariant(ordinaryBoundary, ordinaryBoundaryKeeper.id);
    assert.deepEqual(calls.slice(ordinaryBoundaryCallStart), [
      'discard:221',
      'release:221:false'
    ]);
    const postOrdinaryReleaseCalls = calls.length;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls.length, postOrdinaryReleaseCalls,
      'ordinary late settlement must not rediscard after release success');

    // If Chromium never reaches that boundary inside release's own fence, the
    // command fails explicitly and retains the live transaction. Once the same
    // operation settles, a retry performs one authoritative wake.
    const stuckNative = {
      id: 137,
      windowId: 137,
      index: 0,
      active: false,
      discarded: true,
      frozen: false,
      status: 'unloaded',
      title: 'stuck native target',
      url: 'https://stuck-native-release.example/'
    };
    const stuckNativeKeeper = {
      id: 138,
      windowId: 137,
      index: 1,
      active: true,
      discarded: false,
      frozen: false,
      status: 'complete',
      title: 'stuck native keeper',
      url: 'https://stuck-native-keeper.example/'
    };
    liveTabs.set(stuckNative.id, stuckNative);
    liveTabs.set(stuckNativeKeeper.id, stuckNativeKeeper);
    await ownership.claim(stuckNative);
    discard.releaseNativeFenceTimeout = 10;
    const stuckNativeCallStart = calls.length;
    const stuckNativeTakeover = discard.takeover(
      clone(stuckNative),
      {manual: true}
    ).catch(() => false);
    await waitForNative('explicit release native fence failure');
    await assert.rejects(releasePhaseTarget(stuckNative),
      /cannot safely release tab 137: native discard operation is still pending/);
    assert.equal(hasTakeover(stuckNative.id), true,
      'an unresolved native operation must remain available after release aborts');
    assert.equal(calls.slice(stuckNativeCallStart).includes('release:137:false'), false);
    finishNative();
    assert.equal(await stuckNativeTakeover, false);
    await releasePhaseTarget(stuckNative, [clone(liveTabs.get(stuckNative.id))]);
    assert.equal(calls.slice(stuckNativeCallStart).filter(
      call => call === 'release:137:false'
    ).length, 1);
    await assertReleaseInvariant(stuckNative, stuckNativeKeeper.id);
    assert.equal(liveTabs.get(unrelatedActive.id).active, true);
    discard.releaseNativeFenceTimeout = 200;

    const beforeExternalRediscardCalls = calls.length;
    liveTabs.get(5).discarded = true;
    liveTabs.get(5).status = 'unloaded';
    emitUpdated(5, {discarded: true, status: 'unloaded'});
    state = await ownership.status(5);
    assert.equal(calls.length, beforeExternalRediscardCalls);
    assert.equal(hasTakeover(5), false);
    assert.equal(state.marker.source, 'claimed');
    discard.nativeTimeout = 200;
    discard.takeoverFenceTimeout = savedTakeoverFenceTimeout;
    discard.releaseNativeFenceTimeout = savedReleaseNativeFenceTimeout;
    discard.nativeSettleTimeout = savedNativeSettleTimeout;

    // A completed source:self transaction has no live job to union into the
    // command scope. Its queried suspended snapshot still releases exactly
    // once, clears the committed visual/ownership identity, and preserves the
    // active tab in that window.
    const settledSelf = {
      id: 135,
      windowId: 135,
      index: 0,
      active: false,
      discarded: true,
      frozen: false,
      status: 'unloaded',
      title: 'settled self target',
      url: 'https://settled-self-release.example/'
    };
    const settledSelfKeeper = {
      id: 136,
      windowId: 135,
      index: 1,
      active: true,
      discarded: false,
      frozen: false,
      status: 'complete',
      title: 'settled self keeper',
      url: 'https://settled-self-keeper.example/'
    };
    liveTabs.set(settledSelf.id, settledSelf);
    liveTabs.set(settledSelfKeeper.id, settledSelfKeeper);
    await ownership.claim(settledSelf);
    const settledSelfCallStart = calls.length;
    const settledSelfTakeover = discard.takeover(clone(settledSelf), {manual: true});
    await waitForNative('settled self-owned release');
    finishNative();
    assert.equal(await settledSelfTakeover, true);
    assert.equal((await ownership.status(settledSelf.id)).marker.source, 'self');
    assert.equal(liveTabs.get(settledSelf.id).title.startsWith('\u{1F4A4}'), true);
    await releasePhaseTarget(settledSelf, [clone(liveTabs.get(settledSelf.id))]);
    assert.deepEqual(calls.slice(settledSelfCallStart), [
      'reload:135:false', 'stop:135', 'stop:135', 'discard:135', 'release:135:false'
    ]);
    await assertReleaseInvariant(settledSelf, settledSelfKeeper.id);
    assert.equal(liveTabs.get(unrelatedActive.id).active, true);

    const lateUrl = {
      id: 6,
      windowId: 1,
      index: 7,
      active: false,
      discarded: true,
      url: ''
    };
    liveTabs.set(6, lateUrl);
    listeners.created.forEach(listener => listener(clone(lateUrl)));
    await new Promise(resolve => setTimeout(resolve));
    state = await ownership.status(6);
    assert.equal(state.marker.source, 'claimed');
    lateUrl.url = 'https://late-url.example/';
    const lateUrlCallCount = calls.length;
    emitUpdated(6, {url: lateUrl.url});
    state = await ownership.status(6);
    assert.equal(calls.length, lateUrlCallCount);
    assert.equal(hasTakeover(6), false);
    assert.equal(state.marker.source, 'claimed');

    const contestedTab = {
      id: 2,
      windowId: 1,
      index: 3,
      active: false,
      discarded: true,
      url: 'https://contested.example/'
    };
    liveTabs.set(2, contestedTab);
    await ownership.claim(contestedTab);
    contested.add(2);

    await assert.rejects(discard.takeover(clone(contestedTab), {manual: true}), /already discarded|takeover failed/);
    state = await ownership.status(2);
    assert.equal(state.marker.source, 'contended');
    assert.equal(liveTabs.get(2).discarded, true);
    assert.deepEqual(calls.slice(-4), ['reload:2:false', 'stop:2', 'stop:2', 'discard:2']);
    assert.equal(alarmListeners.length, 0);
    assert.equal(scheduledAlarms.size, 0);
    const contendedCallCount = calls.length;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls.length, contendedCallCount);
    assert.equal(hasTakeover(2), false);

    contested.delete(2);
    const manualRetry = discard.takeover(clone(contestedTab), {manual: true});
    await waitForNative('manual retry');
    assert.deepEqual(calls.slice(-4), ['reload:2:false', 'stop:2', 'stop:2', 'discard:2']);
    finishNative();
    assert.equal(await manualRetry, true);
    state = await ownership.status(2);
    assert.equal(state.marker.source, 'self');

    const claimedTakeoverTab = async (id, url) => {
      const tab = {
        id,
        windowId: 1,
        index: id,
        active: false,
        discarded: true,
        status: 'unloaded',
        url
      };
      liveTabs.set(id, tab);
      await ownership.claim(tab);
      return tab;
    };
    const updatedListenerBaseline = listeners.updated.length;
    let callStart;
    const assertFailedTakeoverClean = async id => {
      assert.equal(discard.waitForTakeover(id), undefined, `tab ${id} must not retain a takeover job`);
      assert.equal((await ownership.status(id)).marker, undefined, `tab ${id} must not retain ownership`);
      assert.equal(listeners.updated.length, updatedListenerBaseline,
        `tab ${id} must remove its reload observer`);
    };

    // Cancellation can arrive while queueTakeover is still waiting for its
    // first tabs.get. Once cancelTakeover returns, releasing that stale read
    // must not recreate a durable takeover-queued marker or schedule a reload.
    const cancelledBeforePersistence = await claimedTakeoverTab(
      41,
      'https://cancel-before-persistence.example/'
    );
    holdGetId = cancelledBeforePersistence.id;
    callStart = calls.length;
    const prePersistenceTakeover = discard.takeover(
      clone(cancelledBeforePersistence),
      {manual: true}
    ).catch(() => false);
    const heldGetDeadline = Date.now() + 1000;
    while (!releaseHeldGet && Date.now() < heldGetDeadline) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(typeof releaseHeldGet, 'function');
    assert.equal(await discard.cancelTakeover(cancelledBeforePersistence.id), true);
    assert.equal(hasTakeover(cancelledBeforePersistence.id), false);
    assert.equal((await ownership.status(cancelledBeforePersistence.id)).marker, undefined);
    releaseHeldGet();
    assert.equal(await prePersistenceTakeover, false);
    assert.equal((await ownership.status(cancelledBeforePersistence.id)).marker, undefined);
    assert.equal(calls.slice(callStart).some(call => call.startsWith('reload:41:')), false);

    // Cancel while the wake navigation's first stop script is still pending.
    // Cleanup performs one fresh stop, waits out loading, and leaves the tab
    // awake/unowned instead of handing release an immortal spinner.
    const cancelledWake = await claimedTakeoverTab(35, 'https://cancelled-wake.example/');
    stopMode = 'pending-once';
    discard.stopTimeout = 10;
    discard.cancellationSettleTimeout = 100;
    callStart = calls.length;
    const cancelledWakeTakeover = discard.takeover(clone(cancelledWake), {manual: true}).catch(() => false);
    const cancelDeadline = Date.now() + 1000;
    while (!calls.slice(callStart).includes('stop:35') && Date.now() < cancelDeadline) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(calls.slice(callStart).includes('stop:35'), true);
    assert.equal(await discard.cancelTakeover(35), true);
    assert.equal(await cancelledWakeTakeover, false);
    assert.deepEqual(calls.slice(callStart), ['reload:35:false', 'stop:35', 'stop:35']);
    assert.equal(liveTabs.get(35).discarded, false);
    assert.equal(liveTabs.get(35).status, 'complete');
    await assertFailedTakeoverClean(35);
    discard.stopTimeout = 1000;

    // tabs.reload starts navigation before its callback settles. Cancellation
    // during that API gap still observes the delayed loading transition, stops
    // it, and never leaves release racing a second wake.
    const callbackGap = await claimedTakeoverTab(36, 'https://callback-gap.example/');
    reloadMode = 'callback-gap';
    discard.takeoverTimeout = 30;
    discard.reloadStartGrace = 20;
    discard.stopTimeout = 20;
    discard.cancellationSettleTimeout = 100;
    callStart = calls.length;
    const callbackGapTakeover = discard.takeover(clone(callbackGap), {manual: true}).catch(() => false);
    const reloadDeadline = Date.now() + 1000;
    while (!calls.slice(callStart).includes('reload:36:false') && Date.now() < reloadDeadline) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(typeof finishReloadCallback, 'function');
    assert.deepEqual(discard.takeoverScheduler.snapshot().resources, {
      cpu: {active: 0, limit: 2},
      network: {active: 1, limit: 4}
    }, 'the reload callback gap must consume only the network/RAM budget');
    let callbackGapReleaseSettled = false;
    const callbackGapRelease = releasePhaseTarget(callbackGap).then(result => {
      callbackGapReleaseSettled = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve));
    assert.equal(callbackGapReleaseSettled, false,
      'release must join cleanup while the wake callback is still pending');
    await callbackGapRelease;
    assert.equal(await callbackGapTakeover, false);
    assert.deepEqual(calls.slice(callStart), ['reload:36:false', 'stop:36']);
    await assertReleaseInvariant(callbackGap);
    finishReloadCallback?.();
    finishReloadCallback = undefined;
    await assertFailedTakeoverClean(36);
    reloadMode = 'normal';
    discard.takeoverTimeout = 200;
    discard.reloadStartGrace = 0;
    discard.stopTimeout = 1000;

    // The marker can be visible in the renderer before executeScript resolves.
    // Release must carry the pre-published exact token through that pending
    // promise, roll the write back once, and leave the already-awake tab alone.
    const markerPending = await claimedTakeoverTab(130, 'https://marker-pending.example/');
    localState.favicon = true;
    preparationCalls.delete(markerPending.id);
    holdMarkerPreparation = {id: markerPending.id, call: 2};
    const markerBoundary = new Promise(resolve => {
      markerPreparationReached = resolve;
    });
    discard.stopTimeout = 30;
    discard.cancellationSettleTimeout = 100;
    callStart = calls.length;
    const markerPendingTakeover = discard.takeover(
      clone(markerPending),
      {manual: true}
    ).catch(() => false);
    const markerReached = await Promise.race([
      markerBoundary.then(() => true),
      new Promise(resolve => setTimeout(resolve, 1000, false))
    ]);
    assert.equal(markerReached, true, 'marker preparation boundary must be reached');
    assert.equal(liveTabs.get(markerPending.id).visualMarked, true);
    assert.equal(liveTabs.get(markerPending.id).faviconMarked, true);
    assert.equal(liveTabs.get(markerPending.id).title.startsWith('\u{1F4A4}'), true);
    const markerRollbackBaseline = markerRollbacks;
    await releasePhaseTarget(markerPending);
    assert.equal(await markerPendingTakeover, false);
    assert.deepEqual(calls.slice(callStart), [
      'reload:130:false', 'stop:130', 'stop:130'
    ]);
    assert.equal(markerRollbacks, markerRollbackBaseline + 1,
      'pending marker preparation must be rolled back exactly once');
    await assertReleaseInvariant(markerPending);
    delete localState.favicon;
    discard.stopTimeout = 1000;

    // Reset is stronger than a marker clear: it cancels a wake during the
    // reload callback gap plus an independently running same-window native
    // discard, waits for settlement, and only then erases ownership state.
    const resetRunning = await claimedTakeoverTab(39, 'https://reset-running.example/');
    const resetQueued = await claimedTakeoverTab(40, 'https://reset-queued.example/');
    reloadMode = 'callback-gap';
    discard.takeoverTimeout = 30;
    discard.reloadStartGrace = 20;
    discard.stopTimeout = 20;
    discard.cancellationSettleTimeout = 100;
    callStart = calls.length;
    const resetRunningTakeover = discard.takeover(clone(resetRunning), {manual: true}).catch(() => false);
    const resetReloadDeadline = Date.now() + 1000;
    while (!calls.slice(callStart).includes('reload:39:false') && Date.now() < resetReloadDeadline) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(calls.slice(callStart).includes('reload:39:false'), true);
    const resetQueuedTakeover = discard.takeover(clone(resetQueued), {manual: true}).catch(() => false);
    const resetQueueDeadline = Date.now() + 1000;
    while ((await ownership.status(40)).marker?.state !== 'takeover-queued' && Date.now() < resetQueueDeadline) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(discard.takeoverSnapshot().find(job => job.id === 40)?.started, true,
      'non-pulsing discarded work in one window is allowed to run concurrently');
    let preferencesCleared = false;
    const resetOperation = resetExtensionState(ownership, {
      clear(callback) {
        preferencesCleared = true;
        callback();
      }
    }, discard.cancelTakeovers);
    await Promise.resolve();
    finishNative?.();
    const resetResult = await resetOperation;
    assert.equal(preferencesCleared, true);
    assert.equal(resetResult.total > 0, true);
    assert.equal(await resetRunningTakeover, false);
    assert.equal(await resetQueuedTakeover, false);
    assert.deepEqual(discard.takeoverSnapshot(), []);
    assert.equal(discard.takeoverScheduler.snapshot().queued, 0);
    assert.equal(liveTabs.get(39).discarded, false);
    assert.equal(liveTabs.get(39).status, 'complete');
    assert.equal(liveTabs.get(40).discarded, true,
      'an already-issued native call may finish physically during reset');
    const resetOwnership = await ownership.snapshot();
    assert.equal(Object.values(resetOwnership).every(marker =>
      marker.state === 'owned' && marker.source === 'claimed' && marker.attemptId === null), true,
    'reset must rebuild sleepers only as fresh external claims, never old self/pending authority');
    finishReloadCallback?.();
    finishReloadCallback = undefined;
    reloadMode = 'normal';
    discard.takeoverTimeout = 200;
    discard.reloadStartGrace = 0;
    discard.stopTimeout = 1000;

    // A renderer handoff can remove the outgoing frame between the tab status
    // read and executeScript. Once that rejected promise settles, retrying on
    // the replacement frame is safe and must still reach an unloaded discard.
    const frameHandoff = await claimedTakeoverTab(19, 'https://frame-handoff.example/');
    stopMode = 'frame-removed-once';
    callStart = calls.length;
    const frameHandoffTakeover = discard.takeover(clone(frameHandoff), {manual: true});
    await waitForNative('frame handoff takeover');
    assert.deepEqual(calls.slice(callStart), [
      'reload:19:false', 'stop:19', 'stop:19', 'stop:19', 'discard:19'
    ]);
    finishNative();
    assert.equal(await frameHandoffTakeover, true);
    assert.equal(listeners.updated.length, updatedListenerBaseline);

    const notReady = await claimedTakeoverTab(26, 'https://frame-not-ready.example/');
    stopMode = 'frame-not-ready-once';
    callStart = calls.length;
    const notReadyTakeover = discard.takeover(clone(notReady), {manual: true});
    await waitForNative('not-ready frame handoff');
    assert.deepEqual(calls.slice(callStart), [
      'reload:26:false', 'stop:26', 'stop:26', 'stop:26', 'discard:26'
    ]);
    finishNative();
    assert.equal(await notReadyTakeover, true);
    assert.equal(listeners.updated.length, updatedListenerBaseline);

    for (const [id, mode, label] of [
      [32, 'no-frame-colon-once', 'colon no-frame handoff'],
      [33, 'no-frame-tab-once', 'tab-id no-frame handoff']
    ]) {
      const noFrame = await claimedTakeoverTab(id, `https://no-frame-${id}.example/`);
      stopMode = mode;
      callStart = calls.length;
      const noFrameTakeover = discard.takeover(clone(noFrame), {manual: true});
      await waitForNative(label);
      assert.deepEqual(calls.slice(callStart), [
        `reload:${id}:false`, `stop:${id}`, `stop:${id}`, `stop:${id}`, `discard:${id}`
      ]);
      finishNative();
      assert.equal(await noFrameTakeover, true);
      assert.equal(listeners.updated.length, updatedListenerBaseline);
    }

    // A frame can also disappear during the final title pass. Re-enter
    // quiescence and retry that settled rejection without waking twice.
    const finalFrameHandoff = await claimedTakeoverTab(27, 'https://final-frame-handoff.example/');
    stopMode = 'frame-removed-final';
    finalFrameStopCalls = 0;
    callStart = calls.length;
    const finalFrameTakeover = discard.takeover(clone(finalFrameHandoff), {manual: true});
    await waitForNative('final frame handoff');
    assert.deepEqual(calls.slice(callStart), [
      'reload:27:false', 'stop:27', 'stop:27', 'stop:27', 'discard:27'
    ]);
    finishNative();
    assert.equal(await finalFrameTakeover, true);
    assert.equal(listeners.updated.length, updatedListenerBaseline);

    // Final visual preparation is not the short reload-stop operation. Hidden
    // Chromium renderers can delay favicon work past stopTimeout even though it
    // remains safely inside prepareTimeout and the overall takeover deadline.
    const delayedFinalMarker = await claimedTakeoverTab(131, 'https://delayed-final-marker.example/');
    localState.favicon = true;
    preparationCalls.delete(delayedFinalMarker.id);
    delayedFinalPreparation = {delay: 30, id: delayedFinalMarker.id};
    discard.stopTimeout = 10;
    discard.prepareTimeout = 100;
    discard.takeoverTimeout = 200;
    callStart = calls.length;
    const delayedFinalTakeover = discard.takeover(clone(delayedFinalMarker), {manual: true});
    await waitForNative('delayed final marker takeover');
    assert.deepEqual(calls.slice(callStart), [
      'reload:131:false', 'stop:131', 'stop:131', 'discard:131'
    ]);
    finishNative();
    assert.equal(await delayedFinalTakeover, true);
    const delayedFinalOwnership = (await ownership.status(delayedFinalMarker.id)).marker;
    assert.equal(delayedFinalOwnership.source, 'self');
    assert.equal(delayedFinalOwnership.visual.complete, true);
    assert.equal(delayedFinalOwnership.visual.favicon, true);
    assert.equal(delayedFinalOwnership.visual.title, true);
    delete localState.favicon;
    discard.stopTimeout = 1000;
    discard.prepareTimeout = 5000;

    // A final pass that never resolves is still bounded by prepareTimeout,
    // never reaches native discard, and invokes exact-token rollback once.
    const expiredFinalMarker = await claimedTakeoverTab(132, 'https://expired-final-marker.example/');
    localState.favicon = true;
    preparationCalls.delete(expiredFinalMarker.id);
    holdMarkerPreparation = {call: 2, id: expiredFinalMarker.id};
    discard.stopTimeout = 10;
    discard.prepareTimeout = 30;
    discard.takeoverTimeout = 100;
    const expiredRollbackBaseline = markerRollbacks;
    callStart = calls.length;
    await assert.rejects(
      discard.takeover(clone(expiredFinalMarker), {manual: true}),
      /timed out preparing/
    );
    assert.deepEqual(calls.slice(callStart), [
      'reload:132:false', 'stop:132', 'stop:132'
    ]);
    assert.equal(markerRollbacks, expiredRollbackBaseline + 1);
    await assertFailedTakeoverClean(expiredFinalMarker.id);
    delete localState.favicon;
    discard.stopTimeout = 1000;
    discard.prepareTimeout = 5000;
    discard.takeoverTimeout = 200;

    // Transient retries are capped, while an error-page injection failure is
    // deliberately outside the whitelist and remains immediately fatal.
    const repeatedFrameHandoff = await claimedTakeoverTab(28, 'https://repeated-frame-handoff.example/');
    stopMode = 'frame-removed-always';
    callStart = calls.length;
    await assert.rejects(discard.takeover(clone(repeatedFrameHandoff), {manual: true}),
      /transient frame retry limit/);
    assert.deepEqual(calls.slice(callStart), ['reload:28:false', 'stop:28', 'stop:28', 'stop:28']);
    await assertFailedTakeoverClean(28);

    const errorPage = await claimedTakeoverTab(29, 'https://error-page.example/');
    stopMode = 'error-page';
    callStart = calls.length;
    await assert.rejects(discard.takeover(clone(errorPage), {manual: true}), /showing error page/);
    assert.deepEqual(calls.slice(callStart), ['reload:29:false', 'stop:29']);
    await assertFailedTakeoverClean(29);

    // A timed-out injection remains in flight, so takeover must fail after one
    // stop attempt instead of queuing late injections or calling native discard.
    const pendingStop = await claimedTakeoverTab(20, 'https://pending-stop.example/');
    stopMode = 'pending';
    discard.stopTimeout = 10;
    discard.takeoverTimeout = 40;
    callStart = calls.length;
    await assert.rejects(discard.takeover(clone(pendingStop), {manual: true}), /timed out stopping/);
    assert.deepEqual(calls.slice(callStart), ['reload:20:false', 'stop:20']);
    await assertFailedTakeoverClean(20);

    // Permanent injection failures and user activation both abort before the
    // native discard boundary.
    const rejectedStop = await claimedTakeoverTab(21, 'https://rejected-stop.example/');
    stopMode = 'reject';
    callStart = calls.length;
    await assert.rejects(discard.takeover(clone(rejectedStop), {manual: true}), /cannot stop the reload/);
    assert.deepEqual(calls.slice(callStart), ['reload:21:false', 'stop:21']);
    await assertFailedTakeoverClean(21);

    const activatedStop = await claimedTakeoverTab(22, 'https://activated-stop.example/');
    stopMode = 'activate';
    callStart = calls.length;
    await assert.rejects(discard.takeover(clone(activatedStop), {manual: true}), /quiescent inactive/);
    assert.deepEqual(calls.slice(callStart), ['reload:22:false', 'stop:22']);
    await assertFailedTakeoverClean(22);
    activatedStop.active = false;

    // Non-loading is not enough: only status:complete can cross into native
    // discard. A delayed loading transition must also be observed and stopped.
    const invalidStatus = await claimedTakeoverTab(23, 'https://invalid-status.example/');
    stopMode = 'invalid-status';
    callStart = calls.length;
    await assert.rejects(discard.takeover(clone(invalidStatus), {manual: true}), /quiescent inactive/);
    assert.deepEqual(calls.slice(callStart), ['reload:23:false', 'stop:23']);
    await assertFailedTakeoverClean(23);

    const delayedLoading = await claimedTakeoverTab(24, 'https://delayed-loading.example/');
    stopMode = 'normal';
    reloadMode = 'delayed-loading';
    discard.reloadStartGrace = 100;
    discard.takeoverTimeout = 300;
    callStart = calls.length;
    const delayedTakeover = discard.takeover(clone(delayedLoading), {manual: true});
    await waitForNative('delayed loading takeover');
    assert.deepEqual(calls.slice(callStart), ['reload:24:false', 'stop:24', 'stop:24', 'discard:24']);
    finishNative();
    assert.equal(await delayedTakeover, true);

    // A callback that says discarded:true while status is still loading is not
    // strong self-ownership and must fail rather than producing a false tag.
    const falseSuccess = await claimedTakeoverTab(25, 'https://false-success.example/');
    reloadMode = 'normal';
    nativeFinalStatus = 'loading';
    discard.nativeSettleTimeout = 30;
    discard.reloadStartGrace = 0;
    const savedFalseSuccessFence = discard.takeoverFenceTimeout;
    discard.takeoverFenceTimeout = 30;
    callStart = calls.length;
    const falseTakeover = discard.takeover(clone(falseSuccess), {manual: true});
    await waitForNative('false native success takeover');
    finishNative();
    await assert.rejects(falseTakeover, /native discard timed out/);
    assert.deepEqual(calls.slice(callStart), ['reload:25:false', 'stop:25', 'stop:25', 'discard:25']);
    assert.notEqual((await ownership.status(25)).marker?.source, 'self');
    assert.ok(discard.waitForTakeover(25),
      'accepted native work stays fenced until an authoritative browser boundary');
    activateLiveTab(25);
    for (let i = 0; i < 100 && hasTakeover(25); i += 1) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(discard.waitForTakeover(25), undefined);
    liveTabs.get(25).active = false;
    discard.takeoverFenceTimeout = savedFalseSuccessFence;
    assert.equal(listeners.updated.length, updatedListenerBaseline);

    // A transient missing live read during Edge replacement is not proof of
    // failure. The callback clone is still never trusted; the next live reads
    // must establish the authoritative unloaded state.
    const missingFreshRead = await claimedTakeoverTab(34, 'https://missing-fresh-read.example/');
    nativeFinalStatus = 'unloaded';
    callStart = calls.length;
    const missingFreshTakeover = discard.takeover(clone(missingFreshRead), {manual: true});
    await waitForNative('missing fresh-read takeover');
    missingPostDiscardGets = 1;
    finishNative();
    assert.equal(await missingFreshTakeover, true);
    assert.deepEqual(calls.slice(callStart), ['reload:34:false', 'stop:34', 'stop:34', 'discard:34']);
    assert.equal((await ownership.status(34)).marker?.source, 'self');
    assert.equal(discard.waitForTakeover(34), undefined);
    assert.equal(listeners.updated.length, updatedListenerBaseline);

    // The callback can carry a valid unloaded clone even though the live tab
    // was activated before callback delivery. A mandatory fresh read rejects it.
    const wakeBeforeCallback = await claimedTakeoverTab(30, 'https://wake-before-callback.example/');
    nativeFinalStatus = 'unloaded';
    nativeWakeBeforeCallback = true;
    discard.nativeSettleTimeout = 100;
    callStart = calls.length;
    const staleCallbackTakeover = discard.takeover(clone(wakeBeforeCallback), {manual: true});
    await waitForNative('stale callback takeover');
    finishNative();
    await assert.rejects(staleCallbackTakeover, /did not settle in the browser discard state/);
    assert.deepEqual(calls.slice(callStart), ['reload:30:false', 'stop:30', 'stop:30', 'discard:30']);
    assert.equal(liveTabs.get(30).active, true);
    await assertFailedTakeoverClean(30);
    liveTabs.get(30).active = false;

    // The mandatory second stable read closes the smaller wake race between
    // the first live read and the marker write (before finalization when the
    // activation arrives early enough, otherwise in confirmSelf).
    const wakeDuringFinalization = await claimedTakeoverTab(31, 'https://wake-during-finalization.example/');
    callStart = calls.length;
    const finalizationRace = discard.takeover(clone(wakeDuringFinalization), {manual: true});
    await waitForNative('ownership-finalization race');
    wakeOnPostDiscardGet = 2;
    finishNative();
    await assert.rejects(finalizationRace,
      /did not settle in the browser discard state|woke during ownership finalization/);
    assert.deepEqual(calls.slice(callStart), ['reload:31:false', 'stop:31', 'stop:31', 'discard:31']);
    assert.equal(liveTabs.get(31).active, true);
    await assertFailedTakeoverClean(31);
  }
  finally {
    delayedLoadingTimers.forEach(clearTimeout);
    delete globalThis.chrome;
  }
});
