const STORAGE_KEY = '__popupCommandActivity';
const SNAPSHOT_VERSION = 1;
const DEFAULT_RESULT_TTL = 30_000;
const DEFAULT_RUNNING_TTL = 5 * 60_000;

const POPUP_CODES = Object.freeze({
  BUSY: 'POPUP_BUSY',
  CANCELLED: 'POPUP_CANCELLED',
  COMMAND_FAILED: 'POPUP_COMMAND_FAILED',
  INTERRUPTED: 'POPUP_INTERRUPTED',
  NO_ACTIVE_TAB: 'POPUP_NO_ACTIVE_TAB',
  TARGET_CHANGED: 'POPUP_TARGET_CHANGED',
  TAB_ALREADY_OWNED: 'TAB_ALREADY_OWNED',
  TAB_ALREADY_OWNED_VISUAL_UNAVAILABLE: 'TAB_ALREADY_OWNED_VISUAL_UNAVAILABLE',
  TAB_CANCELLED: 'TAB_CANCELLED',
  TAB_DISCARDED: 'TAB_DISCARDED',
  TAB_DISCARDED_VISUAL_UNAVAILABLE: 'TAB_DISCARDED_VISUAL_UNAVAILABLE',
  TAB_FAILED: 'TAB_FAILED',
  TAB_MISSING: 'TAB_MISSING',
  TAB_NO_SAFE_KEEPER: 'TAB_NO_SAFE_KEEPER',
  TAB_OWNERSHIP_UNKNOWN: 'TAB_OWNERSHIP_UNKNOWN',
  TAB_PROTECTED: 'TAB_PROTECTED',
  TAB_RELEASED: 'TAB_RELEASED',
  TAB_RELEASE_REMAINS_FROZEN: 'TAB_RELEASE_REMAINS_FROZEN',
  TAB_SKIPPED: 'TAB_SKIPPED',
  TAB_SUSPENSION_UNKNOWN: 'TAB_SUSPENSION_UNKNOWN',
  TAB_UNSUPPORTED: 'TAB_UNSUPPORTED'
});

const terminalStates = new Set(['cancelled', 'complete', 'failed', 'interrupted', 'partial']);
const statusPriority = Object.freeze({skipped: 1, success: 2, failed: 3});

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const tabId = value => Number.isInteger(value) ? value :
  Number.isInteger(value?.tab?.id) ? value.tab.id :
    Number.isInteger(value?.id) ? value.id :
      Number.isInteger(value?.tabId) ? value.tabId : undefined;
const scopeKey = request => Number.isInteger(request?.windowId) ? `window:${request.windowId}` :
  Number.isInteger(request?.tabId) ? `tab:${request.tabId}` : 'current-window';
const fingerprint = request => [
  request?.cmd || '',
  Number.isInteger(request?.tabId) ? request.tabId : '',
  Number.isInteger(request?.windowId) ? request.windowId : '',
  request?.shiftKey === true ? 1 : 0,
  request?.checked === true ? 1 : request?.checked === false ? 0 : ''
].join(':');

const classifyPopupError = error => {
  if (error?.code && Object.values(POPUP_CODES).includes(error.code)) {
    return error.code;
  }
  const message = error?.message || String(error || '');
  if (/\bno active tab\b/i.test(message)) {
    return POPUP_CODES.NO_ACTIVE_TAB;
  }
  if (/\bpopup target changed\b/i.test(message)) {
    return POPUP_CODES.TARGET_CHANGED;
  }
  return POPUP_CODES.COMMAND_FAILED;
};

const provisionalTaskFailureCode = error =>
  error?.code === POPUP_CODES.TAB_RELEASE_REMAINS_FROZEN ?
    POPUP_CODES.TAB_RELEASE_REMAINS_FROZEN : POPUP_CODES.TAB_FAILED;

const trackPopupTabTask = (progress, task, successCode) => async (tab, ...args) => {
  if (!progress) {
    return task(tab, ...args);
  }
  await progress.addTargets([tab]);
  progress.throwIfCancelled();
  try {
    const value = await task(tab, ...args);
    const retainedFrozen = value?.code === POPUP_CODES.TAB_RELEASE_REMAINS_FROZEN;
    const failed = retainedFrozen || value === false ||
      value?.status === 'failed' || value?.status === 'skipped';
    await progress.settle(
      retainedFrozen && Number.isInteger(value?.tab?.id) ? value.tab : tab,
      failed ? 'failed' : 'success',
      retainedFrozen ? POPUP_CODES.TAB_RELEASE_REMAINS_FROZEN :
        failed ? POPUP_CODES.TAB_FAILED : successCode
    );
    return value;
  }
  catch (error) {
    await progress.settle(
      Number.isInteger(error?.tab?.id) ? error.tab : tab,
      progress.cancelled() ? 'skipped' : 'failed',
      progress.cancelled() ? POPUP_CODES.TAB_CANCELLED : provisionalTaskFailureCode(error)
    );
    throw error;
  }
};

const summary = outcomes => {
  const counts = {failed: 0, skipped: 0, success: 0};
  for (const entry of Object.values(outcomes || {})) {
    if (Object.hasOwn(counts, entry.status)) {
      counts[entry.status] += 1;
    }
  }
  return counts;
};

const storageAdapter = area => ({
  read: () => new Promise(resolve => {
    if (!area?.get) {
      resolve(undefined);
      return;
    }
    try {
      area.get({[STORAGE_KEY]: undefined}, values => {
        void globalThis.chrome?.runtime?.lastError;
        resolve(values?.[STORAGE_KEY]);
      });
    }
    catch (error) {
      resolve(undefined);
    }
  }),
  write: value => new Promise(resolve => {
    if (!area?.set) {
      resolve();
      return;
    }
    try {
      area.set({[STORAGE_KEY]: value}, () => {
        void globalThis.chrome?.runtime?.lastError;
        resolve();
      });
    }
    catch (error) {
      resolve();
    }
  })
});

const entries = value => value && value.version === SNAPSHOT_VERSION &&
  value.snapshots && typeof value.snapshots === 'object' ? value.snapshots : {};

const createPopupProgressManager = ({
  now = () => Date.now(),
  publish = async () => {},
  resolveId = id => id,
  resultTtl = DEFAULT_RESULT_TTL,
  runningTtl = DEFAULT_RUNNING_TTL,
  store = storageAdapter(globalThis.chrome?.storage?.session)
} = {}) => {
  const active = new Map();
  const snapshots = new Map();
  let hydrated;
  let sequence = 0;
  let writeChain = Promise.resolve();

  const persist = snapshot => {
    if (snapshot) {
      snapshots.set(snapshot.scope, clone(snapshot));
    }
    const current = now();
    for (const [scope, value] of snapshots) {
      if (Number(value.expiresAt) <= current) {
        snapshots.delete(scope);
      }
    }
    const envelope = {
      snapshots: Object.fromEntries([...snapshots].map(([scope, value]) => [scope, clone(value)])),
      version: SNAPSHOT_VERSION
    };
    writeChain = writeChain.then(() => store.write(envelope)).catch(() => {});
    return writeChain;
  };

  const emit = async snapshot => {
    snapshot.updatedAt = now();
    snapshot.summary = summary(snapshot.outcomes);
    snapshot.completed = Object.keys(snapshot.outcomes).length;
    snapshot.total = Math.max(snapshot.total, snapshot.completed);
    await persist(snapshot);
    try {
      await publish(clone(snapshot));
    }
    catch (error) {}
  };

  const hydrate = () => hydrated ||= (async () => {
    const current = now();
    const stored = entries(await store.read());
    for (const [scope, original] of Object.entries(stored)) {
      if (!original || Number(original.expiresAt) <= current) {
        continue;
      }
      const snapshot = clone(original);
      if (!terminalStates.has(snapshot.state)) {
        snapshot.state = 'interrupted';
        snapshot.errorCode = POPUP_CODES.INTERRUPTED;
        snapshot.endedAt = current;
        snapshot.expiresAt = current + resultTtl;
        for (const id of snapshot.targetIds || []) {
          if (!snapshot.outcomes?.[id]) {
            snapshot.outcomes ||= {};
            snapshot.outcomes[id] = {
              code: POPUP_CODES.TAB_SKIPPED,
              status: 'skipped',
              tabId: Number(id)
            };
          }
        }
        snapshot.summary = summary(snapshot.outcomes);
        snapshot.completed = Object.keys(snapshot.outcomes).length;
        snapshot.total = Math.max(snapshot.total || 0, snapshot.completed);
      }
      snapshots.set(scope, snapshot);
    }
    await persist();
  })();

  const publicSnapshot = snapshot => clone(snapshot);

  const contextFor = job => {
    const {snapshot, token} = job;
    // Task wrappers emit useful provisional outcomes before the shared command
    // pipeline has handled lifecycle races. A final classification may replace
    // that provisional value exactly once; after that, normal status priority
    // prevents a contradictory lower-severity final array from hiding failure.
    const authoritativeIds = new Set();
    const canonicalId = value => {
      const id = tabId(value);
      if (!Number.isInteger(id)) {
        return undefined;
      }
      try {
        const current = resolveId(id);
        return Number.isInteger(current) ? current : id;
      }
      catch (error) {
        return id;
      }
    };
    const canonicalizeSet = set => {
      const current = [...set];
      set.clear();
      current.forEach(value => {
        const id = canonicalId(value);
        if (Number.isInteger(id)) {
          set.add(id);
        }
      });
    };
    const canonicalizeLineage = () => {
      let changed = false;
      const targetIds = [];
      const seen = new Set();
      for (const value of snapshot.targetIds || []) {
        const id = canonicalId(value);
        if (Number.isInteger(id) && !seen.has(id)) {
          seen.add(id);
          targetIds.push(id);
        }
      }
      if (targetIds.length !== snapshot.targetIds.length ||
          targetIds.some((id, index) => id !== snapshot.targetIds[index])) {
        snapshot.targetIds = targetIds;
        changed = true;
      }

      const originalAuthoritative = new Set(authoritativeIds);
      const outcomes = {};
      const winners = new Map();
      for (const [key, value] of Object.entries(snapshot.outcomes || {})) {
        const sourceId = Number.isInteger(value?.tabId) ? value.tabId : Number(key);
        const id = canonicalId(Number.isInteger(sourceId) ? sourceId : value);
        if (!Number.isInteger(id)) {
          continue;
        }
        const candidate = {...value, tabId: id};
        const authoritative = originalAuthoritative.has(sourceId);
        const previous = winners.get(id);
        if (!previous || (authoritative && !previous.authoritative) ||
            (authoritative === previous.authoritative &&
              (statusPriority[candidate.status] || 0) >
              (statusPriority[previous.value.status] || 0))) {
          winners.set(id, {authoritative, value: candidate});
        }
      }
      for (const [id, winner] of winners) {
        outcomes[id] = winner.value;
      }
      if (JSON.stringify(outcomes) !== JSON.stringify(snapshot.outcomes || {})) {
        snapshot.outcomes = outcomes;
        changed = true;
      }
      canonicalizeSet(authoritativeIds);
      return changed;
    };
    const addTargets = async tabs => {
      let changed = canonicalizeLineage();
      for (const value of tabs || []) {
        const id = canonicalId(value);
        if (Number.isInteger(id) && snapshot.targetIds.includes(id) === false) {
          snapshot.targetIds.push(id);
          changed = true;
        }
      }
      if (changed) {
        snapshot.total = Math.max(snapshot.total, snapshot.targetIds.length);
        await emit(snapshot);
      }
      return snapshot.total;
    };
    const settle = async (tab, status, code) => {
      await addTargets([tab]);
      const id = canonicalId(tab);
      if (!Number.isInteger(id) || !Object.hasOwn(statusPriority, status)) {
        return false;
      }
      // A task wrapper can finish after the command pipeline has already
      // classified the tab. Never let that late provisional observation
      // replace a final result, even when it has a higher severity.
      if (authoritativeIds.has(id)) {
        return false;
      }
      const previous = snapshot.outcomes[id];
      if (previous && statusPriority[previous.status] >= statusPriority[status]) {
        return false;
      }
      snapshot.outcomes[id] = {code, status, tabId: id};
      await emit(snapshot);
      return true;
    };
    const settleAuthoritative = async (tab, status, code) => {
      await addTargets([tab]);
      const id = canonicalId(tab);
      if (!Number.isInteger(id) || !Object.hasOwn(statusPriority, status)) {
        return false;
      }
      const previous = snapshot.outcomes[id];
      if (authoritativeIds.has(id) && previous &&
          statusPriority[previous.status] >= statusPriority[status]) {
        return false;
      }
      snapshot.outcomes[id] = {code, status, tabId: id};
      authoritativeIds.add(id);
      await emit(snapshot);
      return true;
    };
    const mergeCheckResult = async (result, tabs = []) => {
      await addTargets(tabs);
      const byId = new Map((tabs || []).map(tab => [canonicalId(tab), tab]));
      for (const value of result?.succeeded || []) {
        await settleAuthoritative(
          byId.get(canonicalId(value)) || value, 'success', POPUP_CODES.TAB_DISCARDED
        );
      }
      for (const value of result?.failed || []) {
        await settleAuthoritative(
          byId.get(canonicalId(value)) || value, 'failed', POPUP_CODES.TAB_FAILED
        );
      }
      for (const key of ['protected', 'unsupported']) {
        for (const value of result?.[key] || []) {
          await settleAuthoritative(byId.get(canonicalId(value)) || value,
            key === 'protected' ? 'skipped' : 'failed',
            key === 'protected' ? POPUP_CODES.TAB_PROTECTED : POPUP_CODES.TAB_UNSUPPORTED);
        }
      }
    };
    const mergeResult = async result => {
      if (!result || typeof result !== 'object') {
        return;
      }
      const classifiedIds = new Set();
      const remember = value => {
        canonicalizeSet(classifiedIds);
        const id = canonicalId(value);
        if (Number.isInteger(id)) {
          classifiedIds.add(id);
        }
        return value;
      };
      for (const value of result.released || []) {
        await settleAuthoritative(remember(value), 'success', POPUP_CODES.TAB_RELEASED);
      }
      // Classify the truthful visual-unavailable disposition before generic
      // success so the duplicated succeeded entry cannot erase its warning.
      for (const value of result.physicalOnly || []) {
        await settleAuthoritative(
          remember(value), 'success', POPUP_CODES.TAB_DISCARDED_VISUAL_UNAVAILABLE
        );
      }
      for (const value of result.succeeded || []) {
        await settleAuthoritative(remember(value), 'success', POPUP_CODES.TAB_DISCARDED);
      }
      for (const value of result.failed || []) {
        await settleAuthoritative(
          remember(value),
          'failed',
          value?.code === POPUP_CODES.TAB_RELEASE_REMAINS_FROZEN ?
            POPUP_CODES.TAB_RELEASE_REMAINS_FROZEN : POPUP_CODES.TAB_FAILED
        );
      }
      for (const value of result.unsupported || []) {
        await settleAuthoritative(remember(value), 'failed', POPUP_CODES.TAB_UNSUPPORTED);
      }
      for (const value of result.unknownSuspension || []) {
        await settleAuthoritative(
          remember(value), 'failed', POPUP_CODES.TAB_SUSPENSION_UNKNOWN
        );
      }
      for (const value of result.unknownOwnership || []) {
        await settleAuthoritative(
          remember(value), 'failed', POPUP_CODES.TAB_OWNERSHIP_UNKNOWN
        );
      }
      for (const [key, code] of [
        ['alreadyOwned', POPUP_CODES.TAB_ALREADY_OWNED],
        ['alreadyOwnedPhysicalOnly', POPUP_CODES.TAB_ALREADY_OWNED_VISUAL_UNAVAILABLE],
        ['protected', POPUP_CODES.TAB_PROTECTED],
        ['skipped', POPUP_CODES.TAB_SKIPPED],
        ['missing', POPUP_CODES.TAB_MISSING]
      ]) {
        for (const value of result[key] || []) {
          await settleAuthoritative(remember(value), 'skipped', code);
        }
      }
      // Ownership retries deliberately retain earlier Error objects for audit.
      // Do not turn a recovered tab into a false failure. Only an error carrying
      // its own otherwise-unclassified tab identity is a terminal tab outcome.
      for (const value of result.errors || []) {
        canonicalizeSet(classifiedIds);
        const id = canonicalId(value);
        if (Number.isInteger(id) && !classifiedIds.has(id)) {
          await settleAuthoritative(value, 'failed', POPUP_CODES.TAB_FAILED);
        }
      }
      // A direct command with no safe keeper deliberately leaves its active
      // intent untouched while continuing independent inactive children. The
      // command result retains that active intent in candidates/takeovers, but
      // it is absent from the ordinary outcome arrays. Preserve that precise,
      // retryable disposition instead of filling the target as a generic skip.
      if (result.blocked === true) {
        const blockedTargets = [
          ...(result.candidates || []),
          ...(result.takeovers || [])
        ].filter(value => {
          canonicalizeSet(classifiedIds);
          const id = canonicalId(value);
          return value?.active === true && Number.isInteger(id) && !classifiedIds.has(id);
        });
        for (const value of blockedTargets) {
          await settleAuthoritative(
            remember(value), 'skipped', POPUP_CODES.TAB_NO_SAFE_KEEPER
          );
        }
      }
    };
    return Object.freeze({
      addTargets,
      cancelled: () => token.cancelled,
      jobId: snapshot.jobId,
      mergeCheckResult,
      mergeResult,
      settle,
      snapshot: () => publicSnapshot(snapshot),
      targetIds: () => [...snapshot.targetIds],
      throwIfCancelled() {
        if (token.cancelled) {
          const error = Error('popup command was cancelled');
          error.code = POPUP_CODES.CANCELLED;
          throw error;
        }
      }
    });
  };

  const finish = async (job, state, error) => {
    const {snapshot} = job;
    const context = job.context;
    if (error?.result) {
      await context.mergeResult(error.result);
    }
    if (state === 'cancelled') {
      for (const id of snapshot.targetIds) {
        if (!snapshot.outcomes[id]) {
          await context.settle(id, 'skipped', POPUP_CODES.TAB_CANCELLED);
        }
      }
    }
    else {
      for (const id of snapshot.targetIds) {
        if (!snapshot.outcomes[id]) {
          await context.settle(
            id,
            state === 'failed' ? 'failed' : 'skipped',
            state === 'failed' ? POPUP_CODES.TAB_FAILED : POPUP_CODES.TAB_SKIPPED
          );
        }
      }
    }
    const counts = summary(snapshot.outcomes);
    const noSafeKeeper = Object.values(snapshot.outcomes).some(
      outcome => outcome.code === POPUP_CODES.TAB_NO_SAFE_KEEPER
    );
    if (!['cancelled', 'interrupted'].includes(state) && (counts.failed > 0 || noSafeKeeper)) {
      state = counts.success > 0 ? 'partial' : 'failed';
    }
    snapshot.state = state;
    snapshot.errorCode = error ? classifyPopupError(error) : undefined;
    if (state === 'cancelled') {
      snapshot.errorCode = POPUP_CODES.CANCELLED;
    }
    snapshot.endedAt = now();
    snapshot.expiresAt = snapshot.endedAt + resultTtl;
    await emit(snapshot);
    active.delete(snapshot.scope);
    return publicSnapshot(snapshot);
  };

  const run = async (request, task, onCancel = async () => {}) => {
    await hydrate();
    const scope = scopeKey(request);
    const signature = fingerprint(request);
    const existing = active.get(scope);
    if (existing) {
      if (existing.signature === signature) {
        return existing.promise;
      }
      const error = Error('another popup command is already running in this window');
      error.code = POPUP_CODES.BUSY;
      const snapshot = publicSnapshot(existing.snapshot);
      snapshot.errorCode = POPUP_CODES.BUSY;
      return snapshot;
    }

    const startedAt = now();
    const snapshot = {
      command: request?.cmd || '',
      completed: 0,
      errorCode: undefined,
      expiresAt: startedAt + runningTtl,
      jobId: `${startedAt.toString(36)}-${(++sequence).toString(36)}`,
      outcomes: {},
      scope,
      startedAt,
      state: 'running',
      summary: {failed: 0, skipped: 0, success: 0},
      targetIds: [],
      total: 0,
      updatedAt: startedAt,
      version: SNAPSHOT_VERSION,
      windowId: Number.isInteger(request?.windowId) ? request.windowId : undefined
    };
    const job = {
      cancel: onCancel,
      context: undefined,
      promise: undefined,
      signature,
      snapshot,
      token: {cancelled: false}
    };
    job.context = contextFor(job);
    active.set(scope, job);
    job.promise = (async () => {
      await emit(snapshot);
      try {
        const result = await task(job.context);
        await job.context.mergeResult(result);
        return finish(job, job.token.cancelled ? 'cancelled' : 'complete');
      }
      catch (error) {
        const cancelled = job.token.cancelled || error?.code === POPUP_CODES.CANCELLED;
        return finish(job, cancelled ? 'cancelled' : 'failed', error);
      }
    })();
    return job.promise;
  };

  const cancel = async jobId => {
    await hydrate();
    const job = [...active.values()].find(candidate => candidate.snapshot.jobId === jobId);
    if (!job) {
      return {accepted: false};
    }
    if (job.token.cancelled) {
      return {accepted: true, snapshot: publicSnapshot(job.snapshot)};
    }
    job.token.cancelled = true;
    job.snapshot.state = 'cancelling';
    job.snapshot.errorCode = POPUP_CODES.CANCELLED;
    await emit(job.snapshot);
    try {
      await job.cancel(job.context);
    }
    catch (error) {}
    return {accepted: true, snapshot: publicSnapshot(job.snapshot)};
  };

  const snapshot = async request => {
    await hydrate();
    const scope = scopeKey(request);
    return publicSnapshot(active.get(scope)?.snapshot || snapshots.get(scope));
  };

  return Object.freeze({cancel, run, snapshot});
};

export {
  createPopupProgressManager,
  POPUP_CODES,
  SNAPSHOT_VERSION,
  STORAGE_KEY,
  storageAdapter,
  trackPopupTabTask
};
