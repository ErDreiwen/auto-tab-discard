const SCRIPTABLE_PROTOCOLS = new Set([
  'http:',
  'https:'
]);

// Chromium and Firefox do not allow extensions to inject the title/favicon
// marker into these documents.  Most of them can still be discarded through
// tabs.discard(), so a manual force command may use a physical-only fallback.
const PHYSICAL_ONLY_PROTOCOLS = new Set([
  'about:',
  'blob:',
  'brave:',
  'chrome:',
  'chrome-extension:',
  'chrome-search:',
  'chrome-untrusted:',
  'data:',
  'edge:',
  'edge-extension:',
  'edge-search:',
  'file:',
  'ftp:',
  'moz-extension:',
  'opera:',
  'resource:',
  'view-source:',
  'vivaldi:'
]);

const UNSUPPORTED_PROTOCOLS = new Set([
  'devtools:',
  'javascript:',
  'mailto:',
  'tel:'
]);

const markerFallback = tab => {
  const raw = tab?.pendingUrl || tab?.url;

  // tabs.query() normally supplies a URL.  Keeping an absent URL on the
  // established renderer path is both backwards-compatible with older browser
  // snapshots and lets the real injection/native APIs make the final decision.
  if (typeof raw !== 'string' || raw.length === 0) {
    return {kind: 'scriptable'};
  }

  let protocol;
  try {
    protocol = new URL(raw).protocol.toLowerCase();
  }
  catch (error) {
    return {
      kind: 'unsupported',
      reason: `invalid tab URL: ${raw}`
    };
  }

  if (SCRIPTABLE_PROTOCOLS.has(protocol)) {
    return {kind: 'scriptable'};
  }
  if (PHYSICAL_ONLY_PROTOCOLS.has(protocol)) {
    return {
      kind: 'physical-only',
      reason: `renderer marker unavailable for ${protocol} tabs`
    };
  }
  if (UNSUPPORTED_PROTOCOLS.has(protocol)) {
    return {
      kind: 'unsupported',
      reason: `unsupported tab scheme: ${protocol}`
    };
  }
  return {
    kind: 'unsupported',
    reason: `unknown tab scheme: ${protocol || '(none)'}`
  };
};

const outcome = (tab, reason) => ({tab, reason});

export {markerFallback, outcome};
