const STORAGE_KEY = '__blankHelperRegistry';
const TRANSACTIONS_KEY = '$transactions';
const MAX_HELPERS = 128;
const MAX_TRANSACTIONS = 32;
const MAX_WINDOWS = 64;

const createHelperRegistry = ({
  activateTab,
  area = () => chrome.storage.session || chrome.storage.local,
  getTab,
  now = () => Date.now(),
  removeTab,
  transactionId = () => globalThis.crypto.randomUUID()
} = {}) => {
  const read = () => new Promise((resolve, reject) => area().get({[STORAGE_KEY]: {}}, result => {
    const error = chrome.runtime.lastError;
    if (error) {
      reject(Error(error.message || error));
    }
    else {
      resolve(result?.[STORAGE_KEY] && typeof result[STORAGE_KEY] === 'object' ? result[STORAGE_KEY] : {});
    }
  }));
  const write = records => new Promise((resolve, reject) => {
    const callback = () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(Error(error.message || error));
      }
      else {
        resolve();
      }
    };
    if (Object.keys(records).length) {
      area().set({[STORAGE_KEY]: records}, callback);
    }
    else {
      area().remove(STORAGE_KEY, callback);
    }
  });
  let tail = Promise.resolve();
  const mutate = task => {
    const operation = tail.then(async () => {
      const records = {...await read()};
      const result = await task(records);
      if (records[TRANSACTIONS_KEY] && Object.keys(records[TRANSACTIONS_KEY]).length === 0) {
        delete records[TRANSACTIONS_KEY];
      }
      await write(records);
      return result;
    });
    tail = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const transactions = records => {
    if (!records[TRANSACTIONS_KEY] || typeof records[TRANSACTIONS_KEY] !== 'object') {
      records[TRANSACTIONS_KEY] = {};
    }
    return records[TRANSACTIONS_KEY];
  };
  const transactionFor = (records, id) => transactions(records)[id];
  const helperEntries = records => Object.entries(records)
    .filter(([key, record]) => Number.isInteger(Number(key)) && record && typeof record === 'object');

  const begin = () => mutate(async records => {
    // Helper pages close themselves when hidden. Reap their small committed
    // records at the next command so a long-lived worker cannot eventually hit
    // the registry bound without ever receiving another startup cleanup.
    for (const [key, record] of helperEntries(records).slice(0, MAX_HELPERS)) {
      if (record.state !== 'committed') {
        continue;
      }
      let helper;
      try {
        helper = await getTab(Number(key));
      }
      catch (error) {
        if (!/no tab|not found|invalid tab/i.test(error?.message || '')) {
          continue;
        }
      }
      if (!helper) {
        delete records[key];
      }
    }
    const pending = transactions(records);
    if (Object.keys(pending).length >= MAX_TRANSACTIONS) {
      throw Error('too many pending blank-helper transactions');
    }
    const id = transactionId();
    if (typeof id !== 'string' || !id || pending[id]) {
      throw Error('blank-helper transaction id is invalid');
    }
    pending[id] = {
      createdAt: now(),
      expiresAt: now() + registry.ttl,
      helperIds: [],
      originals: [],
      state: 'pending'
    };
    return id;
  });

  // This write must finish before any keeper/helper activation. A terminated
  // service worker can therefore recover the exact tab that owned focus.
  const recordOriginal = (id, tab) => mutate(records => {
    const transaction = transactionFor(records, id);
    if (!transaction || transaction.state !== 'pending') {
      throw Error('blank-helper transaction is not pending');
    }
    if (!Number.isInteger(tab?.id) || !Number.isInteger(tab?.windowId)) {
      throw Error('original active tab is invalid');
    }
    const original = {tabId: tab.id, windowId: tab.windowId};
    const existing = (transaction.originals || [])
      .filter(candidate => candidate.windowId !== tab.windowId);
    transaction.originals = [...existing, original].slice(-MAX_WINDOWS);
    transaction.expiresAt = now() + registry.ttl;
    return original;
  });
  const forgetOriginal = (id, windowId) => mutate(records => {
    const transaction = transactionFor(records, id);
    if (!transaction) {
      return false;
    }
    transaction.originals = (transaction.originals || [])
      .filter(original => original.windowId !== windowId);
    return true;
  });

  const add = (tab, details = {}) => mutate(records => {
    if (!Number.isInteger(tab?.id)) {
      throw Error('helper tab was not created');
    }
    if (helperEntries(records).length >= MAX_HELPERS) {
      throw Error('too many registered blank-helper tabs');
    }
    let transaction;
    if (details.transactionId) {
      transaction = transactionFor(records, details.transactionId);
      if (!transaction || transaction.state !== 'pending') {
        throw Error('blank-helper transaction is not pending');
      }
    }
    records[tab.id] = {
      createdAt: now(),
      expiresAt: now() + (details.ttl || registry.ttl),
      openerTabId: details.openerTabId,
      state: 'pending',
      transactionId: details.transactionId,
      windowId: tab.windowId
    };
    if (transaction && transaction.helperIds.includes(tab.id) === false) {
      transaction.helperIds = [...transaction.helperIds, tab.id].slice(-MAX_HELPERS);
    }
    return records[tab.id];
  });
  const forget = id => mutate(records => {
    delete records[id];
    for (const transaction of Object.values(transactions(records))) {
      transaction.helperIds = (transaction.helperIds || []).filter(candidate => candidate !== id);
    }
    return true;
  });
  const close = async id => {
    try {
      await removeTab(id);
    }
    catch (error) {
      if (!/no tab|not found|invalid tab/i.test(error.message)) {
        throw error;
      }
    }
    await forget(id);
    return true;
  };
  const commit = id => mutate(records => {
    const record = records[id];
    if (!record) {
      return false;
    }
    records[id] = {
      ...record,
      expiresAt: now() + registry.ttl,
      state: 'committed',
      transactionId: undefined
    };
    return true;
  });
  const helperIds = async () => new Set(helperEntries(await read()).map(([id]) => Number(id)));
  const has = async id => (await helperIds()).has(id);

  const restoreOriginal = async original => {
    const tab = await getTab(original.tabId).catch(() => undefined);
    if (!tab || tab.windowId !== original.windowId || tab.discarded === true || tab.frozen === true) {
      return false;
    }
    await activateTab(tab.id);
    return true;
  };

  const settle = async (id, {
    keepHelperIds = [],
    keepWindowIds = []
  } = {}) => {
    await tail;
    const records = await read();
    const transaction = records[TRANSACTIONS_KEY]?.[id];
    if (!transaction) {
      return false;
    }
    const keepHelpers = new Set(keepHelperIds);
    const keepWindows = new Set(keepWindowIds);
    const linked = new Set([
      ...(transaction.helperIds || []),
      ...helperEntries(records)
        .filter(([, record]) => record.transactionId === id)
        .map(([key]) => Number(key))
    ]);
    const closeResults = await Promise.allSettled(
      [...linked].filter(helperId => !keepHelpers.has(helperId)).map(close)
    );
    const restoreResults = await Promise.allSettled(
      (transaction.originals || [])
        .filter(original => !keepWindows.has(original.windowId))
        .map(restoreOriginal)
    );
    const failures = [...closeResults, ...restoreResults]
      .filter(result => result.status === 'rejected')
      .map(result => result.reason);
    if (failures.length) {
      // Leave the transaction pending so the next worker start can retry the
      // idempotent cleanup instead of losing recovery state.
      throw new AggregateError(failures, 'blank-helper transaction cleanup failed');
    }
    await mutate(current => {
      const pending = current[TRANSACTIONS_KEY]?.[id];
      if (!pending) {
        return false;
      }
      for (const helperId of keepHelpers) {
        if (current[helperId]) {
          current[helperId] = {
            ...current[helperId],
            expiresAt: now() + registry.ttl,
            state: 'committed',
            transactionId: undefined
          };
        }
      }
      delete current[TRANSACTIONS_KEY][id];
      return true;
    });
    return true;
  };
  const rollback = id => settle(id);
  const commitTransaction = (id, options) => settle(id, options);

  const cleanup = async () => {
    await tail;
    const initial = await read();
    // Every transaction found during module startup belongs to an interrupted
    // command. New writers are capped, keeping this recovery pass bounded.
    const pendingIds = Object.keys(initial[TRANSACTIONS_KEY] || {}).slice(0, MAX_TRANSACTIONS);
    const removed = [];
    for (const id of pendingIds) {
      const transaction = (await read())[TRANSACTIONS_KEY]?.[id];
      if (transaction) {
        removed.push(...(transaction.helperIds || []));
        await rollback(id);
      }
    }

    const records = await read();
    for (const [key, record] of helperEntries(records).slice(0, MAX_HELPERS)) {
      const id = Number(key);
      const helper = await getTab(id).catch(() => undefined);
      const opener = Number.isInteger(record.openerTabId) ?
        await getTab(record.openerTabId).catch(() => undefined) : undefined;
      const interrupted = record.state === 'pending';
      // A committed helper is the intentional active survivor of a successful
      // discard. Its page closes itself when hidden; a transaction TTL must not
      // wake its discarded opener merely because the worker restarted later.
      const expiredPending = record.state !== 'committed' && record.expiresAt <= now();
      const orphaned = interrupted || expiredPending || !helper || !opener;
      if (orphaned) {
        await close(id);
        if (!removed.includes(id)) {
          removed.push(id);
        }
      }
    }
    return removed;
  };

  const registry = {
    add,
    begin,
    cleanup,
    close,
    commit,
    commitTransaction,
    forget,
    forgetOriginal,
    has,
    helperIds,
    recordOriginal,
    rollback,
    ttl: 30_000
  };
  return registry;
};

const callTab = (method, ...args) => new Promise((resolve, reject) => {
  let settled = false;
  const done = value => {
    if (settled) {
      return;
    }
    settled = true;
    const error = chrome.runtime.lastError;
    error ? reject(Error(error.message || error)) : resolve(value);
  };
  try {
    const operation = chrome.tabs[method](...args, done);
    if (operation?.then) {
      operation.then(done, reject);
    }
  }
  catch (error) {
    reject(error);
  }
});

const helperRegistry = createHelperRegistry({
  activateTab: async id => {
    const {ownership} = await import('./ownership.mjs');
    return ownership.withNativeMutationGuard(() =>
      callTab('update', id, {active: true}),
    id);
  },
  getTab: id => callTab('get', id),
  removeTab: id => callTab('remove', id)
});

export {
  createHelperRegistry,
  helperRegistry,
  MAX_HELPERS,
  MAX_TRANSACTIONS,
  MAX_WINDOWS,
  STORAGE_KEY,
  TRANSACTIONS_KEY
};
