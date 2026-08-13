import {prefs, storage} from './prefs.mjs';
import {log, query} from './utils.mjs';
import {withTimeout} from './promise.mjs';
import {ownership} from './ownership.mjs';
import {
  createMarkerAttempt,
  prepareDocumentMarker,
  restoreDocumentMarker,
  visualPreparation
} from './marker.mjs';
import {normalizeTitleMarker} from './marker-title.mjs';
import {invokeNativeDiscard, isNativeDiscardSettled} from './native-discard-state.mjs';
import {createTakeoverScheduler} from './takeover-scheduler.mjs';
import {scriptingFailureDecision} from './browser-error.mjs';
import {createPulseRecovery} from './pulse-recovery.mjs';
import {createOrdinaryIntents} from './ordinary-intents.mjs';
import {
  isDiscardedTab,
  isFrozenTab,
  isLoadedTab,
  isSuspendedTab,
  suspensionState
} from './browser-state.mjs';

// this list keeps ids of the tabs that are in progress of being discarded
const inprogress = new Set();
const rendererOperations = new Set();
const releaseOperations = new Map();
const currentId = id => ownership.resolveId(id);
const pulseRecovery = createPulseRecovery({
  area: chrome.storage.session,
  resolveId: currentId,
  tabs: chrome.tabs
});
const ordinaryIntents = createOrdinaryIntents({area: chrome.storage.session});
const discardOutcome = (status, tab, reason, details = {}) => Object.freeze({
  ok: status === 'succeeded',
  reason,
  status,
  tab,
  ...details
});
const nativeProvenance = outcome => outcome && typeof outcome === 'object' ? {
  accepted: outcome.accepted === true,
  apiStyle: outcome.apiStyle,
  contract: outcome.contract,
  error: outcome.error,
  family: outcome.family,
  resultShape: outcome.resultShape
} : undefined;
const markerAttempt = createMarkerAttempt;

const discard = (tab, {intentId: resumedIntentId} = {}) => {
  const id = currentId(tab.id);
  if (inprogress.has(id) || rendererOperations.has(id) ||
      releaseOperations.has(id) || takeoverJob(id)) {
    return Promise.resolve(discardOutcome('skipped', tab, 'discard is already in progress'));
  }
  // https://github.com/rNeomy/auto-tab-discard/issues/248
  inprogress.add(id);
  const finishEarly = (status, current, reason) => {
    inprogress.delete(tab.id);
    inprogress.delete(currentId(tab.id));
    return discardOutcome(status, current || tab, reason);
  };

  // Metadata scans deliberately release their renderer lease before all peer
  // scans finish. Their tab snapshot can therefore lag a completed physical
  // takeover. Reserve synchronously above, then refresh both the browser tab
  // and its durable ownership before queueing preferences, intent, scripting,
  // or native work. That reservation prevents a same-worker takeover from
  // starting between this authoritative read and renderer preparation.
  const blocked = ownership.hasBlockingNativeIntent(id).catch(() => true);
  const fresh = withTimeout(getTab(id), discard.getTimeout, undefined);
  const status = ownership.status(id).catch(() => undefined);
  return Promise.all([blocked, fresh, status]).then(async ([isBlocked, current, ownershipState]) => {
    if (isBlocked) {
      return finishEarly('skipped', current, 'direct native discard is still settling');
    }
    if (!current) {
      return finishEarly('failed', current, 'tab is no longer available for discard');
    }
    tab = current;
    if (current.active === true) {
      log('tab is active', current);
      return finishEarly('failed', current, 'active tabs cannot be discarded');
    }
    if (isSuspendedTab(current)) {
      log('already suspended', current);
      return finishEarly('skipped', current, 'tab is already suspended');
    }
    const physicalSelf = ownershipState?.marker?.state === 'owned' &&
      ownershipState.marker.source === 'self' &&
      ownershipState.marker.visual?.physicalOnly === true;
    if (physicalSelf) {
      return finishEarly('skipped', current, 'physical discard ownership is already settled');
    }
    const intentId = resumedIntentId || await ordinaryIntents.enqueue(current).catch(() => undefined);
    return storage(prefs).then(async prefs => {
      if (await ownership.hasBlockingNativeIntent(id).catch(() => true)) {
        inprogress.delete(tab.id);
        inprogress.delete(currentId(tab.id));
        return discardOutcome('skipped', tab, 'direct native discard is still settling');
      }
      return new Promise(resolve => {
    const limit = Math.max(1, Number(prefs['simultaneous-jobs']) || 1);
    if (discard.count >= limit) {
      log('discarding queue for', tab);
      discard.tabs.push({intentId, tab, resolve});
      return;
    }

    discard.count += 1;
    let started = false;
    let prepareTimer;
    const marker = {
      favicon: prefs.favicon === true,
      faviconDelay: Math.max(0, Number(prefs['favicon-delay']) || 0),
      prepends: normalizeTitleMarker(prefs.prepends)
    };
    const next = (prepared = visualPreparation(marker)) => {
      if (started) {
        return;
      }
      started = true;
      clearTimeout(prepareTimer);
      void (async () => {
        if (intentId) {
          await ordinaryIntents.transition(intentId, resumedIntentId ? 'resumed' : 'running').catch(() => false);
        }
        let result = discardOutcome('failed', tab, 'discard did not run');
        try {
          result = await discard.perform(tab, {
            ...prepared,
            repair: Boolean(marker.prepends || marker.favicon),
            ...(marker.prepends && {titleMarker: marker.prepends})
          });
          return result;
        }
        finally {
          if (intentId) {
            await ordinaryIntents.transition(
              intentId,
              result?.status === 'succeeded' ? 'completed' : 'failed',
              result?.status === 'succeeded' ? undefined : result?.reason || 'native discard did not settle'
            ).catch(() => false);
          }
        }
      })().then(resolve, error => resolve(discardOutcome(
        'failed', tab, error?.message || String(error)
      ))).finally(() => {
        discard.count -= 1;
        inprogress.delete(tab.id);
        inprogress.delete(currentId(tab.id));
        if (discard.tabs.length) {
          const queued = discard.tabs.shift();
          inprogress.delete(queued.tab.id);
          discard(queued.tab, {intentId: queued.intentId}).then(queued.resolve);
        }
      });
    };
    // Page preparation is bounded independently of the renderer promise. The
    // injected deadline/token makes any result arriving after this timer stale.
    prepareTimer = setTimeout(() => next({
      ...visualPreparation(marker),
      error: 'marker preparation timed out',
      stale: true
    }), discard.prepareTimeout);
    // change title or favicon
    if (prefs.prepends || prefs.favicon) {
      const href = tab.favIconUrl || '';
      const attempt = markerAttempt(discard.prepareTimeout);
      ownership.withNativeMutationGuard(() => chrome.scripting.executeScript({
        target: {
          tabId: tab.id,
          allFrames: true
        },
        func: prepareDocumentMarker,
        args: [marker, href, attempt]
      }), tab.id).then(results => {
        const prepared = results?.find(entry => entry.result?.top)?.result;
        next({...visualPreparation(marker, prepared), rollbackToken: attempt.token});
      }).catch(error => next({
        ...visualPreparation(marker),
        error: error?.message || String(error),
        rollbackToken: attempt.token
      }));
    }
    else {
      next(visualPreparation(marker));
    }
      });
    });
  });
};
discard.tabs = [];
discard.count = 0;
discard.prepareTimeout = 5000;
const getTab = id => new Promise(resolve => chrome.tabs.get(currentId(id), current => {
  const error = chrome.runtime.lastError;
  resolve(error ? undefined : current);
}));
// Chrome MV3 and Firefox both expose tabs.discard() as a Promise, but Firefox
// deliberately has no callback result and fulfills with undefined.  The live
// tab postcondition below is therefore the ownership boundary; the API result
// is useful telemetry only and is never treated as proof that the renderer was
// actually torn down.
const nativeDiscard = async (tab, attemptId) => ownership.withNativeMutationGuard(() =>
  invokeNativeDiscard(currentId(tab.id)),
tab.id,
attemptId
).catch(error => {
  if (error?.code === 'DIRECT_NATIVE_ORPHAN_BLOCKED') {
    return {
      accepted: false,
      contract: 'native-mutation-guard',
      error: 'direct native discard is blocked by unresolved lineage'
    };
  }
  throw error;
});

const takeoverFailureStage = error => {
  const message = error?.message || String(error || '');
  if (/timed out waking/i.test(message)) return 'wake-timeout';
  if (/did not wake as a quiescent/i.test(message)) return 'wake-not-quiescent';
  if (/timed out stopping|cannot stop the reload/i.test(message)) return 'reload-stop-failed';
  if (/timed out preparing|cannot prepare the awakened/i.test(message)) return 'marker-preparation-failed';
  if (/did not expose its prepared sleep title/i.test(message)) return 'marker-title-unavailable';
  if (/native discard timed out/i.test(message)) return 'native-discard-timeout';
  if (/native discard did not settle/i.test(message)) return 'native-discard-unsettled';
  if (/another discarder won/i.test(message)) return 'native-discard-contended';
  if (/ownership finalization|woke during ownership/i.test(message)) return 'ownership-finalization-failed';
  if (/became stale/i.test(message)) return 'ownership-stale';
  if (/cancelled/i.test(message)) return 'cancelled';
  return 'other-takeover-failure';
};

const reloadTab = id => ownership.withNativeMutationGuard(() => new Promise(resolve => {
  try {
    chrome.tabs.reload(currentId(id), {bypassCache: false}, () => {
      const error = chrome.runtime.lastError;
      resolve(error ? {error: error.message || String(error)} : {success: true});
    });
  }
  catch (e) {
    resolve({error: e.message || String(e)});
  }
}), id).catch(error => ({error: error?.code === 'DIRECT_NATIVE_ORPHAN_BLOCKED' ?
  'direct native discard lineage is unresolved' : error?.message || String(error)}));

const remainingTime = deadline => Math.max(0, deadline - Date.now());
const waitBeforeDeadline = async (deadline, interval = discard.takeoverPoll) => {
  const remaining = remainingTime(deadline);
  if (remaining > 0) {
    const delay = Math.min(Math.max(0, interval), remaining);
    // setTimeout(0) is intentional in tests and yields to renderer/event timers;
    // a microtask-only loop can starve a delayed loading transition.
    await new Promise(resolve => setTimeout(resolve, delay));
  }
};
const getTabBeforeDeadline = (id, deadline) => {
  const timeout = Math.min(discard.getTimeout, remainingTime(deadline));
  return timeout > 0 ? withTimeout(getTab(id), timeout, undefined) : Promise.resolve(undefined);
};

const restoreLiveDocumentMarker = async (id, rollbackToken) => {
  if (!rollbackToken || !Number.isInteger(currentId(id))) {
    return false;
  }
  const deadline = Date.now() + discard.markerRollbackTimeout;
  const tab = await getTabBeforeDeadline(id, deadline);
  if (!tab || isSuspendedTab(tab)) {
    return false;
  }
  const timeout = Math.min(discard.markerRollbackTimeout, remainingTime(deadline));
  if (timeout <= 0) {
    return false;
  }
  try {
    const result = await withTimeout(ownership.withNativeMutationGuard(() =>
      chrome.scripting.executeScript({
        target: {tabId: currentId(id)},
        func: restoreDocumentMarker,
        args: [{token: rollbackToken}]
      }), id), timeout, undefined);
    return result?.some(entry => entry?.result?.restored === true ||
      entry?.result?.titlePreserved === true || entry?.result?.faviconPreserved === true) === true;
  }
  catch (error) {
    log('cannot roll back a live document marker', error);
    return false;
  }
};

const waitForAwake = async (id, token, deadline = Date.now() + discard.takeoverTimeout) => {
  while (Date.now() < deadline && token.cancelled === false) {
    const current = await getTabBeforeDeadline(id, deadline);
    if (!current) {
      return undefined;
    }
    if (isLoadedTab(current)) {
      return current;
    }
    await waitBeforeDeadline(deadline);
  }
};

const observeReload = id => {
  const state = {
    sawLoading: false
  };
  const listener = (tabId, changeInfo, tab) => {
    if (currentId(tabId) !== currentId(id)) {
      return;
    }
    const status = changeInfo.status || tab?.status;
    if (status === 'loading') {
      state.sawLoading = true;
    }
  };
  chrome.tabs.onUpdated?.addListener(listener);
  return {
    close: () => chrome.tabs.onUpdated?.removeListener?.(listener),
    state
  };
};

// A takeover has to wake a natively discarded tab before this extension can
// become the physical discarder. Chromium reports discarded:false as soon as
// that navigation starts, not when it is safe to discard again. Discarding the
// still-loading tab can leave a stale tab-strip spinner and a short-lived
// renderer behind, so stop the reload and wait for it to leave "loading" first.
const stopLoadingTab = (
  id,
  marker = {},
  source = '',
  {
    attempt: suppliedAttempt,
    deadline = Date.now() + discard.stopTimeout,
    requireFavicon = false,
    requireTitle = false
  } = {}
) => {
  try {
    const settings = {
      favicon: requireFavicon && marker.favicon === true,
      faviconDelay: Math.max(0, Number(marker.faviconDelay) || 0),
      prepends: marker.prepends || ''
    };
    const attempt = suppliedAttempt || markerAttempt(Math.max(0, deadline - Date.now()));
    return ownership.withNativeMutationGuard(() => chrome.scripting.executeScript({
      target: {tabId: currentId(id)},
      injectImmediately: true,
      func: prepareDocumentMarker,
      args: [settings, source, attempt]
    }), id).then(results => {
      const prepared = results?.find(result => result.result?.stopped === true)?.result;
      if (!prepared) {
        return {error: 'reload stop script did not return a result'};
      }
      const titleApplied = prepared.titleApplied === true ||
        (!settings.prepends || prepared.title?.startsWith(settings.prepends) === true);
      if (requireTitle && settings.prepends && titleApplied !== true) {
        return {error: `sleep title prefix was not applied (title: ${prepared.title || ''})`};
      }
      if (requireFavicon && settings.favicon && prepared.faviconApplied !== true) {
        return {error: `sleep favicon was not applied (${prepared.faviconError || 'unknown reason'})`};
      }
      return {
        rollbackToken: attempt.token,
        success: true,
        title: prepared.title,
        visual: visualPreparation(settings, {...prepared, titleApplied})
      };
    }, error => ({error: error?.message || String(error), cause: error}));
  }
  catch (error) {
    return Promise.resolve({error: error?.message || String(error), cause: error});
  }
};

const quiesceReload = async (
  id,
  token,
  initial,
  observation,
  prepend,
  deadline = Date.now() + discard.takeoverTimeout,
  frameRetries = {count: 0}
) => {
  let current = initial || await getTabBeforeDeadline(id, deadline);
  if (!current || !isLoadedTab(current)) {
    return current;
  }

  let completeSince;
  while (Date.now() < deadline && token.cancelled === false) {
    if (!current || !isLoadedTab(current) || current.active === true) {
      return current;
    }
    if (current.status === 'complete') {
      completeSince ||= Date.now();
      const stableFor = observation?.state.sawLoading ?
        discard.quiesceDwell : discard.reloadStartGrace;
      if (Date.now() - completeSince >= stableFor) {
        return current;
      }
      await waitBeforeDeadline(deadline);
      current = await getTabBeforeDeadline(id, deadline);
      continue;
    }

    completeSince = undefined;
    if (current.status !== 'loading') {
      await waitBeforeDeadline(deadline);
      current = await getTabBeforeDeadline(id, deadline);
      continue;
    }

    // discarded:false can precede the new renderer/document commit. A single
    // immediate injection can therefore stop the outgoing document and miss
    // the new load. Retry only after the prior injection resolved successfully;
    // a timed-out operation is left in flight, so fail the takeover and never
    // queue a second stop behind it.
    const stopTimeout = {};
    const stopLimit = Math.min(discard.stopTimeout, remainingTime(deadline));
    // Quiescence owns navigation settlement only. Indicator writes belong to
    // the later generation-fenced preparation pass, where cancellation has an
    // exact rollback token. Writing a title here allowed a delayed stop call
    // to leave a stale marker after cancellation.
    const stopped = stopLimit > 0 ?
      await withTimeout(stopLoadingTab(id, {}, '', {deadline}),
        stopLimit, stopTimeout) : stopTimeout;
    if (stopped === stopTimeout) {
      throw Error(`timed out stopping the reload on tab ${id}`);
    }
    if (stopped?.error) {
      // During a renderer commit Chrome can reject an otherwise valid
      // executeScript call because the outgoing main frame disappeared. The
      // promise has settled, so it is safe to reread the tab and retry against
      // the replacement frame. Keep permission and closed-tab errors fatal.
      current = await getTabBeforeDeadline(id, deadline);
      const decision = scriptingFailureDecision(stopped.cause || stopped.error, current);
      if (decision.action === 'settled') {
        return current;
      }
      if (decision.action === 'retry') {
        if (frameRetries.count >= discard.transientFrameRetries) {
          throw Error(`cannot stop the reload on tab ${id}: transient frame retry limit reached`);
        }
        frameRetries.count += 1;
        await waitBeforeDeadline(deadline);
        current = await getTabBeforeDeadline(id, deadline);
        continue;
      }
      throw Error(`cannot stop the reload on tab ${id} (${decision.classification.category}): ${stopped.error}`);
    }
    current = await getTabBeforeDeadline(id, deadline);
    if (!current || !isLoadedTab(current) || current.active === true) {
      return current;
    }
    await waitBeforeDeadline(deadline);
    current = await getTabBeforeDeadline(id, deadline);
  }
};

// Cancellation wins over takeover. If this job initiated a reload, stop the
// renderer request once (when scriptable) and wait until the live tab is no
// longer loading before the release path can issue its own wake. This avoids an
// abandoned spinner and duplicate renderer allocation after the user presses X.
const settleCancelledReload = async (id, deadline, observation) => {
  let current;
  let stopped = false;
  let stableKey;
  let stableReads = 0;
  let stableSince;
  const startedAt = Date.now();
  const dwell = Math.min(discard.cancellationStableDwell,
    Math.max(0, Math.floor(remainingTime(deadline) / 2)));
  while (Date.now() < deadline) {
    current = await getTabBeforeDeadline(id, deadline);
    if (!current) {
      return current;
    }
    const suspended = isSuspendedTab(current);
    if (!suspended && current.status === 'loading' && !stopped) {
      stopped = true;
      const limit = Math.min(discard.stopTimeout, remainingTime(deadline));
      if (limit > 0) {
        await withTimeout(stopLoadingTab(id, {}, '', {deadline}), limit, undefined).catch(() => undefined);
      }
      stableKey = undefined;
      stableReads = 0;
      stableSince = undefined;
      await waitBeforeDeadline(deadline);
      continue;
    }
    if (!suspended && current.status === 'loading') {
      stableKey = undefined;
      stableReads = 0;
      stableSince = undefined;
      await waitBeforeDeadline(deadline);
      continue;
    }

    // A single non-loading read is not a settlement fence: a delayed reload
    // callback can still flip discarded->loading in the next task. Require two
    // identical reads plus a dwell, and for a never-observed transition retain
    // the original reload-start grace as well.
    const key = `${current.id}:${current.discarded === true}:${current.frozen === true}:${current.status || ''}`;
    if (key !== stableKey) {
      stableKey = key;
      stableReads = 1;
      stableSince = Date.now();
    }
    else {
      stableReads += 1;
    }
    const graceComplete = observation?.state.sawLoading === true ||
      Date.now() - startedAt >= Math.min(discard.reloadStartGrace, remainingTime(deadline));
    if (stableReads >= 2 && graceComplete && Date.now() - stableSince >= dwell) {
      return current;
    }
    await waitBeforeDeadline(deadline);
  }
  return current;
};

const waitForUnloaded = async (id, token) => {
  const deadline = Date.now() + discard.nativeSettleTimeout;
  let current;
  let stableId;
  let stableReads = 0;
  let stableSince = 0;
  while (Date.now() < deadline && token.cancelled === false) {
    // Never trust the tabs.discard() callback snapshot as the ownership
    // boundary. A user activation can wake the live tab before finalization.
    current = await getTabBeforeDeadline(id, deadline);
    if (!current) {
      // Edge replacement lineage can briefly make tabs.get return no snapshot
      // even though ownership has already remapped the predecessor. Treat it
      // like the inactive callback gap and retry within the bounded settlement
      // window; onRemoved/cancellation still terminates through the token.
      stableId = undefined;
      stableReads = 0;
      await waitBeforeDeadline(deadline);
      continue;
    }
    if (isNativeDiscardSettled(current)) {
      if (stableId === current.id) {
        stableReads += 1;
      }
      else {
        stableId = current.id;
        stableReads = 1;
        stableSince = Date.now();
      }
      // The native callback and the first tabs.get can both win a same-task
      // race against activation. Require a second authoritative read after a
      // short dwell before any source:self marker can be finalized.
      if (stableReads >= 2 && Date.now() - stableSince >= discard.nativeStableDwell) {
        return current;
      }
    }
    else if (current.active === true) {
      return current;
    }
    else {
      // Chromium/Edge may acknowledge tabs.discard() before its replacement
      // and unloaded state become observable. An inactive loaded-looking read
      // is therefore transitional, not proof that the accepted operation
      // failed. Keep polling to the bounded deadline; only user activation is
      // an authoritative early wake boundary.
      stableId = undefined;
      stableReads = 0;
    }
    await waitBeforeDeadline(deadline);
  }
  return current;
};

// A Chromium tabs.discard() callback acknowledges the request, not the
// physical boundary. Edge may replace the tab or expose discarded:true before
// status:unloaded. Keep this Promise pending until two stable authoritative
// unloaded reads, a definite user wake, or removal; release joins this Promise
// so it can never reload ahead of a delayed native discard.
const waitForDirectNativeBoundary = async (id, token) => {
  let stableId;
  let stableReads = 0;
  let stableSince = 0;
  while (true) {
    if (token.removed === true) {
      return undefined;
    }
    const current = await withTimeout(getTab(id), discard.getTimeout, undefined);
    if (current && isNativeDiscardSettled(current)) {
      if (stableId === current.id) {
        stableReads += 1;
      }
      else {
        stableId = current.id;
        stableReads = 1;
        stableSince = Date.now();
      }
      if (stableReads >= 2 && Date.now() - stableSince >= discard.nativeStableDwell) {
        return current;
      }
    }
    else {
      stableId = undefined;
      stableReads = 0;
      // Only an active tab is authoritative evidence that the user won. Edge's
      // accepted native discard can pass through discarded:false/frozen:false
      // while replacing the old renderer, so an inactive both-false snapshot
      // must remain fenced until unloaded, removal, cancellation/release, or a
      // real activation lifecycle event.
      if (current?.active === true) {
        return current;
      }
    }
    await new Promise(resolve => setTimeout(resolve, discard.takeoverPoll));
  }
};

const reconcileLateNative = (operation, authority, attemptId, visual, rollbackToken) => {
  Promise.resolve(operation).then(async outcome => {
    if (outcome?.accepted !== true) {
      await restoreLiveDocumentMarker(authority?.id, rollbackToken);
      return false;
    }
    const id = authority?.id;
    if (!Number.isInteger(id)) {
      return false;
    }
    const finalTab = await waitForUnloaded(id, {cancelled: false});
    if (!isNativeDiscardSettled(finalTab)) {
      await restoreLiveDocumentMarker(id, rollbackToken);
      return false;
    }
    if (!await ownership.promoteLateSelf(authority, attemptId, visual)) {
      await restoreLiveDocumentMarker(id, rollbackToken);
      return false;
    }
    return ownership.confirmSelf(finalTab.id, attemptId);
  }).catch(async error => {
    log('late native discard reconciliation failed', error);
    await restoreLiveDocumentMarker(authority?.id, rollbackToken);
  });
};

const reconcileLateDirectNative = (operation, authority, attemptId, visual) => {
  // Attach immediately so a late rejection can never escape the worker or a
  // focused test. Reset/release invalidates `authority`, making late promotion
  // impossible even when the same browser operation later settles.
  void Promise.resolve(operation).then(async result => {
    if (result?.outcome?.accepted !== true || !isNativeDiscardSettled(result.finalTab)) {
      return false;
    }
    if (!await ownership.promoteLateSelf(authority, attemptId, visual)) {
      return false;
    }
    return ownership.confirmSelf(result.finalTab.id, attemptId);
  }).catch(error => log('late direct native discard reconciliation failed', error));
};

const waitForPreparedTitle = async (
  id,
  token,
  prepend,
  initial,
  deadline = Date.now() + discard.titleSettleTimeout
) => {
  if (!prepend) {
    return initial;
  }
  let current = initial;
  while (Date.now() < deadline && token.cancelled === false) {
    if (!current || !isLoadedTab(current) ||
        current.active === true || current.status !== 'complete') {
      return current;
    }
    if (current.title?.startsWith(prepend)) {
      return current;
    }
    await waitBeforeDeadline(deadline);
    current = await getTabBeforeDeadline(id, deadline);
  }
  return current;
};

const prepareAwakeTab = async (
  id,
  token,
  initial,
  observation,
  marker,
  deadline,
  visual,
  rollback = {}
) => {
  const frameRetries = {count: 0};
  const prepend = marker.prepends || '';
  let current = initial;
  while (Date.now() < deadline && token.cancelled === false) {
    current = await quiesceReload(
      id, token, current, observation, prepend, deadline, frameRetries
    );
    if (!current || !isLoadedTab(current) ||
        current.active === true || current.status !== 'complete') {
      return current;
    }

    // A final pass makes the physical takeover visually consistent with an
    // ordinary extension discard. If Chrome swaps the main frame here, return
    // through quiescence and retry against the replacement renderer.
    const prepareTimeout = {};
    // The reload-stop pass above is deliberately short, but this final visual
    // pass also loads and rasterizes the favicon and honors faviconDelay.
    // Hidden Chromium renderers can throttle that timer to roughly one second,
    // so reusing stopTimeout races a valid marker result after its title write.
    // Give visual preparation its ordinary bounded budget while retaining the
    // single takeover deadline as the outer limit.
    const prepareLimit = Math.min(discard.prepareTimeout, remainingTime(deadline));
    const attempt = markerAttempt(Math.max(0, prepareLimit));
    // The injected function can write the exact-attempt title/favicon before
    // executeScript's result Promise settles. Publish its rollback authority
    // before awaiting that Promise so cancellation and timeouts can still undo
    // only this extension's live-document writes.
    rollback.token = attempt.token;
    const prepared = prepareLimit > 0 ?
      await withTimeout(stopLoadingTab(id, marker, current.favIconUrl || '', {
        attempt,
        deadline,
        requireFavicon: marker.favicon === true,
        requireTitle: Boolean(prepend)
      }), prepareLimit, prepareTimeout) : prepareTimeout;
    if (prepared === prepareTimeout) {
      throw Error(`timed out preparing the awakened tab ${id}`);
    }
    if (prepared?.error) {
      current = await getTabBeforeDeadline(id, deadline);
      const decision = scriptingFailureDecision(prepared.cause || prepared.error, current);
      if (decision.action === 'settled') {
        return current;
      }
      if (decision.action === 'retry') {
        if (frameRetries.count >= discard.transientFrameRetries) {
          throw Error(`cannot prepare the awakened tab ${id}: transient frame retry limit reached`);
        }
        frameRetries.count += 1;
        await waitBeforeDeadline(deadline);
        current = await getTabBeforeDeadline(id, deadline);
        continue;
      }
      throw Error(`cannot prepare the awakened tab ${id} (${decision.classification.category}): ${prepared.error}`);
    }

    Object.assign(visual, prepared.visual || visualPreparation(marker));
    rollback.token = prepared.rollbackToken;
    visual.repair = Boolean(marker.prepends || marker.favicon);
    current = await getTabBeforeDeadline(id, deadline);
    const titleDeadline = Math.min(deadline, Date.now() + discard.titleSettleTimeout);
    return waitForPreparedTitle(id, token, prepend, current, titleDeadline);
  }
  return current;
};

const waitForOwnership = async (id, token) => {
  const deadline = Date.now() + discard.takeoverTimeout;
  while (Date.now() < deadline && token.cancelled === false) {
    const state = await ownership.status(id);
    if (!state.attemptId) {
      return state.marker?.state === 'owned' && state.marker.source === 'self';
    }
    await new Promise(resolve => setTimeout(resolve, discard.takeoverPoll));
  }
  throw Error(`timed out waiting for existing discard attempt on tab ${id}`);
};

const takeoverOnce = async (tab, token) => {
  const id = tab.id;
  const current = await withTimeout(getTab(id), discard.getTimeout, undefined);
  if (token.cancelled) {
    throw Error(`discard takeover cancelled for tab ${id}`);
  }
  const initialState = await ownership.status(id);
  const currentState = suspensionState(current);
  const recovering = currentState.kind === 'loaded' && initialState.marker?.state === 'takeover-recovery';
  const suspended = isSuspendedTab(current);
  if (!current || current.active === true || (suspended === false && recovering === false)) {
    throw Error(`tab ${id} is no longer an inactive takeover target`);
  }

  const directNative = isFrozenTab(current);
  const attemptId = await (directNative ?
    ownership.beginDirectNative(current) : ownership.beginTakeover(current));
  if (!attemptId) {
    if (await waitForOwnership(id, token)) {
      return true;
    }
    throw Error(`cannot start discard takeover for tab ${id}`);
  }

  let finished = false;
  let markerRollbackToken;
  const markerRollback = {};
  let reloadObservation;
  let reloadStarted = false;
  let lateNativePending = false;
  let takeoverDeadline = Date.now() + discard.takeoverTimeout;
  try {
    const takeoverPrefs = await storage({
      favicon: prefs.favicon,
      'favicon-delay': prefs['favicon-delay'],
      prepends: prefs.prepends
    });
    const marker = {
      favicon: takeoverPrefs.favicon === true,
      faviconDelay: Math.max(0, Number(takeoverPrefs['favicon-delay']) || 0),
      prepends: normalizeTitleMarker(takeoverPrefs.prepends)
    };
    const prepend = marker.prepends;
    if (directNative) {
      // A frozen renderer cannot be marked without waking it. Edge can,
      // however, convert it directly into a real unloaded discard without
      // selecting, reloading, or scripting the tab. Keep that physical and
      // visual truth separate: this extension owns the native discard, while
      // the requested title/favicon signal is explicitly unavailable.
      const visualRequested = Boolean(marker.prepends || marker.favicon);
      const visual = visualRequested ? {
        complete: false,
        favicon: false,
        physicalOnly: true,
        repair: false,
        title: false,
        ...(marker.prepends && {titleMarker: marker.prepends})
      } : {
        complete: true,
        favicon: true,
        physicalOnly: true,
        repair: false,
        title: true
      };
      token.directNative = true;
      const live = await getTabBeforeDeadline(id, takeoverDeadline);
      if (token.cancelled || !live || live.active === true || !isFrozenTab(live) ||
          !ownership.isCurrent(id, attemptId)) {
        throw Error(`tab ${id} changed before direct native discard`);
      }

      const nativeTimeout = {};
      const lateAuthority = ownership.lateAuthority(id);
      token.nativeSettled = false;
      const nativeInvocation = Promise.resolve(nativeDiscard(live, attemptId));
      const nativeOperation = token.nativeOperation = nativeInvocation.then(async outcome => ({
        outcome,
        finalTab: outcome?.accepted === true ?
          await waitForDirectNativeBoundary(id, token) :
          await withTimeout(getTab(id), discard.getTimeout, undefined) || live
      })).then(
        result => {
          token.nativeSettled = true;
          return result;
        },
        error => {
          token.nativeSettled = true;
          throw error;
        }
      );
      let settled = await withTimeout(nativeOperation, discard.nativeTimeout, nativeTimeout);
      if (settled === nativeTimeout) {
        const fenceTimeout = {};
        settled = await withTimeout(nativeOperation, discard.takeoverFenceTimeout, fenceTimeout);
        if (settled === fenceTimeout) {
          settled = nativeTimeout;
        }
      }
      const outcome = settled === nativeTimeout ? undefined : settled?.outcome;
      const nativeAccepted = outcome?.accepted === true;
      const finalTab = settled === nativeTimeout ?
        await withTimeout(getTab(id), discard.getTimeout, undefined) || live : settled.finalTab;
      const strong = nativeAccepted && isNativeDiscardSettled(finalTab);
      const owned = await ownership.finish(finalTab || {...live, discarded: false}, attemptId,
        strong ? 'self' : undefined, {
          allowClaimed: false,
          directNative: true,
          lateNative: settled === nativeTimeout,
          visual
        });
      finished = true;
      if (settled === nativeTimeout) {
        lateNativePending = true;
        reconcileLateDirectNative(nativeOperation, lateAuthority, attemptId, visual);
      }
      if (strong && owned && await ownership.confirmSelf(finalTab.id, attemptId)) {
        return Object.freeze({
          ok: true,
          physicalOnly: true,
          reason: visualRequested ? 'native discard completed; frozen renderer visual unavailable' :
            'native discard completed without waking the frozen renderer',
          tab: finalTab,
          visualUnavailable: visualRequested
        });
      }
      const reason = settled === nativeTimeout ? 'native discard timed out' : outcome?.error ||
        (nativeAccepted ? 'native discard did not settle in the browser discard state' :
          'another discarder won before the native discard');
      throw Error(`direct frozen discard takeover failed for tab ${id}: ${reason}`);
    }
    const visual = visualPreparation(marker);
    visual.repair = Boolean(marker.prepends || marker.favicon);
    if (marker.prepends) {
      visual.titleMarker = marker.prepends;
    }
    takeoverDeadline = Date.now() + discard.takeoverTimeout;
    let awake = current;
    if (isDiscardedTab(current)) {
      reloadObservation = observeReload(id);
      // The native call starts the wake synchronously, before its callback can
      // settle. Cancellation cleanup must own that interval too.
      reloadStarted = true;
      const reloadTimeout = {};
      const reloadLimit = remainingTime(takeoverDeadline);
      const reload = reloadLimit > 0 ?
        await withTimeout(reloadTab(id), reloadLimit, reloadTimeout) : reloadTimeout;
      if (reload === reloadTimeout || reload.error) {
        throw Error(reload.error || `timed out waking tab ${id}`);
      }
      awake = await waitForAwake(id, token, takeoverDeadline);
    }
    awake = await prepareAwakeTab(
      id,
      token,
      awake,
      reloadObservation,
      marker,
      takeoverDeadline,
      visual,
      markerRollback
    );
    markerRollbackToken = markerRollback.token;
    if (token.cancelled) {
      throw Error(`discard takeover cancelled for tab ${id}`);
    }

    if (!awake || !isLoadedTab(awake) ||
        awake.active === true || awake.status !== 'complete') {
      throw Error(`tab ${id} did not wake as a quiescent inactive tab`);
    }
    if (prepend && awake.title?.startsWith(prepend) !== true) {
      throw Error(`tab ${id} did not expose its prepared sleep title`);
    }
    if (!ownership.isCurrent(id, attemptId)) {
      throw Error(`discard takeover became stale for tab ${id}`);
    }

    const nativeTimeout = {};
    const lateAuthority = ownership.lateAuthority(id);
    token.nativeSettled = false;
    const nativeOperation = token.nativeOperation = Promise.resolve(nativeDiscard(awake)).then(
      outcome => {
        token.nativeSettled = true;
        return outcome;
      },
      error => {
        token.nativeSettled = true;
        throw error;
      }
    );
    let outcome = await withTimeout(nativeOperation, discard.nativeTimeout, nativeTimeout);
    if (outcome === nativeTimeout) {
      const fenceTimeout = {};
      outcome = await withTimeout(nativeOperation, discard.takeoverFenceTimeout, fenceTimeout);
      if (outcome === fenceTimeout) {
        outcome = nativeTimeout;
      }
    }
    const nativeAccepted = outcome !== nativeTimeout && outcome?.accepted === true;
    let finalTab = outcome?.result || await withTimeout(getTab(id), discard.getTimeout, undefined) || awake;
    if (nativeAccepted) {
      // A missing/timed-out live read is a failed takeover, never permission to
      // fall back to the API's potentially stale or absent result snapshot.
      finalTab = await waitForUnloaded(id, token);
    }
    const strong = nativeAccepted && isNativeDiscardSettled(finalTab);
    const owned = await ownership.finish(finalTab || {...awake, discarded: false}, attemptId,
      strong ? 'self' : undefined, {
      allowClaimed: false,
      lateNative: outcome === nativeTimeout,
      visual
    });
    finished = true;
    if (outcome === nativeTimeout) {
      lateNativePending = true;
      reconcileLateNative(nativeOperation, lateAuthority, attemptId, visual, markerRollbackToken);
    }

    if (strong && owned) {
      if (await ownership.confirmSelf(finalTab.id, attemptId)) {
        return true;
      }
      throw Error(`discard takeover failed for tab ${id}: tab woke during ownership finalization`);
    }
    const reason = outcome === nativeTimeout ? 'native discard timed out' : outcome?.error ||
      (nativeAccepted ? 'native discard did not settle in the browser discard state' :
        'another discarder won before the native discard');
    throw Error(`discard takeover failed for tab ${id}: ${reason}`);
  }
  catch (e) {
    if (token.cancelled && reloadStarted) {
      await settleCancelledReload(
        id,
        Date.now() + discard.cancellationSettleTimeout,
        reloadObservation
      ).catch(() => undefined);
    }
    if (!finished && ownership.isCurrent(id, attemptId)) {
      const finalTab = await withTimeout(getTab(id), discard.getTimeout, undefined) || {
        ...current,
        discarded: false
      };
      await ownership.finish(finalTab, attemptId, undefined, {allowClaimed: false}).catch(() => {
        return ownership.invalidate(id);
      });
    }
    if (!lateNativePending) {
      await restoreLiveDocumentMarker(
        id,
        markerRollbackToken || markerRollback.token
      ).catch(() => false);
    }
    throw e;
  }
  finally {
    reloadObservation?.close();
  }
};

const takeoverJobs = new Map();
const takeoverScheduler = createTakeoverScheduler({concurrency: 4});
const takeoverJob = id => takeoverJobs.get(id) || takeoverJobs.get(currentId(id));
discard.reserveRelease = rawId => {
  const id = currentId(rawId);
  if (!Number.isInteger(id)) {
    throw Error('invalid tab release target');
  }
  if (releaseOperations.has(id) || inprogress.has(id) || rendererOperations.has(id)) {
    throw Error(`tab ${id} has a conflicting discard or release operation`);
  }
  const lease = {};
  releaseOperations.set(id, lease);
  let released = false;
  return Object.freeze({
    release() {
      if (released) {
        return;
      }
      released = true;
      for (const [candidateId, candidate] of releaseOperations) {
        if (candidate === lease) {
          releaseOperations.delete(candidateId);
        }
      }
    }
  });
};
discard.withRendererGuard = (id, task) => {
  id = currentId(id);
  if (!Number.isInteger(id) || inprogress.has(id) || rendererOperations.has(id) ||
      releaseOperations.has(id) || takeoverJob(id)) {
    const error = Error(`tab ${id} has a conflicting discard operation`);
    error.code = 'DISCARD_OPERATION_BLOCKED';
    return Promise.reject(error);
  }
  rendererOperations.add(id);
  return Promise.resolve().then(task).finally(() => {
    rendererOperations.delete(id);
    rendererOperations.delete(currentId(id));
  });
};
const retireTakeoverJob = job => {
  for (const [id, candidate] of takeoverJobs) {
    if (candidate === job) {
      takeoverJobs.delete(id);
    }
  }
};
const takeoverSnapshot = () => Object.freeze([...new Set(takeoverJobs.values())].map(job => {
  const id = currentId(job.id);
  // Return new, minimal records. Callers can scope/cancel a job without gaining
  // access to its cancellation token, scheduler callback, promise, or live Map.
  const tab = Object.freeze({
    id,
    index: job.tab?.index,
    windowId: job.tab?.windowId
  });
  return Object.freeze({
    id,
    started: job.started === true,
    tab
  });
}));

discard.takeover = (tab, {manual = false} = {}) => {
  const id = currentId(tab && tab.id);
  if (!Number.isInteger(id)) {
    return Promise.reject(Error('invalid tab for discard takeover'));
  }
  const existing = takeoverJob(id);
  if (existing) {
    return existing.promise;
  }
  // Ordinary discard reserves its id synchronously before its first await.
  // Never let a frozen/direct takeover interleave persistence and native work
  // with that renderer-marking transaction.
  if (inprogress.has(id) || rendererOperations.has(id) || releaseOperations.has(id)) {
    return Promise.reject(Error(`ordinary discard is already in progress for tab ${id}`));
  }

  const token = {cancelled: false};
  const job = {id, started: false, tab: {...tab, id}, token};
  const execute = async () => {
    job.started = true;
    const live = await withTimeout(getTab(job.id), discard.getTimeout, undefined);
    if (!live || live.active === true) {
      throw Error(`tab ${job.id} is no longer an inactive takeover target`);
    }
    job.tab = {...live};
    let lastError;
    for (let pass = 0; pass < discard.takeoverRetries && token.cancelled === false; pass += 1) {
      const state = await ownership.status(job.id);
      if (state.marker?.source === 'contended' && manual !== true) {
        throw Error(`automatic discard takeover stopped after contention on tab ${job.id}`);
      }
      if (!state.attemptId && state.marker?.state === 'owned' && state.marker.source === 'self') {
        return true;
      }
      if (state.attemptId) {
        try {
          if (await waitForOwnership(job.id, token)) {
            return true;
          }
        }
        catch (e) {
          lastError = e;
          continue;
        }
      }
      try {
        const takeoverResult = await takeoverOnce({...job.tab, id: job.id}, token);
        if (takeoverResult) {
          return takeoverResult;
        }
      }
      catch (e) {
        lastError = e;
        // Emit only a bounded stage code under the existing opt-in debug
        // preference. Browser evidence can diagnose races without exposing
        // tab IDs, URLs, raw errors, or page data.
        log('discard takeover failure stage', takeoverFailureStage(e));
      }
    }
    if (!token.cancelled) {
      const current = await withTimeout(getTab(job.id), discard.getTimeout, undefined);
      if (isDiscardedTab(current) && token.directNative !== true) {
        await ownership.deferTakeover(job.id);
      }
    }
    throw lastError || Error(`discard takeover cancelled for tab ${job.id}`);
  };

  const start = async () => {
    job.queueId = await ownership.queueTakeover(job.tab, token);
    if (!job.queueId || token.cancelled) {
      throw Error(`discard takeover cancelled before scheduling tab ${job.id}`);
    }
    const scheduled = takeoverScheduler.schedule(execute, {
      // Only Edge frozen targets need the user-visible focus domain. Ordinary
      // discarded wake/stop jobs do not activate a tab and may use the bounded
      // global pool concurrently, even when they share a window.
      // Frozen takeovers are direct native operations and never enter the
      // focus domain. The scheduler therefore needs no per-window lock.
      key: undefined
    });
    job.cancelScheduled = scheduled.cancel;
    job.rekeyScheduled = scheduled.rekey;
    return scheduled.promise;
  };
  job.promise = start().finally(async () => {
    if (job.queueId) {
      await ownership.clearQueuedTakeover(job.id, job.queueId).catch(() => false);
    }
    if (job.token.nativeOperation && job.token.nativeSettled !== true) {
      // A timed-out browser discard may still complete physically. Keep this
      // transaction visible to release scopes until that operation reaches an
      // actual boundary; otherwise the target disappears while awake and can
      // be re-discarded after release has already reported success.
      void job.token.nativeOperation.then(
        () => retireTakeoverJob(job),
        () => retireTakeoverJob(job)
      );
    }
    else {
      retireTakeoverJob(job);
    }
  });
  takeoverJobs.set(id, job);
  return job.promise;
};

// Popup adoption commands can join the exact physical job instead of relying
// on a duplicated timeout that cannot account for queue or storage latency.
discard.waitForTakeover = id => takeoverJob(id)?.promise;

discard.cancelTakeover = async id => {
  const job = takeoverJob(id);
  if (!job) {
    return false;
  }
  job.token.cancelled = true;
  // A queued job has not woken or touched the tab yet. Its cancellation token
  // makes it safe to release immediately instead of waiting behind unrelated
  // takeovers in the global serialization queue.
  if (job.started === false) {
    await ownership.invalidate(job.id);
    job.cancelScheduled?.(`discard takeover cancelled for tab ${job.id}`);
    if (takeoverJobs.get(job.id) === job) {
      takeoverJobs.delete(job.id);
    }
    return true;
  }
  const jobFenceTimeout = {};
  const jobSettled = await withTimeout(
    Promise.resolve(job.promise).then(() => true, () => true),
    discard.releaseNativeFenceTimeout,
    jobFenceTimeout
  );
  if (jobSettled === jobFenceTimeout) {
    throw Error(`cannot safely release tab ${job.id}: native discard operation is still pending`);
  }
  if (job.token.nativeOperation && job.token.nativeSettled !== true) {
    const timedOut = {};
    const settled = await withTimeout(
      Promise.resolve(job.token.nativeOperation).then(() => true, () => true),
      discard.releaseNativeFenceTimeout,
      timedOut
    );
    if (settled === timedOut) {
      throw Error(`cannot safely release tab ${job.id}: native discard operation is still pending`);
    }
  }
  // Once the direct physical boundary is definitive, release may remove the
  // old marker before performing its single explicit reload. A fence timeout
  // deliberately leaves direct-native-pending durable so every retry remains
  // a no-op until Edge finally settles.
  await ownership.invalidate(job.id);
  return true;
};

// Reset is a global barrier, so drain the live job registry rather than taking
// a one-shot snapshot. Jobs that were still persisting their queue marker when
// cancellation began are already present in the Map and are fenced by their
// token; any job added while a running takeover settles is caught on the next
// pass before ownership storage is erased.
discard.cancelTakeovers = async () => {
  const cancelled = new Set();
  while (takeoverJobs.size) {
    const jobs = [...new Set(takeoverJobs.values())];
    await Promise.all(jobs.map(async job => {
      if (await discard.cancelTakeover(job.id)) {
        cancelled.add(job);
      }
    }));
  }
  return cancelled.size;
};

// Only resume a takeover that this worker had already woken before MV3 stopped
// it. Do not sweep and reload every pre-existing external discard at startup.
discard.recoverTakeovers = async () => {
  const tabs = await query({
    url: '*://*/*',
    active: false
  });
  const targets = (await Promise.all(tabs.map(async tab => {
    const state = await ownership.status(tab.id);
    const recovery = isLoadedTab(tab) && state.marker?.state === 'takeover-recovery';
    const queued = isSuspendedTab(tab) &&
      state.marker?.state === 'takeover-queued';
    return recovery || queued ? tab : undefined;
  }))).filter(Boolean);
  return Promise.all(targets.map(tab => discard.takeover(tab).catch(e => {
    log('discard takeover failed', e);
    return false;
  })));
};

discard.recoverOrdinaryDiscards = () => ordinaryIntents.recover({
  getTab: id => withTimeout(getTab(id), discard.getTimeout, undefined),
  resolveId: currentId,
  resume: (tab, intentId) => discard(tab, {intentId})
});

chrome.tabs.onRemoved?.addListener(id => {
  void ordinaryIntents.removed(id).catch(() => false);
  if (currentId(id) !== id) {
    return;
  }
  const job = takeoverJob(id);
  if (job) {
    job.token.cancelled = true;
    job.token.removed = true;
    // A queued job has never touched the removed tab. Reject it immediately so
    // it cannot retain scheduler memory, an MV3 recovery marker, or its public
    // snapshot until an unrelated running head eventually finishes.
    if (job.started === false) {
      job.cancelScheduled?.(`discard takeover target ${job.id} was removed`);
      if (takeoverJobs.get(job.id) === job) {
        takeoverJobs.delete(job.id);
      }
    }
  }
});
chrome.tabs.onReplaced?.addListener((addedId, removedId) => {
  void ordinaryIntents.replace(removedId, addedId).catch(() => false);
  const job = takeoverJobs.get(removedId);
  if (job) {
    takeoverJobs.delete(removedId);
    job.id = currentId(addedId);
    job.tab = {...job.tab, id: job.id};
    takeoverJobs.set(job.id, job);
  }
  if (inprogress.delete(removedId)) {
    inprogress.add(currentId(addedId));
  }
  // Queued ordinary jobs hold their original snapshot until the active slot
  // drains. Move that snapshot with the ownership lineage as well as the Set
  // reservation; otherwise the internal resume deletes only the predecessor
  // lock and immediately skips the live successor as already in progress.
  for (const queued of discard.tabs) {
    if (queued?.tab?.id === removedId) {
      queued.tab = {...queued.tab, id: currentId(addedId)};
    }
  }
  if (rendererOperations.delete(removedId)) {
    rendererOperations.add(currentId(addedId));
  }
  const releaseLease = releaseOperations.get(removedId);
  if (releaseLease) {
    releaseOperations.delete(removedId);
    releaseOperations.set(currentId(addedId), releaseLease);
  }
});
chrome.tabs.onAttached?.addListener((id, info) => {
  const job = takeoverJob(id);
  if (!job || !Number.isInteger(info?.newWindowId)) {
    return;
  }
  const focusSensitive = isFrozenTab(job.tab);
  job.tab = {
    ...job.tab,
    windowId: info.newWindowId,
    ...(Number.isInteger(info.newPosition) && {index: info.newPosition})
  };
  if (job.started === false) {
    job.rekeyScheduled?.(focusSensitive ? `window:${info.newWindowId}` : undefined);
  }
  else if (focusSensitive) {
    // An in-flight focus/reload operation cannot safely transfer its window
    // lock. Abort it; a later explicit command can retry in the new window.
    job.token.cancelled = true;
  }
});
chrome.tabs.onMoved?.addListener((id, info) => {
  const job = takeoverJob(id);
  if (!job || !Number.isInteger(info?.toIndex)) {
    return;
  }
  job.tab = {
    ...job.tab,
    index: info.toIndex,
    ...(Number.isInteger(info.windowId) && {windowId: info.windowId})
  };
});

discard.perform = async (tab, visual = undefined) => {
  let attemptId;
  const rollback = () => restoreLiveDocumentMarker(tab.id, visual?.rollbackToken).catch(() => false);
  if (await ownership.hasBlockingNativeIntent(tab.id).catch(() => true)) {
    return discardOutcome('skipped', tab, 'direct native discard is still settling');
  }
  try {
    // The pending tag is persisted before Chromium receives the discard call.
    attemptId = await ownership.begin(tab);
  }
  catch (e) {
    log('discard ownership tagging failed', e);
    await rollback();
    return discardOutcome('failed', tab, `ownership tagging failed: ${e?.message || String(e)}`);
  }
  if (!attemptId) {
    await rollback();
    return discardOutcome('failed', tab, 'ownership tagging did not start');
  }

  const timeout = {};
  const lateAuthority = ownership.lateAuthority(tab.id);
  const nativeOperation = nativeDiscard(tab);
  let outcome = await withTimeout(nativeOperation, discard.nativeTimeout, timeout);
  if (outcome === timeout) {
    const fenceTimeout = {};
    outcome = await withTimeout(nativeOperation, discard.takeoverFenceTimeout, fenceTimeout);
    if (outcome === fenceTimeout) {
      outcome = timeout;
    }
  }

  const accepted = outcome !== timeout && outcome?.accepted === true;
  const token = {cancelled: false};
  let current = accepted ? await waitForUnloaded(tab.id, token) :
    await withTimeout(getTab(tab.id), discard.getTimeout, undefined);
  const settled = accepted && isNativeDiscardSettled(current);
  const source = settled ? 'self' : undefined;

  const failureReason = outcome?.error || (outcome === timeout ? 'native discard timed out' :
    (!settled ? 'native discard did not settle in the browser discard state' : undefined));
  if (failureReason) {
    log('discarding failed', failureReason);
  }

  try {
    const owned = await ownership.finish(current || tab, attemptId, source, {
      allowClaimed: !accepted,
      lateNative: outcome === timeout,
      visual
    });
    if (outcome === timeout) {
      reconcileLateNative(
        nativeOperation,
        lateAuthority,
        attemptId,
        visual,
        visual?.rollbackToken
      );
    }
    if (source && owned === false) {
      await rollback();
      return discardOutcome('failed', current || tab, 'ownership finalization rejected the settled discard', {
        native: nativeProvenance(outcome)
      });
    }
    if (settled && owned && await ownership.confirmSelf(current.id, attemptId) === false) {
      await rollback();
      return discardOutcome('failed', current || tab, 'tab woke during ownership finalization', {
        native: nativeProvenance(outcome)
      });
    }
  }
  catch (e) {
    log('discard ownership finalization failed', e);
    await rollback();
    return discardOutcome('failed', current || tab,
      `ownership finalization failed: ${e?.message || String(e)}`, {native: nativeProvenance(outcome)});
  }
  if (!settled && outcome !== timeout) {
    await rollback();
  }
  return settled ? discardOutcome('succeeded', current, 'native discard settled', {
    native: nativeProvenance(outcome)
  }) : discardOutcome('failed', current || tab, failureReason || 'native discard did not settle', {
    native: nativeProvenance(outcome)
  });
};

discard.recoverInterruptedPulse = async () => {
  const recovery = await pulseRecovery.recover();
  if (Number.isInteger(recovery.targetId) && recovery.status !== 'deferred') {
    // Recovery never changes the live selection. Remove the interrupted
    // attempt so the ordinary takeover startup scan cannot turn a preserved
    // user-visible target into a delayed discard after worker eviction.
    await ownership.invalidate(recovery.targetId);
  }
  return recovery;
};
discard.nativeTimeout = 5000;
discard.getTimeout = 1000;
discard.takeoverTimeout = 5000;
discard.takeoverPoll = 50;
discard.takeoverRetries = 1;
discard.takeoverFenceTimeout = 10000;
discard.releaseNativeFenceTimeout = 10000;
discard.nativeSettleTimeout = 5000;
discard.nativeStableDwell = 50;
discard.quiesceDwell = 100;
discard.reloadStartGrace = 250;
discard.stopTimeout = 1000;
discard.titleSettleTimeout = 1000;
discard.transientFrameRetries = 2;
discard.cancellationSettleTimeout = 2000;
discard.cancellationStableDwell = 100;
discard.activationEventGrace = 50;
discard.transientFocusStartGrace = 100;
discard.transientFocusReturnTimeout = 2000;
// Rollback can queue behind the same bounded visual preparation it revokes.
// Match that operation's budget so a timeout after a renderer-side title write
// still has time to run the exact-token cleanup; this never authorizes a retry
// or a second native discard.
discard.markerRollbackTimeout = 5000;
discard.sideEffectProbeTimeout = 1000;
discard.takeoverSnapshot = takeoverSnapshot;
discard.takeoverScheduler = takeoverScheduler;

export {discard, inprogress};
