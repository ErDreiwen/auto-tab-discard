import {discard} from './discard.mjs';
import {ownership} from './ownership.mjs';
import {isDiscardedTab, isFrozenTab, isLoadedTab, isSuspendedTab} from './browser-state.mjs';

const TAB_RELEASE_REMAINS_FROZEN = 'TAB_RELEASE_REMAINS_FROZEN';
const TAB_RELEASE_NATIVE_PENDING = 'TAB_RELEASE_NATIVE_PENDING';

const createReleaseHelper = ({
  cancelTakeover = id => discard.cancelTakeover(id),
  getStatus = id => ownership.status(id),
  invalidate = id => ownership.invalidate(id),
  reserveRelease = id => discard.reserveRelease(id),
  resolveId = id => ownership.resolveId(id),
  runtime = () => chrome.runtime,
  tabs = () => chrome.tabs,
  takeoverSnapshot = () => discard.takeoverSnapshot(),
  withNativeMutationGuard = (task, id) => ownership.withNativeMutationGuard(task, id)
} = {}) => {
  const callTab = (method, ...args) => new Promise((resolve, reject) => {
    let settled = false;
    const done = value => {
      if (settled) {
        return;
      }
      settled = true;
      const error = runtime().lastError;
      if (error) {
        reject(Error(error.message || error));
      }
      else {
        resolve(value);
      }
    };

    try {
      const operation = tabs()[method](...args, done);
      if (operation?.then) {
        operation.then(done, error => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
      }
    }
    catch (error) {
      reject(error);
    }
  });

  const readTab = id => callTab('get', id).catch(error => {
    // A removed/replaced predecessor is re-resolved by the retry loop. Preserve
    // genuine API failures for the caller when no live successor exists.
    if (resolveId(id) !== id || /no tab|not found|invalid tab/i.test(error.message)) {
      return undefined;
    }
    throw error;
  });

  // Edge can accept reload() and immediately replace the discarded tab, then
  // report a callback/Promise error against the predecessor even though the
  // requested navigation is already underway. The invocation itself is an
  // at-most-once boundary: never retry it from an API error. Instead, consume
  // that error and let waitForRelease() decide the outcome from authoritative
  // replacement-aware browser state. A synchronous throw happens before the
  // browser accepts the operation and remains a direct failure.
  const invokeReloadOnce = (id, options) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = accepted => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(accepted);
    };
    const done = () => {
      const error = runtime().lastError;
      finish(!error);
    };

    try {
      const operation = tabs().reload(id, options, done);
      if (operation?.then) {
        operation.then(() => finish(true), () => finish(false));
      }
    }
    catch (error) {
      reject(error);
    }
  });

  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const stableLoaded = tab => isLoadedTab(tab) &&
    (tab.status === undefined || tab.status === 'complete');
  const stableRetainedFrozen = tab => tab?.active !== true && tab?.discarded === false &&
    tab?.frozen === true && tab?.status === 'complete';
  const releaseDisposition = tab => stableLoaded(tab) ? 'loaded' :
    stableRetainedFrozen(tab) ? 'retained-frozen' : undefined;
  const changedFrom = (initial, current) => current?.id !== initial?.id ||
    current?.active !== initial?.active || current?.discarded !== initial?.discarded ||
    current?.frozen !== initial?.frozen || current?.status !== initial?.status;

  const waitForRelease = async (originalId, initial, accepted, options) => {
    let lastId;
    let lastDisposition;
    let progressed = false;
    let stableReads = 0;
    for (let attempt = 0; attempt < options.polls; attempt += 1) {
      const id = resolveId(originalId);
      const current = await readTab(id);
      if (!current) {
        if (attempt + 1 >= options.polls) {
          throw Error(`tab ${id} no longer exists`);
        }
        await delay(options.interval);
        continue;
      }
      progressed ||= changedFrom(initial, current);
      const disposition = releaseDisposition(current);
      if (disposition) {
        stableReads = current.id === lastId && disposition === lastDisposition ? stableReads + 1 : 1;
        // A successful callback/Promise is browser acceptance evidence. When
        // Edge reports an error against a replaced predecessor, require an
        // independently observed state/identity transition before trusting the
        // final snapshot. An unchanged frozen row after a callback error is not
        // evidence that reload was accepted.
        if (stableReads >= options.stableReads && (accepted || progressed)) {
          return {disposition, tab: current};
        }
      }
      else {
        stableReads = 0;
      }
      lastId = current.id;
      lastDisposition = disposition;
      await delay(options.interval);
    }
    if (!accepted && !progressed) {
      const error = Error(`tab ${resolveId(originalId)} reload was not accepted and made no observable progress`);
      error.code = 'TAB_RELEASE_NOT_ACCEPTED';
      throw error;
    }
    throw Error(`tab ${resolveId(originalId)} did not settle loaded after release`);
  };

  const retainedFrozenError = tab => {
    const error = Error(`tab ${tab.id} remained frozen after its single release reload`);
    error.code = TAB_RELEASE_REMAINS_FROZEN;
    error.disposition = 'retained-frozen';
    error.retryable = true;
    error.tab = tab;
    return error;
  };

  // Release callers hand over a snapshot, but Edge may replace its id before
  // the job runs. Resolve lineage before cancellation and again before the
  // single wake. Ownership is invalidated only after two stable release-state
  // reads, including Edge's truthful retained-frozen disposition.
  const releaseTab = async (tab, options = {}) => {
    const originalId = tab && tab.id;
    if (!Number.isInteger(originalId)) {
      throw Error('invalid tab release target');
    }
    const settings = {
      bypassCache: false,
      interval: releaseTab.interval,
      polls: releaseTab.polls,
      stableReads: releaseTab.stableReads,
      ...options
    };
    settings.stableReads = Math.max(2, Number.isInteger(settings.stableReads) ? settings.stableReads : 2);
    // Acquire before the first await. The lease is shared with ordinary
    // renderer work and direct takeovers, so nothing can begin on this tab in
    // the cancel -> live-read -> reload gaps. Replacement remapping is handled
    // by discard's lineage listener.
    const releaseReservation = reserveRelease(originalId);
    try {
    const ownershipState = await getStatus(originalId);
    const ownershipToken = ownershipState.attemptId || ownershipState.marker?.attemptId;
    const sameOwnership = current => {
      if (ownershipToken) {
        return current.attemptId === ownershipToken || current.marker?.attemptId === ownershipToken;
      }
      const marker = ownershipState.marker;
      return Boolean(marker && current.marker?.state === marker.state && current.marker?.source === marker.source &&
        current.marker?.updatedAt === marker.updatedAt);
    };

    // Scope callers may have cancelled once before re-querying replacement
    // lineage, but another takeover can start in that gap. Re-cancel while the
    // release lease is held; skipCancel is only a legacy caller hint and is
    // never authority to bypass this per-tab fence.
    await cancelTakeover(resolveId(originalId));
    // Cancellation can prove that a queued/direct job never reached the
    // native API and clear its durable intent. Conversely, a direct job can
    // publish that intent while release is joining it. Always classify the
    // post-cancel marker; the pre-cancel snapshot is only an identity fence
    // for the final invalidation.
    const postCancelOwnership = await getStatus(resolveId(originalId));
    if (postCancelOwnership.nativeOrphan === true ||
        postCancelOwnership.marker?.state === 'direct-native-orphan') {
      // A killed worker can lose the only authoritative onReplaced edge after
      // persisting native intent. The remaining session-global orphan is not
      // evidence that any particular live tab is its successor. Do not even
      // read or reload the caller's candidate: release stays fail-closed until
      // an observed replacement, an explicit reset, or the browser-session
      // boundary resolves the fence.
      const error = Error('cannot safely release tab: native discard lineage is unresolved');
      error.code = TAB_RELEASE_NATIVE_PENDING;
      error.disposition = 'native-pending';
      error.retryable = false;
      throw error;
    }
    const directPending = postCancelOwnership.marker?.state === 'direct-native-pending';
    let id = resolveId(originalId);
    let current = await readTab(id);
    id = resolveId(originalId);
    if (!current || current.id !== id) {
      current = await readTab(id);
    }
    if (!current) {
      throw Error(`tab ${id} no longer exists`);
    }

    // After an MV3 restart there may be no live takeover job to join. The
    // persisted direct-native intent is still an absolute physical fence:
    // frozen and inactive both-false states can precede Edge's delayed
    // discarded/unloaded replacement, so release must not reload or erase it.
    if (directPending && !isDiscardedTab(current)) {
      throw Error(`cannot safely release tab ${id}: direct native discard is still pending`);
    }
    if (directPending && (current.status !== 'unloaded' || current.active === true)) {
      throw Error(`cannot safely release tab ${id}: direct native discard is not settled`);
    }

    let accepted = true;
    if (isDiscardedTab(current) || isFrozenTab(current)) {
      // A release is the one operation that intentionally wakes a physical
      // discard. Use exactly one browser reload for both unloaded and Edge
      // frozen states. Never re-enter the activation-pulse unfreeze path: a
      // cancelled direct-native takeover can be frozen before its native call,
      // and selecting it here would reintroduce the focus/RAM regression.
      accepted = await withNativeMutationGuard(() =>
        invokeReloadOnce(id, {bypassCache: settings.bypassCache}),
      id
      ).catch(error => {
        if (error?.code === 'DIRECT_NATIVE_ORPHAN_BLOCKED') {
          const blocked = Error('cannot safely release tab: native discard lineage is unresolved');
          blocked.code = TAB_RELEASE_NATIVE_PENDING;
          blocked.disposition = 'native-pending';
          blocked.retryable = false;
          throw blocked;
        }
        throw error;
      });
    }
    else if (!stableLoaded(current)) {
      throw Error(`tab ${id} is not a releasable suspended tab`);
    }

    const settled = await waitForRelease(originalId, current, accepted, settings);
    // discarded:false may already have cleaned the original marker. Only
    // invalidate if that same identity remains; never erase a newer discard
    // attempt that began while this release was settling.
    if (sameOwnership(await getStatus(settled.tab.id))) {
      await invalidate(settled.tab.id);
    }
    if (settled.disposition === 'retained-frozen') {
      throw retainedFrozenError(settled.tab);
    }
    return settled.tab;
    }
    finally {
      releaseReservation?.release?.();
    }
  };

  releaseTab.interval = 25;
  releaseTab.polls = 200;
  releaseTab.stableReads = 2;

  const releaseMatching = async (queried = [], predicate = () => true) => {
    const candidates = new Map();
    for (const tab of queried || []) {
      if (Number.isInteger(tab?.id) && predicate(tab) &&
          isSuspendedTab(tab)) {
        candidates.set(resolveId(tab.id), tab);
      }
    }
    // A running takeover disappears from discarded:true queries during its
    // wake phase. Union its exact public snapshot, refresh it by lineage, then
    // cancel/release through the same helper as every other candidate.
    for (const job of await Promise.resolve(takeoverSnapshot()) || []) {
      const snapshot = job?.tab || job;
      if (!Number.isInteger(snapshot?.id)) {
        continue;
      }
      const live = await readTab(resolveId(snapshot.id));
      if (live && predicate(live)) {
        candidates.set(live.id, live);
      }
    }
    return Promise.all([...candidates.values()].map(tab => releaseTab(tab)));
  };

  return {
    getTab: readTab,
    releaseMatching,
    releaseTab,
    releaseTabs: tabs => Promise.all((tabs || []).map(tab => releaseTab(tab)))
  };
};

const {getTab, releaseMatching, releaseTab, releaseTabs} = createReleaseHelper();

export {
  TAB_RELEASE_NATIVE_PENDING,
  TAB_RELEASE_REMAINS_FROZEN,
  createReleaseHelper,
  getTab,
  releaseMatching,
  releaseTab,
  releaseTabs
};
