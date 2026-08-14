import {normalizeTitleMarker} from '../../../worker/core/marker-title.mjs';
import {PLUGIN_KEYS} from '../../../worker/core/plugin-catalog.mjs';
import {
  LEGACY_DUMMY_PLUGIN_KEY,
  migrateToolbarClick,
  TOOLBAR_CLICK_VALUES
} from '../../../worker/core/preference-migrations.mjs';
import {
  assertOwned,
  createSettingsImportTransaction,
  finalizeOwned,
  recoverSettingsImport,
  SETTINGS_IMPORT_FENCE_KEY,
  SETTINGS_IMPORT_PHASES,
  SETTINGS_IMPORT_TRANSACTION_KEY,
  transitionOwned,
  userStorageSnapshot,
  withSettingsImportLock
} from '../../../worker/core/settings-import-transaction.mjs';

const MAX_BACKUP_BYTES = 1024 * 1024;
const SETTINGS_BACKUP_FORMAT = 'auto-tab-discard-settings';
const SETTINGS_BACKUP_VERSION = 1;
const RAW_BACKUP_LABEL = 'RAW SETTINGS BACKUP - may contain site rules';

const BOOLEAN_KEYS = Object.freeze([
  'audio',
  'paused',
  'pinned',
  'split-view',
  'form',
  'battery',
  'online',
  'notification.permission',
  'page.context',
  'tab.context',
  'link.context',
  'log',
  'faqs',
  'badge',
  'favicon',
  'discard-protected-on-close',
  'go-hidden',
  'lifecycle-feedback',
  'memory-enabled',
  'idle',
  'startup-unpinned',
  'startup-pinned',
  'startup-release-pinned',
  'use-cache',
  'trash.enabled',
  'trash.unloaded',
  'release-next-tab',
  ...PLUGIN_KEYS
]);

const NUMBER_RANGES = Object.freeze({
  'period': [0, 31_536_000],
  'number': [0, 100_000],
  'max.single.discard': [1, 10_000],
  'trash.period': [1, 87_600],
  'trash.interval': [1, 1_440],
  'memory-value': [10, 1_000_000],
  'favicon-delay': [0, 60_000],
  'simultaneous-jobs': [1, 1_000],
  'idle-timeout': [1, 2_592_000],
  'startup-discarding-period': [0, 86_400]
});

const RULE_LIST_KEYS = Object.freeze([
  'whitelist',
  'whitelist-url',
  'trash.whitelist-url',
  'force.hostnames'
]);

const RULE_FORMATS = Object.freeze({
  'force.hostnames': 'plain',
  'trash.whitelist-url': 'trash',
  'whitelist': 'standard',
  'whitelist-url': 'standard'
});
const EXTERNAL_TRUSTED_IDS_KEY = 'external.trusted-ids';
const EXTERNAL_TRUST_LIMIT = 32;
const EXTERNAL_ID_LIMIT = 255;

const CLICK_VALUES = TOOLBAR_CLICK_VALUES;

const TRANSIENT_KEYS = new Set([
  '__discardOwnership',
  '__blankHelperRegistry',
  'trash.keys',
  'last-update',
  'tmp_disable',
  'whitelist.session',
  'exclude-active',
  'icon-update',
  'period-url'
]);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const FORMAT_KEYS = new Set(['format', 'version', 'label', 'exportedAt', 'settings']);
const LEGACY_KEYS = new Set(['chrome.storage.local', 'localStorage']);
const LEGACY_LOCAL_KEYS = new Set(['click', 'explore-count']);
class SettingsBackupError extends Error {
  constructor(code, path, message) {
    super(`${path}: ${message}`);
    this.name = 'SettingsBackupError';
    this.code = code;
    this.path = path;
  }
}

const fail = (code, path, message) => {
  throw new SettingsBackupError(code, path, message);
};

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObjectRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const assertSafeObjectGraph = (root, rootPath = '$') => {
  const pending = [{depth: 0, path: rootPath, value: root}];
  let nodes = 0;
  while (pending.length) {
    const {depth, path, value} = pending.pop();
    nodes += 1;
    if (nodes > 100_000) {
      fail('structure-limit', path, 'contains too many values');
    }
    if (depth > 32) {
      fail('structure-limit', path, 'is nested too deeply');
    }
    if (value === null || typeof value !== 'object') {
      continue;
    }
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value) === false && prototype !== Object.prototype && prototype !== null) {
      fail('unsafe-object', path, 'must be a plain object');
    }
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key)) {
        fail('prototype-pollution', `${path}.${key}`, 'dangerous object key is not allowed');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || 'value' in descriptor === false) {
        fail('unsafe-object', `${path}.${key}`, 'accessor properties are not allowed');
      }
      pending.push({depth: depth + 1, path: `${path}.${key}`, value: descriptor.value});
    }
  }
  return root;
};

const byteLength = text => new TextEncoder().encode(text).byteLength;
const assertBackupSize = (text, maxBytes = MAX_BACKUP_BYTES) => {
  if (typeof text !== 'string') {
    fail('invalid-text', '$', 'backup must be UTF-8 text');
  }
  const bytes = byteLength(text);
  if (bytes > maxBytes) {
    fail('size-limit', '$', `backup is ${bytes} bytes; maximum is ${maxBytes}`);
  }
  return bytes;
};

const assertExactKeys = (record, allowed, path) => {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      fail('unknown-key', `${path}.${key}`, 'unknown key is not allowed');
    }
  }
};

const validateRuleHookResult = (result, key) => {
  if (result?.then) {
    fail('rule-validator', `$.settings.${key}`, 'rule validator must be synchronous');
  }
  if (result === false || result?.valid === false || result?.ok === false) {
    const rejected = result?.rejected?.[0];
    const reason = result?.reason || result?.error || rejected?.reason ||
      result?.errors?.[0]?.reason || result?.errors?.[0]?.message || 'rule validation failed';
    const entry = Number.isInteger(rejected?.index) ? `[${rejected.index}]` : '';
    fail('invalid-rule', `$.settings.${key}${entry}`, String(reason));
  }
  if (Array.isArray(result?.errors) && result.errors.length) {
    const reason = result.errors[0]?.reason || result.errors[0]?.message || result.errors[0];
    fail('invalid-rule', `$.settings.${key}`, String(reason));
  }
};

const validateRuleListHook = (key, values, validateRules) => {
  if (typeof validateRules !== 'function') {
    return;
  }
  let result;
  try {
    result = validateRules(values, {format: RULE_FORMATS[key], key});
  }
  catch (error) {
    fail('invalid-rule', `$.settings.${key}`, error?.message || String(error));
  }
  validateRuleHookResult(result, key);
};

const validateStringList = (value, key, validateRules) => {
  const path = `$.settings.${key}`;
  if (!Array.isArray(value)) {
    fail('invalid-type', path, 'must be an array');
  }
  if (value.length > 1_000) {
    fail('range', path, 'must contain no more than 1000 entries');
  }
  const output = value.map((entry, index) => {
    if (typeof entry !== 'string') {
      fail('invalid-type', `${path}[${index}]`, 'must be a string');
    }
    if (entry.length === 0 || entry.length > 4_096) {
      fail('range', `${path}[${index}]`, 'must contain 1 to 4096 characters');
    }
    return entry;
  });
  validateRuleListHook(key, output, validateRules);
  return output;
};

const validateExternalTrustedIds = value => {
  const path = `$.settings.${EXTERNAL_TRUSTED_IDS_KEY}`;
  if (!Array.isArray(value)) {
    fail('invalid-type', path, 'must be an array');
  }
  if (value.length > EXTERNAL_TRUST_LIMIT) {
    fail('range', path, `must contain no more than ${EXTERNAL_TRUST_LIMIT} extension IDs`);
  }
  const seen = new Set();
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > EXTERNAL_ID_LIMIT ||
        /[\x00-\x20\x7f]/.test(entry)) {
      fail('invalid-type', `${path}[${index}]`, 'must be a bounded extension ID without whitespace');
    }
    if (seen.has(entry)) {
      fail('duplicate', `${path}[${index}]`, 'must be unique');
    }
    seen.add(entry);
    return entry;
  });
};

const validateSettingsRecord = (record, {validateRules} = {}) => {
  if (!isObjectRecord(record)) {
    fail('invalid-type', '$.settings', 'must be an object');
  }
  assertSafeObjectGraph(record, '$.settings');
  const output = {};
  for (const key of Object.keys(record)) {
    if (TRANSIENT_KEYS.has(key) || key.startsWith('__')) {
      continue;
    }
    const value = record[key];
    if (key === LEGACY_DUMMY_PLUGIN_KEY) {
      if (typeof value !== 'boolean') {
        fail('invalid-type', `$.settings.${key}`, 'deprecated plugin value must be a boolean');
      }
      // V3 never shipped an implementation for this advertised V2 plugin.
      // Accept old backups, but deliberately drop the inert preference.
      continue;
    }
    if (BOOLEAN_KEYS.includes(key)) {
      if (typeof value !== 'boolean') {
        fail('invalid-type', `$.settings.${key}`, 'must be a boolean');
      }
      output[key] = value;
    }
    else if (hasOwn(NUMBER_RANGES, key)) {
      const [minimum, maximum] = NUMBER_RANGES[key];
      if (typeof value !== 'number' || Number.isFinite(value) === false || Number.isInteger(value) === false) {
        fail('invalid-type', `$.settings.${key}`, 'must be a finite integer');
      }
      if (value < minimum || value > maximum) {
        fail('range', `$.settings.${key}`, `must be between ${minimum} and ${maximum}`);
      }
      output[key] = value;
    }
    else if (RULE_LIST_KEYS.includes(key)) {
      output[key] = validateStringList(value, key, validateRules);
    }
    else if (key === EXTERNAL_TRUSTED_IDS_KEY) {
      output[key] = validateExternalTrustedIds(value);
    }
    else if (key === 'mode') {
      if (!['time-based', 'url-based'].includes(value)) {
        fail('enum', '$.settings.mode', 'must be time-based or url-based');
      }
      output[key] = value;
    }
    else if (key === 'click') {
      const candidate = migrateToolbarClick(value);
      if (!CLICK_VALUES.includes(candidate)) {
        fail('enum', '$.settings.click', 'unknown toolbar action');
      }
      output[key] = candidate;
    }
    else if (key === 'prepends') {
      if (typeof value !== 'string') {
        fail('invalid-type', '$.settings.prepends', 'must be a string');
      }
      output[key] = normalizeTitleMarker(value);
    }
    else if (key.startsWith('./plugins/')) {
      fail('unknown-plugin', `$.settings.${key}`, 'unknown plugin key is not allowed');
    }
    else {
      fail('unknown-key', `$.settings.${key}`, 'unknown setting is not allowed');
    }
  }

  // Migrate historical booleans only when their current plug-in key is absent.
  if (hasOwn(output, 'trash.enabled') && !hasOwn(output, './plugins/trash/core.js')) {
    output['./plugins/trash/core.js'] = output['trash.enabled'];
  }
  if (hasOwn(output, 'release-next-tab') && !hasOwn(output, './plugins/next/core.js')) {
    output['./plugins/next/core.js'] = output['release-next-tab'];
  }
  delete output['trash.enabled'];
  delete output['release-next-tab'];
  return output;
};

const normalizeLegacyLocalStorage = (record, settings) => {
  if (record === undefined) {
    return;
  }
  if (!isObjectRecord(record)) {
    fail('invalid-type', '$.localStorage', 'must be an object');
  }
  assertExactKeys(record, LEGACY_LOCAL_KEYS, '$.localStorage');
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string') {
      fail('invalid-type', `$.localStorage.${key}`, 'must be a string');
    }
  }
  if (!hasOwn(settings, 'click') && typeof record.click === 'string') {
    const candidate = migrateToolbarClick(record.click);
    if (!CLICK_VALUES.includes(candidate)) {
      fail('enum', '$.localStorage.click', 'unknown historical toolbar action');
    }
    settings.click = candidate;
  }
  if (hasOwn(record, 'explore-count')) {
    const count = Number(record['explore-count']);
    if (!Number.isInteger(count) || count < 0 || count > 9_999_999 || String(count) !== record['explore-count']) {
      fail('range', '$.localStorage.explore-count', 'must be a canonical non-negative integer string');
    }
  }
};

const createDocument = (settings, exportedAt = new Date().toISOString()) => ({
  format: SETTINGS_BACKUP_FORMAT,
  version: SETTINGS_BACKUP_VERSION,
  label: RAW_BACKUP_LABEL,
  exportedAt,
  settings
});

const parseSettingsBackup = (text, {validateRules} = {}) => {
  assertBackupSize(text);
  let parsed;
  try {
    parsed = JSON.parse(text);
  }
  catch (error) {
    fail('invalid-json', '$', `cannot parse JSON (${error?.message || String(error)})`);
  }
  assertSafeObjectGraph(parsed);
  if (!isObjectRecord(parsed)) {
    fail('invalid-type', '$', 'backup root must be an object');
  }

  const legacy = hasOwn(parsed, 'chrome.storage.local') || hasOwn(parsed, 'localStorage');
  if (legacy) {
    assertExactKeys(parsed, LEGACY_KEYS, '$');
    if (!hasOwn(parsed, 'chrome.storage.local') || !isObjectRecord(parsed['chrome.storage.local'])) {
      fail('invalid-type', '$.chrome.storage.local', 'legacy backup must contain a settings object');
    }
    const settings = {};
    for (const key of Object.keys(parsed['chrome.storage.local'])) {
      settings[key] = parsed['chrome.storage.local'][key];
    }
    normalizeLegacyLocalStorage(parsed.localStorage, settings);
    const normalized = validateSettingsRecord(settings, {validateRules});
    return {
      document: createDocument(normalized),
      migratedFrom: 'legacy-v0'
    };
  }

  assertExactKeys(parsed, FORMAT_KEYS, '$');
  if (parsed.format !== SETTINGS_BACKUP_FORMAT) {
    fail('format', '$.format', `must equal ${SETTINGS_BACKUP_FORMAT}`);
  }
  if (parsed.version !== SETTINGS_BACKUP_VERSION) {
    fail('version', '$.version', `unsupported backup version ${String(parsed.version)}`);
  }
  if (parsed.label !== RAW_BACKUP_LABEL) {
    fail('label', '$.label', 'raw backup safety label is missing or altered');
  }
  if (typeof parsed.exportedAt !== 'string' || Number.isNaN(Date.parse(parsed.exportedAt)) ||
      new Date(parsed.exportedAt).toISOString() !== parsed.exportedAt) {
    fail('invalid-type', '$.exportedAt', 'must be a canonical ISO date string');
  }
  return {
    document: createDocument(validateSettingsRecord(parsed.settings, {validateRules}), parsed.exportedAt),
    migratedFrom: undefined
  };
};

const createRawSettingsBackup = (stored, {now = () => new Date(), validateRules} = {}) => {
  const exportedAt = now();
  if (!(exportedAt instanceof Date) || Number.isNaN(exportedAt.getTime())) {
    fail('invalid-date', '$.exportedAt', 'export clock returned an invalid date');
  }
  return createDocument(validateSettingsRecord(stored, {validateRules}), exportedAt.toISOString());
};

const serializeRawSettingsBackup = (stored, options) => {
  const text = `${JSON.stringify(createRawSettingsBackup(stored, options), null, 2)}\n`;
  assertBackupSize(text);
  return text;
};

class SettingsImportTransactionError extends Error {
  constructor(cause, rollbackErrors = []) {
    const rollback = rollbackErrors.length ?
      `; rollback also failed: ${rollbackErrors.map(error => error?.message || String(error)).join('; ')}` : '';
    super(`settings import failed: ${cause?.message || String(cause)}${rollback}`);
    this.name = 'SettingsImportTransactionError';
    this.cause = cause;
    this.rollbackErrors = rollbackErrors;
  }
}

const stableGraphText = value => {
  if (Array.isArray(value)) {
    return `[${value.map(stableGraphText).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${stableGraphText(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const verifyCommittedImport = async (normalized, adapter, marker) => {
  if (marker) {
    await assertOwned(adapter, marker);
  }
  const storage = userStorageSnapshot(await adapter.readStorage());
  const local = await adapter.readLocalStorage();
  if (stableGraphText(storage) !== stableGraphText(normalized) ||
      stableGraphText(local) !== stableGraphText({})) {
    throw Error('committed settings import failed final state verification');
  }
  if (marker) {
    await assertOwned(adapter, marker);
  }
};

const commitSettingsImportUnlocked = async (settings, adapter, {
  checkpoint = async () => {},
  now = Date.now,
  transactionId,
  validateRules
} = {}) => {
  // Validate again at the transaction boundary so no independent caller can
  // mutate storage with an unrecognized or mistyped record.
  const normalized = validateSettingsRecord(settings, {validateRules});
  // An Options restart is the only context that can restore both extension
  // storage and historical DOM localStorage. Finish that recovery before a new
  // transaction takes its snapshots.
  await recoverSettingsImport(adapter, {lockHeld: true});
  const storageSnapshot = await adapter.readStorage();
  const localStorageSnapshot = await adapter.readLocalStorage();
  assertSafeObjectGraph(storageSnapshot, '$.snapshot.storage');
  assertSafeObjectGraph(localStorageSnapshot, '$.snapshot.localStorage');

  const beforeStorage = userStorageSnapshot(storageSnapshot);
  let marker = createSettingsImportTransaction({
    afterStorage: normalized,
    beforeLocalStorage: localStorageSnapshot,
    beforeStorage,
    id: transactionId,
    now
  });
  const setMarker = async phase => {
    marker = await transitionOwned(adapter, marker, phase, now);
  };
  const owned = async mutation => {
    await assertOwned(adapter, marker);
    await mutation();
    await assertOwned(adapter, marker);
  };
  const removeObsoleteUserStorage = async () => {
    await assertOwned(adapter, marker);
    const current = userStorageSnapshot(await adapter.readStorage());
    await assertOwned(adapter, marker);
    const remove = Object.keys(current).filter(key => !hasOwn(normalized, key));
    if (remove.length) {
      await owned(() => adapter.removeStorage(remove));
    }
  };
  const reached = phase => checkpoint(phase, {marker});

  try {
    // Every destructive step has a durable intent record written first. The
    // marker is removed only after both stores have reached a recoverable final
    // state, so closing Options at any checkpoint cannot strand empty prefs.
    await adapter.writeStorage({
      [SETTINGS_IMPORT_FENCE_KEY]: marker.fence,
      [SETTINGS_IMPORT_TRANSACTION_KEY]: marker
    });
    await assertOwned(adapter, marker);
    await reached('prepared');

    await setMarker(SETTINGS_IMPORT_PHASES.STORAGE_WRITE_PENDING);
    await reached('storage-write-pending');
    await owned(() => adapter.writeStorage(normalized));
    await reached('storage-written');

    await setMarker(SETTINGS_IMPORT_PHASES.STORAGE_REMOVE_PENDING);
    await reached('storage-remove-pending');
    await removeObsoleteUserStorage();
    await reached('storage-removed');

    await setMarker(SETTINGS_IMPORT_PHASES.LOCAL_REPLACE_PENDING);
    await reached('local-replace-pending');
    await owned(() => adapter.replaceLocalStorage({}));
    await reached('local-replaced');

    await setMarker(SETTINGS_IMPORT_PHASES.COMMITTED);
    await reached('committed');
    // COMMITTED is an irreversible durable decision. Re-enforce and verify the
    // complete after-image before reporting success, then remove the sensitive
    // snapshot marker while the origin-wide lock still excludes every reader.
    await owned(() => adapter.writeStorage(normalized));
    await removeObsoleteUserStorage();
    await owned(() => adapter.replaceLocalStorage({}));
    await verifyCommittedImport(normalized, adapter, marker);
    await finalizeOwned(adapter, marker);
    await reached('finalized');
  }
  catch (cause) {
    const rollbackErrors = [];
    let recovery;
    try {
      recovery = await recoverSettingsImport(adapter, {
        expectedTransactionId: marker.id,
        lockHeld: true
      });
    }
    catch (error) {
      rollbackErrors.push(error);
    }
    // If recovery deterministically completed an already-committed import,
    // treat the exact verified after-image as success rather than asking the
    // user to retry an operation whose target state is now authoritative.
    if (rollbackErrors.length === 0 &&
        (recovery?.status === 'completed' ||
          (marker.phase === SETTINGS_IMPORT_PHASES.COMMITTED && recovery?.status === 'none'))) {
      try {
        await verifyCommittedImport(normalized, adapter);
        return {importedKeys: Object.keys(normalized).length, recovered: true};
      }
      catch (error) {
        rollbackErrors.push(error);
      }
    }
    throw new SettingsImportTransactionError(cause, rollbackErrors);
  }
  return {importedKeys: Object.keys(normalized).length};
};

const commitSettingsImport = async (settings, adapter, options = {}) => {
  // Reject malformed input before even consulting an adapter/lock capability.
  // This preserves the no-side-effects validation boundary for independent
  // callers and hostile backup documents.
  validateSettingsRecord(settings, {validateRules: options.validateRules});
  const lockManager = options.lockManager || adapter?.lockManager ||
    globalThis.navigator?.locks;
  if (options.lockHeld === true) {
    return commitSettingsImportUnlocked(settings, adapter, options);
  }
  return withSettingsImportLock(lockManager,
    () => commitSettingsImportUnlocked(settings, adapter, {...options, lockHeld: true}),
    {timeoutMs: options.lockTimeoutMs});
};

export {
  assertBackupSize,
  assertSafeObjectGraph,
  BOOLEAN_KEYS,
  CLICK_VALUES,
  commitSettingsImport,
  createRawSettingsBackup,
  MAX_BACKUP_BYTES,
  NUMBER_RANGES,
  parseSettingsBackup,
  PLUGIN_KEYS,
  RAW_BACKUP_LABEL,
  RULE_LIST_KEYS,
  serializeRawSettingsBackup,
  SETTINGS_BACKUP_FORMAT,
  SETTINGS_BACKUP_VERSION,
  SettingsBackupError,
  SettingsImportTransactionError,
  validateSettingsRecord
};
