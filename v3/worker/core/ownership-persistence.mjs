const STORAGE_KEY = '__discardOwnership';
const RECORD_PREFIX = `${STORAGE_KEY}:tab:`;
const ROOT_SCHEMA = 'auto-tab-discard/ownership';
const ROOT_VERSION = 2;
const RECORD_SCHEMA = 'auto-tab-discard/ownership-marker';
const RECORD_VERSION = 1;
const MAX_RECORDS = 10000;
const MAX_ATTEMPT_ID_LENGTH = 256;
const MAX_RECORD_BYTES = 2048;

const ROOT_READY = Object.freeze({
  schema: ROOT_SCHEMA,
  version: ROOT_VERSION,
  phase: 'ready'
});
const ROOT_MIGRATING = Object.freeze({
  schema: ROOT_SCHEMA,
  version: ROOT_VERSION,
  phase: 'migrating'
});

const markerStates = new Set([
  'direct-native-orphan',
  'direct-native-pending',
  'late-native',
  'owned',
  'pending',
  'takeover-awake',
  'takeover-queued',
  'takeover-recovery',
  'takeover-waking'
]);
const ownedSources = new Set(['adopted', 'claimed', 'contended', 'physical-only', 'self']);
const markerKeys = new Set(['attemptId', 'expiresAt', 'source', 'state', 'updatedAt', 'visual']);
const visualBooleanKeys = new Set(['complete', 'favicon', 'repair', 'title']);
const visualKeys = new Set([...visualBooleanKeys, 'physicalOnly', 'titleMarker']);

const plainObject = value => value !== null && typeof value === 'object' &&
  Array.isArray(value) === false && (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);
const canonicalId = value => Number.isSafeInteger(value) && value >= 0;
const recordKey = id => `${RECORD_PREFIX}${id}`;
const idFromRecordKey = key => {
  if (typeof key !== 'string' || !key.startsWith(RECORD_PREFIX)) {
    return undefined;
  }
  const suffix = key.slice(RECORD_PREFIX.length);
  if (!/^(0|[1-9]\d*)$/.test(suffix)) {
    return undefined;
  }
  const id = Number(suffix);
  return canonicalId(id) ? id : undefined;
};
const ownershipKey = key => key === STORAGE_KEY ||
  (typeof key === 'string' && key.startsWith(RECORD_PREFIX));
const clone = value => JSON.parse(JSON.stringify(value));
const serializedBytes = value => {
  const text = JSON.stringify(value);
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(text).byteLength : text.length;
};

const validateVisual = value => {
  if (!plainObject(value) || Object.keys(value).some(key => !visualKeys.has(key))) {
    return false;
  }
  if (![...visualBooleanKeys].every(key => typeof value[key] === 'boolean')) {
    return false;
  }
  if (value.physicalOnly !== undefined && typeof value.physicalOnly !== 'boolean') {
    return false;
  }
  return value.titleMarker === undefined ||
    (typeof value.titleMarker === 'string' && value.titleMarker.length > 0 &&
      [...value.titleMarker].length <= 32);
};

// Persistence accepts only states emitted by ownership.mjs. Unknown fields are
// rejected instead of copied forward, so a future schema can never be silently
// interpreted with today's ownership/reload semantics.
const validateMarker = marker => {
  if (!plainObject(marker) || Object.keys(marker).some(key => !markerKeys.has(key)) ||
      !markerStates.has(marker.state) || !Number.isFinite(marker.updatedAt) || marker.updatedAt < 0) {
    return {ok: false, reason: 'malformed-marker'};
  }
  if (marker.attemptId !== undefined && marker.attemptId !== null &&
      (typeof marker.attemptId !== 'string' || marker.attemptId.length === 0 ||
        marker.attemptId.length > MAX_ATTEMPT_ID_LENGTH)) {
    return {ok: false, reason: 'invalid-attempt-id'};
  }
  if (marker.visual !== undefined && !validateVisual(marker.visual)) {
    return {ok: false, reason: 'invalid-visual'};
  }

  if (marker.state === 'owned') {
    if (!ownedSources.has(marker.source) || marker.expiresAt !== undefined ||
        (marker.visual !== undefined && marker.source !== 'self')) {
      return {ok: false, reason: 'invalid-owned-marker'};
    }
  }
  else if (marker.state === 'late-native') {
    if (marker.source !== 'self-pending' || typeof marker.attemptId !== 'string' ||
        !Number.isFinite(marker.expiresAt) || marker.expiresAt < 0) {
      return {ok: false, reason: 'invalid-late-marker'};
    }
  }
  else if (marker.state === 'direct-native-pending' || marker.state === 'direct-native-orphan') {
    if (marker.source !== undefined || typeof marker.attemptId !== 'string' ||
        marker.expiresAt !== undefined || marker.visual !== undefined) {
      return {ok: false, reason: marker.state === 'direct-native-orphan' ?
        'invalid-direct-native-orphan' : 'invalid-direct-native-marker'};
    }
  }
  else {
    if (marker.expiresAt !== undefined || marker.visual !== undefined ||
        (marker.state === 'takeover-queued' ? marker.source !== 'requested' :
          marker.state === 'takeover-recovery' ?
            marker.source !== undefined && marker.source !== 'requested' : marker.source !== undefined) ||
        typeof marker.attemptId !== 'string') {
      return {ok: false, reason: 'invalid-phase-marker'};
    }
  }

  if (serializedBytes(marker) > MAX_RECORD_BYTES) {
    return {ok: false, reason: 'marker-too-large'};
  }
  return {ok: true, marker: clone(marker)};
};

const validRoot = root => plainObject(root) && root.schema === ROOT_SCHEMA &&
  root.version === ROOT_VERSION && (root.phase === 'ready' || root.phase === 'migrating') &&
  Object.keys(root).length === 3;

const legacyState = root => {
  if (!plainObject(root) || Object.keys(root).length > MAX_RECORDS) {
    return {ok: false, reason: 'malformed-legacy-root'};
  }
  const state = {};
  for (const [key, candidate] of Object.entries(root)) {
    if (!/^(0|[1-9]\d*)$/.test(key) || !canonicalId(Number(key))) {
      return {ok: false, reason: 'malformed-legacy-id'};
    }
    const result = validateMarker(candidate);
    if (!result.ok) {
      return result;
    }
    state[key] = result.marker;
  }
  return {ok: true, state};
};

const recordEnvelope = (id, marker) => ({
  schema: RECORD_SCHEMA,
  version: RECORD_VERSION,
  id,
  marker
});

const decodeRecords = values => {
  const state = {};
  const rejectedKeys = [];
  let seen = 0;
  for (const [key, value] of Object.entries(values || {})) {
    if (!key.startsWith(RECORD_PREFIX)) {
      continue;
    }
    seen += 1;
    const id = idFromRecordKey(key);
    const marker = validateMarker(value?.marker);
    if (seen > MAX_RECORDS || id === undefined || !plainObject(value) ||
        value.schema !== RECORD_SCHEMA || value.version !== RECORD_VERSION || value.id !== id ||
        Object.keys(value).some(field => !['id', 'marker', 'schema', 'version'].includes(field)) ||
        !marker.ok) {
      rejectedKeys.push(key);
      continue;
    }
    state[id] = marker.marker;
  }
  return {rejectedKeys, state};
};

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now();

const createOwnershipPersistence = api => {
  const primary = api.storage.session?.get && api.storage.session?.set && api.storage.session?.remove ?
    api.storage.session : api.storage.local;
  const fallback = primary === api.storage.session && api.storage.local?.get &&
    api.storage.local?.set && api.storage.local?.remove ? api.storage.local : undefined;
  let ready = false;
  let recordCount;
  const metrics = {
    bytesWritten: 0,
    coalescedMutations: 0,
    loadCalls: 0,
    maxBatchMutations: 0,
    maxQueueLatencyMs: 0,
    maxWriteBytes: 0,
    migrations: 0,
    mutationBatches: 0,
    mutationsPersisted: 0,
    noops: 0,
    queueLatencyMs: 0,
    queueSamples: 0,
    quotaFailures: 0,
    recordsRemoved: 0,
    recordsWritten: 0,
    rejectedRecords: 0,
    removeCalls: 0,
    setCalls: 0,
    storageFailures: 0
  };

  const lastError = () => api.runtime?.lastError;
  const getAll = area => new Promise((resolve, reject) => {
    try {
      area.get(null, result => {
        const error = lastError();
        error ? reject(Error(error.message || error)) : resolve(result || {});
      });
    }
    catch (error) {
      reject(error);
    }
  });
  const set = (area, values) => new Promise((resolve, reject) => {
    const bytes = serializedBytes(values);
    metrics.setCalls += 1;
    metrics.bytesWritten += bytes;
    metrics.maxWriteBytes = Math.max(metrics.maxWriteBytes, bytes);
    try {
      // chrome.storage performs a structured clone. Clone here as well so test
      // adapters cannot retain and mutate our frozen schema constants by
      // reference in ways a browser never would.
      area.set(clone(values), () => {
        const error = lastError();
        if (error) {
          metrics.storageFailures += 1;
          if (/quota/i.test(error.message || String(error))) {
            metrics.quotaFailures += 1;
          }
          reject(Error(error.message || error));
        }
        else {
          resolve();
        }
      });
    }
    catch (error) {
      metrics.storageFailures += 1;
      if (/quota/i.test(error.message || String(error))) {
        metrics.quotaFailures += 1;
      }
      reject(error);
    }
  });
  const removeOne = (area, key) => new Promise((resolve, reject) => {
    metrics.removeCalls += 1;
    try {
      area.remove(key, () => {
        const error = lastError();
        if (error) {
          metrics.storageFailures += 1;
          if (/quota/i.test(error.message || String(error))) {
            metrics.quotaFailures += 1;
          }
          reject(Error(error.message || error));
        }
        else {
          resolve();
        }
      });
    }
    catch (error) {
      metrics.storageFailures += 1;
      if (/quota/i.test(error.message || String(error))) {
        metrics.quotaFailures += 1;
      }
      reject(error);
    }
  });
  const removeKeys = async (area, keys) => {
    const unique = [...new Set(keys)];
    if (unique.length) {
      await removeOne(area, unique.length === 1 ? unique[0] : unique);
    }
  };
  const ownershipKeys = values => Object.keys(values || {}).filter(ownershipKey);
  const purge = async (area, values) => {
    const keys = ownershipKeys(values);
    if (keys.length) {
      await removeKeys(area, keys);
    }
  };
  const recordValues = state => {
    const values = {};
    for (const [key, marker] of Object.entries(state)) {
      const id = Number(key);
      values[recordKey(id)] = recordEnvelope(id, marker);
    }
    return values;
  };
  const migrate = async (sourceArea, sourceValues, state, current) => {
    if (!current()) {
      return state;
    }
    // Keep the legacy/fallback root authoritative while writing envelopes. A
    // multi-key storage call can report failure after applying only a prefix;
    // on restart that old root lets load() discard the partial records and
    // retry the complete migration instead of trusting a truncated v2 state.
    const records = recordValues(state);
    if (Object.keys(records).length) {
      await set(primary, records);
    }
    if (!current()) {
      return state;
    }
    // Only publish the migrating root after every record write succeeded. From
    // here onward each root transition is a single-key operation; a torn
    // migrating phase therefore always has a complete record set to resume.
    await set(primary, {[STORAGE_KEY]: ROOT_MIGRATING});
    if (!current()) {
      return state;
    }
    await set(primary, {[STORAGE_KEY]: ROOT_READY});
    if (!current()) {
      return state;
    }
    ready = true;
    recordCount = Object.keys(state).length;
    metrics.migrations += 1;
    if (sourceArea && sourceArea !== primary) {
      if (!current()) {
        return state;
      }
      await purge(sourceArea, sourceValues);
    }
    return state;
  };

  const loadCurrent = async (values, current) => {
    const decoded = decodeRecords(values);
    metrics.rejectedRecords += decoded.rejectedKeys.length;
    if (decoded.rejectedKeys.length && current()) {
      await removeKeys(primary, decoded.rejectedKeys);
    }
    if (values[STORAGE_KEY].phase === 'migrating' && current()) {
      await set(primary, {[STORAGE_KEY]: ROOT_READY});
      metrics.migrations += 1;
    }
    if (current()) {
      ready = true;
      recordCount = Object.keys(decoded.state).length;
    }
    return decoded.state;
  };

  const load = async (current = () => true) => {
    metrics.loadCalls += 1;
    const values = await getAll(primary);
    const root = values[STORAGE_KEY];

    if (validRoot(root)) {
      const state = await loadCurrent(values, current);
      if (fallback && current()) {
        const fallbackValues = await getAll(fallback);
        if (current()) {
          await purge(fallback, fallbackValues);
        }
      }
      return state;
    }

    if (root !== undefined) {
      const legacy = legacyState(root);
      if (legacy.ok) {
        // Existing record keys beside a legacy root are leftovers from an
        // interrupted/foreign schema. Remove them before canonical migration.
        if (current()) {
          await removeKeys(primary, Object.keys(values).filter(key => key.startsWith(RECORD_PREFIX)));
        }
        return migrate(primary, values, legacy.state, current);
      }
      metrics.rejectedRecords += 1;
      if (!current()) {
        return {};
      }
      await purge(primary, values);
      if (fallback) {
        const fallbackValues = await getAll(fallback);
        if (current()) {
          await purge(fallback, fallbackValues);
        }
      }
      if (!current()) {
        return {};
      }
      await set(primary, {[STORAGE_KEY]: ROOT_READY});
      if (current()) {
        ready = true;
        recordCount = 0;
      }
      return {};
    }

    // An absent root with orphan records is a torn/cleared session, never an
    // authority source. Expire it and reconstruct from live tabs in reconcile.
    const orphanKeys = Object.keys(values).filter(key => key.startsWith(RECORD_PREFIX));
    if (orphanKeys.length) {
      metrics.rejectedRecords += orphanKeys.length;
      if (current()) {
        await removeKeys(primary, orphanKeys);
      }
    }

    if (fallback) {
      const fallbackValues = await getAll(fallback);
      const fallbackRoot = fallbackValues[STORAGE_KEY];
      if (validRoot(fallbackRoot)) {
        const decoded = decodeRecords(fallbackValues);
        metrics.rejectedRecords += decoded.rejectedKeys.length;
        return migrate(fallback, fallbackValues, decoded.state, current);
      }
      if (fallbackRoot !== undefined) {
        const legacy = legacyState(fallbackRoot);
        if (legacy.ok) {
          return migrate(fallback, fallbackValues, legacy.state, current);
        }
        metrics.rejectedRecords += 1;
        if (current()) {
          await purge(fallback, fallbackValues);
        }
      }
    }

    if (current()) {
      await set(primary, {[STORAGE_KEY]: ROOT_READY});
      if (current()) {
        ready = true;
        recordCount = 0;
      }
    }
    return {};
  };

  const persist = async (previous, next, changedKeys) => {
    const upserts = {};
    const removals = [];
    const ids = changedKeys ? new Set(changedKeys) : new Set([...Object.keys(previous), ...Object.keys(next)]);
    if (recordCount === undefined) {
      recordCount = Object.keys(previous).length;
    }
    const nextSize = recordCount + [...ids].reduce((total, key) => {
      return total + (!(key in previous) && key in next ? 1 : key in previous && !(key in next) ? -1 : 0);
    }, 0);
    if (nextSize > MAX_RECORDS) {
      throw Error('ownership record limit exceeded');
    }
    for (const key of ids) {
      const id = Number(key);
      if (!canonicalId(id) || String(id) !== String(key)) {
        throw Error('invalid ownership tab id');
      }
      if (!(key in next)) {
        if (key in previous) {
          removals.push(recordKey(id));
        }
        continue;
      }
      if (!(key in previous) || !same(previous[key], next[key])) {
        const result = validateMarker(next[key]);
        if (!result.ok) {
          throw Error(`invalid ownership marker: ${result.reason}`);
        }
        upserts[recordKey(id)] = recordEnvelope(id, result.marker);
      }
    }

    if (!Object.keys(upserts).length && !removals.length) {
      metrics.noops += 1;
      return;
    }

    // Add/update destinations before deleting predecessors. A crash may leave a
    // harmless duplicate that reconciliation prunes; it cannot lose authority.
    if (Object.keys(upserts).length || !ready) {
      await set(primary, {
        ...(!ready && {[STORAGE_KEY]: ROOT_READY}),
        ...upserts
      });
      ready = true;
      metrics.recordsWritten += Object.keys(upserts).length;
    }
    if (removals.length) {
      await removeKeys(primary, removals);
      metrics.recordsRemoved += removals.length;
    }
    recordCount = nextSize;
  };

  const clear = async () => {
    const values = await getAll(primary);
    await purge(primary, values);
    if (fallback) {
      const fallbackValues = await getAll(fallback);
      await purge(fallback, fallbackValues);
    }
    ready = false;
    recordCount = 0;
  };

  const observeQueueLatency = startedAt => {
    const latency = Math.max(0, monotonicNow() - startedAt);
    metrics.queueLatencyMs += latency;
    metrics.queueSamples += 1;
    metrics.maxQueueLatencyMs = Math.max(metrics.maxQueueLatencyMs, latency);
  };
  const observeMutationBatch = size => {
    size = Math.max(0, Math.floor(Number(size) || 0));
    if (!size) {
      return;
    }
    metrics.mutationBatches += 1;
    metrics.mutationsPersisted += size;
    metrics.coalescedMutations += Math.max(0, size - 1);
    metrics.maxBatchMutations = Math.max(metrics.maxBatchMutations, size);
  };
  const diagnostics = () => ({...metrics});

  return {clear, diagnostics, load, observeMutationBatch, observeQueueLatency, persist};
};

export {
  MAX_RECORDS,
  RECORD_PREFIX,
  RECORD_SCHEMA,
  RECORD_VERSION,
  ROOT_SCHEMA,
  ROOT_VERSION,
  STORAGE_KEY,
  createOwnershipPersistence,
  idFromRecordKey,
  recordKey,
  validateMarker
};
