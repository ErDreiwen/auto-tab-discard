import {
  LOCAL_PREFERENCE_MIGRATION_KEYS,
  overlayPreferenceLayers,
  planLocalPreferenceMigration
} from './preference-migrations.mjs';
import {expandPluginPolicyKeys} from './plugin-catalog.mjs';
import {readStorageArea} from './storage-read.mjs';
import {
  recoverSettingsImportStorage,
  withSettingsImportLock
} from './settings-import-transaction.mjs';

const defaults = Object.freeze({
  'favicon': false,
  'prepends': '💤',
  'discard-protected-on-close': false,
  'number': 6,
  'period': 10 * 60, // in seconds
  'click': 'click.popup',
  'go-hidden': false,
  'page.context': false,
  'tab.context': true,
  'link.context': true,
  'whitelist': [], // whitelist hostnames and regexp rules
  'favicon-delay': /Firefox/.test(navigator.userAgent) ? 500 : 100,
  'log': false,
  'simultaneous-jobs': 10,
  'idle-timeout': 5 * 60, // in seconds
  'pinned': false, // pinned = true => do not discard if tab is pinned
  'split-view': true, // split-view = true => do not discard split tabs if either tab of the split is focused
  'startup-unpinned': false,
  'startup-pinned': false,
  'startup-release-pinned': false,
  'startup-discarding-period': 10 // in seconds
});

const prefs = {...defaults};

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const mutateArea = (area, method, value) => new Promise(resolve => {
  if (typeof area?.[method] !== 'function') {
    resolve(false);
    return;
  }
  try {
    area[method](value, () => resolve(!chrome.runtime.lastError));
  }
  catch (error) {
    resolve(false);
  }
});

const pick = (record, keys) => Object.fromEntries(
  keys.filter(key => hasOwn(record || {}, key)).map(key => [key, record[key]])
);

let migration;
const migrateLocalPreferences = () => {
  if (!migration) {
    migration = readStorageArea(chrome.storage.local, LOCAL_PREFERENCE_MIGRATION_KEYS).then(async stored => {
      const plan = planLocalPreferenceMigration(stored);
      let canonicalWriteSucceeded = true;
      if (Object.keys(plan.set).length) {
        canonicalWriteSucceeded = await mutateArea(chrome.storage.local, 'set', plan.set);
      }
      // Do not erase the only valid representation if promotion failed. A
      // failed removal is harmless and will be retried after the next worker
      // start because the canonical value already exists.
      if (canonicalWriteSucceeded && plan.remove.length) {
        await mutateArea(chrome.storage.local, 'remove', plan.remove);
      }
      return plan;
    }).catch(error => {
      // A later event may retry a transient read failure, but no caller may
      // continue with defaults while the authoritative local layer is unknown.
      migration = undefined;
      throw error;
    });
  }
  return migration;
};

const readPreferences = async (requested, type = 'managed') => {
  if (type === 'managed') {
    // Never expose a partially imported local layer. A fresh live transaction
    // fails closed; a stale/restarted transaction is completed or rolled back
    // before migration/default/managed overlays can observe it.
    await recoverSettingsImportStorage(chrome.storage.local, {lockHeld: true});
    await migrateLocalPreferences();
    const keys = Object.keys(requested || {});
    const managedKeys = expandPluginPolicyKeys(keys);
    const [local, managed] = await Promise.all([
      readStorageArea(chrome.storage.local, requested),
      // An array query returns only values explicitly supplied by enterprise
      // policy. Passing defaults here would make them indistinguishable from
      // managed values and allow local storage to win incorrectly.
      readStorageArea(chrome.storage.managed, managedKeys)
    ]);
    const effective = overlayPreferenceLayers(
      requested,
      pick(local, keys),
      pick(managed, managedKeys)
    );
    return pick(effective, keys);
  }
  if (type === 'session') {
    return readStorageArea(chrome.storage.session, requested);
  }
  throw Error('storage type is not supported');
};

const storage = (requested, type = 'managed') => {
  if (type === 'session') {
    return readPreferences(requested, type);
  }
  // Keep recovery, migration, and the authoritative local read in one
  // origin-wide critical section. Releasing after recovery but before get()
  // would let Options expose a half-written import to command code.
  return withSettingsImportLock(globalThis.navigator?.locks,
    () => readPreferences(requested, type));
};

const samePreferenceValue = (first, second) => Object.is(first, second) ||
  JSON.stringify(first) === JSON.stringify(second);

// monitor changes
{
  const cache = {};
  storage.on = (name, callback) => {
    cache[name] = cache[name] || [];
    cache[name].push(callback);
  };
  chrome.storage.onChanged.addListener((ps, areaName = 'local') => {
    if (areaName !== 'local' && areaName !== 'managed') {
      return;
    }
    // Reserved internal records (ownership, popup activity, diagnostics, and
    // future worker journals) are not user preferences and must never be
    // copied onto the live preference object or trigger preference callbacks.
    const keys = Object.keys(ps).filter(key =>
      !key.startsWith('__') && (hasOwn(defaults, key) || hasOwn(cache, key))
    );
    for (const key of keys) {
      const revision = (storage.revisions.get(key) || 0) + 1;
      storage.revisions.set(key, revision);
      const fallback = hasOwn(defaults, key) ? defaults[key] : undefined;
      void storage({[key]: fallback}).then(effective => {
        if (storage.revisions.get(key) !== revision) {
          return;
        }
        const next = effective[key];
        if (samePreferenceValue(prefs[key], next)) {
          return;
        }
        prefs[key] = next;
        for (const callback of cache[key] || []) {
          callback();
        }
      }).catch(error => {
        console.error(`preference refresh failed: ${key}`, error);
      });
    }
  });
  storage.revisions = new Map();
}

export {
  defaults,
  migrateLocalPreferences,
  prefs,
  storage
};
