import test from 'node:test';
import assert from 'node:assert/strict';

test('tags self discards, claims external discards, and rejects stale attempts', async () => {
  const sessionState = {};
  const listeners = {};
  let liveTabs = [];
  let failWrites = 0;
  let failNextQuery = false;
  let holdNextWrite = false;
  let releaseWrite;

  const write = (apply, callback) => {
    if (failWrites > 0) {
      failWrites -= 1;
      chrome.runtime.lastError = {message: 'temporary storage failure'};
      callback();
      chrome.runtime.lastError = null;
    }
    else if (holdNextWrite) {
      holdNextWrite = false;
      releaseWrite = () => {
        releaseWrite = undefined;
        apply();
        callback();
      };
    }
    else {
      apply();
      callback();
    }
  };

  const event = name => ({
    addListener(listener) {
      listeners[name] = listener;
    }
  });

  globalThis.chrome = {
    runtime: {
      lastError: null
    },
    storage: {
      session: {
        get(defaults, callback) {
          callback({...defaults, ...sessionState});
        },
        set(values, callback) {
          write(() => Object.assign(sessionState, values), callback);
        },
        remove(key, callback) {
          write(() => delete sessionState[key], callback);
        }
      },
      local: {}
    },
    tabs: {
      query(options, callback) {
        if (failNextQuery) {
          failNextQuery = false;
          chrome.runtime.lastError = {message: 'temporary query failure'};
          callback([]);
          chrome.runtime.lastError = null;
          return;
        }
        callback(liveTabs);
      },
      get(id, callback) {
        callback(liveTabs.find(tab => tab.id === id));
      },
      onUpdated: event('updated'),
      onCreated: event('created'),
      onAttached: event('attached'),
      onRemoved: event('removed'),
      onReplaced: event('replaced')
    }
  };

  try {
    const {ownership} = await import('../v3/worker/core/ownership.mjs');

    const external = {
      id: 10,
      windowId: 1,
      url: 'https://external.example/',
      discarded: true
    };
    listeners.updated(external.id, {discarded: true}, external);
    let state = await ownership.snapshot();
    assert.equal(state[external.id].state, 'owned');
    assert.equal(state[external.id].source, 'claimed');

    listeners.updated(external.id, {discarded: false}, {...external, discarded: false});
    state = await ownership.snapshot();
    assert.equal(state[external.id], undefined);

    const concurrent = [30, 31].map(id => ({
      id,
      windowId: 3,
      url: `https://concurrent-${id}.example/`,
      discarded: true
    }));
    await Promise.all(concurrent.map(tab => ownership.claim(tab)));
    state = await ownership.snapshot();
    assert.equal(state[30].source, 'claimed');
    assert.equal(state[31].source, 'claimed');

    const freshSnapshot = {
      id: 32,
      windowId: 3,
      url: 'https://fresh-snapshot.example/',
      discarded: true
    };
    liveTabs = [freshSnapshot];
    assert.ok(await ownership.claimFresh({...freshSnapshot}));
    state = await ownership.snapshot();
    assert.equal(state[freshSnapshot.id].source, 'claimed');
    await ownership.invalidate(freshSnapshot.id);

    // A popup query can become stale before its command is handled. The live
    // tab read must win so an already-awake or removed tab is never re-tagged.
    const staleSnapshot = {
      id: 33,
      windowId: 3,
      url: 'https://stale-snapshot.example/',
      discarded: true
    };
    liveTabs = [{...staleSnapshot, discarded: false}];
    let resolution = await ownership.resolveFresh(staleSnapshot);
    assert.equal(resolution.state, 'loaded');
    assert.equal(resolution.tab.discarded, false);
    liveTabs = [];
    resolution = await ownership.resolveFresh(staleSnapshot);
    assert.equal(resolution.state, 'missing');
    state = await ownership.snapshot();
    assert.equal(state[staleSnapshot.id], undefined);

    const failedFreshClaim = {
      id: 34,
      windowId: 3,
      url: 'https://failed-fresh-claim.example/',
      discarded: true
    };
    liveTabs = [failedFreshClaim];
    failWrites = 3;
    resolution = await ownership.resolveFresh(failedFreshClaim);
    assert.equal(resolution.state, 'discarded');
    assert.match(resolution.error.message, /temporary storage failure/);
    state = await ownership.snapshot();
    assert.equal(state[failedFreshClaim.id], undefined);

    const attached = {
      id: 35,
      windowId: 4,
      url: 'https://attached.example/',
      discarded: true
    };
    liveTabs = [attached];
    await ownership.claim(attached);
    liveTabs = [{...attached, discarded: false}];
    listeners.attached(attached.id);
    await new Promise(resolve => setTimeout(resolve));
    state = await ownership.snapshot();
    assert.equal(state[attached.id], undefined);

    const attachedDiscarded = {...attached, id: 36, discarded: true};
    liveTabs = [attachedDiscarded];
    listeners.attached(attachedDiscarded.id);
    await new Promise(resolve => setTimeout(resolve));
    state = await ownership.snapshot();
    assert.equal(state[attachedDiscarded.id].source, 'claimed');

    const replacement = {...attached, id: 37, discarded: true};
    liveTabs = [replacement];
    listeners.replaced(replacement.id, attachedDiscarded.id);
    await new Promise(resolve => setTimeout(resolve));
    state = await ownership.snapshot();
    assert.equal(state[attachedDiscarded.id], undefined);
    assert.equal(state[replacement.id].source, 'claimed');

    const navigated = {...concurrent[0], url: 'https://navigated.example/'};
    await ownership.observe(30, {url: navigated.url}, navigated);
    state = await ownership.snapshot();
    assert.equal(state[30].source, 'claimed');

    const awake = {
      id: 11,
      windowId: 1,
      url: 'https://self.example/',
      discarded: false
    };
    const attemptId = await ownership.begin(awake);
    state = await ownership.snapshot();
    assert.equal(state[awake.id].state, 'pending');

    const selfDiscarded = {...awake, discarded: true};
    listeners.updated(awake.id, {discarded: true}, selfDiscarded);
    state = await ownership.snapshot();
    assert.equal(state[awake.id].state, 'pending');

    assert.equal(await ownership.finish(selfDiscarded, attemptId, 'self'), true);
    state = await ownership.snapshot();
    assert.equal(state[awake.id].state, 'owned');
    assert.equal(state[awake.id].source, 'self');

    const moved = {...selfDiscarded, windowId: 9};
    await ownership.claim(moved);
    state = await ownership.snapshot();
    assert.equal(state[awake.id].source, 'self');

    const storageFailure = {
      id: 13,
      windowId: 1,
      url: 'https://storage-failure.example/',
      discarded: false
    };
    failWrites = 1;
    const storageFailureAttempt = await ownership.begin(storageFailure);
    assert.equal(typeof storageFailureAttempt, 'string');
    assert.equal(await ownership.finish({...storageFailure, discarded: true}, storageFailureAttempt, 'self'), true);
    state = await ownership.snapshot();
    assert.equal(state[storageFailure.id].source, 'self');

    const finishFailure = {
      id: 14,
      windowId: 1,
      url: 'https://finish-retry.example/',
      discarded: false
    };
    const finishFailureAttempt = await ownership.begin(finishFailure);
    failWrites = 1;
    assert.equal(await ownership.finish({...finishFailure, discarded: true}, finishFailureAttempt, 'self'), true);
    state = await ownership.snapshot();
    assert.equal(state[finishFailure.id].state, 'owned');
    assert.equal(state[finishFailure.id].source, 'self');

    const lateObserved = {
      id: 15,
      windowId: 1,
      url: 'https://late-observed.example/',
      discarded: false
    };
    const lateAttempt = await ownership.begin(lateObserved);
    holdNextWrite = true;
    const lateFinish = ownership.finish(lateObserved, lateAttempt, undefined);
    while (!releaseWrite) {
      await new Promise(resolve => setTimeout(resolve));
    }
    await ownership.claim({...lateObserved, discarded: true});
    releaseWrite();
    assert.equal(await lateFinish, true);
    state = await ownership.snapshot();
    assert.equal(state[lateObserved.id].source, 'claimed');

    const exhausted = {
      id: 16,
      windowId: 1,
      url: 'https://retry-after-failure.example/',
      discarded: false
    };
    const exhaustedAttempt = await ownership.begin(exhausted);
    failWrites = 2;
    await assert.rejects(ownership.finish(exhausted, exhaustedAttempt, undefined), /temporary storage failure/);
    await ownership.snapshot();
    const nextAttempt = await ownership.begin(exhausted);
    assert.equal(typeof nextAttempt, 'string');
    await ownership.invalidate(exhausted.id);

    const stale = {
      id: 12,
      windowId: 1,
      url: 'https://stale.example/',
      discarded: false
    };
    const staleAttempt = await ownership.begin(stale);
    listeners.updated(stale.id, {discarded: false}, stale);
    assert.equal(await ownership.finish({...stale, discarded: true}, staleAttempt, 'self'), false);
    state = await ownership.snapshot();
    assert.equal(state[stale.id], undefined);

    liveTabs = [{
      id: 20,
      windowId: 2,
      url: 'https://restored.example/',
      discarded: true
    }];
    failNextQuery = true;
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(await ownership.start(2, 0), 1);
    }
    finally {
      console.warn = warn;
    }
    state = await ownership.snapshot();
    assert.equal(state[20].source, 'claimed');
    assert.equal(state[awake.id], undefined);

    listeners.removed(20);
    state = await ownership.snapshot();
    assert.equal(state[20], undefined);
  }
  finally {
    delete globalThis.chrome;
  }
});
