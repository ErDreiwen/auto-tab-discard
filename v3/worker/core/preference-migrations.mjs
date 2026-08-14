import {
  expandPluginPolicyKeys,
  PLUGIN_POLICY_ALIASES
} from './plugin-catalog.mjs';

const LEGACY_DUMMY_PLUGIN_KEY = './plugins/dummy/core.js';
const LEGACY_PLUGIN_PREFERENCE_KEYS = Object.freeze(Object.keys(PLUGIN_POLICY_ALIASES));
const LOCAL_PREFERENCE_MIGRATION_KEYS = Object.freeze([
  'click',
  LEGACY_DUMMY_PLUGIN_KEY,
  ...expandPluginPolicyKeys(LEGACY_PLUGIN_PREFERENCE_KEYS)
]);

const TOOLBAR_CLICK_VALUES = Object.freeze([
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

const LEGACY_CLICK_VALUES = Object.freeze({
  'click.discard': 'click.discard-tab',
  'discard': 'click.discard-tab'
});

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const migrateToolbarClick = value => {
  if (typeof value !== 'string') {
    return value;
  }
  const candidate = LEGACY_CLICK_VALUES[value] ||
    (value.startsWith('click.') ? value : `click.${value}`);
  return LEGACY_CLICK_VALUES[candidate] || candidate;
};

const normalizeToolbarClick = (value, fallback = 'click.popup') => {
  const candidate = migrateToolbarClick(value);
  return TOOLBAR_CLICK_VALUES.includes(candidate) ? candidate : fallback;
};

const normalizePreferenceRecord = (record, {fallbackClick = 'click.popup'} = {}) => {
  const normalized = record && typeof record === 'object' ? {...record} : {};
  delete normalized[LEGACY_DUMMY_PLUGIN_KEY];
  for (const [alias, canonical] of Object.entries(PLUGIN_POLICY_ALIASES)) {
    // The canonical key is the newer representation when both forms occur in
    // one layer. Aliases are normalized before layers are overlaid so a
    // managed legacy alias still overrides a canonical local preference.
    if (!hasOwn(normalized, canonical) && typeof normalized[alias] === 'boolean') {
      normalized[canonical] = normalized[alias];
    }
    delete normalized[alias];
  }
  if (hasOwn(normalized, 'click')) {
    normalized.click = normalizeToolbarClick(normalized.click, fallbackClick);
  }
  return normalized;
};

const overlayPreferenceLayers = (defaults, local, managed) => {
  const normalizedDefaults = normalizePreferenceRecord(defaults);
  const fallbackClick = normalizedDefaults.click || 'click.popup';
  return {
    ...normalizedDefaults,
    ...normalizePreferenceRecord(local, {fallbackClick}),
    ...normalizePreferenceRecord(managed, {fallbackClick})
  };
};

const planLocalPreferenceMigration = record => {
  const source = record && typeof record === 'object' ? record : {};
  const remove = [LEGACY_DUMMY_PLUGIN_KEY, ...LEGACY_PLUGIN_PREFERENCE_KEYS]
    .filter(key => hasOwn(source, key));
  const set = {};
  for (const [alias, canonical] of Object.entries(PLUGIN_POLICY_ALIASES)) {
    // Never let an old alias overwrite a canonical value already saved by a
    // newer build. Invalid legacy values are removed without being promoted.
    if (!hasOwn(source, canonical) && typeof source[alias] === 'boolean') {
      set[canonical] = source[alias];
    }
  }
  if (hasOwn(source, 'click')) {
    const click = normalizeToolbarClick(source.click, undefined);
    if (click !== undefined && click !== source.click) {
      set.click = click;
    }
  }
  return {remove, set};
};

export {
  LEGACY_DUMMY_PLUGIN_KEY,
  LEGACY_PLUGIN_PREFERENCE_KEYS,
  LOCAL_PREFERENCE_MIGRATION_KEYS,
  migrateToolbarClick,
  normalizePreferenceRecord,
  normalizeToolbarClick,
  overlayPreferenceLayers,
  planLocalPreferenceMigration,
  TOOLBAR_CLICK_VALUES
};
