import {
  assertBackupSize,
  assertSafeObjectGraph,
  BOOLEAN_KEYS,
  CLICK_VALUES,
  NUMBER_RANGES
} from './settings-backup.mjs';
import {matchesFailureCausePolicy} from '../../../worker/core/failure-causes.mjs';
import {normalizeEnvelope} from '../../../worker/core/diagnostic-journal.mjs';

const SUPPORT_BUNDLE_FORMAT = 'auto-tab-discard-support';
const SUPPORT_BUNDLE_VERSION = 2;
const SUPPORT_BUNDLE_LABEL = 'SANITIZED SUPPORT BUNDLE - excludes browsing and site-rule data';
const SUPPORT_JOURNAL_FORMAT = 'auto-tab-discard-diagnostic-journal';
const SUPPORT_JOURNAL_VERSION = 2;
const MAX_SUPPORT_RECORDS = 2048;
const MAX_SUPPORT_INCIDENTS = 64;
const MAX_SUPPORT_SESSIONS = 32;
// Candidate records are measured without pretty-print indentation. Keep a
// conservative margin beneath the 1 MiB shareable-bundle ceiling.
const MAX_SUPPORT_JOURNAL_BYTES = 384 * 1024;

const SUPPORT_OMISSION_POLICY = Object.freeze({
  browsingData: 'excluded',
  extensionIdentifiers: 'excluded',
  internalState: 'excluded',
  privateWindowActivity: 'excluded',
  rawErrorsAndStacks: 'excluded',
  settingValuesOutsideAllowlist: 'excluded',
  siteRules: 'excluded',
  tabAndWindowIdentifiers: 'excluded'
});

const SAFE_COMMANDS = new Set([
  'discard-lefts',
  'discard-other-windows',
  'discard-rights',
  'discard-tab',
  'discard-tabs',
  'discard-tree',
  'discard-window',
  'release-lefts',
  'release-other-windows',
  'release-rights',
  'release-tabs',
  'release-window'
]);
const SAFE_STATES = new Set([
  'cancelled', 'complete', 'failed', 'interrupted', 'partial'
]);
const SAFE_POPUP_CODES = new Set([
  'POPUP_BUSY',
  'POPUP_CANCELLED',
  'POPUP_COMMAND_FAILED',
  'POPUP_INTERRUPTED',
  'POPUP_NO_ACTIVE_TAB',
  'POPUP_TARGET_CHANGED',
  'TAB_ALREADY_OWNED',
  'TAB_ALREADY_OWNED_VISUAL_UNAVAILABLE',
  'TAB_CANCELLED',
  'TAB_DISCARDED',
  'TAB_DISCARDED_VISUAL_UNAVAILABLE',
  'TAB_FAILED',
  'TAB_MISSING',
  'TAB_NO_SAFE_KEEPER',
  'TAB_OWNERSHIP_UNKNOWN',
  'TAB_PROTECTED',
  'TAB_RELEASED',
  'TAB_RELEASE_REMAINS_FROZEN',
  'TAB_SKIPPED',
  'TAB_SUSPENSION_UNKNOWN',
  'TAB_UNSUPPORTED'
]);
const SAFE_GROUPS = new Map([
  ['POPUP_BUSY', ['command', 'BUSY']],
  ['POPUP_CANCELLED', ['command', 'CANCELLED']],
  ['POPUP_COMMAND_FAILED', ['command', 'COMMAND_FAILED']],
  ['POPUP_INTERRUPTED', ['command', 'INTERRUPTED']],
  ['POPUP_NO_ACTIVE_TAB', ['command', 'NO_ACTIVE_TAB']],
  ['POPUP_TARGET_CHANGED', ['command', 'TARGET_CHANGED']],
  ['TAB_ALREADY_OWNED', ['ownership', 'ALREADY_OWNED']],
  ['TAB_ALREADY_OWNED_VISUAL_UNAVAILABLE', ['visual-marker', 'VISUAL_UNAVAILABLE']],
  ['TAB_CANCELLED', ['command', 'CANCELLED']],
  ['TAB_DISCARDED', ['tab-operation', 'DISCARDED']],
  ['TAB_DISCARDED_VISUAL_UNAVAILABLE', ['visual-marker', 'VISUAL_UNAVAILABLE']],
  ['TAB_FAILED', ['tab-operation', 'OPERATION_FAILED']],
  ['TAB_MISSING', ['eligibility', 'TARGET_MISSING']],
  ['TAB_NO_SAFE_KEEPER', ['keeper', 'NO_SAFE_KEEPER']],
  ['TAB_OWNERSHIP_UNKNOWN', ['verification', 'OWNERSHIP_UNKNOWN']],
  ['TAB_PROTECTED', ['eligibility', 'PROTECTION_RULE']],
  ['TAB_RELEASED', ['release', 'RELEASED']],
  ['TAB_RELEASE_REMAINS_FROZEN', ['release', 'POSTCONDITION_NOT_MET']],
  ['TAB_SKIPPED', ['eligibility', 'NOT_ELIGIBLE']],
  ['TAB_SUSPENSION_UNKNOWN', ['verification', 'SUSPENSION_UNKNOWN']],
  ['TAB_UNSUPPORTED', ['eligibility', 'UNSUPPORTED_PAGE']]
]);
const GENERIC_FAILURE_CODES = new Set([
  'POPUP_COMMAND_FAILED',
  'TAB_FAILED',
  'TAB_UNSUPPORTED'
]);
const SAFE_GROUP_STATUS = new Map([
  ['POPUP_BUSY', 'failed'],
  ['POPUP_CANCELLED', 'skipped'],
  ['POPUP_COMMAND_FAILED', 'failed'],
  ['POPUP_INTERRUPTED', 'failed'],
  ['POPUP_NO_ACTIVE_TAB', 'failed'],
  ['POPUP_TARGET_CHANGED', 'failed'],
  ['TAB_ALREADY_OWNED', 'skipped'],
  ['TAB_ALREADY_OWNED_VISUAL_UNAVAILABLE', 'skipped'],
  ['TAB_CANCELLED', 'skipped'],
  ['TAB_DISCARDED', 'success'],
  ['TAB_DISCARDED_VISUAL_UNAVAILABLE', 'success'],
  ['TAB_FAILED', 'failed'],
  ['TAB_MISSING', 'skipped'],
  ['TAB_NO_SAFE_KEEPER', 'skipped'],
  ['TAB_OWNERSHIP_UNKNOWN', 'failed'],
  ['TAB_PROTECTED', 'skipped'],
  ['TAB_RELEASED', 'success'],
  ['TAB_RELEASE_REMAINS_FROZEN', 'failed'],
  ['TAB_SKIPPED', 'skipped'],
  ['TAB_SUSPENSION_UNKNOWN', 'failed'],
  ['TAB_UNSUPPORTED', 'failed']
]);
const SAFE_GROUP_STATUSES = new Set(['failed', 'skipped', 'success']);
const SAFE_BROWSER_FAMILIES = new Set(['Chromium', 'Edge', 'Firefox', 'Other']);

const SAFE_BOOLEAN_KEYS = Object.freeze(BOOLEAN_KEYS.filter(key =>
  key !== 'trash.enabled' && key !== 'release-next-tab'
));
const SAFE_NUMBER_KEYS = Object.freeze(Object.keys(NUMBER_RANGES));
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const safeCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ?
  value : undefined;
const safeOrdinal = value => Number.isSafeInteger(value) && value >= 0 &&
  value <= 10_000_000_000 ? value : undefined;
const safeDuration = value => Number.isSafeInteger(value) && value >= 0 &&
  value <= 7 * 24 * 60 * 60 * 1000 ? value : undefined;
const safeIdentifier = value => typeof value === 'string' && value.length <= 80 &&
  /^ATD-[A-Z0-9]+(?:-[A-Z0-9]+){1,4}$/.test(value) ? value : undefined;
const safeTimestamp = value => {
  if (typeof value !== 'string' || value.length > 32) {
    return undefined;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value ? value : undefined;
};
const optional = (key, value) => value === undefined ? {} : {[key]: value};

const safeCounts = value => {
  if (!plainObject(value)) {
    return undefined;
  }
  const counts = {};
  for (const key of ['failed', 'skipped', 'success']) {
    const count = safeCount(value[key]);
    if (count !== undefined) {
      counts[key] = count;
    }
  }
  return Object.keys(counts).length === 3 ? counts : undefined;
};

const safeGroups = value => {
  if (!Array.isArray(value)) {
    return [];
  }
  const groups = [];
  for (const entry of value.slice(0, 32)) {
    if (!plainObject(entry) || !SAFE_GROUP_STATUSES.has(entry.status) ||
        !SAFE_POPUP_CODES.has(entry.code) || SAFE_GROUP_STATUS.get(entry.code) !== entry.status) {
      continue;
    }
    const expected = SAFE_GROUPS.get(entry.code);
    const validPolicy = GENERIC_FAILURE_CODES.has(entry.code) ?
      matchesFailureCausePolicy(entry.stage, entry.reasonCode) :
      expected && entry.stage === expected[0] && entry.reasonCode === expected[1];
    if (!validPolicy) {
      continue;
    }
    const count = safeCount(entry.count);
    if (count === undefined || count === 0) {
      continue;
    }
    groups.push({
      code: entry.code,
      count,
      reasonCode: entry.reasonCode,
      stage: entry.stage,
      status: entry.status
    });
  }
  return groups;
};

const safeRuntime = value => {
  if (!plainObject(value)) {
    return undefined;
  }
  const browserFamily = SAFE_BROWSER_FAMILIES.has(value.browserFamily) ?
    value.browserFamily : undefined;
  const extensionVersion = safeVersion(value.extensionVersion);
  return browserFamily && extensionVersion !== 'unknown' ? {browserFamily, extensionVersion} : undefined;
};

const safeIncident = value => {
  if (!plainObject(value)) {
    return undefined;
  }
  const id = safeIdentifier(value.id || value.incidentId);
  const command = SAFE_COMMANDS.has(value.command) ? value.command : undefined;
  const state = SAFE_STATES.has(value.state) ? value.state : undefined;
  if (!id || !command || !state) {
    return undefined;
  }
  const durationMs = safeDuration(value.durationMs);
  const total = safeCount(value.total);
  const startedAt = safeTimestamp(value.startedAt);
  const endedAt = safeTimestamp(value.endedAt);
  const runtime = safeRuntime(value.runtime);
  const summary = safeCounts(value.summary);
  if (durationMs === undefined || total === undefined || !startedAt || !endedAt || !runtime ||
      !summary || summary.success + summary.skipped + summary.failed > total ||
      typeof value.forced !== 'boolean') {
    return undefined;
  }
  return {
    command,
    durationMs,
    endedAt,
    forced: value.forced,
    groups: safeGroups(value.groups),
    id,
    runtime,
    startedAt,
    state,
    summary,
    total
  };
};

// The worker has already projected its private runtime state, but the support
// boundary independently rebuilds a second, smaller allowlisted view. Unknown
// fields are ignored instead of being copied recursively.
const safeEventRecord = value => {
  if (!plainObject(value) || value.kind !== 'event') return undefined;
  const event = {
    kind: 'event',
    offsetMs: safeOrdinal(value.offsetMs),
    runtime: safeRuntime(value.runtime),
    sequence: safeOrdinal(value.sequence),
    source: typeof value.source === 'string' ? value.source : undefined,
    timestamp: safeTimestamp(value.timestamp),
    type: typeof value.type === 'string' ? value.type : undefined
  };
  if (event.offsetMs === undefined || !event.runtime || !event.sequence || !event.timestamp ||
      !event.source || !event.type) return undefined;
  for (const key of ['action', 'command', 'phase', 'outcome', 'code', 'correlation']) {
    if (typeof value[key] === 'string' && value[key].length <= 96) event[key] = value[key];
  }
  if (Number.isSafeInteger(value.attempt) && value.attempt >= 0 && value.attempt <= 10_000) {
    event.attempt = value.attempt;
  }
  if (plainObject(value.counts)) {
    const counts = {};
    for (const [key, count] of Object.entries(value.counts)) {
      if (safeCount(count) !== undefined && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(key)) {
        counts[key] = count;
      }
    }
    if (Object.keys(counts).length) event.counts = counts;
  }
  return event;
};

const safeSupportRecord = value => {
  if (value?.kind === 'event') return safeEventRecord(value);
  if (!plainObject(value) || value.kind !== 'incident') return undefined;
  const incident = safeIncident(value.incident);
  const offsetMs = safeOrdinal(value.offsetMs);
  const sequence = safeOrdinal(value.sequence);
  const timestamp = safeTimestamp(value.timestamp);
  return incident && offsetMs !== undefined && sequence && timestamp ? {
    incident,
    kind: 'incident',
    offsetMs,
    sequence,
    timestamp
  } : undefined;
};

const safeJournal = value => {
  const unavailable = {
    available: false,
    format: SUPPORT_JOURNAL_FORMAT,
    omittedRecords: 0,
    sessions: [],
    version: SUPPORT_JOURNAL_VERSION
  };
  const updatedAt = safeTimestamp(value?.updatedAt);
  if (!plainObject(value) || value.format !== SUPPORT_JOURNAL_FORMAT ||
      value.version !== SUPPORT_JOURNAL_VERSION || !updatedAt || !Array.isArray(value.sessions)) {
    return unavailable;
  }
  const allNormalized = normalizeEnvelope(value);
  const normalized = allNormalized.slice(-MAX_SUPPORT_SESSIONS);
  const selected = [];
  let bytes = 0;
  let incidents = 0;
  let records = 0;
  const sourceRecordCount = allNormalized.reduce((total, session) => total + session.records.length, 0);
  for (let sessionIndex = normalized.length - 1; sessionIndex >= 0; sessionIndex -= 1) {
    const source = normalized[sessionIndex];
    const retained = [];
    for (let recordIndex = source.records.length - 1; recordIndex >= 0; recordIndex -= 1) {
      if (records >= MAX_SUPPORT_RECORDS) break;
      const candidate = safeSupportRecord(source.records[recordIndex]);
      if (!candidate || (candidate.kind === 'incident' && incidents >= MAX_SUPPORT_INCIDENTS)) continue;
      const candidateBytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
      if (bytes + candidateBytes > MAX_SUPPORT_JOURNAL_BYTES) continue;
      retained.unshift(candidate);
      bytes += candidateBytes;
      records += 1;
      if (candidate.kind === 'incident') incidents += 1;
    }
    if (retained.length) {
      selected.unshift({
        id: source.id,
        records: retained,
        startedAt: source.startedAt
      });
    }
    if (records >= MAX_SUPPORT_RECORDS || bytes >= MAX_SUPPORT_JOURNAL_BYTES) break;
  }
  return {
    available: true,
    format: SUPPORT_JOURNAL_FORMAT,
    omittedRecords: Math.max(0, sourceRecordCount - records),
    sessions: selected,
    updatedAt,
    version: SUPPORT_JOURNAL_VERSION
  };
};

const safeVersion = value => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    return 'unknown';
  }
  return [...value].every(character =>
    '0123456789.-+abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.includes(character)
  ) ? value : 'unknown';
};

const browserFamily = userAgent => {
  const source = typeof userAgent === 'string' ? userAgent : '';
  if (source.includes('Edg/')) {
    return 'Edge';
  }
  if (source.includes('Firefox/')) {
    return 'Firefox';
  }
  if (source.includes('Chromium/') || source.includes('Chrome/')) {
    return 'Chromium';
  }
  return 'Other';
};

const safePreferences = stored => {
  assertSafeObjectGraph(stored, '$.stored');
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    return {};
  }

  const preferences = {};
  for (const key of SAFE_BOOLEAN_KEYS) {
    if (typeof stored[key] === 'boolean') {
      preferences[key] = stored[key];
    }
  }
  for (const key of SAFE_NUMBER_KEYS) {
    const value = stored[key];
    const [minimum, maximum] = NUMBER_RANGES[key];
    if (Number.isInteger(value) && value >= minimum && value <= maximum) {
      preferences[key] = value;
    }
  }
  if (['time-based', 'url-based'].includes(stored.mode)) {
    preferences.mode = stored.mode;
  }
  if (CLICK_VALUES.includes(stored.click)) {
    preferences.click = stored.click;
  }

  return preferences;
};

const createSupportBundle = (stored, {
  journal,
  manifest = {},
  now = () => new Date(),
  userAgent = ''
} = {}) => {
  const generatedAt = now();
  if (!(generatedAt instanceof Date) || Number.isNaN(generatedAt.getTime())) {
    throw new TypeError('support bundle clock returned an invalid date');
  }
  const preferences = safePreferences(stored);
  return {
    format: SUPPORT_BUNDLE_FORMAT,
    version: SUPPORT_BUNDLE_VERSION,
    label: SUPPORT_BUNDLE_LABEL,
    generatedAt: generatedAt.toISOString(),
    extension: {
      manifestVersion: manifest.manifest_version === 2 || manifest.manifest_version === 3 ?
        manifest.manifest_version : 'unknown',
      version: safeVersion(manifest.version)
    },
    environment: {
      browserFamily: browserFamily(userAgent)
    },
    diagnostics: {
      journal: safeJournal(journal),
      omissionPolicy: SUPPORT_OMISSION_POLICY,
      preferences
    }
  };
};

const serializeSupportBundle = (stored, options) => {
  const text = `${JSON.stringify(createSupportBundle(stored, options), null, 2)}\n`;
  assertBackupSize(text);
  return text;
};

export {
  browserFamily,
  createSupportBundle,
  safeJournal,
  serializeSupportBundle,
  SUPPORT_BUNDLE_FORMAT,
  SUPPORT_BUNDLE_LABEL,
  SUPPORT_OMISSION_POLICY,
  SUPPORT_BUNDLE_VERSION
};
