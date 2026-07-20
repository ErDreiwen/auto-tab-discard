const STORAGE_KEY = '__discardOwnership';

const attempts = new Map();
const takeoverAttempts = new Map();
const observedDiscards = new Map();
const generations = new Map();
// Edge can replace a tab id as part of tabs.discard(). Treat the replacement
// as the same logical tab so the nonce written before the native call remains
// authoritative when its callback and lifecycle events arrive on different ids.
const replacements = new Map();
let sequence = 0;
let cached;
let loading;
let writes = Promise.resolve();
let bound = false;

const storageArea = () => chrome.storage.session || chrome.storage.local;
const resolveId = id => {
  if (!Number.isInteger(id)) {
    return id;
  }
  const path = [];
  const seen = new Set();
  let current = id;
  while (Number.isInteger(replacements.get(current)) && !seen.has(current)) {
    seen.add(current);
    path.push(current);
    current = replacements.get(current);
  }
  for (const entry of path) {
    replacements.set(entry, current);
  }
  return current;
};
const currentTab = tab => {
  const id = resolveId(tab && tab.id);
  return Number.isInteger(id) && tab ? (id === tab.id ? tab : {...tab, id}) : tab;
};
const attemptTabId = (id, attemptId) => {
  const currentId = resolveId(id);
  if (attempts.get(currentId) === attemptId) {
    return currentId;
  }
  for (const [candidate, candidateAttempt] of attempts) {
    if (candidateAttempt === attemptId) {
      return candidate;
    }
  }
  return currentId;
};
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
const getTab = id => new Promise(resolve => chrome.tabs.get(resolveId(id), tab => {
  const error = chrome.runtime.lastError;
  resolve(error ? undefined : tab);
}));

const begin = async (tab, mode = 'discard') => {
  const id = resolveId(tab && tab.id);
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
      const currentId = resolveId(id);
      if (attempts.get(currentId) !== attemptId) {
        return false;
      }
      state[currentId] = {
        state: mode === 'takeover' ? 'takeover-waking' : 'pending',
        attemptId,
        updatedAt: Date.now()
      };
      return true;
    });

    const currentId = resolveId(id);
    if (!active || attempts.get(currentId) !== attemptId) {
      if (attempts.get(currentId) === attemptId) {
        attempts.delete(currentId);
      }
      if (takeoverAttempts.get(currentId) === attemptId) {
        takeoverAttempts.delete(currentId);
      }
      return null;
    }
    return attemptId;
  }
  catch (e) {
    if (mode === 'takeover') {
      const currentId = resolveId(id);
      if (attempts.get(currentId) === attemptId) {
        attempts.delete(currentId);
      }
      if (takeoverAttempts.get(currentId) === attemptId) {
        takeoverAttempts.delete(currentId);
      }
      throw e;
    }
    // Ownership persistence is best-effort. Keep the live attempt token so a
    // temporary storage failure never disables the extension's core action.
    return attempts.get(resolveId(id)) === attemptId ? attemptId : null;
  }
};

const beginTakeover = tab => begin(tab, 'takeover');

const finish = async (tab, attemptId, source, {allowClaimed = true} = {}) => {
  const id = tab && tab.id;
  const initialId = attemptTabId(id, attemptId);
  if (!Number.isInteger(initialId) || attempts.get(initialId) !== attemptId) {
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
        const currentId = attemptTabId(id, attemptId);
        if (attempts.get(currentId) !== attemptId) {
          return false;
        }
        const observed = observedDiscards.get(currentId);
        const finalSource = source || (allowClaimed && observed && observed.discarded === true ? 'claimed' : undefined);
        const finalTab = currentTab(finalSource === 'claimed' && observed ? observed : tab);
        if (finalSource && finalTab.discarded) {
          state[currentId] = ownedMarker(finalSource, attemptId);
          if (currentId !== id) {
            delete state[id];
          }
          return true;
        }

        delete state[currentId];
        if (currentId !== id) {
          delete state[id];
        }
        return false;
      });

      // An event can arrive while persist() is in flight, after the task above
      // inspected the Map. Run one more serialized pass before clearing it.
      const currentId = attemptTabId(id, attemptId);
      if (allowClaimed && !source && result === false && observedDiscards.get(currentId)?.discarded === true &&
          attempts.get(currentId) === attemptId && latePasses < 1) {
        latePasses += 1;
        continue;
      }
      if (attempts.get(currentId) === attemptId) {
        attempts.delete(currentId);
      }
      if (takeoverAttempts.get(currentId) === attemptId) {
        takeoverAttempts.delete(currentId);
      }
      observedDiscards.delete(currentId);
      return result;
    }
    catch (e) {
      lastError = e;
      failures += 1;
    }
  }

  // Never leave a failed nonce blocking every later discard. Reconciliation is
  // queued separately so a recovered storage API can clean or claim the record.
  const currentId = attemptTabId(id, attemptId);
  if (attempts.get(currentId) === attemptId) {
    attempts.delete(currentId);
  }
  if (takeoverAttempts.get(currentId) === attemptId) {
    takeoverAttempts.delete(currentId);
  }
  observedDiscards.delete(currentId);
  start().catch(report);
  throw lastError;
};

// Revalidate a freshly completed self-discard after its attempt token has been
// cleared. Ownership events are serialized through the same queue, so a wake
// racing finalization either fails this live check or is queued to invalidate
// the marker immediately afterward. The attempt id prevents deleting a newer
// owner's marker.
const confirmSelf = (id, attemptId) => mutate(async state => {
  let currentId = resolveId(id);
  let marker = state[currentId];
  if (marker?.attemptId !== attemptId) {
    const entry = Object.entries(state).find(([, candidate]) => {
      return candidate?.state === 'owned' && candidate.source === 'self' && candidate.attemptId === attemptId;
    });
    if (entry) {
      currentId = Number(entry[0]);
      marker = entry[1];
    }
  }
  if (marker?.state !== 'owned' || marker.source !== 'self' || marker.attemptId !== attemptId) {
    return false;
  }
  const requestedId = resolveId(id);
  const current = await getTab(requestedId) ||
    (requestedId === currentId ? undefined : await getTab(currentId));
  if (current?.discarded === true && current.active !== true && current.status === 'unloaded') {
    return true;
  }
  if (state[currentId]?.attemptId === attemptId) {
    delete state[currentId];
  }
  return false;
});

const invalidate = id => {
  const currentId = resolveId(id);
  generations.set(currentId, (generations.get(currentId) || 0) + 1);
  attempts.delete(currentId);
  takeoverAttempts.delete(currentId);
  observedDiscards.delete(currentId);
  return mutate(state => {
    const resolvedId = resolveId(id);
    const existed = resolvedId in state || id in state;
    delete state[resolvedId];
    if (resolvedId !== id) {
      delete state[id];
    }
    return existed;
  });
};

const deferTakeover = id => mutate(state => {
  const currentId = resolveId(id);
  if (!Number.isInteger(currentId)) {
    return false;
  }
  state[currentId] = {
    state: 'owned',
    source: 'contended',
    updatedAt: Date.now()
  };
  return state[currentId];
});

// Chromium has no native discard-owner field. Adopt an already-discarded tab
// into this extension's ownership model without waking or reloading its page.
const adopt = async tab => {
  const originId = tab && tab.id;
  let id = resolveId(originId);
  if (!Number.isInteger(id)) {
    return false;
  }
  if (attempts.has(id)) {
    return {busy: true};
  }
  const generation = generations.get(id) || 0;
  const current = await getTab(id);
  id = resolveId(originId);
  if (attempts.has(id)) {
    return {busy: true};
  }
  if (!current) {
    return {state: 'missing'};
  }
  if (current.discarded !== true) {
    return {state: 'loaded', tab: current};
  }
  if ((generations.get(id) || 0) !== generation) {
    return {retry: true};
  }

  const adoptionId = `adopt-${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
  const result = await mutate(state => {
    const currentId = resolveId(originId);
    if (attempts.has(currentId)) {
      return {busy: true};
    }
    if ((generations.get(currentId) || 0) !== generation) {
      return {retry: true};
    }
    const existing = state[currentId];
    if (existing?.state === 'owned' && (existing.source === 'self' || existing.source === 'adopted')) {
      return {marker: existing};
    }
    state[currentId] = ownedMarker('adopted', adoptionId);
    return {marker: state[currentId]};
  });
  if (result.busy || result.retry) {
    return result;
  }

  const final = await getTab(originId);
  id = resolveId(originId);
  if (final?.discarded === true && (generations.get(id) || 0) === generation && !attempts.has(id)) {
    return true;
  }
  if (result.marker?.source === 'adopted') {
    const expected = result.marker;
    await mutate(state => {
      const currentId = resolveId(originId);
      const marker = state[currentId];
      if (marker?.state === expected.state && marker.source === expected.source &&
          marker.attemptId === expected.attemptId && marker.updatedAt === expected.updatedAt) {
        delete state[currentId];
        return true;
      }
      return false;
    });
  }
  if (attempts.has(id)) {
    return {busy: true};
  }
  if (!final) {
    return {state: 'missing'};
  }
  return final.discarded === false ? {state: 'loaded', tab: final} : {retry: true};
};

// Moving a tab between windows preserves its id, but Chromium can report the
// attachment while another ownership transition is starting. Fence stale
// pre-attachment reads immediately, then hold the serialized ownership queue
// across the live tab read. Any newer attempt or lifecycle event wins without
// this handler cancelling it or deleting its marker.
const revalidateAttached = id => {
  id = resolveId(id);
  if (!Number.isInteger(id)) {
    return Promise.resolve(false);
  }

  const generation = (generations.get(id) || 0) + 1;
  generations.set(id, generation);

  return mutate(async state => {
    const current = await getTab(id);
    if ((generations.get(id) || 0) !== generation || attempts.has(id)) {
      return false;
    }

    observedDiscards.delete(id);
    takeoverAttempts.delete(id);
    if (!current || current.discarded !== true) {
      delete state[id];
      return false;
    }

    const marker = state[id];
    if (marker?.state === 'owned') {
      return marker;
    }
    state[id] = ownedMarker('claimed');
    return state[id];
  });
};

const claimAtGeneration = (tab, generation) => {
  tab = currentTab(tab);
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
    const currentId = resolveId(id);
    const normalized = currentTab(tab);
    if ((generations.get(currentId) || 0) !== generation) {
      return false;
    }
    // A discard attempt may have started while this claim waited its turn.
    if (attempts.has(currentId)) {
      observedDiscards.set(currentId, normalized);
      return false;
    }
    const marker = state[currentId];
    if (marker && marker.state === 'owned') {
      state[currentId] = {
        ...marker,
        updatedAt: Date.now()
      };
      return state[currentId];
    }

    state[currentId] = ownedMarker('claimed');
    return state[currentId];
  });
};

const claim = tab => {
  tab = currentTab(tab);
  return claimAtGeneration(tab, generations.get(tab && tab.id) || 0);
};

// Resolve a tabs.query snapshot against the live tab. If a discarded snapshot
// woke in the meantime, callers receive the loaded tab so it can re-enter the
// discard pipeline instead of being silently skipped.
const resolveFresh = async tab => {
  const originId = tab && tab.id;
  if (!Number.isInteger(resolveId(originId))) {
    return {state: 'missing'};
  }
  let lastError;

  for (let pass = 0; pass < 3; pass += 1) {
    const id = resolveId(originId);
    const generation = generations.get(id) || 0;
    const current = await getTab(id);
    if (!current) {
      return {state: 'missing'};
    }
    if (resolveId(originId) !== current.id || (generations.get(resolveId(originId)) || 0) !== generation) {
      continue;
    }
    if (current.discarded !== true) {
      return {state: 'loaded', tab: current};
    }

    try {
      const marker = await claimAtGeneration(current, generation);
      if ((generations.get(resolveId(originId)) || 0) !== generation) {
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
  const current = await getTab(originId);
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
  id = resolveId(id);
  const attemptId = takeoverAttempts.get(id);
  if (!attemptId || attempts.get(id) !== attemptId) {
    return Promise.resolve(false);
  }
  return mutate(state => {
    const currentId = resolveId(id);
    const marker = state[currentId];
    if (attempts.get(currentId) !== attemptId || takeoverAttempts.get(currentId) !== attemptId ||
        marker?.attemptId !== attemptId) {
      return false;
    }
    state[currentId] = {
      ...marker,
      state: 'takeover-awake',
      updatedAt: Date.now()
    };
    return true;
  });
};

const observe = async (id, changeInfo, tab) => {
  id = resolveId(id);
  tab = currentTab(tab);
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

const moveEntry = (map, from, to, transform = value => value) => {
  if (!map.has(from)) {
    return;
  }
  const value = map.get(from);
  map.delete(from);
  map.set(to, transform(value));
};

// Preserve the logical ownership transaction across browsers that implement a
// native discard by replacing the tab object. The in-memory move is immediate,
// before the discard callback can run; the persisted marker follows through the
// same serialized write tail as every other lifecycle mutation.
const replace = (addedId, removedId) => {
  if (!Number.isInteger(addedId) || !Number.isInteger(removedId)) {
    return Promise.resolve(false);
  }
  const from = resolveId(removedId);
  const to = resolveId(addedId);
  if (from === to) {
    return Promise.resolve(false);
  }

  replacements.set(removedId, to);
  replacements.set(from, to);
  moveEntry(attempts, from, to);
  moveEntry(takeoverAttempts, from, to);
  moveEntry(observedDiscards, from, to, tab => currentTab({...tab, id: to}));
  const generation = Math.max(generations.get(from) || 0, generations.get(to) || 0);
  generations.set(to, generation);

  return mutate(state => {
    const source = state[from] || state[removedId];
    const destination = state[to];
    const attemptId = attempts.get(to);
    const marker = [source, destination].find(candidate => candidate?.attemptId === attemptId) ||
      source || destination;
    delete state[removedId];
    delete state[from];
    if (marker) {
      state[to] = marker;
    }
    return Boolean(marker);
  }).then(result => {
    const expectedId = resolveId(to);
    const generation = generations.get(expectedId) || 0;

    // Hold the ownership write fence across the live read. A newer attempt,
    // lifecycle generation, or replacement can still start while tabs.get is
    // pending, so recheck all three afterward before applying its stale result.
    return mutate(async state => {
      if (resolveId(to) !== expectedId || (generations.get(expectedId) || 0) !== generation ||
          attempts.has(expectedId)) {
        return result;
      }
      const current = await getTab(expectedId);
      if (!current || current.id !== expectedId || resolveId(to) !== expectedId ||
          (generations.get(expectedId) || 0) !== generation || attempts.has(expectedId)) {
        return result;
      }

      if (current.discarded === true) {
        const marker = state[expectedId];
        if (marker?.state === 'owned') {
          state[expectedId] = {
            ...marker,
            updatedAt: Date.now()
          };
        }
        else {
          state[expectedId] = ownedMarker('claimed');
        }
        return state[expectedId];
      }

      generations.set(expectedId, generation + 1);
      observedDiscards.delete(expectedId);
      takeoverAttempts.delete(expectedId);
      const existed = expectedId in state;
      delete state[expectedId];
      return existed;
    });
  });
};

const forgetReplacementLineage = currentId => {
  for (const id of [...replacements.keys()]) {
    if (resolveId(id) === currentId) {
      replacements.delete(id);
    }
  }
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
  id = resolveId(id);
  const marker = state[id];
  return {
    attemptId: attempts.get(id),
    marker: marker ? JSON.parse(JSON.stringify(marker)) : undefined,
    takeover: takeoverAttempts.has(id)
  };
};

const isCurrent = (id, attemptId) => attempts.get(resolveId(id)) === attemptId;

const report = error => console.warn('discard ownership update failed', error);
const bind = () => {
  if (bound) {
    return;
  }
  bound = true;

  chrome.tabs.onUpdated?.addListener((id, changeInfo, tab) => {
    if (resolveId(id) !== id) {
      return;
    }
    observe(id, changeInfo, tab).catch(report);
  });
  chrome.tabs.onCreated?.addListener(tab => {
    if (tab.discarded === true) {
      claim(tab).catch(report);
    }
  });
  chrome.tabs.onAttached?.addListener(id => {
    if (resolveId(id) !== id) {
      return;
    }
    revalidateAttached(id).catch(report);
  });
  chrome.tabs.onRemoved?.addListener(id => {
    if (resolveId(id) !== id) {
      return;
    }
    invalidate(id).then(() => forgetReplacementLineage(id)).catch(report);
  });
  chrome.tabs.onReplaced?.addListener((addedId, removedId) => {
    replace(addedId, removedId).catch(report);
  });
};

bind();

const ownership = {
  adopt,
  begin,
  beginTakeover,
  bind,
  claim,
  claimFresh,
  confirmSelf,
  deferTakeover,
  finish,
  invalidate,
  isCurrent,
  observe,
  reconcile,
  resolveId,
  resolveFresh,
  start,
  status,
  snapshot
};

export {ownership, STORAGE_KEY};
