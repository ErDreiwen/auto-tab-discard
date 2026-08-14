import {runScopedCommand} from './command-scope.mjs';
import {discard} from './discard.mjs';
import {
  createExternalDiscardController,
  readTrustedExtensionIds
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
        // runScopedCommand admitted this target through its fixed
        // `windowType: normal` query. Preserve that authoritative scope on the
        // Tabs.Tab snapshot passed to the takeover boundary; tabs.query does
        // not itself add a windowType property to returned tabs.
        if (await discard.takeover({...tab, windowType: 'normal'}, {manual: true}) === true) {
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
