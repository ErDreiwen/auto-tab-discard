const STORAGE_KEY = '__discardOwnership';

const attempts = new Map();
const observedDiscards = new Map();
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

const begin = async tab => {
  const id = tab && tab.id;
  if (!Number.isInteger(id) || attempts.has(id)) {
    return null;
  }

  const attemptId = `${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
  observedDiscards.delete(id);
  attempts.set(id, attemptId);

  try {
    const active = await mutate(state => {
      if (attempts.get(id) !== attemptId) {
        return false;
      }
      state[id] = {
        state: 'pending',
        attemptId,
        updatedAt: Date.now()
      };
      return true;
    });

    if (!active || attempts.get(id) !== attemptId) {
      if (attempts.get(id) === attemptId) {
        attempts.delete(id);
      }
      return null;
    }
    return attemptId;
  }
  catch (e) {
    // Ownership persistence is best-effort. Keep the live attempt token so a
    // temporary storage failure never disables the extension's core action.
    return attempts.get(id) === attemptId ? attemptId : null;
  }
};

const finish = async (tab, attemptId, source) => {
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
        const finalSource = source || (observed && observed.discarded === true ? 'claimed' : undefined);
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
      if (!source && result === false && observedDiscards.get(id)?.discarded === true &&
          attempts.get(id) === attemptId && latePasses < 1) {
        latePasses += 1;
        continue;
      }
      if (attempts.get(id) === attemptId) {
        attempts.delete(id);
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
  observedDiscards.delete(id);
  start().catch(report);
  throw lastError;
};

const invalidate = id => {
  attempts.delete(id);
  observedDiscards.delete(id);
  return mutate(state => {
    const existed = id in state;
    delete state[id];
    return existed;
  });
};

const claim = tab => {
  const id = tab && tab.id;
  if (!Number.isInteger(id) || tab.discarded !== true) {
    return Promise.resolve(false);
  }
  if (attempts.has(id)) {
    observedDiscards.set(id, tab);
    return Promise.resolve(false);
  }

  return mutate(state => {
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

const observe = async (id, changeInfo, tab) => {
  if (changeInfo.discarded === false) {
    return invalidate(id);
  }
  if ('url' in changeInfo) {
    if (tab.discarded === true) {
      return claim(tab);
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

    if (!marker || typeof marker !== 'object' || !tab) {
      attempts.delete(id);
      delete state[key];
    }
    else if (tab.discarded === true) {
      if (marker.state === 'pending' && !pendingHere) {
        state[key] = ownedMarker('claimed', marker.attemptId);
      }
      else if (marker.state === 'owned') {
        state[key] = marker;
      }
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
    getTab(id).then(tab => {
      if (tab && tab.discarded === true) {
        return claim(tab);
      }
      return invalidate(id);
    }).catch(report);
  });
  chrome.tabs.onRemoved?.addListener(id => {
    invalidate(id).catch(report);
  });
  chrome.tabs.onReplaced?.addListener((addedId, removedId) => {
    attempts.delete(addedId);
    Promise.all([
      invalidate(removedId),
      invalidate(addedId)
    ]).then(() => getTab(addedId)).then(tab => {
      if (tab && tab.discarded === true) {
        return claim(tab);
      }
    }).catch(report);
  });
};

bind();

const ownership = {
  begin,
  bind,
  claim,
  finish,
  invalidate,
  observe,
  reconcile,
  start,
  snapshot
};

export {ownership, STORAGE_KEY};
