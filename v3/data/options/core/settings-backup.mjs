import {normalizeTitleMarker} from '../../../worker/core/marker-title.mjs';

const MAX_BACKUP_BYTES = 1024 * 1024;
const SETTINGS_BACKUP_FORMAT = 'auto-tab-discard-settings';
const SETTINGS_BACKUP_VERSION = 1;
const RAW_BACKUP_LABEL = 'RAW SETTINGS BACKUP - may contain site rules';

const PLUGIN_KEYS = Object.freeze([
  './plugins/dummy/core.js',
  './plugins/blank/core.js',
  './plugins/focus/core.js',
  './plugins/trash/core.js',
  './plugins/force/core.js',
  './plugins/next/core.js',
  './plugins/previous/core.js',
  './plugins/new/core.js',
  './plugins/unloaded/core.js',
  './plugins/youtube/core.js'
]);

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

const CLICK_VALUES = Object.freeze([
  'click.popup',
  'click.discard-tab',
  'click.discard-tabs',
  'click.release-tabs',
  'click.discard-window',
  'click.release-window',
  'click.discard-other-windows',
  'click.release-other-windows',
  'click.toggle-allowed'
]);

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
const LEGACY_CLICK_VALUES = Object.freeze({
  'click.discard': 'click.discard-tab',
  discard: 'click.discard-tab'
});

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
    else if (key === 'mode') {
      if (!['time-based', 'url-based'].includes(value)) {
        fail('enum', '$.settings.mode', 'must be time-based or url-based');
      }
      output[key] = value;
    }
    else if (key === 'click') {
      const candidate = LEGACY_CLICK_VALUES[value] || value;
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
    let candidate = record.click.startsWith('click.') ? record.click : `click.${record.click}`;
    candidate = LEGACY_CLICK_VALUES[candidate] || candidate;
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

const commitSettingsImport = async (settings, adapter, {validateRules} = {}) => {
  // Validate again at the transaction boundary so no independent caller can
  // mutate storage with an unrecognized or mistyped record.
  const normalized = validateSettingsRecord(settings, {validateRules});
  const storageSnapshot = await adapter.readStorage();
  const localStorageSnapshot = await adapter.readLocalStorage();
  assertSafeObjectGraph(storageSnapshot, '$.snapshot.storage');
  assertSafeObjectGraph(localStorageSnapshot, '$.snapshot.localStorage');

  try {
    await adapter.clearStorage();
    await adapter.writeStorage(normalized);
    await adapter.replaceLocalStorage({});
  }
  catch (cause) {
    const rollbackErrors = [];
    try {
      await adapter.clearStorage();
      await adapter.writeStorage(storageSnapshot);
    }
    catch (error) {
      rollbackErrors.push(error);
    }
    try {
      await adapter.replaceLocalStorage(localStorageSnapshot);
    }
    catch (error) {
      rollbackErrors.push(error);
    }
    throw new SettingsImportTransactionError(cause, rollbackErrors);
  }
  return {importedKeys: Object.keys(normalized).length};
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
