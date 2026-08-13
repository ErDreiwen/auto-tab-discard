import test from 'node:test';
import assert from 'node:assert/strict';

test('waits for tabs.discard before releasing the next queued job', async () => {
  let active = 0;
  let maximum = 0;
  const completed = [];
  let prepends = '';
  let favicon = false;
  const sessionState = {};
  const storedMarker = id => sessionState[`__discardOwnership:tab:${id}`]?.marker;
  const pendingAtNativeCall = [];
  const liveTabs = new Map([
    [1, {id: 1, active: false, discarded: false, status: 'complete'}],
    [2, {id: 2, active: false, discarded: false, status: 'complete'}]
  ]);
  const tabListeners = {
    created: [],
    removed: [],
    replaced: [],
    updated: []
  };

  globalThis.chrome = {
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
          callback({
            ...defaults,
            prepends,
            favicon,
            'simultaneous-jobs': 1
          });
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
        callback([...liveTabs.values()]);
      },
      onCreated: {
        addListener(listener) {
          tabListeners.created.push(listener);
        }
      },
      onRemoved: {
        addListener(listener) {
          tabListeners.removed.push(listener);
        }
      },
      onUpdated: {
        addListener(listener) {
          tabListeners.updated.push(listener);
        }
      },
      onReplaced: {
        addListener(listener) {
          tabListeners.replaced.push(listener);
        }
      },
      get(id, callback) {
        callback(liveTabs.get(id));
      },
      async discard(id) {
        pendingAtNativeCall.push(storedMarker(id)?.state);
        active += 1;
        maximum = Math.max(maximum, active);
        return new Promise(resolve => setTimeout(() => {
          active -= 1;
          completed.push(id);
          const tab = {...liveTabs.get(id), discarded: true, status: 'unloaded'};
          liveTabs.set(id, tab);
          tabListeners.updated.forEach(listener => listener(id, {
            discarded: true,
            status: 'unloaded'
          }, tab));
          resolve(tab);
        }, 10));
      }
    }
  };

  try {
    const [{discard, inprogress}, {ownership}] = await Promise.all([
      import('../v3/worker/core/discard.mjs'),
      import('../v3/worker/core/ownership.mjs')
    ]);

    const results = await Promise.all([
      discard({id: 1, active: false, discarded: false}),
      discard({id: 2, active: false, discarded: false})
    ]);

    assert.deepEqual(completed, [1, 2]);
    assert.deepEqual(results.map(result => result.status), ['succeeded', 'succeeded']);
    assert.equal(results.every(result => result.ok === true && /native discard settled/.test(result.reason)), true);
    assert.equal(maximum, 1);
    assert.equal(discard.count, 0);
    assert.equal(inprogress.size, 0);
    assert.deepEqual(pendingAtNativeCall, ['pending', 'pending']);
    assert.equal(storedMarker(1).source, 'self');
    assert.equal(storedMarker(2).source, 'self');

    // A replacement while an ordinary job is waiting for the concurrency
    // slot must migrate both its lock and queued snapshot. Once the head
    // settles, the successor runs exactly once and leaves no predecessor or
    // successor reservation behind.
    const replacementHead = {id: 60, active: false, discarded: false, status: 'complete'};
    const replacementQueued = {id: 61, active: false, discarded: false, status: 'complete'};
    const replacementSuccessor = {...replacementQueued, id: 62};
    liveTabs.set(replacementHead.id, replacementHead);
    liveTabs.set(replacementQueued.id, replacementQueued);
    let releaseHead;
    const originalDiscard = chrome.tabs.discard;
    chrome.tabs.discard = async id => {
      pendingAtNativeCall.push(storedMarker(id)?.state);
      if (id === replacementHead.id) {
        await new Promise(resolve => { releaseHead = resolve; });
      }
      const tab = {...liveTabs.get(id), discarded: true, status: 'unloaded'};
      liveTabs.set(id, tab);
      tabListeners.updated.forEach(listener => listener(id, {
        discarded: true,
        status: 'unloaded'
      }, tab));
      completed.push(id);
      return tab;
    };
    const headPromise = discard({...replacementHead});
    const queuedPromise = discard({...replacementQueued});
    while (typeof releaseHead !== 'function') {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    liveTabs.delete(replacementQueued.id);
    liveTabs.set(replacementSuccessor.id, replacementSuccessor);
    for (const listener of tabListeners.replaced) {
      listener(replacementSuccessor.id, replacementQueued.id);
    }
    releaseHead();
    const replacementResults = await Promise.all([headPromise, queuedPromise]);
    assert.deepEqual(replacementResults.map(result => result.status), ['succeeded', 'succeeded']);
    assert.equal(completed.filter(id => id === replacementSuccessor.id).length, 1);
    assert.equal(inprogress.has(replacementQueued.id), false);
    assert.equal(inprogress.has(replacementSuccessor.id), false);
    assert.equal(discard.tabs.length, 0);
    assert.equal(storedMarker(replacementSuccessor.id).source, 'self');
    chrome.tabs.discard = originalDiscard;

    chrome.tabs.discard = async id => {
      const tab = {id, active: false, discarded: true, status: 'unloaded'};
      liveTabs.set(id, tab);
      tabListeners.updated.forEach(listener => listener(id, {
        discarded: true,
        status: 'unloaded'
      }, tab));
    };
    chrome.tabs.get = (id, callback) => callback(liveTabs.get(id));
    assert.equal((await discard.perform({id: 3})).status, 'succeeded');
    assert.equal(storedMarker(3).source, 'self');

    prepends = 'sleep:';
    discard.prepareTimeout = 10;
    chrome.scripting = {
      executeScript: async () => [{result: 'async'}]
    };
    chrome.tabs.sendMessage = () => {};
    liveTabs.set(4, {id: 4, active: false, discarded: false, status: 'complete'});
    assert.equal((await discard({id: 4, active: false, discarded: false})).status, 'succeeded');
    assert.equal(inprogress.size, 0);
    assert.deepEqual(storedMarker(4).visual, {
      complete: false,
      favicon: true,
      repair: true,
      title: false,
      titleMarker: 'sleep:'
    });

    // A successful preparation persists visual completeness independently of
    // physical ownership. Takeover/repeat commands can therefore distinguish a
    // real native discard from a missing title/favicon marker.
    prepends = '';
    favicon = true;
    chrome.scripting.executeScript = async details => {
      assert.equal(details.func.name, 'prepareDocumentMarker');
      assert.equal(details.args[0].favicon, true);
      return [{result: {
        complete: true,
        faviconApplied: true,
        stopped: true,
        titleApplied: true,
        top: true
      }}];
    };
    liveTabs.set(44, {id: 44, active: false, discarded: false, status: 'complete'});
    assert.equal((await discard({id: 44, active: false, discarded: false})).status, 'succeeded');
    assert.deepEqual(storedMarker(44).visual, {
      complete: true,
      favicon: true,
      repair: true,
      title: true
    });

    // A persisted direct-native intent is authoritative even when Edge's live
    // snapshot temporarily looks like a normal loaded tab. Ordinary discard
    // must return before renderer preparation and before a second native call.
    const transitional = {
      id: 43,
      active: false,
      discarded: false,
      frozen: false,
      status: 'complete'
    };
    liveTabs.set(transitional.id, transitional);
    assert.ok(await ownership.beginDirectNative(transitional));
    let transitionalScripts = 0;
    let transitionalNativeCalls = 0;
    const priorScript = chrome.scripting.executeScript;
    const priorDiscard = chrome.tabs.discard;
    chrome.scripting.executeScript = async (...args) => {
      transitionalScripts += 1;
      return priorScript(...args);
    };
    chrome.tabs.discard = async (...args) => {
      transitionalNativeCalls += 1;
      return priorDiscard(...args);
    };
    const blocked = await discard(transitional);
    assert.equal(blocked.status, 'skipped');
    assert.match(blocked.reason, /direct native discard.*settling/i);
    assert.equal(transitionalScripts, 0);
    assert.equal(transitionalNativeCalls, 0);
    chrome.scripting.executeScript = priorScript;
    chrome.tabs.discard = priorDiscard;
    await ownership.invalidate(transitional.id);

    // The metadata collector owns a per-tab renderer lease until its probe is
    // done. An ordinary discard invoked during that lease must fail closed at
    // the synchronous interlock, before marker injection or native discard.
    const rendererGuarded = {
      id: 42,
      active: false,
      discarded: false,
      frozen: false,
      status: 'complete'
    };
    liveTabs.set(rendererGuarded.id, rendererGuarded);
    let releaseRendererGuard;
    const heldRendererGuard = discard.withRendererGuard(
      rendererGuarded.id,
      () => new Promise(resolve => releaseRendererGuard = resolve)
    );
    let guardedScripts = 0;
    let guardedNativeCalls = 0;
    const guardedScript = chrome.scripting.executeScript;
    const guardedNative = chrome.tabs.discard;
    chrome.scripting.executeScript = (...args) => {
      guardedScripts += 1;
      return guardedScript(...args);
    };
    chrome.tabs.discard = (...args) => {
      guardedNativeCalls += 1;
      return guardedNative(...args);
    };
    const guardedResult = await discard(rendererGuarded);
    assert.equal(guardedResult.status, 'skipped');
    assert.match(guardedResult.reason, /already in progress/i);
    assert.equal(guardedScripts, 0);
    assert.equal(guardedNativeCalls, 0);
    await Promise.resolve();
    releaseRendererGuard();
    await heldRendererGuard;
    chrome.scripting.executeScript = guardedScript;
    chrome.tabs.discard = guardedNative;

    discard.nativeTimeout = 10;
    discard.takeoverFenceTimeout = 10;
    discard.getTimeout = 10;
    chrome.tabs.discard = id => new Promise(() => {
      tabListeners.updated.forEach(listener => listener(id, {discarded: true}, {
        id,
        windowId: 1,
        url: 'https://timeout.example/',
        discarded: true
      }));
    });
    chrome.tabs.get = () => {};
    assert.equal((await discard.perform({
      id: 5,
      windowId: 1,
      url: 'https://timeout.example/',
      discarded: false
    })).status, 'failed');
    assert.equal(storedMarker(5).state, 'late-native');
    // The unresolved API Promise retains durable/job authority but no repeating
    // polling timer (this standalone test must exit naturally with it pending).
    // Release remains fail-closed and leaves the same discoverable fence.
    discard.releaseNativeFenceTimeout = 2;
    await assert.rejects(discard.cancelTakeover(5),
      /native discard operation is still pending/);
    assert.equal(discard.takeoverSnapshot().some(job => job.id === 5), true);

    const edgeOriginal = {
      id: 6,
      windowId: 2,
      active: false,
      discarded: false,
      status: 'complete',
      url: 'https://edge-perform.example/'
    };
    const edgeSuccessor = {...edgeOriginal, id: 60, discarded: true, status: 'unloaded'};
    const edgeTabs = new Map([[edgeOriginal.id, edgeOriginal]]);
    chrome.tabs.get = (id, callback) => callback(edgeTabs.get(id));
    chrome.tabs.discard = async id => {
      assert.equal(id, edgeOriginal.id);
      edgeTabs.delete(edgeOriginal.id);
      edgeTabs.set(edgeSuccessor.id, edgeSuccessor);
      tabListeners.replaced.forEach(listener => listener(edgeSuccessor.id, edgeOriginal.id));
      tabListeners.updated.forEach(listener => listener(
        edgeSuccessor.id,
        {discarded: true, status: 'unloaded'},
        edgeSuccessor
      ));
      return edgeSuccessor;
    };
    discard.nativeTimeout = 100;
    discard.getTimeout = 100;
    assert.equal((await discard.perform(edgeOriginal)).status, 'succeeded');
    assert.equal(ownership.resolveId(edgeOriginal.id), edgeSuccessor.id);
    assert.equal((await ownership.status(edgeOriginal.id)).marker.source, 'self');
    assert.equal(storedMarker(edgeOriginal.id), undefined);
    assert.equal(storedMarker(edgeSuccessor.id).source, 'self');

    // A successful native callback and first discarded read are not enough:
    // activation in the following task wakes the tab and must turn the command
    // into a truthful failure without retaining a transient self marker.
    const activationRace = {
      id: 49,
      windowId: 4,
      active: false,
      discarded: false,
      status: 'complete',
      url: 'https://activation-race.example/'
    };
    liveTabs.set(activationRace.id, activationRace);
    chrome.tabs.discard = async id => {
      const tab = {...liveTabs.get(id), discarded: true, status: 'unloaded'};
      liveTabs.set(id, tab);
      return tab;
    };
    let activationReads = 0;
    chrome.tabs.get = (id, callback) => {
      callback(liveTabs.get(id));
      if (id === activationRace.id && activationReads++ === 0) {
        queueMicrotask(() => liveTabs.set(id, {
          ...liveTabs.get(id),
          active: true,
          discarded: false,
          status: 'complete'
        }));
      }
    };
    assert.equal((await discard.perform(activationRace)).status, 'failed');
    assert.notEqual((await ownership.status(activationRace.id)).marker?.source, 'self');

    // A Promise-shaped native call can settle after both timeout fences. The
    // immediate command remains a truthful failure, then the exact late call
    // promotes its stable unloaded tab from claimed/empty to self ownership so
    // a repeat command will not wake and rediscard it.
    const late = {
      id: 45,
      windowId: 3,
      active: false,
      discarded: false,
      status: 'complete',
      url: 'https://late-native.example/'
    };
    liveTabs.set(late.id, late);
    chrome.tabs.get = (id, callback) => callback(liveTabs.get(id));
    let finishLate;
    chrome.tabs.discard = () => new Promise(resolve => finishLate = resolve);
    discard.nativeTimeout = 5;
    discard.takeoverFenceTimeout = 5;
    discard.getTimeout = 20;
    discard.nativeSettleTimeout = 50;
    assert.equal((await discard.perform(late)).status, 'failed');
    assert.equal(typeof finishLate, 'function');
    Object.assign(late, {discarded: true, status: 'unloaded'});
    tabListeners.updated.forEach(listener => listener(late.id, {
      discarded: true,
      status: 'unloaded'
    }, late));
    finishLate();
    const lateDeadline = Date.now() + 500;
    while ((await ownership.status(late.id)).marker?.source !== 'self' && Date.now() < lateDeadline) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal((await ownership.status(late.id)).marker?.source, 'self');

    // Release/cancellation renews the identity generation. The old native
    // Promise may still finish physically, but it cannot restore self ownership.
    const cancelledLate = {
      id: 46,
      active: false,
      discarded: false,
      status: 'complete'
    };
    liveTabs.set(cancelledLate.id, cancelledLate);
    let finishCancelledLate;
    chrome.tabs.discard = () => new Promise(resolve => finishCancelledLate = resolve);
    assert.equal((await discard.perform(cancelledLate)).status, 'failed');
    assert.equal((await ownership.status(cancelledLate.id)).marker?.state, 'late-native');
    await ownership.invalidate(cancelledLate.id);
    Object.assign(cancelledLate, {discarded: true, status: 'unloaded'});
    tabListeners.updated.forEach(listener => listener(cancelledLate.id, {
      discarded: true,
      status: 'unloaded'
    }, cancelledLate));
    finishCancelledLate();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.notEqual((await ownership.status(cancelledLate.id)).marker?.source, 'self');

    // Removing and immediately reusing a numeric tab id also renews authority.
    const reusedLate = {
      id: 47,
      active: false,
      discarded: false,
      status: 'complete'
    };
    liveTabs.set(reusedLate.id, reusedLate);
    let finishReusedLate;
    chrome.tabs.discard = () => new Promise(resolve => finishReusedLate = resolve);
    assert.equal((await discard.perform(reusedLate)).status, 'failed');
    liveTabs.delete(reusedLate.id);
    tabListeners.removed.forEach(listener => listener(reusedLate.id));
    const replacementIdentity = {...reusedLate, url: 'https://new-identity.example/'};
    liveTabs.set(replacementIdentity.id, replacementIdentity);
    tabListeners.created.forEach(listener => listener(replacementIdentity));
    finishReusedLate({...reusedLate, discarded: true, status: 'unloaded'});
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.notEqual((await ownership.status(replacementIdentity.id)).marker?.source, 'self');

    // Reset advances the global epoch and permanently fences every detached
    // completion from the prior ownership session.
    const resetLate = {
      id: 48,
      active: false,
      discarded: false,
      status: 'complete'
    };
    liveTabs.set(resetLate.id, resetLate);
    let finishResetLate;
    chrome.tabs.discard = () => new Promise(resolve => finishResetLate = resolve);
    assert.equal((await discard.perform(resetLate)).status, 'failed');
    await ownership.reset();
    Object.assign(resetLate, {discarded: true, status: 'unloaded'});
    finishResetLate();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await ownership.snapshot())[resetLate.id], undefined);
  }
  finally {
    delete globalThis.chrome;
  }
});
