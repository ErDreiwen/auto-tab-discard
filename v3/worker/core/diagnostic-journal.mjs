import {POPUP_CODES} from './popup-progress.mjs';
import {
  failureCauseFrom,
  failureCausePolicy,
  matchesFailureCausePolicy
} from './failure-causes.mjs';

const DIAGNOSTIC_FORMAT = 'auto-tab-discard-diagnostic-journal';
const DIAGNOSTIC_VERSION = 1;
const DIAGNOSTIC_STORAGE_KEY = '__diagnosticJournal';
const MAX_DIAGNOSTIC_BYTES = 256 * 1024;
const MAX_DIAGNOSTIC_INCIDENTS = 12;
const DIAGNOSTIC_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const DIAGNOSTIC_STORAGE_TIMEOUT = 2000;

const SAFE_COMMANDS = new Set([
  'discard-lefts', 'discard-other-windows', 'discard-rights', 'discard-tab',
  'discard-tabs', 'discard-tree', 'discard-window', 'release-lefts',
  'release-other-windows', 'release-rights', 'release-tabs', 'release-window'
]);
const SAFE_STATES = new Set(['cancelled', 'complete', 'failed', 'interrupted', 'partial']);
const SAFE_STATUSES = new Set(['failed', 'skipped', 'success']);
const SAFE_BROWSER_FAMILIES = new Set(['Chromium', 'Edge', 'Firefox', 'Other']);
const SAFE_CODES = new Set(Object.values(POPUP_CODES));
const INCIDENT_PATTERN = /^ATD-[A-Z0-9]+(?:-[A-Z0-9]+){1,4}$/;
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
  POPUP_CODES.TAB_FAILED
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
    const policy = projectedPolicy(code, failureCauseFrom(outcome));
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

const normalizeEnvelope = value => {
  if (!plainObject(value) || value.format !== DIAGNOSTIC_FORMAT ||
      value.version !== DIAGNOSTIC_VERSION || !Array.isArray(value.incidents)) {
    return [];
  }
  return value.incidents.map(normalizeIncident).filter(Boolean);
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
const exactStoredEnvelope = value => exactKeys(value, [
  'format', 'incidents', 'updatedAt', 'version'
]) && value.format === DIAGNOSTIC_FORMAT && value.version === DIAGNOSTIC_VERSION &&
  canonicalIso(value.updatedAt) !== undefined && Array.isArray(value.incidents) &&
  value.incidents.every(exactStoredIncident);

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
      operation.then(value => finish(null, value), error => finish(error));
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
  async read() {
    if (!area?.get) throw Error('diagnostic storage read is unavailable');
    const values = await invokeStorage(area, 'get', [{[key]: undefined}], timeoutMs);
    return values?.[key];
  },
  async remove() {
    if (!area?.remove) throw Error('diagnostic storage removal is unavailable');
    await invokeStorage(area, 'remove', [key], timeoutMs);
  },
  async write(value) {
    if (!area?.set) throw Error('diagnostic storage write is unavailable');
    await invokeStorage(area, 'set', [{[key]: value}], timeoutMs);
  }
});

const envelope = (incidents, updatedAt) => ({
  format: DIAGNOSTIC_FORMAT,
  incidents: clone(incidents),
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

const createDiagnosticJournal = ({
  manifest = globalThis.chrome?.runtime?.getManifest?.() || {},
  maxAge = DIAGNOSTIC_MAX_AGE,
  maxBytes = MAX_DIAGNOSTIC_BYTES,
  maxIncidents = MAX_DIAGNOSTIC_INCIDENTS,
  now = () => Date.now(),
  store = diagnosticStorageAdapter(),
  userAgent = globalThis.navigator?.userAgent || ''
} = {}) => {
  let incidents = [];
  const privateIncidents = new Map();
  let hydrated;
  let tail = Promise.resolve();

  const hydrate = () => hydrated ||= (async () => {
    const stored = await store.read();
    if (stored !== undefined && (!exactStoredEnvelope(stored) ||
        byteLength(JSON.stringify(stored)) > maxBytes)) {
      // Never retain or export a malformed object that another context placed
      // under the reserved key. Removing only this key preserves preferences.
      await store.remove();
      incidents = [];
      return;
    }
    incidents = normalizeEnvelope(stored);
    const pruned = prune(incidents, now());
    if (pruned.incidents.length !== incidents.length) {
      await store.write(pruned.document);
    }
    incidents = pruned.incidents;
  })();
  const enqueue = task => {
    const operation = tail.then(async () => {
      await hydrate();
      return task();
    });
    tail = operation.catch(() => {});
    return operation;
  };
  const prune = (values, current) => {
    const cutoff = current - maxAge;
    let next = values.filter(incident => new Date(incident.endedAt).getTime() >= cutoff)
      .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
    if (next.length > maxIncidents) {
      next = next.slice(-maxIncidents);
    }
    let candidate = envelope(next, new Date(current).toISOString());
    while (next.length && byteLength(JSON.stringify(candidate)) > maxBytes) {
      next.shift();
      candidate = envelope(next, new Date(current).toISOString());
    }
    if (byteLength(JSON.stringify(candidate)) > maxBytes) {
      throw Error('diagnostic journal exceeds its fixed byte limit');
    }
    return {document: candidate, incidents: next};
  };
  const findLatest = (incidentId, {
    includeDurable = true,
    includePrivate = false
  } = {}) => {
    const id = incidentId === undefined ? undefined : safeIncidentId(incidentId);
    if (incidentId !== undefined && !id) return undefined;
    if (id && includePrivate && privateIncidents.has(id)) return clone(privateIncidents.get(id));
    if (id && includeDurable) return clone(incidents.find(incident => incident.id === id));
    const candidates = [
      ...(includeDurable ? incidents : []),
      ...(includePrivate ? privateIncidents.values() : [])
    ]
      .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
    return clone(candidates.at(-1));
  };

  const record = snapshot => {
    const incident = projectDiagnosticIncident(snapshot, {manifest, userAgent});
    if (!incident) return Promise.resolve(undefined);
    if (snapshot.privateContext === true) {
      privateIncidents.set(incident.id, incident);
      const retained = [...privateIncidents.values()]
        .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
      while (retained.length > maxIncidents ||
          byteLength(JSON.stringify(retained)) > maxBytes) {
        const removed = retained.shift();
        privateIncidents.delete(removed.id);
      }
      return Promise.resolve(clone(incident));
    }
    return enqueue(async () => {
      const next = [...incidents];
      const index = next.findIndex(value => value.id === incident.id);
      if (index === -1) next.push(incident);
      else next[index] = incident;
      const pruned = prune(next, now());
      await store.write(pruned.document);
      incidents = pruned.incidents;
      return clone(incident);
    });
  };
  const refresh = async () => {
    const current = now();
    const pruned = prune(incidents, current);
    if (pruned.incidents.length !== incidents.length) {
      await store.write(pruned.document);
    }
    incidents = pruned.incidents;
    for (const [id, incident] of privateIncidents) {
      if (new Date(incident.endedAt).getTime() < current - maxAge) {
        privateIncidents.delete(id);
      }
    }
  };
  const latest = (incidentId, access) => enqueue(async () => {
    await refresh();
    return findLatest(incidentId, access);
  });
  const snapshot = ({includeDurable = true} = {}) => enqueue(async () => {
    if (!includeDurable) {
      return envelope([], new Date(now()).toISOString());
    }
    const pruned = prune(incidents, now());
    if (pruned.incidents.length !== incidents.length) {
      await store.write(pruned.document);
    }
    incidents = pruned.incidents;
    return clone(pruned.document);
  });
  const exportText = (incidentId, access) => enqueue(async () => {
    await refresh();
    const incident = findLatest(incidentId, access);
    return {incident: incident || null, text: incident ? formatDiagnosticLog(incident) : ''};
  });
  const clear = ({clearDurable = true, clearPrivate = false} = {}) => enqueue(async () => {
    if (clearDurable) {
      await store.remove();
      incidents = [];
    }
    if (clearPrivate) {
      privateIncidents.clear();
    }
    return {cleared: true};
  });
  const flush = () => tail;

  return Object.freeze({clear, exportText, flush, latest, record, snapshot});
};

export {
  browserFamily,
  createDiagnosticJournal,
  DIAGNOSTIC_FORMAT,
  DIAGNOSTIC_MAX_AGE,
  DIAGNOSTIC_STORAGE_TIMEOUT,
  DIAGNOSTIC_STORAGE_KEY,
  DIAGNOSTIC_VERSION,
  diagnosticStorageAdapter,
  formatDiagnosticLog,
  GROUP_POLICY,
  MAX_DIAGNOSTIC_BYTES,
  MAX_DIAGNOSTIC_INCIDENTS,
  normalizeEnvelope,
  projectDiagnosticIncident
};
