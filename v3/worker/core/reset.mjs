import {withSettingsImportLock} from './settings-import-transaction.mjs';

const clearStorage = area => new Promise((resolve, reject) => area.clear(() => {
  const error = chrome.runtime.lastError;
  if (error) {
    reject(Error(error.message || error));
  }
  else {
    resolve();
  }
}));

const visualResetCandidates = snapshot => Object.entries(snapshot || {})
  .filter(([, marker]) => marker?.visual?.repair === true &&
    (marker.source === 'self' || marker.source === 'self-pending'))
  .map(([id]) => Number(id))
  .filter(Number.isSafeInteger)
  .sort((a, b) => a - b);

const repairVisualMarkers = async (ownership, release) => {
  const candidates = visualResetCandidates(await ownership.snapshot());
  const repaired = [];
  const failed = [];
  if (typeof release !== 'function') {
    return {candidates, failed, repaired};
  }

  // A reset is explicit and rare, but waking every marked tab at once would
  // reproduce the reload/RAM burst this fork exists to prevent. Repair one
  // document at a time and keep a truthful per-tab result.
  for (const id of candidates) {
    try {
      const tab = await release({id});
      repaired.push(tab?.id ?? ownership.resolveId?.(id) ?? id);
    }
    catch (error) {
      failed.push({id, reason: error?.message || String(error)});
    }
  }
  return {candidates, failed, repaired};
};

// Keep preference clearing, discard draining, visual repair, and the ownership
// barrier in one worker task. The synchronous admission fence covers preference
// observers; the drain gives in-flight native work its bounded settlement before
// ownership reset removes the nonce used for cancellation cleanup.
const resetExtensionState = async (
  ownership,
  area = chrome.storage.local,
  cancelTakeovers = async () => 0,
  release = undefined,
  beginDiscardReset = undefined,
  lockOptions = {}
) => {
  const options = lockOptions && typeof lockOptions === 'object' ? lockOptions : {};
  const lockManager = Object.hasOwn(options, 'lockManager') ?
    options.lockManager : globalThis.navigator?.locks;
  return withSettingsImportLock(lockManager, async () => {
    // beginDiscardReset installs its admission fence synchronously after the
    // cross-context preference lock is acquired. The lock remains owned until
    // clear, native drain, visual repair, and ownership reconciliation all
    // finish, so an Options import cannot resurrect preferences mid-reset.
    let barrier;
    try {
      barrier = typeof beginDiscardReset === 'function' ? beginDiscardReset() : undefined;
      await clearStorage(area);
      if (barrier) {
        await barrier.drain();
      }
      else {
        await cancelTakeovers();
      }
      const visualRepairs = await repairVisualMarkers(ownership, release);
      const result = await ownership.reset({reconcile: true});
      barrier?.complete();
      return {...result, visualRepairs};
    }
    catch (error) {
      barrier?.abort();
      throw error;
    }
  }, {timeoutMs: options.lockTimeoutMs});
};

export {clearStorage, repairVisualMarkers, resetExtensionState, visualResetCandidates};
