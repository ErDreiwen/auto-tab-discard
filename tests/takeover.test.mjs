import test from 'node:test';
import assert from 'node:assert/strict';

import {
  releaseDiscardedTargets,
  runDirectDiscardCommand,
  runScopedCommand
} from '../v3/worker/core/command-scope.mjs';
import {tabsForGroupCommand} from '../v3/worker/core/group.mjs';

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
    created: [],
    removed: [],
    replaced: [],
    updated: []
  };
  const calls = [];
  const contested = new Set();
  const alarmListeners = [];
  const scheduledAlarms = new Map();
  let finishNative;
  let ignoredStops = 1;
  let nativeFinalStatus = 'unloaded';
  let nativeWakeBeforeCallback = false;
  let missingPostDiscardGets = 0;
  let wakeOnPostDiscardGet = 0;
  let reloadMode = 'normal';
  let stopMode = 'normal';
  let finalFrameStopCalls = 0;
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
      executeScript({target}) {
        calls.push(`stop:${target.tabId}`);
        const tab = liveTabs.get(target.tabId);
        if (stopMode === 'pending') {
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
        if (tab && tab.status === 'complete') {
          tab.title = '💤 test';
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
          callback(defaults);
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
    tabs: {
      query(options, callback) {
        callback([...liveTabs.values()].filter(tab => {
          return (!('discarded' in options) || tab.discarded === options.discarded) &&
            (!('active' in options) || tab.active === options.active);
        }).map(clone));
      },
      get(id, callback) {
        const tab = liveTabs.get(id);
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
      reload(id, options, callback) {
        calls.push(`reload:${id}:${options.bypassCache}`);
        const tab = liveTabs.get(id);
        tab.discarded = false;
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
      discard(id, callback) {
        calls.push(`discard:${id}`);
        const tab = liveTabs.get(id);
        if (contested.has(id)) {
          tab.discarded = true;
          emitUpdated(id, {discarded: true});
          chrome.runtime.lastError = {message: 'tab is already discarded'};
          callback();
          chrome.runtime.lastError = null;
          return;
        }
        finishNative = () => {
          finishNative = undefined;
          tab.discarded = true;
          tab.status = nativeFinalStatus;
          emitUpdated(id, {discarded: true, status: nativeFinalStatus});
          const result = clone(tab);
          if (nativeWakeBeforeCallback) {
            nativeWakeBeforeCallback = false;
            tab.active = true;
            tab.discarded = false;
            tab.status = 'complete';
            emitUpdated(id, {discarded: false, status: 'complete'});
          }
          callback(result);
        };
      },
      onUpdated: event('updated'),
      onCreated: event('created'),
      onAttached: event('created'),
      onRemoved: event('removed'),
      onReplaced: event('replaced')
    }
  };

  try {
    const [{discard}, {ownership}] = await Promise.all([
      import('../v3/worker/core/discard.mjs'),
      import('../v3/worker/core/ownership.mjs')
    ]);
    discard.nativeTimeout = 200;
    discard.getTimeout = 100;
    discard.takeoverTimeout = 200;
    discard.takeoverPoll = 0;
    discard.takeoverRetries = 1;
    discard.quiesceDwell = 0;
    discard.reloadStartGrace = 0;

    const adopted = await runScopedCommand({
      adopt: ownership.adopt,
      command: 'discard-tabs',
      selected: {id: 99, index: 0},
      shiftKey: false,
      query: async () => [clone(liveTabs.get(1))],
      resolveFresh: ownership.resolveFresh,
      check: async () => assert.fail('already-discarded adoption must not use the eligibility check'),
      discard: async () => assert.fail('adoption must not use the normal discard pipeline'),
      takeover: async () => assert.fail('normal command must not wake the discarded tab'),
      reload: async () => assert.fail('discard command must not use the release path')
    });
    assert.deepEqual(adopted.takeovers.map(tab => tab.id), [1]);
    assert.deepEqual(calls, []);
    assert.equal(liveTabs.get(1).discarded, true);
    let state = await ownership.status(1);
    assert.equal(state.marker.state, 'owned');
    assert.equal(state.marker.source, 'adopted');

    const repeatedAdoption = await runScopedCommand({
      adopt: async () => assert.fail('an adopted tab must be a no-op'),
      command: 'discard-tabs',
      selected: {id: 99, index: 0},
      shiftKey: false,
      query: async () => [clone(liveTabs.get(1))],
      resolveFresh: ownership.resolveFresh,
      check: async () => {},
      discard: async () => true,
      takeover: async () => assert.fail('repeat normal command must not wake the tab'),
      reload: async () => {}
    });
    assert.deepEqual(repeatedAdoption.alreadyOwned.map(tab => tab.id), [1]);
    assert.deepEqual(calls, []);

    let settled = false;
    const command = runScopedCommand({
      adopt: async () => assert.fail('Shift must physically upgrade an adopted tab'),
      command: 'discard-tabs',
      selected: {id: 99, index: 0},
      shiftKey: true,
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

    await waitForNative('initial Shift takeover');
    assert.equal(settled, false);
    assert.ok(discard.waitForTakeover(1));
    assert.deepEqual(calls, ['reload:1:false', 'stop:1', 'stop:1', 'stop:1', 'discard:1']);

    finishNative();
    const result = await command;
    assert.equal(discard.waitForTakeover(1), undefined);
    assert.deepEqual(result.takeovers.map(tab => tab.id), [1]);
    assert.equal(liveTabs.get(1).discarded, true);
    state = await ownership.status(1);
    assert.equal(state.marker.state, 'owned');
    assert.equal(state.marker.source, 'self');

    const callCount = calls.length;
    const repeat = await runScopedCommand({
      adopt: async () => assert.fail('Shift repeat must not adopt a self-owned tab'),
      command: 'discard-tabs',
      selected: {id: 99, index: 0},
      shiftKey: true,
      query: async () => [clone(liveTabs.get(1))],
      resolveFresh: ownership.resolveFresh,
      check: async () => {},
      discard: async () => true,
      takeover: tab => discard.takeover(tab, {manual: true}),
      reload: async () => {}
    });
    assert.deepEqual(repeat.alreadyOwned.map(tab => tab.id), [1]);
    assert.equal(calls.length, callCount);

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
    const normalGroup = await runDirectDiscardCommand({
      activate: async () => assert.fail('an all-discarded group does not need a keeper'),
      adopt: ownership.adopt,
      allTabs: groupTabs,
      command: 'discard-tree',
      discard: async () => assert.fail('already-discarded group members stay unloaded'),
      inProgress: () => false,
      notifyNoKeeper: () => assert.fail('an inactive discarded group is not blocked'),
      resolveFresh: ownership.resolveFresh,
      selected: groupTabs[0],
      shiftKey: false,
      takeover: async () => assert.fail('normal group command must not reload'),
      targets: groupTargets
    });
    assert.deepEqual(normalGroup.adopted.map(tab => tab.id), [40, 41, 42]);
    assert.equal(calls.length, groupCallStart);
    for (const id of [40, 41, 42]) {
      assert.equal((await ownership.status(id)).marker.source, 'adopted');
      assert.equal(liveTabs.get(id).discarded, true);
    }
    assert.equal((await ownership.status(43)).marker, undefined);

    await runDirectDiscardCommand({
      activate: async () => assert.fail('repeat adoption does not need a keeper'),
      adopt: async () => assert.fail('repeat adoption must be a no-op'),
      allTabs: groupTabs,
      command: 'discard-tree',
      discard: async () => assert.fail('repeat adoption must be a no-op'),
      inProgress: () => false,
      notifyNoKeeper: () => assert.fail('repeat adoption is not blocked'),
      resolveFresh: ownership.resolveFresh,
      selected: groupTabs[0],
      shiftKey: false,
      takeover: async () => assert.fail('repeat adoption must not reload'),
      targets: groupTargets
    });
    assert.equal(calls.length, groupCallStart);

    const forcedGroup = runDirectDiscardCommand({
      activate: async () => assert.fail('inactive group takeover does not need a keeper'),
      adopt: async () => assert.fail('Shift must physically upgrade adopted group members'),
      allTabs: groupTabs,
      command: 'discard-tree',
      discard: async () => assert.fail('adopted group members use the takeover path'),
      inProgress: () => false,
      notifyNoKeeper: () => assert.fail('inactive group takeover is not blocked'),
      resolveFresh: ownership.resolveFresh,
      selected: groupTabs[0],
      shiftKey: true,
      takeover: tab => discard.takeover(tab, {manual: true}),
      targets: groupTargets
    });
    for (const id of [40, 41, 42]) {
      await waitForNative('queued takeover');
      assert.deepEqual(calls.slice(-4), [`reload:${id}:false`, `stop:${id}`, `stop:${id}`, `discard:${id}`]);
      finishNative();
    }
    await forcedGroup;
    for (const id of [40, 41, 42]) {
      assert.equal((await ownership.status(id)).marker.source, 'self');
    }
    assert.equal((await ownership.status(43)).marker, undefined);
    const forcedGroupCallCount = calls.length;
    await runDirectDiscardCommand({
      activate: async () => assert.fail('repeat Shift does not need a keeper'),
      adopt: async () => assert.fail('repeat Shift does not adopt'),
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
    assert.equal(calls.length, forcedGroupCallCount);

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
    assert.equal(discard.takeoverJobs.has(3), false);
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
    let queuedReleaseSettled = false;
    const queuedReleaseCommand = releaseDiscardedTargets(
      'release-tabs',
      [clone(queuedRelease)],
      (tab, options) => new Promise(resolve => chrome.tabs.reload(tab.id, options, resolve)),
      {bypassCache: false},
      tab => discard.cancelTakeover(tab.id, tab.discarded === true),
      tab => new Promise(resolve => chrome.tabs.get(tab.id, resolve))
    ).then(result => {
      queuedReleaseSettled = true;
      return result;
    });
    while (!queuedReleaseSettled) {
      await new Promise(resolve => setTimeout(resolve));
    }
    assert.equal(calls.at(-1), 'reload:8:false');
    assert.equal(liveTabs.get(8).discarded, false);
    finishNative();
    assert.equal(await headTakeover, true);
    assert.equal(await cancelledQueuedTakeover, false);
    await queuedReleaseCommand;

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
    discard.nativeTimeout = 5;
    discard.takeoverFenceTimeout = 100;
    const racingTakeover = discard.takeover(clone(releaseRace), {manual: true});
    await waitForNative('joined takeover');
    await new Promise(resolve => setTimeout(resolve, 10));
    let releaseSettled = false;
    const release = releaseDiscardedTargets(
      'release-tabs',
      [clone(releaseRace)],
      (tab, options) => new Promise(resolve => chrome.tabs.reload(tab.id, options, resolve)),
      {bypassCache: false},
      tab => discard.cancelTakeover(tab.id, tab.discarded === true),
      tab => new Promise(resolve => chrome.tabs.get(tab.id, resolve))
    ).then(result => {
      releaseSettled = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve));
    assert.equal(releaseSettled, false);
    assert.equal(calls.at(-1), 'discard:5');
    finishNative();
    await racingTakeover.catch(() => false);
    await release;
    assert.equal(calls.at(-1), 'reload:5:false');
    assert.equal(liveTabs.get(5).discarded, false);
    state = await ownership.status(5);
    assert.equal(state.marker, undefined);
    const postReleaseCallCount = calls.length;
    liveTabs.get(5).discarded = true;
    liveTabs.get(5).status = 'unloaded';
    emitUpdated(5, {discarded: true, status: 'unloaded'});
    state = await ownership.status(5);
    assert.equal(calls.length, postReleaseCallCount);
    assert.equal(discard.takeoverJobs.has(5), false);
    assert.equal(state.marker.source, 'claimed');
    discard.nativeTimeout = 200;

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
    assert.equal(discard.takeoverJobs.has(6), false);
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
    sessionState.__discardOwnership[2] = {
      state: 'owned',
      source: 'claimed',
      attemptId: null,
      updatedAt: 2
    };
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
    assert.equal(discard.takeoverJobs.has(2), false);

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
    const assertFailedTakeoverClean = async id => {
      assert.equal(discard.waitForTakeover(id), undefined, `tab ${id} must not retain a takeover job`);
      assert.equal((await ownership.status(id)).marker, undefined, `tab ${id} must not retain ownership`);
      assert.equal(listeners.updated.length, updatedListenerBaseline,
        `tab ${id} must remove its reload observer`);
    };

    // A renderer handoff can remove the outgoing frame between the tab status
    // read and executeScript. Once that rejected promise settles, retrying on
    // the replacement frame is safe and must still reach an unloaded discard.
    const frameHandoff = await claimedTakeoverTab(19, 'https://frame-handoff.example/');
    stopMode = 'frame-removed-once';
    let callStart = calls.length;
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
    callStart = calls.length;
    const falseTakeover = discard.takeover(clone(falseSuccess), {manual: true});
    await waitForNative('false native success takeover');
    finishNative();
    await assert.rejects(falseTakeover, /did not settle in the unloaded state/);
    assert.deepEqual(calls.slice(callStart), ['reload:25:false', 'stop:25', 'stop:25', 'discard:25']);
    assert.notEqual((await ownership.status(25)).marker?.source, 'self');
    assert.equal(discard.waitForTakeover(25), undefined);
    assert.equal(listeners.updated.length, updatedListenerBaseline);

    // A missing mandatory live read must not restore the callback clone or
    // persist a false self marker.
    const missingFreshRead = await claimedTakeoverTab(34, 'https://missing-fresh-read.example/');
    nativeFinalStatus = 'unloaded';
    callStart = calls.length;
    const missingFreshTakeover = discard.takeover(clone(missingFreshRead), {manual: true});
    await waitForNative('missing fresh-read takeover');
    missingPostDiscardGets = 1;
    finishNative();
    await assert.rejects(missingFreshTakeover, /did not settle in the unloaded state/);
    assert.deepEqual(calls.slice(callStart), ['reload:34:false', 'stop:34', 'stop:34', 'discard:34']);
    assert.notEqual((await ownership.status(34)).marker?.source, 'self');
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
    await assert.rejects(staleCallbackTakeover, /did not settle in the unloaded state/);
    assert.deepEqual(calls.slice(callStart), ['reload:30:false', 'stop:30', 'stop:30', 'discard:30']);
    assert.equal(liveTabs.get(30).active, true);
    await assertFailedTakeoverClean(30);
    liveTabs.get(30).active = false;

    // A second fresh read, serialized after ownership finalization, closes the
    // smaller wake race between the first live read and the marker write.
    const wakeDuringFinalization = await claimedTakeoverTab(31, 'https://wake-during-finalization.example/');
    callStart = calls.length;
    const finalizationRace = discard.takeover(clone(wakeDuringFinalization), {manual: true});
    await waitForNative('ownership-finalization race');
    wakeOnPostDiscardGet = 2;
    finishNative();
    await assert.rejects(finalizationRace, /woke during ownership finalization/);
    assert.deepEqual(calls.slice(callStart), ['reload:31:false', 'stop:31', 'stop:31', 'discard:31']);
    assert.equal(liveTabs.get(31).active, true);
    await assertFailedTakeoverClean(31);
  }
  finally {
    delayedLoadingTimers.forEach(clearTimeout);
    delete globalThis.chrome;
  }
});
