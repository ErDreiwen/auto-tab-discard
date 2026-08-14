import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {
  ALARM_BASE_BACKOFF,
  ALARM_CATCH_UP_KEY,
  ALARM_MAX_BACKOFF,
  ALARM_MAX_ELAPSED,
  backoffDelay,
  createAlarmCatchUp
} from '../v3/worker/core/alarm-catch-up.mjs';

const deferred = () => {
  let reject;
  let resolve;
  const promise = new Promise((onResolve, onReject) => {
    reject = onReject;
    resolve = onResolve;
  });
  return {promise, reject, resolve};
};

const storage = initial => {
  const state = structuredClone(initial || {});
  return {
    area: {
      get(defaults, callback) {
        callback({...defaults, ...structuredClone(state)});
      },
      set(values, callback) {
        Object.assign(state, structuredClone(values));
        callback();
      }
    },
    state
  };
};

test('a fake-clock seven-day suspension coalesces every missed alarm into one check', async () => {
  let clock = 10_000;
  const previous = {
    failures: 0,
    lastCompleted: clock,
    lastStarted: clock - 1,
    nextRetry: 0
  };
  const persisted = storage({[ALARM_CATCH_UP_KEY]: previous});
  clock += 7 * 24 * 60 * 60 * 1000;
  const gate = deferred();
  const reasons = [];
  const catchUp = createAlarmCatchUp({
    now: () => clock,
    run: reason => {
      reasons.push(reason);
      return gate.promise;
    },
    storageArea: persisted.area
  });

  const resumes = Array.from({length: 1000}, () => catchUp.resume(10 * 60 * 1000));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(reasons.length, 1);
  assert.equal(persisted.state[ALARM_CATCH_UP_KEY].lastStarted, clock);
  assert.equal(persisted.state[ALARM_CATCH_UP_KEY].lastCompleted, previous.lastCompleted);
  gate.resolve('complete');
  const results = await Promise.all(resumes);
  assert.ok(results.every(result => result.coalesced === false));
  assert.equal(results[0].elapsed, ALARM_MAX_ELAPSED);
  assert.equal(persisted.state[ALARM_CATCH_UP_KEY].lastCompleted, clock);

  const stale = await catchUp.trigger({scheduledTime: previous.lastCompleted + 1});
  assert.equal(stale.coalesced, true);
  assert.equal(stale.reason, 'already-completed');
  assert.equal(reasons.length, 1);
});

test('last-started persists before completion and duplicate triggers share one flight', async () => {
  let clock = 50_000;
  const persisted = storage();
  const gate = deferred();
  let calls = 0;
  const catchUp = createAlarmCatchUp({
    now: () => clock,
    run: () => {
      calls += 1;
      return gate.promise;
    },
    storageArea: persisted.area
  });
  const first = catchUp.trigger({scheduledTime: clock - 1000});
  const duplicate = catchUp.trigger({scheduledTime: clock - 2000});
  assert.equal(first, duplicate);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.deepEqual(persisted.state[ALARM_CATCH_UP_KEY], {
    failures: 0,
    lastCompleted: 0,
    lastStarted: clock,
    nextRetry: 0
  });
  clock += 25;
  gate.resolve(true);
  await first;
  assert.equal(persisted.state[ALARM_CATCH_UP_KEY].lastStarted, 50_000);
  assert.equal(persisted.state[ALARM_CATCH_UP_KEY].lastCompleted, 50_025);
});

test('an alarm arriving after the scan snapshot queues exactly one fresh generation', async () => {
  let clock = 75_000;
  const persisted = storage();
  const gates = [deferred(), deferred()];
  const reasons = [];
  const catchUp = createAlarmCatchUp({
    now: () => clock,
    run: reason => {
      reasons.push(reason);
      return gates[reasons.length - 1].promise;
    },
    storageArea: persisted.area
  });

  const stale = catchUp.trigger({scheduledTime: clock - 1000}, 'number/first');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(reasons.length, 1);

  const fresh = catchUp.trigger({scheduledTime: clock}, 'number/fresh');
  const duplicate = catchUp.trigger({scheduledTime: clock + 1}, 'number/latest');
  assert.equal(fresh, duplicate);

  clock += 10;
  gates[0].resolve('stale');
  assert.equal((await stale).value, 'stale');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(reasons.length, 2);
  assert.match(reasons[1], /^number\/latest(?:\/catch-up-\d+)?$/);

  clock += 10;
  gates[1].resolve('fresh');
  const result = await fresh;
  assert.equal(result.coalesced, false);
  assert.equal(result.generation, 2);
  assert.equal(result.value, 'fresh');
  assert.equal(reasons.length, 2);
  assert.equal(persisted.state[ALARM_CATCH_UP_KEY].lastCompleted, clock);
});

test('repeated API failures use persisted bounded exponential backoff', async () => {
  let clock = 1000;
  const persisted = storage();
  let calls = 0;
  const catchUp = createAlarmCatchUp({
    now: () => clock,
    run: async () => {
      calls += 1;
      throw Error('browser API unavailable');
    },
    storageArea: persisted.area
  });

  await assert.rejects(catchUp.trigger({scheduledTime: 1}), /browser API unavailable/);
  assert.equal(persisted.state[ALARM_CATCH_UP_KEY].failures, 1);
  assert.equal(persisted.state[ALARM_CATCH_UP_KEY].nextRetry, clock + ALARM_BASE_BACKOFF);
  assert.equal((await catchUp.trigger({scheduledTime: 2})).reason, 'backoff');
  assert.equal(calls, 1);

  clock += ALARM_BASE_BACKOFF;
  await assert.rejects(catchUp.trigger({scheduledTime: 2}), /browser API unavailable/);
  assert.equal(persisted.state[ALARM_CATCH_UP_KEY].failures, 2);
  assert.equal(persisted.state[ALARM_CATCH_UP_KEY].nextRetry, clock + ALARM_BASE_BACKOFF * 2);
  assert.equal(backoffDelay(1), ALARM_BASE_BACKOFF);
  assert.equal(backoffDelay(2), ALARM_BASE_BACKOFF * 2);
  assert.equal(backoffDelay(100), ALARM_MAX_BACKOFF);
});

test('a current completed check does not produce a resume scan', async () => {
  const clock = 1_000_000;
  const persisted = storage({
    [ALARM_CATCH_UP_KEY]: {
      failures: 0,
      lastCompleted: clock - 100,
      lastStarted: clock - 200,
      nextRetry: 0
    }
  });
  let calls = 0;
  const catchUp = createAlarmCatchUp({
    now: () => clock,
    run: async () => calls += 1,
    storageArea: persisted.area
  });
  const result = await catchUp.resume(10 * 60 * 1000);
  assert.equal(result.reason, 'current');
  assert.equal(calls, 0);
});

test('number alarms and resume catch-up enter the existing number.check single flight', async () => {
  const source = await readFile(new URL('../v3/worker/modes/number.mjs', import.meta.url), 'utf8');
  assert.match(source, /run: reason => number\.check\(undefined, undefined, reason\)/);
  assert.match(source, /alarmCatchUp\.trigger\(\{scheduledTime: alarm\.scheduledTime\}/);
  assert.match(source, /alarmCatchUp\.resume\(ps\.period \* 1000/);
  assert.doesNotMatch(source, /number\.check\(undefined, undefined, 'number\/1'\)/);
});
