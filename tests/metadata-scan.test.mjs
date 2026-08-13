import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSingleFlightQueue,
  loadedDiscardOutcomes,
  metadataFlightKey,
  partitionFrozenTabs,
  runBoundedScan,
  runDiscardCandidates,
  selectOldest
} from '../v3/worker/core/metadata-scan.mjs';

const deferred = () => {
  let reject;
  let resolve;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return {promise, reject, resolve};
};

const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));

test('metadata scanning caps concurrency and restores input order', async () => {
  const items = [1, 2, 3, 4, 5, 6];
  let active = 0;
  let maximum = 0;
  const completionOrder = [];

  const result = await runBoundedScan(items, async item => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, (7 - item) * 2));
    completionOrder.push(item);
    active -= 1;
    return `meta-${item}`;
  }, {
    concurrency: 2,
    timeout: 1000
  });

  assert.equal(maximum, 2);
  assert.notDeepEqual(completionOrder, items);
  assert.deepEqual(result.completed.map(entry => entry.item), items);
  assert.deepEqual(result.completed.map(entry => entry.value), items.map(item => `meta-${item}`));
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.timedOut, false);
});

test('one total deadline stops launching work and records every skipped item', async () => {
  const called = [];
  const startedAt = Date.now();
  const result = await runBoundedScan([10, 11, 12, 13, 14], item => {
    called.push(item);
    return new Promise(() => {});
  }, {
    concurrency: 2,
    timeout: 20
  });

  assert.deepEqual(called, [10, 11]);
  assert.equal(result.started, 2);
  assert.deepEqual(result.completed, []);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.skipped.map(entry => entry.item), [10, 11, 12, 13, 14]);
  assert.deepEqual(result.skipped.map(entry => entry.started), [true, true, false, false, false]);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 250, 'the scan must return near its deadline');
});

test('worker failures are isolated and later items still run', async () => {
  const result = await runBoundedScan([1, 2, 3], item => {
    if (item === 2) {
      throw Error('metadata denied');
    }
    return item * 10;
  }, {
    concurrency: 2,
    timeout: 1000
  });

  assert.deepEqual(result.completed.map(entry => entry.item), [1, 3]);
  assert.deepEqual(result.completed.map(entry => entry.value), [10, 30]);
  assert.deepEqual(result.failed.map(entry => entry.item), [2]);
  assert.match(result.failed[0].error.message, /metadata denied/);
  assert.deepEqual(result.skipped, []);
});

test('single-flight joins equivalent automatic scans but queues targeted scopes', async () => {
  const gates = new Map();
  const started = [];
  let active = 0;
  let maximum = 0;
  const queue = createSingleFlightQueue(label => {
    started.push(label);
    active += 1;
    maximum = Math.max(maximum, active);
    const gate = deferred();
    gates.set(label, () => {
      active -= 1;
      gate.resolve(label);
    });
    return gate.promise;
  });

  const automatic = queue.run('automatic', 'automatic-one');
  const duplicate = queue.run('automatic', 'automatic-two');
  const targeted = queue.run(undefined, 'targeted-tab-42');
  await nextTurn();

  assert.equal(automatic.joined, false);
  assert.equal(duplicate.joined, true);
  assert.equal(duplicate.promise, automatic.promise);
  assert.equal(targeted.joined, false);
  assert.notEqual(targeted.promise, automatic.promise);
  assert.deepEqual(started, ['automatic-one']);

  gates.get('automatic-one')();
  assert.equal(await duplicate.promise, 'automatic-one');
  await nextTurn();
  assert.deepEqual(started, ['automatic-one', 'targeted-tab-42']);
  gates.get('targeted-tab-42')();
  assert.equal(await targeted.promise, 'targeted-tab-42');
  assert.equal(maximum, 1);
});

test('an in-flight automatic trigger queues one fresh generation without swallowing FIFO work', async () => {
  const gates = new Map();
  const started = [];
  const queue = createSingleFlightQueue(label => {
    started.push(label);
    const gate = deferred();
    gates.set(label, gate);
    return gate.promise;
  });

  const stale = queue.run('automatic', 'automatic-stale');
  await nextTurn();
  assert.deepEqual(started, ['automatic-stale']);

  // This targeted request arrived first and must retain its FIFO position.
  const targeted = queue.run(undefined, 'targeted-tab-42');
  const fresh = queue.run('automatic', 'automatic-fresh');
  const duplicate = queue.run('automatic', 'automatic-duplicate');

  assert.equal(fresh.invalidated, true);
  assert.equal(fresh.joined, false);
  assert.ok(fresh.generation > stale.generation);
  assert.equal(duplicate.invalidated, true);
  assert.equal(duplicate.joined, true);
  assert.equal(duplicate.generation, fresh.generation);
  assert.equal(duplicate.promise, fresh.promise);

  gates.get('automatic-stale').resolve('stale-result');
  assert.equal(await stale.promise, 'stale-result');
  await nextTurn();
  assert.deepEqual(started, ['automatic-stale', 'targeted-tab-42']);

  gates.get('targeted-tab-42').resolve('targeted-result');
  assert.equal(await targeted.promise, 'targeted-result');
  await nextTurn();
  assert.deepEqual(started, [
    'automatic-stale',
    'targeted-tab-42',
    'automatic-fresh'
  ]);

  gates.get('automatic-fresh').resolve('fresh-result');
  assert.equal(await fresh.promise, 'fresh-result');
  assert.equal(await duplicate.promise, 'fresh-result');
  assert.equal(gates.has('automatic-duplicate'), false);
});

test('a failed scan does not poison the serial queue', async () => {
  const started = [];
  const queue = createSingleFlightQueue(async label => {
    started.push(label);
    if (label === 'bad') {
      throw Error('bad scan');
    }
    return label;
  });

  const bad = queue.run(undefined, 'bad').promise;
  const healthy = queue.run(undefined, 'healthy').promise;
  await assert.rejects(bad, /bad scan/);
  assert.equal(await healthy, 'healthy');
  assert.deepEqual(started, ['bad', 'healthy']);
});

test('only unscoped default checks receive the automatic flight key', () => {
  assert.equal(metadataFlightKey(undefined, undefined), 'automatic');
  assert.equal(metadataFlightKey(undefined, {}), 'automatic');
  assert.equal(metadataFlightKey([], {}), undefined);
  assert.equal(metadataFlightKey([{id: 42}], {}), undefined);
  assert.equal(metadataFlightKey(undefined, {'ignore.meta.data': true}), undefined);
  assert.equal(metadataFlightKey(undefined, null), undefined);
});

test('a 500-tab scan stays bounded and preserves deterministic oldest ordering', async () => {
  const tabs = Array.from({length: 500}, (_, index) => ({
    id: index + 1,
    time: index % 11 === 0 ? 100 : 500 - index
  }));
  let active = 0;
  let maximum = 0;
  const started = performance.now();
  const scan = await runBoundedScan(tabs, async tab => {
    active += 1;
    maximum = Math.max(maximum, active);
    if (tab.id % 37 === 0) await new Promise(resolve => setTimeout(resolve, 1));
    active -= 1;
    return {...tab, eligible: true};
  }, {concurrency: 4, timeout: 2000});

  assert.equal(maximum, 4);
  assert.equal(scan.completed.length, 500);
  assert.equal(scan.timedOut, false);
  assert.ok(performance.now() - started < 2000);
  const expected = tabs.map((tab, index) => ({tab, index}))
    .toSorted((a, b) => a.tab.time - b.tab.time || a.index - b.index)
    .slice(0, 50).map(entry => entry.tab.id);
  assert.deepEqual(selectOldest(
    scan.completed.map(entry => entry.value),
    tab => tab.time,
    50
  ).map(tab => tab.id), expected);
});

test('oldest selection is stable, deterministic, limited, and non-mutating', () => {
  const items = [
    {id: 1, time: 30},
    {id: 2, time: 10},
    {id: 3, time: 10},
    {id: 4, time: 'unknown'},
    {id: 5, time: 20}
  ];

  assert.deepEqual(
    selectOldest(items, item => item.time, 4).map(item => item.id),
    [2, 3, 5, 1]
  );
  assert.deepEqual(items.map(item => item.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(selectOldest(items, item => item.time, 0), []);
});

test('eligible Edge-frozen tabs are partitioned before renderer metadata', () => {
  const now = 1_000_000;
  const loaded = {id: 1, discarded: false, frozen: false};
  const old = {
    id: 2,
    active: false,
    autoDiscardable: true,
    discarded: false,
    frozen: true,
    lastAccessed: now - 200_000,
    pinned: false,
    status: 'complete'
  };
  const recent = {...old, id: 3, lastAccessed: now - 10_000};
  const missingAge = {...old, id: 4, lastAccessed: undefined};
  const nonDiscardable = {...old, id: 5, autoDiscardable: false};
  const pinned = {...old, id: 6, pinned: true};
  const result = partitionFrozenTabs([
    loaded,
    old,
    recent,
    missingAge,
    nonDiscardable,
    pinned
  ], {
    audio: false,
    form: false,
    paused: false,
    period: 100,
    pinned: true,
    'notification.permission': false
  }, {}, now);

  assert.deepEqual(result.renderer.map(tab => tab.id), [1]);
  assert.deepEqual(result.eligible.map(entry => entry.tab.id), [2]);
  assert.deepEqual(result.eligible.map(entry => entry.time), [old.lastAccessed]);
  assert.deepEqual(result.protected.map(entry => [entry.tab.id, entry.reason]), [
    [3, 'tab is not old enough'],
    [4, 'last-accessed time is unavailable'],
    [5, 'tab is not automatically discardable'],
    [6, 'pinned-tab protection is enabled']
  ]);
});

test('renderer-only automatic protections fail closed for frozen tabs', () => {
  const tab = {
    id: 9,
    active: false,
    audible: false,
    autoDiscardable: true,
    frozen: true,
    lastAccessed: 1,
    pinned: false,
    status: 'complete'
  };
  const base = {
    audio: false,
    form: false,
    paused: false,
    period: 0,
    pinned: false,
    'notification.permission': false
  };
  const cases = [
    ['form', 'unsaved-form state cannot be verified while frozen'],
    ['audio', 'picture-in-picture state cannot be verified while frozen'],
    ['paused', 'paused-media state cannot be verified while frozen'],
    ['notification.permission', 'notification permission cannot be verified while frozen']
  ];

  for (const [preference, reason] of cases) {
    const result = partitionFrozenTabs([tab], {
      ...base,
      [preference]: true
    }, {}, 1000);
    assert.deepEqual(result.eligible, [], preference);
    assert.equal(result.protected[0].reason, reason, preference);
  }

  const loading = partitionFrozenTabs([{...tab, status: 'loading'}], base, {}, 1000);
  assert.equal(loading.protected[0].reason, 'tab readiness cannot be verified while frozen');
  const ignoredReadiness = partitionFrozenTabs([{...tab, status: 'loading'}], base, {
    'ignore.ready.state': true
  }, 1000);
  assert.deepEqual(ignoredReadiness.eligible.map(entry => entry.tab.id), [9]);
});

test('frozen candidates bypass metadata and use the supplied takeover operation', async () => {
  const loaded = {id: 1, discarded: false, frozen: false};
  const frozen = {
    id: 2,
    active: false,
    autoDiscardable: true,
    discarded: false,
    frozen: true,
    lastAccessed: 100,
    status: 'complete'
  };
  const partition = partitionFrozenTabs([loaded, frozen], {
    audio: false,
    form: false,
    paused: false,
    period: 0,
    'notification.permission': false
  }, {}, 1000);
  const injected = [];
  await runBoundedScan(partition.renderer, tab => {
    injected.push(tab.id);
    return {time: 200};
  });

  const calls = [];
  const results = await runDiscardCandidates([
    {kind: 'discard', tab: loaded, time: 200},
    {kind: 'takeover', tab: frozen, time: 100}
  ], {
    discard: async tab => {
      calls.push(`discard:${tab.id}`);
      return true;
    },
    takeover: async tab => {
      calls.push(`takeover:${tab.id}`);
      return true;
    }
  });

  assert.deepEqual(injected, [1]);
  assert.deepEqual(calls, ['discard:1', 'takeover:2']);
  assert.deepEqual(results.map(result => result.success), [true, true]);
});

test('one failed frozen takeover does not abort deterministic peer work', async () => {
  const calls = [];
  const results = await runDiscardCandidates([
    {kind: 'takeover', tab: {id: 1}, time: 1},
    {kind: 'takeover', tab: {id: 2}, time: 2}
  ], {
    discard: async () => assert.fail('frozen tabs must not use ordinary discard'),
    takeover: async tab => {
      calls.push(tab.id);
      if (tab.id === 1) {
        throw Error('contended');
      }
      return true;
    }
  });

  assert.deepEqual(calls, [1, 2]);
  assert.equal(results[0].success, false);
  assert.match(results[0].error.message, /contended/);
  assert.equal(results[1].success, true);
});

test('loaded discard outcomes preserve per-tab false and thrown reasons', async () => {
  const tabs = [{id: 1}, {id: 2}, {id: 3}];
  const settled = await runDiscardCandidates(tabs.map(tab => ({
    kind: 'discard',
    tab,
    time: tab.id
  })), {
    discard: async tab => {
      if (tab.id === 2) {
        return false;
      }
      if (tab.id === 3) {
        throw Error('native failure');
      }
      return true;
    },
    takeover: async () => assert.fail('loaded tabs do not use takeover')
  });
  const outcomes = loadedDiscardOutcomes(settled);

  assert.deepEqual(outcomes.succeeded.map(entry => entry.tab.id), [1]);
  assert.deepEqual(outcomes.failed.map(entry => [entry.tab.id, entry.reason]), [
    [2, 'loaded discard returned false'],
    [3, 'loaded discard failed: native failure']
  ]);
});

test('loaded outcome aggregation ignores frozen takeover results', () => {
  const tab = {id: 8};
  assert.deepEqual(loadedDiscardOutcomes([{
    kind: 'takeover',
    success: false,
    tab,
    value: false
  }]), {failed: [], succeeded: []});
});
