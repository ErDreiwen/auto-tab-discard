const FRAME_ENUMERATION_TIMEOUT = 1000;
const FRAME_PROBE_BATCH_SIZE = 8;
const FRAME_PROBE_CONTROL_LIMIT = 64;
const FRAME_PROBE_FRAME_LIMIT = 64;
const FRAME_PROBE_MEDIA_LIMIT = 32;
const FRAME_PROBE_RESULT_LIMIT = 2048;
const FRAME_FALLBACK_VALUE_LIMIT = 2048;
const FRAME_FALLBACK_RETAINED_VALUE_LIMIT = 16 * 1024;
const FRAME_WATCH_BATCH_SIZE = 8;
const FRAME_WATCH_LIMIT = 32;
const FRAME_MESSAGE_LIMIT = 1 +
  Math.ceil(FRAME_PROBE_FRAME_LIMIT / FRAME_PROBE_BATCH_SIZE) +
  Math.ceil(FRAME_WATCH_LIMIT / FRAME_WATCH_BATCH_SIZE);
const FRAME_OUTPUT_LIMIT = 2; // top metadata plus one aggregate object
const FRAME_PHYSICAL_SCRIPT_LIMIT = 1 + FRAME_PROBE_FRAME_LIMIT + FRAME_WATCH_LIMIT;
const FRAME_STRESS_DURATION_LIMIT = 100;
const FRAME_STRESS_RETAINED_BYTES_LIMIT = 16 * 1024;
const OPTIONAL_FRAME_PERMISSION = Object.freeze({permissions: Object.freeze(['webNavigation'])});

const numericFrameId = value => Number.isInteger(value) && value > 0;
const compareFrame = (a, b) => a.frameId - b.frameId;
const validDocumentId = value => typeof value === 'string' && value.length > 0;

// This function is intentionally self-contained: chrome.scripting serializes
// it into a target frame, so it cannot close over module declarations. In
// `tree` mode it remains in the top frame and walks only same-origin children.
const probeFrameProtection = (requirements, limits, mode = 'frame') => {
  const enabled = {
    audio: requirements?.audio === true,
    form: requirements?.form === true,
    paused: requirements?.paused === true
  };
  const result = {a: false, f: false, p: false, w: false};
  const controlLimit = Math.max(1, Math.min(256, Number(limits?.controls) || 64));
  const frameLimit = Math.max(1, Math.min(256, Number(limits?.frames) || 64));
  const mediaLimit = Math.max(1, Math.min(128, Number(limits?.media) || 32));
  const valueLimit = Math.max(1, Math.min(2048, Number(limits?.valueChars) || 2048));
  const retainedValueLimit = Math.max(valueLimit, Math.min(
    16 * 1024,
    Number(limits?.retainedValueChars) || 16 * 1024
  ));
  const failClosed = () => {
    result.a ||= enabled.audio;
    result.f ||= enabled.form;
    result.p ||= enabled.paused;
  };

  const inspect = (view, frameDocument) => {
    try {
      if (enabled.form) {
        const fallbackStateKey = '__autoTabDiscardFallbackWatchState';
        let fallbackState;
        let installed = view.__autoTabDiscardWatchInstalled === true;
        if (mode === 'tree') {
          const candidate = view[fallbackStateKey];
          if (candidate?.version === 1 && typeof candidate.read === 'function') {
            fallbackState = candidate;
            installed = true;
          }
        }
        try {
          result.f ||= view.isReceivingFormInput === true;
        }
        catch (e) {
          result.f = true;
        }

        let controls = 0;
        let hasCandidate = false;
        let hasUntrackedEditable = false;
        let scanComplete = true;
        const boundedCandidates = [];
        const candidates = frameDocument.querySelectorAll(
          'input,textarea,select,[contenteditable],object[type="application/pdf"]'
        );
        for (const element of candidates) {
          controls += 1;
          if (controls > controlLimit) {
            // A truncated form scan cannot establish safety.
            result.f = true;
            scanComplete = false;
            break;
          }
          const tag = String(element?.tagName || '').toUpperCase();
          const type = String(element?.type || 'text').toLowerCase();
          if (tag === 'INPUT' && ['button', 'hidden', 'image', 'reset', 'submit'].includes(type)) {
            continue;
          }
          let richEditor = element?.isContentEditable === true;
          if (!richEditor && tag !== 'INPUT' && tag !== 'TEXTAREA' &&
              tag !== 'SELECT' && tag !== 'OBJECT') {
            const value = typeof element?.getAttribute === 'function' ?
              element.getAttribute('contenteditable') : null;
            richEditor = value !== null && String(value).toLowerCase() !== 'false';
          }
          if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' &&
              tag !== 'OBJECT' && richEditor === false) {
            continue;
          }
          hasCandidate = true;
          boundedCandidates.push(element);
          if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) {
            result.f ||= Boolean(element.checked) !== Boolean(element.defaultChecked);
          }
          else if (tag === 'SELECT') {
            let optionsSeen = 0;
            for (const option of element.options || []) {
              optionsSeen += 1;
              if (optionsSeen > controlLimit) {
                result.f = true;
                break;
              }
              if (Boolean(option.selected) !== Boolean(option.defaultSelected)) {
                result.f = true;
                break;
              }
            }
          }
          else if (tag === 'INPUT' || tag === 'TEXTAREA') {
            result.f ||= String(element.value ?? '') !== String(element.defaultValue ?? '');
          }
          else if (tag === 'OBJECT') {
            // A PDF editor cannot expose a trustworthy pristine baseline here.
            hasUntrackedEditable = true;
          }
          else {
            hasUntrackedEditable ||= richEditor;
          }
        }
        if (fallbackState) {
          try {
            result.f ||= fallbackState.read(boundedCandidates, scanComplete);
          }
          catch (e) {
            result.f = true;
          }
        }
        if (hasUntrackedEditable && installed === false) {
          result.f = true;
        }
        if (hasCandidate && installed === false && mode === 'tree') {
          try {
            if (typeof view.addEventListener !== 'function') {
              throw Error('same-origin frame event target is unavailable');
            }

            // Keep at most one baseline per bounded candidate. Unlike a sticky
            // dirty bit, this lets an ordinary control become clean after a real
            // undo/toggle-back while late rich editors and PDFs remain unknown.
            const baselines = new Map();
            let overflow = scanComplete === false;
            let ready = false;
            let retainedValueChars = 0;
            const tagName = element => String(element?.tagName || '').toUpperCase();
            const inputType = element => String(element?.type || 'text').toLowerCase();
            const ignoredInputTypes = new Set([
              'button', 'hidden', 'image', 'reset', 'submit'
            ]);
            const isStandardControl = element => {
              const tag = tagName(element);
              return tag === 'TEXTAREA' || tag === 'SELECT' ||
                (tag === 'INPUT' && ignoredInputTypes.has(inputType(element)) === false);
            };
            const isRichEditor = element => {
              if (tagName(element) === 'OBJECT') {
                return false;
              }
              if (element?.isContentEditable === true) {
                return true;
              }
              try {
                const value = typeof element?.getAttribute === 'function' ?
                  element.getAttribute('contenteditable') : null;
                return value !== null && String(value).toLowerCase() !== 'false';
              }
              catch (e) {
                overflow = true;
                return false;
              }
            };
            const snapshot = (element, defaults = false) => {
              const tag = tagName(element);
              const type = inputType(element);
              if (tag === 'SELECT') {
                const selected = [];
                let optionsSeen = 0;
                for (const option of element.options || []) {
                  optionsSeen += 1;
                  if (optionsSeen > controlLimit) {
                    overflow = true;
                    break;
                  }
                  selected.push(Boolean(defaults ? option.defaultSelected : option.selected));
                }
                return JSON.stringify(selected);
              }
              if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) {
                return String(Boolean(defaults ? element.defaultChecked : element.checked));
              }
              if (isStandardControl(element)) {
                return String(element[defaults ? 'defaultValue' : 'value'] ?? '');
              }
              return String(element.innerHTML ?? element.textContent ?? '');
            };
            const prune = () => {
              for (const [element, baseline] of baselines) {
                if (element?.isConnected === false) {
                  retainedValueChars -= baseline.value?.length || 0;
                  baselines.delete(element);
                }
              }
            };
            const remember = (element, defaults, certain) => {
              if (!element || baselines.has(element)) {
                return;
              }
              prune();
              if (baselines.size >= controlLimit) {
                overflow = true;
                return;
              }
              if (certain === false) {
                // Unknown rich/PDF state needs no retained page content.
                baselines.set(element, {certain: false});
                return;
              }
              try {
                const value = snapshot(element, defaults);
                if (value.length > valueLimit ||
                    retainedValueChars + value.length > retainedValueLimit) {
                  overflow = true;
                  return;
                }
                retainedValueChars += value.length;
                baselines.set(element, {certain: true, value});
              }
              catch (e) {
                overflow = true;
              }
            };
            const eventPath = event => {
              try {
                const path = typeof event?.composedPath === 'function' ?
                  event.composedPath() : event?.path;
                if (path?.length) {
                  return path;
                }
              }
              catch (e) {}
              return event?.target ? [event.target] : [];
            };
            const editableFrom = event => eventPath(event).find(element =>
              isStandardControl(element) || tagName(element) === 'OBJECT' || isRichEditor(element)
            );
            const rememberCurrent = event => {
              const element = editableFrom(event);
              if (!element) {
                return;
              }
              if (tagName(element) === 'OBJECT') {
                remember(element, false, false);
              }
              else {
                remember(element, false, true);
              }
            };
            const rememberAfterChange = event => {
              const element = editableFrom(event);
              if (!element || baselines.has(element)) {
                return;
              }
              if (isStandardControl(element)) {
                remember(element, true, true);
              }
              else {
                remember(element, false, false);
              }
            };
            const read = (elements, complete) => {
              if (ready === false) {
                return true;
              }
              if (complete !== true) {
                overflow = true;
              }
              for (const element of elements || []) {
                if (baselines.has(element)) {
                  continue;
                }
                if (isStandardControl(element)) {
                  remember(element, true, true);
                }
                else {
                  // A late scan cannot reconstruct a rich/PDF baseline.
                  remember(element, false, false);
                }
              }
              prune();
              if (overflow) {
                return true;
              }
              for (const [element, baseline] of baselines) {
                try {
                  if (baseline.certain === false) {
                    return true;
                  }
                  const current = snapshot(element);
                  if (current.length > valueLimit || current !== baseline.value) {
                    return true;
                  }
                }
                catch (e) {
                  return true;
                }
              }
              return false;
            };

            for (const element of boundedCandidates) {
              if (isStandardControl(element)) {
                remember(element, true, true);
              }
              else {
                remember(element, false, false);
              }
            }
            const state = Object.freeze({read, version: 1});
            Object.defineProperty(view, fallbackStateKey, {value: state});
            for (const type of ['beforeinput', 'paste', 'focusin', 'pointerdown']) {
              view.addEventListener(type, rememberCurrent, true);
            }
            for (const type of ['input', 'change']) {
              view.addEventListener(type, rememberAfterChange, true);
            }
            ready = true;
            installed = true;
            // The first scan remains protected across the probe-to-listener
            // boundary. Later scans observe this sentinel and can go clean.
            result.w = true;
          }
          catch (e) {
            result.f = true;
          }
        }
        else {
          result.w ||= hasCandidate && installed === false;
        }
      }

      if (enabled.audio || enabled.paused) {
        result.a ||= enabled.audio && Boolean(frameDocument.pictureInPictureElement);
        let mediaSeen = 0;
        for (const element of frameDocument.querySelectorAll('video,audio')) {
          mediaSeen += 1;
          if (mediaSeen > mediaLimit) {
            // A capped media scan is unknown, so enabled media protections fail closed.
            result.a ||= enabled.audio;
            result.p ||= enabled.paused;
            break;
          }
          if (enabled.paused && element.paused && element.currentTime) {
            result.p = true;
          }
        }
      }
    }
    catch (e) {
      // A detaching, hostile, or cross-process document is an unknown branch.
      failClosed();
    }
  };

  if (mode !== 'tree') {
    if (window.top === window) {
      return null;
    }
    inspect(window, document);
    return result;
  }

  // Without the optional frame-enumeration permission, one top-frame script
  // can still inspect a useful bounded same-origin tree. Inaccessible branches
  // are never treated as clean.
  const queue = [];
  let discovered = 0;
  const enqueue = view => {
    let count;
    try {
      count = Math.max(0, Number(view.frames.length) || 0);
    }
    catch (e) {
      failClosed();
      return;
    }
    const remaining = Math.max(0, frameLimit - discovered);
    const accepted = Math.min(count, remaining);
    for (let index = 0; index < accepted; index += 1) {
      try {
        queue.push(view.frames[index]);
        discovered += 1;
      }
      catch (e) {
        failClosed();
      }
    }
    if (count > accepted) {
      failClosed();
    }
  };

  enqueue(window);
  for (let index = 0; index < queue.length; index += 1) {
    const view = queue[index];
    try {
      const frameDocument = view.document;
      if (!frameDocument) {
        failClosed();
        continue;
      }
      inspect(view, frameDocument);
      enqueue(view);
    }
    catch (e) {
      // Cross-origin WindowProxy access and frame detach both land here.
      failClosed();
    }
  }
  return result;
};

const frameRequirements = preferences => ({
  audio: preferences?.audio === true,
  form: preferences?.form === true,
  paused: preferences?.paused === true
});

const needsAggregateFrames = requirements => requirements.audio || requirements.form || requirements.paused;

const unknownFrameAggregate = requirements => ({
  audible: requirements.audio === true,
  forms: requirements.form === true,
  paused: requirements.paused === true
});

const validProbeValue = value => value && typeof value === 'object' &&
  typeof value.a === 'boolean' && typeof value.f === 'boolean' &&
  typeof value.p === 'boolean' && typeof value.w === 'boolean';

const aggregateProbeValue = (value, requirements) => {
  if (!validProbeValue(value)) {
    return unknownFrameAggregate(requirements);
  }
  return {
    audible: requirements.audio === true && value.a === true,
    forms: requirements.form === true && (value.f === true || value.w === true),
    paused: requirements.paused === true && value.p === true
  };
};

const summarizeFrameProbes = (injectionResults, requirements, options = {}) => {
  const resultLimit = Math.max(1, Math.min(
    FRAME_PROBE_RESULT_LIMIT,
    Number(options.resultLimit) || FRAME_PROBE_RESULT_LIMIT
  ));
  const candidateLimit = Math.max(0, Math.min(
    FRAME_PROBE_FRAME_LIMIT,
    Number.isFinite(Number(options.candidateLimit)) ?
      Number(options.candidateLimit) : FRAME_PROBE_FRAME_LIMIT
  ));
  const input = Array.isArray(injectionResults) ? injectionResults : [];
  const expectedInput = Array.isArray(options.expectedFrameIds) ? options.expectedFrameIds : undefined;
  const expected = expectedInput ? new Set(expectedInput.filter(numericFrameId)) : undefined;
  const expectedDocuments = options.expectedDocuments instanceof Map ?
    options.expectedDocuments : undefined;
  let incomplete = input.length > resultLimit ||
    Boolean(expected && expected.size !== expectedInput.length);
  const aggregate = {
    audible: false,
    forms: false,
    paused: false
  };
  const candidates = [];
  const seen = new Set();

  for (const entry of input.slice(0, resultLimit)) {
    const frameId = entry?.frameId;
    if (!numericFrameId(frameId) || seen.has(frameId) || (expected && !expected.has(frameId))) {
      incomplete = true;
      continue;
    }
    seen.add(frameId);
    if (expectedDocuments && entry?.documentId !== expectedDocuments.get(frameId)) {
      incomplete = true;
      continue;
    }
    const value = entry?.result;
    if (!validProbeValue(value)) {
      incomplete = true;
      continue;
    }
    aggregate.audible ||= requirements.audio === true && value.a === true;
    aggregate.forms ||= requirements.form === true && value.f === true;
    aggregate.paused ||= requirements.paused === true && value.p === true;
    if (requirements.form === true && value.w === true) {
      candidates.push({
        documentId: typeof entry.documentId === 'string' ? entry.documentId : undefined,
        frameId,
        protected: value.f === true
      });
    }
  }

  if (expected && (seen.size !== expected.size || [...expected].some(frameId => !seen.has(frameId)))) {
    incomplete = true;
  }
  if (incomplete) {
    Object.assign(aggregate, unknownFrameAggregate(requirements));
  }

  candidates.sort((a, b) => Number(b.protected) - Number(a.protected) || compareFrame(a, b));
  const selected = [];
  const ids = new Set();
  for (const candidate of candidates) {
    if (selected.length >= candidateLimit) {
      break;
    }
    if (!ids.has(candidate.frameId)) {
      ids.add(candidate.frameId);
      selected.push(candidate);
    }
  }

  return {
    aggregate,
    candidates: selected,
    incomplete,
    observed: seen.size,
    truncated: input.length > resultLimit
  };
};

const batches = (values, size = FRAME_WATCH_BATCH_SIZE) => {
  const output = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
};

const sameFrameIds = (left, right) => Array.isArray(left) && Array.isArray(right) &&
  left.length === right.length && left.every((frameId, index) => frameId === right[index]);

const exactFrameDocuments = (documents, frameIds) => {
  if (!Array.isArray(documents)) {
    return undefined;
  }
  const expectedFrameIds = [0, ...frameIds];
  if (documents.length !== expectedFrameIds.length) {
    return undefined;
  }
  const identities = new Set();
  for (let index = 0; index < expectedFrameIds.length; index += 1) {
    const entry = documents[index];
    if (entry?.frameId !== expectedFrameIds[index] || !validDocumentId(entry.documentId) ||
        identities.has(entry.documentId)) {
      return undefined;
    }
    identities.add(entry.documentId);
  }
  return documents;
};

const sameFrameDocuments = (left, right) => Array.isArray(left) && Array.isArray(right) &&
  left.length === right.length && left.every((entry, index) =>
    entry.frameId === right[index]?.frameId && entry.documentId === right[index]?.documentId
  );

const normalizeFrameEnumeration = frames => {
  if (!Array.isArray(frames)) {
    return {complete: false, frameIds: []};
  }
  const ids = new Set();
  const documentIds = new Set();
  const documents = [];
  let identityRecords = 0;
  let complete = true;
  for (const entry of frames) {
    const hasDocumentId = entry && typeof entry === 'object' &&
      Object.hasOwn(entry, 'documentId');
    if (hasDocumentId) {
      identityRecords += 1;
    }
    if (!Number.isInteger(entry?.frameId) || entry.frameId < 0) {
      complete = false;
      continue;
    }
    if (ids.has(entry.frameId)) {
      complete = false;
    }
    ids.add(entry.frameId);
    if (hasDocumentId) {
      if (!validDocumentId(entry.documentId) || documentIds.has(entry.documentId)) {
        complete = false;
      }
      else {
        documentIds.add(entry.documentId);
        documents.push({documentId: entry.documentId, frameId: entry.frameId});
      }
    }
  }
  if (!ids.has(0)) {
    complete = false;
  }
  if (identityRecords !== 0 && identityRecords !== frames.length) {
    complete = false;
  }
  const normalized = {
    complete,
    frameIds: [...ids].filter(numericFrameId).sort((a, b) => a - b)
  };
  if (identityRecords === frames.length && documents.length === frames.length) {
    // Document identities are ephemeral race proofs only. URLs and parent
    // relationships are discarded, and this snapshot never leaves collect().
    normalized.documents = documents.sort(compareFrame);
  }
  return normalized;
};

const callBrowserMethod = (browser, target, method, args, timeoutMs) => new Promise((resolve, reject) => {
  let settled = false;
  const timer = setTimeout(() => finish(Error(`frame API ${method} timed out`)), timeoutMs);
  const finish = (error, value) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    error ? reject(error) : resolve(value);
  };
  try {
    const operation = target[method](...args, value => {
      const error = browser?.runtime?.lastError;
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

const createOptionalFrameEnumerator = (browser = globalThis.chrome, {
  timeoutMs = FRAME_ENUMERATION_TIMEOUT
} = {}) => async tabId => {
  const permissions = browser?.permissions;
  if (typeof permissions?.contains !== 'function') {
    return {complete: false, frameIds: [], granted: false};
  }
  const granted = await callBrowserMethod(
    browser,
    permissions,
    'contains',
    [OPTIONAL_FRAME_PERMISSION],
    timeoutMs
  );
  if (granted !== true) {
    return {complete: false, frameIds: [], granted: false};
  }
  const webNavigation = browser?.webNavigation;
  if (typeof webNavigation?.getAllFrames !== 'function') {
    throw Error('granted frame enumeration API is unavailable');
  }
  const frames = await callBrowserMethod(
    browser,
    webNavigation,
    'getAllFrames',
    [{tabId}],
    timeoutMs
  );
  return {granted: true, ...normalizeFrameEnumeration(frames)};
};

const createFrameMetadataCollector = ({
  enumerateFrames = async () => ({complete: false, frameIds: [], granted: false}),
  execute = details => scripting.executeScript(details),
  scripting,
  watchFile = '/data/inject/watch.js'
} = {}) => {
  if (!scripting || typeof scripting.executeScript !== 'function') {
    throw new TypeError('A scripting.executeScript adapter is required');
  }
  if (typeof execute !== 'function') {
    throw new TypeError('A guarded executeScript adapter is required');
  }
  if (typeof enumerateFrames !== 'function') {
    throw new TypeError('A frame-enumeration adapter is required');
  }
  const limits = {
    controls: FRAME_PROBE_CONTROL_LIMIT,
    frames: FRAME_PROBE_FRAME_LIMIT,
    media: FRAME_PROBE_MEDIA_LIMIT,
    retainedValueChars: FRAME_FALLBACK_RETAINED_VALUE_LIMIT,
    valueChars: FRAME_FALLBACK_VALUE_LIMIT
  };
  const exactFrameResult = (results, frameId) => Array.isArray(results) &&
    results.length === 1 && results[0]?.frameId === frameId &&
    results[0]?.result && typeof results[0].result === 'object' ? results[0] : undefined;

  const collect = async (tabId, preferences = {}) => {
    const requirements = frameRequirements(preferences);
    const topResults = await execute({
      target: {tabId},
      files: ['/data/inject/meta.js']
    });
    const top = exactFrameResult(topResults, 0);
    if (!top) {
      const error = Error('top-frame metadata result was incomplete');
      error.code = 'FRAME_TOP_METADATA_INCOMPLETE';
      throw error;
    }
    if (!needsAggregateFrames(requirements) || top.result.subframes === false) {
      return [top.result];
    }
    const failClosed = () => [top.result, unknownFrameAggregate(requirements)]
      .slice(0, FRAME_OUTPUT_LIMIT);
    if (top.result.subframes !== true) {
      return failClosed();
    }

    let enumeration;
    try {
      enumeration = await enumerateFrames(tabId);
    }
    catch (e) {
      // A permission/API failure cannot justify a partial or unbounded probe.
      return failClosed();
    }

    if (enumeration?.granted !== true) {
      try {
        const fallbackResults = await execute({
          target: {tabId},
          func: probeFrameProtection,
          args: [requirements, limits, 'tree']
        });
        const fallback = exactFrameResult(fallbackResults, 0);
        return [top.result, aggregateProbeValue(fallback?.result, requirements)]
          .slice(0, FRAME_OUTPUT_LIMIT);
      }
      catch (e) {
        return failClosed();
      }
    }

    const frameIds = Array.isArray(enumeration.frameIds) ? enumeration.frameIds : [];
    if (enumeration.complete !== true || frameIds.length === 0 ||
        frameIds.length > FRAME_PROBE_FRAME_LIMIT ||
        frameIds.some((frameId, index) => !numericFrameId(frameId) ||
          (index > 0 && frameId <= frameIds[index - 1]))) {
      return failClosed();
    }
    const frameDocuments = exactFrameDocuments(enumeration.documents, frameIds);
    if (!frameDocuments || top.documentId !== frameDocuments[0].documentId) {
      // Chrome 102 exposes neither webNavigation nor scripting document IDs.
      // It remains supported, but a granted identity-less snapshot cannot
      // safely distinguish a same-frame navigation and therefore stays protected.
      return failClosed();
    }
    const expectedDocuments = new Map(frameDocuments.map(entry => [
      entry.frameId,
      entry.documentId
    ]));

    const probeResults = [];
    try {
      for (const batch of batches(frameIds, FRAME_PROBE_BATCH_SIZE)) {
        const injected = await execute({
          target: {tabId, frameIds: batch},
          func: probeFrameProtection,
          args: [requirements, limits, 'frame']
        });
        if (!Array.isArray(injected)) {
          return failClosed();
        }
        probeResults.push(...injected);
      }
    }
    catch (e) {
      return failClosed();
    }

    const summary = summarizeFrameProbes(probeResults, requirements, {
      expectedDocuments,
      expectedFrameIds: frameIds
    });
    if (summary.incomplete) {
      return failClosed();
    }

    // Multi-batch probing gives the page time to add, detach, or navigate
    // frames. Re-enumeration starts no renderer script and proves the exact
    // target set stayed stable before any watcher is accepted.
    let verifiedEnumeration;
    try {
      verifiedEnumeration = await enumerateFrames(tabId);
    }
    catch (e) {
      return failClosed();
    }
    const verifiedFrameIds = Array.isArray(verifiedEnumeration?.frameIds) ?
      verifiedEnumeration.frameIds : [];
    const verifiedDocuments = exactFrameDocuments(
      verifiedEnumeration?.documents,
      verifiedFrameIds
    );
    if (verifiedEnumeration?.granted !== true || verifiedEnumeration.complete !== true ||
        !sameFrameIds(frameIds, verifiedFrameIds) ||
        !sameFrameDocuments(frameDocuments, verifiedDocuments)) {
      return failClosed();
    }

    if (requirements.form) {
      const selected = summary.candidates.slice(0, FRAME_WATCH_LIMIT);
      let watchersComplete = true;
      if (summary.candidates.length > FRAME_WATCH_LIMIT || selected.length > 0) {
        // Even a successful first watcher leaves a probe-to-injection race.
        // Protect this scan; the next probe observes the installed sentinel and
        // can make a clean decision. Overflow converges over bounded batches.
        summary.aggregate.forms = true;
      }
      for (const batch of batches(selected, FRAME_WATCH_BATCH_SIZE)) {
        try {
          const injected = await execute({
            target: {
              tabId,
              frameIds: batch.map(item => item.frameId)
            },
            files: [watchFile]
          });
          const expected = new Set(batch.map(item => item.frameId));
          const successful = new Set();
          const candidateById = new Map(batch.map(candidate => [candidate.frameId, candidate]));
          if (!Array.isArray(injected) || injected.length !== expected.size) {
            watchersComplete = false;
            break;
          }
          for (const entry of injected) {
            if (!numericFrameId(entry?.frameId) || !expected.has(entry.frameId) ||
                successful.has(entry.frameId)) {
              watchersComplete = false;
              break;
            }
            const candidate = candidateById.get(entry.frameId);
            if (candidate.documentId && entry.documentId !== candidate.documentId) {
              watchersComplete = false;
              break;
            }
            successful.add(entry.frameId);
          }
          if (!watchersComplete || successful.size !== expected.size) {
            watchersComplete = false;
            break;
          }
        }
        catch (e) {
          watchersComplete = false;
          break;
        }
      }
      if (!watchersComplete) {
        // A clean form snapshot is not enough if its future-change watcher did
        // not reach every selected frame. Protect this scan and retry later.
        summary.aggregate.forms = true;
      }
    }

    return [top.result, summary.aggregate].slice(0, FRAME_OUTPUT_LIMIT);
  };

  const forget = () => false;
  return {collect, forget};
};

export {
  aggregateProbeValue,
  createFrameMetadataCollector,
  createOptionalFrameEnumerator,
  FRAME_ENUMERATION_TIMEOUT,
  FRAME_FALLBACK_RETAINED_VALUE_LIMIT,
  FRAME_FALLBACK_VALUE_LIMIT,
  FRAME_MESSAGE_LIMIT,
  FRAME_OUTPUT_LIMIT,
  FRAME_PHYSICAL_SCRIPT_LIMIT,
  FRAME_PROBE_BATCH_SIZE,
  FRAME_PROBE_CONTROL_LIMIT,
  FRAME_PROBE_FRAME_LIMIT,
  FRAME_PROBE_MEDIA_LIMIT,
  FRAME_PROBE_RESULT_LIMIT,
  FRAME_STRESS_DURATION_LIMIT,
  FRAME_STRESS_RETAINED_BYTES_LIMIT,
  FRAME_WATCH_BATCH_SIZE,
  FRAME_WATCH_LIMIT,
  frameRequirements,
  needsAggregateFrames,
  normalizeFrameEnumeration,
  OPTIONAL_FRAME_PERMISSION,
  probeFrameProtection,
  summarizeFrameProbes,
  unknownFrameAggregate
};
