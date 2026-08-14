const MAX_MARKER_CODEPOINTS = 32;

const normalizeTitleMarker = value => {
  const normalized = String(value ?? '')
    .normalize('NFC')
    .replace(/[\s\u200e\u200f\u202a-\u202e\u2066-\u2069]+/gu, ' ')
    .trim();
  return [...normalized].slice(0, MAX_MARKER_CODEPOINTS).join('');
};

const stripTitleMarker = (title, marker) => {
  marker = normalizeTitleMarker(marker);
  const original = String(title ?? '');
  let value = original.normalize('NFC');
  if (!marker) {
    return original;
  }
  // Collapse legacy duplicates as well as this fork's current single prefix.
  let stripped = false;
  while (value === marker || (value.startsWith(marker) && /^\s/u.test(value.slice(marker.length)))) {
    value = value.slice(marker.length).replace(/^\s+/u, '');
    stripped = true;
  }
  // An unmarked page title is page-owned content. Preserve its exact code-unit
  // representation so a later rollback does not silently NFC-normalize a
  // combining title that the page authored. Only the extension-owned prefix
  // removal path returns the normalized, unmarked value.
  return stripped ? value : original;
};

const applyTitleMarker = (title, marker, fallback = '') => {
  marker = normalizeTitleMarker(marker);
  const source = String(title || fallback || '').normalize('NFC');
  if (!marker) {
    return source;
  }
  const unmarked = stripTitleMarker(source, marker);
  return unmarked ? `${marker} ${unmarked}` : marker;
};

// Capture both sides of the one DOM write. Restoration is deliberately an
// exact compare-and-swap: if a site rewrites its title after we mark it, that
// live title wins and is never replaced with our older snapshot.
const titleMarkerSnapshot = (title, marker, fallback = '') => {
  const authored = String(title ?? '');
  return Object.freeze({
    marker: normalizeTitleMarker(marker),
    original: stripTitleMarker(authored, marker),
    written: applyTitleMarker(authored, marker, fallback)
  });
};

const restoreTitleMarker = (title, snapshot) => {
  const current = String(title ?? '');
  if (!snapshot || current !== snapshot.written) {
    return current;
  }
  return String(snapshot.original ?? '');
};

export {
  applyTitleMarker,
  MAX_MARKER_CODEPOINTS,
  normalizeTitleMarker,
  restoreTitleMarker,
  titleMarkerSnapshot,
  stripTitleMarker
};
