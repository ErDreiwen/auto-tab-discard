import {readStorageArea} from './storage-read.mjs';

const EXTERNAL_DISCARD_METHOD = 'discard';
const EXTERNAL_TRUSTED_IDS_KEY = 'external.trusted-ids';
const EXTERNAL_BATCH_LIMIT = 25;
const EXTERNAL_RATE_LIMIT = 4;
const EXTERNAL_RATE_WINDOW = 10_000;
const EXTERNAL_CONCURRENCY_LIMIT = 1;
const EXTERNAL_TRUST_LIMIT = 32;
const EXTERNAL_ID_LIMIT = 255;

const failure = code => Object.freeze({
  error: Object.freeze({code}),
  ok: false
});

const isRecord = value => value !== null && typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const validExtensionId = value => typeof value === 'string' &&
  value.length > 0 && value.length <= EXTERNAL_ID_LIMIT &&
  !/[\x00-\x20\x7f]/.test(value);

const normalizeTrustedIds = value => {
  if (!Array.isArray(value)) {
    return Object.freeze([]);
  }
  const trusted = [];
  const seen = new Set();
  for (const id of value.slice(0, EXTERNAL_TRUST_LIMIT)) {
    if (validExtensionId(id) && !seen.has(id)) {
      seen.add(id);
      trusted.push(id);
    }
  }
  return Object.freeze(trusted);
};

// A successful managed read with no value means that pairing may use the
// local developer allowlist. A failed managed read is different: policy is
// unknown, so it is authoritative denial and local storage is never consulted.
const readTrustedExtensionIds = async ({
  readArea = readStorageArea,
  storage = globalThis.chrome?.storage,
  timeoutMs
} = {}) => {
  const managed = await readArea(storage?.managed, EXTERNAL_TRUSTED_IDS_KEY, {timeoutMs});
  if (Object.hasOwn(managed, EXTERNAL_TRUSTED_IDS_KEY)) {
    return managed[EXTERNAL_TRUSTED_IDS_KEY];
  }
  const local = await readArea(storage?.local, EXTERNAL_TRUSTED_IDS_KEY, {timeoutMs});
  return local[EXTERNAL_TRUSTED_IDS_KEY] || [];
};

const validateExternalDiscardRequest = request => {
  if (!isRecord(request)) {
    throw Object.assign(Error('external request must be an object'), {code: 'INVALID_REQUEST'});
  }
  const keys = Object.keys(request).sort();
  if (keys.length !== 2 || keys[0] !== 'method' || keys[1] !== 'tabIds') {
    throw Object.assign(Error('external request has unknown or missing fields'), {code: 'INVALID_SCHEMA'});
  }
  if (request.method !== EXTERNAL_DISCARD_METHOD) {
    throw Object.assign(Error('external method is not supported'), {code: 'INVALID_METHOD'});
  }
  if (!Array.isArray(request.tabIds) || request.tabIds.length === 0 ||
      request.tabIds.length > EXTERNAL_BATCH_LIMIT) {
    throw Object.assign(Error('external tabIds batch is invalid'), {code: 'INVALID_TAB_IDS'});
  }

  const seen = new Set();
  const tabIds = [];
  for (const id of request.tabIds) {
    if (!Number.isSafeInteger(id) || id < 0 || seen.has(id)) {
      throw Object.assign(Error('external tabIds must be unique nonnegative integers'), {
        code: 'INVALID_TAB_IDS'
      });
    }
    seen.add(id);
    tabIds.push(id);
  }
  return Object.freeze({
    method: EXTERNAL_DISCARD_METHOD,
    tabIds: Object.freeze(tabIds)
  });
};

const entries = (result, key) => Array.isArray(result?.[key]) ? result[key] : [];
const entryId = entry => Number.isSafeInteger(entry) ? entry :
  Number.isSafeInteger(entry?.tab?.id) ? entry.tab.id :
    Number.isSafeInteger(entry?.id) ? entry.id : undefined;

const setOutcome = (outcomes, result, key, status, code, priority) => {
  for (const entry of entries(result, key)) {
    const tabId = entryId(entry);
    const previous = outcomes.get(tabId);
    if (Number.isSafeInteger(tabId) && (!previous || priority > previous.priority)) {
      outcomes.set(tabId, {code, priority, status, tabId});
    }
  }
};

// Browser details, URLs, titles, exception strings, and ownership records are
// deliberately excluded. Callers receive only one fixed-size record per tab
// ID they supplied, in the same order they supplied it.
const sanitizeExternalDiscardResult = (tabIds, result) => {
  const outcomes = new Map();
  setOutcome(outcomes, result, 'alreadyOwned', 'skipped', 'ALREADY_DISCARDED', 10);
  setOutcome(outcomes, result, 'physicalOnly', 'skipped', 'ALREADY_DISCARDED', 10);
  setOutcome(outcomes, result, 'protected', 'skipped', 'PROTECTED', 20);
  setOutcome(outcomes, result, 'unsupported', 'skipped', 'UNSUPPORTED', 20);
  setOutcome(outcomes, result, 'missing', 'skipped', 'NOT_ELIGIBLE', 20);
  setOutcome(outcomes, result, 'skipped', 'skipped', 'NOT_ELIGIBLE', 20);
  setOutcome(outcomes, result, 'unknownSuspension', 'failed', 'STATE_UNAVAILABLE', 30);
  setOutcome(outcomes, result, 'unknownOwnership', 'failed', 'STATE_UNAVAILABLE', 30);
  setOutcome(outcomes, result, 'failed', 'failed', 'OPERATION_FAILED', 40);
  setOutcome(outcomes, result, 'succeeded', 'succeeded', 'DISCARDED', 50);

  return Object.freeze(tabIds.map(tabId => {
    const value = outcomes.get(tabId) || {
      code: 'NOT_ELIGIBLE',
      status: 'skipped',
      tabId
    };
    return Object.freeze({
      code: value.code,
      status: value.status,
      tabId
    });
  }));
};

const summarize = outcomes => Object.freeze({
  failed: outcomes.filter(outcome => outcome.status === 'failed').length,
  skipped: outcomes.filter(outcome => outcome.status === 'skipped').length,
  succeeded: outcomes.filter(outcome => outcome.status === 'succeeded').length,
  total: outcomes.length
});

const createExternalDiscardController = ({
  execute,
  maxConcurrent = EXTERNAL_CONCURRENCY_LIMIT,
  maxRequests = EXTERNAL_RATE_LIMIT,
  now = Date.now,
  rateWindow = EXTERNAL_RATE_WINDOW,
  readTrustedIds
}) => {
  if (typeof execute !== 'function' || typeof readTrustedIds !== 'function') {
    throw Error('external discard controller dependencies are unavailable');
  }
  const senders = new Map();
  let inFlight = 0;

  const handle = async (request, sender = {}) => {
    const senderId = sender?.id;
    let trusted;
    try {
      trusted = normalizeTrustedIds(await readTrustedIds());
    }
    catch (error) {
      return failure('UNAUTHORIZED');
    }
    if (!validExtensionId(senderId) || !trusted.includes(senderId)) {
      return failure('UNAUTHORIZED');
    }

    let parsed;
    try {
      parsed = validateExternalDiscardRequest(request);
    }
    catch (error) {
      return failure(error?.code || 'INVALID_REQUEST');
    }

    const timestamp = Number(now());
    const previous = senders.get(senderId) || {inFlight: false, starts: []};
    previous.starts = previous.starts.filter(start => timestamp - start < rateWindow);
    if (previous.inFlight) {
      return failure('BUSY');
    }
    if (inFlight >= maxConcurrent) {
      return failure('BUSY');
    }
    if (previous.starts.length >= maxRequests) {
      return failure('RATE_LIMITED');
    }
    previous.starts.push(timestamp);
    previous.inFlight = true;
    inFlight += 1;
    senders.set(senderId, previous);

    try {
      let result;
      try {
        result = await execute(parsed);
      }
      catch (error) {
        // The shared command pipeline attaches its settled partial result to an
        // AggregateError. Preserve those exact per-tab classifications without
        // reflecting its exception strings to another extension.
        result = error?.result;
        if (!result) {
          const outcomes = Object.freeze(parsed.tabIds.map(tabId => Object.freeze({
            code: 'OPERATION_FAILED',
            status: 'failed',
            tabId
          })));
          return Object.freeze({
            ok: false,
            outcomes,
            summary: summarize(outcomes)
          });
        }
      }

      const outcomes = sanitizeExternalDiscardResult(parsed.tabIds, result);
      const summary = summarize(outcomes);
      return Object.freeze({
        ok: summary.failed === 0,
        outcomes,
        summary
      });
    }
    finally {
      previous.inFlight = false;
      inFlight = Math.max(0, inFlight - 1);
    }
  };

  return Object.freeze({handle});
};

export {
  createExternalDiscardController,
  EXTERNAL_BATCH_LIMIT,
  EXTERNAL_CONCURRENCY_LIMIT,
  EXTERNAL_DISCARD_METHOD,
  EXTERNAL_RATE_LIMIT,
  EXTERNAL_RATE_WINDOW,
  EXTERNAL_TRUSTED_IDS_KEY,
  normalizeTrustedIds,
  readTrustedExtensionIds,
  sanitizeExternalDiscardResult,
  validateExternalDiscardRequest
};
