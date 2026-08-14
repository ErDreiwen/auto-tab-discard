import {tabInAllowedWindowScope} from './window-scope.mjs';

const DEFAULT_DIAGNOSTIC_ACCESS_TIMEOUT = 2000;
const durableDiagnosticAccess = () => ({
  clearDurable: true,
  clearPrivate: false,
  includeDurable: true,
  includePrivate: false
});

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

const dispatchPopup = async (request, query, onClicked) => {
  const authorized = await authorizePopupRequest(request, query);
  const value = await onClicked({
    menuItemId: authorized.request.cmd,
    value: authorized.request.value,
    checked: authorized.request.checked,
    shiftKey: authorized.request.shiftKey,
    progress: authorized.request.progress
  }, authorized.tab);

  return value === undefined ? true : value;
};

const filterPopupTakeoverSnapshot = (snapshot, selected) => (Array.isArray(snapshot) ? snapshot : [])
  .filter(job => tabInAllowedWindowScope(job?.tab, selected, {requireExplicit: true}));

const authorizeDiagnosticAccess = async (request, sender, {
  expectedExtensionId = globalThis.chrome?.runtime?.id,
  expectedPopupUrl = globalThis.chrome?.runtime?.getURL?.('data/popup/index.html'),
  query,
  resolveWindowScopedTab,
  timeoutMs = DEFAULT_DIAGNOSTIC_ACCESS_TIMEOUT
} = {}) => {
  const trustedPopup = typeof expectedExtensionId === 'string' && expectedExtensionId.length > 0 &&
    typeof expectedPopupUrl === 'string' && expectedPopupUrl.length > 0 &&
    sender?.id === expectedExtensionId && sender?.url === expectedPopupUrl;
  if (!trustedPopup) {
    // Options and other extension pages may inspect only the durable regular
    // journal. Private incidents never participate in this fallback.
    return durableDiagnosticAccess();
  }
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
  const privateContext = selected?.incognito === true;
  return {
    clearDurable: !privateContext,
    clearPrivate: privateContext,
    includeDurable: !privateContext,
    includePrivate: privateContext
  };
};

export {
  authorizeDiagnosticAccess,
  authorizePopupRequest,
  DEFAULT_DIAGNOSTIC_ACCESS_TIMEOUT,
  dispatchPopup,
  filterPopupTakeoverSnapshot,
  respondAsync
};
