const CATEGORIES = Object.freeze({
  TRANSIENT: 'transient-frame',
  PERMISSION: 'permission',
  CLOSED: 'tab-closed',
  POLICY: 'policy',
  UNKNOWN: 'unknown'
});

const normalizeCode = value => String(value || '')
  .trim()
  .replace(/([a-z])([A-Z])/g, '$1_$2')
  .replace(/[^a-z0-9]+/gi, '_')
  .replace(/^_+|_+$/g, '')
  .toUpperCase();

const CODE_CATEGORIES = new Map([
  ['FRAME_NOT_FOUND', CATEGORIES.TRANSIENT],
  ['FRAME_NOT_READY', CATEGORIES.TRANSIENT],
  ['FRAME_REMOVED', CATEGORIES.TRANSIENT],
  ['ERR_FRAME_REMOVED', CATEGORIES.TRANSIENT],
  ['MISSING_HOST_PERMISSION', CATEGORIES.PERMISSION],
  ['MISSING_HOST_PERMISSION_ERROR', CATEGORIES.PERMISSION],
  ['ERR_ACCESS_DENIED', CATEGORIES.PERMISSION],
  ['TAB_NOT_FOUND', CATEGORIES.CLOSED],
  ['INVALID_TAB_ID', CATEGORIES.CLOSED],
  ['NO_TAB', CATEGORIES.CLOSED],
  ['BLOCKED_BY_ADMINISTRATOR', CATEGORIES.POLICY],
  ['BLOCKED_BY_POLICY', CATEGORIES.POLICY],
  ['POLICY_BLOCKED', CATEGORIES.POLICY]
]);

// Sanitized messages observed across Chromium, Edge, and Firefox releases.
// Keep these anchored and ID-agnostic: an unfamiliar error must fail closed.
const MESSAGE_CORPUS = Object.freeze([
  [CATEGORIES.TRANSIENT, /^frame with id \d+ (?:was removed|is not ready)\.?$/i],
  [CATEGORIES.TRANSIENT, /^no frame with id:? \d+(?: in tab(?: with id)? \d+)?\.?$/i],
  [CATEGORIES.TRANSIENT, /^the frame was removed\.?$/i],
  [CATEGORIES.PERMISSION, /^missing host permission(?: for the tab)?\.?$/i],
  [CATEGORIES.PERMISSION, /^cannot access contents of (?:the )?(?:url|page)/i],
  [CATEGORIES.PERMISSION, /^cannot access (?:a |the )?(?:chrome|edge|about|moz-extension):\/\//i],
  [CATEGORIES.PERMISSION, /^the extensions gallery cannot be scripted\.?$/i],
  [CATEGORIES.CLOSED, /^(?:no tab with id|invalid tab id:?|tab not found:?|the tab was closed)/i],
  [CATEGORIES.POLICY, /^(?:blocked|disabled|denied) by (?:the )?(?:administrator|enterprise )?policy/i],
  [CATEGORIES.POLICY, /^scripting (?:is )?disabled by (?:the )?(?:administrator|enterprise )?policy/i]
]);

const errorMessage = error => String(
  error?.message ?? error?.cause?.message ?? error ?? ''
).trim();

const structuredCodes = error => [
  error?.code,
  error?.name,
  error?.cause?.code,
  error?.cause?.name
].map(normalizeCode).filter(Boolean);

const classifyBrowserError = error => {
  const codes = structuredCodes(error);
  for (const code of codes) {
    const category = CODE_CATEGORIES.get(code);
    if (category) {
      return {category, source: 'code', code, message: errorMessage(error)};
    }
  }

  const message = errorMessage(error);
  for (const [category, pattern] of MESSAGE_CORPUS) {
    if (pattern.test(message)) {
      return {category, source: 'message', message};
    }
  }
  return {category: CATEGORIES.UNKNOWN, source: 'unknown', message};
};

// A live read is authoritative after executeScript fails. It can prove that
// the target disappeared or changed state, but it must never turn an unknown,
// permission, or policy error into permission to continue to native discard.
const scriptingFailureDecision = (error, tab) => {
  const classification = classifyBrowserError(error);
  if (tab === null || tab === undefined) {
    return {
      action: 'settled',
      classification: {...classification, category: CATEGORIES.CLOSED, source: 'post-state'}
    };
  }
  if (tab.discarded === true || tab.frozen === true || tab.active === true) {
    return {action: 'settled', classification, tab};
  }
  if (classification.category === CATEGORIES.TRANSIENT) {
    return {action: 'retry', classification, tab};
  }
  return {action: 'fail', classification, tab};
};

export {
  CATEGORIES,
  classifyBrowserError,
  scriptingFailureDecision
};
