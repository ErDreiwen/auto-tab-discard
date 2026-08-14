const KEY = '__ordinaryDiscardIntents';
const VERSION = 2;
const PENDING_TTL = 5 * 60_000;
const TERMINAL_TTL = 60_000;
const STORAGE_TIMEOUT = 2000;
const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'lost']);
const STATUSES = new Set(['queued', 'running', 'resumed', ...TERMINAL]);
let sequence = 0;

const callArea = (area, method, value) => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (settle, result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    settle(result);
  };
  const timer = setTimeout(() => finish(
    reject,
    Error(`ordinary intent storage.${method} timed out`)
  ), STORAGE_TIMEOUT);
  try {
    if (typeof area?.[method] !== 'function') {
      finish(reject, Error(`ordinary intent storage.${method} is unavailable`));
      return;
    }
    const operation = area[method](value, result => {
      const error = globalThis.chrome?.runtime?.lastError;
      error ? finish(reject, Error(error.message || String(error))) : finish(resolve, result);
    });
    operation?.then?.(
      result => finish(resolve, result),
      error => finish(reject, error instanceof Error ? error : Error(String(error)))
    );
  }
  catch (error) {
    finish(reject, error);
  }
});

const jobId = now => globalThis.crypto?.randomUUID?.() ||
  `${now.toString(36)}-${(++sequence).toString(36)}`;
const validRecord = record => Boolean(record && typeof record.id === 'string' &&
  Number.isSafeInteger(record.tabId) && Number.isFinite(record.createdAt) &&
  Number.isFinite(record.expiresAt) && record.expiresAt > record.createdAt &&
  Number.isFinite(record.updatedAt) && record.updatedAt >= record.createdAt &&
  Number.isSafeInteger(record.sequence) && record.sequence > 0 &&
  Number.isSafeInteger(record.windowId) && typeof record.incognito === 'boolean' &&
  STATUSES.has(record.status));
const validTabScope = tab => Boolean(tab && Number.isSafeInteger(tab.id) &&
  Number.isSafeInteger(tab.windowId) && typeof tab.incognito === 'boolean');

const createOrdinaryIntents = ({area, now = Date.now}) => {
  let tail = Promise.resolve();
  let paused = false;
  let generation = 0;
  const load = async () => {
    const stored = await callArea(area, 'get', {[KEY]: null});
    const envelope = stored?.[KEY];
    if (envelope === null || envelope === undefined) {
      return {nextSequence: 0, records: {}, version: VERSION};
    }
    if (envelope.version !== VERSION || !envelope.records || typeof envelope.records !== 'object' ||
        Array.isArray(envelope.records)) {
      await callArea(area, 'remove', KEY);
      return {nextSequence: 0, records: {}, version: VERSION};
    }
    const records = Object.fromEntries(Object.entries(envelope.records)
      .filter(([id, record]) => id === record?.id && validRecord(record)));
    return {
      nextSequence: Number.isSafeInteger(envelope.nextSequence) ? envelope.nextSequence : 0,
      records,
      version: VERSION
    };
  };
  const save = envelope => callArea(area, 'set', {[KEY]: envelope});
  const persist = envelope => Object.keys(envelope.records).length === 0 ?
    callArea(area, 'remove', KEY) : save(envelope);
  const mutate = (task, options = {}) => {
    const blockedValue = Object.hasOwn(options, 'blockedValue') ?
      options.blockedValue : false;
    if (paused) {
      return Promise.resolve(blockedValue);
    }
    const admittedGeneration = generation;
    const operation = tail.then(async () => {
      if (admittedGeneration !== generation) {
        return blockedValue;
      }
      const envelope = await load();
      if (admittedGeneration !== generation) {
        return blockedValue;
      }
      const result = await task(envelope);
      if (admittedGeneration !== generation) {
        return blockedValue;
      }
      await persist(envelope);
      return result;
    });
    tail = operation.catch(() => undefined);
    return operation;
  };
  const prune = envelope => {
    const time = now();
    for (const [id, record] of Object.entries(envelope.records)) {
      if ((TERMINAL.has(record.status) && record.updatedAt + TERMINAL_TTL <= time) ||
          (!TERMINAL.has(record.status) && record.expiresAt <= time)) {
        delete envelope.records[id];
      }
    }
  };
  const enqueue = tab => {
    if (!validTabScope(tab)) {
      return Promise.resolve(undefined);
    }
    return mutate(envelope => {
      prune(envelope);
      const existing = Object.values(envelope.records).find(record =>
        record.tabId === tab.id && !TERMINAL.has(record.status));
      if (existing) {
        return existing.id;
      }
      const createdAt = now();
      const id = jobId(createdAt);
      envelope.nextSequence += 1;
      envelope.records[id] = {
        createdAt,
        expiresAt: createdAt + PENDING_TTL,
        id,
        incognito: tab.incognito === true,
        sequence: envelope.nextSequence,
        status: 'queued',
        tabId: tab.id,
        updatedAt: createdAt,
        windowId: tab.windowId
      };
      return id;
    }, {blockedValue: undefined});
  };
  const transition = (id, status, reason) => {
    if (typeof id !== 'string' || !STATUSES.has(status)) {
      return Promise.resolve(false);
    }
    return mutate(envelope => {
      const record = envelope.records[id];
      if (!record) return false;
      record.status = status;
      record.updatedAt = now();
      if (reason) record.reason = String(reason).slice(0, 160);
      return true;
    });
  };
  const replace = (removedId, addedId) => mutate(envelope => {
    let changed = false;
    for (const record of Object.values(envelope.records)) {
      if (!TERMINAL.has(record.status) && record.tabId === removedId) {
        record.tabId = addedId;
        record.updatedAt = now();
        changed = true;
      }
    }
    return changed;
  });
  const removed = tabId => mutate(envelope => {
    let changed = false;
    for (const record of Object.values(envelope.records)) {
      if (!TERMINAL.has(record.status) && record.tabId === tabId) {
        record.status = 'lost';
        record.reason = 'tab closed before discard completed';
        record.updatedAt = now();
        changed = true;
      }
    }
    return changed;
  });
  // Reads enforce retention at rest too. An expired pending intent must be
  // removed before recovery takes a snapshot, not merely when a later enqueue
  // happens to mutate the journal.
  const snapshot = () => mutate(envelope => {
    prune(envelope);
    return Object.values(envelope.records).map(record => ({...record}));
  }, {blockedValue: []});

  // Reset has two phases. Admission is paused synchronously before preference
  // storage is cleared, but already-admitted writes are allowed to finish if
  // that clear fails. Once reset commits, invalidate queued mutations and put
  // one journal removal behind every write that may already be in flight.
  const beginReset = () => {
    if (paused) {
      return undefined;
    }
    paused = true;
    let active = true;
    let clearPromise;
    const finish = () => {
      if (active) {
        active = false;
        paused = false;
      }
    };
    return Object.freeze({
      abort: finish,
      clear() {
        if (!active) {
          return Promise.reject(Error('ordinary intent reset barrier is no longer active'));
        }
        if (!clearPromise) {
          generation += 1;
          const operation = tail.then(() => callArea(area, 'remove', KEY));
          tail = operation.catch(() => undefined);
          clearPromise = operation;
        }
        return clearPromise;
      },
      complete: finish
    });
  };

  const recover = async ({getTab, revalidate, resolveId = id => id, resume}) => {
    const pending = (await snapshot()).filter(record => !TERMINAL.has(record.status))
      .sort((a, b) => (a.sequence || 0) - (b.sequence || 0) ||
        a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const outcomes = [];
    const candidates = [];
    for (const record of pending) {
      const id = resolveId(record.tabId);
      let tab;
      try {
        tab = await getTab(id);
      }
      catch (error) {
        await transition(record.id, 'failed', error?.message || String(error));
        outcomes.push({id: record.id, status: 'failed', tabId: id});
        continue;
      }
      if (!tab) {
        await transition(record.id, 'lost', 'tab is no longer present');
        outcomes.push({id: record.id, status: 'lost', tabId: id});
        continue;
      }
      if (tab.discarded === true) {
        await transition(record.id, 'completed', 'native discard already settled');
        outcomes.push({id: record.id, status: 'completed', tabId: tab.id});
        continue;
      }
      if (!validTabScope(tab) || tab.active === true || tab.frozen === true ||
          tab.autoDiscardable === false || tab.windowId !== record.windowId ||
          tab.incognito !== record.incognito) {
        await transition(record.id, 'cancelled', 'live tab is no longer eligible');
        outcomes.push({id: record.id, status: 'cancelled', tabId: tab.id});
        continue;
      }
      candidates.push({record, tab});
    }

    // Restart recovery is never authorized by the old tab snapshot alone.
    // The caller must rerun the complete live policy/metadata pipeline once
    // for this batch and return the exact IDs still eligible now. Missing,
    // malformed, or failed revalidation cancels every remaining intent.
    let eligible = new Set();
    if (candidates.length && typeof revalidate === 'function') {
      try {
        const result = await revalidate(candidates.map(entry => entry.tab));
        if (result instanceof Set && [...result].every(Number.isInteger)) {
          eligible = result;
        }
      }
      catch (error) {}
    }

    for (const {record, tab: policyTab} of candidates) {
      const tabId = policyTab.id;
      if (!eligible.has(tabId)) {
        await transition(record.id, 'cancelled', 'live protection policy rejected restart recovery');
        outcomes.push({id: record.id, status: 'cancelled', tabId});
        continue;
      }
      if (record.expiresAt <= now()) {
        await transition(record.id, 'cancelled', 'ordinary discard intent expired during restart recovery');
        outcomes.push({id: record.id, status: 'cancelled', tabId});
        continue;
      }

      // The metadata pass may take seconds. Refresh the exact tab and privacy
      // scope after it, before handing anything back to the native executor.
      let tab;
      try {
        tab = await getTab(resolveId(tabId));
      }
      catch (error) {
        await transition(record.id, 'failed', error?.message || String(error));
        outcomes.push({id: record.id, status: 'failed', tabId});
        continue;
      }
      if (!tab) {
        await transition(record.id, 'lost', 'tab closed during restart revalidation');
        outcomes.push({id: record.id, status: 'lost', tabId});
        continue;
      }
      if (tab.discarded === true) {
        await transition(record.id, 'completed', 'native discard settled during restart revalidation');
        outcomes.push({id: record.id, status: 'completed', tabId: tab.id});
        continue;
      }
      if (!validTabScope(tab) || tab.active === true || tab.frozen === true ||
          tab.autoDiscardable === false || tab.windowId !== record.windowId ||
          tab.incognito !== record.incognito) {
        await transition(record.id, 'cancelled', 'live tab changed during restart revalidation');
        outcomes.push({id: record.id, status: 'cancelled', tabId: tab.id});
        continue;
      }
      if (!await transition(record.id, 'resumed') || paused) {
        outcomes.push({id: record.id, status: 'cancelled', tabId: tab.id});
        continue;
      }
      let success = false;
      try {
        success = await resume(tab, record.id) === true;
      }
      catch (error) {
        await transition(record.id, 'failed', error?.message || String(error));
      }
      if (success) {
        await transition(record.id, 'completed');
      }
      else {
        const latest = (await snapshot()).find(entry => entry.id === record.id);
        if (latest && latest.status !== 'failed') {
          await transition(record.id, 'failed', 'resumed discard did not settle');
        }
      }
      outcomes.push({id: record.id, status: success ? 'completed' : 'failed', tabId: tab.id});
    }
    return outcomes;
  };

  return {beginReset, enqueue, recover, removed, replace, snapshot, transition};
};

export {createOrdinaryIntents, KEY, PENDING_TTL, TERMINAL_TTL, VERSION};
