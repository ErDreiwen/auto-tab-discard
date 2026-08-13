import {runScopedCommand} from './command-scope.mjs';
import {discard} from './discard.mjs';
import {
  createExternalDiscardController,
  EXTERNAL_TRUSTED_IDS_KEY
} from './external-api-policy.mjs';
import {ownership} from './ownership.mjs';
import {storage} from './prefs.mjs';
import {SUSPENDED_POLICY_DEFAULTS} from './suspended-protection.mjs';
import {query} from './utils.mjs';
import {number} from '../modes/number.mjs';

const readTab = id => new Promise((resolve, reject) => {
  try {
    const operation = chrome.tabs.get(ownership.resolveId(id), tab => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(Error(error.message || String(error)));
      }
      else {
        resolve(tab);
      }
    });
    if (operation?.then) {
      operation.then(resolve, reject);
    }
  }
  catch (error) {
    reject(error);
  }
});

const suspendedPolicy = async () => Object.assign(
  await storage(SUSPENDED_POLICY_DEFAULTS),
  number.IGNORE,
  await storage({'whitelist.session': []}, 'session')
);

const readArea = (area, key, {optional = false} = {}) => new Promise((resolve, reject) => {
  try {
    const operation = area.get(key, values => {
      const error = chrome.runtime.lastError;
      if (error) {
        optional ? resolve({}) : reject(Error(error.message || String(error)));
      }
      else {
        resolve(values || {});
      }
    });
    if (operation?.then) {
      operation.then(values => resolve(values || {}), error => {
        optional ? resolve({}) : reject(error);
      });
    }
  }
  catch (error) {
    optional ? resolve({}) : reject(error);
  }
});

// A managed allowlist, when present, is authoritative. Local storage is the
// explicit developer/pairing fallback and cannot override enterprise policy.
const readTrustedExtensionIds = async () => {
  const managed = await readArea(chrome.storage.managed, EXTERNAL_TRUSTED_IDS_KEY, {
    optional: true
  });
  if (Object.hasOwn(managed, EXTERNAL_TRUSTED_IDS_KEY)) {
    return managed[EXTERNAL_TRUSTED_IDS_KEY];
  }
  const local = await readArea(chrome.storage.local, EXTERNAL_TRUSTED_IDS_KEY);
  return local[EXTERNAL_TRUSTED_IDS_KEY] || [];
};

const executeExternalDiscard = async ({tabIds}) => {
  const declared = new Set(tabIds);
  const takeoverFailures = new Map();
  // The only browser query is constructed here. Callers cannot add window,
  // URL, active, discarded, or forced fields to it.
  const declaredQuery = async options => (await query(options)).filter(tab =>
    declared.has(tab.id) && tab.active !== true && tab.incognito !== true
  );

  const result = await runScopedCommand({
    check: tabs => number.check(tabs, number.IGNORE, 'external/authorized'),
    command: 'discard-tabs',
    discard,
    hasBlockingNativeIntent: ownership.hasBlockingNativeIntent,
    query: declaredQuery,
    refresh: tab => readTab(tab.id).catch(() => undefined),
    resolveFresh: ownership.resolveFresh,
    selected: undefined,
    shiftKey: false,
    suspendedPolicy,
    // The shared takeover runner has an all-or-nothing exception contract for
    // UI commands. Capture failures here so one authorized batch can still
    // return a truthful settled record for each independent declared tab.
    takeover: async tab => {
      try {
        if (await discard.takeover(tab, {manual: true}) === true) {
          return true;
        }
      }
      catch (error) {}
      takeoverFailures.set(tab.id, tab);
      return true;
    }
  });

  if (takeoverFailures.size) {
    result.succeeded = (result.succeeded || []).filter(entry =>
      !takeoverFailures.has(entry?.tab?.id)
    );
    result.failed ||= [];
    for (const tab of takeoverFailures.values()) {
      result.failed.push({
        reason: 'authorized takeover did not settle',
        tab
      });
    }
  }
  return result;
};

const externalDiscardController = createExternalDiscardController({
  execute: executeExternalDiscard,
  readTrustedIds: readTrustedExtensionIds
});

const installExternalDiscardApi = (runtime = chrome.runtime) => {
  if (!runtime?.onMessageExternal?.addListener) {
    return false;
  }
  runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
    const respond = value => {
      try {
        sendResponse(value);
      }
      catch (error) {}
    };
    Promise.resolve().then(() => externalDiscardController.handle(request, sender)).then(
      respond,
      () => respond({error: {code: 'OPERATION_FAILED'}, ok: false})
    );
    // Keep an MV3 message channel alive until the safety pipeline settles.
    return true;
  });
  return true;
};

export {
  executeExternalDiscard,
  externalDiscardController,
  installExternalDiscardApi,
  readTrustedExtensionIds
};
