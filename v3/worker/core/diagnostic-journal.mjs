import {POPUP_CODES} from './popup-progress.mjs';
import {
  FAILURE_CAUSES,
  failureCauseFrom,
  failureCausePolicy,
  matchesFailureCausePolicy
} from './failure-causes.mjs';

const DIAGNOSTIC_FORMAT = 'auto-tab-discard-diagnostic-journal';
const DIAGNOSTIC_VERSION = 2;
const LEGACY_DIAGNOSTIC_VERSION = 1;
const DIAGNOSTIC_STORAGE_KEY = '__diagnosticJournal';
const DIAGNOSTIC_CHUNK_FORMAT = 'auto-tab-discard-diagnostic-chunk';
const DIAGNOSTIC_CHUNK_VERSION = 1;
const DIAGNOSTIC_CHUNK_LAYOUT = 'chunked-v1';
const DIAGNOSTIC_CHUNK_STORAGE_PREFIX = `${DIAGNOSTIC_STORAGE_KEY}.chunk.`;
const DIAGNOSTIC_SESSION_FORMAT = 'auto-tab-discard-diagnostic-session';
const DIAGNOSTIC_SESSION_VERSION = 1;
const DIAGNOSTIC_SESSION_STORAGE_KEY = '__diagnosticBrowserSession';
const MAX_DIAGNOSTIC_BYTES = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC_EVENTS = 10_000;
const MAX_DIAGNOSTIC_INCIDENTS = MAX_DIAGNOSTIC_EVENTS;
const MAX_DIAGNOSTIC_SESSIONS = 64;
const MAX_DIAGNOSTIC_CHUNK_BYTES = 24 * 1024;
const MAX_DIAGNOSTIC_CHUNK_RECORDS = 64;
const DIAGNOSTIC_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const DIAGNOSTIC_STORAGE_TIMEOUT = 2000;

const SAFE_COMMANDS = new Set([
  'discard-lefts', 'discard-other-windows', 'discard-rights', 'discard-tab',
  'discard-tabs', 'discard-tree', 'discard-window', 'release-lefts',
  'release-other-windows', 'release-rights', 'release-tabs', 'release-window'
]);
const DIAGNOSTIC_COMMANDS = Object.freeze([
  ...SAFE_COMMANDS,
  'automatic-discard', 'automatic-scan', 'external-discard',
  'open-tab-then-discard', 'auto-discardable', 'toggle-allowed',
  'whitelist-domain', 'whitelist-session', 'move-previous', 'move-next', 'close',
  'settings-import', 'settings-reset', 'startup-recovery', 'takeover-recovery',
  'worker-startup'
]);
const SAFE_DIAGNOSTIC_COMMANDS = new Set(DIAGNOSTIC_COMMANDS);
const DIAGNOSTIC_EVENT_TYPES = Object.freeze({
  ACTION_END: 'ACTION_END',
  ACTION_RETRY: 'ACTION_RETRY',
  ACTION_STAGE: 'ACTION_STAGE',
  ACTION_START: 'ACTION_START',
  ACTION_TIMEOUT: 'ACTION_TIMEOUT',
  RECOVERY_END: 'RECOVERY_END',
  RECOVERY_START: 'RECOVERY_START',
  REQUEST: 'REQUEST',
  RESET_END: 'RESET_END',
  RESET_START: 'RESET_START',
  RESPONSE: 'RESPONSE',
  UI_ACTION: 'UI_ACTION',
  WORKER_START: 'WORKER_START'
});
const DIAGNOSTIC_SOURCES = Object.freeze([
  'popup', 'options', 'context-menu', 'toolbar', 'keyboard', 'runtime',
  'automatic', 'automatic-alarm', 'automatic-startup', 'settings', 'reset',
  'external', 'worker', 'recovery'
]);
const DIAGNOSTIC_PHASES = Object.freeze([
  'admission', 'command', 'scope-query', 'eligibility', 'metadata-check', 'keeper',
  'ownership', 'ownership-resolution', 'native-discard', 'verification',
  'visual-marker', 'takeover', 'tab-operation', 'release', 'ownership-finalization',
  'completion', 'startup', 'storage', 'reset', 'settings',
  'CLICK', 'SEND', 'RESPONSE', 'RETRY', 'CANCEL', 'EXPORT', 'CLEAR', 'SCAN'
]);
const DIAGNOSTIC_OUTCOMES = Object.freeze([
  'STARTED', 'PROGRESS', 'RETRYING', 'TIMED_OUT', 'SUCCEEDED', 'COMPLETED',
  'PARTIAL', 'SKIPPED', 'FAILED', 'DENIED', 'CANCELLED', 'INTERRUPTED'
]);
const DIAGNOSTIC_UI_ACTIONS = Object.freeze([
  'SHOW_DIAGNOSTICS', 'COPY_DIAGNOSTICS', 'DOWNLOAD_LATEST',
  'DOWNLOAD_CURRENT_SESSION', 'DOWNLOAD_ALL_HISTORY', 'CLEAR_DIAGNOSTICS',
  'RETRY_COMMAND', 'CANCEL_COMMAND', 'EXPORT_SUPPORT_BUNDLE', 'OPEN_OPTIONS',
  'RUN_CONFLICT_SCAN', 'REMOVE_CONFLICT_SCAN_ACCESS', 'ENABLE_FRAME_ACCESS',
  'DISABLE_FRAME_ACCESS', 'SAVE_SETTINGS', 'RESET_SETTINGS', 'EXPORT_SETTINGS',
  'IMPORT_SETTINGS', 'OPEN_SUPPORT', 'TOGGLE_TEMP_DISABLE', 'TOGGLE_AUTODISCARD',
  'COMMAND_CONTROL', 'SETTING_CONTROL', 'PLUGIN_CONTROL', 'SITE_RULE_CONTROL',
  'OPEN_POPUP'
]);
const DIAGNOSTIC_EVENT_CODES = Object.freeze([
  'WORKER_STARTED', 'ACTION_ADMITTED', 'ACTION_COMPLETED', 'ACTION_PARTIAL',
  'ACTION_FAILED', 'ACTION_CANCELLED', 'ACTION_INTERRUPTED', 'RETRY_SCHEDULED',
  'DEADLINE_EXCEEDED', 'REQUEST_SENT', 'REQUEST_SUCCEEDED', 'REQUEST_FAILED',
  'REQUEST_TIMEOUT', 'REQUEST_DENIED', 'EXPORT_READY', 'EXPORT_EMPTY',
  'CLEAR_SUCCEEDED', 'CLEAR_FAILED', 'CONTROL_ACTIVATED', 'SCAN_STARTED',
  'SCAN_COMPLETED', 'CONFLICT_SCAN_STARTED', 'CONFLICT_SCAN_COMPLETED',
  'CONFLICT_SCAN_ACCESS_DENIED', 'CONFLICT_SCAN_ACCESS_REMOVED',
  'DUPLICATE_SELF_ENABLED', 'EXTERNAL_DISCARDER_ENABLED',
  'EXTERNAL_PLACEHOLDER_PRESENT', 'EXTERNAL_SLEEPERS_PRESENT',
  'TAB_MANAGER_ENABLED',
  'RECOVERY_STARTED', 'RECOVERY_COMPLETED', 'RESET_STARTED', 'RESET_COMPLETED',
  'NO_CHANGE'
]);
const DIAGNOSTIC_COUNT_KEYS = Object.freeze([
  'total', 'success', 'skipped', 'failed', 'attempted', 'eligible', 'protected',
  'unsupported', 'retried', 'timedOut', 'cancelled', 'enabled', 'disabled',
  'conflicts', 'duplicates', 'dropped', 'discardedTabs', 'duplicateCopies',
  'enabledExtensions', 'externalDiscarders', 'externalPlaceholders',
  'externalSleepers', 'selfOwnedSleepers', 'tabManagers', 'unknownSleepers'
]);
const EVENT_TYPE_ALIASES = new Map([
  ['worker-start', 'WORKER_START'], ['action-start', 'ACTION_START'],
  ['action-stage', 'ACTION_STAGE'], ['action-retry', 'ACTION_RETRY'],
  ['action-timeout', 'ACTION_TIMEOUT'], ['action-end', 'ACTION_END'],
  ['recovery-start', 'RECOVERY_START'], ['recovery-end', 'RECOVERY_END'],
  ['reset-start', 'RESET_START'], ['reset-end', 'RESET_END']
]);
const OUTCOME_ALIASES = new Map([
  ['started', 'STARTED'], ['progress', 'PROGRESS'], ['retrying', 'RETRYING'],
  ['timed-out', 'TIMED_OUT'], ['success', 'SUCCEEDED'], ['complete', 'COMPLETED'],
  ['partial', 'PARTIAL'], ['skipped', 'SKIPPED'], ['failed', 'FAILED'],
  ['denied', 'DENIED'], ['cancelled', 'CANCELLED'], ['interrupted', 'INTERRUPTED']
]);
const SAFE_EVENT_TYPES = new Set(Object.values(DIAGNOSTIC_EVENT_TYPES));
const SAFE_SOURCES = new Set(DIAGNOSTIC_SOURCES);
const SAFE_PHASES = new Set(DIAGNOSTIC_PHASES);
const SAFE_OUTCOMES = new Set(DIAGNOSTIC_OUTCOMES);
const SAFE_UI_ACTIONS = new Set(DIAGNOSTIC_UI_ACTIONS);
const SAFE_EVENT_CODES = new Set([
  ...DIAGNOSTIC_EVENT_CODES,
  ...Object.values(POPUP_CODES),
  ...Object.values(FAILURE_CAUSES)
]);
const SAFE_STATES = new Set(['cancelled', 'complete', 'failed', 'interrupted', 'partial']);
const SAFE_STATUSES = new Set(['failed', 'skipped', 'success']);
const SAFE_BROWSER_FAMILIES = new Set(['Chromium', 'Edge', 'Firefox', 'Other']);
const SAFE_CODES = new Set(Object.values(POPUP_CODES));
const INCIDENT_PATTERN = /^ATD-[A-Z0-9]+(?:-[A-Z0-9]+){1,4}$/;
const SESSION_PATTERN = /^ATDS-[A-Z0-9]+(?:-[A-Z0-9]+){1,3}$/;
const CORRELATION_PATTERN = /^ATDC-[A-Z0-9]{16,40}$/;
const EXPECTED_STATUS = new Map([
  [POPUP_CODES.BUSY, 'failed'],
  [POPUP_CODES.CANCELLED, 'skipped'],
  [POPUP_CODES.COMMAND_FAILED, 'failed'],
  [POPUP_CODES.INTERRUPTED, 'failed'],
  [POPUP_CODES.NO_ACTIVE_TAB, 'failed'],
  [POPUP_CODES.TARGET_CHANGED, 'failed'],
  [POPUP_CODES.TAB_ALREADY_OWNED, 'skipped'],
  [POPUP_CODES.TAB_ALREADY_OWNED_VISUAL_UNAVAILABLE, 'skipped'],
  [POPUP_CODES.TAB_CANCELLED, 'skipped'],
  [POPUP_CODES.TAB_DISCARDED, 'success'],
  [POPUP_CODES.TAB_DISCARDED_VISUAL_UNAVAILABLE, 'success'],
  [POPUP_CODES.TAB_FAILED, 'failed'],
  [POPUP_CODES.TAB_MISSING, 'skipped'],
  [POPUP_CODES.TAB_NO_SAFE_KEEPER, 'skipped'],
  [POPUP_CODES.TAB_OWNERSHIP_UNKNOWN, 'failed'],
  [POPUP_CODES.TAB_PROTECTED, 'skipped'],
  [POPUP_CODES.TAB_RELEASED, 'success'],
  [POPUP_CODES.TAB_RELEASE_REMAINS_FROZEN, 'failed'],
  [POPUP_CODES.TAB_SKIPPED, 'skipped'],
  [POPUP_CODES.TAB_SUSPENSION_UNKNOWN, 'failed'],
  [POPUP_CODES.TAB_UNSUPPORTED, 'failed']
]);

// These mappings are the privacy boundary. Arbitrary reasons and browser
// messages never cross into the journal; each public outcome becomes one fixed
// stage/reason pair suitable for UI grouping and support reports.
const GROUP_POLICY = new Map([
  [POPUP_CODES.BUSY, ['command', 'BUSY']],
  [POPUP_CODES.CANCELLED, ['command', 'CANCELLED']],
  [POPUP_CODES.COMMAND_FAILED, ['command', 'COMMAND_FAILED']],
  [POPUP_CODES.INTERRUPTED, ['command', 'INTERRUPTED']],
  [POPUP_CODES.NO_ACTIVE_TAB, ['command', 'NO_ACTIVE_TAB']],
  [POPUP_CODES.TARGET_CHANGED, ['command', 'TARGET_CHANGED']],
  [POPUP_CODES.TAB_ALREADY_OWNED, ['ownership', 'ALREADY_OWNED']],
  [POPUP_CODES.TAB_ALREADY_OWNED_VISUAL_UNAVAILABLE, ['visual-marker', 'VISUAL_UNAVAILABLE']],
  [POPUP_CODES.TAB_CANCELLED, ['command', 'CANCELLED']],
  [POPUP_CODES.TAB_DISCARDED, ['tab-operation', 'DISCARDED']],
  [POPUP_CODES.TAB_DISCARDED_VISUAL_UNAVAILABLE, ['visual-marker', 'VISUAL_UNAVAILABLE']],
  [POPUP_CODES.TAB_FAILED, ['tab-operation', 'OPERATION_FAILED']],
  [POPUP_CODES.TAB_MISSING, ['eligibility', 'TARGET_MISSING']],
  [POPUP_CODES.TAB_NO_SAFE_KEEPER, ['keeper', 'NO_SAFE_KEEPER']],
  [POPUP_CODES.TAB_OWNERSHIP_UNKNOWN, ['verification', 'OWNERSHIP_UNKNOWN']],
  [POPUP_CODES.TAB_PROTECTED, ['eligibility', 'PROTECTION_RULE']],
  [POPUP_CODES.TAB_RELEASED, ['release', 'RELEASED']],
  [POPUP_CODES.TAB_RELEASE_REMAINS_FROZEN, ['release', 'POSTCONDITION_NOT_MET']],
  [POPUP_CODES.TAB_SKIPPED, ['eligibility', 'NOT_ELIGIBLE']],
  [POPUP_CODES.TAB_SUSPENSION_UNKNOWN, ['verification', 'SUSPENSION_UNKNOWN']],
  [POPUP_CODES.TAB_UNSUPPORTED, ['eligibility', 'UNSUPPORTED_PAGE']]
]);
const GENERIC_FAILURE_CODES = new Set([
  POPUP_CODES.COMMAND_FAILED,
  POPUP_CODES.TAB_FAILED,
  POPUP_CODES.TAB_UNSUPPORTED
]);
const projectedPolicy = (code, failureCause) => GENERIC_FAILURE_CODES.has(code) ?
  failureCausePolicy(failureCause) : GROUP_POLICY.get(code);
const storedPolicyMatches = value => GENERIC_FAILURE_CODES.has(value.code) ?
  matchesFailureCausePolicy(value.stage, value.reasonCode) :
  value.stage === GROUP_POLICY.get(value.code)?.[0] &&
    value.reasonCode === GROUP_POLICY.get(value.code)?.[1];

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const byteLength = value => new TextEncoder().encode(value).byteLength;
const boundedInteger = (value, maximum = 1_000_000) =>
  Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
const canonicalIso = value => {
  if (typeof value !== 'string' || value.length > 32) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value ? undefined : value;
};
const timeIso = value => {
  if (!Number.isFinite(value) || value < 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};
const safeVersion = value => typeof value === 'string' && value.length > 0 && value.length <= 64 &&
  /^[0-9A-Za-z.+-]+$/.test(value) ? value : 'unknown';
const browserFamily = userAgent => {
  const source = typeof userAgent === 'string' ? userAgent : '';
  if (source.includes('Edg/')) return 'Edge';
  if (source.includes('Firefox/')) return 'Firefox';
  if (source.includes('Chromium/') || source.includes('Chrome/')) return 'Chromium';
  return 'Other';
};
const safeIncidentId = value => typeof value === 'string' && value.length <= 80 &&
  INCIDENT_PATTERN.test(value) ? value : undefined;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const ownValue = (value, key) => {
  if (!plainObject(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
};
const hasOwnValue = (value, key) => plainObject(value) &&
  Object.hasOwn(Object.getOwnPropertyDescriptors(value), key) &&
  Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value');
const safeSessionId = value => typeof value === 'string' && value.length <= 96 &&
  SESSION_PATTERN.test(value) ? value : undefined;
const safeCorrelation = value => typeof value === 'string' && CORRELATION_PATTERN.test(value) ?
  value : undefined;
const runtimeInfo = (manifest, userAgent) => ({
  browserFamily: browserFamily(userAgent),
  extensionVersion: safeVersion(manifest?.version)
});
const normalizeAlias = (value, aliases, allowed) => {
  const normalized = aliases.get(value) || value;
  return allowed.has(normalized) ? normalized : undefined;
};
const safeEventCounts = value => {
  if (!plainObject(value)) return undefined;
  const counts = {};
  for (const key of DIAGNOSTIC_COUNT_KEYS) {
    if (!hasOwnValue(value, key)) continue;
    const count = boundedInteger(ownValue(value, key), 10_000_000);
    if (count === undefined) return undefined;
    counts[key] = count;
  }
  return Object.keys(counts).length ? counts : undefined;
};

const projectDiagnosticEvent = (value, {correlation, manifest = {}, userAgent = ''} = {}) => {
  if (!plainObject(value)) return undefined;
  const type = normalizeAlias(ownValue(value, 'type'), EVENT_TYPE_ALIASES, SAFE_EVENT_TYPES);
  const source = ownValue(value, 'source');
  if (!type || !SAFE_SOURCES.has(source)) return undefined;
  const event = {source, type};
  const optionals = [
    ['action', SAFE_UI_ACTIONS],
    ['command', SAFE_DIAGNOSTIC_COMMANDS],
    ['phase', SAFE_PHASES],
    ['code', SAFE_EVENT_CODES]
  ];
  for (const [key, allowed] of optionals) {
    if (!hasOwnValue(value, key)) continue;
    const candidate = ownValue(value, key);
    if (!allowed.has(candidate)) return undefined;
    event[key] = candidate;
  }
  if (hasOwnValue(value, 'outcome')) {
    const outcome = normalizeAlias(ownValue(value, 'outcome'), OUTCOME_ALIASES, SAFE_OUTCOMES);
    if (!outcome) return undefined;
    event.outcome = outcome;
  }
  if (hasOwnValue(value, 'counts')) {
    const counts = safeEventCounts(ownValue(value, 'counts'));
    if (!counts) return undefined;
    event.counts = counts;
  }
  if (hasOwnValue(value, 'attempt')) {
    const attempt = boundedInteger(ownValue(value, 'attempt'), 10_000);
    if (attempt === undefined) return undefined;
    event.attempt = attempt;
  }
  const safeToken = safeCorrelation(correlation);
  if (safeToken) event.correlation = safeToken;
  event.runtime = runtimeInfo(manifest, userAgent);
  return event;
};

const sortedGroups = groups => [...groups].sort((a, b) => {
  const priority = {failed: 0, skipped: 1, success: 2};
  return (priority[a.status] ?? 3) - (priority[b.status] ?? 3) ||
    b.count - a.count || a.code.localeCompare(b.code) ||
    a.stage.localeCompare(b.stage) || a.reasonCode.localeCompare(b.reasonCode);
});

const projectDiagnosticIncident = (snapshot, {
  manifest = globalThis.chrome?.runtime?.getManifest?.() || {},
  userAgent = globalThis.navigator?.userAgent || ''
} = {}) => {
  if (!plainObject(snapshot)) {
    return undefined;
  }
  const id = safeIncidentId(snapshot.incidentId);
  const command = SAFE_COMMANDS.has(snapshot.command) ? snapshot.command : undefined;
  const state = SAFE_STATES.has(snapshot.state) ? snapshot.state : undefined;
  const startedAt = timeIso(snapshot.startedAt);
  const endedAt = timeIso(Number.isFinite(snapshot.endedAt) ? snapshot.endedAt : snapshot.updatedAt);
  if (!id || !command || !state || !startedAt || !endedAt) {
    return undefined;
  }

  const grouped = new Map();
  const summary = {failed: 0, skipped: 0, success: 0};
  const outcomesDescriptor = Object.getOwnPropertyDescriptor(snapshot, 'outcomes');
  const outcomes = outcomesDescriptor && Object.hasOwn(outcomesDescriptor, 'value') &&
    plainObject(outcomesDescriptor.value) ? outcomesDescriptor.value : {};
  const outcomeKeys = Object.keys(outcomes).slice(0, 100_000);
  for (const key of outcomeKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(outcomes, key);
    const outcome = descriptor && Object.hasOwn(descriptor, 'value') && plainObject(descriptor.value) ?
      descriptor.value : undefined;
    if (!outcome) continue;
    const codeDescriptor = outcome && Object.getOwnPropertyDescriptor(outcome, 'code');
    const candidateCode = codeDescriptor && Object.hasOwn(codeDescriptor, 'value') ?
      codeDescriptor.value : undefined;
    // Unknown classifications collapse to one fixed failure token. No raw
    // value, getter, or arbitrary browser reason is retained.
    const code = SAFE_CODES.has(candidateCode) ? candidateCode : POPUP_CODES.TAB_FAILED;
    const status = EXPECTED_STATUS.get(code);
    const policy = projectedPolicy(code, failureCauseFrom(
      outcome,
      code === POPUP_CODES.TAB_UNSUPPORTED ?
        FAILURE_CAUSES.UNSUPPORTED_PAGE : FAILURE_CAUSES.OPERATION_FAILED
    ));
    if (!code || !status || !policy) {
      continue;
    }
    const groupKey = `${status}:${code}:${policy[0]}:${policy[1]}`;
    const previous = grouped.get(groupKey);
    grouped.set(groupKey, {
      code,
      count: (previous?.count || 0) + 1,
      reasonCode: policy[1],
      stage: policy[0],
      status
    });
    summary[status] += 1;
  }

  // A command can fail before it has any tab target (scope query, active-tab
  // lookup, or worker interruption). Retain the fixed top-level classification
  // so the diagnostics panel is never an empty repetition of "failed".
  if (grouped.size === 0 && ['cancelled', 'failed', 'interrupted', 'partial'].includes(snapshot.state)) {
    const fallbackCode = SAFE_CODES.has(snapshot.errorCode) ? snapshot.errorCode :
      snapshot.state === 'cancelled' ? POPUP_CODES.CANCELLED :
        snapshot.state === 'interrupted' ? POPUP_CODES.INTERRUPTED : POPUP_CODES.COMMAND_FAILED;
    const policy = projectedPolicy(
      fallbackCode,
      failureCauseFrom(snapshot, undefined, 'errorCause')
    );
    if (policy) {
      const status = EXPECTED_STATUS.get(fallbackCode);
      grouped.set(`${status}:${fallbackCode}:${policy[0]}:${policy[1]}`, {
        code: fallbackCode,
        count: 1,
        reasonCode: policy[1],
        stage: policy[0],
        status
      });
    }
  }

  const completed = summary.success + summary.skipped + summary.failed;
  const declaredTotal = boundedInteger(snapshot.total);
  const total = Math.max(completed, declaredTotal ?? completed);
  const startedMs = new Date(startedAt).getTime();
  const endedMs = new Date(endedAt).getTime();
  return {
    command,
    durationMs: Math.min(Math.max(0, endedMs - startedMs), 7 * 24 * 60 * 60 * 1000),
    endedAt,
    forced: snapshot.shiftKey === true,
    groups: sortedGroups(grouped.values()),
    id,
    runtime: {
      browserFamily: browserFamily(userAgent),
      extensionVersion: safeVersion(manifest?.version)
    },
    startedAt,
    state,
    summary,
    total
  };
};

const normalizeGroup = value => {
  if (!plainObject(value) || !SAFE_CODES.has(value.code) || !SAFE_STATUSES.has(value.status) ||
      EXPECTED_STATUS.get(value.code) !== value.status) {
    return undefined;
  }
  const count = boundedInteger(value.count);
  if (count === undefined || count === 0 || !storedPolicyMatches(value)) {
    return undefined;
  }
  return {
    code: value.code,
    count,
    reasonCode: value.reasonCode,
    stage: value.stage,
    status: value.status
  };
};

const normalizeIncident = value => {
  if (!plainObject(value)) {
    return undefined;
  }
  const id = safeIncidentId(value.id);
  const command = SAFE_COMMANDS.has(value.command) ? value.command : undefined;
  const state = SAFE_STATES.has(value.state) ? value.state : undefined;
  const startedAt = canonicalIso(value.startedAt);
  const endedAt = canonicalIso(value.endedAt);
  const durationMs = boundedInteger(value.durationMs, DIAGNOSTIC_MAX_AGE);
  const total = boundedInteger(value.total);
  const runtime = plainObject(value.runtime) && SAFE_BROWSER_FAMILIES.has(value.runtime.browserFamily) &&
    safeVersion(value.runtime.extensionVersion) !== 'unknown' ? {
      browserFamily: value.runtime.browserFamily,
      extensionVersion: safeVersion(value.runtime.extensionVersion)
    } : undefined;
  const summary = plainObject(value.summary) ? {
    failed: boundedInteger(value.summary.failed),
    skipped: boundedInteger(value.summary.skipped),
    success: boundedInteger(value.summary.success)
  } : undefined;
  const groups = Array.isArray(value.groups) ? value.groups.map(normalizeGroup).filter(Boolean) : [];
  if (!id || !command || !state || !startedAt || !endedAt || durationMs === undefined ||
      total === undefined || !runtime || !summary || Object.values(summary).some(v => v === undefined) ||
      summary.success + summary.skipped + summary.failed > total || typeof value.forced !== 'boolean') {
    return undefined;
  }
  return {
    command,
    durationMs,
    endedAt,
    forced: value.forced,
    groups: sortedGroups(groups),
    id,
    runtime,
    startedAt,
    state,
    summary,
    total
  };
};

const exactKeys = (value, expected) => plainObject(value) &&
  Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
const exactStoredIncident = value => exactKeys(value, [
  'command', 'durationMs', 'endedAt', 'forced', 'groups', 'id', 'runtime',
  'startedAt', 'state', 'summary', 'total'
]) && exactKeys(value.runtime, ['browserFamily', 'extensionVersion']) &&
  exactKeys(value.summary, ['failed', 'skipped', 'success']) &&
  Array.isArray(value.groups) && value.groups.every(group => exactKeys(group, [
    'code', 'count', 'reasonCode', 'stage', 'status'
  ])) && normalizeIncident(value) !== undefined;
const exactLegacyEnvelope = value => exactKeys(value, [
  'format', 'incidents', 'updatedAt', 'version'
]) && value.format === DIAGNOSTIC_FORMAT && value.version === LEGACY_DIAGNOSTIC_VERSION &&
  canonicalIso(value.updatedAt) !== undefined && Array.isArray(value.incidents) &&
  value.incidents.every(exactStoredIncident);

const normalizeRuntime = value => plainObject(value) &&
  SAFE_BROWSER_FAMILIES.has(value.browserFamily) &&
  (value.extensionVersion === 'unknown' || safeVersion(value.extensionVersion) !== 'unknown') ? {
    browserFamily: value.browserFamily,
    extensionVersion: safeVersion(value.extensionVersion)
  } : undefined;
const normalizeEventRecord = value => {
  if (!plainObject(value) || value.kind !== 'event') return undefined;
  const sequence = boundedInteger(value.sequence, Number.MAX_SAFE_INTEGER);
  const offsetMs = boundedInteger(value.offsetMs, Number.MAX_SAFE_INTEGER);
  const timestamp = canonicalIso(value.timestamp);
  const type = normalizeAlias(value.type, EVENT_TYPE_ALIASES, SAFE_EVENT_TYPES);
  const source = SAFE_SOURCES.has(value.source) ? value.source : undefined;
  const runtime = normalizeRuntime(value.runtime);
  if (!sequence || offsetMs === undefined || !timestamp || !type || !source || !runtime) {
    return undefined;
  }
  const normalized = {kind: 'event', offsetMs, runtime, sequence, source, timestamp, type};
  for (const [key, allowed] of [
    ['action', SAFE_UI_ACTIONS], ['command', SAFE_DIAGNOSTIC_COMMANDS],
    ['phase', SAFE_PHASES], ['code', SAFE_EVENT_CODES]
  ]) {
    if (!Object.hasOwn(value, key)) continue;
    if (!allowed.has(value[key])) return undefined;
    normalized[key] = value[key];
  }
  if (Object.hasOwn(value, 'outcome')) {
    const outcome = normalizeAlias(value.outcome, OUTCOME_ALIASES, SAFE_OUTCOMES);
    if (!outcome) return undefined;
    normalized.outcome = outcome;
  }
  if (Object.hasOwn(value, 'counts')) {
    const counts = safeEventCounts(value.counts);
    if (!counts || !exactKeys(value.counts, Object.keys(counts))) return undefined;
    normalized.counts = counts;
  }
  if (Object.hasOwn(value, 'attempt')) {
    const attempt = boundedInteger(value.attempt, 10_000);
    if (attempt === undefined) return undefined;
    normalized.attempt = attempt;
  }
  if (Object.hasOwn(value, 'correlation')) {
    const correlation = safeCorrelation(value.correlation);
    if (!correlation) return undefined;
    normalized.correlation = correlation;
  }
  return normalized;
};
const normalizeIncidentRecord = value => {
  if (!plainObject(value) || value.kind !== 'incident') return undefined;
  const sequence = boundedInteger(value.sequence, Number.MAX_SAFE_INTEGER);
  const offsetMs = boundedInteger(value.offsetMs, Number.MAX_SAFE_INTEGER);
  const timestamp = canonicalIso(value.timestamp);
  const incident = normalizeIncident(value.incident);
  return sequence && offsetMs !== undefined && timestamp && incident ? {
    incident,
    kind: 'incident',
    offsetMs,
    sequence,
    timestamp
  } : undefined;
};
const normalizeRecord = value => value?.kind === 'event' ?
  normalizeEventRecord(value) : normalizeIncidentRecord(value);
const exactStoredRecord = value => {
  const normalized = normalizeRecord(value);
  if (!normalized || !exactKeys(value, Object.keys(normalized))) return false;
  if (normalized.kind === 'incident') return exactStoredIncident(value.incident);
  return exactKeys(value.runtime, ['browserFamily', 'extensionVersion']);
};
const normalizeSession = value => {
  if (!plainObject(value)) return undefined;
  const id = safeSessionId(value.id);
  const startedAt = canonicalIso(value.startedAt);
  const records = Array.isArray(value.records) ? value.records.map(normalizeRecord).filter(Boolean) : [];
  if (!id || !startedAt || records.length !== value.records?.length) return undefined;
  records.sort((a, b) => a.sequence - b.sequence || a.offsetMs - b.offsetMs ||
    a.timestamp.localeCompare(b.timestamp));
  let previousSequence = 0;
  let previousOffset = -1;
  for (const record of records) {
    if (record.sequence <= previousSequence || record.offsetMs < previousOffset) return undefined;
    previousSequence = record.sequence;
    previousOffset = record.offsetMs;
  }
  return {id, records, startedAt};
};
const exactStoredSession = value => exactKeys(value, ['id', 'records', 'startedAt']) &&
  Array.isArray(value.records) && value.records.every(exactStoredRecord) &&
  normalizeSession(value) !== undefined;
const normalizeEnvelope = value => {
  if (!plainObject(value) || value.format !== DIAGNOSTIC_FORMAT ||
      value.version !== DIAGNOSTIC_VERSION || !Array.isArray(value.sessions)) {
    return [];
  }
  return value.sessions.map(normalizeSession).filter(Boolean);
};
const exactStoredEnvelope = value => exactKeys(value, [
  'format', 'sessions', 'updatedAt', 'version'
]) && value.format === DIAGNOSTIC_FORMAT && value.version === DIAGNOSTIC_VERSION &&
  canonicalIso(value.updatedAt) !== undefined && Array.isArray(value.sessions) &&
  value.sessions.every(exactStoredSession) && normalizeEnvelope(value).length === value.sessions.length &&
  new Set(value.sessions.map(session => session.id)).size === value.sessions.length;

const exactSessionState = value => exactKeys(value, [
  'format', 'id', 'lastOffsetMs', 'lastSequence', 'lastTimestamp', 'startedAt', 'version'
]) && value.format === DIAGNOSTIC_SESSION_FORMAT &&
  value.version === DIAGNOSTIC_SESSION_VERSION && safeSessionId(value.id) &&
  canonicalIso(value.startedAt) && canonicalIso(value.lastTimestamp) &&
  boundedInteger(value.lastOffsetMs, Number.MAX_SAFE_INTEGER) !== undefined &&
  boundedInteger(value.lastSequence, Number.MAX_SAFE_INTEGER) !== undefined &&
  new Date(value.lastTimestamp).getTime() >= new Date(value.startedAt).getTime();

const diagnosticChunkKey = (sessionId, anchorSequence) =>
  `${DIAGNOSTIC_CHUNK_STORAGE_PREFIX}${sessionId}.${anchorSequence}`;
const diagnosticChunkAnchor = (value, sessionId) => {
  if (typeof value !== 'string' || value.length > 180) return undefined;
  const prefix = `${DIAGNOSTIC_CHUNK_STORAGE_PREFIX}${sessionId}.`;
  if (!value.startsWith(prefix)) return undefined;
  const suffix = value.slice(prefix.length);
  if (!/^[1-9][0-9]{0,15}$/.test(suffix)) return undefined;
  const anchor = Number(suffix);
  return Number.isSafeInteger(anchor) && anchor > 0 ? anchor : undefined;
};
const chunkDocument = (sessionId, records) => ({
  format: DIAGNOSTIC_CHUNK_FORMAT,
  records: clone(records),
  sessionId,
  version: DIAGNOSTIC_CHUNK_VERSION
});
const normalizeChunkIndexSession = value => {
  if (!exactKeys(value, ['chunks', 'id', 'startedAt'])) return undefined;
  const id = safeSessionId(value.id);
  const startedAt = canonicalIso(value.startedAt);
  if (!id || !startedAt || !Array.isArray(value.chunks) || value.chunks.length === 0 ||
      value.chunks.length > MAX_DIAGNOSTIC_EVENTS) {
    return undefined;
  }
  const chunks = value.chunks.filter(key => diagnosticChunkAnchor(key, id) !== undefined);
  if (chunks.length !== value.chunks.length || new Set(chunks).size !== chunks.length) {
    return undefined;
  }
  return {chunks, id, startedAt};
};
const normalizeChunkIndex = value => {
  if (!exactKeys(value, ['format', 'layout', 'sessions', 'updatedAt', 'version']) ||
      value.format !== DIAGNOSTIC_FORMAT || value.layout !== DIAGNOSTIC_CHUNK_LAYOUT ||
      value.version !== DIAGNOSTIC_VERSION || !canonicalIso(value.updatedAt) ||
      !Array.isArray(value.sessions) || value.sessions.length > MAX_DIAGNOSTIC_SESSIONS) {
    return undefined;
  }
  const sessions = value.sessions.map(normalizeChunkIndexSession).filter(Boolean);
  const keys = sessions.flatMap(session => session.chunks);
  if (sessions.length !== value.sessions.length ||
      new Set(sessions.map(session => session.id)).size !== sessions.length ||
      new Set(keys).size !== keys.length || keys.length > MAX_DIAGNOSTIC_EVENTS) {
    return undefined;
  }
  return {sessions, updatedAt: value.updatedAt};
};
const normalizeChunkDocument = (value, {id, startedAt}, key) => {
  if (!exactKeys(value, ['format', 'records', 'sessionId', 'version']) ||
      value.format !== DIAGNOSTIC_CHUNK_FORMAT || value.version !== DIAGNOSTIC_CHUNK_VERSION ||
      value.sessionId !== id || !Array.isArray(value.records) || value.records.length === 0 ||
      value.records.length > MAX_DIAGNOSTIC_CHUNK_RECORDS ||
      byteLength(JSON.stringify(value)) > MAX_DIAGNOSTIC_CHUNK_BYTES ||
      value.records.some(record => !exactStoredRecord(record))) {
    return undefined;
  }
  const records = value.records.map(normalizeRecord);
  const normalized = normalizeSession({id, records, startedAt});
  const anchor = diagnosticChunkAnchor(key, id);
  if (!normalized || anchor === undefined || anchor > normalized.records[0].sequence) {
    return undefined;
  }
  return {
    bytes: byteLength(JSON.stringify(value)),
    key,
    oldestTimestamp: Math.min(...normalized.records.map(recordTimestamp)),
    records: normalized.records
  };
};

const invokeStorage = (area, method, args, timeoutMs) => new Promise((resolve, reject) => {
  let settled = false;
  let timer;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    error ? reject(error) : resolve(value);
  };
  timer = setTimeout(() => finish(Error('diagnostic storage operation timed out')),
    Math.max(1, Number(timeoutMs) || DIAGNOSTIC_STORAGE_TIMEOUT));
  try {
    const operation = area[method](...args, value => {
      const error = globalThis.chrome?.runtime?.lastError;
      finish(error ? Error(error.message || String(error)) : null, value);
    });
    if (operation?.then) {
      // Chromium can expose a thenable even when the callback form was used.
      // The callback is the ordering boundary for that invocation; resolving
      // from the thenable first can let a later cleanup overtake its write.
      Promise.resolve(operation).catch(error => finish(error));
    }
  }
  catch (error) {
    finish(error);
  }
});

const diagnosticStorageAdapter = (
  area = globalThis.chrome?.storage?.local,
  key = DIAGNOSTIC_STORAGE_KEY,
  {timeoutMs = DIAGNOSTIC_STORAGE_TIMEOUT} = {}
) => ({
  async clearChunks(chunkKeys = []) {
    if (!area?.remove) throw Error('diagnostic storage removal is unavailable');
    const keys = [key, ...chunkKeys.filter(candidate =>
      typeof candidate === 'string' && candidate.startsWith(DIAGNOSTIC_CHUNK_STORAGE_PREFIX))];
    await invokeStorage(area, 'remove', [keys], timeoutMs);
  },
  async commitChunks(index, chunks = new Map()) {
    if (!area?.set) throw Error('diagnostic storage write is unavailable');
    const values = {};
    if (index !== undefined) values[key] = index;
    for (const [chunkKey, chunk] of chunks) {
      if (typeof chunkKey !== 'string' ||
          !chunkKey.startsWith(DIAGNOSTIC_CHUNK_STORAGE_PREFIX)) {
        throw Error('invalid diagnostic chunk key');
      }
      values[chunkKey] = chunk;
    }
    if (Object.keys(values).length) await invokeStorage(area, 'set', [values], timeoutMs);
  },
  async listChunks() {
    if (!area?.get) throw Error('diagnostic storage enumeration is unavailable');
    const values = await invokeStorage(area, 'get', [null], timeoutMs);
    return Object.keys(plainObject(values) ? values : {}).filter(candidate =>
      candidate.startsWith(DIAGNOSTIC_CHUNK_STORAGE_PREFIX));
  },
  async read() {
    if (!area?.get) throw Error('diagnostic storage read is unavailable');
    const values = await invokeStorage(area, 'get', [{[key]: undefined}], timeoutMs);
    return values?.[key];
  },
  async remove() {
    if (!area?.remove) throw Error('diagnostic storage removal is unavailable');
    await invokeStorage(area, 'remove', [key], timeoutMs);
  },
  async readChunks(chunkKeys = []) {
    if (!area?.get) throw Error('diagnostic storage read is unavailable');
    const keys = chunkKeys.filter(candidate =>
      typeof candidate === 'string' && candidate.startsWith(DIAGNOSTIC_CHUNK_STORAGE_PREFIX));
    return invokeStorage(area, 'get', [keys], timeoutMs);
  },
  async removeChunks(chunkKeys = []) {
    if (!area?.remove) throw Error('diagnostic storage removal is unavailable');
    const keys = chunkKeys.filter(candidate =>
      typeof candidate === 'string' && candidate.startsWith(DIAGNOSTIC_CHUNK_STORAGE_PREFIX));
    if (keys.length) await invokeStorage(area, 'remove', [keys], timeoutMs);
  },
  async write(value) {
    if (!area?.set) throw Error('diagnostic storage write is unavailable');
    await invokeStorage(area, 'set', [{[key]: value}], timeoutMs);
  }
});

const diagnosticSessionStorageAdapter = (
  area = globalThis.chrome?.storage?.session,
  key = DIAGNOSTIC_SESSION_STORAGE_KEY,
  {timeoutMs = DIAGNOSTIC_STORAGE_TIMEOUT} = {}
) => ({
  async read() {
    if (!area?.get) throw Error('diagnostic session storage read is unavailable');
    const values = await invokeStorage(area, 'get', [{[key]: undefined}], timeoutMs);
    return values?.[key];
  },
  async remove() {
    if (!area?.remove) throw Error('diagnostic session storage removal is unavailable');
    await invokeStorage(area, 'remove', [key], timeoutMs);
  },
  async write(value) {
    if (!area?.set) throw Error('diagnostic session storage write is unavailable');
    await invokeStorage(area, 'set', [{[key]: value}], timeoutMs);
  }
});
const volatileStorageAdapter = () => {
  let value;
  return {
    read: async () => clone(value),
    remove: async () => value = undefined,
    write: async next => value = clone(next)
  };
};

const envelope = (sessions, updatedAt) => ({
  format: DIAGNOSTIC_FORMAT,
  sessions: clone(sessions),
  updatedAt,
  version: DIAGNOSTIC_VERSION
});

const logSeverity = status => status === 'failed' ? 'ERROR' : status === 'skipped' ? 'WARN' : 'INFO';
const stateSeverity = state => state === 'failed' ? 'ERROR' :
  ['partial', 'cancelled', 'interrupted'].includes(state) ? 'WARN' : 'INFO';
const formatDiagnosticLog = incidentValue => {
  const incident = normalizeIncident(incidentValue);
  if (!incident) {
    return '';
  }
  const lines = [
    '# Auto Tab Discard SANITIZED latest.log',
    '# Excludes URLs, titles, hostnames, site rules, tab/window/group IDs, raw errors, stacks, paths, and full user-agent data.',
    `[${incident.startedAt}] [AutoTabDiscard/INFO] incident=${incident.id} event=COMMAND_START command=${incident.command} forced=${incident.forced} total=${incident.total}`,
    `[${incident.startedAt}] [AutoTabDiscard/INFO] incident=${incident.id} event=RUNTIME extension=${incident.runtime.extensionVersion} browser=${incident.runtime.browserFamily}`
  ];
  for (const group of incident.groups) {
    lines.push(
      `[${incident.endedAt}] [AutoTabDiscard/${logSeverity(group.status)}] incident=${incident.id} event=OUTCOME status=${group.status} stage=${group.stage} reason=${group.reasonCode} code=${group.code} count=${group.count}`
    );
  }
  lines.push(
    `[${incident.endedAt}] [AutoTabDiscard/${stateSeverity(incident.state)}] incident=${incident.id} event=COMMAND_END state=${incident.state} duration_ms=${incident.durationMs} success=${incident.summary.success} skipped=${incident.summary.skipped} failed=${incident.summary.failed}`,
    '# End of sanitized local diagnostic log.'
  );
  return `${lines.join('\n')}\n`;
};

const opaqueRandom = (length = 24) => {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
      .slice(0, length).toUpperCase();
  }
  let output = '';
  while (output.length < length) {
    output += Math.floor(Math.random() * 0x1_0000_0000).toString(16).padStart(8, '0');
  }
  return output.slice(0, length).toUpperCase();
};
const defaultSessionId = startedAt =>
  `ATDS-${Number(startedAt).toString(36).toUpperCase()}-${opaqueRandom(24)}`;
const defaultCorrelationId = () => `ATDC-${opaqueRandom(24)}`;

const recordTimestamp = record => new Date(record.timestamp).getTime();
const recordCount = sessions => sessions.reduce((total, session) => total + session.records.length, 0);
const migrateLegacyEnvelope = value => {
  if (!exactLegacyEnvelope(value) || value.incidents.length === 0) {
    return envelope([], value?.updatedAt || new Date(0).toISOString());
  }
  const indexed = value.incidents.map((incident, index) => ({
    incident: normalizeIncident(incident),
    index
  })).sort((a, b) => new Date(a.incident.startedAt) - new Date(b.incident.startedAt) ||
    new Date(a.incident.endedAt) - new Date(b.incident.endedAt) || a.index - b.index);
  if (new Set(indexed.map(entry => entry.incident.id)).size !== indexed.length) {
    return undefined;
  }
  const startedMs = Math.min(...indexed.map(entry => new Date(entry.incident.startedAt).getTime()));
  const records = indexed.map((entry, index) => ({
    incident: entry.incident,
    kind: 'incident',
    offsetMs: Math.max(0, new Date(entry.incident.endedAt).getTime() - startedMs),
    sequence: index + 1,
    timestamp: entry.incident.endedAt
  }));
  return envelope([{
    id: 'ATDS-LEGACY-V1',
    records,
    startedAt: new Date(startedMs).toISOString()
  }], value.updatedAt);
};

const valueToken = value => String(value).replace(/[^A-Za-z0-9_.:+-]/g, '');
const eventLogLine = (session, record) => {
  const fields = [
    `session=${session.id}`,
    `offset_ms=${record.offsetMs}`,
    `seq=${record.sequence}`,
    `event=${record.type}`,
    `source=${record.source}`
  ];
  for (const key of ['action', 'command', 'phase', 'outcome', 'code', 'attempt', 'correlation']) {
    if (record[key] !== undefined) fields.push(`${key}=${valueToken(record[key])}`);
  }
  for (const [key, value] of Object.entries(record.counts || {})) {
    fields.push(`${key}=${value}`);
  }
  fields.push(`extension=${record.runtime.extensionVersion}`,
    `browser=${record.runtime.browserFamily}`);
  const severity = ['FAILED', 'TIMED_OUT', 'DENIED'].includes(record.outcome) ? 'ERROR' :
    ['PARTIAL', 'SKIPPED', 'CANCELLED', 'INTERRUPTED', 'RETRYING'].includes(record.outcome) ?
      'WARN' : 'INFO';
  return `[${record.timestamp}] [AutoTabDiscard/${severity}] ${fields.join(' ')}`;
};
const incidentHistoryLines = (session, record) => {
  const incident = record.incident;
  const startPrefix = `session=${session.id} offset_ms=${Math.max(0,
    record.offsetMs - incident.durationMs)} seq=${record.sequence}`;
  const endPrefix = `session=${session.id} offset_ms=${record.offsetMs} seq=${record.sequence}`;
  const lines = [
    `[${incident.startedAt}] [AutoTabDiscard/INFO] ${startPrefix} incident=${incident.id} event=COMMAND_START command=${incident.command} forced=${incident.forced} total=${incident.total}`,
    `[${incident.startedAt}] [AutoTabDiscard/INFO] ${startPrefix} incident=${incident.id} event=RUNTIME extension=${incident.runtime.extensionVersion} browser=${incident.runtime.browserFamily}`
  ];
  for (const group of incident.groups) {
    lines.push(`[${incident.endedAt}] [AutoTabDiscard/${logSeverity(group.status)}] ${endPrefix} incident=${incident.id} event=OUTCOME status=${group.status} stage=${group.stage} reason=${group.reasonCode} code=${group.code} count=${group.count}`);
  }
  lines.push(`[${incident.endedAt}] [AutoTabDiscard/${stateSeverity(incident.state)}] ${endPrefix} incident=${incident.id} event=COMMAND_END state=${incident.state} duration_ms=${incident.durationMs} success=${incident.summary.success} skipped=${incident.summary.skipped} failed=${incident.summary.failed}`);
  return lines;
};
const formatDiagnosticHistory = (sessionsValue, {scope = 'all'} = {}) => {
  const sessions = (Array.isArray(sessionsValue) ? sessionsValue : [])
    .map(normalizeSession).filter(Boolean)
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt) || a.id.localeCompare(b.id));
  const lines = [
    '# Auto Tab Discard SANITIZED diagnostic history',
    '# Excludes URLs, titles, hostnames, site rules, tab/window/group IDs, raw errors, stacks, paths, and full user-agent data.',
    `# scope=${scope} sessions=${sessions.length} records=${recordCount(sessions)}`
  ];
  for (const session of sessions) {
    lines.push(`# SESSION id=${session.id} started=${session.startedAt} records=${session.records.length}`);
    for (const record of session.records) {
      lines.push(...(record.kind === 'event' ?
        [eventLogLine(session, record)] : incidentHistoryLines(session, record)));
    }
  }
  lines.push('# End of sanitized local diagnostic history.');
  return `${lines.join('\n')}\n`;
};

const diagnosticChunk = (sessionId, records, key = diagnosticChunkKey(
  sessionId, records[0]?.sequence
)) => {
  if (!records.length || records.length > MAX_DIAGNOSTIC_CHUNK_RECORDS) return undefined;
  const document = chunkDocument(sessionId, records);
  const bytes = byteLength(JSON.stringify(document));
  if (bytes > MAX_DIAGNOSTIC_CHUNK_BYTES) return undefined;
  return {
    bytes,
    document,
    key,
    oldestTimestamp: Math.min(...document.records.map(recordTimestamp)),
    records: document.records
  };
};
const chunkIndexEnvelope = (layout, updatedAt) => ({
  format: DIAGNOSTIC_FORMAT,
  layout: DIAGNOSTIC_CHUNK_LAYOUT,
  sessions: layout.sessions.map(session => ({
    chunks: session.chunks.map(chunk => chunk.key),
    id: session.id,
    startedAt: session.startedAt
  })),
  updatedAt,
  version: DIAGNOSTIC_VERSION
});
const chunkLayoutKeys = layout => layout.sessions.flatMap(session =>
  session.chunks.map(chunk => chunk.key));
const chunkLayoutRecordCount = layout => layout.sessions.reduce((total, session) =>
  total + session.chunks.reduce((subtotal, chunk) => subtotal + chunk.records.length, 0), 0);
const chunkLayoutBytes = (layout, updatedAt) => byteLength(JSON.stringify(
  chunkIndexEnvelope(layout, updatedAt)
)) + layout.sessions.reduce((total, session) => total +
  session.chunks.reduce((subtotal, chunk) => subtotal + chunk.bytes, 0), 0);
const sessionsFromChunkLayout = layout => layout.sessions.map(session => ({
  id: session.id,
  records: session.chunks.flatMap(chunk => chunk.records),
  startedAt: session.startedAt
}));
const buildChunkLayout = sessionsValue => {
  const layout = {sessions: []};
  for (const session of sessionsValue.map(normalizeSession).filter(Boolean)
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt) || a.id.localeCompare(b.id))) {
    const chunkSession = {chunks: [], id: session.id, startedAt: session.startedAt};
    for (const record of session.records) {
      const previous = chunkSession.chunks.at(-1);
      const combined = previous && previous.records.length < MAX_DIAGNOSTIC_CHUNK_RECORDS ?
        diagnosticChunk(session.id, [...previous.records, record], previous.key) : undefined;
      if (combined) chunkSession.chunks[chunkSession.chunks.length - 1] = combined;
      else {
        const created = diagnosticChunk(session.id, [record]);
        if (!created) throw Error('diagnostic record exceeds its fixed chunk limit');
        chunkSession.chunks.push(created);
      }
    }
    if (chunkSession.chunks.length) layout.sessions.push(chunkSession);
  }
  return layout;
};
const salvageChunkLayout = (indexValue, values) => {
  const index = normalizeChunkIndex(indexValue);
  if (!index || !plainObject(values)) return undefined;
  const layout = {sessions: []};
  const invalidKeys = new Set();
  for (const session of index.sessions) {
    const chunks = [];
    let lastOffset = -1;
    let lastSequence = 0;
    for (const key of session.chunks) {
      const chunk = normalizeChunkDocument(values[key], session, key);
      const first = chunk?.records[0];
      if (!chunk || first.sequence <= lastSequence || first.offsetMs < lastOffset) {
        invalidKeys.add(key);
        continue;
      }
      chunks.push(chunk);
      const last = chunk.records.at(-1);
      lastOffset = last.offsetMs;
      lastSequence = last.sequence;
    }
    if (chunks.length) layout.sessions.push({...session, chunks});
  }
  return {
    invalidKeys,
    layout,
    repaired: invalidKeys.size > 0 || layout.sessions.length !== index.sessions.length
  };
};

const createDiagnosticJournal = ({
  createCorrelationId = defaultCorrelationId,
  createSessionId = defaultSessionId,
  manifest = globalThis.chrome?.runtime?.getManifest?.() || {},
  maxAge = DIAGNOSTIC_MAX_AGE,
  maxBytes = MAX_DIAGNOSTIC_BYTES,
  maxEvents,
  maxIncidents,
  maxSessions = MAX_DIAGNOSTIC_SESSIONS,
  now = () => Date.now(),
  sessionStore,
  store = diagnosticStorageAdapter(),
  userAgent = globalThis.navigator?.userAgent || ''
} = {}) => {
  sessionStore ||= globalThis.chrome?.storage?.session ?
    diagnosticSessionStorageAdapter() : volatileStorageAdapter();
  const recordLimit = Math.max(0, Number.isSafeInteger(maxEvents) ? maxEvents :
    Number.isSafeInteger(maxIncidents) ? maxIncidents : MAX_DIAGNOSTIC_EVENTS);
  const sessionLimit = Number.isSafeInteger(maxSessions) && maxSessions >= 0 ?
    maxSessions : MAX_DIAGNOSTIC_SESSIONS;
  const byteLimit = Number.isSafeInteger(maxBytes) && maxBytes >= 0 ?
    maxBytes : MAX_DIAGNOSTIC_BYTES;
  const chunkedStore = ['clearChunks', 'commitChunks', 'listChunks', 'readChunks', 'removeChunks']
    .every(method => typeof store?.[method] === 'function');
  let sessions = [];
  let chunkLayout = {sessions: []};
  let privateSessions = [];
  let privateClock = {id: undefined, lastOffsetMs: 0, lastSequence: 0, lastTimestamp: undefined};
  let hydrated;
  let sessionHydrated;
  let sessionState;
  let tail = Promise.resolve();

  const prune = (values, current) => {
    const cutoff = current - Math.max(0, Number(maxAge) || 0);
    let next = values.map(normalizeSession).filter(Boolean).map(session => ({
      ...session,
      records: session.records.filter(record => recordTimestamp(record) >= cutoff)
    })).filter(session => session.records.length)
      .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt) || a.id.localeCompare(b.id));
    if (next.length > sessionLimit) {
      next = sessionLimit === 0 ? [] : next.slice(-sessionLimit);
    }
    const dropOldest = () => {
      if (!next.length) return false;
      next[0].records.shift();
      if (next[0].records.length === 0) next.shift();
      return true;
    };
    while (recordCount(next) > recordLimit) dropOldest();
    let candidate = envelope(next, new Date(current).toISOString());
    while (next.length && byteLength(JSON.stringify(candidate)) > byteLimit) {
      dropOldest();
      candidate = envelope(next, new Date(current).toISOString());
    }
    if (byteLength(JSON.stringify(candidate)) > byteLimit) {
      throw Error('diagnostic journal exceeds its fixed byte limit');
    }
    return {document: candidate, sessions: next};
  };

  const forkChunkLayout = source => ({
    sessions: source.sessions.map(session => ({...session, chunks: [...session.chunks]}))
  });
  const durableSessions = () => chunkedStore ? sessionsFromChunkLayout(chunkLayout) : sessions;
  const prepareChunkMutation = source => ({
    changed: new Set(),
    indexChanged: false,
    layout: forkChunkLayout(source),
    originalKeys: new Set(chunkLayoutKeys(source)),
    removed: new Set()
  });
  const removeChunkAt = (mutation, sessionIndex, chunkIndex) => {
    const session = mutation.layout.sessions[sessionIndex];
    const [removed] = session.chunks.splice(chunkIndex, 1);
    if (removed) {
      mutation.changed.delete(removed.key);
      mutation.removed.add(removed.key);
      mutation.indexChanged = true;
    }
    if (session.chunks.length === 0) {
      mutation.layout.sessions.splice(sessionIndex, 1);
      mutation.indexChanged = true;
    }
  };
  const replaceChunkRecords = (mutation, sessionIndex, chunkIndex, records) => {
    const session = mutation.layout.sessions[sessionIndex];
    const previous = session.chunks[chunkIndex];
    const replacement = diagnosticChunk(session.id, records, previous.key);
    if (!replacement) throw Error('diagnostic record exceeds its fixed chunk limit');
    session.chunks[chunkIndex] = replacement;
    mutation.changed.add(replacement.key);
  };
  const pruneChunkMutation = (mutation, current) => {
    const cutoff = current - Math.max(0, Number(maxAge) || 0);
    for (let sessionIndex = mutation.layout.sessions.length - 1; sessionIndex >= 0;
      sessionIndex -= 1) {
      const session = mutation.layout.sessions[sessionIndex];
      for (let chunkIndex = session.chunks.length - 1; chunkIndex >= 0; chunkIndex -= 1) {
        const chunk = session.chunks[chunkIndex];
        if (chunk.oldestTimestamp >= cutoff) continue;
        const retained = chunk.records.filter(record => recordTimestamp(record) >= cutoff);
        if (retained.length === 0) removeChunkAt(mutation, sessionIndex, chunkIndex);
        else replaceChunkRecords(mutation, sessionIndex, chunkIndex, retained);
      }
    }
    while (mutation.layout.sessions.length > sessionLimit) {
      const session = mutation.layout.sessions[0];
      for (const chunk of session.chunks) mutation.removed.add(chunk.key);
      mutation.layout.sessions.shift();
      mutation.indexChanged = true;
    }
    let excess = chunkLayoutRecordCount(mutation.layout) - recordLimit;
    while (excess > 0 && mutation.layout.sessions.length) {
      const chunk = mutation.layout.sessions[0].chunks[0];
      if (chunk.records.length <= excess) {
        excess -= chunk.records.length;
        removeChunkAt(mutation, 0, 0);
      }
      else {
        replaceChunkRecords(mutation, 0, 0, chunk.records.slice(excess));
        excess = 0;
      }
    }
    const updatedAt = new Date(current).toISOString();
    while (mutation.layout.sessions.length &&
        chunkLayoutBytes(mutation.layout, updatedAt) > byteLimit) {
      const firstSession = mutation.layout.sessions[0];
      const firstChunk = firstSession.chunks[0];
      if (firstChunk.records.length === 1 || firstSession.chunks.length > 1 ||
          mutation.layout.sessions.length > 1) {
        removeChunkAt(mutation, 0, 0);
      }
      else {
        replaceChunkRecords(mutation, 0, 0, firstChunk.records.slice(1));
      }
    }
    if (chunkLayoutBytes(mutation.layout, updatedAt) > byteLimit) {
      throw Error('diagnostic journal exceeds its fixed byte limit');
    }
    return mutation;
  };
  const commitChunkMutation = async (mutation, current, {forceIndex = false} = {}) => {
    const existing = new Map();
    for (const session of mutation.layout.sessions) {
      for (const chunk of session.chunks) existing.set(chunk.key, {chunk, sessionId: session.id});
    }
    const writes = new Map();
    for (const key of mutation.changed) {
      const entry = existing.get(key);
      if (entry) writes.set(key, entry.chunk.document ||
        chunkDocument(entry.sessionId, entry.chunk.records));
    }
    const index = forceIndex || mutation.indexChanged ? chunkIndexEnvelope(
      mutation.layout, new Date(current).toISOString()
    ) : undefined;
    if (index !== undefined || writes.size) await store.commitChunks(index, writes);
    chunkLayout = mutation.layout;
    const retained = new Set(existing.keys());
    const stale = [...mutation.removed].filter(key =>
      mutation.originalKeys.has(key) && !retained.has(key));
    if (stale.length) await store.removeChunks(stale).catch(() => undefined);
  };
  const lastChunkRecord = (layout, sessionId) => layout.sessions
    .find(session => session.id === sessionId)?.chunks.at(-1)?.records.at(-1);
  const checkpointRemovedHighWater = async mutation => {
    await hydrateSession();
    const retained = lastChunkRecord(mutation.layout, sessionState.id);
    if (!retained || retained.sequence < sessionState.lastSequence) {
      await sessionStore.write(sessionState);
    }
  };
  const appendDurableChunk = async (record, point) => {
    const mutation = prepareChunkMutation(chunkLayout);
    let session = mutation.layout.sessions.find(candidate => candidate.id === point.sessionId);
    if (!session) {
      session = {chunks: [], id: point.sessionId, startedAt: point.startedAt};
      mutation.layout.sessions.push(session);
      mutation.layout.sessions.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt) ||
        a.id.localeCompare(b.id));
      mutation.indexChanged = true;
    }
    const previous = session.chunks.at(-1);
    const combined = previous && previous.records.length < MAX_DIAGNOSTIC_CHUNK_RECORDS ?
      diagnosticChunk(session.id, [...previous.records, record], previous.key) : undefined;
    if (combined) {
      session.chunks[session.chunks.length - 1] = combined;
      mutation.changed.add(combined.key);
    }
    else {
      const created = diagnosticChunk(session.id, [record]);
      if (!created) throw Error('diagnostic record exceeds its fixed chunk limit');
      session.chunks.push(created);
      mutation.changed.add(created.key);
      mutation.indexChanged = true;
    }
    const current = now();
    pruneChunkMutation(mutation, current);
    await checkpointRemovedHighWater(mutation);
    await commitChunkMutation(mutation, current);
    return clone(record);
  };

  const hydrate = () => {
    if (hydrated) return hydrated;
    const operation = (async () => {
    const stored = await store.read();
    if (stored === undefined) {
      sessions = [];
      chunkLayout = {sessions: []};
      if (chunkedStore) {
        const orphans = await store.listChunks();
        if (orphans.length) await store.removeChunks(orphans);
      }
      return;
    }
    if (chunkedStore && (exactLegacyEnvelope(stored) || exactStoredEnvelope(stored))) {
      const existingChunks = await store.listChunks();
      const migrated = exactLegacyEnvelope(stored) ? migrateLegacyEnvelope(stored) : stored;
      if (!migrated) {
        await store.clearChunks(existingChunks);
        chunkLayout = {sessions: []};
        return;
      }
      const built = buildChunkLayout(normalizeEnvelope(migrated));
      const mutation = prepareChunkMutation(built);
      mutation.changed = new Set(chunkLayoutKeys(built));
      mutation.originalKeys = new Set();
      const current = now();
      pruneChunkMutation(mutation, current);
      await commitChunkMutation(mutation, current, {forceIndex: true});
      const retained = new Set(chunkLayoutKeys(mutation.layout));
      const orphans = existingChunks.filter(key => !retained.has(key));
      if (orphans.length) await store.removeChunks(orphans);
      return;
    }
    if (chunkedStore && normalizeChunkIndex(stored)) {
      const index = normalizeChunkIndex(stored);
      const keys = index.sessions.flatMap(session => session.chunks);
      const allChunks = await store.listChunks();
      const values = await store.readChunks(keys);
      const salvaged = salvageChunkLayout(stored, values);
      chunkLayout = salvaged.layout;
      const mutation = prepareChunkMutation(chunkLayout);
      const current = now();
      pruneChunkMutation(mutation, current);
      if (mutation.changed.size || mutation.removed.size || mutation.indexChanged) {
        await checkpointRemovedHighWater(mutation);
      }
      if (salvaged.repaired || mutation.changed.size || mutation.removed.size ||
          mutation.indexChanged) {
        await commitChunkMutation(mutation, current, {forceIndex: salvaged.repaired});
      }
      const retained = new Set(chunkLayoutKeys(mutation.layout));
      const stale = allChunks.filter(key => !retained.has(key));
      if (stale.length) await store.removeChunks(stale);
      return;
    }
    if (exactLegacyEnvelope(stored)) {
      const migrated = migrateLegacyEnvelope(stored);
      if (!migrated) {
        await store.remove();
        sessions = [];
        return;
      }
      const pruned = prune(migrated.sessions, now());
      await store.write(pruned.document);
    sessions = pruned.sessions;
      return;
    }
    if (plainObject(stored) && stored.format === DIAGNOSTIC_FORMAT &&
        Number.isInteger(stored.version) && stored.version > DIAGNOSTIC_VERSION) {
      sessions = [];
      return;
    }
    if (!exactStoredEnvelope(stored)) {
      if (chunkedStore) await store.clearChunks(await store.listChunks());
      else await store.remove();
      sessions = [];
      chunkLayout = {sessions: []};
      return;
    }
    const normalized = normalizeEnvelope(stored);
    const pruned = prune(normalized, now());
    if (JSON.stringify(pruned.sessions) !== JSON.stringify(normalized) ||
        byteLength(JSON.stringify(stored)) > byteLimit) {
      await store.write(pruned.document);
    }
      sessions = pruned.sessions;
    })();
    const guarded = operation.catch(error => {
      if (hydrated === guarded) hydrated = undefined;
      throw error;
    });
    hydrated = guarded;
    return guarded;
  };

  const newSessionState = () => {
    const current = Math.max(0, Number(now()) || 0);
    const startedAt = new Date(current).toISOString();
    const generated = safeSessionId(createSessionId(current)) || defaultSessionId(current);
    return {
      format: DIAGNOSTIC_SESSION_FORMAT,
      id: generated,
      lastOffsetMs: 0,
      lastSequence: 0,
      lastTimestamp: startedAt,
      startedAt,
      version: DIAGNOSTIC_SESSION_VERSION
    };
  };
  const hydrateSession = () => {
    if (sessionHydrated) return sessionHydrated;
    const operation = (async () => {
      const stored = await sessionStore.read();
      if (stored === undefined || !exactSessionState(stored)) {
        if (stored !== undefined) await sessionStore.remove();
        sessionState = newSessionState();
        await sessionStore.write(sessionState);
        return;
      }
      sessionState = clone(stored);
      const durable = durableSessions().find(session => session.id === sessionState.id);
      const last = durable?.records.at(-1);
      if (last && (last.sequence > sessionState.lastSequence ||
          last.offsetMs > sessionState.lastOffsetMs ||
          new Date(last.timestamp) > new Date(sessionState.lastTimestamp))) {
        sessionState.lastSequence = Math.max(sessionState.lastSequence, last.sequence);
        sessionState.lastOffsetMs = Math.max(sessionState.lastOffsetMs, last.offsetMs);
        sessionState.lastTimestamp = new Date(Math.max(
          new Date(sessionState.lastTimestamp).getTime(),
          new Date(last.timestamp).getTime()
        )).toISOString();
        await sessionStore.write(sessionState);
      }
    })();
    const guarded = operation.catch(error => {
      if (sessionHydrated === guarded) sessionHydrated = undefined;
      throw error;
    });
    sessionHydrated = guarded;
    return guarded;
  };

  const serialize = task => {
    const operation = tail.then(task);
    tail = operation.catch(() => {});
    return operation;
  };
  const enqueue = task => serialize(async () => {
    await hydrate();
    return task();
  });
  const allocate = async privateContext => {
    await hydrateSession();
    const startedMs = new Date(sessionState.startedAt).getTime();
    const current = Math.max(startedMs, Number(now()) || startedMs);
    if (privateContext) {
      if (privateClock.id !== sessionState.id) {
        privateClock = {
          id: sessionState.id,
          lastOffsetMs: 0,
          lastSequence: 0,
          lastTimestamp: sessionState.startedAt
        };
      }
      const timestampMs = Math.max(current, new Date(privateClock.lastTimestamp).getTime());
      privateClock.lastSequence += 1;
      privateClock.lastOffsetMs = Math.max(privateClock.lastOffsetMs, timestampMs - startedMs);
      privateClock.lastTimestamp = new Date(timestampMs).toISOString();
      return {
        offsetMs: privateClock.lastOffsetMs,
        sequence: privateClock.lastSequence,
        sessionId: sessionState.id,
        startedAt: sessionState.startedAt,
        timestamp: privateClock.lastTimestamp
      };
    }
    const timestampMs = Math.max(current, new Date(sessionState.lastTimestamp).getTime());
    const next = {
      ...sessionState,
      lastOffsetMs: Math.max(sessionState.lastOffsetMs, timestampMs - startedMs),
      lastSequence: sessionState.lastSequence + 1,
      lastTimestamp: new Date(timestampMs).toISOString()
    };
    if (!chunkedStore) await sessionStore.write(next);
    sessionState = next;
    return {
      offsetMs: next.lastOffsetMs,
      sequence: next.lastSequence,
      sessionId: next.id,
      startedAt: next.startedAt,
      timestamp: next.lastTimestamp
    };
  };
  const append = async (record, point, privateContext) => {
    if (!privateContext && chunkedStore) return appendDurableChunk(record, point);
    const source = privateContext ? privateSessions : sessions;
    const next = clone(source);
    let session = next.find(candidate => candidate.id === point.sessionId);
    if (!session) {
      session = {id: point.sessionId, records: [], startedAt: point.startedAt};
      next.push(session);
    }
    session.records.push(record);
    session.records.sort((a, b) => a.sequence - b.sequence || a.offsetMs - b.offsetMs ||
      a.timestamp.localeCompare(b.timestamp));
    const pruned = prune(next, now());
    if (!privateContext) await store.write(pruned.document);
    if (privateContext) privateSessions = pruned.sessions;
    else sessions = pruned.sessions;
    return clone(record);
  };
  const refresh = async () => {
    if (chunkedStore) {
      const mutation = prepareChunkMutation(chunkLayout);
      const current = now();
      pruneChunkMutation(mutation, current);
      if (mutation.changed.size || mutation.removed.size || mutation.indexChanged) {
        await checkpointRemovedHighWater(mutation);
        await commitChunkMutation(mutation, current);
      }
      privateSessions = prune(privateSessions, current).sessions;
      return;
    }
    const durable = prune(sessions, now());
    if (JSON.stringify(durable.sessions) !== JSON.stringify(sessions)) {
      await store.write(durable.document);
    }
    sessions = durable.sessions;
    privateSessions = prune(privateSessions, now()).sessions;
  };
  const incidentEntries = ({includeDurable = true, includePrivate = false} = {}) => [
    ...(includeDurable ? durableSessions() : []),
    ...(includePrivate ? privateSessions : [])
  ].flatMap(session => session.records.filter(record => record.kind === 'incident')
    .map(record => ({record, session})))
    .sort((a, b) => recordTimestamp(a.record) - recordTimestamp(b.record) ||
      a.record.sequence - b.record.sequence || a.session.id.localeCompare(b.session.id));
  const findIncident = (incidentId, access) => {
    const id = incidentId === undefined ? undefined : safeIncidentId(incidentId);
    if (incidentId !== undefined && !id) return undefined;
    const entries = incidentEntries(access);
    return id ? entries.filter(entry => entry.record.incident.id === id).at(-1) : entries.at(-1);
  };
  const replaceDurableIncidentChunk = async incident => {
    const mutation = prepareChunkMutation(chunkLayout);
    const sessionIndex = mutation.layout.sessions.findIndex(session => session.id === sessionState.id);
    if (sessionIndex === -1) return undefined;
    const session = mutation.layout.sessions[sessionIndex];
    const chunkIndex = session.chunks.findIndex(chunk => chunk.records.some(record =>
      record.kind === 'incident' && record.incident.id === incident.id));
    if (chunkIndex === -1) return undefined;
    const records = session.chunks[chunkIndex].records.map(record =>
      record.kind === 'incident' && record.incident.id === incident.id ? {
        ...record,
        incident,
        timestamp: incident.endedAt
      } : record);
    replaceChunkRecords(mutation, sessionIndex, chunkIndex, records);
    const current = now();
    pruneChunkMutation(mutation, current);
    await commitChunkMutation(mutation, current);
    return clone(incident);
  };

  const record = snapshot => {
    const incident = projectDiagnosticIncident(snapshot, {manifest, userAgent});
    if (!incident) return Promise.resolve(undefined);
    const privateContext = snapshot.privateContext === true;
    return enqueue(async () => {
      await refresh();
      await hydrateSession();
      const selected = privateContext ? privateSessions : durableSessions();
      const current = selected.find(session => session.id === sessionState.id);
      const existing = current?.records.find(entry =>
        entry.kind === 'incident' && entry.incident.id === incident.id);
      if (existing) {
        if (!privateContext && chunkedStore) return replaceDurableIncidentChunk(incident);
        const next = clone(selected);
        const replacement = next.find(session => session.id === sessionState.id).records
          .find(entry => entry.kind === 'incident' && entry.incident.id === incident.id);
        replacement.incident = incident;
        replacement.timestamp = incident.endedAt;
        const pruned = prune(next, now());
        if (!privateContext) await store.write(pruned.document);
        if (privateContext) privateSessions = pruned.sessions;
        else sessions = pruned.sessions;
        return clone(incident);
      }
      const point = await allocate(privateContext);
      await append({
        incident,
        kind: 'incident',
        offsetMs: point.offsetMs,
        sequence: point.sequence,
        timestamp: incident.endedAt
      }, point, privateContext);
      return clone(incident);
    });
  };

  const appendProjectedEvent = (projected, access = {}) => {
    if (!projected) return Promise.resolve(undefined);
    const privateContext = access?.privateContext === true;
    return enqueue(async () => {
      await refresh();
      const point = await allocate(privateContext);
      return append({
        ...projected,
        kind: 'event',
        offsetMs: point.offsetMs,
        sequence: point.sequence,
        timestamp: point.timestamp
      }, point, privateContext);
    }).catch(() => undefined);
  };
  const event = (value, access) => appendProjectedEvent(projectDiagnosticEvent(value, {
    correlation: ownValue(value, 'correlation'),
    manifest,
    userAgent
  }), access);

  const browserSession = () => enqueue(async () => {
    await hydrateSession();
    return {
      id: sessionState.id,
      offsetMs: sessionState.lastOffsetMs,
      sequence: sessionState.lastSequence,
      startedAt: sessionState.startedAt
    };
  }).catch(() => undefined);
  const latest = (incidentId, access) => enqueue(async () => {
    await refresh();
    return clone(findIncident(incidentId, access)?.record.incident);
  });
  const snapshot = ({includeDurable = true} = {}) => enqueue(async () => {
    await refresh();
    return clone(envelope(includeDurable ? durableSessions() : [], new Date(now()).toISOString()));
  });
  const selectedSessions = async (selector, access) => {
    const available = [
      ...(access?.includeDurable !== false ? durableSessions() : []),
      ...(access?.includePrivate === true ? privateSessions : [])
    ];
    if (selector.scope === 'all') return clone(available);
    if (selector.scope === 'current-session') {
      await hydrateSession();
      return clone(available.filter(session => session.id === sessionState.id));
    }
    const match = findIncident(selector.incidentId, access);
    if (!match) return [];
    return [{...clone(match.session), records: [clone(match.record)]}];
  };
  const exportText = (selectorValue, access) => enqueue(async () => {
    await refresh();
    const selector = typeof selectorValue === 'string' ?
      {incidentId: selectorValue, scope: 'incident'} :
      plainObject(selectorValue) ? clone(selectorValue) : {scope: 'latest'};
    if (!['all', 'current-session', 'incident', 'latest'].includes(selector.scope)) {
      return {incident: null, scope: 'invalid', text: ''};
    }
    if (selector.scope === 'incident' && !safeIncidentId(selector.incidentId)) {
      return {incident: null, scope: 'incident', text: ''};
    }
    const chosen = await selectedSessions(selector, access);
    const chosenIncidents = chosen.flatMap(session => session.records
      .filter(record => record.kind === 'incident').map(record => record.incident));
    const incident = chosenIncidents.at(-1) || null;
    const text = ['incident', 'latest'].includes(selector.scope) ?
      (incident ? formatDiagnosticLog(incident) : '') :
      formatDiagnosticHistory(chosen, {scope: selector.scope});
    return {
      incident: clone(incident),
      incidentCount: chosenIncidents.length,
      recordCount: recordCount(chosen),
      scope: selector.scope,
      sessionCount: chosen.length,
      text
    };
  });
  const clear = ({clearDurable = true, clearPrivate = false} = {}) => enqueue(async () => {
    if (clearDurable) {
      await hydrateSession();
      await sessionStore.write(sessionState);
      if (chunkedStore) await store.clearChunks(await store.listChunks());
      else await store.remove();
      sessions = [];
      chunkLayout = {sessions: []};
    }
    if (clearPrivate) privateSessions = [];
    return {cleared: true};
  });
  const invalidate = ({browserSession: resetSession = false, durable = true} = {}) =>
    serialize(() => {
      if (durable) {
        hydrated = undefined;
        sessions = [];
        chunkLayout = {sessions: []};
      }
      if (resetSession) {
        sessionHydrated = undefined;
        sessionState = undefined;
        privateClock = {id: undefined, lastOffsetMs: 0, lastSequence: 0, lastTimestamp: undefined};
        privateSessions = [];
      }
      return true;
    });

  const spanPayload = (value, fallback = {}) => {
    if (typeof value === 'string') return {...fallback, code: value};
    if (!plainObject(value)) return fallback;
    const next = {...fallback};
    for (const key of ['action', 'command', 'phase', 'outcome', 'counts', 'code', 'attempt']) {
      if (hasOwnValue(value, key)) next[key] = ownValue(value, key);
    }
    if (hasOwnValue(value, 'status') && !hasOwnValue(value, 'outcome')) {
      next.outcome = ownValue(value, 'status');
    }
    if (hasOwnValue(value, 'summary') && !hasOwnValue(value, 'counts')) {
      next.counts = ownValue(value, 'summary');
    }
    if (hasOwnValue(value, 'reasonCode') && !hasOwnValue(value, 'code')) {
      next.code = ownValue(value, 'reasonCode');
    }
    return next;
  };
  const start = (value, access) => {
    const source = ownValue(value, 'source') || ownValue(value, 'origin');
    const actionValue = ownValue(value, 'command') || ownValue(value, 'action');
    const base = {source};
    if (SAFE_DIAGNOSTIC_COMMANDS.has(actionValue)) base.command = actionValue;
    else if (SAFE_UI_ACTIONS.has(actionValue)) base.action = actionValue;
    const generated = safeCorrelation(ownValue(value, 'correlation')) ||
      safeCorrelation(createCorrelationId()) || defaultCorrelationId();
    const withToken = payload => event({...payload, correlation: generated}, access);
    const ready = withToken({...base, type: 'ACTION_START', outcome: 'STARTED'});
    return Object.freeze({
      finish: (payload, counts) => withToken(spanPayload(payload, {
        ...base,
        ...(counts && {counts}),
        type: 'ACTION_END'
      })),
      ready,
      retry: (payload, attempt) => withToken(spanPayload(payload, {
        ...base,
        ...(attempt !== undefined && {attempt}),
        outcome: 'RETRYING',
        type: 'ACTION_RETRY'
      })),
      stage: (payload, counts) => withToken(spanPayload(payload, {
        ...base,
        ...(counts && {counts}),
        outcome: 'PROGRESS',
        type: 'ACTION_STAGE'
      })),
      timeout: payload => withToken(spanPayload(payload, {
        ...base,
        outcome: 'TIMED_OUT',
        type: 'ACTION_TIMEOUT'
      })),
      token: generated
    });
  };
  const flush = () => tail;

  return Object.freeze({
    browserSession,
    clear,
    event,
    exportText,
    flush,
    invalidate,
    latest,
    record,
    snapshot,
    start
  });
};

const createDiagnosticStorageChangeListener = journal => (changes, areaName) => {
  if (areaName !== 'local' || !changes ||
      !Object.hasOwn(changes, DIAGNOSTIC_STORAGE_KEY)) {
    return;
  }
  const descriptor = Object.getOwnPropertyDescriptor(changes, DIAGNOSTIC_STORAGE_KEY);
  const change = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  const next = change && (typeof change === 'object' || typeof change === 'function') ?
    Object.getOwnPropertyDescriptor(change, 'newValue') : undefined;
  // This worker is the sole journal writer. A replacement value is therefore
  // our own commit and must not invalidate the layout that produced it. A
  // missing newValue is an out-of-band clear and still invalidates caches.
  if (next && next.value !== undefined) return;
  void Promise.resolve(journal?.invalidate?.({durable: true})).catch(() => undefined);
};

const diagnosticJournal = createDiagnosticJournal();
try {
  globalThis.chrome?.storage?.onChanged?.addListener(
    createDiagnosticStorageChangeListener(diagnosticJournal)
  );
}
catch (error) {}

export {
  browserFamily,
  createDiagnosticStorageChangeListener,
  createDiagnosticJournal,
  defaultCorrelationId,
  defaultSessionId,
  DIAGNOSTIC_COMMANDS,
  DIAGNOSTIC_COUNT_KEYS,
  DIAGNOSTIC_EVENT_CODES,
  DIAGNOSTIC_EVENT_TYPES,
  DIAGNOSTIC_FORMAT,
  DIAGNOSTIC_MAX_AGE,
  DIAGNOSTIC_OUTCOMES,
  DIAGNOSTIC_PHASES,
  DIAGNOSTIC_SESSION_FORMAT,
  DIAGNOSTIC_SESSION_STORAGE_KEY,
  DIAGNOSTIC_SESSION_VERSION,
  DIAGNOSTIC_SOURCES,
  DIAGNOSTIC_STORAGE_TIMEOUT,
  DIAGNOSTIC_STORAGE_KEY,
  DIAGNOSTIC_UI_ACTIONS,
  DIAGNOSTIC_VERSION,
  diagnosticJournal,
  diagnosticSessionStorageAdapter,
  diagnosticStorageAdapter,
  formatDiagnosticHistory,
  formatDiagnosticLog,
  GROUP_POLICY,
  MAX_DIAGNOSTIC_BYTES,
  MAX_DIAGNOSTIC_EVENTS,
  MAX_DIAGNOSTIC_INCIDENTS,
  MAX_DIAGNOSTIC_SESSIONS,
  migrateLegacyEnvelope,
  normalizeEnvelope,
  projectDiagnosticEvent,
  projectDiagnosticIncident
};
