import {boundedRuntimeMessage} from './runtime-call.mjs';

const CORRELATION_PATTERN = /^ATDC-[A-Z0-9]{16,40}$/;
const SAFE_TYPES = new Set(['UI_ACTION', 'REQUEST', 'RESPONSE']);
const SAFE_PHASES = new Set([
  'CLICK', 'SEND', 'RESPONSE', 'RETRY', 'CANCEL', 'EXPORT', 'CLEAR', 'SCAN'
]);
const SAFE_OUTCOMES = new Set([
  'STARTED', 'PROGRESS', 'RETRYING', 'TIMED_OUT', 'SUCCEEDED', 'COMPLETED',
  'PARTIAL', 'SKIPPED', 'FAILED', 'DENIED', 'CANCELLED', 'INTERRUPTED'
]);
const SAFE_CODES = new Set([
  'REQUEST_SENT', 'REQUEST_SUCCEEDED', 'REQUEST_FAILED', 'REQUEST_TIMEOUT',
  'REQUEST_DENIED', 'EXPORT_READY', 'EXPORT_EMPTY', 'CLEAR_SUCCEEDED',
  'CLEAR_FAILED', 'CONTROL_ACTIVATED', 'CONFLICT_SCAN_STARTED',
  'CONFLICT_SCAN_COMPLETED', 'CONFLICT_SCAN_ACCESS_DENIED',
  'CONFLICT_SCAN_ACCESS_REMOVED', 'DUPLICATE_SELF_ENABLED',
  'EXTERNAL_DISCARDER_ENABLED', 'EXTERNAL_PLACEHOLDER_PRESENT',
  'EXTERNAL_SLEEPERS_PRESENT', 'TAB_MANAGER_ENABLED', 'NO_CHANGE'
]);
const SAFE_ACTIONS = new Set([
  'SHOW_DIAGNOSTICS', 'COPY_DIAGNOSTICS', 'DOWNLOAD_LATEST',
  'DOWNLOAD_CURRENT_SESSION', 'DOWNLOAD_ALL_HISTORY', 'CLEAR_DIAGNOSTICS',
  'RETRY_COMMAND', 'CANCEL_COMMAND', 'EXPORT_SUPPORT_BUNDLE', 'OPEN_OPTIONS',
  'OPEN_POPUP',
  'RUN_CONFLICT_SCAN', 'REMOVE_CONFLICT_SCAN_ACCESS', 'ENABLE_FRAME_ACCESS',
  'DISABLE_FRAME_ACCESS', 'SAVE_SETTINGS', 'RESET_SETTINGS', 'EXPORT_SETTINGS',
  'IMPORT_SETTINGS', 'OPEN_SUPPORT', 'TOGGLE_TEMP_DISABLE', 'TOGGLE_AUTODISCARD',
  'COMMAND_CONTROL', 'SETTING_CONTROL', 'PLUGIN_CONTROL', 'SITE_RULE_CONTROL'
]);
const SAFE_COMMANDS = new Set([
  'discard-lefts', 'discard-other-windows', 'discard-rights', 'discard-tab',
  'discard-tabs', 'discard-tree', 'discard-window', 'release-lefts',
  'release-other-windows', 'release-rights', 'release-tabs', 'release-window',
  'open-tab-then-discard', 'auto-discardable', 'toggle-allowed',
  'whitelist-domain', 'whitelist-session', 'move-previous', 'move-next', 'close'
]);
const SAFE_COUNT_KEYS = new Set([
  'total', 'success', 'skipped', 'failed', 'attempted', 'eligible', 'protected',
  'unsupported', 'retried', 'timedOut', 'cancelled', 'enabled', 'disabled',
  'conflicts', 'duplicates', 'dropped', 'discardedTabs', 'duplicateCopies',
  'enabledExtensions', 'externalDiscarders', 'externalPlaceholders',
  'externalSleepers', 'selfOwnedSleepers', 'tabManagers', 'unknownSleepers'
]);

const own = (value, key) => value !== null && typeof value === 'object' &&
  Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
const safeInteger = value => Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000;

const correlationToken = (cryptoObject = globalThis.crypto) => {
  const bytes = new Uint8Array(10);
  try {
    cryptoObject?.getRandomValues?.(bytes);
  }
  catch (error) {
    return undefined;
  }
  if (!bytes.some(value => value !== 0)) {
    return undefined;
  }
  return `ATDC-${[...bytes].map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
};

const safeCounts = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const counts = {};
  for (const [key, count] of Object.entries(value)) {
    if (!SAFE_COUNT_KEYS.has(key) || !safeInteger(count)) continue;
    counts[key] = count;
  }
  return Object.keys(counts).length ? counts : undefined;
};

const projectEvent = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !SAFE_TYPES.has(value.type)) {
    return undefined;
  }
  const event = {type: value.type};
  const optionals = [
    ['action', SAFE_ACTIONS],
    ['command', SAFE_COMMANDS],
    ['phase', SAFE_PHASES],
    ['outcome', SAFE_OUTCOMES],
    ['code', SAFE_CODES]
  ];
  for (const [key, allowed] of optionals) {
    const candidate = own(value, key);
    if (candidate === undefined) continue;
    if (!allowed.has(candidate)) return undefined;
    event[key] = candidate;
  }
  if (own(value, 'attempt') !== undefined) {
    if (!Number.isSafeInteger(value.attempt) || value.attempt < 0 || value.attempt > 10_000) {
      return undefined;
    }
    event.attempt = value.attempt;
  }
  const counts = safeCounts(own(value, 'counts'));
  if (own(value, 'counts') !== undefined && !counts) return undefined;
  if (counts) event.counts = counts;
  return event;
};

const responseCounts = value => {
  const source = own(value, 'summary') || own(own(value, 'value'), 'summary');
  const total = own(value, 'total') ?? own(own(value, 'value'), 'total');
  const completed = own(value, 'completed') ?? own(own(value, 'value'), 'completed');
  return safeCounts({
    total: safeInteger(total) ? total : undefined,
    attempted: safeInteger(completed) ? completed : undefined,
    success: safeInteger(own(source, 'success')) ? source.success : undefined,
    skipped: safeInteger(own(source, 'skipped')) ? source.skipped : undefined,
    failed: safeInteger(own(source, 'failed')) ? source.failed : undefined
  });
};

const createDiagnosticClient = ({
  authorization = () => ({}),
  cryptoObject = globalThis.crypto,
  runtime = globalThis.chrome?.runtime,
  timeoutMs = 2500
} = {}) => {
  let droppedEvents = 0;
  const emit = async (value, {correlation} = {}) => {
    const event = projectEvent(value);
    if (!event || typeof runtime?.sendMessage !== 'function') return false;
    const reportedDrops = droppedEvents;
    if (reportedDrops > 0) {
      event.counts = {
        ...(event.counts || {}),
        dropped: Math.min(10_000_000, reportedDrops)
      };
    }
    const auth = authorization?.();
    const request = {
      method: 'diagnostic-event',
      event
    };
    if (CORRELATION_PATTERN.test(correlation || '')) request.correlation = correlation;
    if (Number.isInteger(auth?.tabId)) request.tabId = auth.tabId;
    if (Number.isInteger(auth?.windowId)) request.windowId = auth.windowId;
    const response = await boundedRuntimeMessage(runtime, request, {timeoutMs});
    const accepted = response?.ok === true && response.value?.accepted === true;
    if (accepted) droppedEvents = Math.max(0, droppedEvents - reportedDrops);
    else droppedEvents = Math.min(10_000_000, droppedEvents + 1);
    return accepted;
  };
  const start = ({action, command, attempt = 0} = {}) => {
    const correlation = correlationToken(cryptoObject);
    const base = {
      ...(SAFE_ACTIONS.has(action) ? {action} : {}),
      ...(SAFE_COMMANDS.has(command) ? {command} : {})
    };
    const event = (type, phase, outcome, code, details = {}) => void emit({
      ...base,
      type,
      phase,
      outcome,
      code,
      ...(safeInteger(details.attempt) ? {attempt: details.attempt} : {}),
      ...(safeCounts(details.counts) ? {counts: safeCounts(details.counts)} : {})
    }, {correlation});
    return Object.freeze({
      cancelled: details => event('RESPONSE', 'RESPONSE', 'CANCELLED', 'REQUEST_FAILED', details),
      correlation,
      click: () => event('UI_ACTION', 'CLICK', 'STARTED', 'CONTROL_ACTIVATED', {attempt}),
      completed: details => event('RESPONSE', 'RESPONSE', 'COMPLETED', 'REQUEST_SUCCEEDED', details),
      denied: details => event('RESPONSE', 'RESPONSE', 'DENIED', 'REQUEST_DENIED', details),
      failed: details => event('RESPONSE', 'RESPONSE', 'FAILED', 'REQUEST_FAILED', details),
      partial: details => event('RESPONSE', 'RESPONSE', 'PARTIAL', 'REQUEST_SUCCEEDED', details),
      progress: details => event('RESPONSE', 'RESPONSE', 'PROGRESS', 'REQUEST_SUCCEEDED', details),
      request: details => event('REQUEST', 'SEND', 'STARTED', 'REQUEST_SENT', details),
      retry: details => event('REQUEST', 'RETRY', 'RETRYING', 'REQUEST_SENT', details),
      skipped: details => event('RESPONSE', 'RESPONSE', 'SKIPPED', 'NO_CHANGE', details),
      succeeded: details => event('RESPONSE', 'RESPONSE', 'SUCCEEDED', 'REQUEST_SUCCEEDED', details),
      timedOut: details => event('RESPONSE', 'RESPONSE', 'TIMED_OUT', 'REQUEST_TIMEOUT', details)
    });
  };
  return Object.freeze({emit, start});
};

export {
  correlationToken,
  createDiagnosticClient,
  projectEvent,
  responseCounts,
  SAFE_ACTIONS,
  SAFE_COMMANDS
};
