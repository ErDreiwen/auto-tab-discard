const ALARM_CATCH_UP_KEY = '__numberAlarmCatchUp';
const ALARM_MAX_ELAPSED = 7 * 24 * 60 * 60 * 1000;
const ALARM_BASE_BACKOFF = 30 * 1000;
const ALARM_MAX_BACKOFF = 30 * 60 * 1000;
const ALARM_MAX_FAILURES = 8;

const cleanTimestamp = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
const cleanFailures = value => Math.min(ALARM_MAX_FAILURES, Math.max(0, Math.floor(Number(value) || 0)));
const normalize = value => ({
  failures: cleanFailures(value?.failures),
  lastCompleted: cleanTimestamp(value?.lastCompleted),
  lastStarted: cleanTimestamp(value?.lastStarted),
  nextRetry: cleanTimestamp(value?.nextRetry)
});

const callbackCall = (area, method, ...arguments_) => new Promise((resolve, reject) => {
  let settled = false;
  const callback = value => {
    if (settled) {
      return;
    }
    settled = true;
    const error = globalThis.chrome?.runtime?.lastError;
    error ? reject(Error(error.message || String(error))) : resolve(value);
  };
  try {
    const returned = area[method](...arguments_, callback);
    if (returned && typeof returned.then === 'function') {
      returned.then(callback, reject);
    }
  }
  catch (error) {
    reject(error);
  }
});

const readState = async (storageArea, key) => {
  const result = await callbackCall(storageArea, 'get', {[key]: {}});
  return normalize(result?.[key]);
};
const writeState = (storageArea, key, state) => callbackCall(storageArea, 'set', {[key]: normalize(state)});

const backoffDelay = failures => Math.min(
  ALARM_MAX_BACKOFF,
  ALARM_BASE_BACKOFF * (2 ** Math.max(0, Math.min(ALARM_MAX_FAILURES, failures) - 1))
);

const createAlarmCatchUp = ({
  run,
  storageArea,
  now = Date.now,
  key = ALARM_CATCH_UP_KEY,
  maxElapsed = ALARM_MAX_ELAPSED
} = {}) => {
  if (typeof run !== 'function' || !storageArea) {
    throw new TypeError('Alarm catch-up requires run and storageArea');
  }
  let tail = Promise.resolve();
  let nextGeneration = 0;
  const generations = [];

  const execute = async record => {
    const state = await readState(storageArea, key);
    // This is the invalidation boundary. A later trigger cannot be covered by
    // the state/schedule snapshot below, so trigger() gives it one successor
    // generation instead of joining this stale check.
    record.snapshotTaken = true;
    const current = now();
    if (state.nextRetry > current) {
      return {coalesced: true, generation: record.generation, reason: 'backoff', state};
    }

    const scheduled = cleanTimestamp(record.alarm.scheduledTime);
    if (record.force !== true && record.alarm.catchUp !== true &&
        scheduled > 0 && state.lastCompleted >= scheduled) {
      return {
        coalesced: true,
        generation: record.generation,
        reason: 'already-completed',
        state
      };
    }
    const elapsed = scheduled > 0 ? Math.min(maxElapsed, Math.max(0, current - scheduled)) : 0;
    const started = {
      ...state,
      lastStarted: current
    };
    await writeState(storageArea, key, started);

    try {
      const value = await run(
        `${record.reason}${elapsed > 0 ? `/catch-up-${elapsed}` : ''}`
      );
      const completed = {
        failures: 0,
        lastCompleted: now(),
        lastStarted: current,
        nextRetry: 0
      };
      await writeState(storageArea, key, completed);
      return {
        coalesced: false,
        elapsed,
        generation: record.generation,
        state: completed,
        value
      };
    }
    catch (error) {
      const failures = Math.min(ALARM_MAX_FAILURES, state.failures + 1);
      const failed = {
        ...started,
        failures,
        nextRetry: now() + backoffDelay(failures)
      };
      // Prefer the original browser/API error even when persistence also fails.
      await writeState(storageArea, key, failed).catch(() => {});
      throw error;
    }
  };

  const mergeTrigger = (record, alarm, reason) => {
    const previous = cleanTimestamp(record.alarm.scheduledTime);
    const incoming = cleanTimestamp(alarm?.scheduledTime);
    record.alarm = {
      ...record.alarm,
      ...alarm,
      catchUp: record.alarm.catchUp === true || alarm?.catchUp === true,
      scheduledTime: Math.max(previous, incoming)
    };
    record.reason = reason;
  };

  const trigger = (alarm = {}, reason = 'number/alarm') => {
    const latest = generations.at(-1);
    if (latest?.snapshotTaken === false) {
      // The queued generation has not captured browser state yet and therefore
      // already covers this trigger. Keep its most recent schedule/reason.
      mergeTrigger(latest, alarm, reason);
      return latest.promise;
    }

    const record = {
      alarm: {...alarm},
      force: Boolean(latest),
      generation: ++nextGeneration,
      reason,
      snapshotTaken: false
    };
    generations.push(record);
    record.promise = tail.catch(() => {}).then(() => execute(record));
    tail = record.promise.catch(() => {});

    const clear = () => {
      const index = generations.indexOf(record);
      if (index !== -1) {
        generations.splice(index, 1);
      }
    };
    record.promise.then(clear, clear);
    return record.promise;
  };

  const resume = async (period, reason = 'number/resume') => {
    const state = await readState(storageArea, key);
    const current = now();
    const interval = Math.max(1, Number(period) || 1);
    if (state.nextRetry > current) {
      return {coalesced: true, reason: 'backoff', state};
    }
    if (state.failures > 0 || state.lastStarted > state.lastCompleted ||
        (state.lastCompleted > 0 && current - state.lastCompleted >= interval)) {
      return trigger({catchUp: true, scheduledTime: state.lastCompleted || state.lastStarted}, reason);
    }
    return {coalesced: true, reason: 'current', state};
  };

  const snapshot = () => readState(storageArea, key);
  return {resume, snapshot, trigger};
};

export {
  ALARM_BASE_BACKOFF,
  ALARM_CATCH_UP_KEY,
  ALARM_MAX_BACKOFF,
  ALARM_MAX_ELAPSED,
  backoffDelay,
  createAlarmCatchUp
};
