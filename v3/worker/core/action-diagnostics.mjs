import {FAILURE_CAUSES, failureCauseFrom, safeFailureCause} from './failure-causes.mjs';
import {POPUP_CODES} from './popup-progress.mjs';

const MAX_COUNT = 1_000_000;
const DIAGNOSTIC_CAPABILITY_MAX = 128;
const DIAGNOSTIC_CAPABILITY_TTL = 5 * 60 * 1000;
const CONFLICT_SCAN_ENDPOINT_TIMEOUT = 8_000;
const ACTION_COMMANDS = new Set([
  'auto-discardable', 'automatic-discard', 'automatic-scan', 'close',
  'discard-lefts', 'discard-other-windows', 'discard-rights', 'discard-tab',
  'discard-tabs', 'discard-tree', 'discard-window', 'external-discard',
  'move-next', 'move-previous', 'open-tab-then-discard', 'release-lefts',
  'release-other-windows', 'release-rights', 'release-tabs', 'release-window',
  'settings-import', 'settings-reset', 'startup-recovery', 'takeover-recovery',
  'toggle-allowed', 'whitelist-domain', 'whitelist-session', 'worker-startup'
]);
const ACTION_SOURCES = new Set([
  'automatic', 'automatic-alarm', 'automatic-startup', 'context-menu',
  'external', 'keyboard', 'options', 'popup', 'recovery', 'reset', 'runtime',
  'settings', 'toolbar', 'worker'
]);
const ACTION_PHASES = new Set([
  'CANCEL', 'CLEAR', 'CLICK', 'EXPORT', 'RESPONSE', 'RETRY', 'SCAN', 'SEND',
  'admission', 'command', 'completion', 'eligibility', 'keeper',
  'metadata-check', 'native-discard', 'ownership', 'ownership-finalization',
  'ownership-resolution', 'release', 'reset', 'scope-query', 'settings',
  'startup', 'storage', 'tab-operation', 'takeover', 'verification',
  'visual-marker'
]);
const ACTION_OUTCOMES = new Set([
  'CANCELLED', 'COMPLETED', 'DENIED', 'FAILED', 'INTERRUPTED', 'PARTIAL',
  'PROGRESS', 'RETRYING', 'SKIPPED', 'STARTED', 'SUCCEEDED', 'TIMED_OUT',
  'cancelled', 'complete', 'denied', 'failed', 'interrupted', 'partial',
  'progress', 'retrying', 'skipped', 'started', 'success', 'timed-out'
]);
const ACTION_EVENT_TYPES = new Set([
  'ACTION_END', 'ACTION_RETRY', 'ACTION_STAGE', 'ACTION_START',
  'ACTION_TIMEOUT', 'RECOVERY_END', 'RECOVERY_START', 'REQUEST', 'RESET_END',
  'RESET_START', 'RESPONSE', 'UI_ACTION', 'WORKER_START',
  'action-end', 'action-retry', 'action-stage', 'action-start',
  'action-timeout', 'recovery-end', 'recovery-start', 'reset-end',
  'reset-start', 'worker-start'
]);
const UI_ACTIONS = new Set([
  'SHOW_DIAGNOSTICS', 'COPY_DIAGNOSTICS', 'DOWNLOAD_LATEST',
  'DOWNLOAD_CURRENT_SESSION', 'DOWNLOAD_ALL_HISTORY', 'CLEAR_DIAGNOSTICS',
  'RETRY_COMMAND', 'CANCEL_COMMAND', 'EXPORT_SUPPORT_BUNDLE', 'OPEN_OPTIONS',
  'OPEN_POPUP',
  'RUN_CONFLICT_SCAN', 'REMOVE_CONFLICT_SCAN_ACCESS', 'ENABLE_FRAME_ACCESS',
  'DISABLE_FRAME_ACCESS', 'SAVE_SETTINGS', 'RESET_SETTINGS', 'EXPORT_SETTINGS',
  'IMPORT_SETTINGS', 'OPEN_SUPPORT', 'TOGGLE_TEMP_DISABLE',
  'TOGGLE_AUTODISCARD', 'COMMAND_CONTROL', 'SETTING_CONTROL',
  'PLUGIN_CONTROL', 'SITE_RULE_CONTROL'
]);
const GENERAL_CODES = new Set([
  'WORKER_STARTED', 'ACTION_ADMITTED', 'ACTION_COMPLETED', 'ACTION_PARTIAL',
  'ACTION_FAILED', 'ACTION_CANCELLED', 'ACTION_INTERRUPTED',
  'RETRY_SCHEDULED', 'DEADLINE_EXCEEDED', 'REQUEST_SENT',
  'REQUEST_SUCCEEDED', 'REQUEST_FAILED', 'REQUEST_TIMEOUT', 'REQUEST_DENIED',
  'EXPORT_READY', 'EXPORT_EMPTY', 'CLEAR_SUCCEEDED', 'CLEAR_FAILED',
  'CONTROL_ACTIVATED', 'SCAN_STARTED', 'SCAN_COMPLETED',
  'CONFLICT_SCAN_STARTED', 'CONFLICT_SCAN_COMPLETED',
  'CONFLICT_SCAN_ACCESS_DENIED', 'CONFLICT_SCAN_ACCESS_REMOVED',
  'DUPLICATE_SELF_ENABLED', 'EXTERNAL_DISCARDER_ENABLED',
  'EXTERNAL_PLACEHOLDER_PRESENT', 'EXTERNAL_SLEEPERS_PRESENT',
  'TAB_MANAGER_ENABLED',
  'RECOVERY_STARTED', 'RECOVERY_COMPLETED', 'RESET_STARTED', 'RESET_COMPLETED',
  'NO_CHANGE'
]);
const SAFE_CODES = new Set([
  ...GENERAL_CODES,
  ...Object.values(FAILURE_CAUSES),
  ...Object.values(POPUP_CODES)
]);
const COUNT_KEYS = new Set([
  'attempted', 'cancelled', 'conflicts', 'disabled', 'eligible', 'enabled',
  'failed', 'protected', 'duplicates', 'dropped', 'retried', 'skipped', 'success',
  'timedOut', 'total', 'unsupported', 'discardedTabs', 'duplicateCopies',
  'enabledExtensions', 'externalDiscarders', 'externalPlaceholders',
  'externalSleepers', 'selfOwnedSleepers', 'tabManagers', 'unknownSleepers'
]);
const TERMINAL_STATES = new Set([
  'cancelled', 'complete', 'failed', 'interrupted', 'partial'
]);
const TERMINAL_RESPONSE_OUTCOMES = new Set([
  'CANCELLED', 'COMPLETED', 'DENIED', 'FAILED', 'INTERRUPTED', 'PARTIAL',
  'SKIPPED', 'SUCCEEDED', 'TIMED_OUT', 'cancelled', 'complete', 'denied',
  'failed', 'interrupted', 'partial', 'skipped', 'success', 'timed-out'
]);

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const ownValue = (value, key) => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
};
const boundedInteger = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT ?
  value : undefined;
const safeCommand = value => ACTION_COMMANDS.has(value) ? value : undefined;
const safeSource = value => ACTION_SOURCES.has(value) ? value : undefined;
const safePhase = value => ACTION_PHASES.has(value) ? value : undefined;
const safeOutcome = value => ACTION_OUTCOMES.has(value) ? value : undefined;
const safeCode = value => SAFE_CODES.has(value) ? value : undefined;
const safeEventType = value => ACTION_EVENT_TYPES.has(value) ? value : undefined;
const safeUiAction = value => UI_ACTIONS.has(value) ? value : undefined;
const safeCorrelation = value => typeof value === 'string' &&
  /^ATDC-[A-Z0-9]{16,40}$/.test(value) ? value : undefined;
const hasOwnData = (value, key) => {
  if (!plainObject(value)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return Boolean(descriptor && Object.hasOwn(descriptor, 'value'));
};
const list = (value, key) => {
  const candidate = ownValue(value, key);
  return Array.isArray(candidate) ? candidate.slice(0, MAX_COUNT) : [];
};
const nested = (value, key) => {
  const candidate = ownValue(value, key);
  return plainObject(candidate) ? candidate : undefined;
};
const unwrap = value => {
  const errorResult = ownValue(value, 'result');
  if (errorResult && typeof errorResult === 'object') {
    return errorResult;
  }
  const responseValue = ownValue(value, 'value');
  if (plainObject(value) && typeof ownValue(value, 'ok') === 'boolean' &&
      responseValue && typeof responseValue === 'object') {
    return responseValue;
  }
  return value;
};

// Identifiers are used only as ephemeral de-duplication keys. They never leave
// this projection and are never passed to the diagnostic journal.
const outcomeKey = (entry, fallback) => {
  if (Number.isSafeInteger(entry)) {
    return `id:${entry}`;
  }
  const tab = ownValue(entry, 'tab');
  const tabId = ownValue(tab, 'id');
  if (Number.isSafeInteger(tabId)) {
    return `id:${tabId}`;
  }
  const id = ownValue(entry, 'id');
  return Number.isSafeInteger(id) ? `id:${id}` : fallback;
};

const directSummary = value => {
  const summary = nested(value, 'summary');
  if (!summary) return undefined;
  const success = boundedInteger(ownValue(summary, 'success')) ??
    boundedInteger(ownValue(summary, 'succeeded'));
  const skipped = boundedInteger(ownValue(summary, 'skipped'));
  const failed = boundedInteger(ownValue(summary, 'failed'));
  if ([success, skipped, failed].some(item => item === undefined)) {
    return undefined;
  }
  const total = boundedInteger(ownValue(summary, 'total')) ?? success + skipped + failed;
  if (total < success + skipped + failed) return undefined;
  return {failed, skipped, success, total};
};

const actionCounts = input => {
  const value = unwrap(input);
  const declared = directSummary(value);
  if (declared) return declared;

  const outcomes = new Map();
  const apply = (key, status, priority) => {
    list(value, key).forEach((entry, index) => {
      const id = outcomeKey(entry, `${key}:${index}`);
      const previous = outcomes.get(id);
      if (!previous || priority > previous.priority) {
        outcomes.set(id, {priority, status});
      }
    });
  };

  for (const key of ['succeeded', 'released', 'physicalOnly', 'discarded']) {
    apply(key, 'success', 10);
  }
  for (const key of ['alreadyOwned', 'alreadyOwnedPhysicalOnly', 'protected', 'skipped', 'missing']) {
    apply(key, 'skipped', 20);
  }
  for (const key of ['failed', 'unsupported', 'unknownOwnership', 'unknownSuspension']) {
    apply(key, 'failed', 30);
  }

  const counts = {failed: 0, skipped: 0, success: 0, total: outcomes.size};
  for (const outcome of outcomes.values()) {
    counts[outcome.status] += 1;
  }

  const candidates = boundedInteger(ownValue(value, 'candidates'));
  if (candidates !== undefined) counts.eligible = candidates;
  const scan = nested(value, 'scan');
  if (scan) {
    const attempted = boundedInteger(ownValue(scan, 'total'));
    if (attempted !== undefined) counts.attempted = attempted;
    if (ownValue(scan, 'timedOut') === true) {
      counts.timedOut = Math.max(1, list(scan, 'skipped').length);
    }
  }
  const frozen = nested(value, 'frozen');
  if (frozen) {
    const attempted = list(frozen, 'attempted').length;
    if (attempted) counts.attempted = Math.max(counts.attempted || 0, attempted);
    const eligible = list(frozen, 'eligible').length;
    if (eligible) counts.eligible = Math.max(counts.eligible || 0, eligible);
    const protectedCount = list(frozen, 'protected').length;
    if (protectedCount) counts.protected = protectedCount;
  }
  const unsupported = list(value, 'unsupported').length;
  if (unsupported) counts.unsupported = unsupported;
  const protectedCount = list(value, 'protected').length;
  if (protectedCount) counts.protected = Math.max(counts.protected || 0, protectedCount);
  return counts;
};

const terminalProjection = (value, error) => {
  const counts = actionCounts(error || value);
  const responseOk = ownValue(value, 'ok');
  const responseCode = safeCode(ownValue(value, 'code'));
  const result = unwrap(error || value);
  const explicitState = ownValue(result, 'state');
  let outcome;
  if (error || responseOk === false) {
    outcome = responseCode === POPUP_CODES.NO_SAFE_KEEPER ? 'skipped' : 'failed';
  }
  else if (responseCode === 'NO_CHANGE') {
    outcome = 'skipped';
  }
  else if (TERMINAL_STATES.has(explicitState)) {
    outcome = explicitState;
  }
  else if (counts.failed > 0 && counts.success > 0) {
    outcome = 'partial';
  }
  else if (counts.failed > 0) {
    outcome = 'failed';
  }
  else if (counts.total > 0 && counts.success === 0) {
    outcome = 'skipped';
  }
  else {
    outcome = 'complete';
  }
  const code = responseCode || (error ? failureCauseFrom(error) : undefined);
  return {
    ...(safeCode(code) && {code: safeCode(code)}),
    counts,
    outcome,
    phase: 'completion'
  };
};

const cleanCounts = value => {
  if (!plainObject(value)) return undefined;
  const counts = {};
  for (const key of COUNT_KEYS) {
    const count = boundedInteger(ownValue(value, key));
    if (count !== undefined) counts[key] = count;
  }
  return Object.keys(counts).length ? counts : undefined;
};

const noopSpan = Object.freeze({
  finish: async () => undefined,
  ready: Promise.resolve(undefined),
  retry: async () => undefined,
  stage: async () => undefined,
  timeout: async () => undefined,
  token: undefined
});
const settle = task => Promise.resolve(task).catch(() => undefined);
const spanCall = (span, method, payload) => {
  try {
    return settle(typeof span?.[method] === 'function' ? span[method](payload) : undefined);
  }
  catch (error) {
    return Promise.resolve(undefined);
  }
};

const safeSpan = (journal, {command, correlation, source}, access) => {
  if (!journal || typeof journal.start !== 'function' || !safeSource(source)) {
    return noopSpan;
  }
  try {
    return journal.start({
      ...(safeCommand(command) && {command: safeCommand(command)}),
      ...(safeCorrelation(correlation) && {correlation: safeCorrelation(correlation)}),
      source: safeSource(source)
    }, {privateContext: access?.privateContext === true}) || noopSpan;
  }
  catch (error) {
    return noopSpan;
  }
};

const projectActionEvent = value => {
  if (!plainObject(value)) return undefined;
  const required = {
    source: safeSource(ownValue(value, 'source')),
    type: safeEventType(ownValue(value, 'type'))
  };
  if (!required.source || !required.type) return undefined;
  for (const [key, sanitize] of [
    ['action', safeUiAction],
    ['command', safeCommand],
    ['phase', safePhase],
    ['outcome', safeOutcome],
    ['code', safeCode],
    ['correlation', safeCorrelation]
  ]) {
    if (hasOwnData(value, key) && !sanitize(ownValue(value, key))) return undefined;
  }
  if (hasOwnData(value, 'counts') && !cleanCounts(ownValue(value, 'counts'))) return undefined;
  if (hasOwnData(value, 'attempt') && boundedInteger(ownValue(value, 'attempt')) === undefined) {
    return undefined;
  }
  return {
    ...(safeUiAction(ownValue(value, 'action')) && {action: safeUiAction(ownValue(value, 'action'))}),
    ...(boundedInteger(ownValue(value, 'attempt')) !== undefined && {
      attempt: boundedInteger(ownValue(value, 'attempt'))
    }),
    ...(safeCode(ownValue(value, 'code')) && {code: safeCode(ownValue(value, 'code'))}),
    ...(safeCommand(ownValue(value, 'command')) && {command: safeCommand(ownValue(value, 'command'))}),
    ...(safeCorrelation(ownValue(value, 'correlation')) && {
      correlation: safeCorrelation(ownValue(value, 'correlation'))
    }),
    ...(cleanCounts(ownValue(value, 'counts')) && {counts: cleanCounts(ownValue(value, 'counts'))}),
    ...(safeOutcome(ownValue(value, 'outcome')) && {outcome: safeOutcome(ownValue(value, 'outcome'))}),
    ...(safePhase(ownValue(value, 'phase')) && {phase: safePhase(ownValue(value, 'phase'))}),
    ...(ownValue(value, 'privateContext') === true && {privateContext: true}),
    source: required.source,
    type: required.type
  };
};

const terminalDiagnosticResponse = value => ownValue(value, 'type') === 'RESPONSE' &&
  TERMINAL_RESPONSE_OUTCOMES.has(ownValue(value, 'outcome'));

const createDiagnosticCapabilityCache = ({
  maxEntries = DIAGNOSTIC_CAPABILITY_MAX,
  now = Date.now,
  ttlMs = DIAGNOSTIC_CAPABILITY_TTL
} = {}) => {
  const entries = new Map();
  const limit = Math.max(1, Math.min(DIAGNOSTIC_CAPABILITY_MAX,
    Number.isSafeInteger(maxEntries) ? maxEntries : DIAGNOSTIC_CAPABILITY_MAX));
  const lifetime = Math.max(1, Math.min(DIAGNOSTIC_CAPABILITY_TTL,
    Number.isSafeInteger(ttlMs) ? ttlMs : DIAGNOSTIC_CAPABILITY_TTL));
  const prune = current => {
    for (const [token, entry] of entries) {
      if (entry.expiresAt <= current) entries.delete(token);
    }
    while (entries.size > limit) entries.delete(entries.keys().next().value);
  };
  const remember = (correlation, access) => {
    const token = safeCorrelation(correlation);
    if (!token) return false;
    const privateContext = access?.includePrivate === true && access?.includeDurable !== true;
    const current = Number(now());
    if (!Number.isFinite(current)) return false;
    entries.delete(token);
    entries.set(token, {expiresAt: current + lifetime, privateContext});
    prune(current);
    return true;
  };
  const resolve = correlation => {
    const token = safeCorrelation(correlation);
    const current = Number(now());
    if (!token || !Number.isFinite(current)) return undefined;
    prune(current);
    const entry = entries.get(token);
    if (!entry) return undefined;
    entry.expiresAt = current + lifetime;
    entries.delete(token);
    entries.set(token, entry);
    return entry.privateContext ? {
      clearDurable: false,
      clearPrivate: true,
      includeDurable: false,
      includePrivate: true
    } : {
      clearDurable: true,
      clearPrivate: false,
      includeDurable: true,
      includePrivate: false
    };
  };
  const remove = correlation => safeCorrelation(correlation) ? entries.delete(correlation) : false;
  const size = () => {
    const current = Number(now());
    if (Number.isFinite(current)) prune(current);
    return entries.size;
  };
  return Object.freeze({remember, remove, resolve, size});
};

const fixedConflictError = code => Object.assign(Error(
  code === 'CONFLICT_SCAN_TIMEOUT' ? 'Conflict scan timed out' :
    code === 'CONFLICT_SCAN_ACCESS_DENIED' ? 'Optional conflict scan access is not granted' :
      'Conflict scan is unavailable'
), {code});

const cancelPopupProgressWithDiagnostics = async ({
  actionDiagnostics,
  cancel,
  command,
  correlation,
  jobId,
  privateContext = false
} = {}) => {
  if (typeof cancel !== 'function') throw Error('Popup cancellation is unavailable');
  // Cancellation is authoritative. Only describe it after the manager confirms
  // that the job still exists; a snapshot taken for authorization can go stale.
  const response = await cancel(jobId);
  const accepted = ownValue(response, 'accepted') === true;
  await actionDiagnostics?.event?.({
    code: accepted ? 'ACTION_CANCELLED' : 'NO_CHANGE',
    ...(safeCommand(command) && {command: safeCommand(command)}),
    ...(safeCorrelation(correlation) && {correlation: safeCorrelation(correlation)}),
    outcome: accepted ? 'CANCELLED' : 'DENIED',
    phase: 'CANCEL',
    ...(privateContext === true && {privateContext: true}),
    source: 'popup',
    type: 'RESPONSE'
  });
  return response;
};

const runConflictScanEndpoint = ({
  actionDiagnostics,
  authorize,
  checkPermission,
  scan,
  signalCodes = [],
  timeoutMs = CONFLICT_SCAN_ENDPOINT_TIMEOUT
} = {}) => {
  if (typeof authorize !== 'function' || typeof checkPermission !== 'function' ||
      typeof scan !== 'function') {
    return Promise.reject(fixedConflictError('CONFLICT_SCAN_UNAVAILABLE'));
  }
  const duration = Math.max(1, Math.min(
    CONFLICT_SCAN_ENDPOINT_TIMEOUT,
    Number.isSafeInteger(timeoutMs) ? timeoutMs : CONFLICT_SCAN_ENDPOINT_TIMEOUT
  ));
  const allowedSignals = new Set(Array.from(signalCodes).filter(safeCode));
  let open = true;
  let timer;
  const timedOut = () => fixedConflictError('CONFLICT_SCAN_TIMEOUT');
  const assertOpen = () => {
    if (!open) throw timedOut();
  };
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      open = false;
      reject(timedOut());
    }, duration);
  });
  const task = (async () => {
    let authorized;
    let base;
    const record = async fields => {
      assertOpen();
      await actionDiagnostics?.event?.({...base, ...fields});
      // A slow journal write consumes the same endpoint budget. This guard also
      // prevents the scan or any later success event from starting afterward.
      assertOpen();
    };
    try {
      authorized = await authorize();
      assertOpen();
      const correlation = ownValue(authorized, 'correlation');
      base = {
        action: 'RUN_CONFLICT_SCAN',
        ...(safeCorrelation(correlation) && {correlation: safeCorrelation(correlation)}),
        ...(ownValue(authorized, 'privateContext') === true && {privateContext: true}),
        source: 'options'
      };
      if (await checkPermission() !== true) {
        throw fixedConflictError('CONFLICT_SCAN_ACCESS_DENIED');
      }
      assertOpen();
      await record({
        code: 'CONFLICT_SCAN_STARTED',
        outcome: 'STARTED',
        phase: 'SCAN',
        type: 'ACTION_STAGE'
      });
      const privateContext = ownValue(authorized, 'privateContext') === true;
      const result = await scan({privateContext});
      assertOpen();
      const signals = ownValue(result, 'signals');
      if (Array.isArray(signals)) {
        for (const signal of signals) {
          assertOpen();
          if (allowedSignals.has(signal)) {
            await record({
              code: signal,
              outcome: 'PROGRESS',
              phase: 'SCAN',
              type: 'ACTION_STAGE'
            });
          }
        }
      }
      await record({
        code: 'CONFLICT_SCAN_COMPLETED',
        counts: ownValue(result, 'counts'),
        outcome: 'SUCCEEDED',
        phase: 'SCAN',
        type: 'RESPONSE'
      });
      return result;
    }
    catch (error) {
      // Once the deadline closes, the abandoned work may settle but may not
      // append a failure or (more importantly) a later success record.
      if (!open || !base) throw error;
      const code = ownValue(error, 'code');
      await record({
        code: code === 'CONFLICT_SCAN_ACCESS_DENIED' ? 'CONFLICT_SCAN_ACCESS_DENIED' :
          code === 'CONFLICT_SCAN_TIMEOUT' ? 'REQUEST_TIMEOUT' : 'REQUEST_FAILED',
        outcome: code === 'CONFLICT_SCAN_ACCESS_DENIED' ? 'DENIED' :
          code === 'CONFLICT_SCAN_TIMEOUT' ? 'TIMED_OUT' : 'FAILED',
        phase: 'SCAN',
        type: 'RESPONSE'
      });
      throw error;
    }
  })();
  return Promise.race([task, deadline]).finally(() => {
    open = false;
    clearTimeout(timer);
  });
};

const createActionDiagnostics = journal => {
  const run = async ({command, correlation, privateContext = false, source}, task) => {
    const span = safeSpan(journal, {command, correlation, source}, {privateContext});
    void settle(span.ready);
    void spanCall(span, 'stage', {outcome: 'success', phase: 'admission'});
    try {
      const value = await task({
        retry: ({attempt, code, counts, phase = 'command'} = {}) => spanCall(span, 'retry', {
          ...(boundedInteger(attempt) !== undefined && {attempt}),
          ...(safeCode(code) && {code}),
          ...(cleanCounts(counts) && {counts: cleanCounts(counts)}),
          outcome: 'retrying',
          phase: safePhase(phase) || 'command'
        }),
        stage: ({code, counts, outcome = 'progress', phase = 'command'} = {}) =>
          spanCall(span, 'stage', {
            ...(safeCode(code) && {code}),
            ...(cleanCounts(counts) && {counts: cleanCounts(counts)}),
            outcome: safeOutcome(outcome) || 'progress',
            phase: safePhase(phase) || 'command'
          }),
        timeout: ({attempt, code, counts, phase = 'command'} = {}) => spanCall(span, 'timeout', {
          ...(boundedInteger(attempt) !== undefined && {attempt}),
          ...(safeCode(code) && {code}),
          ...(cleanCounts(counts) && {counts: cleanCounts(counts)}),
          outcome: 'timed-out',
          phase: safePhase(phase) || 'command'
        })
      });
      await spanCall(span, 'finish', terminalProjection(value));
      return value;
    }
    catch (error) {
      const code = safeFailureCause(failureCauseFrom(error));
      if (code === FAILURE_CAUSES.NATIVE_TIMEOUT) {
        await spanCall(span, 'timeout', {code, outcome: 'timed-out', phase: 'native-discard'});
      }
      await spanCall(span, 'finish', terminalProjection(undefined, error));
      throw error;
    }
  };

  const event = value => {
    if (!journal || typeof journal.event !== 'function') {
      return Promise.resolve(undefined);
    }
    const projected = projectActionEvent(value);
    if (!projected) return Promise.resolve(undefined);
    return settle(journal.event(projected, {
      privateContext: ownValue(projected, 'privateContext') === true
    }));
  };

  return Object.freeze({event, run});
};

export {
  ACTION_COMMANDS,
  ACTION_EVENT_TYPES,
  ACTION_OUTCOMES,
  ACTION_PHASES,
  ACTION_SOURCES,
  CONFLICT_SCAN_ENDPOINT_TIMEOUT,
  UI_ACTIONS,
  actionCounts,
  cancelPopupProgressWithDiagnostics,
  createActionDiagnostics,
  createDiagnosticCapabilityCache,
  DIAGNOSTIC_CAPABILITY_MAX,
  DIAGNOSTIC_CAPABILITY_TTL,
  projectActionEvent,
  runConflictScanEndpoint,
  terminalDiagnosticResponse,
  terminalProjection
};
