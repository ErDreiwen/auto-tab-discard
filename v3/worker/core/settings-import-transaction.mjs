import {readStorageArea} from './storage-read.mjs';

const SETTINGS_IMPORT_TRANSACTION_KEY = '__settingsImportTransaction';
const SETTINGS_IMPORT_FENCE_KEY = '__settingsImportFence';
const SETTINGS_IMPORT_TRANSACTION_FORMAT = 'auto-tab-discard-settings-import';
const SETTINGS_IMPORT_TRANSACTION_VERSION = 2;
const SETTINGS_IMPORT_ACTIVE_GRACE = 2_000;
const SETTINGS_IMPORT_LOCK_NAME = 'auto-tab-discard:settings-import';
const SETTINGS_IMPORT_LOCK_TIMEOUT = 2_000;
const MAX_SETTINGS_IMPORT_TRANSACTION_BYTES = 4 * 1024 * 1024;

const SETTINGS_IMPORT_PHASES = Object.freeze({
  COMMITTED: 'committed',
  LOCAL_REPLACE_PENDING: 'local-replace-pending',
  LOCAL_ROLLBACK_PENDING: 'local-rollback-pending',
  PREPARED: 'prepared',
  ROLLED_BACK: 'rolled-back',
  STORAGE_REMOVE_PENDING: 'storage-remove-pending',
  STORAGE_WRITE_PENDING: 'storage-write-pending'
});

const PHASES = new Set(Object.values(SETTINGS_IMPORT_PHASES));
const LOCAL_MUTATION_POSSIBLE = new Set([
  SETTINGS_IMPORT_PHASES.LOCAL_REPLACE_PENDING,
  SETTINGS_IMPORT_PHASES.LOCAL_ROLLBACK_PENDING
]);
const MARKER_KEYS = new Set([
  'afterStorage',
  'beforeLocalStorage',
  'beforeStorage',
  'createdAt',
  'format',
  'fence',
  'id',
  'phase',
  'updatedAt',
  'version'
]);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_RECORD_KEYS = 4_096;
const MAX_GRAPH_DEPTH = 32;
const MAX_GRAPH_NODES = 100_000;
const MAX_KEY_LENGTH = 4_096;
const MAX_VALUE_STRING_LENGTH = 1024 * 1024;
const TRANSACTION_ID = /^[A-Za-z0-9._-]{1,128}$/;

class SettingsImportRecoveryError extends Error {
  constructor(code, path, message, cause) {
    super(`${path}: ${message}`, cause === undefined ? undefined : {cause});
    this.name = 'SettingsImportRecoveryError';
    this.code = code;
    this.path = path;
  }
}

class SettingsImportOwnershipError extends SettingsImportRecoveryError {
  constructor(message = 'settings import transaction ownership was lost') {
    super('ownership-lost', '$transaction', message);
    this.name = 'SettingsImportOwnershipError';
  }
}

const fail = (code, path, message, cause) => {
  throw new SettingsImportRecoveryError(code, path, message, cause);
};
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const assertRecord = (value, path) => {
  if (!isRecord(value)) {
    fail('invalid-marker', path, 'must be a plain object');
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_RECORD_KEYS) {
    fail('marker-limit', path, `contains more than ${MAX_RECORD_KEYS} keys`);
  }
  return keys;
};

const assertJsonGraph = (root, path) => {
  const pending = [{depth: 0, path, value: root}];
  let nodes = 0;
  while (pending.length) {
    const entry = pending.pop();
    nodes += 1;
    if (nodes > MAX_GRAPH_NODES) {
      fail('marker-limit', entry.path, 'contains too many values');
    }
    if (entry.depth > MAX_GRAPH_DEPTH) {
      fail('marker-limit', entry.path, 'is nested too deeply');
    }

    const value = entry.value;
    if (value === null || typeof value === 'boolean') {
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        fail('invalid-marker', entry.path, 'contains a non-finite number');
      }
      continue;
    }
    if (typeof value === 'string') {
      if (value.length > MAX_VALUE_STRING_LENGTH) {
        fail('marker-limit', entry.path, 'contains an oversized string');
      }
      continue;
    }
    if (typeof value !== 'object') {
      fail('invalid-marker', entry.path, `contains unsupported ${typeof value} data`);
    }

    if (Array.isArray(value)) {
      if (value.length > MAX_RECORD_KEYS) {
        fail('marker-limit', entry.path, 'contains an oversized array');
      }
      for (let index = value.length - 1; index >= 0; index -= 1) {
        if (!hasOwn(value, index)) {
          fail('invalid-marker', `${entry.path}[${index}]`, 'sparse arrays are not allowed');
        }
        pending.push({depth: entry.depth + 1, path: `${entry.path}[${index}]`, value: value[index]});
      }
      continue;
    }

    const keys = assertRecord(value, entry.path);
    for (const key of keys) {
      if (DANGEROUS_KEYS.has(key)) {
        fail('invalid-marker', `${entry.path}.${key}`, 'dangerous object key is not allowed');
      }
      if (key.length > MAX_KEY_LENGTH) {
        fail('marker-limit', entry.path, 'contains an oversized key');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !hasOwn(descriptor, 'value')) {
        fail('invalid-marker', `${entry.path}.${key}`, 'accessor properties are not allowed');
      }
      pending.push({
        depth: entry.depth + 1,
        path: `${entry.path}.${key}`,
        value: descriptor.value
      });
    }
  }
  return root;
};

const cloneJson = (value, path) => {
  try {
    return JSON.parse(JSON.stringify(value));
  }
  catch (error) {
    fail('invalid-marker', path, 'cannot be serialized safely', error);
  }
};

const markerBytes = marker => {
  let text;
  try {
    text = JSON.stringify(marker);
  }
  catch (error) {
    fail('invalid-marker', '$transaction', 'cannot be serialized safely', error);
  }
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_SETTINGS_IMPORT_TRANSACTION_BYTES) {
    fail('marker-limit', '$transaction',
      `is ${bytes} bytes; maximum is ${MAX_SETTINGS_IMPORT_TRANSACTION_BYTES}`);
  }
  return bytes;
};

const validateStorageSnapshot = (value, path) => {
  const keys = assertRecord(value, path);
  for (const key of keys) {
    if (key.startsWith('__')) {
      fail('invalid-marker', `${path}.${key}`, 'reserved internal keys are not transaction data');
    }
  }
  assertJsonGraph(value, path);
  return cloneJson(value, path);
};

const validateLocalStorageSnapshot = (value, path) => {
  const keys = assertRecord(value, path);
  for (const key of keys) {
    if (key.length > MAX_KEY_LENGTH || typeof value[key] !== 'string' ||
        value[key].length > MAX_VALUE_STRING_LENGTH) {
      fail('invalid-marker', `${path}.${key}`, 'localStorage entries must be bounded strings');
    }
  }
  return cloneJson(value, path);
};

const timestampFrom = now => {
  const value = typeof now === 'function' ? now() : now;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('invalid-clock', '$transaction.updatedAt', 'clock must return a nonnegative safe integer');
  }
  return value;
};

const randomToken = now => globalThis.crypto?.randomUUID?.() ||
  `${timestampFrom(now).toString(36)}-${Math.random().toString(36).slice(2, 14)}`;

const assertSettingsImportTransaction = raw => {
  const keys = assertRecord(raw, '$transaction');
  if (keys.length !== MARKER_KEYS.size || keys.some(key => !MARKER_KEYS.has(key))) {
    fail('invalid-marker', '$transaction', 'contains missing or unknown fields');
  }
  if (raw.format !== SETTINGS_IMPORT_TRANSACTION_FORMAT ||
      raw.version !== SETTINGS_IMPORT_TRANSACTION_VERSION) {
    fail('invalid-marker', '$transaction', 'format or version is not supported');
  }
  if (typeof raw.id !== 'string' || !TRANSACTION_ID.test(raw.id)) {
    fail('invalid-marker', '$transaction.id', 'must be a bounded transaction identifier');
  }
  if (typeof raw.fence !== 'string' || !TRANSACTION_ID.test(raw.fence)) {
    fail('invalid-marker', '$transaction.fence', 'must be a bounded fencing token');
  }
  if (!PHASES.has(raw.phase)) {
    fail('invalid-marker', '$transaction.phase', 'is not a recognized phase');
  }
  if (!Number.isSafeInteger(raw.createdAt) || raw.createdAt < 0 ||
      !Number.isSafeInteger(raw.updatedAt) || raw.updatedAt < raw.createdAt) {
    fail('invalid-marker', '$transaction.updatedAt', 'timestamps are invalid');
  }

  const marker = {
    afterStorage: validateStorageSnapshot(raw.afterStorage, '$transaction.afterStorage'),
    beforeLocalStorage: validateLocalStorageSnapshot(
      raw.beforeLocalStorage,
      '$transaction.beforeLocalStorage'
    ),
    beforeStorage: validateStorageSnapshot(raw.beforeStorage, '$transaction.beforeStorage'),
    createdAt: raw.createdAt,
    fence: raw.fence,
    format: raw.format,
    id: raw.id,
    phase: raw.phase,
    updatedAt: raw.updatedAt,
    version: raw.version
  };
  markerBytes(marker);
  return marker;
};

const createSettingsImportTransaction = ({
  afterStorage,
  beforeLocalStorage,
  beforeStorage,
  id,
  fence,
  now = Date.now
}) => {
  const timestamp = timestampFrom(now);
  const transactionId = id || randomToken(timestamp);
  return assertSettingsImportTransaction({
    afterStorage,
    beforeLocalStorage,
    beforeStorage,
    createdAt: timestamp,
    fence: fence || randomToken(timestamp),
    format: SETTINGS_IMPORT_TRANSACTION_FORMAT,
    id: transactionId,
    phase: SETTINGS_IMPORT_PHASES.PREPARED,
    updatedAt: timestamp,
    version: SETTINGS_IMPORT_TRANSACTION_VERSION
  });
};

const settingsImportTransactionPhase = (raw, phase, now = Date.now) => {
  const marker = assertSettingsImportTransaction(raw);
  if (!PHASES.has(phase)) {
    fail('invalid-marker', '$transaction.phase', 'is not a recognized phase');
  }
  return assertSettingsImportTransaction({
    ...marker,
    phase,
    updatedAt: Math.max(marker.updatedAt, timestampFrom(now))
  });
};

const userStorageSnapshot = value => {
  const keys = assertRecord(value, '$storage');
  const entries = [];
  for (const key of keys) {
    if (!key.startsWith('__')) {
      entries.push([key, value[key]]);
    }
  }
  return validateStorageSnapshot(Object.fromEntries(entries), '$storage.user');
};

const readTransactionState = async adapter => {
  let stored;
  try {
    stored = typeof adapter?.readTransaction === 'function' ?
      await adapter.readTransaction() : await adapter.readStorage();
  }
  catch (error) {
    fail('storage-error', '$transaction',
      `cannot read the transaction marker (${error?.message || String(error)})`, error);
  }
  if (!isRecord(stored)) {
    fail('storage-error', '$transaction', 'transaction storage returned malformed data');
  }
  const fence = stored[SETTINGS_IMPORT_FENCE_KEY];
  if (fence !== undefined && (typeof fence !== 'string' || !TRANSACTION_ID.test(fence))) {
    fail('invalid-marker', `$transaction.${SETTINGS_IMPORT_FENCE_KEY}`,
      'stored fencing token is invalid');
  }
  if (!hasOwn(stored, SETTINGS_IMPORT_TRANSACTION_KEY)) {
    return {fence, marker: undefined};
  }
  const marker = assertSettingsImportTransaction(stored[SETTINGS_IMPORT_TRANSACTION_KEY]);
  return {fence, marker};
};

const markerText = marker => JSON.stringify(assertSettingsImportTransaction(marker));
const sameMarker = (left, right) => Boolean(left && right) && markerText(left) === markerText(right);
const stableJson = value => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const assertOwned = async (adapter, expected) => {
  const {fence, marker} = await readTransactionState(adapter);
  if (fence !== expected.fence || !sameMarker(marker, expected)) {
    throw new SettingsImportOwnershipError();
  }
  return marker;
};

const writeClaim = async (adapter, marker) => {
  const claimed = assertSettingsImportTransaction(marker);
  await adapter.writeStorage({
    [SETTINGS_IMPORT_FENCE_KEY]: claimed.fence,
    [SETTINGS_IMPORT_TRANSACTION_KEY]: claimed
  });
  await assertOwned(adapter, claimed);
  return claimed;
};

const transitionOwned = async (adapter, marker, phase, now) => {
  await assertOwned(adapter, marker);
  const next = settingsImportTransactionPhase(marker, phase, now);
  await adapter.writeStorage({[SETTINGS_IMPORT_TRANSACTION_KEY]: next});
  await assertOwned(adapter, next);
  return next;
};

const mutateOwned = async (adapter, marker, mutation) => {
  await assertOwned(adapter, marker);
  await mutation();
  await assertOwned(adapter, marker);
};

const finalizeOwned = async (adapter, marker) => {
  await assertOwned(adapter, marker);
  await adapter.removeStorage([
    SETTINGS_IMPORT_FENCE_KEY,
    SETTINGS_IMPORT_TRANSACTION_KEY
  ]);
  const state = await readTransactionState(adapter);
  if (state.marker !== undefined || state.fence !== undefined) {
    throw new SettingsImportOwnershipError('settings import finalization was superseded');
  }
};

const replaceUserStorage = async (adapter, desired, marker, owned = async task => task()) => {
  const replacement = validateStorageSnapshot(desired, '$transaction.replacement');
  if (Object.keys(replacement).length) {
    await owned(() => adapter.writeStorage(replacement));
  }
  if (typeof adapter?.readStorage !== 'function') {
    fail('storage-error', '$transaction', 'recovery adapter cannot inspect extension storage');
  }
  const current = userStorageSnapshot(await adapter.readStorage());
  const remove = Object.keys(current).filter(key => !hasOwn(replacement, key));
  if (remove.length) {
    await owned(() => adapter.removeStorage(remove));
  }
};

const verifyRecoveryState = async (adapter, desired, localDesired, marker) => {
  if (typeof adapter?.readStorage !== 'function') {
    fail('storage-error', '$transaction', 'recovery adapter cannot verify extension storage');
  }
  await assertOwned(adapter, marker);
  const actual = userStorageSnapshot(await adapter.readStorage());
  if (stableJson(actual) !== stableJson(desired)) {
    fail('storage-error', '$transaction', 'recovered extension storage failed verification');
  }
  if (localDesired !== undefined) {
    if (typeof adapter?.readLocalStorage !== 'function') {
      fail('storage-error', '$transaction', 'recovery adapter cannot verify localStorage');
    }
    const local = validateLocalStorageSnapshot(
      await adapter.readLocalStorage(),
      '$transaction.localStorageVerification'
    );
    if (stableJson(local) !== stableJson(localDesired)) {
      fail('storage-error', '$transaction', 'recovered localStorage failed verification');
    }
  }
  await assertOwned(adapter, marker);
};

const withSettingsImportLock = async (lockManager, task, {
  timeoutMs = SETTINGS_IMPORT_LOCK_TIMEOUT
} = {}) => {
  if (typeof lockManager?.request !== 'function' || typeof AbortController !== 'function') {
    fail('lock-unavailable', '$transaction.lock',
      'the browser settings-import lock is unavailable');
  }
  const controller = new AbortController();
  let acquired = false;
  const timeout = Math.max(1, Number(timeoutMs) || SETTINGS_IMPORT_LOCK_TIMEOUT);
  const timer = setTimeout(() => {
    if (!acquired) {
      controller.abort();
    }
  }, timeout);
  try {
    return await lockManager.request(SETTINGS_IMPORT_LOCK_NAME, {
      mode: 'exclusive',
      signal: controller.signal
    }, async lock => {
      if (controller.signal.aborted) {
        fail('lock-timeout', '$transaction.lock',
          'an aborted lock request must not enter its critical section');
      }
      if (!lock) {
        fail('lock-unavailable', '$transaction.lock', 'exclusive lock was not granted');
      }
      acquired = true;
      clearTimeout(timer);
      return task();
    });
  }
  catch (error) {
    if (!acquired && controller.signal.aborted) {
      const timeoutError = new SettingsImportRecoveryError(
        'lock-timeout',
        '$transaction.lock',
        `exclusive lock was not acquired within ${timeout} ms`,
        error
      );
      timeoutError.retryable = true;
      throw timeoutError;
    }
    throw error;
  }
  finally {
    clearTimeout(timer);
  }
};

const recoverSettingsImportUnlocked = async (adapter, {
  activeGrace = SETTINGS_IMPORT_ACTIVE_GRACE,
  exclusive = false,
  expectedTransactionId,
  now = Date.now,
  respectActiveGrace = false,
  storageOnly = typeof adapter?.replaceLocalStorage !== 'function'
} = {}) => {
  let {fence, marker} = await readTransactionState(adapter);
  if (!marker) {
    if (fence !== undefined) {
      await adapter.removeStorage([SETTINGS_IMPORT_FENCE_KEY]);
      ({fence, marker} = await readTransactionState(adapter));
      if (marker) {
        return recoverSettingsImportUnlocked(adapter, {
          activeGrace,
          exclusive,
          expectedTransactionId,
          now,
          respectActiveGrace,
          storageOnly
        });
      }
      if (fence !== undefined) {
        fail('storage-error', '$transaction', 'orphaned fencing token could not be removed');
      }
    }
    return Object.freeze({status: 'none'});
  }
  if (expectedTransactionId !== undefined && marker.id !== expectedTransactionId) {
    return Object.freeze({status: 'superseded'});
  }

  const timestamp = timestampFrom(now);
  if (!exclusive && respectActiveGrace && marker.phase !== SETTINGS_IMPORT_PHASES.COMMITTED &&
      marker.phase !== SETTINGS_IMPORT_PHASES.LOCAL_ROLLBACK_PENDING &&
      marker.phase !== SETTINGS_IMPORT_PHASES.ROLLED_BACK &&
      timestamp - marker.updatedAt < Math.max(0, Number(activeGrace) || 0)) {
    const error = new SettingsImportRecoveryError(
      'transaction-active',
      '$transaction',
      'settings import is still active; preferences remain unavailable'
    );
    error.retryable = true;
    throw error;
  }

  if (storageOnly && marker.phase === SETTINGS_IMPORT_PHASES.LOCAL_ROLLBACK_PENDING &&
      fence === marker.fence) {
    await assertOwned(adapter, marker);
    const actual = userStorageSnapshot(await adapter.readStorage());
    await assertOwned(adapter, marker);
    if (stableJson(actual) === stableJson(marker.beforeStorage)) {
      return Object.freeze({pendingLocalStorage: true, status: 'rolled-back-storage'});
    }
  }

  const committed = marker.phase === SETTINGS_IMPORT_PHASES.COMMITTED;
  const alreadyRolledBack = marker.phase === SETTINGS_IMPORT_PHASES.ROLLED_BACK;
  const needsLocalRollback = LOCAL_MUTATION_POSSIBLE.has(marker.phase);
  const phase = committed ? SETTINGS_IMPORT_PHASES.COMMITTED :
    (alreadyRolledBack || (storageOnly && !needsLocalRollback) ?
      SETTINGS_IMPORT_PHASES.ROLLED_BACK : SETTINGS_IMPORT_PHASES.LOCAL_ROLLBACK_PENDING);
  marker = assertSettingsImportTransaction({
    ...marker,
    fence: randomToken(now),
    phase,
    updatedAt: Math.max(marker.updatedAt, timestampFrom(now))
  });
  await writeClaim(adapter, marker);

  const owned = mutation => mutateOwned(adapter, marker, mutation);
  await replaceUserStorage(
    adapter,
    committed ? marker.afterStorage : marker.beforeStorage,
    marker,
    owned
  );
  if (!storageOnly) {
    await owned(() => adapter.replaceLocalStorage(
      committed ? {} : marker.beforeLocalStorage
    ));
  }
  await verifyRecoveryState(
    adapter,
    committed ? marker.afterStorage : marker.beforeStorage,
    storageOnly ? undefined : (committed ? {} : marker.beforeLocalStorage),
    marker
  );
  if (committed) {
    await finalizeOwned(adapter, marker);
    return Object.freeze({status: 'completed'});
  }
  if (storageOnly && needsLocalRollback) {
    return Object.freeze({pendingLocalStorage: true, status: 'rolled-back-storage'});
  }
  if (phase !== SETTINGS_IMPORT_PHASES.ROLLED_BACK) {
    marker = await transitionOwned(
      adapter,
      marker,
      SETTINGS_IMPORT_PHASES.ROLLED_BACK,
      now
    );
  }
  await finalizeOwned(adapter, marker);
  return Object.freeze({status: 'rolled-back'});
};

const recoverSettingsImport = (adapter, options = {}) => {
  const lockManager = options.lockManager || adapter?.lockManager;
  if (options.lockHeld === true) {
    return recoverSettingsImportUnlocked(adapter, {...options, exclusive: true});
  }
  if (lockManager || options.requireLock === true || adapter?.requireLock === true) {
    return withSettingsImportLock(lockManager, () => recoverSettingsImportUnlocked(adapter, {
      ...options,
      exclusive: true
    }), {timeoutMs: options.lockTimeoutMs});
  }
  return recoverSettingsImportUnlocked(adapter, options);
};

const STORAGE_MUTATION_TIMEOUT = 2_000;
const callStorageMutation = (area, method, value, timeout = STORAGE_MUTATION_TIMEOUT) =>
  new Promise((resolve, reject) => {
    if (typeof area?.[method] !== 'function') {
      reject(Error(`storage.${method} is unavailable`));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => finish(reject, Error(`storage.${method} timed out`)), timeout);
    function finish(settle, result) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      settle(result);
    }
    try {
      const operation = area[method](value, result => {
        const error = globalThis.chrome?.runtime?.lastError;
        error ? finish(reject, Error(error.message || String(error))) : finish(resolve, result);
      });
      if (operation?.then) {
        operation.then(
          result => finish(resolve, result),
          error => finish(reject, error)
        );
      }
    }
    catch (error) {
      finish(reject, error);
    }
  });

const storageRecoveryFlights = new WeakMap();
const recoverSettingsImportStorage = (area, options = {}) => {
  const existing = storageRecoveryFlights.get(area);
  if (existing) {
    return existing;
  }
  const adapter = {
    readTransaction: () => readStorageArea(area, [
      SETTINGS_IMPORT_FENCE_KEY,
      SETTINGS_IMPORT_TRANSACTION_KEY
    ]),
    readStorage: () => readStorageArea(area, null),
    removeStorage: keys => callStorageMutation(area, 'remove', keys),
    writeStorage: values => callStorageMutation(area, 'set', values)
  };
  const operation = recoverSettingsImport(adapter, {
    ...options,
    lockManager: options.lockManager || globalThis.navigator?.locks,
    requireLock: true,
    respectActiveGrace: true,
    storageOnly: true
  }).finally(() => {
    if (storageRecoveryFlights.get(area) === operation) {
      storageRecoveryFlights.delete(area);
    }
  });
  storageRecoveryFlights.set(area, operation);
  return operation;
};

export {
  assertSettingsImportTransaction,
  createSettingsImportTransaction,
  MAX_SETTINGS_IMPORT_TRANSACTION_BYTES,
  recoverSettingsImport,
  recoverSettingsImportStorage,
  SETTINGS_IMPORT_ACTIVE_GRACE,
  SETTINGS_IMPORT_FENCE_KEY,
  SETTINGS_IMPORT_LOCK_NAME,
  SETTINGS_IMPORT_LOCK_TIMEOUT,
  SETTINGS_IMPORT_PHASES,
  SETTINGS_IMPORT_TRANSACTION_FORMAT,
  SETTINGS_IMPORT_TRANSACTION_KEY,
  SETTINGS_IMPORT_TRANSACTION_VERSION,
  SettingsImportOwnershipError,
  SettingsImportRecoveryError,
  settingsImportTransactionPhase,
  transitionOwned,
  assertOwned,
  finalizeOwned,
  userStorageSnapshot,
  withSettingsImportLock
};
