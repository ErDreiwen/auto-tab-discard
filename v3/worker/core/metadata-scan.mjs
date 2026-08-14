import {suspensionState} from './browser-state.mjs';
import {failureCauseFrom} from './failure-causes.mjs';

const METADATA_SCAN_CONCURRENCY = 4;
const METADATA_SCAN_TIMEOUT = 10000;
const METADATA_PHYSICAL_QUEUE_LIMIT = METADATA_SCAN_CONCURRENCY;

// A logical scan may hit its deadline while chrome.scripting.executeScript is
// still retained by the browser. Keep those physical operations leased across
// later scans; otherwise every alarm can start another full concurrency batch.
let metadataPhysicalActive = 0;
const metadataPhysicalQueue = [];

const metadataPhysicalPoolSnapshot = () => Object.freeze({
  active: metadataPhysicalActive,
  limit: METADATA_SCAN_CONCURRENCY,
  maxQueued: METADATA_PHYSICAL_QUEUE_LIMIT,
  queued: metadataPhysicalQueue.length
});

const createMetadataPhysicalLease = () => {
  metadataPhysicalActive += 1;
  let released = false;
  return Object.freeze({
    status: 'acquired',
    release: () => {
      if (released) {
        return;
      }
      released = true;
      metadataPhysicalActive = Math.max(0, metadataPhysicalActive - 1);
      while (metadataPhysicalActive < METADATA_SCAN_CONCURRENCY && metadataPhysicalQueue.length) {
        const waiter = metadataPhysicalQueue.shift();
        if (waiter.settled) {
          continue;
        }
        waiter.settled = true;
        clearTimeout(waiter.timer);
        waiter.resolve(createMetadataPhysicalLease());
      }
    }
  });
};

const acquireMetadataPhysicalLease = timeout => {
  if (metadataPhysicalActive < METADATA_SCAN_CONCURRENCY) {
    return Promise.resolve(createMetadataPhysicalLease());
  }
  if (metadataPhysicalQueue.length >= METADATA_PHYSICAL_QUEUE_LIMIT) {
    return Promise.resolve(Object.freeze({status: 'capacity'}));
  }

  const remaining = Math.max(0, Number(timeout) || 0);
  if (remaining === 0) {
    return Promise.resolve(Object.freeze({status: 'deadline'}));
  }
  return new Promise(resolve => {
    const waiter = {resolve, settled: false, timer: undefined};
    waiter.timer = setTimeout(() => {
      if (waiter.settled) {
        return;
      }
      waiter.settled = true;
      const index = metadataPhysicalQueue.indexOf(waiter);
      if (index !== -1) {
        metadataPhysicalQueue.splice(index, 1);
      }
      resolve(Object.freeze({status: 'deadline'}));
    }, remaining);
    metadataPhysicalQueue.push(waiter);
  });
};

const positiveInteger = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
};

const settleBefore = (operation, timeout) => new Promise(resolve => {
  let settled = false;
  const finish = outcome => {
    if (settled === false) {
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    }
  };
  const timer = setTimeout(() => finish({status: 'deadline'}), timeout);

  Promise.resolve(operation).then(
    value => finish({status: 'fulfilled', value}),
    error => finish({status: 'rejected', error})
  );
});

// Runs only a small number of metadata injections at once. Every output list is
// kept in input order even though workers can finish in any order.
const runBoundedScan = async (items, worker, options = {}) => {
  const input = [...items];
  const concurrency = Math.min(
    input.length || 1,
    METADATA_SCAN_CONCURRENCY,
    positiveInteger(options.concurrency, METADATA_SCAN_CONCURRENCY)
  );
  const timeout = Math.max(0, Number.isFinite(Number(options.timeout)) ?
    Number(options.timeout) : METADATA_SCAN_TIMEOUT);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const startedAt = now();
  const deadline = startedAt + timeout;
  const outcomes = new Array(input.length);
  let cursor = 0;
  let capacityReached = false;
  let started = 0;

  const take = () => {
    if (cursor >= input.length || now() >= deadline) {
      return undefined;
    }
    const index = cursor;
    cursor += 1;
    return {index, item: input[index]};
  };

  const runWorker = async () => {
    while (true) {
      const entry = take();
      if (!entry) {
        return;
      }

      const lease = await acquireMetadataPhysicalLease(deadline - now());
      if (lease.status !== 'acquired') {
        capacityReached ||= lease.status === 'capacity';
        outcomes[entry.index] = {
          ...entry,
          reason: lease.status === 'capacity' ? 'physical-capacity' : 'deadline',
          started: false,
          status: lease.status
        };
        return;
      }

      const beforeStart = deadline - now();
      if (beforeStart <= 0) {
        lease.release();
        outcomes[entry.index] = {...entry, reason: 'deadline', started: false, status: 'deadline'};
        return;
      }

      let operation;
      started += 1;
      try {
        operation = worker(entry.item, entry.index);
      }
      catch (error) {
        operation = Promise.reject(error);
      }
      // A logical deadline does not release physical capacity. Only the
      // underlying browser operation settling can admit another injection.
      Promise.resolve(operation).then(lease.release, lease.release);

      const remaining = deadline - now();
      if (remaining <= 0) {
        // Attach a rejection handler even though this late result is ignored.
        Promise.resolve(operation).catch(() => {});
        outcomes[entry.index] = {...entry, reason: 'deadline', started: true, status: 'deadline'};
        return;
      }

      const outcome = await settleBefore(operation, remaining);
      outcomes[entry.index] = {...entry, ...outcome, started: true};
      if (outcome.status === 'deadline') {
        return;
      }
    }
  };

  await Promise.all(Array.from({length: concurrency}, runWorker));

  // Work not started before the shared deadline is skipped without ever calling
  // the injection function. Running work that hit the deadline is skipped too.
  for (let index = cursor; index < input.length; index += 1) {
    const status = capacityReached && now() < deadline ? 'capacity' : 'deadline';
    outcomes[index] = {
      index,
      item: input[index],
      reason: status === 'capacity' ? 'physical-capacity' : 'deadline',
      status,
      started: false
    };
  }

  const completed = [];
  const failed = [];
  const skipped = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'fulfilled') {
      completed.push({
        index: outcome.index,
        item: outcome.item,
        value: outcome.value
      });
    }
    else if (outcome.status === 'rejected') {
      failed.push({
        index: outcome.index,
        item: outcome.item,
        error: outcome.error
      });
    }
    else {
      skipped.push({
        index: outcome.index,
        item: outcome.item,
        reason: outcome.reason || 'deadline',
        started: outcome.started !== false
      });
    }
  }

  return {
    completed,
    failed,
    skipped,
    started,
    total: input.length,
    timedOut: skipped.length !== 0,
    elapsed: Math.max(0, now() - startedAt)
  };
};

// A keyed request joins an equivalent request while that generation is still
// queued. Once its task has started, a new trigger invalidates that snapshot and
// creates exactly one successor generation. Further equivalent triggers join
// the queued successor. Unkeyed requests are always retained on the same FIFO,
// so a targeted/manual scan is never replaced by an automatic invalidation.
const createSingleFlightQueue = task => {
  let tail = Promise.resolve();
  const keyed = new Map();
  let nextGeneration = 0;

  const enqueue = operation => {
    const promise = tail.catch(() => {}).then(operation);
    tail = promise.catch(() => {});
    return promise;
  };

  const createGeneration = (key, records, args, invalidated) => {
    const record = {
      args,
      generation: ++nextGeneration,
      invalidated,
      started: false
    };
    records.push(record);
    record.promise = enqueue(() => {
      record.started = true;
      return task(...record.args);
    });

    const clear = () => {
      const index = records.indexOf(record);
      if (index !== -1) {
        records.splice(index, 1);
      }
      if (records.length === 0 && keyed.get(key) === records) {
        keyed.delete(key);
      }
    };
    record.promise.then(clear, clear);
    return record;
  };

  const run = (key, ...args) => {
    if (key === undefined) {
      return {
        generation: ++nextGeneration,
        invalidated: false,
        joined: false,
        promise: enqueue(() => task(...args))
      };
    }

    let records = keyed.get(key);
    if (!records) {
      records = [];
      keyed.set(key, records);
    }

    const latest = records.at(-1);
    if (latest?.started === false) {
      return {
        generation: latest.generation,
        invalidated: latest.invalidated,
        joined: true,
        promise: latest.promise
      };
    }

    const record = createGeneration(key, records, args, Boolean(latest));

    return {
      generation: record.generation,
      invalidated: record.invalidated,
      joined: false,
      promise: record.promise
    };
  };

  return {run};
};

const metadataFlightKey = (filterTabsFrom, options) => {
  const automaticOptions = options === undefined ||
    (options && typeof options === 'object' && Object.keys(options).length === 0);

  return filterTabsFrom === undefined && automaticOptions ? 'automatic' : undefined;
};

const frozenProtectionReason = (tab, preferences, options, now) => {
  if (tab.active === true) {
    return 'tab is active';
  }
  if (tab.autoDiscardable === false) {
    return 'tab is not automatically discardable';
  }
  if (preferences.pinned === true && tab.pinned === true) {
    return 'pinned-tab protection is enabled';
  }
  if (preferences.audio === true && tab.audible === true) {
    return 'tab is audible';
  }

  // A frozen renderer cannot answer the metadata probe. Fail closed for every
  // enabled condition whose state cannot be established from tabs.Tab alone.
  if (preferences.form === true) {
    return 'unsaved-form state cannot be verified while frozen';
  }
  if (preferences.audio === true) {
    return 'picture-in-picture state cannot be verified while frozen';
  }
  if (preferences.paused === true) {
    return 'paused-media state cannot be verified while frozen';
  }
  if (preferences['notification.permission'] === true) {
    return 'notification permission cannot be verified while frozen';
  }
  if (options['ignore.ready.state'] !== true && tab.status !== 'complete') {
    return 'tab readiness cannot be verified while frozen';
  }

  const period = Math.max(0, Number(preferences.period) || 0) * 1000;
  const lastAccessed = typeof tab.lastAccessed === 'number' ? tab.lastAccessed : NaN;
  if (period > 0 && Number.isFinite(lastAccessed) === false) {
    return 'last-accessed time is unavailable';
  }
  if (period > 0 && now - lastAccessed < period) {
    return 'tab is not old enough';
  }
};

// Edge-frozen tabs cannot run the renderer metadata script. Partition them
// before scanning: only tabs whose normal automatic protections can be proven
// safe from browser metadata become takeover candidates.
const partitionFrozenTabs = (tabs, preferences = {}, options = {}, now = Date.now()) => {
  const renderer = [];
  const eligible = [];
  const protectedTabs = [];

  for (const tab of tabs) {
    const state = suspensionState(tab);
    if (state.kind === 'unknown' || state.kind === 'missing' || state.kind === 'active') {
      protectedTabs.push({tab, reason: state.reason || `tab suspension state is ${state.kind}`});
      continue;
    }
    if (state.kind === 'loaded') {
      renderer.push(tab);
      continue;
    }
    if (state.kind === 'discarded') {
      protectedTabs.push({tab, reason: 'tab is already discarded'});
      continue;
    }

    const reason = frozenProtectionReason(tab, preferences, options, now);
    if (reason) {
      protectedTabs.push({tab, reason});
    }
    else {
      const lastAccessed = typeof tab.lastAccessed === 'number' ? tab.lastAccessed : NaN;
      eligible.push({
        tab,
        // Unknown age is allowed only when the period check is disabled. Sort
        // it after candidates with a known age for deterministic selection.
        time: Number.isFinite(lastAccessed) ? lastAccessed : Infinity
      });
    }
  }

  return {eligible, protected: protectedTabs, renderer};
};

const runDiscardCandidates = async (candidates, operations) => {
  return Promise.all(candidates.map(async candidate => {
    const operation = candidate.kind === 'takeover' ? operations.takeover : operations.discard;
    try {
      const value = await operation(candidate.tab);
      return {
        ...candidate,
        success: value === true || value?.status === 'succeeded' || value?.ok === true,
        value
      };
    }
    catch (error) {
      return {
        ...candidate,
        error,
        success: false
      };
    }
  }));
};

const loadedDiscardOutcomes = results => {
  const failed = [];
  const succeeded = [];

  for (const result of results.filter(entry => entry.kind === 'discard')) {
    if (result.success === true) {
      succeeded.push({tab: result.tab});
    }
    else {
      failed.push({
        failureCause: failureCauseFrom(result.error || result.value),
        tab: result.tab,
        reason: result.error ?
          `loaded discard failed: ${result.error.message || String(result.error)}` :
          result.value?.reason || 'loaded discard returned false'
      });
    }
  }
  return {failed, succeeded};
};

const selectOldest = (items, getTime, limit = Infinity) => {
  const numericLimit = Number(limit);
  const count = Number.isFinite(numericLimit) ?
    Math.max(0, Math.floor(numericLimit)) : items.length;

  return items.map((item, index) => {
    const value = Number(getTime(item));
    return {
      item,
      index,
      time: Number.isFinite(value) ? value : Infinity
    };
  }).sort((a, b) => a.time - b.time || a.index - b.index)
    .slice(0, count)
    .map(entry => entry.item);
};

export {
  createSingleFlightQueue,
  METADATA_SCAN_CONCURRENCY,
  METADATA_SCAN_TIMEOUT,
  loadedDiscardOutcomes,
  metadataFlightKey,
  metadataPhysicalPoolSnapshot,
  partitionFrozenTabs,
  runBoundedScan,
  runDiscardCandidates,
  selectOldest
};
