const CONFLICT_SCAN_TIMEOUT = 3000;
const MAX_SCAN_ITEMS = 10_000;

const SIGNALS = Object.freeze({
  DUPLICATE_SELF_ENABLED: 'DUPLICATE_SELF_ENABLED',
  EXTERNAL_DISCARDER_ENABLED: 'EXTERNAL_DISCARDER_ENABLED',
  EXTERNAL_PLACEHOLDER_PRESENT: 'EXTERNAL_PLACEHOLDER_PRESENT',
  EXTERNAL_SLEEPERS_PRESENT: 'EXTERNAL_SLEEPERS_PRESENT',
  TAB_MANAGER_ENABLED: 'TAB_MANAGER_ENABLED'
});

const boundedCount = value => Math.min(MAX_SCAN_ITEMS,
  Math.max(0, Number.isSafeInteger(value) ? value : 0));
const plainObject = value => value !== null && typeof value === 'object' &&
  !Array.isArray(value);
const normalizeName = value => typeof value === 'string' ? value.toLowerCase()
  .replace(/\([^)]*\)/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim() : '';
const canonicalHomepage = value => {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, '').toLowerCase()}`;
  }
  catch (e) {
    return '';
  }
};
const extensionPlaceholder = value => {
  if (typeof value !== 'string' || value.length > 4096) return '';
  try {
    const url = new URL(value);
    const extensionPage = ['chrome-extension:', 'edge-extension:', 'moz-extension:']
      .includes(url.protocol);
    const placeholderPath = /(?:discard|hibernate|park|placeholder|restore|sleep|suspend|unload)/i
      .test(`${url.pathname}${url.hash}`);
    return extensionPage && placeholderPath ? url.hostname : '';
  }
  catch (e) {
    return '';
  }
};
const DISCARDS_TABS = /\b(?:auto\s+tab\s+discard|tab\s+(?:discard|suspend|suspender|sleep|sleeper|unload)|great\s+(?:tab\s+)?suspender|hibernate\s+tabs?|memory\s+saver)\b/i;
const MANAGES_TABS = /\b(?:tab\s+manager|session\s+(?:buddy|manager)|workona|onetab|tree\s+style\s+tab)\b/i;

const callApi = (target, method, args = [], {
  timeout = CONFLICT_SCAN_TIMEOUT,
  runtime = globalThis.chrome?.runtime
} = {}) => new Promise((resolve, reject) => {
  let settled = false;
  let timer;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    error ? reject(error) : resolve(value);
  };
  timer = setTimeout(() => finish(Object.assign(Error('conflict scan timed out'), {
    code: 'CONFLICT_SCAN_TIMEOUT'
  })), Math.max(1, Number(timeout) || CONFLICT_SCAN_TIMEOUT));
  try {
    const operation = target?.[method]?.(...args, value => {
      const error = runtime?.lastError;
      finish(error ? Object.assign(Error(error.message || String(error)), {
        code: 'CONFLICT_SCAN_REJECTED'
      }) : null, value);
    });
    if (operation?.then) {
      operation.then(value => finish(null, value), error => finish(error));
    }
    else if (typeof target?.[method] !== 'function') {
      finish(Object.assign(Error('conflict scan API is unavailable'), {
        code: 'CONFLICT_SCAN_UNAVAILABLE'
      }));
    }
  }
  catch (error) {
    finish(error);
  }
});

const withScanDeadline = (task, timeout) => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    error ? reject(error) : resolve(value);
  };
  const timer = setTimeout(() => finish(Object.assign(Error('conflict scan timed out'), {
    code: 'CONFLICT_SCAN_TIMEOUT'
  })), Math.max(1, Number(timeout) || CONFLICT_SCAN_TIMEOUT));
  Promise.resolve().then(task).then(value => finish(null, value), error => finish(error));
});

const ownershipSource = marker => marker?.state === 'owned' ? marker.source : undefined;
const sanitizedResult = ({
  discardedTabs,
  duplicateCopies,
  enabledExtensions,
  externalDiscarders,
  externalPlaceholders,
  externalSleepers,
  selfOwnedSleepers,
  tabManagers,
  unknownSleepers
}) => {
  const signals = [];
  if (duplicateCopies) signals.push(SIGNALS.DUPLICATE_SELF_ENABLED);
  if (externalDiscarders) signals.push(SIGNALS.EXTERNAL_DISCARDER_ENABLED);
  if (externalPlaceholders) signals.push(SIGNALS.EXTERNAL_PLACEHOLDER_PRESENT);
  if (externalSleepers) signals.push(SIGNALS.EXTERNAL_SLEEPERS_PRESENT);
  if (tabManagers) signals.push(SIGNALS.TAB_MANAGER_ENABLED);
  const confidence = duplicateCopies && (externalSleepers || externalPlaceholders) ? 'high' :
    (externalDiscarders && (externalSleepers || externalPlaceholders) ? 'medium' :
      (signals.length ? 'low' : 'none'));
  return Object.freeze({
    confidence,
    counts: Object.freeze({
      discardedTabs: boundedCount(discardedTabs),
      duplicateCopies: boundedCount(duplicateCopies),
      enabledExtensions: boundedCount(enabledExtensions),
      externalDiscarders: boundedCount(externalDiscarders),
      externalPlaceholders: boundedCount(externalPlaceholders),
      externalSleepers: boundedCount(externalSleepers),
      selfOwnedSleepers: boundedCount(selfOwnedSleepers),
      tabManagers: boundedCount(tabManagers),
      unknownSleepers: boundedCount(unknownSleepers)
    }),
    signals: Object.freeze(signals)
  });
};

const createConflictScanner = ({
  management = globalThis.chrome?.management,
  manifest = globalThis.chrome?.runtime?.getManifest?.() || {},
  ownership,
  runtime = globalThis.chrome?.runtime,
  tabs = globalThis.chrome?.tabs,
  timeout = CONFLICT_SCAN_TIMEOUT
} = {}) => ({
  async scan({privateContext = false} = {}) {
    if (typeof management?.getAll !== 'function' || typeof tabs?.query !== 'function' ||
        typeof ownership?.snapshot !== 'function') {
      const error = Error('extension conflict scan is unavailable');
      error.code = 'CONFLICT_SCAN_UNAVAILABLE';
      throw error;
    }
    const [installedValue, tabValue, ownershipValue] = await withScanDeadline(() => Promise.all([
      callApi(management, 'getAll', [], {runtime, timeout}),
      callApi(tabs, 'query', [{}], {runtime, timeout}),
      Promise.resolve().then(() => ownership.snapshot())
    ]), timeout);
    if (!Array.isArray(installedValue) || !Array.isArray(tabValue) || !plainObject(ownershipValue)) {
      const error = Error('extension conflict scan returned malformed data');
      error.code = 'CONFLICT_SCAN_MALFORMED';
      throw error;
    }
    const installed = installedValue.slice(0, MAX_SCAN_ITEMS);
    // In spanning mode tabs.query({}) returns both regular and private tabs.
    // The browser-owned Options context is threaded through the endpoint; an
    // absent/malformed tab privacy bit never crosses into either aggregate.
    const liveTabs = tabValue.slice(0, MAX_SCAN_ITEMS)
      .filter(tab => plainObject(tab) && tab.incognito === privateContext);
    const markers = ownershipValue;
    const selfId = typeof runtime?.id === 'string' ? runtime.id : '';
    const selfName = normalizeName(manifest?.name);
    const selfHomepage = canonicalHomepage(manifest?.homepage_url);
    const candidates = new Map();
    let duplicateCopies = 0;
    let enabledExtensions = 0;
    let externalDiscarders = 0;
    let tabManagers = 0;

    for (const info of installed) {
      if (!plainObject(info) || info.enabled !== true || info.type !== 'extension' ||
          typeof info.id !== 'string' || info.id.length > 256 || info.id === selfId) {
        continue;
      }
      enabledExtensions += 1;
      const text = [info.name, info.shortName, info.description]
        .filter(value => typeof value === 'string' && value.length <= 1024).join(' ');
      const name = normalizeName(info.name);
      const homepage = canonicalHomepage(info.homepageUrl);
      const duplicate = Boolean(selfName && name === selfName) ||
        Boolean(selfHomepage && homepage === selfHomepage);
      const discarder = duplicate || DISCARDS_TABS.test(text);
      const manager = MANAGES_TABS.test(text);
      if (duplicate) duplicateCopies += 1;
      if (discarder) externalDiscarders += 1;
      if (manager) tabManagers += 1;
      if (discarder || manager) {
        candidates.set(info.id, {discarder, manager});
      }
    }

    let discardedTabs = 0;
    let externalPlaceholders = 0;
    let externalSleepers = 0;
    let selfOwnedSleepers = 0;
    let unknownSleepers = 0;
    for (const tab of liveTabs) {
      if (!plainObject(tab)) continue;
      const placeholderOwner = extensionPlaceholder(tab.url);
      if (placeholderOwner && placeholderOwner !== selfId &&
          candidates.get(placeholderOwner)?.discarder === true) {
        externalPlaceholders += 1;
      }
      if (tab.discarded !== true || !Number.isInteger(tab.id)) continue;
      discardedTabs += 1;
      const source = ownershipSource(markers[tab.id]);
      if (source === 'self' || source === 'physical-only') {
        selfOwnedSleepers += 1;
      }
      else if (source === 'claimed') {
        externalSleepers += 1;
      }
      else {
        unknownSleepers += 1;
      }
    }
    return sanitizedResult({
      discardedTabs,
      duplicateCopies,
      enabledExtensions,
      externalDiscarders,
      externalPlaceholders,
      externalSleepers,
      selfOwnedSleepers,
      tabManagers,
      unknownSleepers
    });
  }
});

export {
  callApi,
  CONFLICT_SCAN_TIMEOUT,
  createConflictScanner,
  SIGNALS
};
