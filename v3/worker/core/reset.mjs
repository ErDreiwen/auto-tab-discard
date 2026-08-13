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

// Keep the preference clear and ownership barrier in one worker task. Running
// takeover cancellation and ownership.reset() last cancel any work indirectly
// triggered while storage.onChanged observers process the preference clear.
// Waiting here also gives an in-flight wake its bounded reload settlement before
// reset removes the nonce it uses to identify cancellation cleanup safely.
const resetExtensionState = async (
  ownership,
  area = chrome.storage.local,
  cancelTakeovers = async () => 0,
  release = undefined
) => {
  await clearStorage(area);
  await cancelTakeovers();
  const visualRepairs = await repairVisualMarkers(ownership, release);
  const result = await ownership.reset({reconcile: true});
  return {...result, visualRepairs};
};

export {clearStorage, repairVisualMarkers, resetExtensionState, visualResetCandidates};
