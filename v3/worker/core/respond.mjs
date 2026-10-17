import {tabInAllowedWindowScope} from './window-scope.mjs';

const DEFAULT_DIAGNOSTIC_ACCESS_TIMEOUT = 2000;
const durableDiagnosticAccess = () => ({
  clearDurable: true,
  clearPrivate: false,
  includeDurable: true,
  includePrivate: false
});
const privateDiagnosticAccess = () => ({
  clearDurable: false,
  clearPrivate: true,
  includeDurable: false,
  includePrivate: true
});

const authorizeOptionsPageRequest = (sender, {
  expectedExtensionId = globalThis.chrome?.runtime?.id,
  expectedOptionsUrl = globalThis.chrome?.runtime?.getURL?.('data/options/index.html')
} = {}) => {
  if (typeof expectedExtensionId !== 'string' || expectedExtensionId.length === 0 ||
      typeof expectedOptionsUrl !== 'string' || expectedOptionsUrl.length === 0 ||
      sender?.id !== expectedExtensionId || sender?.url !== expectedOptionsUrl) {
    throw Error('Options sender is not authorized');
  }
  // The page-provided request has no privacy authority. open_in_tab gives the
  // worker a browser-owned Tabs.Tab bit; without it, fail closed.
  if (sender?.tab?.incognito === true) return privateDiagnosticAccess();
  if (sender?.tab?.incognito === false) return durableDiagnosticAccess();
  throw Error('Options context is incomplete');
};

const withRejectingTimeout = (task, timeoutMs, message) => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    error ? reject(error) : resolve(value);
  };
  const timer = setTimeout(() => finish(Error(message)), Math.max(1,
    Number(timeoutMs) || DEFAULT_DIAGNOSTIC_ACCESS_TIMEOUT));
  Promise.resolve().then(task).then(value => finish(null, value), error => finish(error));
});

const respondAsync = (task, sendResponse) => {
  const send = payload => {
    try {
      sendResponse(payload);
    }
    catch (e) {}
  };

  Promise.resolve().then(task).then(value => send({
    ok: true,
    value
  }), error => send({
    ok: false,
    error: error && error.message ? error.message : String(error)
  }));

  // Keep the runtime message channel (and MV3 worker) alive until task settles.
  return true;
};

const authorizePopupRequest = async (request, query) => {
  const pinnedWindow = Number.isInteger(request?.windowId);
  const tabs = await query(pinnedWindow ? {
    active: true,
    windowId: request.windowId,
    windowType: 'normal'
  } : {
    active: true,
    currentWindow: true,
    windowType: 'normal'
  });
  if (tabs.length === 0) {
    throw Error('No active tab is available');
  }
  if (Number.isInteger(request?.tabId) && tabs[0].id !== request.tabId) {
    throw Error('The popup target changed before the command could run');
  }
  const tab = tabs[0];
  return {
    request: {
      ...request,
      // Popup input is not an authority in Chromium's spanning-incognito
      // mode. Only the worker's active Tabs.Tab decides whether diagnostics
      // may enter durable storage.
      incognito: tab.incognito === true,
      tabId: tab.id,
      ...(Number.isInteger(tab.windowId) && {windowId: tab.windowId})
    },
    tab
  };
};

const authorizePopupPageRequest = async (request, sender, {
  expectedExtensionId = globalThis.chrome?.runtime?.id,
  expectedPopupUrl = globalThis.chrome?.runtime?.getURL?.('data/popup/index.html'),
  query
} = {}) => {
  if (typeof expectedExtensionId !== 'string' || expectedExtensionId.length === 0 ||
      typeof expectedPopupUrl !== 'string' || expectedPopupUrl.length === 0 ||
      sender?.id !== expectedExtensionId || sender?.url !== expectedPopupUrl) {
    throw Error('Popup sender is not authorized');
  }
  if (typeof query !== 'function') throw Error('Popup authorization is unavailable');
  return authorizePopupRequest(request, query);
};

const authorizePopupNavigationRequest = (request, sender, options) => {
  if (!['close', 'move-next', 'move-previous'].includes(request?.method) ||
      !Number.isInteger(request?.tabId) || !Number.isInteger(request?.windowId)) {
    throw Error('Popup navigation context is incomplete');
  }
  return authorizePopupPageRequest(request, sender, options);
};

const validatePopupTargetIds = (ids, tabs, {maxTargets = 10_000} = {}) => {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > maxTargets || !Array.isArray(tabs)) {
    throw Error('Popup target scope is invalid');
  }
  const available = new Map(tabs
    .filter(tab => Number.isSafeInteger(tab?.id) && tab.id >= 0)
    .map(tab => [tab.id, tab]));
  const selected = [];
  const seen = new Set();
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < 0 || seen.has(id) || !available.has(id)) {
      throw Error('Popup target scope changed');
    }
    seen.add(id);
    selected.push(available.get(id));
  }
  return selected;
};

const dispatchPopup = async (request, query, onClicked, diagnostic) => {
  const authorized = await authorizePopupRequest(request, query);
  const value = await onClicked({
    menuItemId: authorized.request.cmd,
    value: authorized.request.value,
    checked: authorized.request.checked,
    shiftKey: authorized.request.shiftKey,
    progress: authorized.request.progress,
    // This capability is created by the worker after popup authorization. A
    // page-supplied `diagnostic` property is deliberately never forwarded.
    diagnostic
  }, authorized.tab);

  return value === undefined ? true : value;
};

const filterPopupTakeoverSnapshot = (snapshot, selected) => (Array.isArray(snapshot) ? snapshot : [])
  .filter(job => tabInAllowedWindowScope(job?.tab, selected, {requireExplicit: true}));

const authorizeDiagnosticAccess = async (request, sender, {
  expectedExtensionId = globalThis.chrome?.runtime?.id,
  expectedOptionsUrl = globalThis.chrome?.runtime?.getURL?.('data/options/index.html'),
  expectedPopupUrl = globalThis.chrome?.runtime?.getURL?.('data/popup/index.html'),
  query,
  resolveWindowScopedTab,
  timeoutMs = DEFAULT_DIAGNOSTIC_ACCESS_TIMEOUT
} = {}) => {
  const trustedPopup = typeof expectedExtensionId === 'string' && expectedExtensionId.length > 0 &&
    typeof expectedPopupUrl === 'string' && expectedPopupUrl.length > 0 &&
    sender?.id === expectedExtensionId && sender?.url === expectedPopupUrl;
  const trustedOptions = typeof expectedExtensionId === 'string' && expectedExtensionId.length > 0 &&
    typeof expectedOptionsUrl === 'string' && expectedOptionsUrl.length > 0 &&
    sender?.id === expectedExtensionId && sender?.url === expectedOptionsUrl;
  if (trustedOptions) {
    return authorizeOptionsPageRequest(sender, {expectedExtensionId, expectedOptionsUrl});
  }
  if (!trustedPopup) throw Error('Diagnostic sender is not authorized');
  if (!Number.isInteger(request?.tabId) || !Number.isInteger(request?.windowId)) {
    // The popup document is shared by regular and private windows in Chromium
    // spanning mode. Without both identities there is no safe fallback side.
    throw Error('Diagnostic popup context is incomplete');
  }
  if (typeof query !== 'function' || typeof resolveWindowScopedTab !== 'function') {
    throw Error('Diagnostic popup authorization is unavailable');
  }
  const selected = await withRejectingTimeout(async () => {
    const {tab} = await authorizePopupRequest(request, query);
    return resolveWindowScopedTab(tab);
  }, timeoutMs, 'Diagnostic popup authorization timed out');
  return selected?.incognito === true ? privateDiagnosticAccess() : durableDiagnosticAccess();
};

export {
  authorizeDiagnosticAccess,
  authorizeOptionsPageRequest,
  authorizePopupNavigationRequest,
  authorizePopupPageRequest,
  authorizePopupRequest,
  DEFAULT_DIAGNOSTIC_ACCESS_TIMEOUT,
  dispatchPopup,
  filterPopupTakeoverSnapshot,
  respondAsync,
  validatePopupTargetIds
};
