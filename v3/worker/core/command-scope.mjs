import {selectKeeper} from './keeper.mjs';
import {markerFallback, outcome} from './marker-fallback.mjs';
import {classifySuspendedTarget} from './suspended-protection.mjs';
import {tabInAllowedWindowScope} from './window-scope.mjs';
import {suspensionState} from './browser-state.mjs';
import {FAILURE_CAUSES, failureCauseFrom} from './failure-causes.mjs';

const CURRENT_WINDOW_COMMANDS = new Set([
  'discard-window',
  'discard-rights',
  'discard-lefts',
  'release-window',
  'release-rights',
  'release-lefts'
]);
const OTHER_WINDOW_COMMANDS = new Set([
  'discard-other-windows',
  'release-other-windows'
]);
const DISCARD_COMMANDS = new Set([
  'discard-tab',
  'discard-tree',
  'discard-window',
  'discard-rights',
  'discard-lefts',
  'discard-other-windows',
  'discard-tabs'
]);
const releaseCommands = Object.freeze([
  'release-window',
  'release-rights',
  'release-lefts',
  'release-other-windows',
  'release-tabs'
]);
const RELEASE_COMMANDS = new Set(releaseCommands);
const RELEASE_REMAINS_FROZEN_CODE = 'TAB_RELEASE_REMAINS_FROZEN';
const retainedFrozenReleaseFailure = (value, fallbackTab) => ({
  code: RELEASE_REMAINS_FROZEN_CODE,
  disposition: value?.disposition || 'retained-frozen',
  reason: value?.message || value?.reason || 'tab remained frozen after release',
  retryable: true,
  tab: Number.isInteger(value?.tab?.id) ? value.tab : fallbackTab
});
const physicalTargets = new WeakMap();
const TRANSIENT_QUERY_CODES = new Set([
  'QUERY_TEMPORARILY_UNAVAILABLE',
  'TABS_QUERY_TEMPORARILY_UNAVAILABLE'
]);

const queryFailureCode = error => String(error?.code || error?.cause?.code || '').toUpperCase();
const queryCommandScope = async (query, options, {
  command = 'unknown-command',
  phase = 'initial-scope'
} = {}) => {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await query(options);
    }
    catch (cause) {
      const transient = TRANSIENT_QUERY_CODES.has(queryFailureCode(cause));
      if (transient && attempt === 1) {
        continue;
      }
      const error = new Error(
        `${command} ${phase} tab query failed: ${cause?.message || String(cause)}`,
        {cause}
      );
      error.code = 'TAB_QUERY_FAILED';
      error.failureCause = FAILURE_CAUSES.SCOPE_QUERY_FAILED;
      error.command = command;
      error.phase = phase;
      error.query = {...options};
      error.transient = transient;
      throw error;
    }
  }
};

const scopeQuery = (command, selected) => {
  const options = {
    active: false,
    windowType: 'normal'
  };
  if (CURRENT_WINDOW_COMMANDS.has(command)) {
    if (Number.isInteger(selected?.windowId)) {
      options.windowId = selected.windowId;
    }
    else {
      options.currentWindow = true;
    }
  }
  else if (OTHER_WINDOW_COMMANDS.has(command) && !Number.isInteger(selected?.windowId)) {
    options.currentWindow = false;
  }
  return options;
};

const filterScopeTabs = (command, tabs, selected) => {
  tabs = tabs.filter(tab => tabInAllowedWindowScope(tab, selected));
  if (Number.isInteger(selected?.windowId)) {
    if (CURRENT_WINDOW_COMMANDS.has(command)) {
      tabs = tabs.filter(tab => tab.windowId === selected.windowId);
    }
    else if (OTHER_WINDOW_COMMANDS.has(command)) {
      tabs = tabs.filter(tab => tab.windowId !== selected.windowId);
    }
  }
  if (command.endsWith('lefts')) {
    return tabs.filter(tab => tab.index < selected.index);
  }
  if (command.endsWith('rights')) {
    return tabs.filter(tab => tab.index > selected.index);
  }
  return tabs;
};

const snapshotTabs = snapshot => (Array.isArray(snapshot) ? snapshot : [])
  .map(entry => entry?.tab || entry)
  .filter(tab => Number.isInteger(tab?.id));

const readTakeoverSnapshot = async source => snapshotTabs(
  await (typeof source === 'function' ? source() : source)
);

const uniqueTabs = (...groups) => {
  const ids = new Set();
  return groups.flatMap(group => group || []).filter(tab => {
    if (!Number.isInteger(tab?.id) || ids.has(tab.id)) {
      return false;
    }
    ids.add(tab.id);
    return true;
  });
};

// A takeover can temporarily activate its target, which removes it from the
// normal active:false tab query. Scope only the jobs we knew about in memory;
// broadening the browser query to active tabs would risk waking unrelated work.
const scopeTakeoverTabs = (command, snapshot, selected) => {
  // Unlike browser query results, takeover records are an internal authority
  // for cancelling and reloading a temporarily active tab. Require both scope
  // fields explicitly so a legacy/incomplete record can never default into a
  // regular normal-window release.
  let tabs = snapshotTabs(snapshot).filter(tab =>
    tabInAllowedWindowScope(tab, selected, {requireExplicit: true})
  );
  if (command === 'release-tabs') {
    return tabs;
  }
  if (!selected || !Number.isInteger(selected.windowId)) {
    return [];
  }
  if (CURRENT_WINDOW_COMMANDS.has(command)) {
    tabs = tabs.filter(tab => tab.windowId === selected.windowId);
  }
  else if (OTHER_WINDOW_COMMANDS.has(command)) {
    tabs = tabs.filter(tab => tab.windowId !== selected.windowId);
  }
  return filterScopeTabs(command, tabs, selected);
};

const releaseAvailability = async (query, selected, takeoverSnapshot = []) => {
  const jobs = await readTakeoverSnapshot(takeoverSnapshot);
  return Object.fromEntries(await Promise.all(releaseCommands.map(async command => {
    if (!selected && (command.endsWith('lefts') || command.endsWith('rights'))) {
      return [command, false];
    }
    const options = scopeQuery(command, selected);
    const tabs = await queryCommandScope(query, options, {command, phase: 'availability'});
    const hasPhysicalTarget = filterScopeTabs(command, tabs, selected)
      .some(tab => tab.discarded === true || tab.frozen === true);
    return [command, hasPhysicalTarget || scopeTakeoverTabs(command, jobs, selected).length > 0];
  })));
};

// A manual discard command owns both halves of its scope: loaded tabs continue
// to the normal pipeline, while tabs suspended by another mechanism are
// physically taken over. A bookkeeping-only adoption cannot apply the portable
// title/favicon marker because an unloaded document has no renderer to update.
const resolutionError = (value, fallback) => {
  if (value instanceof Error) {
    return value;
  }
  if (value !== undefined && value !== null) {
    return Error(typeof value === 'string' ? value : String(value));
  }
  return Error(fallback);
};

const freshResolutionError = fresh => {
  if (!fresh || typeof fresh !== 'object') {
    return Error('ownership resolver returned no classification');
  }
  if (fresh.error) {
    return resolutionError(fresh.error, 'ownership resolver reported an error');
  }
  if (fresh.unstable === true) {
    return Error('ownership resolver returned an unstable live read');
  }
  if (fresh.reset === true) {
    return Error('ownership state reset during classification');
  }
  if (fresh.retry === true || fresh.busy === true) {
    return Error(`ownership resolver requested ${fresh.busy === true ? 'a retry after busy state' : 'a retry'}`);
  }
  if (fresh.state === 'loaded') {
    return fresh.tab ? undefined : Error('loaded ownership classification omitted the live tab');
  }
  if (fresh.state === 'direct-native-pending') {
    return fresh.tab && fresh.marker?.state === 'direct-native-pending' ? undefined :
      Error('direct native ownership classification omitted its durable marker or live tab');
  }
  if (fresh.state === 'direct-native-orphan') {
    return fresh.tab && fresh.nativeOrphan === true ? undefined :
      Error('orphaned native ownership classification omitted its global fence or live tab');
  }
  if (fresh.state === 'discarded') {
    if (!fresh.tab || fresh.tab.discarded !== true) {
      return Error('discarded ownership classification omitted a discarded live tab');
    }
    if (!fresh.marker || !['owned', 'direct-native-pending'].includes(fresh.marker.state)) {
      return Error('discarded ownership classification has no authoritative owner marker');
    }
    return undefined;
  }
  if (fresh.state === 'missing') {
    return undefined;
  }
  return Error(`ownership resolver returned an unknown state: ${fresh.state || '(none)'}`);
};

const resolveDiscardedOwnership = async (tab, resolveFresh, retryUnknown) => {
  const errors = [];
  const attempts = retryUnknown === true ? 2 : 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let fresh;
    try {
      fresh = await resolveFresh(tab);
    }
    catch (error) {
      errors.push(resolutionError(error, 'ownership resolution failed'));
      if (attempt < attempts) {
        continue;
      }
      return {
        attempts: attempt,
        error: errors.at(-1),
        errors,
        retryable: true,
        state: 'ownership-unknown',
        tab
      };
    }

    const error = freshResolutionError(fresh);
    if (error) {
      errors.push(error);
      if (attempt < attempts) {
        continue;
      }
      return {
        attempts: attempt,
        error,
        errors,
        retryable: true,
        state: 'ownership-unknown',
        tab: fresh?.tab || tab
      };
    }
    return {
      ...fresh,
      attempts: attempt,
      errors,
      tab: fresh.tab || tab
    };
  }
};

const prepareDiscardTargets = async (command, tabs, resolveFresh, {
  hasBlockingNativeIntent = async () => false,
  retryUnknown = false
} = {}) => {
  if (!DISCARD_COMMANDS.has(command)) {
    throw Error(`Unknown discard command: ${command}`);
  }

  const resolved = await Promise.all(tabs.map(async tab => {
    const classify = current => ({
      ...markerFallback(current),
      tab: current
    });
    // Edge Sleeping Tabs are frozen while still memory-loaded. Treat that as an
    // existing suspension, not as an ordinary loaded candidate: the controlled
    // takeover wakes it once, applies our marker, then performs the native
    // discard. Missing `frozen` remains compatible with older Chromium builds.
    const initialFallback = classify(tab);
    if (initialFallback.kind === 'unsupported') {
      return {state: 'unsupported', ...initialFallback};
    }
    // Consult the global native fence before every inactive physical or
    // renderer classification. An unattributed orphan is deliberately not
    // tied to one successor, so even a loaded-looking/restricted candidate
    // must not reach scripting or another native discard while it exists.
    let nativeIntentBlocked = false;
    if (tab.active !== true) {
      try {
        nativeIntentBlocked = await hasBlockingNativeIntent(tab.id);
      }
      catch (error) {
        return {
          error: resolutionError(error, 'ownership resolution failed'),
          errors: [resolutionError(error, 'ownership resolution failed')],
          retryable: true,
          state: 'ownership-unknown',
          tab
        };
      }
    }
    if (nativeIntentBlocked) {
      return {
        marker: {state: 'direct-native-pending'},
        reason: 'direct native discard is still settling; no wake or retry was attempted',
        state: 'direct-native-pending',
        tab
      };
    }
    // Restricted renderer schemes have an authoritative, browser-independent
    // physical fallback. Chromium can expose `frozen: null` for a fully loaded
    // file/PDF/internal tab; do not let that optional-field drift turn a known
    // protected/native path into an unclassified skip.
    if (tab.discarded !== true && initialFallback.kind === 'physical-only') {
      return {state: 'physical-only', ...initialFallback};
    }
    const browserState = suspensionState(tab);
    if (browserState.kind === 'active') {
      return {state: 'active', tab};
    }
    if (browserState.kind === 'unknown') {
      return {state: 'suspension-unknown', tab, reason: browserState.reason};
    }
    // Check every inactive snapshot before deciding that it is an ordinary
    // loaded/frozen candidate. Edge briefly exposes an accepted direct native
    // discard as both discarded:false and frozen:false; classifying that gap
    // from physical flags alone would script or discard it a second time.
    if (tab.discarded !== true && tab.frozen === true) {
      const fresh = typeof resolveFresh === 'function' ?
        await resolveFresh(tab).catch(() => undefined) : undefined;
      if (fresh?.marker?.state === 'direct-native-pending') {
        return {
          ...fresh,
          reason: 'direct native discard is still settling; no wake or retry was attempted',
          state: 'direct-native-pending',
          tab: fresh.tab || tab
        };
      }
      return {state: 'frozen', tab};
    }
    if (tab.discarded !== true) {
      return {state: 'loaded', tab};
    }
    const fresh = await resolveDiscardedOwnership(tab, resolveFresh, retryUnknown);
    const current = fresh?.tab || tab;
    const fallback = classify(current);
    return {...fresh, fallback, tab: current};
  }));
  const candidates = resolved.filter(result => result?.state === 'loaded').map(result => result.tab);
  const discarded = resolved.filter(result => result?.state === 'discarded');
  const directNativePending = discarded.filter(
    result => result.marker?.state === 'direct-native-pending'
  );
  directNativePending.push(...resolved.filter(result => result.state === 'direct-native-pending'));
  directNativePending.push(...resolved.filter(result => result.state === 'direct-native-orphan'));
  const missingLiveTitleMarker = result => {
    const expected = result.marker?.visual?.titleMarker;
    if (typeof expected !== 'string' || !expected) {
      return false;
    }
    const title = String(result.tab?.title ?? '').normalize('NFC');
    return title !== expected && !title.startsWith(`${expected} `);
  };
  const needsMarkerRepair = result => result.marker?.state === 'owned' &&
    result.marker.source === 'self' && result.marker.visual?.repair === true &&
    result.fallback?.kind === 'scriptable' &&
    (result.marker.visual.complete === false || missingLiveTitleMarker(result));
  const alreadyOwned = discarded
    .filter(result => result.marker?.state === 'owned' && result.marker.source === 'self' &&
      !needsMarkerRepair(result) && !(result.marker.visual?.physicalOnly === true &&
        result.marker.visual?.complete === false &&
        result.marker.visual?.repair === false))
    .map(result => result.tab);
  const alreadyOwnedPhysicalOnly = discarded
    .filter(result => result.marker?.state === 'owned' && result.marker.source === 'self' &&
      result.marker.visual?.physicalOnly === true && result.marker.visual?.complete === false &&
      result.marker.visual?.repair === false)
    .map(result => outcome(
      result.tab,
      'already extension-owned; frozen renderer visual remains unavailable'
    ));
  // A stable native discard and its portable title/favicon signal are separate
  // postconditions. Older records have no `visual` field and remain complete;
  // an explicitly incomplete self marker is eligible for one bounded repair
  // takeover instead of becoming a permanent no-op.
  const markerRepairs = discarded
    .filter(needsMarkerRepair)
    .map(result => result.tab);
  const takeovers = resolved.filter(result => result?.state === 'frozen').map(result => result.tab);
  takeovers.push(...discarded
    .filter(result => result.fallback?.kind !== 'physical-only' &&
      result.fallback?.kind !== 'unsupported' &&
      result.state !== 'direct-native-orphan' &&
      result.marker?.state !== 'direct-native-pending' &&
      (result.marker?.state !== 'owned' ||
        !['self', 'physical-only'].includes(result.marker.source)))
    .map(result => result.tab));
  takeovers.push(...markerRepairs);
  const errors = resolved.flatMap(result => result?.errors || []);
  const unknownOwnership = resolved
    .filter(result => result.state === 'ownership-unknown')
    .map(result => ({
      attempts: result.attempts,
      error: result.error,
      reason: `${result.attempts > 1 ? 'ownership resolution retry failed' :
        'ownership resolution failed'}: ${result.error?.message || String(result.error)}`,
      retryable: true,
      tab: result.tab
    }));
  const physicalOnly = discarded
    .filter(result => result.fallback?.kind === 'physical-only' ||
      result.marker?.source === 'physical-only')
    .filter(result => result.state !== 'direct-native-orphan')
    .filter(result => result.marker?.state !== 'direct-native-pending')
    .filter(result => !(result.marker?.state === 'owned' && result.marker.source === 'self'))
    .map(result => outcome(
      result.tab,
      `${result.fallback?.reason || 'interrupted direct native takeover'}; ` +
        'tab is already physically discarded'
    ));
  const pendingPhysical = resolved
    .filter(result => result.state === 'physical-only')
    .map(result => outcome(result.tab, result.reason));
  const unsupported = [
    ...resolved
      .filter(result => result.state === 'unsupported')
      .map(result => outcome(result.tab, result.reason)),
    ...discarded
      .filter(result => result.fallback?.kind === 'unsupported')
      .map(result => outcome(result.tab, result.fallback.reason))
  ];
  const unknownSuspension = resolved
    .filter(result => result.state === 'suspension-unknown')
    .map(result => outcome(result.tab, result.reason));
  const result = {
    alreadyOwned,
    alreadyOwnedPhysicalOnly,
    bypassed: [],
    candidates,
    errors,
    failed: unknownOwnership.map(entry => ({
      failureCause: FAILURE_CAUSES.OWNERSHIP_RESOLUTION_FAILED,
      reason: entry.reason,
      retryable: true,
      tab: entry.tab
    })),
    markerRepairs,
    physicalOnly,
    protected: directNativePending.map(entry => outcome(
      entry.tab,
      'direct native discard is still settling; no wake or retry was attempted'
    )),
    succeeded: [],
    takeovers,
    unknownOwnership,
    unknownSuspension,
    unsupported
  };
  physicalTargets.set(result, pendingPhysical);
  return result;
};

const pendingPhysicalTabs = result => (physicalTargets.get(result) || []).map(entry => entry.tab);

const pushOutcome = (result, key, entry) => {
  result[key] ||= [];
  const duplicate = result[key].some(current => current.tab?.id === entry.tab?.id &&
    current.reason === entry.reason);
  if (!duplicate) {
    result[key].push(entry);
  }
};
const failedOutcome = (tab, reason, source, fallback) => ({
  ...outcome(tab, reason),
  failureCause: failureCauseFrom(source, fallback)
});

const protectSuspendedTargets = async (result, suspendedPolicy, shiftKey) => {
  // Keeping this hook optional preserves pure callers and lets embedders that do
  // not own preference storage choose their own policy provider explicitly.
  if (suspendedPolicy === undefined || result.takeovers.length === 0) {
    return result;
  }

  let policy;
  try {
    policy = await (typeof suspendedPolicy === 'function' ? suspendedPolicy() : suspendedPolicy);
    if (!policy || typeof policy !== 'object') {
      throw Error('suspended protection policy is unavailable');
    }
  }
  catch (error) {
    const reason = `suspended protection policy failed: ${error?.message || String(error)}`;
    if (shiftKey === true) {
      result.bypassed.push(...result.takeovers.map(tab => ({tab, reason, reasons: [reason]})));
    }
    else {
      result.takeovers.forEach(tab => pushOutcome(result, 'protected', {
        tab,
        reason,
        reasons: [reason]
      }));
      result.takeovers = [];
    }
    return result;
  }

  const permitted = [];
  for (const tab of result.takeovers) {
    const decision = classifySuspendedTarget(tab, policy, {shiftKey});
    if (decision.protected) {
      pushOutcome(result, 'protected', {
        tab,
        reason: decision.reason,
        reasons: decision.reasons
      });
    }
    else {
      permitted.push(tab);
      if (decision.bypassed) {
        result.bypassed.push({
          tab,
          reason: decision.reasons.join('; '),
          reasons: decision.reasons
        });
      }
    }
  }
  result.takeovers = permitted;
  return result;
};

const tabForOutcome = (entry, tabs) => {
  if (Number.isInteger(entry)) {
    return tabs.find(tab => tab.id === entry);
  }
  if (entry?.tab) {
    return entry.tab;
  }
  if (Number.isInteger(entry?.id)) {
    return entry;
  }
};

// Accept only an explicit success contract. Missing, malformed, and unknown
// outcomes fail closed instead of becoming a false command success.
const discardAccepted = value => value === true || value?.status === 'succeeded' || value?.ok === true;
const discardFailureReason = (value, fallback) => value?.reason || fallback;

const settleLoadedDiscards = async (result, tabs, discard, label = 'loaded discard') => {
  const settled = await Promise.all(tabs.map(async tab => {
    try {
      const accepted = await discard(tab);
      return discardAccepted(accepted) === false ? {
        failureCause: failureCauseFrom(accepted),
        reason: discardFailureReason(accepted, `${label} returned false`),
        state: 'failed',
        tab
      } : {state: 'succeeded', tab};
    }
    catch (error) {
      return {
        failureCause: failureCauseFrom(error),
        reason: `${label} failed: ${error?.message || String(error)}`,
        state: 'failed',
        tab
      };
    }
  }));

  for (const entry of settled) {
    pushOutcome(result, entry.state, entry.state === 'failed' ?
      {...outcome(entry.tab, entry.reason), failureCause: entry.failureCause} : {tab: entry.tab});
  }
  return settled;
};

const mergeCheckOutcomes = (result, checked, tabs) => {
  for (const entry of checked?.succeeded || []) {
    const tab = tabForOutcome(entry, tabs);
    if (tab) {
      pushOutcome(result, 'succeeded', {tab});
    }
  }
  for (const entry of checked?.failed || []) {
    const tab = tabForOutcome(entry, tabs);
    if (tab) {
      pushOutcome(result, 'failed', failedOutcome(
        tab,
        entry?.reason || 'normal discard returned false',
        entry,
        FAILURE_CAUSES.METADATA_CHECK_FAILED
      ));
    }
  }
  for (const key of ['protected', 'unsupported']) {
    for (const entry of checked?.[key] || []) {
      const tab = tabForOutcome(entry, tabs);
      if (tab) {
        pushOutcome(result, key, outcome(tab, entry?.reason || `normal discard classified tab as ${key}`));
      }
    }
  }
};

const runCheckedDiscards = async (result, tabs, check) => {
  try {
    const checked = await check(tabs);
    if (checked === false) {
      tabs.forEach(tab => pushOutcome(result, 'failed', failedOutcome(
        tab,
        'normal discard check returned false',
        undefined,
        FAILURE_CAUSES.METADATA_CHECK_FAILED
      )));
    }
    else {
      mergeCheckOutcomes(result, checked, tabs);
    }
  }
  catch (error) {
    tabs.forEach(tab => pushOutcome(result, 'failed', failedOutcome(
      tab,
      `normal discard check failed: ${error?.message || String(error)}`,
      error,
      FAILURE_CAUSES.METADATA_CHECK_FAILED
    )));
  }
};

const finishLoadedOutcomes = result => {
  if (result.failed.length > 0 && result.succeeded.length === 0) {
    const takeoverOnly = result.failed.every(entry =>
      String(entry.reason || '').startsWith('discard takeover failed:'));
    const error = new AggregateError(
      result.failed.map(entry => Error(`tab ${entry.tab?.id}: ${entry.reason}`)),
      takeoverOnly ? `all ${result.failed.length} intended discard takeovers failed` :
        `all ${result.failed.length} intended loaded tab discards failed`
    );
    error.result = result;
    throw error;
  }
  return result;
};

const settlePhysicalTargets = async (result, discard, {
  allow = () => true,
  protectedReason = 'normal discard cannot inspect this tab; use Shift to force a native discard'
} = {}) => {
  const pending = physicalTargets.get(result) || [];
  physicalTargets.delete(result);
  const permitted = [];

  for (const entry of pending) {
    if (allow(entry.tab)) {
      permitted.push(entry);
    }
    else {
      result.protected.push(outcome(entry.tab, `${entry.reason}; ${protectedReason}`));
    }
  }

  const settled = await Promise.all(permitted.map(async entry => {
    try {
      const accepted = await discard(entry.tab);
      return discardAccepted(accepted) ? {entry, state: 'physical-only'} : {
        entry,
        reason: `${entry.reason}; ${discardFailureReason(accepted, 'native discard was rejected')}`,
        state: 'unsupported'
      };
    }
    catch (error) {
      return {
        entry,
        reason: `${entry.reason}; native discard failed: ${error?.message || String(error)}`,
        state: 'unsupported'
      };
    }
  }));

  for (const entry of settled) {
    if (entry.state === 'physical-only') {
      result.physicalOnly.push(entry.entry);
      pushOutcome(result, 'succeeded', {tab: entry.entry.tab});
    }
    else {
      result.unsupported.push(outcome(entry.entry.tab, entry.reason));
    }
  }
  return result;
};

const CHANGED_TAKEOVER_TARGET = /\bis no longer an inactive takeover target\b/;
const runTakeovers = async (tabs, takeover, {
  onAwake = async () => {},
  onFailure = async () => {},
  onSkipped = async () => {},
  onSuccess = async () => {},
  refresh = async tab => tab,
} = {}) => {
  if (tabs.length === 0) {
    return [];
  }
  const settled = await Promise.allSettled(tabs.map(async tab => {
    try {
      const value = await takeover(tab);
      if (discardAccepted(value)) {
        await onSuccess(tab, value);
      }
      return value;
    }
    catch (error) {
      // A takeover can wait behind another queued job after the preflight read.
      // Its first authoritative read reports this exact condition before it has
      // woken or modified the tab, so it is safe to route the now-loaded target
      // back through the command's normal/forced loaded behavior.
      if (CHANGED_TAKEOVER_TARGET.test(error?.message || String(error))) {
        const current = await refresh(tab);
        if (!current) {
          await onSkipped(current, tab);
          return true;
        }
        if (current.discarded !== true && current.frozen !== true) {
          if (current.active === true) {
            await onSkipped(current, tab);
            return true;
          }
          await onAwake(current, tab);
          return true;
        }
      }
      throw error;
    }
  }));
  for (const [index, entry] of settled.entries()) {
    if (entry.status === 'rejected' || discardAccepted(entry.value) === false) {
      const reason = entry.status === 'rejected' ?
        entry.reason?.message || String(entry.reason) :
        entry.value?.reason || 'takeover returned false';
      await onFailure(tabs[index], `discard takeover failed: ${reason}`, entry);
    }
  }
  return settled.map(result => result.value);
};

// A tab can wake after the ownership snapshot was prepared but before its
// queued takeover begins. Take one final live read at the scope boundary so an
// already-awake tab returns to the command's ordinary loaded path instead of
// turning a benign lifecycle race into a failed popup command. Frozen tabs are
// still suspended and must remain on the controlled Edge takeover path.
const refreshTakeoverTargets = async (result, refresh = async tab => tab) => {
  if (result.takeovers.length === 0) {
    return result;
  }
  const refreshed = await Promise.all(result.takeovers.map(async tab => {
    try {
      const current = await refresh(tab);
      if (!current) {
        return {state: 'missing', tab};
      }
      if (current.discarded !== true && current.frozen !== true) {
        if (current.active === true) {
          return {state: 'active', tab: current};
        }
        return {state: 'loaded', tab: current};
      }
      return {state: 'takeover', tab: current};
    }
    catch (error) {
      // Preserve the original takeover behavior on a transient refresh error;
      // its own authoritative live read still decides whether it can proceed.
      result.errors.push(error);
      return {state: 'takeover', tab};
    }
  }));

  result.candidates.push(...refreshed
    .filter(entry => entry.state === 'loaded')
    .map(entry => entry.tab));
  result.takeovers = refreshed
    .filter(entry => entry.state === 'takeover')
    .map(entry => entry.tab);
  result.missing = [
    ...(result.missing || []),
    ...refreshed.filter(entry => entry.state === 'missing').map(entry => entry.tab)
  ];
  result.skipped = [
    ...(result.skipped || []),
    ...refreshed.filter(entry => entry.state === 'active').map(entry => entry.tab)
  ];
  return result;
};

const recordSkippedTakeover = (result, current, original) => {
  result.takeovers = result.takeovers.filter(candidate => candidate.id !== original.id);
  const target = current || original;
  const key = current ? 'skipped' : 'missing';
  result[key] ||= [];
  if (result[key].some(candidate => candidate.id === target.id) === false) {
    result[key].push(target);
  }
};

const recordTakeoverSuccess = (result, tab, value) => {
  const current = value?.tab || tab;
  if (value?.physicalOnly === true && value.visualUnavailable === true) {
    pushOutcome(result, 'physicalOnly', {
      reason: value.reason || 'native discard completed without waking the frozen renderer',
      tab: current,
      visualUnavailable: value.visualUnavailable === true
    });
  }
  pushOutcome(result, 'succeeded', {tab: current});
};

const recordTakeoverFailure = (result, tab, reason, settled) => {
  const source = settled?.status === 'rejected' ? settled.reason : settled?.value;
  pushOutcome(result, 'failed', {
    ...outcome(tab, reason),
    failureCause: failureCauseFrom(source, FAILURE_CAUSES.TAKEOVER_FAILED)
  });
};

const commitDirectScope = async (commitScope, result, targets) => {
  if (typeof commitScope !== 'function') {
    return undefined;
  }
  const committed = await commitScope();
  if (committed?.valid !== true) {
    const reason = committed?.reason || 'selected tab-group scope changed before execution';
    const error = Error(reason);
    error.result = {
      ...result,
      blocked: true,
      scopeChanged: true,
      skipped: [...targets]
    };
    throw error;
  }

  // Preserve classification references while refreshing authoritative browser
  // fields such as active, groupId, windowId, index, discarded, and frozen.
  const live = new Map((committed.targets || []).map(tab => [tab.id, tab]));
  for (const target of targets) {
    const current = live.get(target.id);
    if (current) {
      Object.assign(target, current);
    }
  }
  return committed;
};

// The selected-tab and tab-group rows need an active keeper before Chromium
// permits their active target to be discarded. Keeping this path here makes
// the first two popup commands exercise the same tested ownership preparation.
const runDirectDiscardCommand = async ({
  activate,
  allTabs,
  command,
  commitScope,
  discard,
  hasBlockingNativeIntent,
  inProgress,
  notifyNoKeeper,
  refresh = async tab => tab,
  resolveFresh,
  selected,
  shiftKey,
  suspendedPolicy,
  takeover,
  targets
}) => {
  // createWindowScope() is the authority that admitted this direct command to
  // a normal browser window. commitScope deliberately refreshes `selected`
  // from chrome.tabs.get(), whose Tabs.Tab shape has no windowType field, so
  // preserve the admitted type before that refresh instead of weakening the
  // takeover's required native scope.
  const takeoverWindowType = selected?.windowType === 'normal' ? 'normal' : undefined;
  const scopedTakeover = tab => takeover({
    ...tab,
    ...(takeoverWindowType && {windowType: takeoverWindowType})
  });
  const result = await prepareDiscardTargets(command, targets, resolveFresh, {
    hasBlockingNativeIntent,
    retryUnknown: shiftKey === true
  });
  await refreshTakeoverTargets(result, refresh);
  await protectSuspendedTargets(result, suspendedPolicy, shiftKey);
  result.adopted = [];
  let keeper;

  // Membership may change while ownership and policy reads are queued. This
  // fence is immediately before the executor is allowed to move focus.
  const committed = await commitDirectScope(commitScope, result, targets);
  if (committed) {
    allTabs = committed.allTabs;
    selected = committed.selected;
  }

  if ([
    ...result.candidates,
    ...result.takeovers,
    ...pendingPhysicalTabs(result)
  ].some(tab => tab.active)) {
    const ids = new Set(targets.map(tab => tab.id));
    keeper = selectKeeper(allTabs, selected, {
      inProgress,
      targetIds: ids
    });

    if (!keeper) {
      notifyNoKeeper();
      // The active root cannot be discarded without somewhere safe to move
      // focus, but that must not suppress independent inactive children.
      const inactive = result.candidates.filter(tab => tab.active !== true);
      await Promise.all([
        settleLoadedDiscards(result, inactive, discard),
        settlePhysicalTargets(result, discard, {
          allow: tab => tab.active !== true,
          protectedReason: 'active target has no safe keeper'
        }),
        runTakeovers(result.takeovers.filter(tab => tab.active !== true), scopedTakeover, {
          onAwake: (tab, original) => {
            result.takeovers = result.takeovers.filter(candidate => candidate.id !== original.id);
            result.candidates.push(tab);
            return settleLoadedDiscards(result, [tab], discard);
          },
          onFailure: (tab, reason, settled) => recordTakeoverFailure(result, tab, reason, settled),
          onSkipped: (tab, original) => recordSkippedTakeover(result, tab, original),
          onSuccess: (tab, value) => recordTakeoverSuccess(result, tab, value),
          refresh
        })
      ]);
      return finishLoadedOutcomes({...result, blocked: true, keeper: null});
    }
    await activate(keeper);
    [
      ...result.candidates,
      ...result.takeovers,
      ...pendingPhysicalTabs(result)
    ].forEach(tab => tab.active = false);
  }

  await Promise.all([
    settleLoadedDiscards(result, [...result.candidates], discard),
    settlePhysicalTargets(result, discard),
    runTakeovers(result.takeovers, scopedTakeover, {
      onAwake: (tab, original) => {
        result.takeovers = result.takeovers.filter(candidate => candidate.id !== original.id);
        result.candidates.push(tab);
        return settleLoadedDiscards(result, [tab], discard);
      },
      onFailure: (tab, reason, settled) => recordTakeoverFailure(result, tab, reason, settled),
      onSkipped: (tab, original) => recordSkippedTakeover(result, tab, original),
      onSuccess: (tab, value) => recordTakeoverSuccess(result, tab, value),
      refresh
    })
  ]);
  return finishLoadedOutcomes({...result, blocked: false, keeper});
};

// Chromium's discarded:false event is the authoritative ownership cleanup.
// Clearing immediately after reload() could erase a newer concurrent discard.
const releaseDiscardedTargets = async (
  command,
  tabs,
  reload,
  options = {},
  cancelTakeover = async () => {},
  refresh = async tab => tab,
  refreshScope,
  release
) => {
  if (!RELEASE_COMMANDS.has(command)) {
    throw Error(`Unknown release command: ${command}`);
  }
  // A takeover's wake phase is discarded:false, so cancel every tab in the
  // selected release scope before deciding which live tabs still need reload.
  await Promise.all(tabs.map(cancelTakeover));
  // Edge may replace a tab id while cancellation is settling. Re-querying the
  // whole live scope avoids looking up a stale predecessor and silently
  // skipping its discarded successor. Direct helper callers retain the
  // per-target refresh fallback.
  const live = refreshScope ? await refreshScope() : await Promise.all(tabs.map(refresh));
  const targets = live.filter(tab => tab?.discarded === true || tab?.frozen === true);
  const settled = await Promise.all(targets.map(async tab => {
    try {
      // Production callers use the shared release helper. It follows Edge tab
      // replacement lineage and does not resolve until the successor has been
      // observed loaded twice. The legacy pair remains injectable for focused
      // command-scope tests and embedders.
      const value = typeof release === 'function' ?
        await release(tab, options) :
        tab.discarded === true ? await reload(tab, options) :
          (() => { throw Error(`frozen tab ${tab.id} requires the shared verified release helper`); })();
      if (value?.code === RELEASE_REMAINS_FROZEN_CODE) {
        return {failed: retainedFrozenReleaseFailure(value, tab)};
      }
      if (value === false) {
        throw Error(`tab ${tab.id} did not complete release`);
      }
      return {released: value && typeof value === 'object' ? value : tab};
    }
    catch (error) {
      if (error?.code === RELEASE_REMAINS_FROZEN_CODE) {
        return {failed: retainedFrozenReleaseFailure(error, tab)};
      }
      return {
        failed: {
          failureCause: failureCauseFrom(error, FAILURE_CAUSES.RELEASE_FAILED),
          reason: error?.message || String(error),
          tab
        }
      };
    }
  }));
  return {
    failed: settled.filter(entry => entry.failed).map(entry => entry.failed),
    released: settled.filter(entry => entry.released).map(entry => entry.released)
  };
};

// This is the shared execution path for all five bulk rows and their X controls.
// Tests exercise this same function, not a parallel reconstruction of menu.mjs.
const runScopedCommand = async ({
  cancelTakeover,
  check,
  command,
  discard,
  hasBlockingNativeIntent,
  query,
  refresh,
  release,
  reload,
  resolveFresh,
  selected,
  shiftKey,
  suspendedPolicy,
  takeoverSnapshot = [],
  takeover,
}) => {
  const options = scopeQuery(command, selected);
  const scopedTakeover = tab => takeover({
    ...tab,
    ...(options.windowType && {windowType: options.windowType})
  });
  const queried = await queryCommandScope(query, options, {command, phase: 'initial-scope'});
  const scopedJobs = RELEASE_COMMANDS.has(command) ?
    scopeTakeoverTabs(command, await readTakeoverSnapshot(takeoverSnapshot), selected) : [];
  const tabs = uniqueTabs(filterScopeTabs(command, queried, selected), scopedJobs);

  if (DISCARD_COMMANDS.has(command)) {
    const result = await prepareDiscardTargets(command, tabs, resolveFresh, {
      hasBlockingNativeIntent,
      retryUnknown: shiftKey === true
    });
    await refreshTakeoverTargets(result, refresh);
    await protectSuspendedTargets(result, suspendedPolicy, shiftKey);
    result.adopted = [];
    if (shiftKey) {
      await Promise.all([
        settlePhysicalTargets(result, discard),
        runTakeovers(result.takeovers, scopedTakeover, {
          onAwake: (tab, original) => {
            result.takeovers = result.takeovers.filter(candidate => candidate.id !== original.id);
            result.candidates.push(tab);
            return settleLoadedDiscards(result, [tab], discard);
          },
          onFailure: (tab, reason, settled) => recordTakeoverFailure(result, tab, reason, settled),
          onSkipped: (tab, original) => recordSkippedTakeover(result, tab, original),
          onSuccess: (tab, value) => recordTakeoverSuccess(result, tab, value),
          refresh
        }),
        settleLoadedDiscards(result, [...result.candidates], discard)
      ]);
    }
    else {
      const candidates = [...result.candidates];
      await Promise.all([
        settlePhysicalTargets(result, discard, {allow: () => false}),
        runTakeovers(result.takeovers, scopedTakeover, {
          onAwake: (tab, original) => {
            result.takeovers = result.takeovers.filter(candidate => candidate.id !== original.id);
            result.candidates.push(tab);
            return runCheckedDiscards(result, [tab], check);
          },
          onFailure: (tab, reason, settled) => recordTakeoverFailure(result, tab, reason, settled),
          onSkipped: (tab, original) => recordSkippedTakeover(result, tab, original),
          onSuccess: (tab, value) => recordTakeoverSuccess(result, tab, value),
          refresh
        }),
        candidates.length ? runCheckedDiscards(result, candidates, check) : Promise.resolve()
      ]);
    }
    return finishLoadedOutcomes(result);
  }
  if (RELEASE_COMMANDS.has(command)) {
    const refreshTab = typeof refresh === 'function' ? refresh : async tab => tab;
    return releaseDiscardedTargets(
      command,
      tabs,
      reload,
      {bypassCache: shiftKey === true},
      cancelTakeover,
      refresh,
      async () => uniqueTabs(
        filterScopeTabs(command, await queryCommandScope(query, options, {
          command,
          phase: 'release-refresh'
        }), selected),
        (await Promise.all(scopedJobs.map(refreshTab))).filter(Boolean)
      ),
      release
    );
  }
  throw Error(`Unknown scoped command: ${command}`);
};

export {
  filterScopeTabs,
  prepareDiscardTargets,
  queryCommandScope,
  releaseAvailability,
  releaseCommands,
  releaseDiscardedTargets,
  runDirectDiscardCommand,
  runScopedCommand,
  scopeTakeoverTabs,
  scopeQuery
};
