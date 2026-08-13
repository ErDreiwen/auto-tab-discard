import test from 'node:test';
import assert from 'node:assert/strict';

import {createTakeoverScheduler} from '../v3/worker/core/takeover-scheduler.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => resolve = done);
  return {promise, resolve};
};

test('bounds global takeover work while serializing only matching focus domains', async () => {
  const scheduler = createTakeoverScheduler({concurrency: 3});
  const gates = new Map();
  const events = [];
  let active = 0;
  let maximum = 0;
  const run = (id, key) => {
    const gate = deferred();
    gates.set(id, gate);
    return scheduler.schedule(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      events.push(`start:${id}`);
      await gate.promise;
      events.push(`end:${id}`);
      active -= 1;
      return id;
    }, {key});
  };

  const a1 = run('a1', 'window:1');
  const a2 = run('a2', 'window:1');
  const b1 = run('b1', 'window:2');
  const plain = run('plain');
  await new Promise(resolve => setTimeout(resolve));
  assert.deepEqual(events, ['start:a1', 'start:b1', 'start:plain']);
  assert.deepEqual(scheduler.snapshot(), {
    active: 3,
    activeKeys: 2,
    concurrency: 3,
    queued: 1
  });

  gates.get('a1').resolve();
  await a1.promise;
  await new Promise(resolve => setTimeout(resolve));
  assert.equal(events.includes('start:a2'), true);
  assert.equal(maximum, 3);
  for (const id of ['a2', 'b1', 'plain']) {
    gates.get(id).resolve();
  }
  assert.deepEqual(await Promise.all([a2.promise, b1.promise, plain.promise]), ['a2', 'b1', 'plain']);
  assert.equal(scheduler.snapshot().active, 0);
});

test('cancels a queued takeover without consuming a concurrency slot', async () => {
  const scheduler = createTakeoverScheduler({concurrency: 1});
  const gate = deferred();
  const head = scheduler.schedule(() => gate.promise);
  const queued = scheduler.schedule(() => assert.fail('cancelled task must never start'));
  assert.equal(queued.cancel('released before wake'), true);
  await assert.rejects(queued.promise, /released before wake/);
  assert.equal(scheduler.snapshot().queued, 0);
  gate.resolve(true);
  assert.equal(await head.promise, true);
});

test('a 100-job batch never exceeds its declared bound', async () => {
  const scheduler = createTakeoverScheduler({concurrency: 5});
  let active = 0;
  let maximum = 0;
  const jobs = Array.from({length: 100}, (_, index) => scheduler.schedule(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, index % 3));
    active -= 1;
    return index;
  }, {key: index % 10 === 0 ? `window:${index % 2}` : undefined}).promise);
  assert.deepEqual(await Promise.all(jobs), Array.from({length: 100}, (_, index) => index));
  assert.equal(maximum, 5);
  assert.deepEqual(scheduler.snapshot(), {active: 0, activeKeys: 0, concurrency: 5, queued: 0});
});

test('a rejected task releases both its global slot and per-window lock', async () => {
  const scheduler = createTakeoverScheduler({concurrency: 1});
  const events = [];
  const failed = scheduler.schedule(() => {
    events.push('failed:start');
    throw Error('renderer failed');
  }, {key: 'window:1'});
  const follower = scheduler.schedule(() => {
    events.push('follower:start');
    return 'finished';
  }, {key: 'window:1'});

  await assert.rejects(failed.promise, /renderer failed/);
  assert.equal(await follower.promise, 'finished');
  await new Promise(resolve => setTimeout(resolve));
  assert.deepEqual(events, ['failed:start', 'follower:start']);
  assert.deepEqual(scheduler.snapshot(), {
    active: 0,
    activeKeys: 0,
    concurrency: 1,
    queued: 0
  });
});

test('cancelling a blocked same-window job does not disturb its running lock owner', async () => {
  const scheduler = createTakeoverScheduler({concurrency: 2});
  const gate = deferred();
  const events = [];
  const owner = scheduler.schedule(async () => {
    events.push('owner:start');
    await gate.promise;
    events.push('owner:end');
  }, {key: 'window:1'});
  const blocked = scheduler.schedule(() => assert.fail('cancelled same-window task must not start'), {
    key: 'window:1'
  });
  const independent = scheduler.schedule(() => {
    events.push('independent:start');
    return true;
  }, {key: 'window:2'});

  assert.equal(blocked.cancel('release cancelled queued takeover'), true);
  await assert.rejects(blocked.promise, /release cancelled queued takeover/);
  assert.equal(await independent.promise, true);
  assert.deepEqual(scheduler.snapshot(), {
    active: 1,
    activeKeys: 1,
    concurrency: 2,
    queued: 0
  });
  gate.resolve();
  await owner.promise;
  await new Promise(resolve => setTimeout(resolve));
  assert.deepEqual(events, ['owner:start', 'independent:start', 'owner:end']);
  assert.equal(blocked.cancel(), false);
  assert.deepEqual(scheduler.snapshot(), {
    active: 0,
    activeKeys: 0,
    concurrency: 2,
    queued: 0
  });
});

test('rekeys queued work when a tab moves to a different window', async () => {
  const scheduler = createTakeoverScheduler({concurrency: 2});
  let releaseOne;
  let releaseTwo;
  const first = scheduler.schedule(() => new Promise(resolve => releaseOne = resolve), {
    key: 'window:1'
  });
  const second = scheduler.schedule(() => new Promise(resolve => releaseTwo = resolve), {
    key: 'window:2'
  });
  const moved = scheduler.schedule(() => 'moved', {key: 'window:1'});
  await Promise.resolve();

  assert.equal(moved.rekey('window:2'), true);
  assert.equal(scheduler.snapshot().queued, 1);
  releaseTwo('two');
  assert.equal(await moved.promise, 'moved');
  assert.equal(moved.rekey('window:3'), false);
  releaseOne('one');
  assert.deepEqual(await Promise.all([first.promise, second.promise]), ['one', 'two']);
});

test('fifty mixed-window jobs meet bounded p95 latency without focus-domain overlap', async () => {
  const scheduler = createTakeoverScheduler({concurrency: 4});
  const activeWindows = new Set();
  const start = performance.now();
  const completedAt = [];
  let active = 0;
  let maximum = 0;
  const jobs = Array.from({length: 50}, (_, index) => {
    const key = `window:${index % 10}`;
    return scheduler.schedule(async () => {
      assert.equal(activeWindows.has(key), false, `${key} overlapped its own focus domain`);
      activeWindows.add(key);
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, index % 3));
      active -= 1;
      activeWindows.delete(key);
      completedAt.push(performance.now() - start);
      return index;
    }, {key}).promise;
  });
  assert.deepEqual(await Promise.all(jobs), Array.from({length: 50}, (_, index) => index));
  const sorted = completedAt.toSorted((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  assert.ok(p95 < 500, `p95 ${p95.toFixed(1)}ms exceeded 500ms`);
  assert.equal(maximum, 4);
  assert.deepEqual(scheduler.snapshot(), {active: 0, activeKeys: 0, concurrency: 4, queued: 0});
});

test('release cancellation wins within one second without disturbing the focus lock owner', async () => {
  const scheduler = createTakeoverScheduler({concurrency: 2});
  const ownerGate = deferred();
  const owner = scheduler.schedule(() => ownerGate.promise, {key: 'window:1'});
  const queued = scheduler.schedule(() => assert.fail('released work must not run'), {key: 'window:1'});
  await Promise.resolve();
  const started = performance.now();
  assert.equal(queued.cancel('release has priority'), true);
  await assert.rejects(queued.promise, /release has priority/);
  assert.ok(performance.now() - started < 1000);
  assert.deepEqual(scheduler.snapshot(), {active: 1, activeKeys: 1, concurrency: 2, queued: 0});
  ownerGate.resolve(true);
  assert.equal(await owner.promise, true);
});

test('100 mixed jobs serialize only frozen focus pulses and meet the p95 budget', async () => {
  const scheduler = createTakeoverScheduler({concurrency: 4});
  const activePulseWindows = new Set();
  const completedAt = [];
  const started = performance.now();
  let active = 0;
  let maximum = 0;
  const jobs = Array.from({length: 100}, (_, index) => {
    const frozen = index % 5 === 0;
    const windowKey = `window:${index % 4}`;
    return scheduler.schedule(async () => {
      if (frozen) {
        assert.equal(activePulseWindows.has(windowKey), false, `${windowKey} pulse overlap`);
        activePulseWindows.add(windowKey);
      }
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, index % 2));
      active -= 1;
      if (frozen) {
        activePulseWindows.delete(windowKey);
      }
      completedAt.push(performance.now() - started);
      return index;
    }, {key: frozen ? windowKey : undefined}).promise;
  });
  assert.deepEqual(await Promise.all(jobs), Array.from({length: 100}, (_, index) => index));
  const sorted = completedAt.toSorted((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  assert.ok(p95 < 1000, `mixed p95 ${p95.toFixed(1)}ms exceeded 1s`);
  assert.equal(maximum, 4);
  assert.equal(activePulseWindows.size, 0);
  assert.deepEqual(scheduler.snapshot(), {active: 0, activeKeys: 0, concurrency: 4, queued: 0});
});

test('independent CPU and network limits admit native work past saturated reloads', async () => {
  const scheduler = createTakeoverScheduler({
    concurrency: 4,
    resourceLimits: {cpu: 3, network: 1}
  });
  const gates = new Map();
  const events = [];
  const active = {cpu: 0, network: 0};
  const maximum = {cpu: 0, network: 0};
  const run = (id, resources, key) => {
    const gate = deferred();
    gates.set(id, gate);
    return scheduler.schedule(async () => {
      events.push(`start:${id}`);
      for (const resource of resources) {
        active[resource] += 1;
        maximum[resource] = Math.max(maximum[resource], active[resource]);
      }
      await gate.promise;
      for (const resource of resources) active[resource] -= 1;
      events.push(`end:${id}`);
      return id;
    }, {key, resources});
  };

  const reloadOne = run('reload-1', ['cpu', 'network']);
  const reloadTwo = run('reload-2', ['cpu', 'network']);
  const nativeOne = run('native-1', ['cpu'], 'window:1');
  const nativeBlockedByKey = run('native-key-peer', ['cpu'], 'window:1');
  const nativeTwo = run('native-2', ['cpu'], 'window:2');
  const nativeCpuQueued = run('native-cpu-queued', ['cpu'], 'window:3');
  await new Promise(resolve => setTimeout(resolve));

  assert.deepEqual(events, ['start:reload-1', 'start:native-1', 'start:native-2']);
  assert.deepEqual(scheduler.snapshot(), {
    active: 3,
    activeKeys: 2,
    concurrency: 4,
    queued: 3,
    resources: {
      cpu: {active: 3, limit: 3},
      network: {active: 1, limit: 1}
    }
  });

  gates.get('native-2').resolve();
  assert.equal(await nativeTwo.promise, 'native-2');
  await new Promise(resolve => setTimeout(resolve));
  assert.equal(events.includes('start:native-cpu-queued'), true,
    'free CPU must admit an unrelated native job while network remains saturated');
  assert.equal(events.includes('start:reload-2'), false,
    'a second reload must wait for the independent network budget');

  gates.get('reload-1').resolve();
  assert.equal(await reloadOne.promise, 'reload-1');
  await new Promise(resolve => setTimeout(resolve));
  assert.equal(events.includes('start:reload-2'), true);
  assert.deepEqual(maximum, {cpu: 3, network: 1});

  gates.get('native-1').resolve();
  assert.equal(await nativeOne.promise, 'native-1');
  await new Promise(resolve => setTimeout(resolve));
  assert.equal(events.includes('start:native-key-peer'), true,
    'matching focus keys remain serialized after resource admission');

  for (const id of ['reload-2', 'native-key-peer', 'native-cpu-queued']) gates.get(id).resolve();
  assert.deepEqual(await Promise.all([
    reloadTwo.promise,
    nativeBlockedByKey.promise,
    nativeCpuQueued.promise
  ]), ['reload-2', 'native-key-peer', 'native-cpu-queued']);
  await new Promise(resolve => setTimeout(resolve));
  assert.deepEqual(scheduler.snapshot(), {
    active: 0,
    activeKeys: 0,
    concurrency: 4,
    queued: 0,
    resources: {
      cpu: {active: 0, limit: 3},
      network: {active: 0, limit: 1}
    }
  });
});

test('resource scheduling rejects undeclared classes before queueing work', () => {
  const scheduler = createTakeoverScheduler({resourceLimits: {cpu: 2}});
  assert.throws(() => scheduler.schedule(() => true, {resources: ['network']}),
    /unknown takeover scheduler resource: network/);
  assert.equal(scheduler.snapshot().queued, 0);
});

test('priority cleanup jumps queued work without preempting active resource owners', async () => {
  const scheduler = createTakeoverScheduler({
    concurrency: 1,
    resourceLimits: {cpu: 1}
  });
  const ownerGate = deferred();
  const events = [];
  let active = 0;
  let maximum = 0;
  const task = (name, gate) => scheduler.schedule(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    events.push(`start:${name}`);
    if (gate) await gate.promise;
    events.push(`end:${name}`);
    active -= 1;
    return name;
  }, {priority: name === 'cleanup' ? 1 : 0, resources: ['cpu']});

  const owner = task('owner', ownerGate);
  const queuedNormal = task('normal');
  const queuedCleanup = task('cleanup');
  await new Promise(resolve => setTimeout(resolve));
  assert.deepEqual(events, ['start:owner']);
  assert.equal(queuedCleanup.started, false,
    'priority must not preempt the active resource owner');
  assert.deepEqual(scheduler.snapshot(), {
    active: 1,
    activeKeys: 0,
    concurrency: 1,
    queued: 2,
    resources: {cpu: {active: 1, limit: 1}}
  });

  ownerGate.resolve();
  assert.equal(await owner.promise, 'owner');
  assert.equal(await queuedCleanup.promise, 'cleanup');
  assert.equal(await queuedNormal.promise, 'normal');
  assert.deepEqual(events, [
    'start:owner', 'end:owner',
    'start:cleanup', 'end:cleanup',
    'start:normal', 'end:normal'
  ]);
  assert.equal(maximum, 1, 'priority must retain the global and resource caps');
  await new Promise(resolve => setTimeout(resolve));
  assert.deepEqual(scheduler.snapshot(), {
    active: 0,
    activeKeys: 0,
    concurrency: 1,
    queued: 0,
    resources: {cpu: {active: 0, limit: 1}}
  });
});
