import {isNativeDiscardSettled} from './native-discard-state.mjs';
import {
  STORAGE_KEY,
  createOwnershipPersistence
} from './ownership-persistence.mjs';
import {
  pruneReplacementLineage,
  recordReplacement,
  resolveReplacement
} from './replacement-lineage.mjs';

const attempts = new Map();
const attemptOrigins = new Map();
const takeoverAttempts = new Map();
const observedDiscards = new Map();
const generations = new Map();
// Edge can replace a tab id as part of tabs.discard(). Treat the replacement
// as the same logical tab so the nonce written before the native call remains
// authoritative when its callback and lifecycle events arrive on different ids.
const replacements = new Map();
let sequence = 0;
let generationSequence = 0;
let cached;
let loading;
// A storage read is not part of the serialized write tail. Reset therefore
// invalidates its generation immediately so a read that began before the reset
// cannot repopulate the in-memory cache after the persisted record was erased.
let cacheGeneration = 0;
let writes = Promise.resolve();
// Browser mutations that can script, focus, reload, or discard serialize with
// the two operations that may create an unattributed global native fence
// (startup reconciliation and predecessor removal). This closes the
// check-to-effect gap without blocking ordinary ownership writes or real
// onReplaced lineage events needed by an in-flight native operation.
let nativeMutationTail = Promise.resolve();
// Removal notification is synchronous even though its persisted orphan
// conversion is serialized. A guard that already owns the serializer must
// still observe a removal delivered while it awaits storage/reconciliation.
let nativeRemovalGeneration = 0;
const serializeNativeMutation = task => {
  const previous = nativeMutationTail;
  let release;
  nativeMutationTail = new Promise(resolve => { release = resolve; });
  return previous.then(task).finally(release);
};
let reconciledOnce = false;
let bound = false;
// Reset advances this fence before it waits for queued storage work. Any
// ownership operation that began against an older epoch can finish its native
// browser work, but it can no longer recreate a marker after the reset barrier.
let epoch = 0;
let resetting = false;
// A reset leaves lifecycle observation paused. The next explicit ownership
// operation re-enables it after classifying the live tab instead of allowing a
// late event from a cancelled job to repopulate session storage immediately.
let initialized = true;
const persistence = createOwnershipPersistence(chrome);
const resolveId = id => resolveReplacement(replacements, id);
// A unique token avoids the default-zero ABA problem: after a removed tab's
// generation entry is deleted, a late read from that old identity cannot match
// either an absent entry or a newly created tab that reuses the same numeric id.
const generationOf = id => {
  id = resolveId(id);
  if (!Number.isInteger(id)) {
    return undefined;
  }
  if (!generations.has(id)) {
    generations.set(id, ++generationSequence);
  }
  return generations.get(id);
};
const renewGeneration = id => {
  id = resolveId(id);
  if (!Number.isInteger(id)) {
    return undefined;
  }
  const generation = ++generationSequence;
  generations.set(id, generation);
  return generation;
};
const isGeneration = (id, generation) => generations.get(resolveId(id)) === generation;
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
const ownedMarker = (source, attemptId = null, visual = undefined) => ({
  state: 'owned',
  source,
  attemptId,
  ...(source === 'self' && visual && {
    visual: {
      complete: visual.complete === true,
      favicon: visual.favicon === true,
      ...(visual.physicalOnly === true && {physicalOnly: true}),
      repair: visual.repair === true,
      title: visual.title === true,
      ...(typeof visual.titleMarker === 'string' && visual.titleMarker && {
        titleMarker: [...visual.titleMarker].slice(0, 32).join('')
      })
    }
  }),
  updatedAt: Date.now()
});

const LATE_NATIVE_TTL = 60000;
const directNativeMarker = attemptId => ({
  state: 'direct-native-pending',
  attemptId,
  updatedAt: Date.now()
});
// If MV3 stops after the native request was persisted but Edge replaces the
// predecessor while no listener exists, the durable nonce can no longer be
// assigned to any particular live tab. Keep it as a session-only global fence
// under the missing predecessor id. It deliberately contains no browsing or
// topology data and has no wall-clock expiry.
const directNativeOrphanMarker = attemptId => ({
  state: 'direct-native-orphan',
  attemptId,
  updatedAt: Date.now()
});
const isDirectNativeOrphan = marker => marker?.state === 'direct-native-orphan';
const nativeOrphanIn = state => Object.values(state).some(isDirectNativeOrphan);
const lateNativeMarker = (attemptId, visual) => ({
  state: 'late-native',
  source: 'self-pending',
  attemptId,
  expiresAt: Date.now() + LATE_NATIVE_TTL,
  ...(visual && {visual: ownedMarker('self', attemptId, visual).visual}),
  updatedAt: Date.now()
});

const load = () => {
  if (cached) {
    return Promise.resolve(cached);
  }
  if (!loading) {
    const generation = cacheGeneration;
    const operation = persistence.load(() => generation === cacheGeneration && !resetting).then(state => {
      if (generation === cacheGeneration) {
        cached = state;
      }
      return state;
    }).finally(() => {
      // A reset can detach this old read and start a newer one. Never let the
      // older promise's finally handler clear that newer in-flight load.
      if (loading === operation) {
        loading = undefined;
      }
    });
    loading = operation;
  }
  return loading;
};

// Most operations touch one tab. A shallow clone made every such mutation
// O(total markers) even after storage became per-tab. This copy-on-write view
// records only touched keys, but still implements enumeration for the few
// reconciliation paths that deliberately inspect the complete ownership set.
const mutationView = base => {
  const changed = new Set();
  const deleted = new Set();
  const overlay = Object.create(null);
  const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const valueAt = key => deleted.has(key) ? undefined : owns(overlay, key) ? overlay[key] : base[key];
  const has = key => !deleted.has(key) && (owns(overlay, key) || owns(base, key));
  const view = new Proxy({}, {
    deleteProperty(target, key) {
      if (typeof key === 'string') {
        changed.add(key);
        deleted.add(key);
        delete overlay[key];
      }
      return true;
    },
    get(target, key) {
      return typeof key === 'string' ? valueAt(key) : Reflect.get(target, key);
    },
    getOwnPropertyDescriptor(target, key) {
      return typeof key === 'string' && has(key) ? {
        configurable: true,
        enumerable: true,
        value: valueAt(key),
        writable: true
      } : undefined;
    },
    has(target, key) {
      return typeof key === 'string' ? has(key) : Reflect.has(target, key);
    },
    ownKeys() {
      return [...new Set([...Object.keys(base), ...Object.keys(overlay)])].filter(key => !deleted.has(key));
    },
    set(target, key, value) {
      if (typeof key !== 'string') {
        return Reflect.set(target, key, value);
      }
      changed.add(key);
      deleted.delete(key);
      overlay[key] = value;
      return true;
    }
  });
  const commit = () => {
    for (const key of changed) {
      if (deleted.has(key)) {
        delete base[key];
      }
      else {
        base[key] = overlay[key];
      }
    }
    return base;
  };
  return {changed, commit, view};
};

// All ownership mutations share one recoverable tail so concurrent tab events
// cannot overwrite one another's read-modify-write storage operations.
const mutate = (task, operationEpoch = epoch) => {
  if (resetting || operationEpoch !== epoch) {
    return Promise.resolve(false);
  }
  const queuedAt = globalThis.performance?.now?.() ?? Date.now();
  const operation = writes.then(async () => {
    persistence.observeQueueLatency(queuedAt);
    if (resetting || operationEpoch !== epoch) {
      return false;
    }
    const previous = await load();
    const transaction = mutationView(previous);
    const state = transaction.view;
    if (resetting || operationEpoch !== epoch) {
      return false;
    }
    const result = await task(state);
    if (resetting || operationEpoch !== epoch) {
      return false;
    }
    await persistence.persist(previous, state, transaction.changed);
    if (resetting || operationEpoch !== epoch) {
      return false;
    }
    cached = transaction.commit();
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
  if (resetting) {
    return null;
  }
  initialized = true;
  const id = resolveId(tab && tab.id);
  if (!Number.isInteger(id) || attempts.has(id)) {
    return null;
  }

  const attemptId = `${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
  observedDiscards.delete(id);
  attempts.set(id, attemptId);
  attemptOrigins.set(attemptId, id);
  if (mode === 'takeover') {
    takeoverAttempts.set(id, attemptId);
  }

  try {
    const active = await mutate(state => {
      const currentId = resolveId(id);
      if (attempts.get(currentId) !== attemptId) {
        return false;
      }
      // A lost predecessor nonce is a global no-mutation fence. Recheck it in
      // the serialized transaction so a command that raced reconciliation
      // cannot start renderer/native work from an earlier clean read.
      if (tab?.active !== true && (nativeOrphanIn(state) ||
          state[currentId]?.state === 'direct-native-pending' ||
          isDirectNativeOrphan(state[currentId]))) {
        return false;
      }
      state[currentId] = mode === 'direct-native' ? directNativeMarker(attemptId) : {
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
        attemptOrigins.delete(attemptId);
      }
      if (takeoverAttempts.get(currentId) === attemptId) {
        takeoverAttempts.delete(currentId);
      }
      return null;
    }
    return attemptId;
  }
  catch (e) {
    if (mode !== 'discard') {
      const currentId = resolveId(id);
      if (attempts.get(currentId) === attemptId) {
        attempts.delete(currentId);
        attemptOrigins.delete(attemptId);
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
const beginDirectNative = tab => begin(tab, 'direct-native');

const finish = async (
  tab,
  attemptId,
  source,
  {allowClaimed = true, directNative = false, lateNative = false, visual} = {}
) => {
  const operationEpoch = epoch;
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
        if (lateNative) {
          state[currentId] = directNative ? directNativeMarker(attemptId) :
            lateNativeMarker(attemptId, visual);
          if (currentId !== id) {
            delete state[id];
          }
          return false;
        }
        const finalSource = source || (allowClaimed && observed && observed.discarded === true ? 'claimed' : undefined);
        const finalTab = currentTab(finalSource === 'claimed' && observed ? observed : tab);
        if (finalSource && finalTab.discarded) {
          state[currentId] = ownedMarker(finalSource, attemptId, visual);
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
      }, operationEpoch);

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
        attemptOrigins.delete(attemptId);
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
    attemptOrigins.delete(attemptId);
  }
  if (takeoverAttempts.get(currentId) === attemptId) {
    takeoverAttempts.delete(currentId);
  }
  observedDiscards.delete(currentId);
  start(2, 250, operationEpoch).catch(report);
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
  if (isNativeDiscardSettled(current)) {
    return true;
  }
  if (state[currentId]?.attemptId === attemptId) {
    delete state[currentId];
  }
  return false;
});

// Capture the exact reset/cancel/tab-identity authority for a native operation
// that may outlive both of its caller-side timeout fences.  The returned value
// contains no browsing data; it is only meaningful to this worker instance.
const lateAuthority = id => {
  id = resolveId(id);
  return Number.isInteger(id) ? Object.freeze({
    epoch,
    generation: generationOf(id),
    id
  }) : undefined;
};

const promoteLateSelf = (authority, attemptId, visual) => {
  if (!authority || authority.epoch !== epoch || resetting ||
      resolveId(authority.id) !== authority.id ||
      !isGeneration(authority.id, authority.generation)) {
    return Promise.resolve(false);
  }
  return mutate(async state => {
    const id = authority.id;
    if (authority.epoch !== epoch || resetting || resolveId(id) !== id ||
        !isGeneration(id, authority.generation) || attempts.has(id)) {
      return false;
    }
    const marker = state[id];
    if (marker?.source === 'contended' || marker?.state === 'pending' ||
        (marker?.attemptId && marker.attemptId !== attemptId)) {
      return false;
    }
    if (marker?.state === 'owned' && marker.source === 'self') {
      return marker.attemptId === attemptId;
    }
    const current = await getTab(id);
    if (authority.epoch !== epoch || resetting || resolveId(id) !== id ||
        !isGeneration(id, authority.generation) || !current || current.id !== id ||
        !isNativeDiscardSettled(current) || attempts.has(id)) {
      return false;
    }
    state[id] = ownedMarker('self', attemptId, visual);
    return true;
  }, authority.epoch);
};

const invalidate = id => {
  if (resetting) {
    return Promise.resolve(false);
  }
  const currentId = resolveId(id);
  renewGeneration(currentId);
  const activeAttempt = attempts.get(currentId);
  attempts.delete(currentId);
  if (activeAttempt) {
    attemptOrigins.delete(activeAttempt);
  }
  takeoverAttempts.delete(currentId);
  observedDiscards.delete(currentId);
  return mutate(state => {
    const resolvedId = resolveId(id);
    const existed = resolvedId in state || id in state;
    if (!isDirectNativeOrphan(state[resolvedId])) {
      delete state[resolvedId];
    }
    if (resolvedId !== id && !isDirectNativeOrphan(state[id])) {
      delete state[id];
    }
    return existed;
  });
};

const deferTakeover = id => mutate(state => {
  if (!initialized) {
    return false;
  }
  if (nativeOrphanIn(state)) {
    return false;
  }
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

// Persist explicit work before it enters an in-memory scheduler. This is the
// MV3 recovery anchor for context-menu batches whose event listener itself
// cannot keep a service worker alive while earlier same-window jobs run.
const queueTakeover = async (tab, cancellation) => {
  const operationEpoch = epoch;
  const cancelled = () => cancellation?.cancelled === true;
  if (resetting || cancelled()) {
    return false;
  }
  initialized = true;
  const originId = tab?.id;
  const id = resolveId(originId);
  if (!Number.isInteger(id)) {
    return false;
  }
  const generation = generationOf(id);
  const current = await getTab(id);
  if (operationEpoch !== epoch || resetting || cancelled() || !isGeneration(id, generation) ||
      !current || current.id !== id || current.active === true) {
    return false;
  }
  const queueId = `queue-${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
  const queued = await mutate(state => {
    const currentId = resolveId(originId);
    if (cancelled() || currentId !== id || !isGeneration(id, generation) || attempts.has(id) ||
        nativeOrphanIn(state)) {
      return false;
    }
    const existing = state[id];
    const recovering = current.discarded === false && current.frozen !== true &&
      existing?.state === 'takeover-recovery';
    if (recovering) {
      return existing.attemptId || queueId;
    }
    if (current.discarded !== true && current.frozen !== true) {
      return false;
    }
    state[id] = {
      state: 'takeover-queued',
      source: 'requested',
      attemptId: queueId,
      updatedAt: Date.now()
    };
    return queueId;
  }, operationEpoch);
  return operationEpoch === epoch && !resetting && !cancelled() ? queued : false;
};

const clearQueuedTakeover = (id, queueId) => mutate(state => {
  id = resolveId(id);
  const marker = state[id];
  if (marker?.state !== 'takeover-queued' || marker.attemptId !== queueId) {
    return false;
  }
  delete state[id];
  return true;
});

// Chromium has no native discard-owner field. Adopt an already-discarded tab
// into this extension's ownership model without waking or reloading its page.
const adopt = async tab => {
  const operationEpoch = epoch;
  if (resetting) {
    return {retry: true};
  }
  initialized = true;
  const originId = tab && tab.id;
  let id = resolveId(originId);
  if (!Number.isInteger(id)) {
    return false;
  }
  if (attempts.has(id)) {
    return {busy: true};
  }
  const generation = generationOf(id);
  const current = await getTab(id);
  if (operationEpoch !== epoch || resetting) {
    return {retry: true};
  }
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
  if (!isGeneration(id, generation)) {
    return {retry: true};
  }

  const adoptionId = `adopt-${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
  const result = await mutate(state => {
    const currentId = resolveId(originId);
    if (attempts.has(currentId)) {
      return {busy: true};
    }
    if (nativeOrphanIn(state)) {
      return {busy: true, nativeOrphan: true};
    }
    if (!isGeneration(currentId, generation)) {
      return {retry: true};
    }
    const existing = state[currentId];
    if (existing?.state === 'owned' && (existing.source === 'self' || existing.source === 'adopted')) {
      return {marker: existing};
    }
    state[currentId] = ownedMarker('adopted', adoptionId);
    return {marker: state[currentId]};
  }, operationEpoch);
  if (!result || operationEpoch !== epoch || resetting) {
    return {retry: true};
  }
  if (result.busy || result.retry) {
    return result;
  }

  const final = await getTab(originId);
  if (operationEpoch !== epoch || resetting) {
    return {retry: true};
  }
  id = resolveId(originId);
  if (final?.discarded === true && isGeneration(id, generation) && !attempts.has(id)) {
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
    }, operationEpoch);
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

  const generation = renewGeneration(id);

  return mutate(async state => {
    const current = await getTab(id);
    if (!isGeneration(id, generation) || attempts.has(id)) {
      return false;
    }

    observedDiscards.delete(id);
    takeoverAttempts.delete(id);
    const marker = state[id];
    if (!current) {
      if (!isDirectNativeOrphan(marker)) {
        delete state[id];
      }
      return false;
    }
    if (nativeOrphanIn(state)) {
      return isDirectNativeOrphan(marker) ? marker : false;
    }

    // Moving an inactive tab is not proof that a previously accepted native
    // discard was cancelled. Preserve its durable ambiguity across both the
    // non-discarded replacement gap and discarded:true/status:complete.
    if (marker?.state === 'direct-native-pending' && current.active !== true) {
      if (isNativeDiscardSettled(current)) {
        state[id] = ownedMarker('physical-only', marker.attemptId);
      }
      return state[id];
    }
    if (current.discarded !== true) {
      delete state[id];
      return false;
    }

    if (marker?.state === 'owned' || marker?.state === 'takeover-queued' ||
        (marker?.state === 'late-native' && marker.expiresAt > Date.now())) {
      return marker;
    }
    state[id] = ownedMarker('claimed');
    return state[id];
  });
};

const claimAtGeneration = (tab, generation, operationEpoch = epoch) => {
  tab = currentTab(tab);
  const id = tab && tab.id;
  if (resetting || operationEpoch !== epoch || !Number.isInteger(id) || tab.discarded !== true) {
    return Promise.resolve(false);
  }
  if (!isGeneration(id, generation)) {
    return Promise.resolve(false);
  }
  if (attempts.has(id)) {
    observedDiscards.set(id, tab);
    return Promise.resolve(false);
  }

  return mutate(state => {
    const currentId = resolveId(id);
    const normalized = currentTab(tab);
    if (!isGeneration(currentId, generation)) {
      return false;
    }
    // A discard attempt may have started while this claim waited its turn.
    if (attempts.has(currentId)) {
      observedDiscards.set(currentId, normalized);
      return false;
    }
    const marker = state[currentId];
    // A physical successor observed without onReplaced is indistinguishable
    // from every other sleeping tab. Do not attach the lost attempt nonce (or
    // even an ordinary claim) by inference; the global orphan fence keeps all
    // such candidates inert until authoritative lineage arrives.
    if (nativeOrphanIn(state) && !isDirectNativeOrphan(marker)) {
      return false;
    }
    if (isDirectNativeOrphan(marker)) {
      return marker;
    }
    if (marker?.state === 'direct-native-pending') {
      if (isNativeDiscardSettled(normalized)) {
        state[currentId] = ownedMarker('physical-only', marker.attemptId);
      }
      // discarded:true can precede status:unloaded. Preserve the direct intent
      // until the browser exposes the complete native-discard postcondition.
      return state[currentId];
    }
    if (marker?.state === 'late-native' && marker.expiresAt > Date.now() &&
        isNativeDiscardSettled(normalized)) {
      state[currentId] = ownedMarker('self', marker.attemptId, marker.visual);
      return state[currentId];
    }
    if (marker?.state === 'late-native' && marker.expiresAt > Date.now()) {
      // discarded:true can precede Chromium's unloaded postcondition. Keep the
      // durable correlated intent pending; neither an early lifecycle event nor
      // a command read may relabel an ambiguous tab as self or external.
      return marker;
    }
    if (marker && marker.state === 'owned') {
      // A lifecycle claim can refresh age, but it must not replace the caller's
      // snapshot object: resolveFresh() needs the complete persisted marker
      // (including visual repair state) to classify the command truthfully.
      state[currentId] = {
        ...marker,
        updatedAt: Date.now()
      };
      return state[currentId];
    }

    state[currentId] = ownedMarker('claimed');
    return state[currentId];
  }, operationEpoch);
};

// Commands need the full persisted marker after a claim refresh. `claim()`'s
// public boolean-ish contract is historical and callers may receive `false`
// when an ownership attempt is active, so read the authoritative serialized
// snapshot once the generation-fenced claim has settled.
const markerAtGeneration = async (tab, generation, operationEpoch) => {
  await claimAtGeneration(tab, generation, operationEpoch);
  if (operationEpoch !== epoch || resetting || !isGeneration(tab.id, generation)) {
    return false;
  }
  const state = await snapshot();
  return state[resolveId(tab.id)] || false;
};

const claim = tab => {
  if (resetting) {
    return Promise.resolve(false);
  }
  initialized = true;
  tab = currentTab(tab);
  return claimAtGeneration(tab, generationOf(tab && tab.id));
};

// Resolve a tabs.query snapshot against the live tab. If a discarded snapshot
// woke in the meantime, callers receive the loaded tab so it can re-enter the
// discard pipeline instead of being silently skipped.
const resolveFresh = async tab => {
  const operationEpoch = epoch;
  if (resetting) {
    return {reset: true, state: 'missing'};
  }
  initialized = true;
  const originId = tab && tab.id;
  if (!Number.isInteger(resolveId(originId))) {
    return {state: 'missing'};
  }
  let lastError;

  for (let pass = 0; pass < 3; pass += 1) {
    const id = resolveId(originId);
    const generation = generationOf(id);
    const current = await getTab(id);
    if (operationEpoch !== epoch || resetting) {
      return {reset: true, state: 'missing'};
    }
    if (!current) {
      return {state: 'missing'};
    }
    if (resolveId(originId) !== current.id || !isGeneration(originId, generation)) {
      continue;
    }
    const fenceState = await stableState();
    if (operationEpoch !== epoch || resetting || resolveId(originId) !== current.id ||
        !isGeneration(originId, generation)) {
      continue;
    }
    if (current.active !== true && nativeOrphanIn(fenceState)) {
      return {
        nativeOrphan: true,
        state: 'direct-native-orphan',
        tab: current
      };
    }
    if (current.discarded !== true) {
      const persisted = fenceState[resolveId(originId)];
      const marker = persisted ? JSON.parse(JSON.stringify(persisted)) : undefined;
      if (current.active !== true &&
          marker?.state === 'direct-native-pending') {
        return {marker, state: 'direct-native-pending', tab: current};
      }
      return {state: 'loaded', tab: current};
    }

    try {
      const marker = await markerAtGeneration(current, generation, operationEpoch);
      if (operationEpoch !== epoch || resetting) {
        return {reset: true, state: 'missing'};
      }
      if (!isGeneration(originId, generation)) {
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
  if (operationEpoch !== epoch || resetting) {
    return {reset: true, state: 'missing'};
  }
  if (!current) {
    return {state: 'missing', unstable: true};
  }
  const fenceState = await stableState();
  if (current.active !== true && nativeOrphanIn(fenceState)) {
    return {
      nativeOrphan: true,
      state: 'direct-native-orphan',
      tab: current,
      unstable: true
    };
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
    const known = cached?.[resolveId(id)];
    if (tab?.active !== true && known?.state === 'direct-native-pending') {
      return true;
    }
    if (!known && tab?.active !== true && await hasBlockingNativeIntent(id)) {
      return true;
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
    const known = cached?.[resolveId(id)];
    if (tab?.active !== true && known?.state === 'direct-native-pending') {
      return true;
    }
    if (!known && tab?.active !== true && await hasBlockingNativeIntent(id)) {
      return true;
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
  const operationEpoch = epoch;
  if (resetting) {
    return Promise.resolve(false);
  }
  if (!Number.isInteger(addedId) || !Number.isInteger(removedId)) {
    return Promise.resolve(false);
  }
  const replacement = recordReplacement(replacements, addedId, removedId);
  if (!replacement?.changed) {
    return Promise.resolve(false);
  }
  const {from, to} = replacement;
  moveEntry(attempts, from, to);
  moveEntry(takeoverAttempts, from, to);
  moveEntry(observedDiscards, from, to, tab => currentTab({...tab, id: to}));
  // The predecessor is no longer a live identity. Fence reads started against
  // either object with a fresh successor token, then delete predecessor tokens
  // immediately; the replacement map alone preserves callback lineage.
  generations.delete(removedId);
  generations.delete(from);
  renewGeneration(to);

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
  }, operationEpoch).then(result => {
    const expectedId = resolveId(to);
    const generation = generationOf(expectedId);

    // Hold the ownership write fence across the live read. A newer attempt,
    // lifecycle generation, or replacement can still start while tabs.get is
    // pending, so recheck all three afterward before applying its stale result.
    return mutate(async state => {
      if (resolveId(to) !== expectedId || !isGeneration(expectedId, generation) ||
          attempts.has(expectedId)) {
        return result;
      }
      const current = await getTab(expectedId);
      if (!current || current.id !== expectedId || resolveId(to) !== expectedId ||
          !isGeneration(expectedId, generation) || attempts.has(expectedId)) {
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
        else if (marker?.state === 'takeover-queued') {
          // The explicit request was moved to the successor above. Preserve its
          // durable recovery anchor exactly; a worker restart before scheduler
          // execution must still resume this requested takeover.
          state[expectedId] = marker;
        }
        else if (marker?.state === 'direct-native-pending' && isNativeDiscardSettled(current)) {
          // The replacement is strong evidence that the native operation
          // crossed its physical boundary, but a lost worker cannot retain
          // callback authority to call it source:self.
          state[expectedId] = ownedMarker('physical-only', marker.attemptId);
        }
        else if (isDirectNativeOrphan(marker) && isNativeDiscardSettled(current)) {
          // Unlike a matching live-state guess, an actual onReplaced edge is
          // authoritative lineage. It may transfer the lost nonce to this one
          // successor, while worker loss still forbids calling it source:self.
          state[expectedId] = ownedMarker('physical-only', marker.attemptId);
        }
        else if (isDirectNativeOrphan(marker)) {
          state[expectedId] = directNativeMarker(marker.attemptId);
        }
        else if (marker?.state === 'late-native' && marker.expiresAt > Date.now() &&
            isNativeDiscardSettled(current)) {
          // A replacement is live proof that the timed-out native operation
          // completed and settled on this logical tab. Promote the moved marker
          // now because the old generation-scoped in-memory authority
          // intentionally cannot cross an id replacement.
          state[expectedId] = ownedMarker('self', marker.attemptId, marker.visual);
        }
        else if (marker?.state === 'late-native' && marker.expiresAt > Date.now()) {
          // discarded:true can precede Chromium's authoritative unloaded state.
          // Keep the durable pending marker so a later lifecycle claim/startup
          // reconciliation can promote it, rather than claiming too early.
          state[expectedId] = marker;
        }
        else {
          state[expectedId] = ownedMarker('claimed');
        }
        return state[expectedId];
      }

      renewGeneration(expectedId);
      observedDiscards.delete(expectedId);
      takeoverAttempts.delete(expectedId);
      const liveMarker = state[expectedId];
      if (liveMarker?.state === 'direct-native-pending' && current.active !== true) {
        // Edge can expose a successor before its final discarded/unloaded
        // update. The moved intent is the only authority preventing a repeat
        // renderer scan or second tabs.discard call in this gap.
        return liveMarker;
      }
      if (isDirectNativeOrphan(liveMarker) && current.active !== true) {
        // The real replacement event, not candidate shape, transfers the nonce.
        // Preserve the normal per-tab pending fence until Edge publishes its
        // discarded/unloaded postcondition.
        state[expectedId] = directNativeMarker(liveMarker.attemptId);
        return state[expectedId];
      }
      const existed = expectedId in state;
      delete state[expectedId];
      return existed;
    }, operationEpoch);
  });
};

const clearTransientId = (id, {generation = true} = {}) => {
  const attemptId = attempts.get(id);
  attempts.delete(id);
  if (attemptId) {
    attemptOrigins.delete(attemptId);
  }
  takeoverAttempts.delete(id);
  observedDiscards.delete(id);
  if (generation) {
    generations.delete(id);
  }
};

const replacementLineage = currentId => {
  const lineage = new Set([currentId]);
  for (const id of [...replacements.keys()]) {
    if (resolveId(id) === currentId) {
      lineage.add(id);
    }
  }
  return lineage;
};

const forgetReplacementLineage = (currentId, lineage = replacementLineage(currentId)) => {
  for (const id of lineage) {
    // replacementLineage() path-compresses captured predecessors to the final
    // identity. Match that exact edge so a reused id's newer lineage is safe.
    if (id !== currentId && replacements.get(id) === currentId) {
      replacements.delete(id);
    }
  }
};

const removeUnlocked = id => {
  const currentId = resolveId(id);
  if (!Number.isInteger(currentId)) {
    return Promise.resolve(false);
  }

  // onRemoved for an Edge predecessor can arrive after onReplaced. Its live
  // attempt and observed state have already moved to the successor, so only
  // predecessor-local bookkeeping is safe to prune here.
  if (currentId !== id) {
    clearTransientId(id);
    return Promise.resolve(false);
  }

  const lineage = replacementLineage(currentId);
  const removalGeneration = renewGeneration(currentId);
  for (const predecessor of lineage) {
    clearTransientId(predecessor, {generation: predecessor !== currentId});
  }

  const finalize = () => {
    forgetReplacementLineage(currentId, lineage);
    // A newly-created tab may reuse this numeric id before the serialized
    // removal finishes. Its onCreated token wins and keeps its own state.
    if (generations.get(currentId) === removalGeneration && resolveId(currentId) === currentId) {
      generations.delete(currentId);
    }
  };

  const operation = mutate(state => {
    let existed = false;
    for (const removedId of lineage) {
      existed = removedId in state || existed;
      const marker = state[removedId];
      if (marker?.state === 'direct-native-pending') {
        // onRemoved without onReplaced cannot prove whether Edge completed a
        // replacement while the worker was unavailable. Retain only the
        // session nonce as a global orphan fence; do not invent a successor.
        state[removedId] = directNativeOrphanMarker(marker.attemptId);
      }
      else if (!isDirectNativeOrphan(marker)) {
        delete state[removedId];
      }
    }
    return existed;
  });
  return operation.then(result => {
    finalize();
    return result;
  }, error => {
    finalize();
    throw error;
  });
};
const remove = id => {
  nativeRemovalGeneration += 1;
  return serializeNativeMutation(() => removeUnlocked(id));
};

const pruneTransientMaps = liveIds => {
  for (const map of [attempts, takeoverAttempts, observedDiscards, generations]) {
    for (const id of [...map.keys()]) {
      if (!liveIds.has(id)) {
        map.delete(id);
      }
    }
  }

  pruneReplacementLineage(replacements, {
    liveIds,
    referencedIds: new Set(attemptOrigins.values())
  });
};

const reconcileUnlocked = (operationEpoch = epoch) => {
  if (resetting || operationEpoch !== epoch) {
    return Promise.resolve(false);
  }
  initialized = true;
  return mutate(async state => {
    const tabs = await queryTabs({});
    const live = new Map(tabs.filter(tab => Number.isInteger(tab.id)).map(tab => [tab.id, tab]));
    // Without a replacement event, no live-row shape or absence is causal
    // proof. Edge can expose a short predecessor-absent/successor-not-yet-
    // enumerable gap, so even a full query with zero inactive tabs cannot
    // safely retire this session fence. Only an actual onReplaced transfer,
    // explicit reset, or storage.session/browser-session loss may clear it.
    pruneTransientMaps(new Set(live.keys()));

    for (const key of Object.keys(state)) {
      const id = Number(key);
      const tab = live.get(id);
      const marker = state[key];
      const pendingHere = marker && attempts.get(id) === marker.attemptId;
      const takeoverMarker = typeof marker?.state === 'string' && marker.state.startsWith('takeover-');

      if (!marker || typeof marker !== 'object') {
        clearTransientId(id, {generation: false});
        delete state[key];
      }
      else if (isDirectNativeOrphan(marker)) {
        state[key] = marker;
      }
      else if (!tab) {
        clearTransientId(id, {generation: false});
        if (marker.state === 'direct-native-pending') {
          state[key] = directNativeOrphanMarker(marker.attemptId);
        }
        else {
          delete state[key];
        }
      }
      else if (tab.discarded === true) {
        if (marker.state === 'late-native' && marker.expiresAt > Date.now() &&
            isNativeDiscardSettled(tab)) {
          state[key] = ownedMarker('self', marker.attemptId, marker.visual);
        }
        else if (marker.state === 'late-native' && marker.expiresAt > Date.now()) {
          state[key] = marker;
        }
        else if (marker.state === 'takeover-queued') {
          state[key] = marker;
        }
        // `takeover-waking` is persisted before reload/activation begins. If
        // MV3 stops the worker in that exact gap, the still-discarded live tab
        // proves the destructive phase never started, so retain the explicit
        // request as queued work for startup recovery instead of downgrading it
        // to an ordinary external claim.
        else if (marker.state === 'takeover-waking' && tab.active !== true && !pendingHere) {
          state[key] = {
            ...marker,
            source: 'requested',
            state: 'takeover-queued',
            updatedAt: Date.now()
          };
        }
        // A direct-native intent proves only that persistence completed before
        // tabs.discard() was invoked. After worker loss there is no callback
        // authority to distinguish our operation from an external winner, so
        // retain the physical state without claiming visual/self ownership.
        else if (marker.state === 'direct-native-pending' && !pendingHere &&
            isNativeDiscardSettled(tab)) {
          state[key] = ownedMarker('physical-only', marker.attemptId);
        }
        else if (marker.state === 'direct-native-pending' && !pendingHere) {
          state[key] = marker;
        }
        else if ((marker.state === 'pending' || takeoverMarker) && !pendingHere) {
          state[key] = ownedMarker('claimed', marker.attemptId);
        }
        else if (marker.state === 'owned') {
          state[key] = marker;
        }
      }
      else if (marker.state === 'direct-native-pending' && pendingHere) {
        state[key] = marker;
      }
      else if (marker.state === 'direct-native-pending' && tab.active !== true) {
        // The worker may have stopped after invoking tabs.discard() but before
        // Edge exposed discarded/unloaded or its replacement. Preserve the
        // durable ambiguity: a later native lifecycle can promote it, while a
        // repeat command must remain protected and issue no second operation.
        state[key] = marker;
      }
      else if (marker.state === 'direct-native-pending') {
        delete state[key];
      }
      else if (marker.state === 'takeover-queued' && tab.frozen === true && tab.active !== true) {
        state[key] = marker;
      }
      else if (marker.state === 'late-native' && marker.expiresAt > Date.now() && tab.active !== true) {
        state[key] = marker;
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

    const nativeOrphan = nativeOrphanIn(state);
    for (const tab of tabs) {
      if (tab.discarded !== true || attempts.has(tab.id)) {
        continue;
      }
      const marker = state[tab.id];
      if (nativeOrphan && !marker) {
        // No event correlates this row with the missing predecessor. Leave it
        // unowned rather than guessing physical-only (or external) ownership;
        // resolveFresh() exposes the global fail-closed classification.
        continue;
      }
      const correlatedLate = marker?.state === 'late-native' && marker.expiresAt > Date.now();
      const directPending = marker?.state === 'direct-native-pending';
      const directOrphan = isDirectNativeOrphan(marker);
      if (!marker || (marker.state !== 'owned' && marker.state !== 'takeover-queued' &&
          !correlatedLate && !directPending && !directOrphan)) {
        state[tab.id] = ownedMarker('claimed');
      }
    }

    return Object.values(state).filter(marker => marker.state === 'owned').length;
  }, operationEpoch);
};
const reconcile = (operationEpoch = epoch) => serializeNativeMutation(() =>
  reconcileUnlocked(operationEpoch)
);

const start = async (retries = 2, delay = 250, operationEpoch = epoch) => {
  if (resetting || operationEpoch !== epoch) {
    return false;
  }
  initialized = true;
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (resetting || operationEpoch !== epoch) {
      return false;
    }
    try {
      const result = await reconcile(operationEpoch);
      if (result === false || resetting || operationEpoch !== epoch) {
        return false;
      }
      reconciledOnce = true;
      return result;
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

// Run one browser mutation only after startup reconciliation and under the
// same global ordering fence as orphan creation. The callback must perform its
// check and browser effect synchronously (returning the resulting Promise is
// fine); no orphan can appear between those two steps.
const withNativeMutationGuard = (task, targetId, allowedAttemptId) => {
  const requestedEpoch = epoch;
  const requestedDuringReset = resetting;
  const requestedRemovalGeneration = nativeRemovalGeneration;
  return serializeNativeMutation(async () => {
  if (requestedDuringReset || requestedEpoch !== epoch || resetting) {
    const error = Error('ownership reset is in progress');
    error.code = 'DIRECT_NATIVE_ORPHAN_BLOCKED';
    throw error;
  }
  if (!reconciledOnce) {
    const reconciled = await reconcileUnlocked(requestedEpoch);
    if (reconciled === false || resetting || requestedEpoch !== epoch) {
      const error = Error('ownership reconciliation did not reach a stable boundary');
      error.code = 'DIRECT_NATIVE_ORPHAN_BLOCKED';
      throw error;
    }
    reconciledOnce = true;
  }
  const state = await stableState();
  const resolvedTargetId = resolveId(targetId);
  const targetMarker = Number.isInteger(resolvedTargetId) ? state[resolvedTargetId] : undefined;
  const authorizedDirectNative = typeof allowedAttemptId === 'string' &&
    targetMarker?.state === 'direct-native-pending' &&
    targetMarker.attemptId === allowedAttemptId &&
    attempts.get(resolvedTargetId) === allowedAttemptId;
  if (resetting || requestedEpoch !== epoch ||
      requestedRemovalGeneration !== nativeRemovalGeneration || nativeOrphanIn(state) ||
      (typeof allowedAttemptId === 'string' && !authorizedDirectNative) ||
      (targetMarker?.state === 'direct-native-pending' && !authorizedDirectNative) ||
      isDirectNativeOrphan(targetMarker)) {
    const error = Error('direct native discard lineage is unresolved');
    error.code = 'DIRECT_NATIVE_ORPHAN_BLOCKED';
    throw error;
  }
  const operation = task();
  // The browser call itself must be issued under the fence, but holding it
  // until a renderer/reload/native Promise settles would deadlock the very
  // lifecycle event that creates or transfers ownership state.
  return {operation};
  }).then(({operation}) => operation);
};

const clearTransient = () => {
  attempts.clear();
  attemptOrigins.clear();
  takeoverAttempts.clear();
  observedDiscards.clear();
  generations.clear();
  replacements.clear();
};

const classifyTabs = tabs => {
  const classified = (tabs || []).filter(tab => Number.isInteger(tab.id)).map(tab => ({
    id: tab.id,
    state: tab.discarded === true ? 'discarded' : (tab.frozen === true ? 'frozen' : 'loaded')
  }));

  return {
    discarded: classified.filter(tab => tab.state === 'discarded').length,
    frozen: classified.filter(tab => tab.state === 'frozen').length,
    loaded: classified.filter(tab => tab.state === 'loaded').length,
    tabs: classified,
    total: classified.length
  };
};

// Reset is a write barrier. Callers may request an immediate fresh
// reconciliation after old authority is erased; this classifies a still
// sleeping physical tab as an external claim, never as one of our old self,
// pending, late-native, or replacement attempts.
const reset = ({reconcile: reconcileLive = false} = {}) => {
  const resetEpoch = ++epoch;
  resetting = true;
  reconciledOnce = false;
  initialized = false;
  cacheGeneration += 1;
  cached = undefined;
  loading = undefined;
  clearTransient();

  const pendingWrites = writes;
  const operation = serializeNativeMutation(() => {
    const resetWrite = pendingWrites.then(async () => {
      try {
        if (resetEpoch !== epoch) {
          return false;
        }
        clearTransient();
        sequence = 0;
        generationSequence = 0;
        cached = undefined;
        loading = undefined;
        await persistence.clear();
        cached = {};

        if (resetEpoch !== epoch) {
          return false;
        }
        const tabs = await queryTabs({});
        const result = classifyTabs(tabs);
        if (reconcileLive) {
          const fresh = {};
          for (const tab of tabs) {
            if (Number.isInteger(tab?.id) && tab.discarded === true) {
              fresh[tab.id] = ownedMarker('claimed');
            }
          }
          await persistence.persist({}, fresh, new Set(Object.keys(fresh)));
          cached = fresh;
          initialized = true;
        }
        reconciledOnce = reconcileLive;
        return reconcileLive ? {
          ...result,
          reconciled: true,
          sleepingClaims: Object.keys(cached).length
        } : result;
      }
      finally {
        if (resetEpoch === epoch) {
          resetting = false;
        }
      }
    });
    writes = resetWrite.then(() => undefined, () => undefined);
    return resetWrite;
  });
  return operation;
};

const drainWrites = async () => {
  while (true) {
    const pending = writes;
    await pending;
    if (pending === writes) {
      return;
    }
  }
};

const stableState = async () => {
  await drainWrites();
  return load();
};

const snapshot = async () => JSON.parse(JSON.stringify(await stableState()));

const status = async id => {
  const state = await stableState();
  id = resolveId(id);
  const marker = state[id];
  return {
    attemptId: attempts.get(id),
    marker: marker ? JSON.parse(JSON.stringify(marker)) : undefined,
    ...(nativeOrphanIn(state) && {nativeOrphan: true}),
    takeover: takeoverAttempts.has(id)
  };
};

const isCurrent = (id, attemptId) => attempts.get(resolveId(id)) === attemptId;

// Count-only diagnostics support leak/stress tests without exposing tab ids,
// URLs, markers, or any other browsing data.
const diagnostics = async () => {
  await nativeMutationTail;
  await drainWrites();
  return {
    attempts: attempts.size,
    generations: generations.size,
    observedDiscards: observedDiscards.size,
    replacements: replacements.size,
    takeoverAttempts: takeoverAttempts.size
  };
};

// One shared, serialized guard protects every path that could otherwise touch
// a renderer or issue a second native discard while Edge is between its
// frozen, replacement, and unloaded observations. Callers must treat a true
// result as an absolute no-mutation boundary.
const hasBlockingNativeIntent = async id => {
  const state = await status(id);
  return state.nativeOrphan === true ||
    state.marker?.state === 'direct-native-pending' ||
    state.marker?.state === 'direct-native-orphan';
};

// Storage-only counters deliberately contain no tab ids, marker values, URLs,
// or other browsing data. They make write amplification and quota behavior
// observable in deterministic stress tests without widening snapshot access.
const persistenceDiagnostics = async () => {
  await drainWrites();
  return persistence.diagnostics();
};

const report = error => console.warn('discard ownership update failed', error);
const bind = () => {
  if (bound) {
    return;
  }
  bound = true;

  chrome.tabs.onUpdated?.addListener((id, changeInfo, tab) => {
    if (!initialized || resolveId(id) !== id) {
      return;
    }
    observe(id, changeInfo, tab).catch(report);
  });
  chrome.tabs.onCreated?.addListener(tab => {
    if (!initialized || !Number.isInteger(tab.id)) {
      return;
    }
    // Chromium may eventually reuse numeric tab ids. Detach this new identity
    // from any stale predecessor edge before assigning its unique generation.
    replacements.delete(tab.id);
    clearTransientId(tab.id);
    renewGeneration(tab.id);
    if (tab.discarded === true) {
      claim(tab).catch(report);
    }
  });
  chrome.tabs.onActivated?.addListener(({tabId}) => {
    if (!initialized || !Number.isInteger(tabId)) {
      return;
    }
    // Activation is authoritative user/browser wake evidence. It is the one
    // inactive-looking follow-up cannot undo: clear any persisted direct
    // ambiguity now so a later deactivation cannot leave a permanent blocker.
    invalidate(tabId).catch(report);
  });
  chrome.tabs.onAttached?.addListener(id => {
    if (!initialized || resolveId(id) !== id) {
      return;
    }
    revalidateAttached(id).catch(report);
  });
  chrome.tabs.onRemoved?.addListener(id => {
    if (!initialized || resolveId(id) !== id) {
      if (initialized) {
        clearTransientId(id);
      }
      return;
    }
    remove(id).catch(report);
  });
  chrome.tabs.onReplaced?.addListener((addedId, removedId) => {
    if (initialized) {
      replace(addedId, removedId).catch(report);
    }
  });
};

bind();

const ownership = {
  adopt,
  begin,
  beginDirectNative,
  beginTakeover,
  bind,
  claim,
  claimFresh,
  clearQueuedTakeover,
  confirmSelf,
  deferTakeover,
  diagnostics,
  finish,
  hasBlockingNativeIntent,
  invalidate,
  isCurrent,
  lateAuthority,
  observe,
  persistenceDiagnostics,
  promoteLateSelf,
  queueTakeover,
  reconcile,
  reset,
  resolveId,
  resolveFresh,
  start,
  status,
  snapshot,
  withNativeMutationGuard
};

export {ownership, STORAGE_KEY};
