const STORAGE_KEY = '__discardOwnership';

const attempts = new Map();
const takeoverAttempts = new Map();
const observedDiscards = new Map();
const generations = new Map();
let sequence = 0;
let cached;
let loading;
let writes = Promise.resolve();
let bound = false;

const storageArea = () => chrome.storage.session || chrome.storage.local;
const ownedMarker = (source, attemptId = null) => ({
  state: 'owned',
  source,
  attemptId,
  updatedAt: Date.now()
});

const read = () => new Promise((resolve, reject) => storageArea().get({
  [STORAGE_KEY]: {}
}, result => {
  const error = chrome.runtime.lastError;
  if (error) {
    reject(Error(error.message || error));
  }
  else {
    const value = result && result[STORAGE_KEY];
    resolve(value && typeof value === 'object' && Array.isArray(value) === false ? value : {});
  }
}));
const persist = state => new Promise((resolve, reject) => {
  const area = storageArea();
  const callback = () => {
    const error = chrome.runtime.lastError;
    if (error) {
      reject(Error(error.message || error));
    }
    else {
      resolve();
    }
  };

  if (Object.keys(state).length) {
    area.set({[STORAGE_KEY]: state}, callback);
  }
  else {
    area.remove(STORAGE_KEY, callback);
  }
});
const load = () => {
  if (cached) {
    return Promise.resolve(cached);
  }
  if (!loading) {
    loading = read().then(state => cached = state).finally(() => loading = undefined);
  }
  return loading;
};

// All ownership mutations share one recoverable tail so concurrent tab events
// cannot overwrite one another's read-modify-write storage operations.
const mutate = task => {
  const operation = writes.then(async () => {
    const state = {...await load()};
    const result = await task(state);
    await persist(state);
    cached = state;
    return result;
  });
  writes = operation.then(() => undefined, () => undefined);
  return operation;
};

const queryTabs = options => new Promise((resolve, reject) => chrome.tabs.query(options, tabs => {
  const error = chrome.runtime.lastError;
  if (error) {
    reject(Error(error.message || error));
  }
  else {
    resolve(tabs || []);
  }
}));
const getTab = id => new Promise(resolve => chrome.tabs.get(id, tab => {
  const error = chrome.runtime.lastError;
  resolve(error ? undefined : tab);
}));

const begin = async (tab, mode = 'discard') => {
  const id = tab && tab.id;
  if (!Number.isInteger(id) || attempts.has(id)) {
    return null;
  }

  const attemptId = `${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
  observedDiscards.delete(id);
  attempts.set(id, attemptId);
  if (mode === 'takeover') {
    takeoverAttempts.set(id, attemptId);
  }

  try {
    const active = await mutate(state => {
      if (attempts.get(id) !== attemptId) {
        return false;
      }
      state[id] = {
        state: mode === 'takeover' ? 'takeover-waking' : 'pending',
        attemptId,
        updatedAt: Date.now()
      };
      return true;
    });

    if (!active || attempts.get(id) !== attemptId) {
      if (attempts.get(id) === attemptId) {
        attempts.delete(id);
      }
      if (takeoverAttempts.get(id) === attemptId) {
        takeoverAttempts.delete(id);
      }
      return null;
    }
    return attemptId;
  }
  catch (e) {
    if (mode === 'takeover') {
      if (attempts.get(id) === attemptId) {
        attempts.delete(id);
      }
      if (takeoverAttempts.get(id) === attemptId) {
        takeoverAttempts.delete(id);
      }
      throw e;
    }
    // Ownership persistence is best-effort. Keep the live attempt token so a
    // temporary storage failure never disables the extension's core action.
    return attempts.get(id) === attemptId ? attemptId : null;
  }
};

const beginTakeover = tab => begin(tab, 'takeover');

const finish = async (tab, attemptId, source, {allowClaimed = true} = {}) => {
  const id = tab && tab.id;
  if (!Number.isInteger(id) || attempts.get(id) !== attemptId) {
    return false;
  }
  let lastError;
  let failures = 0;
  let latePasses = 0;

  // A single retry covers transient storage failures without returning success
  // while the persisted marker is still pending.
  while (failures < 2) {
    try {
      const result = await mutate(state => {
        if (attempts.get(id) !== attemptId) {
          return false;
        }
        const observed = observedDiscards.get(id);
        const finalSource = source || (allowClaimed && observed && observed.discarded === true ? 'claimed' : undefined);
        const finalTab = finalSource === 'claimed' && observed ? observed : tab;
        if (finalSource && finalTab.discarded) {
          state[id] = ownedMarker(finalSource, attemptId);
          return true;
        }

        delete state[id];
        return false;
      });

      // An event can arrive while persist() is in flight, after the task above
      // inspected the Map. Run one more serialized pass before clearing it.
      if (allowClaimed && !source && result === false && observedDiscards.get(id)?.discarded === true &&
          attempts.get(id) === attemptId && latePasses < 1) {
        latePasses += 1;
        continue;
      }
      if (attempts.get(id) === attemptId) {
        attempts.delete(id);
      }
      if (takeoverAttempts.get(id) === attemptId) {
        takeoverAttempts.delete(id);
      }
      observedDiscards.delete(id);
      return result;
    }
    catch (e) {
      lastError = e;
      failures += 1;
    }
  }

  // Never leave a failed nonce blocking every later discard. Reconciliation is
  // queued separately so a recovered storage API can clean or claim the record.
  if (attempts.get(id) === attemptId) {
    attempts.delete(id);
  }
  if (takeoverAttempts.get(id) === attemptId) {
    takeoverAttempts.delete(id);
  }
  observedDiscards.delete(id);
  start().catch(report);
  throw lastError;
};

const invalidate = id => {
  generations.set(id, (generations.get(id) || 0) + 1);
  attempts.delete(id);
  takeoverAttempts.delete(id);
  observedDiscards.delete(id);
  return mutate(state => {
    const existed = id in state;
    delete state[id];
    return existed;
  });
};

const deferTakeover = id => mutate(state => {
  if (!Number.isInteger(id)) {
    return false;
  }
  state[id] = {
    state: 'owned',
    source: 'contended',
    updatedAt: Date.now()
  };
  return state[id];
});

const claimAtGeneration = (tab, generation) => {
  const id = tab && tab.id;
  if (!Number.isInteger(id) || tab.discarded !== true) {
    return Promise.resolve(false);
  }
  if ((generations.get(id) || 0) !== generation) {
    return Promise.resolve(false);
  }
  if (attempts.has(id)) {
    observedDiscards.set(id, tab);
    return Promise.resolve(false);
  }

  return mutate(state => {
    if ((generations.get(id) || 0) !== generation) {
      return false;
    }
    // A discard attempt may have started while this claim waited its turn.
    if (attempts.has(id)) {
      observedDiscards.set(id, tab);
      return false;
    }
    const marker = state[id];
    if (marker && marker.state === 'owned') {
      state[id] = {
        ...marker,
        updatedAt: Date.now()
      };
      return state[id];
    }

    state[id] = ownedMarker('claimed');
    return state[id];
  });
};

const claim = tab => claimAtGeneration(tab, generations.get(tab && tab.id) || 0);

// Resolve a tabs.query snapshot against the live tab. If a discarded snapshot
// woke in the meantime, callers receive the loaded tab so it can re-enter the
// discard pipeline instead of being silently skipped.
const resolveFresh = async tab => {
  const id = tab && tab.id;
  if (!Number.isInteger(id)) {
    return {state: 'missing'};
  }
  let lastError;

  for (let pass = 0; pass < 3; pass += 1) {
    const generation = generations.get(id) || 0;
    const current = await getTab(id);
    if (!current) {
      return {state: 'missing'};
    }
    if ((generations.get(id) || 0) !== generation) {
      continue;
    }
    if (current.discarded !== true) {
      return {state: 'loaded', tab: current};
    }

    try {
      const marker = await claimAtGeneration(current, generation);
      if ((generations.get(id) || 0) !== generation) {
        continue;
      }
      return {marker, state: 'discarded', tab: current};
    }
    catch (error) {
      lastError = error;
      // Retry against a new live read. The serialized write tail is recoverable,
      // so a transient storage error does not permanently lose the ownership tag.
      continue;
    }
  }

  // Continuous lifecycle churn is rare; make one final live classification
  // without applying a potentially stale ownership mutation.
  const current = await getTab(id);
  if (!current) {
    return {state: 'missing', unstable: true};
  }
  return {
    error: lastError,
    state: current.discarded === true ? 'discarded' : 'loaded',
    tab: current,
    unstable: true
  };
};

// Lifecycle listeners only need to know whether a current discarded tab was
// claimed. Popup commands use resolveFresh() for the full live classification.
const claimFresh = async tab => (await resolveFresh(tab)).marker || false;

const preserveTakeover = id => {
  const attemptId = takeoverAttempts.get(id);
  if (!attemptId || attempts.get(id) !== attemptId) {
    return Promise.resolve(false);
  }
  return mutate(state => {
    const marker = state[id];
    if (attempts.get(id) !== attemptId || takeoverAttempts.get(id) !== attemptId ||
        marker?.attemptId !== attemptId) {
      return false;
    }
    state[id] = {
      ...marker,
      state: 'takeover-awake',
      updatedAt: Date.now()
    };
    return true;
  });
};

const observe = async (id, changeInfo, tab) => {
  if (changeInfo.discarded === false) {
    if (takeoverAttempts.has(id)) {
      return preserveTakeover(id);
    }
    return invalidate(id);
  }
  if ('url' in changeInfo) {
    if (tab.discarded === true) {
      return claim(tab);
    }
    if (takeoverAttempts.has(id)) {
      return preserveTakeover(id);
    }
    return invalidate(id);
  }
  if (changeInfo.discarded === true) {
    return claim(tab);
  }
  return false;
};

const reconcile = () => mutate(async state => {
  const tabs = await queryTabs({});
  const live = new Map(tabs.filter(tab => Number.isInteger(tab.id)).map(tab => [tab.id, tab]));

  for (const key of Object.keys(state)) {
    const id = Number(key);
    const tab = live.get(id);
    const marker = state[key];
    const pendingHere = marker && attempts.get(id) === marker.attemptId;
    const takeoverMarker = typeof marker?.state === 'string' && marker.state.startsWith('takeover-');

    if (!marker || typeof marker !== 'object' || !tab) {
      attempts.delete(id);
      takeoverAttempts.delete(id);
      delete state[key];
    }
    else if (tab.discarded === true) {
      if ((marker.state === 'pending' || takeoverMarker) && !pendingHere) {
        state[key] = ownedMarker('claimed', marker.attemptId);
      }
      else if (marker.state === 'owned') {
        state[key] = marker;
      }
    }
    else if (takeoverMarker && pendingHere) {
      state[key] = marker;
    }
    else if (takeoverMarker && tab.active !== true) {
      state[key] = {
        ...marker,
        state: 'takeover-recovery',
        updatedAt: Date.now()
      };
    }
    else if (!(marker.state === 'pending' && pendingHere)) {
      delete state[key];
    }
  }

  for (const tab of tabs) {
    if (tab.discarded !== true || attempts.has(tab.id)) {
      continue;
    }
    const marker = state[tab.id];
    if (!marker || marker.state !== 'owned') {
      state[tab.id] = ownedMarker('claimed');
    }
  }

  return Object.values(state).filter(marker => marker.state === 'owned').length;
});

const start = async (retries = 2, delay = 250) => {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await reconcile();
    }
    catch (e) {
      lastError = e;
      report(e);
      if (attempt + 1 < retries && delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  return false;
};

const snapshot = async () => {
  await writes;
  return JSON.parse(JSON.stringify(await load()));
};

const status = async id => {
  await writes;
  const state = await load();
  const marker = state[id];
  return {
    attemptId: attempts.get(id),
    marker: marker ? JSON.parse(JSON.stringify(marker)) : undefined,
    takeover: takeoverAttempts.has(id)
  };
};

const isCurrent = (id, attemptId) => attempts.get(id) === attemptId;

const report = error => console.warn('discard ownership update failed', error);
const bind = () => {
  if (bound) {
    return;
  }
  bound = true;

  chrome.tabs.onUpdated?.addListener((id, changeInfo, tab) => {
    observe(id, changeInfo, tab).catch(report);
  });
  chrome.tabs.onCreated?.addListener(tab => {
    if (tab.discarded === true) {
      claim(tab).catch(report);
    }
  });
  chrome.tabs.onAttached?.addListener(id => {
    if (attempts.has(id)) {
      return;
    }
    // Clear any marker tied to the pre-attachment snapshot, then re-read and
    // reclaim only if the moved tab is still discarded.
    invalidate(id).then(() => claimFresh({id})).catch(report);
  });
  chrome.tabs.onRemoved?.addListener(id => {
    invalidate(id).catch(report);
  });
  chrome.tabs.onReplaced?.addListener((addedId, removedId) => {
    attempts.delete(addedId);
    Promise.all([
      invalidate(removedId),
      invalidate(addedId)
    ]).then(() => claimFresh({id: addedId})).catch(report);
  });
};

bind();

const ownership = {
  begin,
  beginTakeover,
  bind,
  claim,
  claimFresh,
  deferTakeover,
  finish,
  invalidate,
  isCurrent,
  observe,
  reconcile,
  resolveFresh,
  start,
  status,
  snapshot
};

export {ownership, STORAGE_KEY};
