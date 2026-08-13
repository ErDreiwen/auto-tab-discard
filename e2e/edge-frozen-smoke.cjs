#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {createHash, randomUUID} = require('node:crypto');

const SCRIPT_DIR = __dirname;
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_EXTENSION = path.join(SCRIPT_DIR, '..', 'v3');
const DEFAULT_PROFILE_ROOT = path.join(SCRIPT_DIR, '.profiles');
const DEFAULT_RESULTS_ROOT = path.join(SCRIPT_DIR, 'results');
const RESULT_FILE = 'edge-frozen-smoke.json';
const DWELL_MS = 3000;
const FOCUS_SETTLE_MS = 500;
const CONTROL_CLOSE_QUIET_MS = 2000;
const GROUP_FIXTURE_KEYS = [
  // Keep protected outside peers before the active grouped root. The blank
  // helper is inserted at the root index, so those peers retain their exact
  // pre-command indices while the helper safely takes focus.
  'group-out-loaded',
  'group-out-external',
  'group-keeper',
  'group-selected',
  'group-loaded',
  'group-external'
];
const NO_HELPER_FIXTURE_KEYS = [
  'no-helper-root',
  'no-helper-loaded',
  'no-helper-frozen',
  'no-helper-external'
];

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const withTimeout = (promise, milliseconds, message) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error(message)), milliseconds);
  Promise.resolve(promise).then(value => {
    clearTimeout(timer);
    resolve(value);
  }, error => {
    clearTimeout(timer);
    reject(error);
  });
});

const classifyTakeoverFailure = value => {
  const message = String(value || '');
  if (/timed out waking/i.test(message)) return 'wake-timeout';
  if (/did not wake as a quiescent/i.test(message)) return 'wake-not-quiescent';
  if (/timed out stopping|cannot stop the reload/i.test(message)) return 'reload-stop-failed';
  if (/timed out preparing|cannot prepare the awakened/i.test(message)) return 'marker-preparation-failed';
  if (/did not expose its prepared sleep title/i.test(message)) return 'marker-title-unavailable';
  if (/native discard timed out/i.test(message)) return 'native-discard-timeout';
  if (/native discard did not settle/i.test(message)) return 'native-discard-unsettled';
  if (/another discarder won/i.test(message)) return 'native-discard-contended';
  if (/ownership finalization|woke during ownership/i.test(message)) return 'ownership-finalization-failed';
  if (/became stale/i.test(message)) return 'ownership-stale';
  if (/cancelled/i.test(message)) return 'cancelled';
  return 'other-takeover-failure';
};

const waitFor = async (probe, message, timeout = 15000, interval = 100) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) {
        return value;
      }
    }
    catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw lastError || Error(message);
};

const ensure = (condition, message) => {
  if (!condition) {
    throw Error(message);
  }
};

const isExactVisibilityPulse = evidence => Array.isArray(evidence?.visibilityTransitions) &&
  evidence.visibilityTransitions.length === 2 &&
  evidence.visibilityTransitions[0] === 'visible' &&
  evidence.visibilityTransitions[1] === 'hidden';

const classifyFocusEvents = (
  events,
  expectedFocusedWindowId,
  baselineExpectedWindowFocused,
  noFocusedWindowId,
  checkpointAt = 0
) => {
  let focusedWindowId = baselineExpectedWindowFocused ? expectedFocusedWindowId : noFocusedWindowId;
  let actualFocusTransitions = 0;
  let ambientFocusLosses = 0;
  let duplicateFocusedWindowNotifications = 0;
  const rawFocusEvents = (Array.isArray(events) ? events : []).map(event => {
    let classification;
    if (event.windowId === focusedWindowId) {
      if (event.windowId === expectedFocusedWindowId) {
        duplicateFocusedWindowNotifications += 1;
        classification = 'duplicate-expected-window';
      }
      else if (event.windowId === noFocusedWindowId) {
        classification = 'duplicate-no-focused-window';
      }
      else {
        classification = 'duplicate-other-window';
      }
    }
    else {
      actualFocusTransitions += 1;
      focusedWindowId = event.windowId;
      if (event.windowId === noFocusedWindowId) {
        ambientFocusLosses += 1;
        classification = 'focus-lost';
      }
      else if (event.windowId === expectedFocusedWindowId) {
        classification = 'expected-window-focused';
      }
      else {
        classification = 'other-window-focused';
      }
    }
    return {
      classification,
      offsetMilliseconds: Math.max(0, Math.round(Number(event.at || 0) - Number(checkpointAt || 0)))
    };
  });
  return {
    actualFocusTransitions,
    ambientFocusLosses,
    browserFocusChanges: actualFocusTransitions,
    duplicateFocusedWindowNotifications,
    finalExpectedWindowFocused: focusedWindowId === expectedFocusedWindowId,
    rawFocusEvents
  };
};

// Windows can remove OS focus from Edge (for example when the automation host
// itself becomes foreground). That is not a transfer to another browser
// window and cannot be attributed to a tab command. Accept it only when
// independent live reads agree that no normal Edge window is focused and the
// exact tested window remains the last-focused identity.
const classifyDwellFocusState = (state, {requireCurrentMatched = true} = {}) => {
  const currentFocusedMatches = !requireCurrentMatched ||
    (state?.currentMatched === true && state.currentFocused === true);
  const currentUnfocusedMatches = !requireCurrentMatched ||
    (state?.currentMatched === true && state.currentFocused === false);
  const exactFocused = state?.exactFocused === true && currentFocusedMatches &&
    state.lastFocusedIdMatched === true && state.lastFocusedFocused === true &&
    Number(state.focusedNormalWindowCount) === 1;
  const ambientOsFocusLoss = state?.exactFocused === false && currentUnfocusedMatches &&
    state.lastFocusedIdMatched === true && state.lastFocusedFocused === false &&
    Number(state.focusedNormalWindowCount) === 0;
  return {
    ambientOsFocusLoss,
    currentFocused: state?.currentFocused === true,
    currentMatched: state?.currentMatched === true,
    exactFocused: state?.exactFocused === true,
    exactNormal: state?.exactNormal === true,
    exactTypeNormal: state?.exactTypeNormal === true,
    focusMode: exactFocused ? 'exact-focused' :
      ambientOsFocusLoss ? 'ambient-os-unfocused' : 'invalid',
    focusedNormalWindowCount: Number(state?.focusedNormalWindowCount || 0),
    lastFocusedIdMatched: state?.lastFocusedIdMatched === true,
    lastFocusedFocused: state?.lastFocusedFocused === true,
    normalWindowCount: Number(state?.normalWindowCount || 0),
    valid: (exactFocused || ambientOsFocusLoss) && state?.exactNormal === true &&
      state?.exactTypeNormal === true
  };
};

// A command-period focus loss is acceptable only as one exact transition from
// the proven fixture window to WINDOW_ID_NONE. Independent live reads must then
// prove either that Edge remains wholly OS-unfocused or that the exact fixture
// window is again the sole focused/last-focused Edge window. The latter is
// reported as a coalesced exact return, never as zero transitions. Any observed
// return, duplicate transition, or different browser window remains a failure.
const classifyCommandFocusState = (
  summary,
  state,
  {requireCurrentMatched = true} = {}
) => {
  const live = classifyDwellFocusState(state, {requireCurrentMatched});
  const rawFocusEvents = Array.isArray(summary?.rawFocusEvents) ? summary.rawFocusEvents : [];
  const exactFocused = Number(summary?.actualFocusTransitions || 0) === 0 &&
    summary?.finalExpectedWindowFocused === true &&
    live.focusMode === 'exact-focused';
  const ambientOsFocusLoss = Number(summary?.actualFocusTransitions || 0) === 1 &&
    Number(summary?.ambientFocusLosses || 0) === 1 &&
    summary?.finalExpectedWindowFocused === false &&
    rawFocusEvents.length === 1 && rawFocusEvents[0]?.classification === 'focus-lost' &&
    live.focusMode === 'ambient-os-unfocused';
  const coalescedExactReturn = Number(summary?.actualFocusTransitions || 0) === 1 &&
    Number(summary?.ambientFocusLosses || 0) === 1 &&
    summary?.finalExpectedWindowFocused === false &&
    rawFocusEvents.length === 1 && rawFocusEvents[0]?.classification === 'focus-lost' &&
    live.focusMode === 'exact-focused';
  return {
    ...live,
    coalescedExactReturn,
    focusMode: exactFocused ? 'exact-focused' :
      ambientOsFocusLoss ? 'ambient-os-unfocused' :
        coalescedExactReturn ? 'coalesced-exact-return' : 'invalid',
    valid: exactFocused || ambientOsFocusLoss || coalescedExactReturn
  };
};

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const safeMessage = error => String(error?.message || error || 'unknown failure')
  .replace(new RegExp(escapeRegExp(WORKSPACE_ROOT), 'gi'), '<workspace>')
  .replace(/[A-Z]:[\\/][^"'\r\n]*?[\\/]edge-frozen-smoke-\d+-\d+/gi, '<isolated-profile>')
  .replace(/\/(?:[^\s"']+\/)*edge-frozen-smoke-\d+-\d+/gi, '<isolated-profile>')
  .replace(/[A-Z]:[\\/]Users[\\/][^\\/\s]+/gi, '<user-path>')
  .replace(/\/(?:Users|home)\/[^/\s]+/gi, '<user-path>')
  .replace(/(?:chrome|edge)-extension:\/\/[^/\s"')]+/gi, 'extension://<redacted>')
  .replace(/https?:\/\/127\.0\.0\.1:\d+\/frozen-smoke\/[^\s"')]+/gi, '<fixture-url>')
  .replace(/\b(?:https?|ws):\/\/(?:127\.0\.0\.1|localhost):\d+(?:\/[^\s"')\]]*)?/gi,
    '<loopback-url>')
  .replace(/\b(?:127\.0\.0\.1|localhost):\d+\b/gi, '<loopback-endpoint>')
  .replace(/edge-frozen-smoke-\d+-\d+/gi, '<isolated-profile>')
  .replace(/("(?:id|tabId|windowId|addedId|removedId)"\s*:\s*)-?\d+/gi, '$1"<redacted>"')
  .replace(/\b(tab(?:\s+with)?\s+id\s*[:=]?\s*)-?\d+\b/gi, '$1<redacted>')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
    '<token>');

const sanitize = value => {
  if (typeof value === 'string') {
    return safeMessage(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]));
  }
  return value;
};

const summarizeSnapshot = snapshot => snapshot ? {
  active: snapshot.active === true,
  autoDiscardable: snapshot.autoDiscardable !== false,
  discarded: snapshot.discarded === true,
  found: snapshot.found === true,
  frozen: snapshot.frozen === true,
  markerState: snapshot.markerState || null,
  ownershipOnlyCurrent: snapshot.ownershipOnlyCurrent === true,
  source: snapshot.source || null,
  status: snapshot.status || null,
  titleMarked: snapshot.titleMarked === true,
  visualComplete: snapshot.visualComplete === true,
  visualFavicon: snapshot.visualFavicon === true,
  visualPhysicalOnly: snapshot.visualPhysicalOnly === true,
  visualRepair: snapshot.visualRepair === true,
  visualTitle: snapshot.visualTitle === true,
  visualTitleConfigured: snapshot.visualTitleConfigured === true
} : null;

const summarizeActivity = summary => summary ? {
  actualFocusTransitions: Number(summary.actualFocusTransitions || 0),
  ambientFocusLosses: Number(summary.ambientFocusLosses || 0),
  awakeEpisodes: Number(summary.awakeEpisodes || 0),
  browserFocusChanges: Number(summary.browserFocusChanges || 0),
  duplicateFocusedWindowNotifications: Number(summary.duplicateFocusedWindowNotifications || 0),
  driverReactivations: Number(summary.driverReactivations || 0),
  eventCount: Number(summary.eventCount || 0),
  finalExpectedWindowFocused: summary.finalExpectedWindowFocused === true,
  focusChanges: Number(summary.focusChanges || 0),
  loadingSignals: Number(summary.loadingSignals || 0),
  rawFocusEvents: Array.isArray(summary.rawFocusEvents) ? summary.rawFocusEvents.map(event => ({
    classification: String(event?.classification || 'unknown'),
    offsetMilliseconds: Number(event?.offsetMilliseconds || 0)
  })) : [],
  targetActivations: Number(summary.targetActivations || 0)
} : null;

const summarizeGroupActivity = summary => summary ? {
  actualFocusTransitions: Number(summary.actualFocusTransitions || 0),
  ambientFocusLosses: Number(summary.ambientFocusLosses || 0),
  duplicateFocusedWindowNotifications: Number(summary.duplicateFocusedWindowNotifications || 0),
  externalActivations: Number(summary.externalActivations || 0),
  finalExpectedWindowFocused: summary.finalExpectedWindowFocused === true,
  focusChanges: Number(summary.focusChanges || 0),
  helperActivations: Number(summary.helperActivations || 0),
  externalAwakeEpisodes: Number(summary.externalAwakeEpisodes || 0),
  loadingSignals: Number(summary.loadingSignals || 0),
  protectedActivations: Number(summary.protectedActivations || 0),
  protectedEventCount: Number(summary.protectedEventCount || 0),
  rawFocusEvents: Array.isArray(summary.rawFocusEvents) ? summary.rawFocusEvents.map(event => ({
    classification: String(event?.classification || 'unknown'),
    offsetMilliseconds: Number(event?.offsetMilliseconds || 0)
  })) : [],
  selectedActivations: Number(summary.selectedActivations || 0),
  targetActivations: Number(summary.targetActivations || 0),
  targetEventCount: Number(summary.targetEventCount || 0),
  wakeSignals: Number(summary.wakeSignals || 0)
} : null;

const summarizeGroupSnapshot = snapshot => snapshot ? {
  candidateCount: Number(snapshot.candidateCount || 0),
  candidateRoles: Array.isArray(snapshot.candidateRoles) ?
    snapshot.candidateRoles.map(role => String(role)) : [],
  helperCount: Number(snapshot.helperCount || 0),
  helperRegistryEntryCount: Number(snapshot.helperRegistryEntryCount || 0),
  helperTransactionCount: Number(snapshot.helperTransactionCount || 0),
  helpers: Array.isArray(snapshot.helpers) ? snapshot.helpers.map(helper => ({
    active: helper?.active === true,
    discarded: helper?.discarded === true,
    frozen: helper?.frozen === true,
    registered: helper?.registered === true,
    status: helper?.status || null,
    windowMatched: helper?.windowMatched === true
  })) : [],
  ownershipExact: snapshot.ownershipExact === true,
  tabCount: Number(snapshot.tabCount || 0),
  tabs: snapshot.tabs ? Object.fromEntries(Object.entries(snapshot.tabs).map(([key, tab]) => [key, {
    active: tab?.active === true,
    discarded: tab?.discarded === true,
    frozen: tab?.frozen === true,
    groupMatched: tab?.groupMatched === true,
    highlighted: tab?.highlighted === true,
    idMatched: tab?.idMatched === true,
    indexMatched: tab?.indexMatched === true,
    markerState: tab?.markerState || null,
    pinned: tab?.pinned === true,
    source: tab?.source || null,
    status: tab?.status || null,
    titleMarked: tab?.titleMarked === true,
    urlMatched: tab?.urlMatched === true,
    visualComplete: tab?.visualComplete === true,
    visualFavicon: tab?.visualFavicon === true,
    visualPhysicalOnly: tab?.visualPhysicalOnly === true,
    visualRepair: tab?.visualRepair === true,
    visualTitle: tab?.visualTitle === true,
    visualTitleConfigured: tab?.visualTitleConfigured === true
  }])) : {},
  targetGroupCount: Number(snapshot.targetGroupCount || 0),
  unknownCandidateCount: Number(snapshot.unknownCandidateCount || 0)
} : null;

const extensionTree = root => {
  const entries = [];
  const visit = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) {
        entries.push({path: safeMessage(relative), type: 'directory'});
        visit(path.join(directory, entry.name), relative);
      }
      else {
        entries.push({path: safeMessage(relative), type: entry.isFile() ? 'file' : 'other'});
      }
    }
  };
  visit(root);
  return entries;
};

// Match scripts/archive-inventory.mjs exactly: binary path ordering, followed
// by path NUL, raw file bytes, and NUL for every regular file.
const extensionTreeSha256 = root => {
  const entries = [];
  const visit = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute, relative);
      }
      else if (entry.isFile()) {
        entries.push({data: fs.readFileSync(absolute), path: relative});
      }
      else {
        throw Error(`Extension tree contains a non-file entry: ${safeMessage(relative)}`);
      }
    }
  };
  visit(root);
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.path, 'utf8');
    hash.update('\0');
    hash.update(entry.data);
    hash.update('\0');
  }
  return hash.digest('hex');
};

class CdpConnection {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.eventListeners = new Set();
    this.closed = false;
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, {once: true});
      this.socket.addEventListener('error', () => reject(Error('CDP WebSocket failed to open')), {once: true});
    });
    this.socket.addEventListener('message', event => this.onMessage(event));
    this.socket.addEventListener('close', () => this.onClose());
    this.socket.addEventListener('error', () => {});
  }

  onMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    }
    catch (error) {
      return;
    }
    if (!message.id) {
      for (const listener of this.eventListeners) {
        try {
          listener(message);
        }
        catch (error) {
          // A diagnostic listener cannot interrupt CDP command delivery.
        }
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(Error(`CDP command failed: ${pending.method}`));
    }
    else {
      pending.resolve(message.result || {});
    }
  }

  onClose() {
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(Error('CDP connection closed'));
    }
    this.pending.clear();
  }

  async send(method, params = {}, sessionId) {
    await this.ready;
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      throw Error('CDP connection is not open');
    }
    const id = ++this.id;
    const payload = {id, method, params};
    if (sessionId) {
      payload.sessionId = sessionId;
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, {method, reject, resolve});
      try {
        this.socket.send(JSON.stringify(payload));
      }
      catch (error) {
        this.pending.delete(id);
        reject(Error(`CDP command could not be sent: ${method}`));
      }
    });
  }

  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  close() {
    if (!this.closed) {
      this.socket.close();
    }
  }
}

const evaluate = async (cdp, sessionId, expression, timeout = 15000, stage = 'CDP evaluation') => {
  const response = await withTimeout(cdp.send('Runtime.evaluate', {
    awaitPromise: true,
    expression,
    returnByValue: true,
    userGesture: true
  }, sessionId), timeout, `${stage} timed out`);
  if (response.exceptionDetails) {
    throw Error(`${stage} failed`);
  }
  return response.result?.value;
};

const attachPage = async (cdp, targetId) => {
  const {sessionId} = await cdp.send('Target.attachToTarget', {
    flatten: true,
    targetId
  });
  ensure(sessionId, 'CDP did not create a page session');
  await cdp.send('Runtime.enable', {}, sessionId);
  return sessionId;
};

const startFixture = async () => {
  const token = randomUUID();
  const pathname = `/frozen-smoke/${token}`;
  const urls = {};
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const current = new URL(request.url, 'http://127.0.0.1');
    if (!current.pathname.startsWith(`${pathname}/`)) {
      response.writeHead(404, {'Content-Type': 'text/plain'});
      response.end('not found');
      return;
    }
    const key = current.pathname.slice(pathname.length + 1);
    if (!['combined', 'favicon-only', ...GROUP_FIXTURE_KEYS, ...NO_HELPER_FIXTURE_KEYS].includes(key)) {
      response.writeHead(404, {'Content-Type': 'text/plain'});
      response.end('not found');
      return;
    }
    requests.push({at: Date.now(), key});
    response.writeHead(200, {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Content-Type': 'text/html; charset=utf-8',
      'Expires': '0',
      'Pragma': 'no-cache'
    });
    response.end(`<!doctype html>
      <meta charset="utf-8">
      <title>Edge frozen smoke ${key} ${token}</title>
      <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%233267d6'/%3E%3C/svg%3E">
      <h1>Frozen tab fixture</h1>
      <script>
        globalThis.fixtureMemory = new Uint8Array(8 * 1024 * 1024);
        setInterval(() => globalThis.fixtureHeartbeat = Date.now(), 250);
        (() => {
          const evidence = {
            blurEvents: 0,
            focusEvents: 0,
            mediaEvents: 0,
            pictureInPictureEvents: 0,
            visibilityTransitions: []
          };
          const publish = () => {
            document.documentElement.dataset.autoTabDiscardPulseEvidence = JSON.stringify(evidence);
          };
          const snapshot = () => ({
            blurEvents: evidence.blurEvents,
            focusEvents: evidence.focusEvents,
            mediaEvents: evidence.mediaEvents,
            pictureInPictureEvents: evidence.pictureInPictureEvents,
            visibilityTransitions: [...evidence.visibilityTransitions]
          });
          globalThis.__autoTabDiscardPulseCheckpoint = () => {
            const before = snapshot();
            evidence.blurEvents = 0;
            evidence.focusEvents = 0;
            evidence.mediaEvents = 0;
            evidence.pictureInPictureEvents = 0;
            evidence.visibilityTransitions = [];
            publish();
            return {
              after: snapshot(),
              before,
              finalFocused: document.hasFocus() === true,
              finalVisibility: document.visibilityState
            };
          };
          document.addEventListener('visibilitychange', () => {
            evidence.visibilityTransitions.push(document.visibilityState);
            evidence.visibilityTransitions = evidence.visibilityTransitions.slice(-8);
            publish();
          });
          window.addEventListener('focus', () => {
            evidence.focusEvents += 1;
            publish();
          });
          window.addEventListener('blur', () => {
            evidence.blurEvents += 1;
            publish();
          });
          for (const name of ['play', 'playing', 'volumechange']) {
            document.addEventListener(name, () => {
              evidence.mediaEvents += 1;
              publish();
            }, true);
          }
          document.addEventListener('enterpictureinpicture', () => {
            evidence.pictureInPictureEvents += 1;
            publish();
          }, true);
          publish();
        })();
      </script>`);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  for (const key of ['combined', 'favicon-only', ...GROUP_FIXTURE_KEYS, ...NO_HELPER_FIXTURE_KEYS]) {
    urls[key] = `http://127.0.0.1:${address.port}${pathname}/${key}`;
  }
  return {
    count: key => key ? requests.filter(request => request.key === key).length : requests.length,
    stop: () => new Promise((resolve, reject) => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close(error => error ? reject(error) : resolve());
    }),
    url: urls.combined,
    urls
  };
};

const childExitState = child => {
  if (!child || (child.exitCode === null && child.signalCode === null)) {
    return null;
  }

  return {
    code: child.exitCode,
    signal: child.signalCode
  };
};

const waitForChildExit = (child, timeout) => {
  const existing = childExitState(child);
  if (!child || existing) {
    return Promise.resolve(existing);
  }
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        child.removeListener('exit', onExit);
        resolve(value);
      }
    };
    const onExit = (code, signal) => finish({code, signal});
    const timer = setTimeout(() => finish(null), timeout);
    child.once('exit', onExit);
  });
};

const killProcessTree = child => {
  if (!child || !Number.isInteger(child.pid) || childExitState(child)) {
    return {issued: false, status: null};
  }
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
    if (result.error) {
      throw Error(`The exact Edge process tree could not be killed: ${safeMessage(result.error)}`);
    }
    return {issued: result.status === 0, status: result.status};
  }
  const issued = child.kill('SIGKILL');
  if (!issued) {
    throw Error('The exact Edge child rejected SIGKILL');
  }
  return {issued: true, status: 0};
};

const assertExactChildExit = (exit, forced, platform = process.platform) => {
  ensure(exit, 'The exact Edge child did not exit');
  if (forced) {
    if (platform === 'win32') {
      ensure(exit.code === 1 && exit.signal === null,
        `The forced Edge child exit was not exact (code ${exit.code}, signal ${exit.signal})`);
    }
    else {
      ensure(exit.code === null && exit.signal === 'SIGKILL',
        `The forced Edge child exit was not exact (code ${exit.code}, signal ${exit.signal})`);
    }
  }
  else {
    ensure(exit.code === 0 && exit.signal === null,
      `The graceful Edge child exit was not exact (code ${exit.code}, signal ${exit.signal})`);
  }
};

const terminateBrowser = async (child, cdp) => {
  const spawned = Boolean(child && Number.isInteger(child.pid));
  const result = {
    attempted: Boolean(spawned || cdp),
    cdpClosed: false,
    closeRequested: false,
    exitAsserted: false,
    failures: [],
    forceRequestStatus: null,
    forced: false,
    exit: childExitState(child)
  };
  const failures = [];
  if (cdp && !cdp.closed) {
    try {
      await withTimeout(cdp.send('Browser.close'), 3000, 'Browser.close timed out');
      result.closeRequested = true;
    }
    catch (error) {
      failures.push(error);
    }
  }
  if (spawned) {
    let exit = await waitForChildExit(child, 5000);
    if (!exit) {
      try {
        const kill = killProcessTree(child);
        result.forced = kill.issued;
        result.forceRequestStatus = kill.status;
        exit = await waitForChildExit(child, 5000);
        ensure(kill.issued || exit,
          `The exact Edge process-tree kill failed (task status ${kill.status})`);
      }
      catch (error) {
        failures.push(error);
      }
    }
    result.exit = exit || childExitState(child);
    try {
      assertExactChildExit(result.exit, result.forced);
      result.exitAsserted = true;
    }
    catch (error) {
      failures.push(error);
    }
  }
  try {
    cdp?.close();
    result.cdpClosed = !cdp || cdp.closed === true || cdp.socket?.readyState === WebSocket.CLOSING ||
      cdp.socket?.readyState === WebSocket.CLOSED;
  }
  catch (error) {
    failures.push(error);
  }
  if (failures.length) {
    result.failures = failures.map(safeMessage);
    const error = new AggregateError(failures,
      `Edge browser cleanup failed: ${result.failures.join('; ')}`);
    error.cleanup = result;
    throw error;
  }
  return result;
};

const findCrashCount = root => {
  let count = 0;
  const visit = directory => {
    if (!fs.existsSync(directory)) {
      return;
    }
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target);
      }
      else if (/\.(?:dmp|crash)$/i.test(entry.name)) {
        count += 1;
      }
    }
  };
  visit(root);
  return count;
};

const launchEdge = async ({executable, extension, profile}) => {
  const disabledFeatures = [
    'OptimizationHints',
    'MediaRouter',
    'msImplicitSignin',
    'msM365LinksImplicitSignin'
  ];
  const child = spawn(executable, [
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-component-update',
    '--disable-background-mode',
    '--disable-background-networking',
    `--disable-features=${disabledFeatures.join(',')}`,
    '--window-position=20,20',
    '--window-size=1100,800',
    'about:blank'
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: false
  });
  let spawnFailed = false;
  child.once('error', () => spawnFailed = true);
  let stderr = '';
  child.stderr.on('data', chunk => {
    // Retain only a bounded diagnostic buffer and never print it: Edge startup
    // output may include machine-specific values.
    stderr = (stderr + String(chunk)).slice(-64 * 1024);
  });
  let cdp;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    const activePort = await waitFor(() => {
      if (spawnFailed || child.exitCode !== null) {
        throw Error('Edge exited before its isolated CDP endpoint was ready');
      }
      if (!fs.existsSync(portFile)) {
        return false;
      }
      const lines = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
      const port = Number(lines[0]);
      if (!port || !lines[1]) {
        return false;
      }
      return {path: lines[1], port};
    }, 'Edge CDP endpoint did not appear', 20000);
    const websocketUrl = activePort.path.startsWith('ws://') ? activePort.path :
      `ws://127.0.0.1:${activePort.port}${activePort.path}`;
    cdp = new CdpConnection(websocketUrl);
    await withTimeout(cdp.ready, 10000, 'Edge CDP connection timed out');
    return {cdp, child};
  }
  catch (error) {
    // `browser` is assigned only after this function returns. Own every
    // partial-launch failure here so neither Edge nor its isolated profile can
    // outlive a missing DevToolsActivePort or failed WebSocket handshake.
    try {
      error.browserCleanup = await terminateBrowser(child, cdp);
    }
    catch (cleanupFailure) {
      const combined = new AggregateError([error, cleanupFailure],
        `${error.message}; partial Edge launch cleanup also failed`);
      combined.browserCleanup = cleanupFailure.cleanup;
      throw combined;
    }
    throw error;
  }
};

const extensionSnapshotExpression = fixtureUrl => `(async () => {
  const fixtureUrl = ${JSON.stringify(fixtureUrl)};
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find(candidate => candidate.url === fixtureUrl);
  if (!tab) {
    return {found: false};
  }
  const stored = await chrome.storage.session.get(null);
  const prefix = '__discardOwnership:tab:';
  const ownershipKeys = Object.keys(stored).filter(key => key.startsWith(prefix));
  const marker = stored[prefix + tab.id]?.marker;
  return {
    active: tab.active === true,
    autoDiscardable: tab.autoDiscardable !== false,
    discarded: tab.discarded === true,
    found: true,
    frozen: tab.frozen === true,
    id: tab.id,
    markerState: marker && marker.state,
    ownershipOnlyCurrent: ownershipKeys.length === 1 && ownershipKeys[0] === prefix + tab.id,
    source: marker && marker.source,
    status: tab.status,
    visualComplete: marker?.visual?.complete === true,
    visualFavicon: marker?.visual?.favicon === true,
    visualPhysicalOnly: marker?.visual?.physicalOnly === true,
    visualRepair: marker?.visual?.repair === true,
    visualTitle: marker?.visual?.title === true,
    visualTitleConfigured: typeof marker?.visual?.titleMarker === 'string' &&
      marker.visual.titleMarker.length > 0,
    windowId: tab.windowId,
    titleMarked: typeof tab.title === 'string' && tab.title.startsWith('💤')
  };
})()`;

const monitorInstallExpression = `(() => {
  if (globalThis.__edgeFrozenSmoke) {
    return true;
  }
  const state = globalThis.__edgeFrozenSmoke = {
    activations: [],
    events: [],
    focusChanges: [],
    replacements: []
  };
  const compact = tab => tab && ({
    discarded: tab.discarded === true,
    frozen: tab.frozen === true,
    status: tab.status,
    titleMarked: typeof tab.title === 'string' && tab.title.startsWith('💤')
  });
  chrome.tabs.onUpdated.addListener((id, changeInfo, tab) => state.events.push({
    at: performance.now(),
    change: {
      discarded: changeInfo.discarded,
      frozen: changeInfo.frozen,
      status: changeInfo.status
    },
    id,
    tab: compact(tab)
  }));
  chrome.tabs.onActivated.addListener(activeInfo => state.activations.push({
    at: performance.now(),
    tabId: activeInfo.tabId,
    windowId: activeInfo.windowId
  }));
  chrome.tabs.onReplaced.addListener((addedId, removedId) => state.replacements.push({
    addedId,
    at: performance.now(),
    removedId
  }));
  chrome.windows.onFocusChanged.addListener(windowId => state.focusChanges.push({
    at: performance.now(),
    windowId
  }));
  return true;
})()`;

const monitorCheckpointExpression = `(() => ({
  activations: globalThis.__edgeFrozenSmoke.activations.length,
  at: performance.now(),
  events: globalThis.__edgeFrozenSmoke.events.length,
  focusChanges: globalThis.__edgeFrozenSmoke.focusChanges.length,
  replacements: globalThis.__edgeFrozenSmoke.replacements.length
}))()`;

const focusStateExpression = windowId => `(async () => {
  const windowId = ${Number(windowId)};
  const bounded = (operation, label) => Promise.race([
    Promise.resolve(operation),
    new Promise((resolve, reject) => setTimeout(() =>
      reject(Error(label + ' API deadline exceeded')), 3000))
  ]);
  try {
    const [exact, current, lastFocused, normalWindows] = await Promise.all([
      bounded(chrome.windows.get(windowId), 'windows.get'),
      bounded(chrome.windows.getCurrent(), 'windows.getCurrent'),
      bounded(chrome.windows.getLastFocused(), 'windows.getLastFocused'),
      bounded(chrome.windows.getAll({windowTypes: ['normal']}), 'windows.getAll')
    ]);
    return {
      currentFocused: current?.focused === true,
      currentMatched: current?.id === windowId,
      exactFocused: exact?.focused === true,
      exactNormal: exact?.state === 'normal',
      exactTypeNormal: exact?.type === 'normal',
      focusChanges: globalThis.__edgeFrozenSmoke.focusChanges.length,
      focusedNormalWindowCount: normalWindows.filter(window => window.focused === true).length,
      lastFocusedFocused: lastFocused?.focused === true,
      lastFocusedIdMatched: lastFocused?.id === windowId,
      lastFocusedMatched: lastFocused?.id === windowId && lastFocused?.focused === true,
      normalWindowCount: normalWindows.length
    };
  }
  catch (error) {
    return {apiError: String(error?.message || error)};
  }
})()`;

const exactFocusedWindowExpression = windowId => `(async () => {
  const windowId = ${Number(windowId)};
  const bounded = (operation, label) => Promise.race([
    Promise.resolve(operation),
    new Promise((resolve, reject) => setTimeout(() =>
      reject(Error(label + ' API deadline exceeded')), 3000))
  ]);
  try {
    const [exact, lastFocused] = await Promise.all([
      bounded(chrome.windows.get(windowId), 'windows.get'),
      bounded(chrome.windows.getLastFocused(), 'windows.getLastFocused')
    ]);
    return {
      exactFocused: exact?.focused === true,
      exactNormal: exact?.state === 'normal',
      exactTypeNormal: exact?.type === 'normal',
      focusChanges: globalThis.__edgeFrozenSmoke.focusChanges.length,
      lastFocusedMatched: lastFocused?.id === windowId && lastFocused?.focused === true
    };
  }
  catch (error) {
    return {apiError: String(error?.message || error)};
  }
})()`;

const waitForExactFocusedWindowSettlement = async (cdp, sessionId, windowId, stage) => {
  let focusCount;
  let stableSince = 0;
  return waitFor(async () => {
    const state = await evaluate(cdp, sessionId, exactFocusedWindowExpression(windowId), 5000,
      `${stage}: exact focused-window probe`);
    if (state?.apiError) {
      throw Error(`${stage}: ${state.apiError}`);
    }
    const confirmed = state.exactFocused === true && state.exactNormal === true &&
      state.exactTypeNormal === true && state.lastFocusedMatched === true;
    if (!confirmed || state.focusChanges !== focusCount) {
      focusCount = state.focusChanges;
      stableSince = confirmed ? Date.now() : 0;
      return false;
    }
    if (!stableSince) {
      stableSince = Date.now();
      return false;
    }
    const stableMilliseconds = Date.now() - stableSince;
    return stableMilliseconds >= FOCUS_SETTLE_MS ? {...state, stableMilliseconds} : false;
  }, `${stage}: exact window did not become stably focused`, 10000, 100);
};

const setupFocusSummaryExpression = (focusCheckpoint, windowId) => `(() => {
  const events = globalThis.__edgeFrozenSmoke.focusChanges.slice(${Number(focusCheckpoint)});
  return {
    ambientFocusLosses: events.filter(event =>
      event.windowId === chrome.windows.WINDOW_ID_NONE).length,
    eventCount: events.length,
    otherWindowFocusEvents: events.filter(event =>
      event.windowId !== chrome.windows.WINDOW_ID_NONE &&
      event.windowId !== ${Number(windowId)}).length,
    targetFocusEvents: events.filter(event => event.windowId === ${Number(windowId)}).length
  };
})()`;

const waitForFocusedWindowSettlement = async (cdp, sessionId, windowId, stage) => {
  let focusCount;
  let lastState;
  let stableSince = 0;
  try {
    return await waitFor(async () => {
      const state = await evaluate(cdp, sessionId, focusStateExpression(windowId), 5000,
        `${stage}: bounded focus-state probe`);
      lastState = state;
      if (state?.apiError) {
        throw Error(`${stage}: ${state.apiError}`);
      }
      const confirmed = state?.exactFocused === true && state.exactNormal === true &&
        state.exactTypeNormal === true && state.currentMatched === true &&
        state.currentFocused === true && state.lastFocusedMatched === true;
      if (!confirmed || state.focusChanges !== focusCount) {
        focusCount = state?.focusChanges;
        stableSince = confirmed ? Date.now() : 0;
        return false;
      }
      if (!stableSince) {
        stableSince = Date.now();
        return false;
      }
      const stableMilliseconds = Date.now() - stableSince;
      return stableMilliseconds >= FOCUS_SETTLE_MS ? {...state, stableMilliseconds} : false;
    }, `${stage}: exact fixture window did not become stably focused`, 10000, 100);
  }
  catch (error) {
    const diagnostic = lastState && typeof lastState === 'object' ? {
      apiError: lastState.apiError || null,
      currentFocused: lastState.currentFocused === true,
      currentMatched: lastState.currentMatched === true,
      exactFocused: lastState.exactFocused === true,
      exactNormal: lastState.exactNormal === true,
      exactTypeNormal: lastState.exactTypeNormal === true,
      focusChanges: Number(lastState.focusChanges || 0),
      lastFocusedMatched: lastState.lastFocusedMatched === true
    } : null;
    throw Error(`${error.message}; last focus state ${JSON.stringify(diagnostic)}`);
  }
};

const activateSetupKeeperExpression = (driverId, windowId) => `(async () => {
  const driverId = ${Number(driverId)};
  const windowId = ${Number(windowId)};
  try {
    const updated = await Promise.race([
      chrome.tabs.update(driverId, {active: true}),
      new Promise((resolve, reject) => setTimeout(() =>
        reject(Error('tabs.update API deadline exceeded')), 3000))
    ]);
    return {
      active: updated?.active === true,
      windowMatched: updated?.windowId === windowId
    };
  }
  catch (error) {
    return {apiError: String(error?.message || error)};
  }
})()`;

const setupTabStateExpression = (driverId, targetId, windowId) => `(async () => {
  const bounded = (operation, label) => Promise.race([
    Promise.resolve(operation),
    new Promise((resolve, reject) => setTimeout(() =>
      reject(Error(label + ' API deadline exceeded')), 3000))
  ]);
  try {
    const [driver, target] = await Promise.all([
      bounded(chrome.tabs.get(${Number(driverId)}), 'driver tabs.get'),
      bounded(chrome.tabs.get(${Number(targetId)}), 'target tabs.get')
    ]);
    return {
      driverActive: driver?.active === true,
      driverWindowMatched: driver?.windowId === ${Number(windowId)},
      targetActive: target?.active === true,
      targetWindowMatched: target?.windowId === ${Number(windowId)}
    };
  }
  catch (error) {
    return {apiError: String(error?.message || error)};
  }
})()`;

const fixtureDocumentStateExpression = tabId => `(async () => {
  try {
    const entries = await Promise.race([
      chrome.scripting.executeScript({
        func: () => ({
          focused: document.hasFocus() === true,
          visibility: document.visibilityState
        }),
        target: {tabId: ${Number(tabId)}},
        world: 'MAIN'
      }),
      new Promise((resolve, reject) => setTimeout(() =>
        reject(Error('scripting.executeScript API deadline exceeded')), 3000))
    ]);
    return entries?.[0]?.result || null;
  }
  catch (error) {
    return {apiError: String(error?.message || error)};
  }
})()`;

const waitForSetupMonitorSettlement = async (
  cdp,
  sessionId,
  stage,
  settleMilliseconds = FOCUS_SETTLE_MS
) => {
  let signature;
  let stableSince = 0;
  return waitFor(async () => {
    const state = await evaluate(cdp, sessionId, monitorCheckpointExpression, 5000,
      `${stage}: monitor checkpoint`);
    const nextSignature = `${state.activations}:${state.focusChanges}`;
    if (nextSignature !== signature) {
      signature = nextSignature;
      stableSince = Date.now();
      return false;
    }
    const stableMilliseconds = Date.now() - stableSince;
    return stableMilliseconds >= settleMilliseconds ? {...state, stableMilliseconds} : false;
  }, 'The setup activation/focus monitors did not settle', 10000, 100);
};

const pulseCheckpointExpression = tabId => `(async () => {
  try {
    const entries = await Promise.race([
      chrome.scripting.executeScript({
        func: () => globalThis.__autoTabDiscardPulseCheckpoint?.(),
        target: {tabId: ${Number(tabId)}},
        world: 'MAIN'
      }),
      new Promise((resolve, reject) => setTimeout(() =>
        reject(Error('pulse checkpoint API deadline exceeded')), 3000))
    ]);
    return entries?.[0]?.result || null;
  }
  catch (error) {
    return {apiError: String(error?.message || error)};
  }
})()`;

const monitorSummaryExpression = (
  startId,
  eventCheckpoint,
  activationCheckpoint,
  driverId,
  focusCheckpoint = 0,
  expectedFocusedWindowId,
  baselineExpectedWindowFocused = false,
  focusCheckpointAt = 0
) => `(() => {
  const monitor = globalThis.__edgeFrozenSmoke;
  const lineage = new Set([${Number(startId)}]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const replacement of monitor.replacements) {
      if (lineage.has(replacement.removedId) && !lineage.has(replacement.addedId)) {
        lineage.add(replacement.addedId);
        changed = true;
      }
    }
  }
  const events = monitor.events.slice(${Number(eventCheckpoint)}).filter(event => lineage.has(event.id));
  const activations = monitor.activations.slice(${Number(activationCheckpoint)});
  const targetActivationIndexes = activations.map((activation, index) =>
    lineage.has(activation.tabId) ? index : -1).filter(index => index !== -1);
  const firstTargetActivation = targetActivationIndexes[0] ?? -1;
  const driverReactivations = activations.filter((activation, index) =>
    activation.tabId === ${Number(driverId)} && index > firstTargetActivation).length;
  let awake = false;
  let awakeEpisodes = 0;
  let loadingSignals = 0;
  for (const event of events) {
    // A direct native discard legitimately reports frozen:false as the old
    // in-memory renderer is replaced by an unloaded tab. That is a physical
    // conversion, not a wake episode. Loading or discarded:false remain the
    // authoritative wake signals.
    const signal = event.change.status === 'loading' || event.change.discarded === false;
    if (event.change.status === 'loading') {
      loadingSignals += 1;
    }
    if (signal && awake === false) {
      awake = true;
      awakeEpisodes += 1;
    }
    if (event.tab && (event.tab.discarded === true || event.tab.frozen === true)) {
      awake = false;
    }
  }
  const focusChanges = monitor.focusChanges.slice(${Number(focusCheckpoint)});
  const expectedFocusedWindowId = ${Number(expectedFocusedWindowId)};
  const focusSummary = (${classifyFocusEvents.toString()})(
    focusChanges,
    expectedFocusedWindowId,
    ${baselineExpectedWindowFocused === true},
    chrome.windows.WINDOW_ID_NONE,
    ${Number(focusCheckpointAt)}
  );
  return {
    ...focusSummary,
    awakeEpisodes,
    driverReactivations,
    eventCount: events.length,
    focusChanges: focusChanges.length,
    loadingSignals,
    targetActivations: targetActivationIndexes.length
  };
})()`;

const groupSnapshotExpression = layout => `(async () => {
  const layout = ${JSON.stringify(layout)};
  const bounded = (operation, label) => Promise.race([
    Promise.resolve(operation),
    new Promise((resolve, reject) => setTimeout(() =>
      reject(Error(label + ' API deadline exceeded')), 3000))
  ]);
  try {
    const tabs = await bounded(chrome.tabs.query({windowId: layout.windowId}), 'tabs.query');
    const stored = await bounded(chrome.storage.session.get(null), 'storage.session.get');
    const ownershipPrefix = '__discardOwnership:tab:';
    const helperBase = chrome.runtime.getURL('worker/plugins/blank/blank.html');
    const helperRegistry = stored.__blankHelperRegistry || {};
    const byId = new Map(tabs.map(tab => [tab.id, tab]));
    const byUrl = new Map(tabs.map(tab => [tab.url, tab]));
    const currentFor = key => byId.get(layout.tabs[key].id) || byUrl.get(layout.tabs[key].url);
    const targetIds = new Set(layout.targets.map(currentFor).filter(Boolean).map(tab => tab.id));
    const compact = key => {
      const specification = layout.tabs[key];
      const tab = currentFor(key);
      const marker = tab && stored[ownershipPrefix + tab.id]?.marker;
      return tab ? {
        active: tab.active === true,
        discarded: tab.discarded === true,
        frozen: tab.frozen === true,
        groupMatched: tab.groupId === specification.groupId,
        highlighted: tab.highlighted === true,
        idMatched: tab.id === specification.id,
        indexMatched: tab.index === specification.index,
        markerState: marker?.state || null,
        pinned: tab.pinned === true,
        source: marker?.source || null,
        status: tab.status,
        titleMarked: typeof tab.title === 'string' && tab.title.startsWith('\u{1F4A4}'),
        urlMatched: tab.url === specification.url,
        visualComplete: marker?.visual?.complete === true,
        visualFavicon: marker?.visual?.favicon === true,
        visualPhysicalOnly: marker?.visual?.physicalOnly === true,
        visualRepair: marker?.visual?.repair === true,
        visualTitle: marker?.visual?.title === true,
        visualTitleConfigured: marker?.visual?.titleMarker === '\u{1F4A4}'
      } : {found: false};
    };
    const registeredHelperIds = new Set(Object.keys(helperRegistry)
      .filter(key => /^\\d+$/.test(key)).map(Number));
    // The hardened manifest intentionally omits the broad tabs permission.
    // Edge may therefore redact even an extension helper's URL in tabs.query.
    // Production identifies helpers by this registry, so use the same
    // authoritative IDs and retain URL recognition only as a secondary signal.
    const helpers = tabs.filter(tab => registeredHelperIds.has(tab.id) ||
      [tab.url, tab.pendingUrl].some(url =>
        typeof url === 'string' && url.split('#', 1)[0] === helperBase));
    const helperSummaries = helpers.map(tab => ({
      active: tab.active === true,
      discarded: tab.discarded === true,
      frozen: tab.frozen === true,
      registered: helperRegistry[tab.id]?.state === 'committed',
      status: tab.status,
      windowMatched: tab.windowId === layout.windowId
    }));
    const candidates = tabs.filter(tab => targetIds.has(tab.id) === false &&
      helpers.some(helper => helper.id === tab.id) === false &&
      tab.discarded === false && tab.frozen !== true && tab.highlighted === false &&
      tab.status !== 'unloaded');
    const roleFor = tab => Object.keys(layout.tabs).find(key => currentFor(key)?.id === tab.id) || 'unknown';
    const candidateRoles = candidates.map(roleFor).sort();
    const ownershipIds = Object.keys(stored).filter(key => key.startsWith(ownershipPrefix))
      .map(key => Number(key.slice(ownershipPrefix.length))).sort((a, b) => a - b);
    const expectedOwnershipIds = layout.expectedOwnership.map(currentFor).filter(Boolean).map(tab => tab.id)
      .sort((a, b) => a - b);
    return {
      apiError: null,
      candidateCount: candidates.length,
      candidateRoles,
      helperCount: helpers.length,
      helperIds: helpers.map(tab => tab.id),
      helperRegistryEntryCount: Object.keys(helperRegistry)
        .filter(key => /^\\d+$/.test(key)).length,
      helperTransactionCount: Object.keys(helperRegistry.$transactions || {}).length,
      helpers: helperSummaries,
      ownershipExact: ownershipIds.length === expectedOwnershipIds.length &&
        ownershipIds.every((id, index) => id === expectedOwnershipIds[index]),
      resolvedIds: Object.fromEntries(Object.keys(layout.tabs).map(key => [key, currentFor(key)?.id])),
      resolvedIndexes: Object.fromEntries(Object.keys(layout.tabs).map(key => [key, currentFor(key)?.index])),
      tabCount: tabs.length,
      tabs: Object.fromEntries(Object.keys(layout.tabs).map(key => [key, compact(key)])),
      targetGroupCount: tabs.filter(tab => targetIds.has(tab.id) && tab.groupId === layout.groupId).length,
      unknownCandidateCount: candidateRoles.filter(role => role === 'unknown').length
    };
  }
  catch (error) {
    return {apiError: String(error?.message || error)};
  }
})()`;

const groupHelperMonitorInstallExpression = windowId => `(async () => {
  const windowId = ${Number(windowId)};
  const helperBase = chrome.runtime.getURL('worker/plugins/blank/blank.html');
  const isHelper = tab => tab?.windowId === windowId && [tab?.url, tab?.pendingUrl].some(url =>
    typeof url === 'string' && url.split('#', 1)[0] === helperBase);
  if (globalThis.__edgeFrozenGroupHelpers?.windowId === windowId) {
    return true;
  }
  const registryIds = records => new Set(Object.keys(records || {})
    .filter(key => /^\\d+$/.test(key)).map(Number));
  const initialTabs = await chrome.tabs.query({windowId});
  const initialStored = await chrome.storage.session.get('__blankHelperRegistry');
  const initialRegistered = registryIds(initialStored.__blankHelperRegistry);
  const initial = initialTabs.filter(tab => initialRegistered.has(tab.id) || isHelper(tab));
  const state = globalThis.__edgeFrozenGroupHelpers = {
    created: 0,
    current: new Set(initial.map(tab => tab.id)),
    maxConcurrent: initial.length,
    removed: 0,
    windowId
  };
  const observe = tab => {
    if (isHelper(tab) && state.current.has(tab.id) === false) {
      state.current.add(tab.id);
      state.created += 1;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.current.size);
    }
  };
  chrome.tabs.onCreated.addListener(observe);
  chrome.tabs.onUpdated.addListener((id, changeInfo, tab) => observe(tab));
  chrome.tabs.onRemoved.addListener(id => {
    if (state.current.delete(id)) {
      state.removed += 1;
    }
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'session' || !changes.__blankHelperRegistry) {
      return;
    }
    const next = registryIds(changes.__blankHelperRegistry.newValue);
    for (const id of next) {
      if (state.current.has(id) === false) {
        state.current.add(id);
        state.created += 1;
        state.maxConcurrent = Math.max(state.maxConcurrent, state.current.size);
      }
    }
    for (const id of [...state.current]) {
      if (!next.has(id)) {
        state.current.delete(id);
        state.removed += 1;
      }
    }
  });
  return true;
})()`;

const groupHelperMonitorSnapshotExpression = `(() => {
  const state = globalThis.__edgeFrozenGroupHelpers;
  return state ? {
    created: state.created,
    current: state.current.size,
    maxConcurrent: state.maxConcurrent,
    removed: state.removed
  } : null;
})()`;

const groupActivitySummaryExpression = ({
  baselineExpectedWindowFocused = true,
  checkpoint,
  expectedFocusedWindowId,
  externalId,
  helperId,
  protectedIds,
  selectedId,
  targetIds
}) => `(() => {
  const monitor = globalThis.__edgeFrozenSmoke;
  const lineageFor = seed => {
    const lineage = new Set([seed]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const replacement of monitor.replacements) {
        if (lineage.has(replacement.removedId) && !lineage.has(replacement.addedId)) {
          lineage.add(replacement.addedId);
          changed = true;
        }
      }
    }
    return lineage;
  };
  const targetIds = new Set(${JSON.stringify(targetIds)}.flatMap(id => [...lineageFor(id)]));
  const protectedIds = new Set(${JSON.stringify(protectedIds)}.flatMap(id => [...lineageFor(id)]));
  const externalIds = lineageFor(${Number(externalId)});
  const helperIds = lineageFor(${Number(helperId)});
  const selectedIds = lineageFor(${Number(selectedId)});
  const events = monitor.events.slice(${Number(checkpoint.events)});
  const targetEvents = events.filter(event => targetIds.has(event.id));
  const externalEvents = events.filter(event => externalIds.has(event.id));
  const protectedEvents = events.filter(event => protectedIds.has(event.id));
  const activations = monitor.activations.slice(${Number(checkpoint.activations)});
  const focusChanges = monitor.focusChanges.slice(${Number(checkpoint.focusChanges)});
  const focusSummary = (${classifyFocusEvents.toString()})(
    focusChanges,
    ${Number(expectedFocusedWindowId)},
    ${baselineExpectedWindowFocused === true},
    chrome.windows.WINDOW_ID_NONE,
    ${Number(checkpoint.at)}
  );
  const loadingSignals = targetEvents.filter(event => event.change.status === 'loading').length;
  const wakeSignals = targetEvents.filter(event =>
    event.change.status === 'loading' || event.change.discarded === false).length;
  let externalAwake = false;
  let externalAwakeEpisodes = 0;
  for (const event of externalEvents) {
    const signal = event.change.status === 'loading' || event.change.discarded === false;
    if (signal && externalAwake === false) {
      externalAwake = true;
      externalAwakeEpisodes += 1;
    }
    if (event.tab && (event.tab.discarded === true || event.tab.frozen === true)) {
      externalAwake = false;
    }
  }
  return {
    ...focusSummary,
    externalActivations: activations.filter(event => externalIds.has(event.tabId)).length,
    externalAwakeEpisodes,
    focusChanges: focusChanges.length,
    helperActivations: activations.filter(event => helperIds.has(event.tabId)).length,
    loadingSignals,
    protectedActivations: activations.filter(event => protectedIds.has(event.tabId)).length,
    protectedEventCount: protectedEvents.length,
    selectedActivations: activations.filter(event => selectedIds.has(event.tabId)).length,
    targetActivations: activations.filter(event => targetIds.has(event.tabId)).length,
    targetEventCount: targetEvents.length,
    wakeSignals
  };
})()`;

const noHelperActivitySummaryExpression = ({
  baselineExpectedWindowFocused = true,
  checkpoint,
  expectedFocusedWindowId,
  externalId,
  frozenId,
  loadedId,
  rootId,
  targetIds
}) => `(() => {
  const monitor = globalThis.__edgeFrozenSmoke;
  const lineageFor = seed => {
    const lineage = new Set([seed]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const replacement of monitor.replacements) {
        if (lineage.has(replacement.removedId) && !lineage.has(replacement.addedId)) {
          lineage.add(replacement.addedId);
          changed = true;
        }
      }
    }
    return lineage;
  };
  const targetIds = new Set(${JSON.stringify(targetIds)}.flatMap(id => [...lineageFor(id)]));
  const externalIds = lineageFor(${Number(externalId)});
  const frozenIds = lineageFor(${Number(frozenId)});
  const loadedIds = lineageFor(${Number(loadedId)});
  const rootIds = lineageFor(${Number(rootId)});
  const events = monitor.events.slice(${Number(checkpoint.events)});
  const targetEvents = events.filter(event => targetIds.has(event.id));
  const rootEvents = events.filter(event => rootIds.has(event.id));
  const externalEvents = events.filter(event => externalIds.has(event.id));
  const activations = monitor.activations.slice(${Number(checkpoint.activations)});
  const focusChanges = monitor.focusChanges.slice(${Number(checkpoint.focusChanges)});
  const focusSummary = (${classifyFocusEvents.toString()})(
    focusChanges,
    ${Number(expectedFocusedWindowId)},
    ${baselineExpectedWindowFocused === true},
    chrome.windows.WINDOW_ID_NONE,
    ${Number(checkpoint.at)}
  );
  const loadingSignals = targetEvents.filter(event => event.change.status === 'loading').length;
  const wakeSignals = targetEvents.filter(event =>
    event.change.status === 'loading' || event.change.discarded === false).length;
  let externalAwake = false;
  let externalAwakeEpisodes = 0;
  for (const event of externalEvents) {
    const signal = event.change.status === 'loading' || event.change.discarded === false;
    if (signal && externalAwake === false) {
      externalAwake = true;
      externalAwakeEpisodes += 1;
    }
    if (event.tab && (event.tab.discarded === true || event.tab.frozen === true)) {
      externalAwake = false;
    }
  }
  return {
    ...focusSummary,
    externalActivations: activations.filter(event => externalIds.has(event.tabId)).length,
    externalAwakeEpisodes,
    focusChanges: focusChanges.length,
    frozenActivations: activations.filter(event => frozenIds.has(event.tabId)).length,
    loadedActivations: activations.filter(event => loadedIds.has(event.tabId)).length,
    loadingSignals,
    rootActivations: activations.filter(event => rootIds.has(event.tabId)).length,
    rootEventCount: rootEvents.length,
    targetActivations: activations.filter(event => targetIds.has(event.tabId)).length,
    targetEventCount: targetEvents.length,
    wakeSignals
  };
})()`;

const freezeClickExpression = fixtureUrl => `(() => {
  const needle = ${JSON.stringify(fixtureUrl)};
  const deepElements = root => {
    const output = [];
    const visit = node => {
      if (!node) return;
      if (node.nodeType === Node.ELEMENT_NODE) {
        output.push(node);
        if (node.shadowRoot) visit(node.shadowRoot);
      }
      for (const child of node.children || []) visit(child);
    };
    visit(root);
    return output;
  };
  const deepText = root => deepElements(root).map(element => element.childNodes ?
    [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join(' ') : '')
    .join(' ').replace(/\\s+/g, ' ').trim();
  const isFreeze = element => {
    const label = (element.innerText || element.textContent || element.getAttribute?.('aria-label') || '')
      .replace(/[\\[\\]]/g, '').trim().toLowerCase();
    // Edge 150 exposes this action as a clickable DIV, whereas Chromium builds
    // have also used links. The exact leaf text is the stable contract.
    return typeof element.click === 'function' && label === 'freeze';
  };
  const elements = deepElements(document);
  const containers = elements.filter(element => {
    if (!deepText(element).includes(needle)) return false;
    return deepElements(element).filter(isFreeze).length === 1;
  }).sort((left, right) => deepElements(left).length - deepElements(right).length);
  for (const container of containers) {
    const control = deepElements(container).find(isFreeze);
    if (control) {
      control.click();
      return true;
    }
  }
  return false;
})()`;

const safeProfile = (profileRoot, profile) => {
  const root = path.resolve(profileRoot);
  const candidate = path.resolve(profile);
  return candidate.startsWith(root + path.sep) &&
    /^edge-frozen-smoke-\d+-\d+$/.test(path.basename(candidate));
};

const run = async () => {
  fs.mkdirSync(DEFAULT_RESULTS_ROOT, {recursive: true});
  const reportPath = path.join(DEFAULT_RESULTS_ROOT, RESULT_FILE);
  const report = {
    browser: {family: 'edge'},
    cleanup: {
      browser: null,
      crashArtifacts: null,
      crashFree: null,
      fixtureStopped: false,
      profileCreated: false,
      profileRemoved: false
    },
    extension: {
      manifestVersion: null,
      serviceWorker: null,
      tree: [],
      version: null
    },
    failures: [],
    fixture: {
      requestCountTotal: null,
      windowIsolation: null
    },
    scenarios: [],
    outcome: 'failed',
    schemaVersion: 2,
    startedAt: new Date().toISOString(),
    test: 'edge-frozen-smoke'
  };
  const writeReport = () => fs.writeFileSync(reportPath,
    `${JSON.stringify(sanitize(report), null, 2)}\n`, 'utf8');
  const recordFailure = (stage, error) => report.failures.push({
    message: safeMessage(error),
    name: String(error?.name || 'Error'),
    stage
  });

  let browser;
  let emergency = false;
  let executable;
  let fixture;
  let pulseEvidence;
  const takeoverFailureCodes = [];
  let stopPulseEvidenceListener;
  let primaryError;
  let profile;
  let profileRoot;
  const cleanupFailures = [];
  const captureCleanupFailure = (stage, error) => {
    cleanupFailures.push(error);
    recordFailure(stage, error);
  };

  const emergencyCleanup = reason => {
    if (!emergency) {
      return;
    }
    emergency = false;
    try {
      const kill = killProcessTree(browser?.child);
      if (browser?.child && !childExitState(browser.child)) {
        ensure(kill.issued, `Emergency Edge process-tree kill failed (task status ${kill.status})`);
      }
    }
    catch (error) {
      recordFailure('emergency browser cleanup', error);
      process.stderr.write(`Edge emergency browser cleanup failed: ${safeMessage(error)}\n`);
    }
    try {
      if (profile) {
        ensure(safeProfile(profileRoot, profile),
          'Refusing emergency deletion outside the isolated Edge profile root');
        fs.rmSync(profile, {force: true, maxRetries: 4, recursive: true, retryDelay: 250});
        ensure(!fs.existsSync(profile), 'Emergency Edge profile removal failed');
        report.cleanup.profileRemoved = true;
      }
    }
    catch (error) {
      recordFailure('emergency profile cleanup', error);
      process.stderr.write(`Edge emergency profile cleanup failed: ${safeMessage(error)}\n`);
    }
    report.emergencyReason = safeMessage(reason);
    report.finishedAt = new Date().toISOString();
    try {
      writeReport();
    }
    catch (error) {
      process.stderr.write(`Edge emergency report write failed: ${safeMessage(error)}\n`);
    }
  };
  const onSigint = () => {
    emergencyCleanup('SIGINT');
    process.exit(130);
  };
  const onSigterm = () => {
    emergencyCleanup('SIGTERM');
    process.exit(143);
  };

  try {
    executable = path.resolve(option('executable', ''));
    const extension = path.resolve(option('extension', DEFAULT_EXTENSION));
    profileRoot = path.resolve(option('profile-root', DEFAULT_PROFILE_ROOT));
    ensure(fs.existsSync(path.join(extension, 'manifest.json')), 'The unpacked extension does not exist');
    const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
    const workerPath = `/${String(manifest.background?.service_worker || '').replace(/^\/+/, '')}`;
    ensure(workerPath !== '/', 'The extension manifest has no service worker');
    report.extension = {
      manifestVersion: manifest.manifest_version,
      serviceWorker: workerPath.replace(/^\/+/, ''),
      tree: extensionTree(extension),
      treeSha256: extensionTreeSha256(extension),
      version: manifest.version
    };
    ensure(process.argv.includes('--allow-edge'), 'Pass --allow-edge to authorize the isolated Edge smoke run');
    ensure(option('executable'), 'Pass --executable with the Microsoft Edge executable');
    ensure(path.basename(executable).toLowerCase() === 'msedge.exe', 'This harness only accepts Microsoft Edge');
    ensure(fs.existsSync(executable), 'The Edge executable does not exist');

    fs.mkdirSync(profileRoot, {recursive: true});
    profile = path.join(profileRoot, `edge-frozen-smoke-${Date.now()}-${process.pid}`);
    ensure(safeProfile(profileRoot, profile), 'The generated Edge profile escaped the profile root');
    fs.mkdirSync(profile, {recursive: false});
    report.cleanup.profileCreated = true;
    emergency = true;
    process.once('exit', emergencyCleanup);
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);

    fixture = await startFixture();
    browser = await launchEdge({executable, extension, profile});
    const {cdp} = browser;

    const extensionTarget = await waitFor(async () => {
      const {targetInfos = []} = await cdp.send('Target.getTargets');
      const target = targetInfos.find(info =>
        info.type === 'service_worker' && /^(?:chrome|edge)-extension:\/\//.test(info.url) &&
        new URL(info.url).pathname === workerPath);
      if (!target) {
        return false;
      }
      return target;
    }, 'The unpacked extension did not start', 20000);

    // Attach directly to the already-running MV3 worker. Creating or navigating
    // an extension page through raw Edge CDP is racy and can silently retain a
    // normal New Tab origin; the worker is the authoritative extension context
    // and exposes the same runtime, storage, and tabs APIs without touching the
    // fixture renderer.
    const workerSession = await attachPage(cdp, extensionTarget.targetId);
    stopPulseEvidenceListener = cdp.onEvent(message => {
      if (message.sessionId !== workerSession || message.method !== 'Runtime.consoleAPICalled') {
        return;
      }
      const argumentsList = message.params?.args || [];
      const values = argumentsList.map(argument => argument.value)
        .filter(value => typeof value === 'string');
      if (values.includes('discard takeover failure stage')) {
        const description = argumentsList.map(argument =>
          typeof argument.value === 'string' ? argument.value : argument.description || '').join(' ');
        const known = [
          'wake-timeout', 'wake-not-quiescent', 'reload-stop-failed',
          'marker-preparation-failed', 'marker-title-unavailable',
          'native-discard-timeout', 'native-discard-unsettled',
          'native-discard-contended', 'ownership-finalization-failed',
          'ownership-stale', 'cancelled', 'other-takeover-failure'
        ].find(code => description.includes(code));
        takeoverFailureCodes.push(known || classifyTakeoverFailure(description));
      }
      const encoded = values.find(value => value.includes('auto-tab-discard/pulse-evidence'));
      if (!encoded) {
        return;
      }
      try {
        const candidate = JSON.parse(encoded);
        if (candidate?.schema === 'auto-tab-discard/pulse-evidence') {
          pulseEvidence = candidate;
        }
      }
      catch (error) {
        // Ignore unrelated diagnostic strings.
      }
    });
    let extensionProbe;
    try {
      await waitFor(async () => {
        extensionProbe = await evaluate(cdp, workerSession, `(() => ({
          chromeApi: Boolean(globalThis.chrome),
          extensionApi: Boolean(globalThis.chrome?.runtime?.id),
          storageApi: Boolean(globalThis.chrome?.storage),
          tabsApi: Boolean(globalThis.chrome?.tabs)
        }))()`);
        return extensionProbe?.chromeApi && extensionProbe.extensionApi && extensionProbe.storageApi &&
          extensionProbe.tabsApi;
      }, 'The extension test page did not become ready', 15000);
    }
    catch (error) {
      const flags = ['chromeApi', 'extensionApi', 'storageApi', 'tabsApi']
        .map(key => extensionProbe?.[key] === true ? '1' : '0').join('');
      throw Error(`The extension worker did not become ready (capabilities ${flags})`);
    }

    await evaluate(cdp, workerSession, `(async () => {
      await chrome.storage.local.set({
        audio: false,
        favicon: true,
        form: false,
        log: true,
        'max.single.discard': 1,
        'notification.permission': false,
        number: 0,
        paused: false,
        period: 0,
        prepends: '💤'
      });
      return true;
    })()`);

    // Construct the fixture in a dedicated, ordinary Edge window through the
    // extension API. A raw Target.createTarget tab can remain renderer-visible
    // despite being reported inactive on Edge; that is not a valid background
    // tab precondition for this smoke test.
    const fixtureWindow = await evaluate(cdp, workerSession, `(async () => {
      const created = await chrome.windows.create({
        focused: true,
        state: 'normal',
        type: 'normal',
        url: ${JSON.stringify(fixture.url)}
      });
      const exact = created?.id === undefined ? null : await chrome.windows.get(created.id);
      const tabs = created?.id === undefined ? [] : await chrome.tabs.query({windowId: created.id});
      const tab = tabs[0];
      return {
        focusRequested: true,
        focused: exact?.focused === true,
        state: exact?.state,
        tabActive: tab?.active === true,
        tabId: tab?.id,
        type: exact?.type,
        windowId: created?.id
      };
    })()`);
    ensure(Number.isInteger(fixtureWindow?.windowId) && Number.isInteger(fixtureWindow.tabId) &&
      fixtureWindow.focusRequested === true && fixtureWindow.state === 'normal' &&
      fixtureWindow.type === 'normal' && fixtureWindow.tabActive === true,
    'Edge did not create a requested-focused normal fixture window with one active standard tab');

    // Create the command driver in that exact normal window. This both commits
    // the extension origin correctly and makes the fixture a genuine inactive
    // sibling tab rather than a raw-CDP background target.
    const driverCreation = await evaluate(cdp, workerSession, `(async () => {
      const url = chrome.runtime.getURL('data/options/index.html');
      const tab = await chrome.tabs.create({
        active: true,
        url,
        windowId: ${Number(fixtureWindow.windowId)}
      });
      return {
        active: tab?.active === true,
        id: tab?.id,
        url,
        windowMatched: tab?.windowId === ${Number(fixtureWindow.windowId)}
      };
    })()`);
    ensure(Number.isInteger(driverCreation?.id) && driverCreation.active === true &&
      driverCreation.windowMatched === true,
    'Edge did not create the active keeper in the dedicated fixture window');
    const driverUrl = driverCreation.url;
    const driverTarget = await waitFor(async () => {
      const {targetInfos = []} = await cdp.send('Target.getTargets');
      return targetInfos.find(info => info.type === 'page' && info.url === driverUrl) || false;
    }, 'The extension command driver did not appear', 15000);
    const driverSession = await attachPage(cdp, driverTarget.targetId);
    await waitFor(async () => evaluate(cdp, driverSession, `document.readyState === 'complete' &&
      Boolean(globalThis.chrome?.runtime?.id) && Boolean(globalThis.chrome?.tabs)`),
    'The extension command driver did not become ready', 15000);
    const driverTab = await evaluate(cdp, driverSession, `new Promise(resolve => {
      chrome.tabs.getCurrent(tab => resolve(tab && ({
        active: tab.active === true,
        id: tab.id,
        windowId: tab.windowId
      })));
    })`);
    const driverId = driverTab?.id;
    ensure(Number.isInteger(driverId) && driverId === driverCreation.id &&
      driverTab.active === true && driverTab.windowId === fixtureWindow.windowId,
    'The extension command driver has no live identity in the dedicated fixture window');

    // From this point onward, keep every harness API call and diagnostic
    // listener in the active extension page. Edge can suspend the MV3 worker's
    // CDP execution context when a transient control window closes; the page
    // remains stable while the real worker is independently woken by the alarm.
    await evaluate(cdp, driverSession, monitorInstallExpression);
    await evaluate(cdp, driverSession, `(() => {
      if (!globalThis.__edgeFrozenAlarmMonitor) {
        const monitor = globalThis.__edgeFrozenAlarmMonitor = {events: []};
        chrome.alarms.onAlarm.addListener(alarm => monitor.events.push({
          at: performance.now(),
          name: alarm.name,
          scheduledTime: alarm.scheduledTime
        }));
      }
      return true;
    })()`);

    // Edge starts with an unrelated about:blank window. Keep the isolated run
    // to the one exact normal fixture window so closing a disposable
    // edge://discards control cannot later refocus a stale startup window
    // while the strict zero-focus command evidence is being collected.
    const isolatedWindows = await evaluate(cdp, driverSession, `(async () => {
      const keepWindowId = ${Number(fixtureWindow.windowId)};
      const before = await chrome.windows.getAll({populate: true, windowTypes: ['normal']});
      const remove = before.filter(window => window.id !== keepWindowId);
      for (const window of remove) {
        await Promise.race([
          chrome.windows.remove(window.id),
          new Promise((resolve, reject) => setTimeout(() =>
            reject(Error('windows.remove API deadline exceeded')), 3000))
        ]);
      }
      const after = await chrome.windows.getAll({populate: true, windowTypes: ['normal']});
      return {
        exactFixtureWindowRemaining: after.length === 1 && after[0].id === keepWindowId,
        extraneousWindowsClosed: remove.length,
        remainingNormalWindows: after.length
      };
    })()`, 10000, 'initial normal-window isolation');
    ensure(isolatedWindows?.exactFixtureWindowRemaining === true &&
      isolatedWindows.remainingNormalWindows === 1,
    'Edge retained an unrelated normal window in the isolated frozen smoke run');
    report.fixture.windowIsolation = isolatedWindows;

    const modes = [{
      key: 'combined',
      prepends: '\u{1F4A4}',
      titleExpected: true
    }, {
      key: 'favicon-only',
      prepends: '',
      titleExpected: false
    }];

    for (let index = 0; index < modes.length; index += 1) {
      const mode = modes[index];
      const url = fixture.urls[mode.key];
      if (index > 0) {
        const created = await evaluate(cdp, driverSession, `(async () => {
          const tab = await chrome.tabs.create({
            active: false,
            url: ${JSON.stringify(url)},
            windowId: ${JSON.stringify(driverTab.windowId)}
          });
          return {id: tab.id};
        })()`);
        ensure(Number.isInteger(created?.id), `${mode.key}: Edge did not create the fixture tab`);
      }

      const scenario = {
        alarm: {
          eventCount: 0,
          name: 'number.check',
          observed: false,
          trigger: 'chrome.alarms.onAlarm'
        },
        controlWindowClosed: false,
        dwell: {
          durationMilliseconds: DWELL_MS,
          focusState: null,
          requestCountAfter: null,
          requestCountBefore: null,
          snapshot: null,
          summary: null
        },
        final: {requestCount: null, snapshot: null, summary: null},
        fixture: {
          pulseCheckpoint: null,
          pulseEvidence: null,
          requestCounts: {
            afterAlarm: null,
            afterDwell: null,
            beforeAlarm: null,
            beforeDwell: null,
            initial: null
          },
          setupFocus: null,
          setupKeeper: null
        },
        frozen: null,
        initial: null,
        name: mode.key,
        repeat: null,
        settings: {
          favicon: true,
          titleIndicator: mode.titleExpected ? 'configured' : 'disabled'
        }
      };
      report.scenarios.push(scenario);

      await evaluate(cdp, driverSession, `(async () => {
        await chrome.storage.local.set({
          favicon: true,
          'max.single.discard': 1,
          number: 0,
          period: 0,
          prepends: ${JSON.stringify(mode.prepends)}
        });
        return true;
      })()`);
      await sleep(300);

      const initial = await waitFor(async () => {
        const snapshot = await evaluate(cdp, driverSession, extensionSnapshotExpression(url));
        return snapshot?.found && snapshot.active === false && snapshot.discarded === false &&
          snapshot.frozen === false && snapshot.status === 'complete' ? snapshot : false;
      }, `${mode.key}: fixture tab did not finish loading in the background`, 20000);
      if (index === 0) {
        ensure(initial.id === fixtureWindow.tabId && initial.windowId === fixtureWindow.windowId,
          `${mode.key}: dedicated fixture tab identity changed during construction`);
      }
      scenario.initial = summarizeSnapshot(initial);
      ensure(driverTab.windowId === initial.windowId,
        `${mode.key}: command driver is not in the fixture window`);
      scenario.fixture.requestCounts.initial = fixture.count(mode.key);
      ensure(fixture.count(mode.key) === 1,
        `${mode.key}: fixture made an unexpected number of initial document requests`);

      // Read and reset renderer-side pulse evidence before invoking Edge's
      // native Freeze control. Once frozen, Edge intentionally stops servicing
      // scripting.executeScript for that renderer, so any post-Freeze script
      // injection would test a harness timeout rather than extension behavior.
      const preFreezeTabs = await evaluate(cdp, driverSession,
        setupTabStateExpression(driverId, initial.id, initial.windowId), 5000,
        `${mode.key}: pre-freeze live tab verification`);
      ensure(!preFreezeTabs?.apiError,
        `${mode.key}: ${preFreezeTabs?.apiError || 'pre-freeze tab verification returned no state'}`);
      ensure(preFreezeTabs.driverActive === true && preFreezeTabs.driverWindowMatched === true &&
        preFreezeTabs.targetActive === false && preFreezeTabs.targetWindowMatched === true,
      `${mode.key}: pre-freeze fixture did not have the exact active keeper`);
      const preFreezeHiddenFixture = await waitFor(async () => {
        const state = await evaluate(cdp, driverSession,
          fixtureDocumentStateExpression(initial.id), 5000,
          `${mode.key}: pre-freeze fixture visibility probe`);
        if (state?.apiError) {
          throw Error(`${mode.key}: ${state.apiError}`);
        }
        return state?.focused === false && state.visibility === 'hidden' ? state : false;
      }, `${mode.key}: fixture remained visible before native Freeze`, 5000, 100);
      const pulseCheckpoint = await evaluate(cdp, driverSession,
        pulseCheckpointExpression(initial.id), 5000,
        `${mode.key}: pre-freeze pulse evidence checkpoint`);
      scenario.fixture.pulseCheckpoint = pulseCheckpoint;
      ensure(!pulseCheckpoint?.apiError,
        `${mode.key}: ${pulseCheckpoint?.apiError || 'pre-freeze pulse checkpoint returned no state'}`);
      ensure(pulseCheckpoint?.finalFocused === false && pulseCheckpoint.finalVisibility === 'hidden',
        `${mode.key}: pulse checkpoint was not taken from an unfocused background fixture`);
      ensure(pulseCheckpoint?.after?.blurEvents === 0 &&
        pulseCheckpoint.after.focusEvents === 0 &&
        pulseCheckpoint.after.mediaEvents === 0 &&
        pulseCheckpoint.after.pictureInPictureEvents === 0 &&
        Array.isArray(pulseCheckpoint.after.visibilityTransitions) &&
        pulseCheckpoint.after.visibilityTransitions.length === 0,
      `${mode.key}: pulse checkpoint did not reset the pre-freeze event baseline`);
      ensure(fixture.count(mode.key) === 1,
        `${mode.key}: pre-freeze pulse checkpoint unexpectedly requested the fixture again`);

      const {targetId: scenarioControlTargetId} = await cdp.send('Target.createTarget', {
        newWindow: true,
        url: 'edge://discards/'
      });
      ensure(scenarioControlTargetId,
        `${mode.key}: Edge did not create the fresh edge://discards control target`);
      const scenarioControlWindow = await cdp.send('Browser.getWindowForTarget', {
        targetId: scenarioControlTargetId
      });
      ensure(Number.isInteger(scenarioControlWindow?.windowId) &&
        scenarioControlWindow.windowId > 0,
      `${mode.key}: CDP did not identify the fresh edge://discards control window`);
      const scenarioDiscardsSession = await attachPage(cdp, scenarioControlTargetId);
      await waitFor(() => evaluate(cdp, scenarioDiscardsSession,
        'document.readyState === "complete"'),
      `${mode.key}: fresh edge://discards control did not become ready`, 15000);
      await waitFor(() => evaluate(cdp, scenarioDiscardsSession, freezeClickExpression(url)),
        `${mode.key}: Freeze control was not found on edge://discards`, 15000, 250);
      const frozen = await waitFor(async () => {
        const snapshot = await evaluate(cdp, driverSession, extensionSnapshotExpression(url));
        return snapshot?.found && snapshot.discarded === false && snapshot.frozen === true ? snapshot : false;
      }, `${mode.key}: Edge did not expose the fixture as frozen`, 15000);
      scenario.frozen = summarizeSnapshot(frozen);
      ensure(frozen.id === initial.id, `${mode.key}: fixture identity changed before the alarm`);
      ensure(frozen.active === false && frozen.autoDiscardable !== false && frozen.status === 'complete',
        `${mode.key}: frozen fixture is not eligible for the automatic alarm path`);

      await cdp.send('Target.detachFromTarget', {
        sessionId: scenarioDiscardsSession
      });
      const closedControl = await cdp.send('Target.closeTarget', {
        targetId: scenarioControlTargetId
      });
      ensure(closedControl?.success === true,
        `${mode.key}: exact edge://discards control target rejected close`);
      await waitFor(async () => {
        const {targetInfos = []} = await cdp.send('Target.getTargets');
        return targetInfos.every(info => info.targetId !== scenarioControlTargetId);
      }, `${mode.key}: exact edge://discards control target remained after close`, 10000, 100);
      scenario.controlWindowClosed = true;

      // The control click is allowed to perturb OS focus. Establish every
      // command/dwell baseline only after that disposable window is closed and
      // the exact normal fixture window plus keeper have settled again.
      await withTimeout(cdp.send('Target.activateTarget', {
        targetId: driverTarget.targetId
      }), 5000, `${mode.key}: post-control driver target activation timed out`);
      const setupStage = `${mode.key}: post-control driver setup`;
      const activatedFocus = await evaluate(cdp, driverSession,
        focusStateExpression(initial.windowId), 5000,
        `${setupStage}: activation focus verification`);
      ensure(!activatedFocus?.apiError,
        `${setupStage}: ${activatedFocus?.apiError || 'focus verification returned no state'}`);
      ensure(activatedFocus.exactFocused === true && activatedFocus.exactNormal === true &&
        activatedFocus.exactTypeNormal === true && activatedFocus.currentMatched === true &&
        activatedFocus.currentFocused === true && activatedFocus.lastFocusedMatched === true,
      `${mode.key}: CDP driver activation did not restore the exact normal fixture window`);
      scenario.fixture.setupFocus = {
        browserTargetActivated: true,
        confirmed: false,
        initialVerification: true,
        requested: false
      };
      const postControlQuiescence = await waitForSetupMonitorSettlement(
        cdp,
        driverSession,
        `${setupStage}: delayed control-focus quiescence`,
        CONTROL_CLOSE_QUIET_MS
      );
      await withTimeout(cdp.send('Target.activateTarget', {
        targetId: driverTarget.targetId
      }), 5000, `${mode.key}: post-quiescence driver target activation timed out`);
      const finalActivatedFocus = await evaluate(cdp, driverSession,
        focusStateExpression(initial.windowId), 5000,
        `${setupStage}: post-quiescence focus verification`);
      ensure(!finalActivatedFocus?.apiError,
        `${setupStage}: ${finalActivatedFocus?.apiError || 'post-quiescence focus returned no state'}`);
      ensure(finalActivatedFocus.exactFocused === true && finalActivatedFocus.exactNormal === true &&
        finalActivatedFocus.exactTypeNormal === true && finalActivatedFocus.currentMatched === true &&
        finalActivatedFocus.currentFocused === true && finalActivatedFocus.lastFocusedMatched === true,
      `${mode.key}: final CDP driver activation did not restore the exact normal fixture window`);
      const setupFocusCheckpoint = await evaluate(cdp, driverSession,
        monitorCheckpointExpression, 5000, `${setupStage}: initial monitor checkpoint`);
      const settledFocus = await waitForFocusedWindowSettlement(
        cdp,
        driverSession,
        initial.windowId,
        setupStage
      );
      const settledFocusCheckpoint = await evaluate(cdp, driverSession,
        monitorCheckpointExpression, 5000, `${setupStage}: settled focus checkpoint`);
      ensure(settledFocusCheckpoint.focusChanges === settledFocus.focusChanges,
        `${mode.key}: fixture-window focus changed after the settlement fence`);

      const setupKeeperRequest = await evaluate(cdp, driverSession,
        activateSetupKeeperExpression(driverId, initial.windowId), 5000,
        `${setupStage}: exact keeper activation`);
      ensure(!setupKeeperRequest?.apiError,
        `${setupStage}: ${setupKeeperRequest?.apiError || 'keeper activation returned no state'}`);
      ensure(setupKeeperRequest?.active === true && setupKeeperRequest.windowMatched === true,
        `${mode.key}: Edge did not accept exact driver-tab activation`);
      const liveSetupTabs = await waitFor(async () => {
        const state = await evaluate(cdp, driverSession,
          setupTabStateExpression(driverId, initial.id, initial.windowId), 5000,
          `${setupStage}: live keeper state probe`);
        if (state?.apiError) {
          throw Error(`${setupStage}: ${state.apiError}`);
        }
        return state?.driverActive === true && state.driverWindowMatched === true &&
          state.targetActive === false && state.targetWindowMatched === true ? state : false;
      }, `${mode.key}: exact driver activation did not produce one live keeper`, 10000, 100);
      const settledSetupMonitor = await waitForSetupMonitorSettlement(cdp, driverSession, setupStage);
      const setupBaseline = await evaluate(cdp, driverSession, monitorCheckpointExpression, 5000,
        `${setupStage}: final monitor baseline`);
      ensure(setupBaseline.activations === settledSetupMonitor.activations &&
        setupBaseline.focusChanges === settledSetupMonitor.focusChanges,
      `${mode.key}: setup activation/focus monitor changed after the settlement fence`);
      const confirmedSetupTabs = await evaluate(cdp, driverSession,
        setupTabStateExpression(driverId, initial.id, initial.windowId), 5000,
        `${setupStage}: final live tab verification`);
      ensure(!confirmedSetupTabs?.apiError,
        `${setupStage}: ${confirmedSetupTabs?.apiError || 'final tab verification returned no state'}`);
      ensure(confirmedSetupTabs?.driverActive === true &&
        confirmedSetupTabs.driverWindowMatched === true &&
        confirmedSetupTabs.targetActive === false &&
        confirmedSetupTabs.targetWindowMatched === true,
      `${mode.key}: live keeper/target state drifted after setup settlement`);
      const confirmedSetupFocus = await evaluate(cdp, driverSession,
        focusStateExpression(initial.windowId), 5000,
        `${setupStage}: final focus verification`);
      ensure(!confirmedSetupFocus?.apiError,
        `${setupStage}: ${confirmedSetupFocus?.apiError || 'final focus verification returned no state'}`);
      ensure(confirmedSetupFocus?.exactFocused === true &&
        confirmedSetupFocus.exactNormal === true &&
        confirmedSetupFocus.exactTypeNormal === true &&
        confirmedSetupFocus.currentMatched === true &&
        confirmedSetupFocus.currentFocused === true &&
        confirmedSetupFocus.lastFocusedMatched === true,
      `${mode.key}: exact fixture window lost focus during keeper setup`);

      const setupFocusSummary = await evaluate(cdp, driverSession,
        setupFocusSummaryExpression(setupFocusCheckpoint.focusChanges, initial.windowId), 5000,
        `${setupStage}: focus-event summary`);
      scenario.fixture.setupFocus = {
        ...setupFocusSummary,
        browserTargetActivated: true,
        confirmed: true,
        controlCloseQuietMilliseconds: postControlQuiescence.stableMilliseconds,
        requested: false,
        reactivatedAfterQuiescence: true,
        stableMilliseconds: settledFocus.stableMilliseconds
      };
      ensure(setupFocusSummary.otherWindowFocusEvents === 0,
        `${mode.key}: a different Edge window gained focus during fixture setup`);
      scenario.fixture.setupKeeper = {
        activationEvents: setupBaseline.activations - settledFocusCheckpoint.activations,
        confirmed: true,
        driverActive: liveSetupTabs.driverActive === true,
        driverWindowMatched: liveSetupTabs.driverWindowMatched === true,
        fixtureFocused: preFreezeHiddenFixture.focused === true,
        fixtureVisibility: preFreezeHiddenFixture.visibility,
        focusEvents: setupBaseline.focusChanges - settledFocusCheckpoint.focusChanges,
        requested: true,
        stableMilliseconds: settledSetupMonitor.stableMilliseconds,
        targetActive: liveSetupTabs.targetActive === true,
        targetWindowMatched: liveSetupTabs.targetWindowMatched === true,
        windowFocused: confirmedSetupFocus.exactFocused === true &&
          confirmedSetupFocus.lastFocusedMatched === true,
        windowNormal: confirmedSetupFocus.exactNormal === true &&
          confirmedSetupFocus.exactTypeNormal === true
      };

      ensure(fixture.count(mode.key) === 1,
        `${mode.key}: post-control setup unexpectedly requested the frozen fixture again`);
      const frozenAfterSetup = await evaluate(cdp, driverSession,
        extensionSnapshotExpression(url), 5000,
        `${setupStage}: frozen eligibility recheck`);
      ensure(frozenAfterSetup?.found && frozenAfterSetup.id === initial.id &&
        frozenAfterSetup.discarded === false && frozenAfterSetup.frozen === true &&
        frozenAfterSetup.active === false && frozenAfterSetup.status === 'complete',
      `${mode.key}: post-control setup did not preserve the eligible frozen target`);

      const baselineRequests = fixture.count(mode.key);
      scenario.fixture.requestCounts.beforeAlarm = baselineRequests;
      const alarmCheckpoint = await evaluate(cdp, driverSession,
        'globalThis.__edgeFrozenAlarmMonitor.events.length');
      const commandCheckpoint = await evaluate(cdp, driverSession, monitorCheckpointExpression);
      const alarmCreated = await evaluate(cdp, driverSession, `(async () => {
        await new Promise(resolve => chrome.alarms.clear('number.check', resolve));
        chrome.alarms.create('number.check', {when: Date.now() + 500});
        const alarm = await new Promise(resolve => chrome.alarms.get('number.check', resolve));
        return alarm?.name === 'number.check' && Number.isFinite(alarm.scheduledTime);
      })()`);
      ensure(alarmCreated === true, `${mode.key}: number.check alarm was not created`);

      let observedFinal;
      let final;
      try {
        final = await waitFor(async () => {
          const snapshot = await evaluate(cdp, driverSession, extensionSnapshotExpression(url));
          observedFinal = snapshot;
          return snapshot?.found && snapshot.discarded === true && snapshot.status === 'unloaded' &&
            snapshot.source === 'self' && snapshot.markerState === 'owned' &&
            snapshot.ownershipOnlyCurrent === true && snapshot.titleMarked === false &&
            snapshot.visualComplete === false && snapshot.visualFavicon === false &&
            snapshot.visualPhysicalOnly === true && snapshot.visualRepair === false &&
            snapshot.visualTitle === false && snapshot.visualTitleConfigured === mode.titleExpected ?
            snapshot : false;
        }, `${mode.key}: alarm did not settle the frozen tab as a physical-only self-owned discard`, 30000);
      }
      catch (error) {
        scenario.final.snapshot = summarizeSnapshot(observedFinal);
        scenario.fixture.requestCounts.afterAlarm = fixture.count(mode.key);
        scenario.final.requestCount = fixture.count(mode.key);
        try {
          scenario.final.summary = summarizeActivity(await evaluate(cdp, driverSession,
            monitorSummaryExpression(
              initial.id,
              commandCheckpoint.events,
              commandCheckpoint.activations,
              driverId,
              commandCheckpoint.focusChanges,
              initial.windowId,
              true,
              commandCheckpoint.at
            )));
        }
        catch (summaryError) {
          recordFailure(`${mode.key}: final activity summary after settlement failure`, summaryError);
        }
        throw Error(`${error.message}; last state ${JSON.stringify(observedFinal)}`);
      }
      scenario.final.snapshot = summarizeSnapshot(final);
      scenario.fixture.requestCounts.afterAlarm = fixture.count(mode.key);
      scenario.final.requestCount = fixture.count(mode.key);

      const alarmEvents = await waitFor(async () => {
        const events = await evaluate(cdp, driverSession,
          `globalThis.__edgeFrozenAlarmMonitor.events.slice(${Number(alarmCheckpoint)})`);
        return events.some(event => event.name === 'number.check') ? events : false;
      }, `${mode.key}: real number.check alarm event was not observed`, 5000);
      const numberAlarmEvents = alarmEvents.filter(event => event.name === 'number.check');
      scenario.alarm.eventCount = numberAlarmEvents.length;
      scenario.alarm.observed = true;
      ensure(numberAlarmEvents.length === 1, `${mode.key}: number.check alarm fired more than once`);

      const commandSummary = await evaluate(cdp, driverSession,
        monitorSummaryExpression(
          initial.id,
          commandCheckpoint.events,
          commandCheckpoint.activations,
          driverId,
          commandCheckpoint.focusChanges,
          initial.windowId,
          true,
          commandCheckpoint.at
        ));
      scenario.final.summary = summarizeActivity(commandSummary);
      ensure(fixture.count(mode.key) === baselineRequests,
        `${mode.key}: frozen takeover unexpectedly requested the document again`);
      ensure(commandSummary.awakeEpisodes === 0 && commandSummary.loadingSignals === 0,
        `${mode.key}: direct native alarm takeover woke or loaded the frozen renderer`);
      ensure(commandSummary.targetActivations === 0 && commandSummary.driverReactivations === 0,
        `${mode.key}: direct native alarm takeover activated the target or keeper`);
      ensure(commandSummary.focusChanges === 0,
        `${mode.key}: direct native alarm takeover changed browser-window focus`);

      const repeatCheckpoint = await evaluate(cdp, driverSession, monitorCheckpointExpression);
      const repeatResponse = await evaluate(cdp, driverSession, `new Promise(resolve => {
        const timer = setTimeout(() => resolve({apiError: 'repeat popup response deadline exceeded'}), 10000);
        chrome.runtime.sendMessage({
          method: 'popup',
          // A real popup is anchored to the active keeper. The sleeping
          // target cannot truthfully be the popup tab without waking it, so
          // exercise the visible "Discard Other Tabs" row in this one-target
          // window scope. It reaches the same ownership repeat contract while
          // preserving the strict zero-activation invariant.
          cmd: 'discard-tabs',
          tabId: ${Number(driverId)},
          windowId: ${Number(initial.windowId)},
          shiftKey: false,
          checked: false
        }, response => {
          const error = chrome.runtime.lastError;
          clearTimeout(timer);
          resolve(error ? {apiError: error.message} : response);
        });
      })`, 15000, `${mode.key}: physical-only repeat popup command`);
      const repeatOutcomes = Object.values(repeatResponse?.value?.outcomes || {}).map(outcome => ({
        code: String(outcome?.code || ''),
        status: String(outcome?.status || '')
      }));
      scenario.repeat = {
        response: {
          apiError: repeatResponse?.apiError ? safeMessage(repeatResponse.apiError) : null,
          completed: Number(repeatResponse?.value?.completed || 0),
          error: repeatResponse?.error ? safeMessage(repeatResponse.error) : null,
          ok: repeatResponse?.ok === true,
          outcomes: repeatOutcomes,
          state: repeatResponse?.value?.state || null,
          total: Number(repeatResponse?.value?.total || 0)
        },
        summary: null
      };
      ensure(!repeatResponse?.apiError && repeatResponse?.ok === true &&
        repeatResponse.value?.state === 'complete' && repeatResponse.value.completed === 1 &&
        repeatResponse.value.total === 1,
      `${mode.key}: physical-only repeat did not complete as a no-op`);
      const repeatOutcome = Object.values(repeatResponse.value.outcomes || {})[0];
      ensure(repeatOutcome?.status === 'skipped' &&
        repeatOutcome.code === 'TAB_ALREADY_OWNED_VISUAL_UNAVAILABLE',
      `${mode.key}: physical-only repeat did not retain the visual-unavailable warning`);
      const repeatSummary = await evaluate(cdp, driverSession,
        monitorSummaryExpression(
          final.id,
          repeatCheckpoint.events,
          repeatCheckpoint.activations,
          driverId,
          repeatCheckpoint.focusChanges,
          initial.windowId,
          true,
          repeatCheckpoint.at
        ));
      ensure(repeatSummary.eventCount === 0 && repeatSummary.awakeEpisodes === 0 &&
        repeatSummary.loadingSignals === 0 && repeatSummary.targetActivations === 0 &&
        repeatSummary.driverReactivations === 0 && repeatSummary.focusChanges === 0,
      `${mode.key}: physical-only repeat was not a strict browser no-op`);
      scenario.repeat = {
        response: scenario.repeat.response,
        outcome: {code: repeatOutcome.code, status: repeatOutcome.status},
        summary: summarizeActivity(repeatSummary)
      };

      const dwellCheckpoint = await evaluate(cdp, driverSession, monitorCheckpointExpression);
      const dwellRequests = fixture.count(mode.key);
      scenario.fixture.requestCounts.beforeDwell = dwellRequests;
      scenario.dwell.requestCountBefore = dwellRequests;
      await sleep(DWELL_MS);
      const afterDwell = await evaluate(cdp, driverSession, extensionSnapshotExpression(url));
      scenario.dwell.snapshot = summarizeSnapshot(afterDwell);
      scenario.fixture.requestCounts.afterDwell = fixture.count(mode.key);
      scenario.dwell.requestCountAfter = fixture.count(mode.key);
      const dwellSummary = await evaluate(cdp, driverSession,
        monitorSummaryExpression(
          initial.id,
          dwellCheckpoint.events,
          dwellCheckpoint.activations,
          driverId,
          dwellCheckpoint.focusChanges,
          initial.windowId,
          true,
          dwellCheckpoint.at
        ));
      scenario.dwell.summary = summarizeActivity(dwellSummary);
      const dwellFocusState = await evaluate(cdp, driverSession,
        focusStateExpression(initial.windowId));
      const classifiedDwellFocus = classifyDwellFocusState(dwellFocusState);
      scenario.dwell.focusState = classifiedDwellFocus;
      ensure(afterDwell?.found && afterDwell.discarded === true && afterDwell.status === 'unloaded' &&
        afterDwell.source === 'self' && afterDwell.markerState === 'owned' &&
        afterDwell.ownershipOnlyCurrent === true && afterDwell.titleMarked === false &&
        afterDwell.visualComplete === false && afterDwell.visualFavicon === false &&
        afterDwell.visualPhysicalOnly === true && afterDwell.visualRepair === false &&
        afterDwell.visualTitle === false &&
        afterDwell.visualTitleConfigured === mode.titleExpected,
      `${mode.key}: tab did not retain its physical-only visual record during the dwell`);
      ensure(afterDwell.id === final.id, `${mode.key}: tab changed identity after discard settled`);
      ensure(fixture.count(mode.key) === dwellRequests,
        `${mode.key}: delayed fixture request occurred during the dwell`);
      ensure(dwellSummary.awakeEpisodes === 0 && dwellSummary.loadingSignals === 0,
        `${mode.key}: delayed wake or loading spinner occurred during the dwell`);
      ensure(dwellSummary.targetActivations === 0 && dwellSummary.driverReactivations === 0,
        `${mode.key}: delayed target or keeper activation occurred during the dwell`);
      ensure(dwellSummary.actualFocusTransitions === 0 &&
        dwellSummary.finalExpectedWindowFocused === true,
      `${mode.key}: the focused Edge window actually changed during the dwell`);
      ensure(classifiedDwellFocus.valid === true,
        `${mode.key}: dwell focus was neither the exact Edge window nor a proven ambient OS focus loss`);
      const alarmEventsAfterDwell = await evaluate(cdp, driverSession,
        `globalThis.__edgeFrozenAlarmMonitor.events.slice(${Number(alarmCheckpoint)})`);
      ensure(alarmEventsAfterDwell.filter(event => event.name === 'number.check').length === 1,
        `${mode.key}: number.check alarm repeated during the stable dwell`);

      await evaluate(cdp, driverSession, `new Promise(resolve => {
        chrome.tabs.remove(${Number(final.id)}, () => {
          void chrome.runtime.lastError;
          resolve(true);
        });
      })`);
      await waitFor(async () => {
        const stored = await evaluate(cdp, driverSession,
          `chrome.storage.session.get('__discardOwnership:tab:${Number(final.id)}')`);
        return Object.keys(stored || {}).length === 0;
      }, `${mode.key}: removed fixture ownership did not clear`, 10000);
    }

    {
      const name = 'discard-tree-active-group-helper-with-direct-native-frozen-child';
      const groupScenario = {
        command: {
          entry: 'chrome.runtime.sendMessage popup command path',
          name: 'discard-tree',
          response: null
        },
        controlWindowClosed: false,
        dwell: {
          durationMilliseconds: DWELL_MS,
          requestCountsStable: false,
          snapshot: null,
          summary: null
        },
        final: {
          helperLifecycle: null,
          requestCounts: null,
          snapshot: null,
          summary: null
        },
        frozen: {
          discarded: null,
          frozen: null,
          requestCountStable: null
        },
        name,
        settings: {
          blankHelper: 'enabled-default',
          favicon: true,
          titleIndicator: 'configured'
        },
        setup: null
      };
      report.scenarios.push(groupScenario);

      await evaluate(cdp, driverSession, `(async () => {
        await chrome.storage.local.set({
          './plugins/blank/core.js': true,
          favicon: true,
          log: true,
          'max.single.discard': 1,
          number: 0,
          period: 0,
          prepends: '\u{1F4A4}'
        });
        return true;
      })()`, 5000, `${name}: settings`);

      const groupCreation = await evaluate(cdp, driverSession, `(async () => {
        const urls = ${JSON.stringify(Object.fromEntries(GROUP_FIXTURE_KEYS.map(key => [key, fixture.urls[key]])))};
        const orderedKeys = ${JSON.stringify(GROUP_FIXTURE_KEYS)};
        const created = await chrome.windows.create({
          focused: true,
          state: 'normal',
          type: 'normal',
          url: urls[orderedKeys[0]]
        });
        const tabs = {[orderedKeys[0]]: created.tabs?.[0]};
        for (const key of orderedKeys.slice(1)) {
          tabs[key] = await chrome.tabs.create({
            active: false,
            url: urls[key],
            windowId: created.id
          });
        }
        const targetKeys = ['group-selected', 'group-loaded', 'group-external'];
        const outsideKeys = ['group-out-loaded', 'group-out-external'];
        const groupId = await chrome.tabs.group({
          createProperties: {windowId: created.id},
          tabIds: targetKeys.map(key => tabs[key].id)
        });
        await chrome.tabs.group({
          createProperties: {windowId: created.id},
          tabIds: outsideKeys.map(key => tabs[key].id)
        });
        const queried = await chrome.tabs.query({windowId: created.id});
        const selected = queried.find(tab => tab.id === tabs['group-selected'].id);
        const outside = queried.find(tab => tab.id === tabs['group-out-loaded'].id);
        // tabs.highlight makes the first listed index active. Establish the
        // grouped popup root as active and both tabs as highlighted atomically; a later
        // tabs.update({active:true}) can collapse the multi-selection in Edge.
        await chrome.tabs.highlight({windowId: created.id, tabs: [selected.index, outside.index]});
        const highlighted = await chrome.tabs.query({windowId: created.id});
        const selectedAfter = highlighted.find(tab => tab.id === selected.id);
        const outsideAfter = highlighted.find(tab => tab.id === outside.id);
        if (selectedAfter?.active !== true || selectedAfter?.highlighted !== true ||
            outsideAfter?.active === true || outsideAfter?.highlighted !== true) {
          throw Error('atomic highlighted group/outside topology did not settle');
        }
        const finalById = new Map(highlighted.map(tab => [tab.id, tab]));
        return {
          groupId,
          tabs: Object.fromEntries(Object.entries(tabs).map(([key, tab]) => [key, {
            groupId: finalById.get(tab.id)?.groupId,
            id: tab.id,
            index: finalById.get(tab.id)?.index,
            url: urls[key]
          }])),
          windowId: created.id
        };
      })()`, 10000, `${name}: dedicated group fixture construction`);
      ensure(Number.isInteger(groupCreation?.windowId) && Number.isInteger(groupCreation.groupId) &&
        Object.values(groupCreation.tabs || {}).every(tab => Number.isInteger(tab.id)),
      `${name}: Edge did not construct the dedicated native tab-group fixture`);
      const groupLayout = {
        expectedOwnership: [
          'group-selected',
          'group-loaded',
          'group-external',
          'group-out-external'
        ],
        groupId: groupCreation.groupId,
        tabs: groupCreation.tabs,
        targets: ['group-selected', 'group-loaded', 'group-external'],
        windowId: groupCreation.windowId
      };

      await waitFor(async () => {
        const snapshot = await evaluate(cdp, driverSession, groupSnapshotExpression(groupLayout), 5000,
          `${name}: group fixture readiness`);
        if (snapshot?.apiError) {
          throw Error(`${name}: ${snapshot.apiError}`);
        }
        return GROUP_FIXTURE_KEYS.every(key => snapshot.tabs?.[key]?.status === 'complete' &&
          snapshot.tabs[key].discarded === false && snapshot.tabs[key].urlMatched === true) ? snapshot : false;
      }, `${name}: all group fixtures did not complete`, 20000, 100);
      ensure(GROUP_FIXTURE_KEYS.every(key => fixture.count(key) === 1),
        `${name}: group fixtures did not each make exactly one initial document request`);

      const externalDiscardResult = await evaluate(cdp, driverSession, `(async () => {
        const ids = ${JSON.stringify([
          groupCreation.tabs['group-external'].id,
          groupCreation.tabs['group-out-external'].id
        ])};
        const results = [];
        for (const id of ids) {
          results.push(await Promise.race([
            chrome.tabs.discard(id),
            new Promise((resolve, reject) => setTimeout(() =>
              reject(Error('tabs.discard API deadline exceeded')), 3000))
          ]));
        }
        return results.map(tab => ({discarded: tab?.discarded === true, status: tab?.status}));
      })()`, 10000, `${name}: external native discards`);
      ensure(Array.isArray(externalDiscardResult) && externalDiscardResult.length === 2,
        `${name}: external discard setup did not return both tabs`);
      await waitFor(async () => {
        const snapshot = await evaluate(cdp, driverSession, groupSnapshotExpression(groupLayout));
        return snapshot.tabs?.['group-external']?.discarded === true &&
          snapshot.tabs['group-external'].status === 'unloaded' &&
          snapshot.tabs['group-external'].source === 'claimed' &&
          snapshot.tabs['group-out-external']?.discarded === true &&
          snapshot.tabs['group-out-external'].status === 'unloaded' &&
          snapshot.tabs['group-out-external'].source === 'claimed' ? snapshot : false;
      }, `${name}: external discards did not become claimed sleepers`, 15000, 100);

      await evaluate(cdp, driverSession,
        groupHelperMonitorInstallExpression(groupCreation.windowId), 5000,
        `${name}: helper lifecycle monitor installation`);
      const preFreeze = await evaluate(cdp, driverSession, groupSnapshotExpression(groupLayout), 5000,
        `${name}: pre-freeze snapshot`);
      groupScenario.setup = {
        preFreezeTopology: {
          helperCount: Number(preFreeze?.helperCount || 0),
          outsideActive: preFreeze?.tabs?.['group-out-loaded']?.active === true,
          outsideHighlighted: preFreeze?.tabs?.['group-out-loaded']?.highlighted === true,
          selectedActive: preFreeze?.tabs?.['group-selected']?.active === true,
          selectedHighlighted: preFreeze?.tabs?.['group-selected']?.highlighted === true,
          targetGroupCount: Number(preFreeze?.targetGroupCount || 0)
        }
      };
      ensure(!preFreeze?.apiError && preFreeze.helperCount === 0 &&
        preFreeze.tabs['group-selected'].active === true &&
        preFreeze.tabs['group-selected'].highlighted === true &&
        preFreeze.tabs['group-out-loaded'].active === false &&
        preFreeze.tabs['group-out-loaded'].highlighted === true &&
        preFreeze.tabs['group-external'].discarded === true &&
        preFreeze.tabs['group-out-external'].discarded === true,
      `${name}: pre-freeze native group/highlight/discard topology is invalid`);

      const keeperUrl = groupCreation.tabs['group-keeper'].url;
      const frozenTargetUrl = groupCreation.tabs['group-loaded'].url;
      const keeperRequestsBeforeFreeze = fixture.count('group-keeper');
      const targetRequestsBeforeFreeze = fixture.count('group-loaded');
      const {targetId: groupControlTargetId} = await cdp.send('Target.createTarget', {
        newWindow: true,
        url: 'edge://discards/'
      });
      ensure(groupControlTargetId, `${name}: Edge did not create a disposable Freeze control`);
      const groupControlWindow = await cdp.send('Browser.getWindowForTarget', {
        targetId: groupControlTargetId
      });
      ensure(Number.isInteger(groupControlWindow?.windowId) && groupControlWindow.windowId > 0,
        `${name}: Edge did not isolate the disposable Freeze control window`);
      const groupControlSession = await attachPage(cdp, groupControlTargetId);
      await waitFor(() => evaluate(cdp, groupControlSession, 'document.readyState === "complete"'),
        `${name}: disposable Freeze control did not become ready`, 15000);
      await waitFor(() => evaluate(cdp, groupControlSession, freezeClickExpression(keeperUrl)),
        `${name}: exact g-keeper Freeze control was not found`, 15000, 250);
      await waitFor(() => evaluate(cdp, groupControlSession, freezeClickExpression(frozenTargetUrl)),
        `${name}: exact grouped target Freeze control was not found`, 15000, 250);
      const frozenGroupKeeper = await waitFor(async () => {
        const snapshot = await evaluate(cdp, driverSession, groupSnapshotExpression(groupLayout));
        const keeper = snapshot.tabs?.['group-keeper'];
        const target = snapshot.tabs?.['group-loaded'];
        return keeper?.frozen === true && keeper.discarded === false &&
          keeper.active === false && keeper.status === 'complete' && keeper.urlMatched === true &&
          target?.frozen === true && target.discarded === false && target.active === false &&
          target.status === 'complete' && target.urlMatched === true ? snapshot : false;
      }, `${name}: protected keeper and grouped target did not retain native frozen state`, 15000, 100);
      groupScenario.frozen = {
        protectedOutside: {
          discarded: frozenGroupKeeper.tabs['group-keeper'].discarded,
          frozen: frozenGroupKeeper.tabs['group-keeper'].frozen
        },
        requestCountStable: fixture.count('group-keeper') === keeperRequestsBeforeFreeze &&
          fixture.count('group-loaded') === targetRequestsBeforeFreeze,
        target: {
          discarded: frozenGroupKeeper.tabs['group-loaded'].discarded,
          frozen: frozenGroupKeeper.tabs['group-loaded'].frozen
        }
      };
      ensure(groupScenario.frozen.requestCountStable,
        `${name}: native Freeze unexpectedly requested a frozen fixture again`);
      await cdp.send('Target.detachFromTarget', {sessionId: groupControlSession});
      const groupControlClosed = await cdp.send('Target.closeTarget', {targetId: groupControlTargetId});
      ensure(groupControlClosed?.success === true,
        `${name}: disposable Freeze control rejected exact close`);
      await waitFor(async () => {
        const {targetInfos = []} = await cdp.send('Target.getTargets');
        return targetInfos.every(info => info.targetId !== groupControlTargetId);
      }, `${name}: disposable Freeze control survived exact close`, 10000, 100);
      groupScenario.controlWindowClosed = true;

      await withTimeout(cdp.send('Target.activateTarget', {targetId: driverTarget.targetId}), 5000,
        `${name}: driver activation after control close timed out`);
      await waitForSetupMonitorSettlement(cdp, driverSession,
        `${name}: delayed control-focus quiescence`, CONTROL_CLOSE_QUIET_MS);
      const groupSelectedTarget = await waitFor(async () => {
        const {targetInfos = []} = await cdp.send('Target.getTargets');
        const exact = targetInfos.filter(info => info.type === 'page' &&
          info.url === groupCreation.tabs['group-selected'].url);
        return exact.length === 1 ? exact[0] : false;
      }, `${name}: exact active group root target was missing or ambiguous`, 10000, 100);
      await withTimeout(cdp.send('Target.activateTarget', {targetId: groupSelectedTarget.targetId}), 5000,
        `${name}: active group root target activation timed out`);
      const settledGroupFocus = await waitForExactFocusedWindowSettlement(
        cdp,
        driverSession,
        groupCreation.windowId,
        `${name}: command focus baseline`
      );
      // Target.activateTarget can collapse Edge's multi-highlight selection.
      // Establish/focus the exact popup renderer first, then make the selected
      // group root active and the outside peer highlighted as the final setup
      // mutation immediately before the command checkpoint.
      const preFinalGroupMonitor = await evaluate(cdp, driverSession, monitorCheckpointExpression,
        5000, `${name}: pre-final-topology monitor checkpoint`);
      const restoreGroupRoot = await evaluate(cdp, driverSession, `(async () => {
        const windowId = ${Number(groupCreation.windowId)};
        const selectedId = ${Number(groupCreation.tabs['group-selected'].id)};
        const outsideId = ${Number(groupCreation.tabs['group-out-loaded'].id)};
        const tabs = await chrome.tabs.query({windowId});
        const selected = tabs.find(tab => tab.id === selectedId);
        const outside = tabs.find(tab => tab.id === outsideId);
        await chrome.tabs.highlight({windowId, tabs: [selected.index, outside.index]});
        return chrome.tabs.query({windowId});
      })()`, 10000, `${name}: final command-root restoration`);
      ensure(Array.isArray(restoreGroupRoot) && restoreGroupRoot.find(tab =>
        tab.id === groupCreation.tabs['group-selected'].id)?.active === true &&
        restoreGroupRoot.find(tab => tab.id === groupCreation.tabs['group-out-loaded'].id)?.active === false &&
        restoreGroupRoot.find(tab => tab.id === groupCreation.tabs['group-out-loaded'].id)?.highlighted === true,
      `${name}: exact active group root plus highlighted outsider were not restored last`);
      const settledFinalGroupMonitor = await waitForSetupMonitorSettlement(cdp, driverSession,
        `${name}: final highlighted topology settlement`);
      ensure(settledFinalGroupMonitor.activations === preFinalGroupMonitor.activations &&
        settledFinalGroupMonitor.focusChanges === preFinalGroupMonitor.focusChanges,
      `${name}: final highlight unexpectedly changed active-tab or window-focus state`);
      const finalGroupFocus = await waitForExactFocusedWindowSettlement(
        cdp,
        driverSession,
        groupCreation.windowId,
        `${name}: final highlighted command focus baseline`
      );
      const noKeeper = await evaluate(cdp, driverSession, groupSnapshotExpression(groupLayout));
      groupScenario.setup = {
        ...groupScenario.setup,
        candidateEvidence: {
          knownRoles: noKeeper.candidateRoles,
          total: noKeeper.candidateCount,
          unknownCount: noKeeper.unknownCandidateCount
        }
      };
      ensure(noKeeper.candidateCount === 0 && noKeeper.helperCount === 0 &&
        noKeeper.tabs['group-keeper'].frozen === true &&
        noKeeper.tabs['group-loaded'].frozen === true &&
        noKeeper.tabs['group-selected'].active === true &&
        noKeeper.tabs['group-out-loaded'].active === false &&
        noKeeper.tabs['group-out-loaded'].highlighted === true &&
        noKeeper.tabs['group-out-external'].discarded === true,
      `${name}: setup unexpectedly retained an eligible loaded keeper (${noKeeper.candidateRoles.join(',') ||
        'unknown-none-listed'}; unknown ${noKeeper.unknownCandidateCount})`);
      for (const key of GROUP_FIXTURE_KEYS) {
        ensure(Number.isInteger(noKeeper.resolvedIds?.[key]) && Number.isInteger(noKeeper.resolvedIndexes?.[key]),
          `${name}: exact pre-command identity was unavailable for ${key}`);
        groupLayout.tabs[key].id = noKeeper.resolvedIds[key];
        groupLayout.tabs[key].index = noKeeper.resolvedIndexes[key];
      }
      groupScenario.setup = {
        ...groupScenario.setup,
        externalGroupMember: 'discarded-claimed',
        groupMemberCount: noKeeper.targetGroupCount,
        helperCount: noKeeper.helperCount,
        noValidKeeper: noKeeper.candidateCount === 0,
        activePopupAnchor: noKeeper.tabs['group-selected'].active === true,
        inactiveChildren: ['group-loaded', 'group-external'].every(key =>
          noKeeper.tabs[key].active === false),
        outsideCandidates: ['native-frozen', 'highlighted-ineligible', 'discarded-claimed'],
        finalHighlightStableMilliseconds: settledFinalGroupMonitor.stableMilliseconds,
        windowFocusStableMilliseconds: Math.min(
          settledGroupFocus.stableMilliseconds,
          finalGroupFocus.stableMilliseconds
        )
      };

      const groupBaselineRequests = Object.fromEntries(GROUP_FIXTURE_KEYS.map(key => [key, fixture.count(key)]));
      takeoverFailureCodes.length = 0;
      const groupCommandCheckpoint = await evaluate(cdp, driverSession, monitorCheckpointExpression);
      const groupResponse = await evaluate(cdp, driverSession, `new Promise(resolve => {
        const timer = setTimeout(() => resolve({apiError: 'popup command response deadline exceeded'}), 30000);
        chrome.runtime.sendMessage({
          method: 'popup',
          cmd: 'discard-tree',
          tabId: ${Number(groupCreation.tabs['group-selected'].id)},
          windowId: ${Number(groupCreation.windowId)},
          shiftKey: false,
          checked: false
        }, response => {
          const error = chrome.runtime.lastError;
          clearTimeout(timer);
          resolve(error ? {apiError: error.message} : response);
        });
      })`, 35000, `${name}: real popup command path`);
      const groupOutcomes = Object.values(groupResponse?.value?.outcomes || {});
      // Persist only the stable, ID-free public contract before asserting it so
      // a real-browser failure remains diagnosable without leaking tab identity.
      groupScenario.command.response = {
        apiError: groupResponse?.apiError ? String(groupResponse.apiError) : null,
        completed: Number(groupResponse?.value?.completed || 0),
        ok: groupResponse?.ok === true,
        outcomeCodes: groupOutcomes.map(outcome => String(outcome?.code || 'unknown')).sort(),
        outcomeStatuses: groupOutcomes.map(outcome => String(outcome?.status || 'unknown')).sort(),
        state: groupResponse?.value?.state || null,
        summary: {
          failed: Number(groupResponse?.value?.summary?.failed || 0),
          skipped: Number(groupResponse?.value?.summary?.skipped || 0),
          success: Number(groupResponse?.value?.summary?.success || 0)
        },
        total: Number(groupResponse?.value?.total || 0)
      };
      // Capture compact post-command evidence before any response assertion.
      // This distinguishes result-accounting failures from helper/execution
      // failures while keeping report data free of tab IDs and URLs.
      const responseBoundaryGroup = await evaluate(cdp, driverSession,
        groupSnapshotExpression(groupLayout), 5000, `${name}: response-boundary group snapshot`);
      const responseBoundaryHelpers = await evaluate(
        cdp, driverSession, groupHelperMonitorSnapshotExpression
      );
      const outcomeByRole = Object.fromEntries(groupLayout.targets.map(role => {
        const currentId = responseBoundaryGroup?.resolvedIds?.[role];
        const predecessorId = groupLayout.tabs[role]?.id;
        const outcome = groupResponse?.value?.outcomes?.[currentId] ||
          groupResponse?.value?.outcomes?.[predecessorId];
        return [role, outcome ? {
          code: String(outcome.code || 'unknown'),
          status: String(outcome.status || 'unknown')
        } : null];
      }));
      groupScenario.command.boundary = {
        helperLifecycle: responseBoundaryHelpers ? {
          created: Number(responseBoundaryHelpers.created || 0),
          current: Number(responseBoundaryHelpers.current || 0),
          maxConcurrent: Number(responseBoundaryHelpers.maxConcurrent || 0),
          removed: Number(responseBoundaryHelpers.removed || 0)
        } : null,
        outcomeByRole,
        snapshot: summarizeGroupSnapshot(responseBoundaryGroup),
        takeoverFailureCodes: [...new Set(takeoverFailureCodes)].sort()
      };
      ensure(!groupResponse?.apiError && groupResponse?.ok === true &&
        groupResponse.value?.state === 'complete' &&
        groupResponse.value.completed === 3 && groupResponse.value.total === 3,
      `${name}: real popup command path did not complete every target`);
      ensure(groupResponse.value.summary?.success === 3 &&
        groupResponse.value.summary?.skipped === 0 && groupResponse.value.summary?.failed === 0 &&
        groupOutcomes.filter(outcome => outcome?.code === 'TAB_DISCARDED').length === 2 &&
        groupOutcomes.filter(outcome =>
          outcome?.code === 'TAB_DISCARDED_VISUAL_UNAVAILABLE').length === 1,
      `${name}: popup result did not report two marked discards plus one visual-unavailable physical discard`);

      const finalGroup = await waitFor(async () => {
        const snapshot = await evaluate(cdp, driverSession, groupSnapshotExpression(groupLayout));
        if (snapshot?.apiError) {
          throw Error(`${name}: ${snapshot.apiError}`);
        }
        const targetsSettled = groupLayout.targets.every(key => {
          const tab = snapshot.tabs?.[key];
          const direct = key === 'group-loaded';
          return tab?.discarded === true && tab.status === 'unloaded' &&
            tab.source === 'self' && tab.markerState === 'owned' &&
            tab.titleMarked === !direct && tab.visualComplete === !direct &&
            tab.visualFavicon === !direct && tab.visualPhysicalOnly === direct &&
            tab.visualRepair === !direct && tab.visualTitle === !direct &&
            tab.visualTitleConfigured === true;
        });
        const helper = snapshot.helpers?.[0];
        return targetsSettled && snapshot.helperCount === 1 && helper?.active === true &&
          helper.discarded === false && helper.frozen === false && helper.registered === true &&
          helper.status === 'complete' && helper.windowMatched === true ? snapshot : false;
      }, `${name}: group targets and their committed helper did not settle`, 30000, 100);
      ensure(finalGroup.ownershipExact === true && finalGroup.helperRegistryEntryCount === 1 &&
        finalGroup.helperTransactionCount === 0 && finalGroup.targetGroupCount === 3 &&
        groupLayout.targets.every(key => finalGroup.tabs[key].groupMatched === true),
      `${name}: settled group ownership/helper registry scope is not exact`);
      ensure(finalGroup.tabs['group-keeper'].frozen === true &&
        finalGroup.tabs['group-keeper'].discarded === false &&
        finalGroup.tabs['group-keeper'].idMatched === true &&
        finalGroup.tabs['group-keeper'].indexMatched === true &&
        finalGroup.tabs['group-keeper'].pinned === false &&
        finalGroup.tabs['group-keeper'].status === 'complete' &&
        finalGroup.tabs['group-keeper'].groupMatched === true &&
        finalGroup.tabs['group-keeper'].urlMatched === true,
      `${name}: native frozen g-keeper was touched by the group command`);
      ensure(finalGroup.tabs['group-out-loaded'].discarded === false &&
        finalGroup.tabs['group-out-loaded'].frozen === false &&
        finalGroup.tabs['group-out-loaded'].active === false &&
        finalGroup.tabs['group-out-loaded'].idMatched === true &&
        finalGroup.tabs['group-out-loaded'].indexMatched === true &&
        finalGroup.tabs['group-out-loaded'].pinned === false &&
        finalGroup.tabs['group-out-loaded'].status === 'complete' &&
        finalGroup.tabs['group-out-loaded'].source === null &&
        finalGroup.tabs['group-out-loaded'].groupMatched === true &&
        finalGroup.tabs['group-out-loaded'].urlMatched === true,
      `${name}: highlighted outside loaded candidate was touched`);
      ensure(finalGroup.tabs['group-out-external'].discarded === true &&
        finalGroup.tabs['group-out-external'].frozen === false &&
        finalGroup.tabs['group-out-external'].idMatched === true &&
        finalGroup.tabs['group-out-external'].indexMatched === true &&
        finalGroup.tabs['group-out-external'].pinned === false &&
        finalGroup.tabs['group-out-external'].status === 'unloaded' &&
        finalGroup.tabs['group-out-external'].source === 'claimed' &&
        finalGroup.tabs['group-out-external'].groupMatched === true &&
        finalGroup.tabs['group-out-external'].urlMatched === true,
      `${name}: outside external sleeper did not remain asleep`);
      for (const key of GROUP_FIXTURE_KEYS) {
        ensure(fixture.count(key) === groupBaselineRequests[key] + (key === 'group-external' ? 1 : 0),
          `${name}: unexpected document request delta for ${key}`);
      }
      const helperLifecycle = await evaluate(cdp, driverSession, groupHelperMonitorSnapshotExpression);
      ensure(helperLifecycle?.created === 1 && helperLifecycle.current === 1 &&
        helperLifecycle.maxConcurrent === 1 && helperLifecycle.removed === 0,
      `${name}: the group command did not retain exactly one helper`);
      ensure(Array.isArray(finalGroup.helperIds) && finalGroup.helperIds.length === 1,
        `${name}: exact helper identity was unavailable for activity accounting`);
      const helperId = finalGroup.helperIds[0];
      const commandGroupSummary = await evaluate(cdp, driverSession, groupActivitySummaryExpression({
        checkpoint: groupCommandCheckpoint,
        expectedFocusedWindowId: groupCreation.windowId,
        externalId: groupCreation.tabs['group-external'].id,
        helperId,
        protectedIds: [
          groupCreation.tabs['group-keeper'].id,
          groupCreation.tabs['group-out-loaded'].id,
          groupCreation.tabs['group-out-external'].id
        ],
        selectedId: groupCreation.tabs['group-selected'].id,
        targetIds: groupLayout.targets.map(key => groupCreation.tabs[key].id)
      }));
      groupScenario.final.helperLifecycle = helperLifecycle;
      groupScenario.final.requestCounts = Object.fromEntries(GROUP_FIXTURE_KEYS.map(key => [key, fixture.count(key)]));
      groupScenario.final.snapshot = summarizeGroupSnapshot(finalGroup);
      groupScenario.final.outsideHighlight = finalGroup.tabs['group-out-loaded'].highlighted;
      groupScenario.final.summary = summarizeGroupActivity(commandGroupSummary);
      const postCommandGroupFocus = await evaluate(cdp, driverSession,
        focusStateExpression(groupCreation.windowId));
      const classifiedGroupCommandFocus = classifyCommandFocusState(
        commandGroupSummary,
        postCommandGroupFocus,
        {requireCurrentMatched: false}
      );
      groupScenario.final.focusState = classifiedGroupCommandFocus;
      ensure(commandGroupSummary.externalAwakeEpisodes === 1 &&
        commandGroupSummary.loadingSignals >= 1 && commandGroupSummary.wakeSignals >= 1 &&
        commandGroupSummary.externalActivations === 0 &&
        commandGroupSummary.helperActivations === 1 && commandGroupSummary.selectedActivations === 0 &&
        commandGroupSummary.targetActivations === 0 &&
        commandGroupSummary.protectedActivations === 0 && commandGroupSummary.protectedEventCount === 0,
      `${name}: command activity was not one bounded external takeover with protected outsiders untouched`);
      ensure(classifiedGroupCommandFocus.valid === true,
      `${name}: command focus was neither the exact Edge window nor a proven ambient OS focus loss`);

      const groupDwellCheckpoint = await evaluate(cdp, driverSession, monitorCheckpointExpression);
      const groupDwellBaselineFocused =
        classifiedGroupCommandFocus.focusMode !== 'ambient-os-unfocused';
      const dwellBaselineRequests = Object.fromEntries(GROUP_FIXTURE_KEYS.map(key => [key, fixture.count(key)]));
      await sleep(DWELL_MS);
      const afterGroupDwell = await evaluate(cdp, driverSession, groupSnapshotExpression(groupLayout));
      const dwellHelperLifecycle = await evaluate(cdp, driverSession, groupHelperMonitorSnapshotExpression);
      const dwellGroupSummary = await evaluate(cdp, driverSession, groupActivitySummaryExpression({
        baselineExpectedWindowFocused: groupDwellBaselineFocused,
        checkpoint: groupDwellCheckpoint,
        expectedFocusedWindowId: groupCreation.windowId,
        externalId: groupCreation.tabs['group-external'].id,
        helperId,
        protectedIds: [
          groupCreation.tabs['group-keeper'].id,
          groupCreation.tabs['group-out-loaded'].id,
          groupCreation.tabs['group-out-external'].id
        ],
        selectedId: groupCreation.tabs['group-selected'].id,
        targetIds: groupLayout.targets.map(key => groupCreation.tabs[key].id)
      }));
      const dwellRequestsStable = GROUP_FIXTURE_KEYS.every(key => fixture.count(key) === dwellBaselineRequests[key]);
      const postDwellGroupFocus = await evaluate(cdp, driverSession,
        focusStateExpression(groupCreation.windowId));
      const classifiedGroupDwellFocus = classifyDwellFocusState(postDwellGroupFocus, {
        requireCurrentMatched: false
      });
      groupScenario.dwell.requestCountsStable = dwellRequestsStable;
      groupScenario.dwell.snapshot = summarizeGroupSnapshot(afterGroupDwell);
      groupScenario.dwell.summary = summarizeGroupActivity(dwellGroupSummary);
      groupScenario.dwell.focusState = classifiedGroupDwellFocus;
      ensure(dwellRequestsStable && afterGroupDwell.helperCount === 1 &&
        afterGroupDwell.helperRegistryEntryCount === 1 && afterGroupDwell.helperTransactionCount === 0 &&
        afterGroupDwell.targetGroupCount === 3 &&
        afterGroupDwell.helpers?.length === 1 && afterGroupDwell.helpers[0].active === true &&
        afterGroupDwell.helpers[0].discarded === false && afterGroupDwell.helpers[0].frozen === false &&
        afterGroupDwell.helpers[0].registered === true && afterGroupDwell.helpers[0].status === 'complete' &&
        afterGroupDwell.helpers[0].windowMatched === true &&
        afterGroupDwell.tabs['group-keeper'].frozen === true &&
        afterGroupDwell.tabs['group-keeper'].discarded === false &&
        afterGroupDwell.tabs['group-keeper'].idMatched === true &&
        afterGroupDwell.tabs['group-keeper'].indexMatched === true &&
        afterGroupDwell.tabs['group-keeper'].pinned === false &&
        afterGroupDwell.tabs['group-keeper'].status === 'complete' &&
        afterGroupDwell.tabs['group-keeper'].groupMatched === true &&
        afterGroupDwell.tabs['group-keeper'].urlMatched === true &&
        afterGroupDwell.tabs['group-out-loaded'].discarded === false &&
        afterGroupDwell.tabs['group-out-loaded'].frozen === false &&
        afterGroupDwell.tabs['group-out-loaded'].active === false &&
        afterGroupDwell.tabs['group-out-loaded'].idMatched === true &&
        afterGroupDwell.tabs['group-out-loaded'].indexMatched === true &&
        afterGroupDwell.tabs['group-out-loaded'].pinned === false &&
        afterGroupDwell.tabs['group-out-loaded'].status === 'complete' &&
        afterGroupDwell.tabs['group-out-loaded'].source === null &&
        afterGroupDwell.tabs['group-out-loaded'].groupMatched === true &&
        afterGroupDwell.tabs['group-out-loaded'].urlMatched === true &&
        afterGroupDwell.tabs['group-out-external'].discarded === true &&
        afterGroupDwell.tabs['group-out-external'].frozen === false &&
        afterGroupDwell.tabs['group-out-external'].idMatched === true &&
        afterGroupDwell.tabs['group-out-external'].indexMatched === true &&
        afterGroupDwell.tabs['group-out-external'].pinned === false &&
        afterGroupDwell.tabs['group-out-external'].status === 'unloaded' &&
        afterGroupDwell.tabs['group-out-external'].source === 'claimed' &&
        afterGroupDwell.tabs['group-out-external'].groupMatched === true &&
        afterGroupDwell.tabs['group-out-external'].urlMatched === true &&
        groupLayout.targets.every(key => afterGroupDwell.tabs[key].discarded === true &&
          afterGroupDwell.tabs[key].source === 'self' &&
          afterGroupDwell.tabs[key].groupMatched === true) &&
        afterGroupDwell.tabs['group-loaded'].visualPhysicalOnly === true &&
        afterGroupDwell.tabs['group-loaded'].visualComplete === false &&
        afterGroupDwell.tabs['group-loaded'].visualRepair === false &&
        afterGroupDwell.tabs['group-selected'].visualComplete === true &&
        afterGroupDwell.tabs['group-external'].visualComplete === true &&
        dwellHelperLifecycle.created === 1 && dwellHelperLifecycle.current === 1 &&
        dwellHelperLifecycle.maxConcurrent === 1 && dwellHelperLifecycle.removed === 0 &&
        dwellGroupSummary.loadingSignals === 0 &&
        dwellGroupSummary.wakeSignals === 0 && dwellGroupSummary.targetActivations === 0 &&
        dwellGroupSummary.helperActivations === 0 && dwellGroupSummary.externalActivations === 0 &&
        dwellGroupSummary.selectedActivations === 0 &&
        dwellGroupSummary.protectedActivations === 0 && dwellGroupSummary.protectedEventCount === 0 &&
        dwellGroupSummary.actualFocusTransitions === 0 &&
        dwellGroupSummary.finalExpectedWindowFocused === groupDwellBaselineFocused &&
        classifiedGroupDwellFocus.valid === true,
      `${name}: delayed helper growth, wake/loading loop, or state drift occurred during dwell`);

      await evaluate(cdp, driverSession, `new Promise(resolve => {
        chrome.windows.remove(${Number(groupCreation.windowId)}, () => {
          void chrome.runtime.lastError;
          resolve(true);
        });
      })`, 10000, `${name}: fixture window cleanup`);
      await waitFor(() => evaluate(cdp, driverSession, `new Promise(resolve => {
        chrome.windows.get(${Number(groupCreation.windowId)}, () => {
          const missing = Boolean(chrome.runtime.lastError);
          resolve(missing);
        });
      })`), `${name}: fixture window did not close before helper recovery`, 10000, 100);
      const helperRecovery = await evaluate(cdp, driverSession, `(async () => {
        const {helperRegistry} = await import(
          chrome.runtime.getURL('worker/core/helper-registry.mjs')
        );
        const removed = await helperRegistry.cleanup();
        const stored = await chrome.storage.session.get('__blankHelperRegistry');
        return {
          registryAbsent: stored.__blankHelperRegistry === undefined,
          removedCount: removed.length
        };
      })()`, 10000, `${name}: production helper-registry recovery`);
      ensure(helperRecovery?.registryAbsent === true && helperRecovery.removedCount === 1,
        `${name}: production helper-registry recovery did not reap the one closed committed helper`);
      await waitFor(async () => {
        const stored = await evaluate(cdp, driverSession, 'chrome.storage.session.get(null)');
        return Object.keys(stored).every(key => !key.startsWith('__discardOwnership:tab:')) &&
          stored.__blankHelperRegistry === undefined;
      }, `${name}: group ownership/helper cleanup did not settle`, 10000, 100);
      groupScenario.cleanup = {
        helperRegistryAbsent: true,
        helperRegistryRecovery: {
          path: 'production-helper-registry-cleanup',
          removedCount: helperRecovery.removedCount
        },
        windowClosed: true
      };
    }

    {
      const name = 'discard-tree-active-group-no-helper-partial-with-direct-native-frozen-child';
      const noHelperScenario = {
        artifact: {
          treeSha256: report.extension.treeSha256,
          treeSha256Verified: false
        },
        cleanup: null,
        command: {
          entry: 'chrome.runtime.sendMessage popup command path',
          name: 'discard-tree',
          response: null
        },
        controlWindowClosed: false,
        dwell: {
          durationMilliseconds: DWELL_MS,
          requestCountsStable: false,
          snapshot: null,
          summary: null
        },
        final: {
          helperLifecycle: null,
          requestCounts: null,
          snapshot: null,
          summary: null
        },
        frozen: {
          discarded: null,
          frozen: null,
          requestCountStable: null
        },
        name,
        settings: {
          blankHelper: 'disabled-local-preference',
          blankHelperPreferenceRestored: false,
          favicon: true,
          titleIndicator: 'configured'
        },
        setup: null
      };
      report.scenarios.push(noHelperScenario);

      const blankPreferenceBefore = await evaluate(cdp, driverSession, `(async () => {
        const key = './plugins/blank/core.js';
        const stored = await chrome.storage.local.get(key);
        const present = Object.prototype.hasOwnProperty.call(stored, key);
        return {present, value: present ? stored[key] === true : null};
      })()`, 5000, `${name}: capture blank-helper preference`);
      let noHelperControlSession;
      let noHelperControlTargetId;
      let noHelperLiveWorkerSession;
      let noHelperLiveWorkerTargetId;
      let stopNoHelperDisableListener;
      let noHelperWindowId;
      let phaseFailure;
      try {
        ensure(blankPreferenceBefore.present === true && blankPreferenceBefore.value === true,
          `${name}: blank helper was not enabled before the disable fence`);
        // Attach before changing the preference. Dynamic import from a DevTools
        // evaluation is not supported in Edge's ServiceWorkerGlobalScope, so
        // the authoritative boundary is the production module's own log after
        // its synchronous storage.onChanged -> blank.disable() -> release()
        // path runs in this exact worker realm.
        const liveBlankWorker = await waitFor(async () => {
          const {targetInfos = []} = await cdp.send('Target.getTargets');
          const matches = targetInfos.filter(info =>
            info.type === 'service_worker' &&
            /^(?:chrome|edge)-extension:\/\//.test(info.url) &&
            new URL(info.url).pathname === workerPath);
          if (matches.length !== 1) {
            return false;
          }
          return {
            sessionId: await attachPage(cdp, matches[0].targetId),
            targetId: matches[0].targetId
          };
        }, `${name}: current extension worker was missing or ambiguous`, 10000, 100);
        noHelperLiveWorkerSession = liveBlankWorker.sessionId;
        noHelperLiveWorkerTargetId = liveBlankWorker.targetId;
        let blankDisableObserved = false;
        stopNoHelperDisableListener = cdp.onEvent(message => {
          if (message.sessionId !== noHelperLiveWorkerSession ||
              message.method !== 'Runtime.consoleAPICalled') {
            return;
          }
          const values = (message.params?.args || []).map(argument => argument.value)
            .filter(value => typeof value === 'string');
          if (values.includes('blank.disable is called')) {
            blankDisableObserved = true;
          }
        });
        const disabledPreference = await evaluate(cdp, driverSession, `(async () => {
          const key = './plugins/blank/core.js';
          await chrome.storage.local.set({[key]: false});
          const stored = await chrome.storage.local.get(key);
          return stored[key] === false;
        })()`, 5000, `${name}: disable blank helper through extension preference`);
        ensure(disabledPreference === true,
          `${name}: blank helper preference did not become disabled`);
        await waitFor(() => blankDisableObserved,
          `${name}: live worker did not release the blank-helper interrupt`, 10000, 50);

        const noHelperCreation = await evaluate(cdp, driverSession, `(async () => {
          const urls = ${JSON.stringify(Object.fromEntries(
    NO_HELPER_FIXTURE_KEYS.map(key => [key, fixture.urls[key]])
  ))};
          const orderedKeys = ${JSON.stringify(NO_HELPER_FIXTURE_KEYS)};
          const created = await chrome.windows.create({
            focused: true,
            state: 'normal',
            type: 'normal',
            url: urls[orderedKeys[0]]
          });
          const tabs = {[orderedKeys[0]]: created.tabs?.[0]};
          for (const key of orderedKeys.slice(1)) {
            tabs[key] = await chrome.tabs.create({
              active: false,
              url: urls[key],
              windowId: created.id
            });
          }
          const groupId = await chrome.tabs.group({
            createProperties: {windowId: created.id},
            tabIds: orderedKeys.map(key => tabs[key].id)
          });
          const queried = await chrome.tabs.query({windowId: created.id});
          const byId = new Map(queried.map(tab => [tab.id, tab]));
          return {
            groupId,
            tabs: Object.fromEntries(Object.entries(tabs).map(([key, tab]) => [key, {
              groupId: byId.get(tab.id)?.groupId,
              id: tab.id,
              index: byId.get(tab.id)?.index,
              url: urls[key]
            }])),
            windowId: created.id
          };
        })()`, 10000, `${name}: dedicated no-helper group fixture construction`);
        ensure(Number.isInteger(noHelperCreation?.windowId) &&
          Number.isInteger(noHelperCreation.groupId) &&
          Object.values(noHelperCreation.tabs || {}).every(tab => Number.isInteger(tab.id)),
        `${name}: Edge did not construct the dedicated no-helper native group`);
        noHelperWindowId = noHelperCreation.windowId;
        const noHelperLayout = {
          expectedOwnership: [
            'no-helper-loaded',
            'no-helper-frozen',
            'no-helper-external'
          ],
          groupId: noHelperCreation.groupId,
          tabs: noHelperCreation.tabs,
          targets: [...NO_HELPER_FIXTURE_KEYS],
          windowId: noHelperCreation.windowId
        };

        await waitFor(async () => {
          const snapshot = await evaluate(cdp, driverSession,
            groupSnapshotExpression(noHelperLayout), 5000,
            `${name}: no-helper fixture readiness`);
          if (snapshot?.apiError) {
            throw Error(`${name}: ${snapshot.apiError}`);
          }
          return NO_HELPER_FIXTURE_KEYS.every(key =>
            snapshot.tabs?.[key]?.status === 'complete' &&
            snapshot.tabs[key].discarded === false &&
            snapshot.tabs[key].urlMatched === true) ? snapshot : false;
        }, `${name}: all no-helper fixtures did not complete`, 20000, 100);
        ensure(NO_HELPER_FIXTURE_KEYS.every(key => fixture.count(key) === 1),
          `${name}: no-helper fixtures did not each make one initial request`);

        const externalDiscard = await evaluate(cdp, driverSession, `Promise.race([
          chrome.tabs.discard(${Number(noHelperCreation.tabs['no-helper-external'].id)}),
          new Promise((resolve, reject) => setTimeout(() =>
            reject(Error('tabs.discard API deadline exceeded')), 3000))
        ]).then(tab => ({discarded: tab?.discarded === true, status: tab?.status}))`,
        5000, `${name}: external native discard`);
        ensure(externalDiscard?.discarded === true || externalDiscard?.status === 'unloaded',
          `${name}: external discard setup was not accepted`);
        await waitFor(async () => {
          const snapshot = await evaluate(cdp, driverSession,
            groupSnapshotExpression(noHelperLayout));
          const external = snapshot.tabs?.['no-helper-external'];
          return external?.discarded === true && external.status === 'unloaded' &&
            external.source === 'claimed' ? snapshot : false;
        }, `${name}: external child did not become a claimed sleeper`, 15000, 100);

        await evaluate(cdp, driverSession,
          groupHelperMonitorInstallExpression(noHelperCreation.windowId), 5000,
          `${name}: no-helper lifecycle monitor installation`);
        const frozenUrl = noHelperCreation.tabs['no-helper-frozen'].url;
        const frozenRequestsBeforeFreeze = fixture.count('no-helper-frozen');
        const controlCreation = await cdp.send('Target.createTarget', {
          newWindow: true,
          url: 'edge://discards/'
        });
        noHelperControlTargetId = controlCreation.targetId;
        ensure(noHelperControlTargetId,
          `${name}: Edge did not create a disposable Freeze control`);
        const noHelperControlWindow = await cdp.send('Browser.getWindowForTarget', {
          targetId: noHelperControlTargetId
        });
        ensure(Number.isInteger(noHelperControlWindow?.windowId) &&
          noHelperControlWindow.windowId > 0,
        `${name}: Edge did not isolate the disposable Freeze control window`);
        noHelperControlSession = await attachPage(cdp, noHelperControlTargetId);
        await waitFor(() => evaluate(cdp, noHelperControlSession,
          'document.readyState === "complete"'),
        `${name}: disposable Freeze control did not become ready`, 15000);
        await waitFor(() => evaluate(cdp, noHelperControlSession,
          freezeClickExpression(frozenUrl)),
        `${name}: exact no-helper frozen child control was not found`, 15000, 250);
        const frozenChild = await waitFor(async () => {
          const snapshot = await evaluate(cdp, driverSession,
            groupSnapshotExpression(noHelperLayout));
          const frozen = snapshot.tabs?.['no-helper-frozen'];
          return frozen?.frozen === true && frozen.discarded === false &&
            frozen.active === false && frozen.status === 'complete' &&
            frozen.urlMatched === true ? snapshot : false;
        }, `${name}: inactive child did not retain native frozen state`, 15000, 100);
        noHelperScenario.frozen = {
          discarded: frozenChild.tabs['no-helper-frozen'].discarded,
          frozen: frozenChild.tabs['no-helper-frozen'].frozen,
          requestCountStable: fixture.count('no-helper-frozen') ===
            frozenRequestsBeforeFreeze
        };
        ensure(noHelperScenario.frozen.requestCountStable,
          `${name}: native Freeze unexpectedly requested the frozen child again`);
        await cdp.send('Target.detachFromTarget', {sessionId: noHelperControlSession});
        noHelperControlSession = undefined;
        const noHelperControlClosed = await cdp.send('Target.closeTarget', {
          targetId: noHelperControlTargetId
        });
        ensure(noHelperControlClosed?.success === true,
          `${name}: disposable Freeze control rejected exact close`);
        await waitFor(async () => {
          const {targetInfos = []} = await cdp.send('Target.getTargets');
          return targetInfos.every(info => info.targetId !== noHelperControlTargetId);
        }, `${name}: disposable Freeze control survived exact close`, 10000, 100);
        noHelperControlTargetId = undefined;
        noHelperScenario.controlWindowClosed = true;

        await withTimeout(cdp.send('Target.activateTarget', {
          targetId: driverTarget.targetId
        }), 5000, `${name}: driver activation after control close timed out`);
        await waitForSetupMonitorSettlement(cdp, driverSession,
          `${name}: delayed control-focus quiescence`, CONTROL_CLOSE_QUIET_MS);
        const noHelperRootTarget = await waitFor(async () => {
          const {targetInfos = []} = await cdp.send('Target.getTargets');
          const exact = targetInfos.filter(info => info.type === 'page' &&
            info.url === noHelperCreation.tabs['no-helper-root'].url);
          return exact.length === 1 ? exact[0] : false;
        }, `${name}: exact active group root target was missing or ambiguous`, 10000, 100);
        await withTimeout(cdp.send('Target.activateTarget', {
          targetId: noHelperRootTarget.targetId
        }), 5000, `${name}: active no-helper group root activation timed out`);
        const noHelperFocus = await waitForExactFocusedWindowSettlement(
          cdp,
          driverSession,
          noHelperCreation.windowId,
          `${name}: command focus baseline`
        );
        const settledNoHelperMonitor = await waitForSetupMonitorSettlement(cdp,
          driverSession, `${name}: final active-root settlement`);
        const noKeeper = await evaluate(cdp, driverSession,
          groupSnapshotExpression(noHelperLayout));
        for (const key of NO_HELPER_FIXTURE_KEYS) {
          noHelperLayout.tabs[key].id = noKeeper.resolvedIds[key];
          noHelperLayout.tabs[key].index = noKeeper.resolvedIndexes[key];
        }
        noHelperScenario.setup = {
          activePopupAnchor: noKeeper.tabs['no-helper-root'].active === true,
          candidateEvidence: {
            knownRoles: noKeeper.candidateRoles,
            total: noKeeper.candidateCount,
            unknownCount: noKeeper.unknownCandidateCount
          },
          helperCount: noKeeper.helperCount,
          inactiveChildren: [
            'no-helper-loaded',
            'no-helper-frozen',
            'no-helper-external'
          ].every(key => noKeeper.tabs[key].active === false),
          targetGroupCount: noKeeper.targetGroupCount,
          windowFocusStableMilliseconds: noHelperFocus.stableMilliseconds
        };
        ensure(noKeeper.candidateCount === 0 && noKeeper.helperCount === 0 &&
          noKeeper.helperRegistryEntryCount === 0 &&
          noKeeper.helperTransactionCount === 0 &&
          noKeeper.targetGroupCount === 4 &&
          noKeeper.tabs['no-helper-root'].active === true &&
          noKeeper.tabs['no-helper-root'].discarded === false &&
          noKeeper.tabs['no-helper-loaded'].active === false &&
          noKeeper.tabs['no-helper-loaded'].discarded === false &&
          noKeeper.tabs['no-helper-frozen'].active === false &&
          noKeeper.tabs['no-helper-frozen'].frozen === true &&
          noKeeper.tabs['no-helper-external'].active === false &&
          noKeeper.tabs['no-helper-external'].discarded === true,
        `${name}: exact active-root/no-eligible-keeper topology is invalid`);

        const noHelperBaselineRequests = Object.fromEntries(
          NO_HELPER_FIXTURE_KEYS.map(key => [key, fixture.count(key)])
        );
        takeoverFailureCodes.length = 0;
        const currentWorkerTargets = (await cdp.send('Target.getTargets')).targetInfos || [];
        const currentWorker = currentWorkerTargets.filter(info =>
          info.type === 'service_worker' &&
          /^(?:chrome|edge)-extension:\/\//.test(info.url) &&
          new URL(info.url).pathname === workerPath);
        ensure(currentWorker.length === 1 &&
          currentWorker[0].targetId === noHelperLiveWorkerTargetId,
        `${name}: inspected worker changed before the popup command`);
        const liveWorkerStillDisabled = await evaluate(cdp, noHelperLiveWorkerSession, `(async () => {
          const key = './plugins/blank/core.js';
          const stored = await chrome.storage.local.get(key);
          return stored[key] === false;
        })()`, 3000, `${name}: final live blank-helper interrupt fence`);
        ensure(liveWorkerStillDisabled === true,
          `${name}: blank-helper interrupt changed before the popup command`);
        const noHelperCommandCheckpoint = await evaluate(cdp, driverSession,
          monitorCheckpointExpression);
        const noHelperResponse = await evaluate(cdp, driverSession, `new Promise(resolve => {
          const timer = setTimeout(() => resolve({apiError: 'popup command response deadline exceeded'}), 30000);
          chrome.runtime.sendMessage({
            method: 'popup',
            cmd: 'discard-tree',
            tabId: ${Number(noHelperLayout.tabs['no-helper-root'].id)},
            windowId: ${Number(noHelperCreation.windowId)},
            shiftKey: false,
            checked: false
          }, response => {
            const error = chrome.runtime.lastError;
            clearTimeout(timer);
            resolve(error ? {apiError: error.message} : response);
          });
        })`, 35000, `${name}: real popup command path`);
        const noHelperOutcomes = Object.values(noHelperResponse?.value?.outcomes || {});
        noHelperScenario.command.response = {
          apiError: noHelperResponse?.apiError ? String(noHelperResponse.apiError) : null,
          completed: Number(noHelperResponse?.value?.completed || 0),
          ok: noHelperResponse?.ok === true,
          outcomeCodes: noHelperOutcomes.map(outcome =>
            String(outcome?.code || 'unknown')).sort(),
          outcomeStatuses: noHelperOutcomes.map(outcome =>
            String(outcome?.status || 'unknown')).sort(),
          state: noHelperResponse?.value?.state || null,
          summary: {
            failed: Number(noHelperResponse?.value?.summary?.failed || 0),
            skipped: Number(noHelperResponse?.value?.summary?.skipped || 0),
            success: Number(noHelperResponse?.value?.summary?.success || 0)
          },
          total: Number(noHelperResponse?.value?.total || 0)
        };
        const responseBoundaryNoHelper = await evaluate(cdp, driverSession,
          groupSnapshotExpression(noHelperLayout), 5000,
          `${name}: response-boundary no-helper snapshot`);
        const responseBoundaryNoHelperLifecycle = await evaluate(
          cdp, driverSession, groupHelperMonitorSnapshotExpression
        );
        const outcomeByRole = Object.fromEntries(NO_HELPER_FIXTURE_KEYS.map(role => {
          const currentId = responseBoundaryNoHelper?.resolvedIds?.[role];
          const predecessorId = noHelperLayout.tabs[role]?.id;
          const outcome = noHelperResponse?.value?.outcomes?.[currentId] ||
            noHelperResponse?.value?.outcomes?.[predecessorId];
          return [role, outcome ? {
            code: String(outcome.code || 'unknown'),
            status: String(outcome.status || 'unknown')
          } : null];
        }));
        noHelperScenario.command.boundary = {
          helperLifecycle: responseBoundaryNoHelperLifecycle ? {
            created: Number(responseBoundaryNoHelperLifecycle.created || 0),
            current: Number(responseBoundaryNoHelperLifecycle.current || 0),
            maxConcurrent: Number(responseBoundaryNoHelperLifecycle.maxConcurrent || 0),
            removed: Number(responseBoundaryNoHelperLifecycle.removed || 0)
          } : null,
          outcomeByRole,
          snapshot: summarizeGroupSnapshot(responseBoundaryNoHelper),
          takeoverFailureCodes: [...new Set(takeoverFailureCodes)].sort()
        };
        ensure(!noHelperResponse?.apiError && noHelperResponse?.ok === true &&
          noHelperResponse.value?.state === 'partial' &&
          noHelperResponse.value.completed === 4 &&
          noHelperResponse.value.total === 4,
        `${name}: real popup command did not return terminal partial 4/4`);
        ensure(noHelperResponse.value.summary?.success === 3 &&
          noHelperResponse.value.summary?.skipped === 1 &&
          noHelperResponse.value.summary?.failed === 0 &&
          noHelperOutcomes.length === 4 &&
          noHelperOutcomes.filter(outcome =>
            outcome?.code === 'TAB_NO_SAFE_KEEPER').length === 1 &&
          noHelperOutcomes.filter(outcome =>
            outcome?.code === 'TAB_DISCARDED').length === 2 &&
          noHelperOutcomes.filter(outcome =>
            outcome?.code === 'TAB_DISCARDED_VISUAL_UNAVAILABLE').length === 1 &&
          outcomeByRole['no-helper-root']?.code === 'TAB_NO_SAFE_KEEPER' &&
          outcomeByRole['no-helper-root']?.status === 'skipped' &&
          outcomeByRole['no-helper-loaded']?.code === 'TAB_DISCARDED' &&
          outcomeByRole['no-helper-frozen']?.code ===
            'TAB_DISCARDED_VISUAL_UNAVAILABLE' &&
          outcomeByRole['no-helper-external']?.code === 'TAB_DISCARDED',
        `${name}: partial response did not preserve the exact role dispositions`);

        const finalNoHelper = await waitFor(async () => {
          const snapshot = await evaluate(cdp, driverSession,
            groupSnapshotExpression(noHelperLayout));
          if (snapshot?.apiError) {
            throw Error(`${name}: ${snapshot.apiError}`);
          }
          const root = snapshot.tabs?.['no-helper-root'];
          const childrenSettled = [
            'no-helper-loaded',
            'no-helper-frozen',
            'no-helper-external'
          ].every(key => {
            const tab = snapshot.tabs?.[key];
            const direct = key === 'no-helper-frozen';
            return tab?.discarded === true && tab.status === 'unloaded' &&
              tab.source === 'self' && tab.markerState === 'owned' &&
              tab.titleMarked === !direct && tab.visualComplete === !direct &&
              tab.visualFavicon === !direct &&
              tab.visualPhysicalOnly === direct &&
              tab.visualRepair === !direct && tab.visualTitle === !direct &&
              tab.visualTitleConfigured === true;
          });
          return root?.active === true && root.discarded === false &&
            root.frozen === false && root.status === 'complete' &&
            root.markerState === null && root.source === null &&
            root.titleMarked === false && root.visualComplete === false &&
            root.visualFavicon === false && root.visualPhysicalOnly === false &&
            root.visualRepair === false && root.visualTitle === false &&
            childrenSettled && snapshot.helperCount === 0 ? snapshot : false;
        }, `${name}: partial target states did not settle`, 30000, 100);
        ensure(finalNoHelper.ownershipExact === true &&
          finalNoHelper.helperCount === 0 &&
          finalNoHelper.helperRegistryEntryCount === 0 &&
          finalNoHelper.helperTransactionCount === 0 &&
          finalNoHelper.targetGroupCount === 4 &&
          NO_HELPER_FIXTURE_KEYS.every(key =>
            finalNoHelper.tabs[key].groupMatched === true),
        `${name}: exact no-helper ownership/group scope is invalid`);
        ensure(finalNoHelper.tabs['no-helper-root'].idMatched === true &&
          finalNoHelper.tabs['no-helper-root'].indexMatched === true &&
          finalNoHelper.tabs['no-helper-root'].urlMatched === true &&
          finalNoHelper.tabs['no-helper-root'].pinned === false,
        `${name}: active root moved, unloaded, or became owned`);
        for (const key of NO_HELPER_FIXTURE_KEYS) {
          ensure(fixture.count(key) === noHelperBaselineRequests[key] +
            (key === 'no-helper-external' ? 1 : 0),
          `${name}: unexpected document request delta for ${key}`);
        }
        const noHelperLifecycle = await evaluate(cdp, driverSession,
          groupHelperMonitorSnapshotExpression);
        ensure(noHelperLifecycle?.created === 0 &&
          noHelperLifecycle.current === 0 &&
          noHelperLifecycle.maxConcurrent === 0 &&
          noHelperLifecycle.removed === 0,
        `${name}: disabled blank-helper preference still created a helper`);
        const noHelperCommandSummary = await evaluate(cdp, driverSession,
          noHelperActivitySummaryExpression({
            checkpoint: noHelperCommandCheckpoint,
            expectedFocusedWindowId: noHelperCreation.windowId,
            externalId: noHelperLayout.tabs['no-helper-external'].id,
            frozenId: noHelperLayout.tabs['no-helper-frozen'].id,
            loadedId: noHelperLayout.tabs['no-helper-loaded'].id,
            rootId: noHelperLayout.tabs['no-helper-root'].id,
            targetIds: NO_HELPER_FIXTURE_KEYS.map(key =>
              noHelperLayout.tabs[key].id)
          }));
        const postCommandNoHelperFocus = await evaluate(cdp, driverSession,
          focusStateExpression(noHelperCreation.windowId));
        const classifiedNoHelperCommandFocus = classifyCommandFocusState(
          noHelperCommandSummary,
          postCommandNoHelperFocus,
          {requireCurrentMatched: false}
        );
        noHelperScenario.final.helperLifecycle = noHelperLifecycle;
        noHelperScenario.final.requestCounts = Object.fromEntries(
          NO_HELPER_FIXTURE_KEYS.map(key => [key, fixture.count(key)])
        );
        noHelperScenario.final.snapshot = summarizeGroupSnapshot(finalNoHelper);
        noHelperScenario.final.summary = {
          actualFocusTransitions: Number(noHelperCommandSummary.actualFocusTransitions || 0),
          externalActivations: Number(noHelperCommandSummary.externalActivations || 0),
          externalAwakeEpisodes: Number(noHelperCommandSummary.externalAwakeEpisodes || 0),
          frozenActivations: Number(noHelperCommandSummary.frozenActivations || 0),
          loadedActivations: Number(noHelperCommandSummary.loadedActivations || 0),
          loadingSignals: Number(noHelperCommandSummary.loadingSignals || 0),
          rootActivations: Number(noHelperCommandSummary.rootActivations || 0),
          rootEventCount: Number(noHelperCommandSummary.rootEventCount || 0),
          targetActivations: Number(noHelperCommandSummary.targetActivations || 0),
          targetEventCount: Number(noHelperCommandSummary.targetEventCount || 0),
          wakeSignals: Number(noHelperCommandSummary.wakeSignals || 0)
        };
        noHelperScenario.final.focusState = classifiedNoHelperCommandFocus;
        ensure(noHelperCommandSummary.externalAwakeEpisodes === 1 &&
          noHelperCommandSummary.loadingSignals >= 1 &&
          noHelperCommandSummary.wakeSignals >= 1 &&
          noHelperCommandSummary.externalActivations === 0 &&
          noHelperCommandSummary.frozenActivations === 0 &&
          noHelperCommandSummary.loadedActivations === 0 &&
          noHelperCommandSummary.rootActivations === 0 &&
          noHelperCommandSummary.rootEventCount === 0 &&
          noHelperCommandSummary.targetActivations === 0 &&
          takeoverFailureCodes.length === 0,
        `${name}: command was not one bounded external wake with zero target activation`);
        ensure(classifiedNoHelperCommandFocus.valid === true,
          `${name}: command focus was neither exact nor a proven ambient OS loss`);

        const noHelperDwellCheckpoint = await evaluate(cdp, driverSession,
          monitorCheckpointExpression);
        const noHelperDwellBaselineFocused =
          classifiedNoHelperCommandFocus.focusMode !== 'ambient-os-unfocused';
        const noHelperDwellRequests = Object.fromEntries(
          NO_HELPER_FIXTURE_KEYS.map(key => [key, fixture.count(key)])
        );
        await sleep(DWELL_MS);
        const afterNoHelperDwell = await evaluate(cdp, driverSession,
          groupSnapshotExpression(noHelperLayout));
        const noHelperDwellLifecycle = await evaluate(cdp, driverSession,
          groupHelperMonitorSnapshotExpression);
        const noHelperDwellSummary = await evaluate(cdp, driverSession,
          noHelperActivitySummaryExpression({
            baselineExpectedWindowFocused: noHelperDwellBaselineFocused,
            checkpoint: noHelperDwellCheckpoint,
            expectedFocusedWindowId: noHelperCreation.windowId,
            externalId: noHelperLayout.tabs['no-helper-external'].id,
            frozenId: noHelperLayout.tabs['no-helper-frozen'].id,
            loadedId: noHelperLayout.tabs['no-helper-loaded'].id,
            rootId: noHelperLayout.tabs['no-helper-root'].id,
            targetIds: NO_HELPER_FIXTURE_KEYS.map(key =>
              noHelperLayout.tabs[key].id)
          }));
        const postDwellNoHelperFocus = await evaluate(cdp, driverSession,
          focusStateExpression(noHelperCreation.windowId));
        const classifiedNoHelperDwellFocus = classifyDwellFocusState(
          postDwellNoHelperFocus,
          {requireCurrentMatched: false}
        );
        const noHelperRequestsStable = NO_HELPER_FIXTURE_KEYS.every(key =>
          fixture.count(key) === noHelperDwellRequests[key]);
        noHelperScenario.dwell.requestCountsStable = noHelperRequestsStable;
        noHelperScenario.dwell.snapshot = summarizeGroupSnapshot(afterNoHelperDwell);
        noHelperScenario.dwell.summary = {
          actualFocusTransitions: Number(noHelperDwellSummary.actualFocusTransitions || 0),
          externalActivations: Number(noHelperDwellSummary.externalActivations || 0),
          externalAwakeEpisodes: Number(noHelperDwellSummary.externalAwakeEpisodes || 0),
          frozenActivations: Number(noHelperDwellSummary.frozenActivations || 0),
          loadedActivations: Number(noHelperDwellSummary.loadedActivations || 0),
          loadingSignals: Number(noHelperDwellSummary.loadingSignals || 0),
          rootActivations: Number(noHelperDwellSummary.rootActivations || 0),
          rootEventCount: Number(noHelperDwellSummary.rootEventCount || 0),
          targetActivations: Number(noHelperDwellSummary.targetActivations || 0),
          targetEventCount: Number(noHelperDwellSummary.targetEventCount || 0),
          wakeSignals: Number(noHelperDwellSummary.wakeSignals || 0)
        };
        noHelperScenario.dwell.focusState = classifiedNoHelperDwellFocus;
        ensure(noHelperRequestsStable && afterNoHelperDwell.helperCount === 0 &&
          afterNoHelperDwell.helperRegistryEntryCount === 0 &&
          afterNoHelperDwell.helperTransactionCount === 0 &&
          afterNoHelperDwell.ownershipExact === true &&
          afterNoHelperDwell.targetGroupCount === 4 &&
          afterNoHelperDwell.tabs['no-helper-root'].active === true &&
          afterNoHelperDwell.tabs['no-helper-root'].discarded === false &&
          afterNoHelperDwell.tabs['no-helper-root'].markerState === null &&
          afterNoHelperDwell.tabs['no-helper-root'].source === null &&
          afterNoHelperDwell.tabs['no-helper-loaded'].discarded === true &&
          afterNoHelperDwell.tabs['no-helper-loaded'].source === 'self' &&
          afterNoHelperDwell.tabs['no-helper-frozen'].discarded === true &&
          afterNoHelperDwell.tabs['no-helper-frozen'].source === 'self' &&
          afterNoHelperDwell.tabs['no-helper-frozen'].visualPhysicalOnly === true &&
          afterNoHelperDwell.tabs['no-helper-frozen'].visualComplete === false &&
          afterNoHelperDwell.tabs['no-helper-frozen'].visualRepair === false &&
          afterNoHelperDwell.tabs['no-helper-external'].discarded === true &&
          afterNoHelperDwell.tabs['no-helper-external'].source === 'self' &&
          noHelperDwellLifecycle.created === 0 &&
          noHelperDwellLifecycle.current === 0 &&
          noHelperDwellLifecycle.maxConcurrent === 0 &&
          noHelperDwellLifecycle.removed === 0 &&
          noHelperDwellSummary.loadingSignals === 0 &&
          noHelperDwellSummary.wakeSignals === 0 &&
          noHelperDwellSummary.externalAwakeEpisodes === 0 &&
          noHelperDwellSummary.externalActivations === 0 &&
          noHelperDwellSummary.frozenActivations === 0 &&
          noHelperDwellSummary.loadedActivations === 0 &&
          noHelperDwellSummary.rootActivations === 0 &&
          noHelperDwellSummary.rootEventCount === 0 &&
          noHelperDwellSummary.targetActivations === 0 &&
          noHelperDwellSummary.targetEventCount === 0 &&
          noHelperDwellSummary.actualFocusTransitions === 0 &&
          noHelperDwellSummary.finalExpectedWindowFocused ===
            noHelperDwellBaselineFocused &&
          classifiedNoHelperDwellFocus.valid === true,
        `${name}: delayed helper, wake/loading loop, or partial-state drift occurred`);
        ensure(extensionTreeSha256(extension) === report.extension.treeSha256,
          `${name}: unpacked extension tree changed during evidence collection`);
        noHelperScenario.artifact.treeSha256Verified = true;
        noHelperScenario.setup.monitorStableMilliseconds =
          settledNoHelperMonitor.stableMilliseconds;
      }
      catch (error) {
        phaseFailure = error;
      }
      finally {
        const cleanupErrors = [];
        stopNoHelperDisableListener?.();
        stopNoHelperDisableListener = undefined;
        if (noHelperLiveWorkerSession) {
          try {
            await cdp.send('Target.detachFromTarget', {
              sessionId: noHelperLiveWorkerSession
            });
            noHelperLiveWorkerSession = undefined;
          }
          catch (error) {
            // A terminated MV3 worker implicitly releases its session. Only a
            // still-live matching target would make this an incomplete detach.
            const {targetInfos = []} = await cdp.send('Target.getTargets').catch(() => ({}));
            if (targetInfos.some(info => info.targetId === noHelperLiveWorkerTargetId)) {
              cleanupErrors.push(error);
            }
          }
        }
        if (noHelperControlSession) {
          try {
            await cdp.send('Target.detachFromTarget', {
              sessionId: noHelperControlSession
            });
          }
          catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (noHelperControlTargetId) {
          try {
            await cdp.send('Target.closeTarget', {
              targetId: noHelperControlTargetId
            });
          }
          catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (Number.isInteger(noHelperWindowId)) {
          try {
            await evaluate(cdp, driverSession, `new Promise(resolve => {
              chrome.windows.remove(${Number(noHelperWindowId)}, () => {
                void chrome.runtime.lastError;
                resolve(true);
              });
            })`, 10000, `${name}: fixture window cleanup`);
            await waitFor(() => evaluate(cdp, driverSession, `new Promise(resolve => {
              chrome.windows.get(${Number(noHelperWindowId)}, () => {
                const missing = Boolean(chrome.runtime.lastError);
                resolve(missing);
              });
            })`), `${name}: fixture window did not close`, 10000, 100);
          }
          catch (error) {
            cleanupErrors.push(error);
          }
        }
        let helperRecovery;
        try {
          helperRecovery = await evaluate(cdp, driverSession, `(async () => {
            const {helperRegistry} = await import(
              chrome.runtime.getURL('worker/core/helper-registry.mjs')
            );
            const removed = await helperRegistry.cleanup();
            const stored = await chrome.storage.session.get('__blankHelperRegistry');
            return {
              registryAbsent: stored.__blankHelperRegistry === undefined,
              removedCount: removed.length
            };
          })()`, 10000, `${name}: production helper-registry cleanup`);
          await waitFor(async () => {
            const stored = await evaluate(cdp, driverSession,
              'chrome.storage.session.get(null)');
            return Object.keys(stored).every(key =>
              !key.startsWith('__discardOwnership:tab:')) &&
              stored.__blankHelperRegistry === undefined;
          }, `${name}: ownership/helper cleanup did not settle`, 10000, 100);
        }
        catch (error) {
          cleanupErrors.push(error);
        }
        try {
          const restored = await evaluate(cdp, driverSession, `(async () => {
            const key = './plugins/blank/core.js';
            const previous = ${JSON.stringify(blankPreferenceBefore)};
            if (previous.present) {
              await chrome.storage.local.set({[key]: previous.value === true});
            }
            else {
              await chrome.storage.local.remove(key);
            }
            await new Promise(resolve => setTimeout(resolve, 100));
            const stored = await chrome.storage.local.get(key);
            const present = Object.prototype.hasOwnProperty.call(stored, key);
            return previous.present ? present && stored[key] === previous.value : !present;
          })()`, 5000, `${name}: restore blank-helper preference`);
          ensure(restored === true,
            `${name}: blank-helper preference was not restored exactly`);
          noHelperScenario.settings.blankHelperPreferenceRestored = true;
        }
        catch (error) {
          cleanupErrors.push(error);
        }
        noHelperScenario.cleanup = {
          helperRegistryAbsent: helperRecovery?.registryAbsent === true,
          helperRegistryRecovery: {
            path: 'production-helper-registry-cleanup',
            removedCount: Number(helperRecovery?.removedCount || 0)
          },
          preferenceRestored:
            noHelperScenario.settings.blankHelperPreferenceRestored === true,
          windowClosed: Number.isInteger(noHelperWindowId)
        };
        if (phaseFailure || cleanupErrors.length) {
          const failures = [...(phaseFailure ? [phaseFailure] : []), ...cleanupErrors];
          throw failures.length === 1 ? failures[0] : new AggregateError(
            failures,
            `${name}: phase or cleanup failed`
          );
        }
        ensure(helperRecovery?.registryAbsent === true &&
          helperRecovery.removedCount === 0,
        `${name}: no-helper phase left a helper registry entry`);
      }
    }
  }
  catch (error) {
    primaryError = error;
    if (error.browserCleanup) {
      report.cleanup.browser = error.browserCleanup;
    }
    recordFailure('Edge frozen smoke', error);
  }
  finally {
    stopPulseEvidenceListener?.();
    if (fixture) {
      report.fixture.requestCountTotal = fixture.count();
      try {
        await fixture.stop();
        report.cleanup.fixtureStopped = true;
      }
      catch (error) {
        captureCleanupFailure('fixture server cleanup', error);
      }
    }
    if (browser) {
      try {
        report.cleanup.browser = await terminateBrowser(browser.child, browser.cdp);
      }
      catch (error) {
        report.cleanup.browser = error.cleanup || report.cleanup.browser;
        captureCleanupFailure('browser cleanup', error);
      }
    }
    if (profile) {
      try {
        const crashes = findCrashCount(profile);
        report.cleanup.crashArtifacts = crashes;
        report.cleanup.crashFree = crashes === 0;
        ensure(crashes === 0, 'Edge produced a crash dump during the smoke run');
      }
      catch (error) {
        captureCleanupFailure('crash-artifact assertion', error);
      }
      try {
        ensure(safeProfile(profileRoot, profile),
          'Refusing to delete a profile outside the isolated Edge profile root');
        fs.rmSync(profile, {force: true, maxRetries: 4, recursive: true, retryDelay: 250});
        ensure(!fs.existsSync(profile), 'The isolated Edge profile was not removed');
        report.cleanup.profileRemoved = true;
      }
      catch (error) {
        captureCleanupFailure('isolated profile removal', error);
      }
    }
    emergency = false;
    browser = undefined;
    process.removeListener('exit', emergencyCleanup);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    report.finishedAt = new Date().toISOString();
    const allFailures = [...(primaryError ? [primaryError] : []), ...cleanupFailures];
    if (cleanupFailures.length) {
      const cleanupMessage = cleanupFailures.map(safeMessage).join('; ');
      primaryError = new AggregateError(allFailures, primaryError ?
        `${primaryError.message}; cleanup failed: ${cleanupMessage}` :
        `Edge frozen smoke cleanup failed: ${cleanupMessage}`);
    }
    report.outcome = primaryError ? 'failed' : 'passed';
    if (primaryError) {
      report.error = safeMessage(primaryError);
    }
    try {
      writeReport();
    }
    catch (error) {
      const writeFailure = Error(`The sanitized Edge result could not be written: ${safeMessage(error)}`);
      primaryError = primaryError ? new AggregateError([primaryError, writeFailure],
        `${primaryError.message}; sanitized result write failed`) : writeFailure;
    }
  }
  if (primaryError) {
    primaryError.reportPath = reportPath;
    throw primaryError;
  }
  return reportPath;
};

if (require.main === module) {
  run().then(reportPath => {
    console.log(`Edge frozen smoke passed: combined and favicon-only direct physical alarm takeovers plus the active native-group helper and no-helper partial paths, bounded external takeovers, truthful unavailable visual records, stable no-op repeats and dwell, zero crashes, profile removed; sanitized result: ${safeMessage(reportPath)}`);
  }, error => {
    console.error(`Edge frozen smoke failed: ${safeMessage(error)}`);
    if (error.reportPath) {
      console.error(`Sanitized result: ${safeMessage(error.reportPath)}`);
    }
    process.exitCode = 1;
  });
}

module.exports = {
  assertExactChildExit,
  classifyCommandFocusState,
  classifyDwellFocusState,
  classifyFocusEvents,
  extensionTreeSha256,
  isExactVisibilityPulse,
  safeMessage,
  safeProfile,
  sanitize,
  summarizeActivity,
  summarizeGroupActivity,
  summarizeGroupSnapshot,
  summarizeSnapshot
};
