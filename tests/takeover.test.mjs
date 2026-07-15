import test from 'node:test';
import assert from 'node:assert/strict';

import {releaseDiscardedTargets, runScopedCommand} from '../v3/worker/core/command-scope.mjs';

test('performs a real reload and native rediscard before recording self ownership', async () => {
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

  const clone = value => value && JSON.parse(JSON.stringify(value));
  const event = name => ({
    addListener(listener) {
      listeners[name].push(listener);
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
        callback(clone(liveTabs.get(id)));
      },
      reload(id, options, callback) {
        calls.push(`reload:${id}:${options.bypassCache}`);
        const tab = liveTabs.get(id);
        tab.discarded = false;
        tab.status = 'loading';
        emitUpdated(id, {discarded: false, status: 'loading'});
        callback();
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
          tab.status = 'unloaded';
          emitUpdated(id, {discarded: true, status: 'unloaded'});
          callback(clone(tab));
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
    discard.takeoverCooldown = 5;

    let settled = false;
    const command = runScopedCommand({
      command: 'discard-tabs',
      selected: {id: 99, index: 0},
      shiftKey: false,
      query: async () => [clone(liveTabs.get(1))],
      resolveFresh: ownership.resolveFresh,
      check: async () => assert.fail('already-discarded takeover must not use the eligibility check'),
      discard: async () => assert.fail('takeover must use its low-level native discard path'),
      takeover: discard.takeover,
      reload: async () => assert.fail('discard command must not use the release path')
    }).then(result => {
      settled = true;
      return result;
    });

    while (!finishNative) {
      await new Promise(resolve => setTimeout(resolve));
    }
    assert.equal(settled, false);
    assert.deepEqual(calls, ['reload:1:false', 'discard:1']);

    finishNative();
    const result = await command;
    assert.deepEqual(result.takeovers.map(tab => tab.id), [1]);
    assert.equal(liveTabs.get(1).discarded, true);
    let state = await ownership.status(1);
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
      takeover: discard.takeover,
      reload: async () => {}
    });
    assert.deepEqual(repeat.alreadyOwned.map(tab => tab.id), [1]);
    assert.equal(calls.length, callCount);

    const automatic = {
      id: 3,
      windowId: 1,
      index: 4,
      active: false,
      discarded: true,
      url: 'https://automatic.example/'
    };
    liveTabs.set(3, automatic);
    emitUpdated(3, {discarded: true});
    while (!finishNative) {
      await new Promise(resolve => setTimeout(resolve));
    }
    assert.deepEqual(calls.slice(-2), ['reload:3:false', 'discard:3']);
    finishNative();
    while (discard.takeoverJobs.has(3)) {
      await new Promise(resolve => setTimeout(resolve));
    }
    state = await ownership.status(3);
    assert.equal(state.marker.source, 'self');

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
    const startupTakeover = discard.takeoverExisting();
    while (!finishNative) {
      await new Promise(resolve => setTimeout(resolve));
    }
    assert.deepEqual(calls.slice(-2), ['reload:4:false', 'discard:4']);
    finishNative();
    assert.ok((await startupTakeover).every(Boolean));
    state = await ownership.status(4);
    assert.equal(state.marker.source, 'self');

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
    const headTakeover = discard.takeover(clone(queueHead));
    while (!finishNative) {
      await new Promise(resolve => setTimeout(resolve));
    }
    const cancelledQueuedTakeover = discard.takeover(clone(queuedRelease)).catch(() => false);
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
    const racingTakeover = discard.takeover(clone(releaseRace));
    while (!finishNative) {
      await new Promise(resolve => setTimeout(resolve));
    }
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
    emitUpdated(6, {url: lateUrl.url});
    while (!finishNative) {
      await new Promise(resolve => setTimeout(resolve));
    }
    assert.deepEqual(calls.slice(-2), ['reload:6:false', 'discard:6']);
    finishNative();
    while (discard.takeoverJobs.has(6)) {
      await new Promise(resolve => setTimeout(resolve));
    }
    state = await ownership.status(6);
    assert.equal(state.marker.source, 'self');

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

    await assert.rejects(discard.takeover(clone(contestedTab)), /already discarded|takeover failed/);
    state = await ownership.status(2);
    assert.equal(state.marker.source, 'contended');
    assert.ok(state.marker.retryAfter > Date.now());
    assert.equal(liveTabs.get(2).discarded, true);
    assert.deepEqual(calls.slice(-2), ['reload:2:false', 'discard:2']);

    scheduledAlarms.clear();
    assert.deepEqual(await discard.takeoverExisting(), []);
    const retryName = 'discard.takeover.retry.2';
    assert.equal(scheduledAlarms.get(retryName).when, state.marker.retryAfter);
    contested.delete(2);
    while (Date.now() < state.marker.retryAfter) {
      await new Promise(resolve => setTimeout(resolve));
    }
    alarmListeners.forEach(listener => listener({name: retryName}));
    while (!finishNative) {
      await new Promise(resolve => setTimeout(resolve));
    }
    assert.deepEqual(calls.slice(-2), ['reload:2:false', 'discard:2']);
    finishNative();
    while (discard.takeoverJobs.has(2)) {
      await new Promise(resolve => setTimeout(resolve));
    }
    state = await ownership.status(2);
    assert.equal(state.marker.source, 'self');
  }
  finally {
    delete globalThis.chrome;
  }
});
