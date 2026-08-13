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
  let holdNextGet = false;
  let releaseGet;

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
        if (holdNextGet) {
          holdNextGet = false;
          releaseGet = value => {
            releaseGet = undefined;
            callback(value);
          };
        }
        else {
          callback(liveTabs.find(tab => tab.id === id));
        }
      },
      onUpdated: event('updated'),
      onActivated: event('activated'),
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

    const adoptable = {
      id: 38,
      windowId: 1,
      url: 'https://adoptable.example/',
      discarded: true
    };
    liveTabs = [adoptable];
    await ownership.claim(adoptable);
    assert.equal(await ownership.adopt(adoptable), true);
    assert.equal(await ownership.adopt(adoptable), true);
    state = await ownership.snapshot();
    assert.equal(state[adoptable.id].source, 'adopted');
    liveTabs = [{...adoptable, discarded: false}];
    assert.equal((await ownership.adopt(adoptable)).state, 'loaded');
    listeners.updated(adoptable.id, {discarded: false}, liveTabs[0]);
    state = await ownership.snapshot();
    assert.equal(state[adoptable.id], undefined);

    const staleAdoption = {
      id: 41,
      windowId: 1,
      url: 'https://stale-adoption.example/',
      discarded: true
    };
    liveTabs = [staleAdoption];
    holdNextWrite = true;
    const adoptionInFlight = ownership.adopt(staleAdoption);
    while (!releaseWrite) {
      await new Promise(resolve => setTimeout(resolve));
    }
    holdNextGet = true;
    releaseWrite();
    while (!releaseGet) {
      await new Promise(resolve => setTimeout(resolve));
    }
    const newerAttempt = await ownership.begin({...staleAdoption, discarded: false});
    assert.equal(await ownership.finish(staleAdoption, newerAttempt, 'self'), true);
    releaseGet({...staleAdoption, discarded: false});
    const staleOutcome = await adoptionInFlight;
    assert.equal(staleOutcome.state, 'loaded');
    state = await ownership.snapshot();
    assert.equal(state[staleAdoption.id].source, 'self');

    // Removing an identity is allowed to delete its generation entry. A unique
    // token still fences a late read if Chromium immediately reuses the number.
    const removedIdentity = {
      id: 60,
      windowId: 1,
      url: 'https://removed-identity.example/',
      discarded: true
    };
    liveTabs = [removedIdentity];
    holdNextGet = true;
    const removedAdoption = ownership.adopt(removedIdentity);
    while (!releaseGet) {
      await new Promise(resolve => setTimeout(resolve));
    }
    liveTabs = [];
    listeners.removed(removedIdentity.id);
    const reusedIdentity = {
      ...removedIdentity,
      url: 'https://reused-identity.example/'
    };
    liveTabs = [reusedIdentity];
    listeners.created(reusedIdentity);
    listeners.updated(reusedIdentity.id, {discarded: true}, reusedIdentity);
    releaseGet(removedIdentity);
    assert.equal((await removedAdoption).retry, true);
    await ownership.reconcile();
    state = await ownership.snapshot();
    assert.equal(state[reusedIdentity.id].source, 'claimed');

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

    const attachedAdopted = {...attached, id: 40, discarded: true};
    liveTabs = [attachedAdopted];
    await ownership.claim(attachedAdopted);
    assert.equal(await ownership.adopt(attachedAdopted), true);
    const attachedAdoptedMarker = (await ownership.status(attachedAdopted.id)).marker;
    listeners.attached(attachedAdopted.id);
    await new Promise(resolve => setTimeout(resolve));
    state = await ownership.snapshot();
    assert.deepEqual(state[attachedAdopted.id], attachedAdoptedMarker);

    // Moving a queued takeover to another window must retain its durable MV3
    // recovery anchor. The in-memory scheduler rekeys separately; if the worker
    // dies afterward, startup still needs this exact explicit request.
    const attachedQueued = {...attached, id: 41, discarded: true};
    liveTabs = [attachedQueued];
    const attachedQueueId = await ownership.queueTakeover(attachedQueued);
    assert.equal(typeof attachedQueueId, 'string');
    listeners.attached(attachedQueued.id);
    state = await ownership.snapshot();
    assert.equal(state[attachedQueued.id].state, 'takeover-queued');
    assert.equal(state[attachedQueued.id].attemptId, attachedQueueId);

    // Attachment also must not downgrade an unresolved late native operation
    // to an external claim. Its generation-fenced reconciler or the next fresh
    // claim remains responsible for promoting it to self ownership.
    const attachedLate = {...attached, id: 44, discarded: false};
    liveTabs = [attachedLate];
    const attachedLateAttempt = await ownership.begin(attachedLate);
    assert.equal(typeof attachedLateAttempt, 'string');
    assert.equal(await ownership.finish(attachedLate, attachedLateAttempt, undefined, {
      allowClaimed: false,
      lateNative: true
    }), false);
    liveTabs = [{...attachedLate, discarded: true, status: 'unloaded'}];
    listeners.attached(attachedLate.id);
    state = await ownership.snapshot();
    assert.equal(state[attachedLate.id].state, 'late-native');
    assert.equal(state[attachedLate.id].attemptId, attachedLateAttempt);

    // A stale loaded result from an attachment must not cancel a newer discard
    // attempt that started while tabs.get was pending.
    const attachedAttemptRace = {...attached, id: 42, discarded: true};
    liveTabs = [attachedAttemptRace];
    await ownership.claim(attachedAttemptRace);
    assert.equal(await ownership.adopt(attachedAttemptRace), true);
    holdNextGet = true;
    listeners.attached(attachedAttemptRace.id);
    while (!releaseGet) {
      await new Promise(resolve => setTimeout(resolve));
    }
    const attachedAttemptAwake = {...attachedAttemptRace, discarded: false};
    const newerAttachedAttempt = ownership.begin(attachedAttemptAwake);
    releaseGet(attachedAttemptAwake);
    const attachedAttemptId = await newerAttachedAttempt;
    assert.equal(typeof attachedAttemptId, 'string');
    const attachedAttemptDiscarded = {...attachedAttemptAwake, discarded: true};
    liveTabs = [attachedAttemptDiscarded];
    assert.equal(await ownership.finish(attachedAttemptDiscarded, attachedAttemptId, 'self'), true);
    state = await ownership.snapshot();
    assert.equal(state[attachedAttemptRace.id].source, 'self');
    assert.equal(state[attachedAttemptRace.id].attemptId, attachedAttemptId);

    // The same stale attachment read must run before, rather than erase, a
    // newer external-discard claim queued in the read gap.
    const attachedClaimRace = {...attached, id: 43, discarded: true};
    liveTabs = [attachedClaimRace];
    await ownership.claim(attachedClaimRace);
    assert.equal(await ownership.adopt(attachedClaimRace), true);
    holdNextGet = true;
    listeners.attached(attachedClaimRace.id);
    while (!releaseGet) {
      await new Promise(resolve => setTimeout(resolve));
    }
    const newerAttachedClaim = ownership.claim(attachedClaimRace);
    releaseGet({...attachedClaimRace, discarded: false});
    assert.ok(await newerAttachedClaim);
    state = await ownership.snapshot();
    assert.equal(state[attachedClaimRace.id].source, 'claimed');

    // Edge replaces the tab id while tabs.discard() is in flight. Preserve the
    // same pending nonce through a replacement chain so a callback carrying the
    // original id can still finalize self-ownership on the live successor.
    const edgeOriginal = {
      id: 44,
      windowId: 5,
      url: 'https://edge-replacement.example/',
      active: false,
      discarded: false,
      status: 'complete'
    };
    liveTabs = [edgeOriginal];
    const edgeAttempt = await ownership.begin(edgeOriginal);
    const edgeMiddle = {...edgeOriginal, id: 45, discarded: true, status: 'unloaded'};
    liveTabs = [edgeMiddle];
    listeners.replaced(edgeMiddle.id, edgeOriginal.id);
    const edgeFinal = {...edgeMiddle, id: 46};
    liveTabs = [edgeFinal];
    listeners.replaced(edgeFinal.id, edgeMiddle.id);
    let edgeStatus = await ownership.status(edgeOriginal.id);
    assert.equal(edgeStatus.attemptId, edgeAttempt);
    assert.equal((await ownership.status(edgeFinal.id)).attemptId, edgeAttempt);
    listeners.updated(edgeFinal.id, {discarded: true, status: 'unloaded'}, edgeFinal);
    assert.equal(await ownership.finish(
      {...edgeOriginal, discarded: true, status: 'unloaded'}, edgeAttempt, 'self'
    ), true);
    assert.equal(await ownership.confirmSelf(edgeOriginal.id, edgeAttempt), true);
    assert.equal(ownership.resolveId(edgeOriginal.id), edgeFinal.id);
    state = await ownership.snapshot();
    assert.equal(state[edgeOriginal.id], undefined);
    assert.equal(state[edgeMiddle.id], undefined);
    assert.equal(state[edgeFinal.id].source, 'self');
    edgeStatus = await ownership.status(edgeOriginal.id);
    assert.equal(edgeStatus.marker.source, 'self');

    // Edge can replace a tab after an explicit takeover was durably queued but
    // before its in-memory scheduler begins. The successor must retain the same
    // queue nonce so MV3 restart recovery does not lose the user's command.
    const queuedReplacementOriginal = {
      ...edgeOriginal,
      id: 56,
      discarded: true,
      status: 'unloaded',
      url: 'https://queued-replacement.example/'
    };
    liveTabs = [queuedReplacementOriginal];
    const queuedReplacementId = await ownership.queueTakeover(queuedReplacementOriginal);
    const queuedReplacementSuccessor = {...queuedReplacementOriginal, id: 57};
    liveTabs = [queuedReplacementSuccessor];
    listeners.replaced(queuedReplacementSuccessor.id, queuedReplacementOriginal.id);
    state = await ownership.snapshot();
    assert.equal(state[queuedReplacementOriginal.id], undefined);
    assert.equal(state[queuedReplacementSuccessor.id].state, 'takeover-queued');
    assert.equal(state[queuedReplacementSuccessor.id].attemptId, queuedReplacementId);

    // A timed-out native discard can itself be the operation that replaces the
    // tab. The replacement's stable unloaded successor is authoritative proof
    // of completion and must retain self ownership rather than becoming claimed.
    const lateReplacementOriginal = {
      ...edgeOriginal,
      id: 58,
      url: 'https://late-native-replacement.example/'
    };
    liveTabs = [lateReplacementOriginal];
    const lateReplacementAttempt = await ownership.begin(lateReplacementOriginal);
    assert.equal(await ownership.finish(lateReplacementOriginal, lateReplacementAttempt, undefined, {
      allowClaimed: false,
      lateNative: true,
      visual: {complete: true, favicon: false, repair: true, title: true}
    }), false);
    const lateReplacementSuccessor = {
      ...lateReplacementOriginal,
      id: 59,
      discarded: true,
      status: 'unloaded'
    };
    liveTabs = [lateReplacementSuccessor];
    listeners.replaced(lateReplacementSuccessor.id, lateReplacementOriginal.id);
    state = await ownership.snapshot();
    assert.equal(state[lateReplacementOriginal.id], undefined);
    assert.equal(state[lateReplacementSuccessor.id].source, 'self');
    assert.equal(state[lateReplacementSuccessor.id].attemptId, lateReplacementAttempt);
    assert.equal(state[lateReplacementSuccessor.id].visual.complete, true);

    // discarded:true is not enough on Chromium while the successor still says
    // loading. Preserve late-native until an unloaded lifecycle read promotes it.
    const unsettledReplacementOriginal = {
      ...edgeOriginal,
      id: 70,
      url: 'https://unsettled-late-replacement.example/'
    };
    liveTabs = [unsettledReplacementOriginal];
    const unsettledReplacementAttempt = await ownership.begin(unsettledReplacementOriginal);
    assert.equal(await ownership.finish(
      unsettledReplacementOriginal,
      unsettledReplacementAttempt,
      undefined,
      {allowClaimed: false, lateNative: true}
    ), false);
    const unsettledReplacementSuccessor = {
      ...unsettledReplacementOriginal,
      id: 71,
      discarded: true,
      status: 'loading'
    };
    liveTabs = [unsettledReplacementSuccessor];
    listeners.replaced(unsettledReplacementSuccessor.id, unsettledReplacementOriginal.id);
    state = await ownership.snapshot();
    assert.equal(state[unsettledReplacementSuccessor.id].state, 'late-native');
    const settledReplacementSuccessor = {...unsettledReplacementSuccessor, status: 'unloaded'};
    liveTabs = [settledReplacementSuccessor];
    assert.equal((await ownership.claim(settledReplacementSuccessor)).source, 'self');

    // The same fence applies without replacement: an early discarded:true /
    // loading lifecycle event cannot promote or claim the durable intent. A
    // later authoritative unloaded read converges exactly once to self.
    const unsettledDirect = {
      ...edgeOriginal,
      id: 72,
      url: 'https://unsettled-late-direct.example/'
    };
    liveTabs = [unsettledDirect];
    const unsettledDirectAttempt = await ownership.begin(unsettledDirect);
    assert.equal(await ownership.finish(unsettledDirect, unsettledDirectAttempt, undefined, {
      allowClaimed: false,
      lateNative: true
    }), false);
    const earlyDirect = {...unsettledDirect, discarded: true, status: 'loading'};
    liveTabs = [earlyDirect];
    assert.equal((await ownership.claim(earlyDirect)).state, 'late-native');
    await ownership.reconcile();
    state = await ownership.snapshot();
    assert.equal(state[earlyDirect.id].state, 'late-native');
    const settledDirect = {...earlyDirect, status: 'unloaded'};
    liveTabs = [settledDirect];
    assert.equal((await ownership.claim(settledDirect)).source, 'self');
    state = await ownership.snapshot();
    assert.equal(state[settledDirect.id].attemptId, unsettledDirectAttempt);

    // Edge frozen direct-native intent survives worker-style reconciliation in
    // every pre-settlement shape. It is never relabelled as a wake/reload
    // takeover, and only discarded+unloaded promotes physical ownership.
    const frozenPending = {
      id: 73,
      active: false,
      discarded: false,
      frozen: true,
      status: 'complete',
      url: 'https://direct-native-pending.example/'
    };
    liveTabs = [frozenPending];
    const frozenPendingAttempt = await ownership.beginDirectNative(frozenPending);
    assert.equal(typeof frozenPendingAttempt, 'string');
    await ownership.reconcile();
    state = await ownership.snapshot();
    assert.equal(state[frozenPending.id].state, 'direct-native-pending');
    assert.equal((await ownership.resolveFresh(frozenPending)).state, 'direct-native-pending');

    const intermediatePending = {...frozenPending, frozen: false};
    liveTabs = [intermediatePending];
    await ownership.reconcile();
    state = await ownership.snapshot();
    assert.equal(state[intermediatePending.id].state, 'direct-native-pending');
    assert.equal((await ownership.resolveFresh(intermediatePending)).state, 'direct-native-pending');

    const activatedPending = {
      id: 406,
      windowId: 4,
      active: false,
      discarded: false,
      frozen: false,
      status: 'complete'
    };
    liveTabs = [activatedPending];
    assert.ok(await ownership.beginDirectNative(activatedPending));
    listeners.activated({tabId: activatedPending.id, windowId: activatedPending.windowId});
    await new Promise(resolve => setTimeout(resolve));
    assert.equal((await ownership.status(activatedPending.id)).marker, undefined);

    const earlyPending = {...intermediatePending, discarded: true, status: 'complete'};
    liveTabs = [earlyPending];
    assert.equal(await ownership.finish(earlyPending, frozenPendingAttempt, undefined, {
      allowClaimed: false,
      directNative: true,
      lateNative: true
    }), false);
    await ownership.reconcile();
    assert.equal((await ownership.snapshot())[earlyPending.id].state, 'direct-native-pending');
    assert.equal((await ownership.resolveFresh(earlyPending)).marker.state, 'direct-native-pending');

    const physicalPending = {...earlyPending, status: 'unloaded'};
    liveTabs = [physicalPending];
    listeners.updated(physicalPending.id, {status: 'unloaded'}, physicalPending);
    await ownership.reconcile();
    state = await ownership.snapshot();
    assert.equal(state[physicalPending.id].state, 'owned');
    assert.equal(state[physicalPending.id].source, 'physical-only');

    // Also tolerate a browser that resolves the API callback with the new tab
    // before dispatching onReplaced. The globally unique nonce finds the old
    // pending record, and the later event moves the completed marker.
    const callbackFirstOriginal = {...edgeOriginal, id: 47};
    liveTabs = [callbackFirstOriginal];
    const callbackFirstAttempt = await ownership.begin(callbackFirstOriginal);
    const callbackFirstSuccessor = {
      ...callbackFirstOriginal,
      id: 48,
      discarded: true,
      status: 'unloaded'
    };
    liveTabs = [callbackFirstSuccessor];
    assert.equal(await ownership.finish(
      callbackFirstSuccessor, callbackFirstAttempt, 'self'
    ), true);
    assert.equal(await ownership.confirmSelf(callbackFirstSuccessor.id, callbackFirstAttempt), true);
    listeners.replaced(callbackFirstSuccessor.id, callbackFirstOriginal.id);
    state = await ownership.snapshot();
    assert.equal(state[callbackFirstOriginal.id], undefined);
    assert.equal(state[callbackFirstSuccessor.id].source, 'self');

    // Replacement revalidation holds a live tabs.get read. A new attempt that
    // starts in that gap must win and retain its pending marker.
    const replacementAttemptOriginal = {
      ...external,
      id: 49,
      status: 'unloaded',
      url: 'https://replacement-attempt-race.example/'
    };
    liveTabs = [replacementAttemptOriginal];
    await ownership.claim(replacementAttemptOriginal);
    const replacementAttemptSuccessor = {
      ...replacementAttemptOriginal,
      id: 50,
      discarded: false,
      status: 'complete'
    };
    liveTabs = [replacementAttemptSuccessor];
    holdNextGet = true;
    listeners.replaced(replacementAttemptSuccessor.id, replacementAttemptOriginal.id);
    while (!releaseGet) {
      await new Promise(resolve => setTimeout(resolve));
    }
    const replacementNewAttempt = ownership.begin(replacementAttemptSuccessor);
    releaseGet(replacementAttemptSuccessor);
    const replacementNewAttemptId = await replacementNewAttempt;
    assert.equal(typeof replacementNewAttemptId, 'string');
    state = await ownership.snapshot();
    assert.equal(state[replacementAttemptSuccessor.id].state, 'pending');
    const replacementAttemptDiscarded = {
      ...replacementAttemptSuccessor,
      discarded: true,
      status: 'unloaded'
    };
    liveTabs = [replacementAttemptDiscarded];
    assert.equal(await ownership.finish(
      replacementAttemptDiscarded, replacementNewAttemptId, 'self'
    ), true);

    // A lifecycle generation change during the same read must fence its stale
    // loaded result. The newer attachment owns the final live classification.
    const generationRaceOriginal = {
      ...replacementAttemptSuccessor,
      id: 51,
      discarded: false,
      url: 'https://replacement-generation-race.example/'
    };
    liveTabs = [generationRaceOriginal];
    const generationRaceAttempt = await ownership.begin(generationRaceOriginal);
    const generationRaceDiscarded = {...generationRaceOriginal, discarded: true, status: 'unloaded'};
    liveTabs = [generationRaceDiscarded];
    assert.equal(await ownership.finish(generationRaceDiscarded, generationRaceAttempt, 'self'), true);
    const generationRaceSuccessor = {
      ...generationRaceOriginal,
      id: 52,
      discarded: false,
      status: 'complete'
    };
    liveTabs = [generationRaceSuccessor];
    holdNextGet = true;
    listeners.replaced(generationRaceSuccessor.id, generationRaceOriginal.id);
    while (!releaseGet) {
      await new Promise(resolve => setTimeout(resolve));
    }
    const generationRaceFinal = {...generationRaceSuccessor, discarded: true, status: 'unloaded'};
    liveTabs = [generationRaceFinal];
    listeners.attached(generationRaceSuccessor.id);
    releaseGet(generationRaceSuccessor);
    state = await ownership.snapshot();
    assert.equal(state[generationRaceSuccessor.id].source, 'self');

    // A second replacement while the first successor read is pending likewise
    // prevents that obsolete identity from deleting or downgrading ownership.
    const identityRaceOriginal = {
      ...generationRaceOriginal,
      id: 53,
      url: 'https://replacement-identity-race.example/'
    };
    liveTabs = [identityRaceOriginal];
    const identityRaceAttempt = await ownership.begin(identityRaceOriginal);
    const identityRaceDiscarded = {...identityRaceOriginal, discarded: true, status: 'unloaded'};
    liveTabs = [identityRaceDiscarded];
    assert.equal(await ownership.finish(identityRaceDiscarded, identityRaceAttempt, 'self'), true);
    const identityRaceMiddle = {
      ...identityRaceOriginal,
      id: 54,
      discarded: false,
      status: 'complete'
    };
    liveTabs = [identityRaceMiddle];
    holdNextGet = true;
    listeners.replaced(identityRaceMiddle.id, identityRaceOriginal.id);
    while (!releaseGet) {
      await new Promise(resolve => setTimeout(resolve));
    }
    const identityRaceFinal = {...identityRaceDiscarded, id: 55};
    liveTabs = [identityRaceFinal];
    listeners.replaced(identityRaceFinal.id, identityRaceMiddle.id);
    releaseGet(identityRaceMiddle);
    state = await ownership.snapshot();
    assert.equal(state[identityRaceOriginal.id], undefined);
    assert.equal(state[identityRaceMiddle.id], undefined);
    assert.equal(state[identityRaceFinal.id].source, 'self');

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

    liveTabs = [selfDiscarded];
    assert.equal(await ownership.adopt(selfDiscarded), true);
    state = await ownership.snapshot();
    assert.equal(state[awake.id].source, 'self');
    listeners.attached(awake.id);
    await new Promise(resolve => setTimeout(resolve));
    state = await ownership.snapshot();
    assert.equal(state[awake.id].source, 'self');

    const busyAdoption = {
      id: 39,
      windowId: 1,
      url: 'https://busy-adoption.example/',
      discarded: true
    };
    liveTabs = [busyAdoption];
    const busyAttempt = await ownership.begin(busyAdoption);
    assert.equal(typeof busyAttempt, 'string');
    assert.equal((await ownership.adopt(busyAdoption)).busy, true);
    await ownership.invalidate(busyAdoption.id);

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

test('reset fences a storage read that resolves after the ownership record was erased', async () => {
  const staleMarker = {
    attemptId: 'deleted-before-late-read',
    source: 'self',
    state: 'owned',
    updatedAt: 1
  };
  const sessionState = {
    __discardOwnership: {1: staleMarker}
  };
  const liveTab = {
    active: false,
    discarded: true,
    id: 2,
    status: 'unloaded',
    url: 'https://after-reset.example/'
  };
  let holdRead = true;
  let releaseRead;
  const event = () => ({addListener() {}});

  globalThis.chrome = {
    runtime: {lastError: null},
    storage: {
      local: {},
      session: {
        get(defaults, callback) {
          const result = JSON.parse(JSON.stringify({...defaults, ...sessionState}));
          if (holdRead) {
            holdRead = false;
            releaseRead = () => callback(result);
          }
          else {
            callback(result);
          }
        },
        remove(key, callback) {
          delete sessionState[key];
          callback();
        },
        set(values, callback) {
          Object.assign(sessionState, values);
          callback();
        }
      }
    },
    tabs: {
      get(id, callback) {
        callback(id === liveTab.id ? {...liveTab} : undefined);
      },
      query(options, callback) {
        callback([{...liveTab}]);
      },
      onAttached: event(),
      onCreated: event(),
      onRemoved: event(),
      onReplaced: event(),
      onUpdated: event()
    }
  };

  try {
    const url = new URL('../v3/worker/core/ownership.mjs', import.meta.url);
    url.searchParams.set('late-reset-read', Date.now().toString());
    const {ownership, STORAGE_KEY} = await import(url);

    const staleStatus = ownership.status(1);
    while (!releaseRead) {
      await new Promise(resolve => setTimeout(resolve));
    }
    await ownership.reset();
    assert.equal(sessionState[STORAGE_KEY], undefined);

    releaseRead();
    assert.equal((await staleStatus).marker.attemptId, staleMarker.attemptId);
    await ownership.claim(liveTab);

    const state = await ownership.snapshot();
    assert.equal(state[1], undefined, 'the pre-reset read must never resurrect its deleted marker');
    assert.equal(state[liveTab.id].source, 'claimed');
    assert.equal(sessionState[`${STORAGE_KEY}:tab:1`], undefined);
  }
  finally {
    delete globalThis.chrome;
  }
});

test('prunes ownership identity maps through thousands of create, replace, and remove cycles', async () => {
  const sessionState = {};
  const listeners = {};
  const liveTabs = new Map();
  const event = name => ({
    addListener(listener) {
      listeners[name] = listener;
    }
  });

  globalThis.chrome = {
    runtime: {lastError: null},
    storage: {
      local: {},
      session: {
        get(defaults, callback) {
          callback({...defaults, ...sessionState});
        },
        remove(key, callback) {
          delete sessionState[key];
          callback();
        },
        set(values, callback) {
          Object.assign(sessionState, values);
          callback();
        }
      }
    },
    tabs: {
      get(id, callback) {
        callback(liveTabs.get(id));
      },
      query(options, callback) {
        callback([...liveTabs.values()]);
      },
      onAttached: event('attached'),
      onCreated: event('created'),
      onRemoved: event('removed'),
      onReplaced: event('replaced'),
      onUpdated: event('updated')
    }
  };

  try {
    const url = new URL('../v3/worker/core/ownership.mjs', import.meta.url);
    url.searchParams.set('stress', Date.now().toString());
    const {ownership, STORAGE_KEY} = await import(url);
    const cycles = 2048;
    const cycleIdentity = (index, emitRemoval) => {
      const original = {
        id: 10_000 + index * 3,
        discarded: false,
        status: 'complete',
        url: `https://identity-${index}.example/`
      };
      const middle = {...original, id: original.id + 1};
      const successor = {...original, id: original.id + 2};
      liveTabs.set(original.id, original);
      listeners.created(original);
      liveTabs.delete(original.id);
      liveTabs.set(middle.id, middle);
      listeners.replaced(middle.id, original.id);
      liveTabs.delete(middle.id);
      liveTabs.set(successor.id, successor);
      listeners.replaced(successor.id, middle.id);

      if (emitRemoval) {
        listeners.removed(original.id);
        listeners.removed(middle.id);
        liveTabs.delete(successor.id);
        listeners.removed(successor.id);
      }
      else {
        liveTabs.delete(successor.id);
      }
    };

    // First prove the event path reaches a zero baseline on its own.
    for (let index = 0; index < cycles / 2; index += 1) {
      cycleIdentity(index, true);
    }
    await ownership.diagnostics();
    assert.deepEqual(await ownership.diagnostics(), {
      attempts: 0,
      generations: 0,
      observedDiscards: 0,
      replacements: 0,
      takeoverAttempts: 0
    });

    // Then omit removal events so reconciliation has thousands of orphaned
    // identity records to sweep independently of the direct event path.
    for (let index = cycles / 2; index < cycles; index += 1) {
      cycleIdentity(index, false);
    }

    // Populate every job-side map with identities that disappear without an
    // onRemoved event. Reconciliation must clear these as well as lineage.
    for (let index = 0; index < 32; index += 1) {
      const tab = {
        id: 50_000 + index,
        discarded: false,
        status: 'complete',
        url: `https://pending-${index}.example/`
      };
      liveTabs.set(tab.id, tab);
      listeners.created(tab);
      const attemptId = index % 2 === 0 ? await ownership.begin(tab) : await ownership.beginTakeover(tab);
      assert.equal(typeof attemptId, 'string');
      listeners.updated(tab.id, {discarded: true}, {...tab, discarded: true, status: 'unloaded'});
      liveTabs.delete(tab.id);
    }

    assert.equal(await ownership.reconcile(), 0);
    assert.deepEqual(await ownership.diagnostics(), {
      attempts: 0,
      generations: 0,
      observedDiscards: 0,
      replacements: 0,
      takeoverAttempts: 0
    });
    assert.deepEqual(await ownership.snapshot(), {});
    assert.deepEqual(sessionState[STORAGE_KEY], {
      phase: 'ready',
      schema: 'auto-tab-discard/ownership',
      version: 2
    });
    assert.equal(Object.keys(sessionState).some(key => key.startsWith(`${STORAGE_KEY}:tab:`)), false);
    assert.equal(ownership.resolveId(10_000), 10_000);
    assert.equal(ownership.resolveId(10_000 + (cycles - 1) * 3), 10_000 + (cycles - 1) * 3);
  }
  finally {
    delete globalThis.chrome;
  }
});
