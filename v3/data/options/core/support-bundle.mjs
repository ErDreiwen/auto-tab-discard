import {
  assertBackupSize,
  assertSafeObjectGraph,
  BOOLEAN_KEYS,
  CLICK_VALUES,
  NUMBER_RANGES
} from './settings-backup.mjs';

const SUPPORT_BUNDLE_FORMAT = 'auto-tab-discard-support';
const SUPPORT_BUNDLE_VERSION = 1;
const SUPPORT_BUNDLE_LABEL = 'SANITIZED SUPPORT BUNDLE - excludes browsing and site-rule data';

const SAFE_BOOLEAN_KEYS = Object.freeze(BOOLEAN_KEYS.filter(key =>
  key !== 'trash.enabled' && key !== 'release-next-tab'
));
const SAFE_NUMBER_KEYS = Object.freeze(Object.keys(NUMBER_RANGES));
const SAFE_SETTING_KEYS = new Set([
  ...SAFE_BOOLEAN_KEYS,
  ...SAFE_NUMBER_KEYS,
  'click',
  'mode'
]);

const safeVersion = value => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    return 'unknown';
  }
  return [...value].every(character =>
    '0123456789.-+abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.includes(character)
  ) ? value : 'unknown';
};

const browserFamily = userAgent => {
  const source = typeof userAgent === 'string' ? userAgent : '';
  if (source.includes('Edg/')) {
    return 'Edge';
  }
  if (source.includes('Firefox/')) {
    return 'Firefox';
  }
  if (source.includes('Chromium/') || source.includes('Chrome/')) {
    return 'Chromium';
  }
  return 'Other';
};

const safePreferences = stored => {
  assertSafeObjectGraph(stored, '$.stored');
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    return {omittedValueCount: 0, preferences: {}};
  }

  const preferences = {};
  for (const key of SAFE_BOOLEAN_KEYS) {
    if (typeof stored[key] === 'boolean') {
      preferences[key] = stored[key];
    }
  }
  for (const key of SAFE_NUMBER_KEYS) {
    const value = stored[key];
    const [minimum, maximum] = NUMBER_RANGES[key];
    if (Number.isInteger(value) && value >= minimum && value <= maximum) {
      preferences[key] = value;
    }
  }
  if (['time-based', 'url-based'].includes(stored.mode)) {
    preferences.mode = stored.mode;
  }
  if (CLICK_VALUES.includes(stored.click)) {
    preferences.click = stored.click;
  }

  return {
    omittedValueCount: Object.keys(stored).filter(key => SAFE_SETTING_KEYS.has(key) === false).length,
    preferences
  };
};

const createSupportBundle = (stored, {
  manifest = {},
  now = () => new Date(),
  userAgent = ''
} = {}) => {
  const generatedAt = now();
  if (!(generatedAt instanceof Date) || Number.isNaN(generatedAt.getTime())) {
    throw new TypeError('support bundle clock returned an invalid date');
  }
  const {omittedValueCount, preferences} = safePreferences(stored);
  return {
    format: SUPPORT_BUNDLE_FORMAT,
    version: SUPPORT_BUNDLE_VERSION,
    label: SUPPORT_BUNDLE_LABEL,
    generatedAt: generatedAt.toISOString(),
    extension: {
      manifestVersion: manifest.manifest_version === 2 || manifest.manifest_version === 3 ?
        manifest.manifest_version : 'unknown',
      version: safeVersion(manifest.version)
    },
    environment: {
      browserFamily: browserFamily(userAgent)
    },
    diagnostics: {
      omittedValueCount,
      preferences
    }
  };
};

const serializeSupportBundle = (stored, options) => {
  const text = `${JSON.stringify(createSupportBundle(stored, options), null, 2)}\n`;
  assertBackupSize(text);
  return text;
};

export {
  browserFamily,
  createSupportBundle,
  serializeSupportBundle,
  SUPPORT_BUNDLE_FORMAT,
  SUPPORT_BUNDLE_LABEL,
  SUPPORT_BUNDLE_VERSION
};
