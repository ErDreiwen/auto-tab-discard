const FRAME_PROBE_CONTROL_LIMIT = 64;
const FRAME_PROBE_MEDIA_LIMIT = 32;
const FRAME_PROBE_RESULT_LIMIT = 2048;
const FRAME_WATCH_BATCH_SIZE = 8;
const FRAME_WATCH_LIMIT = 32;
const FRAME_MESSAGE_LIMIT = 6; // top metadata + probe + four watcher batches
const FRAME_OUTPUT_LIMIT = 2; // top metadata plus one aggregate object
const FRAME_STRESS_DURATION_LIMIT = 100;
const FRAME_STRESS_RETAINED_BYTES_LIMIT = 16 * 1024;

const numericFrameId = value => Number.isInteger(value) && value > 0;
const compareFrame = (a, b) => a.frameId - b.frameId;

// This function is intentionally self-contained: chrome.scripting serializes
// it into each frame, so it cannot close over module declarations.
const probeFrameProtection = (requirements, limits) => {
  if (window.top === window) {
    return null;
  }

  const result = {a: false, f: false, p: false, w: false};
  const controlLimit = Math.max(1, Math.min(256, Number(limits?.controls) || 64));
  const mediaLimit = Math.max(1, Math.min(128, Number(limits?.media) || 32));

  try {
    if (requirements.form === true) {
      const installed = window.__autoTabDiscardWatchInstalled === true;
      try {
        result.f = window.isReceivingFormInput === true;
      }
      catch (e) {
        result.f = true;
      }

      let controls = 0;
      let hasUntrackedEditable = false;
      const candidates = document.querySelectorAll(
        'input,textarea,select,[contenteditable],object[type="application/pdf"]'
      );
      for (const element of candidates) {
        result.w = true;
        controls += 1;
        if (controls > controlLimit) {
          // A truncated form scan cannot establish safety. It is still useful
          // as a watcher candidate, but this check must fail closed today.
          result.f = true;
          break;
        }
        const tag = String(element?.tagName || '').toUpperCase();
        const type = String(element?.type || 'text').toLowerCase();
        if (tag === 'INPUT' && ['button', 'hidden', 'image', 'reset', 'submit'].includes(type)) {
          continue;
        }
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
          hasUntrackedEditable ||= element.isContentEditable !== false;
        }
        if (result.f) {
          break;
        }
      }
      if (hasUntrackedEditable && installed === false) {
        result.f = true;
      }
    }

    if (requirements.audio === true || requirements.paused === true) {
      result.a = requirements.audio === true && Boolean(document.pictureInPictureElement);
      let mediaSeen = 0;
      for (const element of document.querySelectorAll('video,audio')) {
        mediaSeen += 1;
        if (mediaSeen > mediaLimit) {
          // A capped media scan is unknown, so enabled media protections fail closed.
          result.a ||= requirements.audio === true;
          result.p ||= requirements.paused === true;
          break;
        }
        if (requirements.paused === true && element.paused && element.currentTime) {
          result.p = true;
        }
      }
    }
  }
  catch (e) {
    // A detaching or cross-process frame must not turn an enabled protection off.
    result.a = requirements.audio === true;
    result.f = requirements.form === true;
    result.p = requirements.paused === true;
  }
  return result;
};

const frameRequirements = preferences => ({
  audio: preferences?.audio === true,
  form: preferences?.form === true,
  paused: preferences?.paused === true
});

const needsAggregateFrames = requirements => requirements.audio || requirements.form || requirements.paused;

const summarizeFrameProbes = (injectionResults, requirements, options = {}) => {
  const resultLimit = Math.max(1, Math.min(
    FRAME_PROBE_RESULT_LIMIT,
    Number(options.resultLimit) || FRAME_PROBE_RESULT_LIMIT
  ));
  const watchLimit = Math.max(0, Math.min(
    FRAME_WATCH_LIMIT,
    Number.isFinite(Number(options.watchLimit)) ? Number(options.watchLimit) : FRAME_WATCH_LIMIT
  ));
  const input = Array.isArray(injectionResults) ? injectionResults : [];
  const truncated = input.length > resultLimit;
  const aggregate = {
    audible: truncated && requirements.audio === true,
    forms: truncated && requirements.form === true,
    paused: truncated && requirements.paused === true
  };
  const candidates = [];

  for (const entry of input.slice(0, resultLimit)) {
    const value = entry?.result;
    if (!value || typeof value !== 'object') {
      continue;
    }
    aggregate.audible ||= requirements.audio === true && value.a === true;
    aggregate.forms ||= requirements.form === true && value.f === true;
    aggregate.paused ||= requirements.paused === true && value.p === true;
    if (requirements.form === true && value.w === true && numericFrameId(entry.frameId)) {
      candidates.push({
        documentId: typeof entry.documentId === 'string' ? entry.documentId : undefined,
        frameId: entry.frameId,
        protected: value.f === true
      });
    }
  }

  candidates.sort((a, b) => Number(b.protected) - Number(a.protected) || compareFrame(a, b));
  const selected = [];
  const ids = new Set();
  for (const candidate of candidates) {
    if (selected.length >= watchLimit) {
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
    observed: Math.min(input.length, resultLimit),
    truncated
  };
};

const batches = (values, size = FRAME_WATCH_BATCH_SIZE) => {
  const output = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
};

const createFrameMetadataCollector = ({
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
  const watched = new Map();

  const collect = async (tabId, preferences = {}) => {
    const requirements = frameRequirements(preferences);
    const topPromise = execute({
      target: {tabId},
      files: ['/data/inject/meta.js']
    });
    if (!needsAggregateFrames(requirements)) {
      const top = await topPromise;
      return (top || []).slice(0, 1).map(entry => entry.result);
    }

    const probePromise = execute({
      target: {tabId, allFrames: true},
      func: probeFrameProtection,
      args: [requirements, {
        controls: FRAME_PROBE_CONTROL_LIMIT,
        media: FRAME_PROBE_MEDIA_LIMIT
      }]
    });
    const [topOutcome, probeOutcome] = await Promise.allSettled([topPromise, probePromise]);
    if (topOutcome.status !== 'fulfilled') {
      throw topOutcome.reason;
    }
    const top = (topOutcome.value || []).find(entry => entry?.frameId === 0) || topOutcome.value?.[0];
    if (!top || !top.result) {
      return [];
    }
    if (probeOutcome.status !== 'fulfilled') {
      return [top.result, {
        audible: requirements.audio,
        forms: requirements.form,
        paused: requirements.paused
      }];
    }

    const summary = summarizeFrameProbes(probeOutcome.value, requirements);
    if (requirements.form && summary.candidates.length) {
      const presentDocuments = new Set(summary.candidates.map(item => item.documentId).filter(Boolean));
      const known = watched.get(tabId) || new Set();
      for (const documentId of known) {
        if (!presentDocuments.has(documentId)) {
          known.delete(documentId);
        }
      }
      const selected = summary.candidates.filter(candidate =>
        !candidate.documentId || !known.has(candidate.documentId)
      ).slice(0, FRAME_WATCH_LIMIT);
      for (const batch of batches(selected)) {
        try {
          const injected = await execute({
            target: {
              tabId,
              frameIds: batch.map(item => item.frameId)
            },
            files: [watchFile]
          });
          const successful = new Set((injected || []).map(item => item.documentId).filter(Boolean));
          for (const candidate of batch) {
            if (candidate.documentId && (successful.size === 0 || successful.has(candidate.documentId))) {
              known.add(candidate.documentId);
            }
          }
        }
        catch (e) {
          // A frame commonly disappears between probe and injection. Its state
          // already contributed to this aggregate, and the next scan retries.
        }
      }
      watched.set(tabId, known);
    }

    return [top.result, summary.aggregate].slice(0, FRAME_OUTPUT_LIMIT);
  };

  const forget = tabId => watched.delete(tabId);
  return {collect, forget};
};

export {
  createFrameMetadataCollector,
  FRAME_MESSAGE_LIMIT,
  FRAME_OUTPUT_LIMIT,
  FRAME_PROBE_CONTROL_LIMIT,
  FRAME_PROBE_MEDIA_LIMIT,
  FRAME_PROBE_RESULT_LIMIT,
  FRAME_STRESS_DURATION_LIMIT,
  FRAME_STRESS_RETAINED_BYTES_LIMIT,
  FRAME_WATCH_BATCH_SIZE,
  FRAME_WATCH_LIMIT,
  frameRequirements,
  needsAggregateFrames,
  probeFrameProtection,
  summarizeFrameProbes
};
