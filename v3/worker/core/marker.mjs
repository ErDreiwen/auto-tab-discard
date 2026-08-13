let lastMarkerGeneration = 0;

// Date.now() alone is not an ordering primitive: the reload-stop pass and the
// final visual pass can be issued in the same millisecond. Give every worker
// invocation a high-resolution, strictly increasing generation while retaining
// the wall-clock issuedAt value used by the document-navigation fence.
const createMarkerAttempt = (timeout, {
  now = () => Date.now(),
  preciseNow = () => {
    const origin = Number(globalThis.performance?.timeOrigin);
    const elapsed = Number(globalThis.performance?.now?.());
    return Number.isFinite(origin) && Number.isFinite(elapsed) ? origin + elapsed : Date.now();
  },
  random = () => Math.random()
} = {}) => {
  const issuedAt = Number(now());
  const precise = Number(preciseNow());
  const candidate = Math.trunc((Number.isFinite(precise) ? precise : issuedAt) * 1000);
  lastMarkerGeneration = Math.max(lastMarkerGeneration + 1, candidate);
  return {
    deadline: issuedAt + Math.max(0, Number(timeout) || 0),
    generation: lastMarkerGeneration,
    issuedAt,
    token: `${issuedAt.toString(36)}-${random().toString(36).slice(2)}`
  };
};

// This function is passed directly to chrome.scripting.executeScript. Keep it
// self-contained: imported helpers and service-worker variables are not
// available in the page's isolated world after Chrome serializes `func`.
const prepareDocumentMarker = async (marker, source, attempt) => {
  const key = '__autoTabDiscardMarkerAttempt';
  const revokedKey = '__autoTabDiscardRevokedMarkerAttempts';
  const fenceKey = '__autoTabDiscardMarkerGeneration';
  const visualKey = '__autoTabDiscardVisualState';
  const token = typeof attempt?.token === 'string' ? attempt.token : '';
  const deadline = Number(attempt?.deadline);
  const encodedCandidate = /^[0-9a-z]+-[0-9a-z]+$/i.test(token) ?
    Number.parseInt(token.split('-', 1)[0], 36) : NaN;
  // Internal tokens encode Date.now() in base36. Validate it against the
  // attempt deadline so arbitrary caller-supplied labels are never mistaken
  // for timestamps.
  const encodedIssuedAt = Number.isFinite(encodedCandidate) && encodedCandidate <= deadline &&
    deadline - encodedCandidate <= 60_000 ? encodedCandidate : NaN;
  const explicitIssuedAt = Number(attempt?.issuedAt);
  const issuedAt = Number.isFinite(explicitIssuedAt) ? explicitIssuedAt : encodedIssuedAt;
  const documentStartedAt = Number(globalThis.performance?.timeOrigin);
  const explicitGeneration = Number(attempt?.generation);
  // Current internal tokens encode their issuance time. Use that rather than
  // the deadline: two call sites can have different timeout lengths, so an
  // older long attempt may otherwise appear newer than a later short one.
  // Equal generations never steal one another's live lease.
  const generation = Number.isFinite(explicitGeneration) ? explicitGeneration :
    (Number.isFinite(issuedAt) ? issuedAt : deadline);
  const prefix = marker.prepends ? [...String(marker.prepends)
    .normalize('NFC')
    .replace(/[\s\u200e\u200f\u202a-\u202e\u2066-\u2069]+/gu, ' ')
    .trim()].slice(0, 32).join('') : '';
  const result = {
    faviconApplied: marker.favicon !== true,
    stopped: false,
    titleApplied: !prefix,
    top: window === window.top
  };

  const stale = () => ({...result, stale: true});
  const revoked = globalThis[revokedKey];
  if (revoked instanceof Map) {
    const current = Date.now();
    for (const [candidate, expiresAt] of revoked) {
      if (!Number.isFinite(expiresAt) || expiresAt <= current) {
        revoked.delete(candidate);
      }
    }
    // Rollback can race ahead of a queued executeScript invocation. Retain the
    // exact cancelled token in this document so that invocation is a no-op
    // before window.stop(), title, favicon, or listener work begins.
    if (revoked.has(token)) {
      return stale();
    }
  }
  if (!token || !Number.isFinite(deadline) || Date.now() > deadline ||
      (Number.isFinite(issuedAt) && Number.isFinite(documentStartedAt) && documentStartedAt > issuedAt)) {
    return stale();
  }

  const fence = globalThis[fenceKey];
  if (fence && fence.token !== token && generation <= fence.generation) {
    return stale();
  }
  const incumbent = globalThis[key];
  if (incumbent) {
    // A legacy string lease cannot be ordered safely, so fail closed until its
    // bounded invocation removes it. For versioned leases, latest-generation
    // wins and an older delayed invocation is a no-op before window.stop().
    if (typeof incumbent !== 'object' || incumbent.token === token ||
        (Date.now() <= incumbent.deadline && generation <= incumbent.generation)) {
      return stale();
    }
    incumbent.cancel?.();
  }

  // Unlike the short-lived async lease, this tiny generation fence survives
  // completion for the lifetime of the document. It prevents an older
  // executeScript invocation that was queued in the renderer from starting
  // after the newer invocation has already finished and removed its lease.
  globalThis[fenceKey] = {generation, token};

  let pendingCancel;
  const lease = {
    cancel: () => pendingCancel?.(),
    deadline,
    generation,
    token
  };
  globalThis[key] = lease;
  const ownsAttempt = () => globalThis[key] === lease && Date.now() <= deadline;
  const remaining = () => Math.max(0, deadline - Date.now());

  const ensureHead = () => {
    let root = document.documentElement;
    if (!root) {
      root = document.appendChild(document.createElement('html'));
    }
    let head = document.head;
    if (!head) {
      head = document.createElement('head');
      root.insertBefore(head, root.firstChild);
    }
    return head;
  };

  const wait = milliseconds => new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (pendingCancel === cancel) {
        pendingCancel = undefined;
      }
      callback(value);
    };
    const cancel = () => finish(reject, Error('marker attempt superseded'));
    pendingCancel = cancel;
    timer = setTimeout(() => finish(resolve), Math.max(0, milliseconds));
    if (!ownsAttempt()) {
      cancel();
    }
  });

  try {
    // executeScript cannot be cancelled after its service-worker-side timeout.
    // An invocation that starts late must therefore return before even calling
    // window.stop(), otherwise the expired attempt can still disturb a newer
    // navigation or marker repair.
    if (!ownsAttempt()) {
      return {...result, stale: true};
    }
    window.stop();
    result.stopped = true;
    if (!result.top || !ownsAttempt()) {
      result.stale = !ownsAttempt();
      return result;
    }

    if (prefix) {
      const authored = String(document.title ?? '');
      const head = ensureHead();
      let titleElement = head.querySelector('title');
      const previous = globalThis[visualKey];
      const carriesPrevious = previous?.title && titleElement === previous.title.node &&
        String(document.title ?? '') === previous.title.written;
      // When preferences change between two attempts, rebuild from the first
      // captured page title instead of stacking the new prefix over our old
      // one. A page-authored concurrent update disables this carry path.
      const title = carriesPrevious ? (previous.title.original || location.href || '') :
        (authored || location.href || '');
      let unmarked = title.normalize('NFC');
      while (unmarked === prefix ||
        (unmarked.startsWith(prefix) && /^\s/u.test(unmarked.slice(prefix.length)))) {
        unmarked = unmarked.slice(prefix.length).replace(/^\s+/u, '');
      }
      const next = unmarked ? `${prefix} ${unmarked}` : prefix;
      if (!ownsAttempt()) {
        return stale();
      }
      const originalTitle = carriesPrevious ? previous.title.original : (() => {
        let value = authored.normalize('NFC');
        let stripped = false;
        while (value === prefix ||
          (value.startsWith(prefix) && /^\s/u.test(value.slice(prefix.length)))) {
          value = value.slice(prefix.length).replace(/^\s+/u, '');
          stripped = true;
        }
        return stripped ? value : authored;
      })();
      const titleWasCreated = carriesPrevious ? previous.title.created : !titleElement;
      const originalText = carriesPrevious ? previous.title.originalText : titleElement?.textContent;
      if (!titleElement) {
        titleElement = head.appendChild(document.createElement('title'));
      }
      titleElement.textContent = next;
      document.title = next;
      result.title = document.title;
      result.originalTitle = originalTitle;
      result.titleApplied = document.title.startsWith(prefix);
      result.titleRestorable = result.titleApplied;
      globalThis[visualKey] = {
        ...(previous?.favicon && {favicon: previous.favicon}),
        generation,
        marker: prefix,
        title: {
          created: titleWasCreated,
          node: titleElement,
          original: originalTitle,
          originalText,
          written: String(document.title ?? '')
        },
        token
      };
    }
    else {
      result.title = document.title;
    }

    if (marker.favicon === true) {
      const load = src => new Promise((resolve, reject) => {
        const time = remaining();
        if (!src || time <= 0 || !ownsAttempt()) {
          reject(Error('favicon marker attempt expired'));
          return;
        }
        const image = new Image();
        let settled = false;
        let timer;
        const finish = (callback, value) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          image.onload = null;
          image.onerror = null;
          if (pendingCancel === cancel) {
            pendingCancel = undefined;
          }
          callback(value);
        };
        const cancel = () => finish(reject, Error('favicon marker attempt superseded'));
        pendingCancel = cancel;
        image.crossOrigin = 'anonymous';
        image.onerror = () => finish(reject, Error('favicon image failed to load'));
        image.onload = () => finish(resolve, image);
        timer = setTimeout(() => finish(reject, Error('favicon image timed out')), time);
        image.src = src;
        if (!ownsAttempt()) {
          cancel();
        }
      });

      let image;
      try {
        image = await load(source);
      }
      catch (error) {
        if (ownsAttempt()) {
          try {
            image = await load(chrome.runtime.getURL('/data/page.png'));
          }
          catch (fallbackError) {
            result.faviconError = fallbackError?.message || String(fallbackError);
          }
        }
        else {
          result.faviconError = error?.message || String(error);
        }
      }

      if (image && ownsAttempt()) {
        try {
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          if (!context) {
            throw Error('favicon canvas context is unavailable');
          }
          canvas.width = Math.max(1, image.naturalWidth || image.width || 32);
          canvas.height = Math.max(1, image.naturalHeight || image.height || 32);
          context.globalAlpha = 0.6;
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          context.globalAlpha = 1;
          context.beginPath();
          context.fillStyle = '#a1a0a1';
          context.arc(canvas.width * 0.75, canvas.height * 0.75,
            Math.min(canvas.width, canvas.height) * 0.25, 0, 2 * Math.PI, false);
          context.fill();
          const href = canvas.toDataURL('image/png');
          if (!ownsAttempt()) {
            return stale();
          }
          const head = ensureHead();
          const previous = globalThis[visualKey];
          const icons = [...document.querySelectorAll('link[rel*="icon"]')];
          const previousLink = previous?.favicon?.link;
          const carriesPrevious = previousLink && icons.length === 1 && icons[0] === previousLink &&
            previousLink.href === previous.favicon.writtenHref;
          const originals = carriesPrevious ? previous.favicon.originals : icons
            .filter(link => link.dataset?.autoTabDiscardMarker === undefined)
            .map(link => ({
              next: link.nextSibling,
              node: link,
              parent: link.parentNode
            }));
          icons.forEach(link => link.remove());
          const link = document.createElement('link');
          link.rel = 'icon';
          link.type = 'image/png';
          link.href = href;
          link.dataset.autoTabDiscardMarker = token;
          head.appendChild(link);
          globalThis[visualKey] = {
            ...(previous?.title && {title: previous.title}),
            favicon: {
              link,
              originals,
              ownerToken: token,
              writtenHref: link.href
            },
            generation,
            marker: previous?.marker || '',
            token
          };
          result.originalFaviconCount = originals.length;
          result.faviconApplied = true;
          if (marker.faviconDelay > 0 && ownsAttempt()) {
            await wait(Math.min(marker.faviconDelay, remaining()));
          }
        }
        catch (error) {
          result.faviconError = error?.message || String(error);
        }
      }
    }

    result.complete = result.titleApplied && result.faviconApplied;
    result.stale = !ownsAttempt();
    return result;
  }
  catch (error) {
    return {
      ...result,
      error: error?.message || String(error),
      stale: !ownsAttempt()
    };
  }
  finally {
    pendingCancel = undefined;
    if (globalThis[key] === lease) {
      delete globalThis[key];
    }
  }
};

// Release/abort rollback for a still-live document. Native release normally
// commits a fresh document, which restores the page naturally. This helper is
// for the bounded failure path: it only undoes exact nodes/values written by
// the matching attempt and never overwrites a site's subsequent title/icon.
// Keep it self-contained so it can also be passed to executeScript.
const restoreDocumentMarker = expected => {
  const key = '__autoTabDiscardMarkerAttempt';
  const revokedKey = '__autoTabDiscardRevokedMarkerAttempts';
  const visualKey = '__autoTabDiscardVisualState';
  const token = typeof expected === 'string' ? expected : expected?.token;
  if (token) {
    const current = Date.now();
    let revoked = globalThis[revokedKey];
    if (!(revoked instanceof Map)) {
      revoked = new Map();
      globalThis[revokedKey] = revoked;
    }
    for (const [candidate, expiresAt] of revoked) {
      if (!Number.isFinite(expiresAt) || expiresAt <= current) {
        revoked.delete(candidate);
      }
    }
    revoked.set(token, current + 60_000);
    while (revoked.size > 32) {
      revoked.delete(revoked.keys().next().value);
    }
  }
  const state = globalThis[visualKey];
  const result = {
    faviconPreserved: false,
    faviconRestored: false,
    restored: false,
    titlePreserved: false,
    titleRestored: false,
    tokenRevoked: Boolean(token)
  };
  if (!state || (token && state.token !== token)) {
    return {...result, stale: Boolean(state)};
  }

  const lease = globalThis[key];
  if (lease && lease.token !== state.token) {
    return {...result, stale: true};
  }
  if (lease?.token === state.token) {
    lease.cancel?.();
    if (globalThis[key] === lease) {
      delete globalThis[key];
    }
  }

  const title = state.title;
  if (title) {
    const current = document.head?.querySelector('title');
    if (current === title.node && String(document.title ?? '') === title.written &&
        String(current.textContent ?? '') === title.written) {
      if (title.created) {
        current.remove();
      }
      else {
        current.textContent = title.originalText ?? title.original;
        document.title = title.original;
      }
      result.titleRestored = true;
      result.originalTitle = title.original;
    }
    else {
      // A page-authored update is authoritative, even when it happens to
      // contain the same marker text elsewhere.
      result.titlePreserved = true;
    }
  }

  const favicon = state.favicon;
  if (favicon) {
    const icons = [...document.querySelectorAll('link[rel*="icon"]')];
    const markerUnchanged = icons.includes(favicon.link) &&
      favicon.link.href === favicon.writtenHref &&
      favicon.link.dataset?.autoTabDiscardMarker === (favicon.ownerToken || state.token);
    if (markerUnchanged) {
      const foreign = icons.filter(link => link !== favicon.link);
      favicon.link.remove();
      if (foreign.length === 0) {
        for (const entry of favicon.originals || []) {
          if (!entry.node?.isConnected && entry.parent) {
            const next = entry.next?.parentNode === entry.parent ? entry.next : null;
            if (typeof entry.parent.insertBefore === 'function') {
              entry.parent.insertBefore(entry.node, next);
            }
            else {
              entry.parent.appendChild?.(entry.node);
            }
          }
        }
        result.faviconRestored = true;
      }
      else {
        result.faviconPreserved = true;
      }
    }
    else {
      result.faviconPreserved = true;
    }
  }

  if (globalThis[visualKey] === state) {
    delete globalThis[visualKey];
  }
  result.restored = result.titleRestored || result.faviconRestored;
  return result;
};

const visualPreparation = (marker, result) => {
  const title = !marker.prepends || result?.titleApplied === true;
  const favicon = marker.favicon !== true || result?.faviconApplied === true;
  return {
    complete: title && favicon,
    favicon,
    ...(result?.faviconError && {faviconError: result.faviconError}),
    ...(result?.error && {error: result.error}),
    ...(result?.stale && {stale: true}),
    title
  };
};

export {createMarkerAttempt, prepareDocumentMarker, restoreDocumentMarker, visualPreparation};
