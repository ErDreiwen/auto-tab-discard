import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {
  createPopupProgressManager,
  POPUP_CODES,
  SNAPSHOT_VERSION,
  trackPopupTabTask
} from '../v3/worker/core/popup-progress.mjs';
import {FAILURE_CAUSES} from '../v3/worker/core/failure-causes.mjs';

const memoryStore = initial => {
  let value = structuredClone(initial);
  return {
    read: async () => structuredClone(value),
    value: () => structuredClone(value),
    write: async next => value = structuredClone(next)
  };
};

const tick = () => new Promise(resolve => setTimeout(resolve));

test('deduplicates an identical popup command and rejects a conflicting command in the same window', async () => {
  const store = memoryStore();
  let finish;
  let executions = 0;
  const manager = createPopupProgressManager({store});
  const request = {cmd: 'discard-window', tabId: 1, windowId: 7};
  const task = async progress => {
    executions += 1;
    await progress.addTargets([{id: 2}]);
    await new Promise(resolve => finish = resolve);
    await progress.settle({id: 2}, 'success', POPUP_CODES.TAB_DISCARDED);
    return {succeeded: [{tab: {id: 2}}]};
  };

  const first = manager.run(request, task);
  while (!finish) {
    await tick();
  }
  const duplicate = manager.run(request, () => assert.fail('deduplicated task must not execute'));
  const conflict = await manager.run({...request, cmd: 'release-window'}, () => {});
  assert.equal(conflict.errorCode, POPUP_CODES.BUSY);
  assert.equal(conflict.jobId, (await manager.snapshot(request)).jobId);

  finish();
  const [a, b] = await Promise.all([first, duplicate]);
  assert.deepEqual(a, b);
  assert.equal(executions, 1);
  assert.equal(a.state, 'complete');
  assert.deepEqual(a.summary, {failed: 0, skipped: 0, success: 1});
});

test('cancels a 50-tab slow takeover batch with monotonic progress and stable per-tab results', async () => {
  const store = memoryStore();
  const published = [];
  let release;
  let cancellationCalls = 0;
  const manager = createPopupProgressManager({
    publish: async snapshot => published.push(snapshot),
    store
  });
  const tabs = Array.from({length: 50}, (_, index) => ({id: index + 10}));
  const gate = new Promise(resolve => release = resolve);
  const request = {cmd: 'discard-tabs', tabId: 1, windowId: 3};

  const running = manager.run(request, async progress => {
    await progress.addTargets(tabs);
    await Promise.allSettled(tabs.map(async tab => {
      await gate;
      progress.throwIfCancelled();
      await progress.settle(tab, 'success', POPUP_CODES.TAB_DISCARDED);
    }));
    progress.throwIfCancelled();
  }, async progress => {
    cancellationCalls += 1;
    assert.equal(progress.targetIds().length, 50);
    release();
  });

  let snapshot;
  do {
    await tick();
    snapshot = await manager.snapshot(request);
  } while (snapshot?.total !== 50);

  const cancelling = await manager.cancel(snapshot.jobId);
  assert.equal(cancelling.accepted, true);
  assert.equal(cancelling.snapshot.jobId, snapshot.jobId);
  assert.equal(cancelling.snapshot.state, 'cancelling');
  assert.equal(cancelling.snapshot.errorCode, POPUP_CODES.CANCELLED);

  const result = await running;
  assert.equal(cancellationCalls, 1);
  assert.equal(result.state, 'cancelled');
  assert.equal(result.completed, 50);
  assert.equal(result.total, 50);
  assert.deepEqual(result.summary, {failed: 0, skipped: 50, success: 0});
  assert.equal(Object.values(result.outcomes).every(entry =>
    entry.status === 'skipped' && entry.code === POPUP_CODES.TAB_CANCELLED), true);

  const forJob = published.filter(entry => entry.jobId === result.jobId);
  for (let index = 1; index < forJob.length; index += 1) {
    assert.ok(forJob[index].completed >= forJob[index - 1].completed, 'completed count must not decrease');
    assert.ok(forJob[index].total >= forJob[index - 1].total, 'total count must not decrease');
  }
  assert.deepEqual(await manager.cancel(result.jobId), {accepted: false});
});

test('a terminal result survives popup closure while a stale running record becomes interrupted', async () => {
  let clock = 1_000;
  const store = memoryStore();
  const request = {cmd: 'discard-tab', tabId: 4, windowId: 2};
  const first = createPopupProgressManager({now: () => clock, store});
  const result = await first.run(request, async progress => {
    await progress.addTargets([{id: 4}]);
    await progress.settle({id: 4}, 'success', POPUP_CODES.TAB_DISCARDED);
  });
  assert.equal(result.state, 'complete');

  // This is a new manager, as if the popup and service worker were recreated.
  clock += 1_000;
  const reopened = createPopupProgressManager({now: () => clock, store});
  assert.deepEqual(await reopened.snapshot(request), result);

  const interruptedStore = memoryStore({
    snapshots: {
      'window:9': {
        command: 'discard-tabs',
        completed: 1,
        expiresAt: clock + 60_000,
        jobId: 'old-job',
        outcomes: {1: {code: POPUP_CODES.TAB_DISCARDED, status: 'success', tabId: 1}},
        scope: 'window:9',
        state: 'running',
        summary: {failed: 0, skipped: 0, success: 1},
        targetIds: [1, 2],
        total: 2,
        version: SNAPSHOT_VERSION,
        windowId: 9
      }
    },
    version: SNAPSHOT_VERSION
  });
  const restarted = createPopupProgressManager({now: () => clock, store: interruptedStore});
  const interrupted = await restarted.snapshot({windowId: 9});
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.errorCode, POPUP_CODES.INTERRUPTED);
  assert.deepEqual(interrupted.summary, {failed: 0, skipped: 1, success: 1});
});

test('every intended tab receives one terminal success, skipped, or failed outcome', async () => {
  const manager = createPopupProgressManager({store: memoryStore()});
  const completed = await manager.run({cmd: 'release-window', windowId: 12}, async progress => {
    await progress.addTargets([{id: 1}, {id: 2}, {id: 3}]);
    await progress.settle({id: 1}, 'success', POPUP_CODES.TAB_RELEASED);
    // Loaded tabs in a release scope legitimately need no work.
  });
  assert.equal(completed.completed, completed.total);
  assert.deepEqual(completed.summary, {failed: 0, skipped: 2, success: 1});

  const failed = await manager.run({cmd: 'discard-window', windowId: 13}, async progress => {
    await progress.addTargets([{id: 4}, {id: 5}]);
    throw Error('simulated executor failure');
  });
  assert.equal(failed.completed, failed.total);
  assert.deepEqual(failed.summary, {failed: 2, skipped: 0, success: 0});
  assert.equal(Object.values(failed.outcomes).every(entry => entry.code === POPUP_CODES.TAB_FAILED), true);
});

test('no-safe-keeper group result is a retryable partial without downgrading normal skips', async () => {
  const manager = createPopupProgressManager({store: memoryStore()});
  const root = {active: true, id: 41};
  const children = [42, 43, 44].map(id => ({active: false, id}));
  const partial = await manager.run({cmd: 'discard-tree', windowId: 14}, async progress => {
    await progress.addTargets([root, ...children]);
    return {
      blocked: true,
      candidates: [root, children[0]],
      failed: [],
      physicalOnly: [{tab: children[1]}],
      protected: [],
      succeeded: children.map(tab => ({tab})),
      takeovers: [children[2]]
    };
  });

  assert.equal(partial.state, 'partial');
  assert.deepEqual(partial.summary, {failed: 0, skipped: 1, success: 3});
  assert.deepEqual(partial.outcomes[41], {
    code: POPUP_CODES.TAB_NO_SAFE_KEEPER,
    status: 'skipped',
    tabId: 41
  });
  assert.equal(partial.outcomes[42].code, POPUP_CODES.TAB_DISCARDED);
  assert.equal(partial.outcomes[43].code, POPUP_CODES.TAB_DISCARDED_VISUAL_UNAVAILABLE);
  assert.equal(partial.outcomes[44].code, POPUP_CODES.TAB_DISCARDED);

  const successfulGroup = await manager.run({cmd: 'discard-tree', windowId: 15}, async progress => {
    await progress.addTargets(children);
    return {blocked: false, succeeded: children.map(tab => ({tab}))};
  });
  assert.equal(successfulGroup.state, 'complete', 'a 3/3 group success must remain complete');
  assert.deepEqual(successfulGroup.summary, {failed: 0, skipped: 0, success: 3});

  const protectedSkip = await manager.run({cmd: 'discard-window', windowId: 16}, async progress => {
    await progress.addTargets([{id: 45}]);
    return {protected: [{reason: 'protected by policy', tab: {id: 45}}]};
  });
  assert.equal(protectedSkip.state, 'complete');
  assert.equal(protectedSkip.outcomes[45].code, POPUP_CODES.TAB_PROTECTED);
});

test('command result classifications produce truthful failed, partial, and physical-only terminals', async () => {
  const manager = createPopupProgressManager({store: memoryStore()});
  const targets = Array.from({length: 8}, (_, index) => ({id: index + 101}));
  const mixed = await manager.run({cmd: 'discard-window', windowId: 21}, async progress => {
    await progress.addTargets(targets);
    return {
      errors: [
        // This is a recovered retry diagnostic and must not override the
        // authoritative success for the same tab.
        {reason: 'first ownership read failed', tab: targets[0]},
        {reason: 'unclassified target failed', tab: targets[6]},
        Error('unattributed retry diagnostic')
      ],
      missing: [targets[7]],
      physicalOnly: [{reason: 'already physically discarded', tab: targets[1]}],
      protected: [{reason: 'protected by policy', tab: targets[2]}],
      succeeded: [{tab: targets[0]}],
      unknownOwnership: [{reason: 'ownership unavailable', tab: targets[5]}],
      unknownSuspension: [{reason: 'frozen state unavailable', tab: targets[4]}],
      unsupported: [{reason: 'browser rejected native discard', tab: targets[3]}]
    };
  });

  assert.equal(mixed.state, 'partial');
  assert.deepEqual(mixed.summary, {failed: 4, skipped: 2, success: 2});
  assert.deepEqual(mixed.outcomes[101], {
    code: POPUP_CODES.TAB_DISCARDED,
    status: 'success',
    tabId: 101
  });
  assert.deepEqual(mixed.outcomes[102], {
    code: POPUP_CODES.TAB_DISCARDED_VISUAL_UNAVAILABLE,
    status: 'success',
    tabId: 102
  });
  assert.deepEqual(mixed.outcomes[103], {
    code: POPUP_CODES.TAB_PROTECTED,
    status: 'skipped',
    tabId: 103
  });
  assert.deepEqual(mixed.outcomes[104], {
    code: POPUP_CODES.TAB_UNSUPPORTED,
    status: 'failed',
    tabId: 104
  });
  assert.deepEqual(mixed.outcomes[105], {
    code: POPUP_CODES.TAB_SUSPENSION_UNKNOWN,
    status: 'failed',
    tabId: 105
  });
  assert.deepEqual(mixed.outcomes[106], {
    code: POPUP_CODES.TAB_OWNERSHIP_UNKNOWN,
    status: 'failed',
    tabId: 106
  });
  assert.deepEqual(mixed.outcomes[107], {
    code: POPUP_CODES.TAB_FAILED,
    failureCause: FAILURE_CAUSES.OPERATION_FAILED,
    status: 'failed',
    tabId: 107
  });
  assert.deepEqual(mixed.outcomes[108], {
    code: POPUP_CODES.TAB_MISSING,
    status: 'skipped',
    tabId: 108
  });

  const releaseFailed = await manager.run({cmd: 'release-window', windowId: 22}, async progress => {
    await progress.addTargets([{id: 201}, {id: 202}]);
    return {
      failed: [{reason: 'native operation remains pending', tab: {id: 201}}],
      unsupported: [{reason: 'release API unavailable', tab: {id: 202}}]
    };
  });
  assert.equal(releaseFailed.state, 'failed');
  assert.deepEqual(releaseFailed.summary, {failed: 2, skipped: 0, success: 0});
  assert.equal(releaseFailed.outcomes[202].code, POPUP_CODES.TAB_UNSUPPORTED);

  const alreadyPhysical = await manager.run({cmd: 'discard-window', windowId: 23}, async progress => {
    await progress.addTargets([{id: 301}]);
    return {physicalOnly: [{reason: 'already physically discarded', tab: {id: 301}}]};
  });
  assert.equal(alreadyPhysical.state, 'complete');
  assert.deepEqual(alreadyPhysical.summary, {failed: 0, skipped: 0, success: 1});
});

test('retained-frozen release is an exact retryable failure and makes a mixed bulk result partial', async () => {
  const manager = createPopupProgressManager({store: memoryStore()});
  const retained = {discarded: false, frozen: true, id: 702, status: 'complete'};
  const single = await manager.run({cmd: 'release-tabs', windowId: 30}, async progress => {
    await progress.addTargets([{id: 701}]);
    return {
      failed: [{
        code: 'TAB_RELEASE_REMAINS_FROZEN',
        disposition: 'retained-frozen',
        retryable: true,
        tab: {discarded: false, frozen: true, id: 701, status: 'complete'}
      }]
    };
  });
  assert.equal(single.state, 'failed');
  assert.deepEqual(single.summary, {failed: 1, skipped: 0, success: 0});
  assert.deepEqual(single.outcomes[701], {
    code: POPUP_CODES.TAB_RELEASE_REMAINS_FROZEN,
    status: 'failed',
    tabId: 701
  });

  const mixed = await manager.run({cmd: 'release-tabs', windowId: 31}, async progress => {
    await progress.addTargets([{id: 702}, {id: 703}]);
    return {
      failed: [{
        code: 'TAB_RELEASE_REMAINS_FROZEN',
        disposition: 'retained-frozen',
        retryable: true,
        tab: retained
      }],
      released: [{discarded: false, frozen: false, id: 703, status: 'complete'}]
    };
  });
  assert.equal(mixed.state, 'partial');
  assert.deepEqual(mixed.summary, {failed: 1, skipped: 0, success: 1});
  assert.equal(mixed.outcomes[702].code, POPUP_CODES.TAB_RELEASE_REMAINS_FROZEN);
  assert.equal(mixed.outcomes[703].code, POPUP_CODES.TAB_RELEASED);
  assert.equal(Object.values(mixed.outcomes).some(outcome =>
    outcome.code === POPUP_CODES.TAB_FAILED), false);
});

test('menu provisional settlement allowlists retained-frozen without publishing generic TAB_FAILED', async () => {
  const menu = await readFile(new URL('../v3/worker/menu.mjs', import.meta.url), 'utf8');
  assert.match(menu,
    /trackPopupTabTask as trackTabTask/);
  assert.match(menu,
    /release:\s*trackTabTask\(progress, releaseTab, POPUP_CODES\.TAB_RELEASED\)/);

  const published = [];
  const manager = createPopupProgressManager({
    publish: async snapshot => published.push(snapshot),
    resolveId: id => id === 604 ? 704 : id,
    store: memoryStore()
  });
  const result = await manager.run({cmd: 'release-tabs', windowId: 32}, async progress => {
    const retained = {discarded: false, frozen: true, id: 704, status: 'complete'};
    const release = trackPopupTabTask(progress, async () => {
      const error = Error('Edge retained the frozen state');
      error.code = POPUP_CODES.TAB_RELEASE_REMAINS_FROZEN;
      error.disposition = 'retained-frozen';
      error.retryable = true;
      error.tab = retained;
      throw error;
    }, POPUP_CODES.TAB_RELEASED);
    let error;
    try {
      await release({id: 604});
    }
    catch (caught) {
      error = caught;
    }
    return {
      failed: [{
        code: error.code,
        disposition: error.disposition,
        retryable: error.retryable,
        tab: error.tab
      }]
    };
  });

  assert.equal(result.state, 'failed');
  assert.equal(result.outcomes[704].code, POPUP_CODES.TAB_RELEASE_REMAINS_FROZEN);
  assert.equal(published.some(snapshot => Object.values(snapshot.outcomes || {}).some(
    outcome => outcome.code === POPUP_CODES.TAB_FAILED
  )), false);

  const returnedPublished = [];
  const returnedManager = createPopupProgressManager({
    publish: async snapshot => returnedPublished.push(snapshot),
    store: memoryStore()
  });
  const returned = await returnedManager.run({cmd: 'release-tabs', windowId: 34}, async progress => {
    const disposition = {
      code: POPUP_CODES.TAB_RELEASE_REMAINS_FROZEN,
      disposition: 'retained-frozen',
      retryable: true,
      tab: {discarded: false, frozen: true, id: 706, status: 'complete'}
    };
    const release = trackPopupTabTask(progress, async () => disposition, POPUP_CODES.TAB_RELEASED);
    await release(disposition.tab);
    return {failed: [disposition]};
  });
  assert.equal(returned.state, 'failed');
  assert.equal(returned.outcomes[706].code, POPUP_CODES.TAB_RELEASE_REMAINS_FROZEN);
  assert.equal(returnedPublished.some(snapshot => Object.values(snapshot.outcomes || {}).some(
    outcome => [POPUP_CODES.TAB_FAILED, POPUP_CODES.TAB_RELEASED].includes(outcome.code)
  )), false);

  const rawPublished = [];
  const rawManager = createPopupProgressManager({
    publish: async snapshot => rawPublished.push(snapshot),
    store: memoryStore()
  });
  await rawManager.run({cmd: 'release-tabs', windowId: 33}, async progress => {
    const release = trackPopupTabTask(progress, async () => {
      const error = Error('private browser diagnostic');
      error.code = 'RAW_PRIVATE_BROWSER_CODE';
      throw error;
    }, POPUP_CODES.TAB_RELEASED);
    await release({id: 705});
  });
  assert.equal(rawPublished.some(snapshot => Object.values(snapshot.outcomes || {}).some(
    outcome => outcome.code === 'RAW_PRIVATE_BROWSER_CODE'
  )), false);
  assert.equal(rawPublished.some(snapshot => Object.values(snapshot.outcomes || {}).some(
    outcome => outcome.code === POPUP_CODES.TAB_FAILED
  )), true);
});

test('normal-check unsupported outcomes retain their precise popup code', async () => {
  const manager = createPopupProgressManager({store: memoryStore()});
  const target = {id: 350};
  const result = await manager.run({cmd: 'discard-window', windowId: 23}, async progress => {
    await progress.mergeCheckResult({
      unsupported: [{reason: 'renderer unavailable for restricted scheme', tab: target}]
    }, [target]);
    return {
      unsupported: [{reason: 'renderer unavailable for restricted scheme', tab: target}]
    };
  });

  assert.equal(result.state, 'failed');
  assert.deepEqual(result.outcomes[350], {
    code: POPUP_CODES.TAB_UNSUPPORTED,
    status: 'failed',
    tabId: 350
  });
});

test('authoritative command results replace provisional task outcomes exactly once', async () => {
  const manager = createPopupProgressManager({store: memoryStore()});

  const recoveredSuccess = await manager.run({
    cmd: 'discard-tab',
    windowId: 24
  }, async progress => {
    await progress.addTargets([{id: 401}]);
    // The takeover task rejected before command-scope observed that its target
    // replacement had actually completed successfully.
    await progress.settle({id: 401}, 'failed', POPUP_CODES.TAB_FAILED);
    return {succeeded: [{tab: {id: 401}}]};
  });
  assert.equal(recoveredSuccess.state, 'complete');
  assert.deepEqual(recoveredSuccess.outcomes[401], {
    code: POPUP_CODES.TAB_DISCARDED,
    status: 'success',
    tabId: 401
  });

  const recoveredSkip = await manager.run({
    cmd: 'discard-tab',
    windowId: 25
  }, async progress => {
    await progress.addTargets([{id: 402}]);
    await progress.settle({id: 402}, 'failed', POPUP_CODES.TAB_FAILED);
    return {skipped: [{id: 402, reason: 'target became active'}]};
  });
  assert.equal(recoveredSkip.state, 'complete');
  assert.deepEqual(recoveredSkip.outcomes[402], {
    code: POPUP_CODES.TAB_SKIPPED,
    status: 'skipped',
    tabId: 402
  });

  const finalFailure = await manager.run({
    cmd: 'discard-tab',
    windowId: 26
  }, async progress => {
    await progress.addTargets([{id: 403}]);
    await progress.settle({id: 403}, 'success', POPUP_CODES.TAB_DISCARDED);
    return {
      failed: [{reason: 'final native discard failed', tab: {id: 403}}],
      skipped: [{id: 403, reason: 'contradictory lower-priority classification'}],
      succeeded: [{tab: {id: 403}}]
    };
  });
  assert.equal(finalFailure.state, 'failed');
  assert.deepEqual(finalFailure.outcomes[403], {
    code: POPUP_CODES.TAB_FAILED,
    failureCause: FAILURE_CAUSES.OPERATION_FAILED,
    status: 'failed',
    tabId: 403
  });
});

test('generic failures retain only the strict fixed cause taxonomy', async () => {
  const manager = createPopupProgressManager({store: memoryStore()});
  const causes = Object.values(FAILURE_CAUSES);
  const targets = causes.map((failureCause, index) => ({failureCause, tab: {id: 800 + index}}));
  const result = await manager.run({cmd: 'discard-window', windowId: 80}, async progress => {
    await progress.addTargets([...targets.map(entry => entry.tab), {id: 899}]);
    return {
      failed: [
        ...targets.map(entry => ({
          failureCause: entry.failureCause,
          reason: 'SECRET raw browser failure',
          tab: entry.tab
        })),
        {
          failureCause: 'RAW_PRIVATE_BROWSER_CAUSE',
          reason: 'SECRET invalid cause',
          tab: {id: 899}
        }
      ]
    };
  });

  for (const [index, failureCause] of causes.entries()) {
    assert.equal(result.outcomes[800 + index].failureCause, failureCause);
  }
  assert.equal(result.outcomes[899].failureCause, FAILURE_CAUSES.OPERATION_FAILED);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|RAW_PRIVATE/);

  const commandFailure = await manager.run({cmd: 'discard-window', windowId: 81}, async () => {
    const error = Error('SECRET scope query response');
    error.failureCause = FAILURE_CAUSES.SCOPE_QUERY_FAILED;
    throw error;
  });
  assert.equal(commandFailure.errorCode, POPUP_CODES.COMMAND_FAILED);
  assert.equal(commandFailure.errorCause, FAILURE_CAUSES.SCOPE_QUERY_FAILED);
  assert.doesNotMatch(JSON.stringify(commandFailure), /SECRET/);
});

test('replacement lineage migrates a provisional predecessor into one authoritative successor', async () => {
  const replacements = new Map();
  const resolveId = id => replacements.get(id) || id;
  const manager = createPopupProgressManager({resolveId, store: memoryStore()});
  const predecessor = {id: 502};
  const targets = [{id: 501}, predecessor, {id: 503}];
  const result = await manager.run({cmd: 'discard-tree', windowId: 27}, async progress => {
    await progress.addTargets(targets);
    await progress.settle(predecessor, 'success', POPUP_CODES.TAB_DISCARDED);
    replacements.set(predecessor.id, 602);
    return {
      physicalOnly: [{tab: {id: 602}}],
      succeeded: [{tab: targets[0]}, {tab: {id: 602}}, {tab: targets[2]}]
    };
  });

  assert.equal(result.state, 'complete');
  assert.equal(result.total, 3);
  assert.equal(result.completed, 3);
  assert.deepEqual(result.summary, {failed: 0, skipped: 0, success: 3});
  assert.deepEqual(result.targetIds, [501, 602, 503]);
  assert.equal(Object.hasOwn(result.outcomes, 502), false);
  assert.deepEqual(result.outcomes[602], {
    code: POPUP_CODES.TAB_DISCARDED_VISUAL_UNAVAILABLE,
    status: 'success',
    tabId: 602
  });
});

test('task result keeps a replacement logical target exact after shared lineage retirement', async () => {
  const manager = createPopupProgressManager({
    // Model the real Edge boundary where ownership has already retired its
    // global predecessor edge by the time the aggregate result is merged.
    resolveId: id => id,
    store: memoryStore()
  });
  const predecessor = {id: 610};
  const successor = {id: 710};
  const result = await manager.run({cmd: 'discard-tree', windowId: 28}, async progress => {
    await progress.addTargets([predecessor]);
    const discard = trackPopupTabTask(progress, async () => ({
      ok: true,
      status: 'succeeded',
      tab: successor
    }), POPUP_CODES.TAB_DISCARDED);
    const disposition = await discard(predecessor);
    return {succeeded: [disposition]};
  });

  assert.equal(result.state, 'complete');
  assert.equal(result.total, 1);
  assert.equal(result.completed, 1);
  assert.deepEqual(result.targetIds, [710]);
  assert.deepEqual(result.summary, {failed: 0, skipped: 0, success: 1});
  assert.equal(Object.hasOwn(result.outcomes, 610), false);
  assert.deepEqual(result.outcomes[710], {
    code: POPUP_CODES.TAB_DISCARDED,
    status: 'success',
    tabId: 710
  });
});

test('lost shared lineage keeps the exact no-keeper physical-only partial at four targets', async () => {
  const manager = createPopupProgressManager({resolveId: id => id, store: memoryStore()});
  const root = {active: true, id: 720};
  const loaded = {id: 721};
  const frozenPredecessor = {id: 722};
  const frozenSuccessor = {id: 822};
  const external = {id: 723};
  const result = await manager.run({cmd: 'discard-tree', windowId: 29}, async progress => {
    await progress.addTargets([root, loaded, frozenPredecessor, external]);
    const discard = trackPopupTabTask(progress, async tab => ({
      ok: true,
      status: 'succeeded',
      tab: tab.id === frozenPredecessor.id ? frozenSuccessor : tab
    }), POPUP_CODES.TAB_DISCARDED);
    const loadedResult = await discard(loaded);
    const frozenResult = await discard(frozenPredecessor);
    const externalResult = await discard(external);
    return {
      blocked: true,
      candidates: [root],
      physicalOnly: [frozenResult],
      succeeded: [loadedResult, frozenResult, externalResult]
    };
  });

  assert.equal(result.state, 'partial');
  assert.equal(result.total, 4);
  assert.equal(result.completed, 4);
  assert.deepEqual(result.targetIds, [720, 721, 822, 723]);
  assert.deepEqual(result.summary, {failed: 0, skipped: 1, success: 3});
  assert.deepEqual(Object.values(result.outcomes).map(outcome => outcome.code).sort(), [
    POPUP_CODES.TAB_DISCARDED,
    POPUP_CODES.TAB_DISCARDED,
    POPUP_CODES.TAB_DISCARDED_VISUAL_UNAVAILABLE,
    POPUP_CODES.TAB_NO_SAFE_KEEPER
  ].sort());
  assert.equal(Object.hasOwn(result.outcomes, frozenPredecessor.id), false);
});

test('popup cancellation is wired to the real queued and running takeover tokens', async () => {
  const [menu, popup] = await Promise.all([
    readFile(new URL('../v3/worker/menu.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../v3/data/popup/index.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(menu, /popupProgress\.run\(/);
  assert.match(menu, /progress\.targetIds\(\)\.map\(id => discard\.cancelTakeover\(id\)\)/);
  assert.match(menu, /request\.method === 'popup-progress-cancel'/);
  assert.match(popup, /method: 'popup-progress-cancel'/);
  assert.match(popup, /setConflictingControlsDisabled\(true\)/);
  assert.match(popup, /'partial'/);
  assert.match(popup, /pendingCommand \|\|/);
});

test('popup snapshots retain an opaque incident and exact retry modifiers', async () => {
  const manager = createPopupProgressManager({
    createIncidentId: (startedAt, sequence) => `ATD-TEST-${startedAt}-${sequence}`,
    now: () => 1_234,
    store: memoryStore()
  });
  const result = await manager.run({
    checked: true,
    cmd: 'discard-window',
    shiftKey: true,
    windowId: 91
  }, async progress => {
    await progress.addTargets([{id: 901}]);
    return {succeeded: [{tab: {id: 901}}]};
  });

  assert.equal(result.incidentId, 'ATD-TEST-1234-1');
  assert.equal(result.checked, true);
  assert.equal(result.shiftKey, true);
});

test('one terminal diagnostic is awaited best-effort and never changes command results', async () => {
  const checkpoints = [];
  const manager = createPopupProgressManager({
    recordDiagnostic: async snapshot => {
      checkpoints.push(structuredClone(snapshot));
      throw Error('diagnostic storage unavailable');
    },
    store: memoryStore()
  });
  const result = await manager.run({cmd: 'discard-tab', windowId: 92}, async progress => {
    await progress.addTargets([{id: 902}]);
    await progress.settle({id: 902}, 'success', POPUP_CODES.TAB_DISCARDED);
    return {succeeded: [{tab: {id: 902}}]};
  });

  assert.equal(result.state, 'complete');
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].state, 'complete');
  assert.equal(checkpoints[0].summary.success, 1);
});

test('a diagnostic backend that never settles cannot hang terminal command publication', async () => {
  const published = [];
  const manager = createPopupProgressManager({
    diagnosticTimeout: 10,
    publish: async snapshot => published.push(structuredClone(snapshot)),
    recordDiagnostic: () => new Promise(() => {}),
    store: memoryStore()
  });
  const result = await manager.run({cmd: 'discard-tab', windowId: 94}, async progress => {
    await progress.addTargets([{id: 904}]);
    return {succeeded: [{tab: {id: 904}}]};
  });

  assert.equal(result.state, 'complete');
  assert.equal(published.at(-1).state, 'complete');
});

test('session progress read and write backends have independent hard deadlines', async () => {
  const readHung = createPopupProgressManager({
    storageTimeout: 10,
    store: {
      read: () => new Promise(() => {}),
      write: async () => {}
    }
  });
  assert.equal(await readHung.snapshot({windowId: 95}), undefined);

  const writeHung = createPopupProgressManager({
    storageTimeout: 10,
    store: {
      read: async () => undefined,
      write: () => new Promise(() => {})
    }
  });
  const result = await writeHung.run({cmd: 'discard-tab', windowId: 96}, async progress => {
    await progress.addTargets([{id: 906}]);
    return {succeeded: [{tab: {id: 906}}]};
  });
  assert.equal(result.state, 'complete');
});

test('a progress publisher that never settles cannot retain command completion', async () => {
  let taskRan = false;
  const manager = createPopupProgressManager({
    publish: () => new Promise(() => {}),
    publishTimeout: 10,
    store: memoryStore()
  });
  const result = await manager.run({cmd: 'discard-tab', windowId: 97}, async progress => {
    taskRan = true;
    await progress.addTargets([{id: 907}]);
    return {succeeded: [{tab: {id: 907}}]};
  });

  assert.equal(taskRan, true);
  assert.equal(result.state, 'complete');
  assert.deepEqual(result.summary, {failed: 0, skipped: 0, success: 1});
});

test('hydration publishes one fixed interrupted diagnostic checkpoint', async () => {
  const interrupted = {
    checked: false,
    command: 'discard-tabs',
    completed: 0,
    expiresAt: 20_000,
    incidentId: 'ATD-INTERRUPTED-1',
    jobId: 'old-job',
    outcomes: {},
    scope: 'window:93',
    shiftKey: false,
    startedAt: 100,
    state: 'running',
    summary: {failed: 0, skipped: 0, success: 0},
    targetIds: [903],
    total: 1,
    updatedAt: 100,
    version: SNAPSHOT_VERSION,
    windowId: 93
  };
  const store = memoryStore({
    snapshots: {'window:93': interrupted},
    version: SNAPSHOT_VERSION
  });
  const checkpoints = [];
  const manager = createPopupProgressManager({
    now: () => 1_000,
    recordDiagnostic: async snapshot => checkpoints.push(snapshot),
    store
  });

  const first = await manager.snapshot({windowId: 93});
  const second = await manager.snapshot({windowId: 93});
  assert.equal(first.state, 'interrupted');
  assert.equal(second.state, 'interrupted');
  assert.equal(first.errorCode, POPUP_CODES.INTERRUPTED);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].outcomes[903].code, POPUP_CODES.TAB_SKIPPED);
});
