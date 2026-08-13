const KEY = '__ordinaryDiscardIntents';
const VERSION = 1;
const PENDING_TTL = 5 * 60_000;
const TERMINAL_TTL = 60_000;
const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'lost']);
let sequence = 0;

const callArea = (area, method, value) => new Promise((resolve, reject) => {
  try {
    area[method](value, result => {
      const error = globalThis.chrome?.runtime?.lastError;
      error ? reject(Error(error.message || String(error))) : resolve(result);
    });
  }
  catch (error) {
    reject(error);
  }
});

const jobId = now => globalThis.crypto?.randomUUID?.() ||
  `${now.toString(36)}-${(++sequence).toString(36)}`;
const validRecord = record => Boolean(record && typeof record.id === 'string' &&
  Number.isInteger(record.tabId) && Number.isFinite(record.createdAt) &&
  Number.isFinite(record.expiresAt) &&
  ['queued', 'running', 'resumed', ...TERMINAL].includes(record.status));

const createOrdinaryIntents = ({area, now = Date.now}) => {
  let tail = Promise.resolve();
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
  const mutate = task => {
    const operation = tail.then(async () => {
      const envelope = await load();
      const result = await task(envelope);
      await save(envelope);
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
  const enqueue = tab => mutate(envelope => {
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
      sequence: envelope.nextSequence,
      status: 'queued',
      tabId: tab.id,
      updatedAt: createdAt,
      ...(Number.isInteger(tab.windowId) && {windowId: tab.windowId})
    };
    return id;
  });
  const transition = (id, status, reason) => mutate(envelope => {
    const record = envelope.records[id];
    if (!record) return false;
    record.status = status;
    record.updatedAt = now();
    if (reason) record.reason = String(reason).slice(0, 160);
    return true;
  });
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
  const snapshot = async () => {
    const envelope = await load();
    return Object.values(envelope.records).map(record => ({...record}));
  };

  const recover = async ({getTab, resolveId = id => id, resume}) => {
    const pending = (await snapshot()).filter(record => !TERMINAL.has(record.status))
      .sort((a, b) => (a.sequence || 0) - (b.sequence || 0) ||
        a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const outcomes = [];
    for (const record of pending) {
      const id = resolveId(record.tabId);
      let tab;
      try {
        tab = await getTab(id);
      }
      catch (error) {}
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
      if (tab.active === true || tab.frozen === true || tab.autoDiscardable === false) {
        await transition(record.id, 'cancelled', 'live tab is no longer eligible');
        outcomes.push({id: record.id, status: 'cancelled', tabId: tab.id});
        continue;
      }
      await transition(record.id, 'resumed');
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

  return {enqueue, recover, removed, replace, snapshot, transition};
};

export {createOrdinaryIntents, KEY, PENDING_TTL, TERMINAL_TTL, VERSION};
