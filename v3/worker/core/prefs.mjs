import {
  LOCAL_PREFERENCE_MIGRATION_KEYS,
  overlayPreferenceLayers,
  planLocalPreferenceMigration
} from './preference-migrations.mjs';
import {expandPluginPolicyKeys} from './plugin-catalog.mjs';
import {
  MANAGED_STORAGE_READ_TIMEOUT,
  readManagedStorageArea,
  readStorageArea
} from './storage-read.mjs';
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

const storage = async (requested, type = 'managed') => {
  if (type === 'session') {
    return readStorageArea(chrome.storage.session, requested);
  }
  if (type !== 'managed') {
    throw Error('storage type is not supported');
  }
  const keys = Object.keys(requested || {});
  const managedKeys = expandPluginPolicyKeys(keys);
  // Chrome can defer the first managed-storage callback while its policy
  // provider initializes. It is independent of settings import, so wait for it
  // outside the origin lock and retain a separate, bounded cold-start budget.
  // Holding the import lock here would block every startup preference reader.
  const managed = await readManagedStorageArea(chrome.storage.managed, managedKeys);
  // Keep recovery, migration, and the authoritative local read in one short
  // origin-wide critical section. This snapshot is taken after the potentially
  // slow managed read, so an import cannot expose a partial or stale local
  // image while the effective preferences are assembled.
  const local = await withSettingsImportLock(globalThis.navigator?.locks, async () => {
    await recoverSettingsImportStorage(chrome.storage.local, {lockHeld: true});
    await migrateLocalPreferences();
    return readStorageArea(chrome.storage.local, requested);
  });
  const effective = overlayPreferenceLayers(
    requested,
    pick(local, keys),
    pick(managed, managedKeys)
  );
  return pick(effective, keys);
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
    const refreshes = keys.map(key => {
      const revision = (storage.revisions.get(key) || 0) + 1;
      storage.revisions.set(key, revision);
      return {
        fallback: hasOwn(defaults, key) ? defaults[key] : undefined,
        key,
        revision
      };
    });
    if (keys.length === 0) {
      return;
    }
    // One chrome.storage.set() can report dozens of changed preferences. Read
    // their authoritative local/managed overlay under one origin lock instead
    // of queueing one lock request per key. Per-key revisions still prevent an
    // older batch from publishing over a newer change event.
    const requested = Object.fromEntries(
      refreshes.map(({fallback, key}) => [key, fallback])
    );
    void storage(requested).then(effective => {
      for (const {key, revision} of refreshes) {
        if (storage.revisions.get(key) !== revision) {
          continue;
        }
        try {
          const next = effective[key];
          if (samePreferenceValue(prefs[key], next)) {
            continue;
          }
          prefs[key] = next;
          for (const callback of cache[key] || []) {
            callback();
          }
        }
        catch (error) {
          console.error(`preference refresh failed: ${key}`, error);
        }
      }
    }).catch(error => {
      for (const {key} of refreshes) {
        console.error(`preference refresh failed: ${key}`, error);
      }
    });
  });
  storage.revisions = new Map();
}

export {
  defaults,
  MANAGED_STORAGE_READ_TIMEOUT,
  migrateLocalPreferences,
  prefs,
  storage
};
