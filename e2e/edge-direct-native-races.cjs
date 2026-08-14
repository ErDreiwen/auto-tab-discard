#!/usr/bin/env node
'use strict';

/*
 * Real Edge release/restart race gate.
 *
 * The extension tree is loaded without modification. Raw CDP attaches only to
 * the extension's own driver page, disposable edge://discards controls, and the
 * service worker; fixture renderers remain debugger-free so Edge can freeze
 * them natively. Extension behavior still enters through genuine runtime popup
 * messages. Debugger commands place source-derived breakpoints around the
 * native call, terminate the worker at exact boundaries, and install count-only
 * API telemetry in that disposable worker. No production source is patched.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');

const SCRIPT_DIR = __dirname;
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_EXTENSION = path.join(WORKSPACE_ROOT, 'v3');
const DEFAULT_PROFILE_ROOT = path.join(SCRIPT_DIR, '.profiles');
const DEFAULT_RESULTS_ROOT = path.join(SCRIPT_DIR, 'results');
const RESULT_FILE = 'edge-direct-native-races.json';
const EXPECTED_EXTENSION_VERSION = '0.6.9.2';
const RELEASE_COMMANDS = Object.freeze([
  'release-window',
  'release-rights',
  'release-lefts',
  'release-other-windows',
  'release-tabs'
]);
const TERMINATION_BOUNDARIES = Object.freeze([
  'before-native-invocation',
  'during-native-wait',
  'after-replacement-settlement'
]);
const CANCELLATION_PHASES = Object.freeze([
  'queued',
  'pre-native',
  'native-pending',
  'late-settlement'
]);
const RETAINED_FROZEN_CODE = 'TAB_RELEASE_REMAINS_FROZEN';
const ORPHAN_RELEASE_OUTCOME_CODE = 'TAB_FAILED';
const RETAINED_FROZEN_LIMITATION =
  'Edge retained a frozen renderer after one inactive explicit release request';
const OWNERSHIP_PREFIX = '__discardOwnership:tab:';
const WORKER_API_TELEMETRY_METHOD = '__edge-direct-native-api-telemetry';
const ISOLATED_PREFERENCES = Object.freeze({
  favicon: true,
  log: false,
  mode: 'time-based',
  period: 0,
  prepends: '\u{1F4A4}',
  tmp_disable: 1
});

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const ensure = (condition, message) => {
  if (!condition) throw Error(message);
};
const bounded = async (operation, timeout = 5000, label = 'operation') => {
  let timer;
  const owned = Promise.resolve(operation);
  // Promise.race stops observing the losing branch. Own it explicitly so a
  // late CDP close/rejection after the deadline cannot crash the harness.
  owned.catch(() => {});
  try {
    return await Promise.race([
      owned,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Error(`${label} timed out`)), timeout);
      })
    ]);
  }
  finally {
    clearTimeout(timer);
  }
};
const waitFor = async (probe, label, timeout = 20_000, interval = 50) => {
  const deadline = Date.now() + timeout;
  let last;
  let lastError;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      lastError = undefined;
      if (last) return last;
    }
    catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  const suffix = lastError ? `; last error=${lastError.message}` :
    last === undefined ? '' : `; last=${JSON.stringify(last)}`;
  throw Error(`timed out waiting for ${label}${suffix}`);
};

const safeMessage = error => String(error?.message || error || 'unknown failure')
  .replace(new RegExp(WORKSPACE_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<workspace>')
  .replace(/[A-Z]:[\\/]Users[\\/][^\\/\s]+/gi, '<user-path>')
  .replace(/(?:chrome|edge)-extension:\/\/[a-p]{32}/gi, 'extension://<redacted>')
  .replace(/\b(?:https?|ws):\/\/(?:127\.0\.0\.1|localhost):\d+(?:\/[^\s"')\]]*)?/gi,
    '<loopback-url>')
  .replace(/edge-direct-native-races-\d+-\d+/gi, '<isolated-profile>')
  .replace(/("(?:id|tabId|windowId|targetId|sessionId|addedId|removedId)"\s*:\s*)"?[-\w]+"?/gi,
    '$1"<redacted>"')
  .replace(/\b((?:tab|window|target|session)(?:\s+(?:with\s+)?id)?\s*[:=]?\s*)-?\d+\b/gi,
    '$1<redacted>');

const sanitize = value => {
  if (typeof value === 'string') return safeMessage(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]));
};

const extensionTreeSha256 = root => {
  const files = [];
  const visit = directory => fs.readdirSync(directory, {withFileTypes: true}).forEach(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(target);
    else if (entry.isFile()) files.push(target);
  });
  visit(root);
  const digest = crypto.createHash('sha256');
  files.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))).forEach(file => {
    digest.update(path.relative(root, file).replaceAll('\\', '/'));
    digest.update('\0');
    digest.update(fs.readFileSync(file));
    digest.update('\0');
  });
  return digest.digest('hex');
};

const safeProfile = (profileRoot, profile) => {
  const root = path.resolve(profileRoot);
  const candidate = path.resolve(profile);
  return candidate.startsWith(root + path.sep) &&
    /^edge-direct-native-races-\d+-\d+$/.test(path.basename(candidate));
};

const findCrashCount = profile => {
  let count = 0;
  const visit = directory => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.(?:dmp|crash)$/i.test(entry.name)) count += 1;
    }
  };
  visit(profile);
  return count;
};

const taskkill = process.platform === 'win32' ?
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe') : undefined;
const killTree = child => {
  if (!child || child.exitCode !== null || !Number.isInteger(child.pid)) return false;
  if (process.platform === 'win32' && fs.existsSync(taskkill)) {
    spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true
    });
    return true;
  }
  child.kill('SIGKILL');
  return true;
};
const waitExit = (child, timeout = 5000) => child?.exitCode !== null ? Promise.resolve(true) :
  Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    sleep(timeout).then(() => false)
  ]);
const terminateBrowser = async (child, browserCdp) => {
  let browserCloseRequested = false;
  try {
    await bounded(browserCdp?.send('Browser.close'), 3000, 'Browser.close');
    browserCloseRequested = true;
  }
  catch (error) {}
  const graceful = await waitExit(child, 5000);
  const forced = graceful ? false : killTree(child);
  const exited = graceful || await waitExit(child, 5000);
  ensure(exited, 'the exact isolated Edge child did not exit');
  if (!forced) {
    ensure(child.exitCode === 0 && child.signalCode === null,
      `the graceful isolated Edge exit was not exact (code ${child.exitCode}, signal ${child.signalCode})`);
  }
  else {
    ensure(child.exitCode !== null || child.signalCode !== null,
      'the forced isolated Edge exit did not publish a terminal process state');
  }
  return {
    browserCloseRequested,
    exitCode: child.exitCode,
    exited,
    forced,
    graceful,
    signal: child.signalCode
  };
};

const fixtureServer = async () => {
  const requests = new Map();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const label = url.searchParams.get('case') || 'unknown';
    requests.set(label, (requests.get(label) || 0) + 1);
    response.writeHead(200, {
      'cache-control': 'no-store, no-cache, must-revalidate',
      'content-type': 'text/html; charset=utf-8'
    });
    response.end(`<!doctype html><meta charset="utf-8"><title>${label}</title><p>${label}</p>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    count: label => requests.get(label) || 0,
    counts: () => Object.fromEntries([...requests].sort()),
    stop: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        server.closeAllConnections?.();
        reject(Error('fixture server did not stop within its cleanup deadline'));
      }, 5000);
      server.close(error => {
        clearTimeout(timer);
        error ? reject(error) : resolve();
      });
      server.closeIdleConnections?.();
    }),
    url: label => `http://127.0.0.1:${port}/fixture?case=${encodeURIComponent(label)}`
  };
};

const readJson = url => new Promise((resolve, reject) => {
  http.get(url, response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => body += chunk);
    response.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (error) { reject(error); }
    });
  }).on('error', reject);
});

class RawCdp {
  constructor(url) {
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, {once: true});
      this.socket.addEventListener('error', reject, {once: true});
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (Number.isInteger(message.id)) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        message.error ? pending.reject(Error(message.error.message || 'CDP error')) :
          pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) || []) {
        Promise.resolve().then(() => listener(message.params || {}, message.sessionId)).catch(() => {});
      }
    });
    this.socket.addEventListener('close', () => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        // Browser.close normally tears down the WebSocket before its response,
        // and Edge may also leave polling/detach commands in flight at that
        // instant. Process-exit and cleanup checks below are authoritative;
        // resolve all transport waiters so teardown cannot surface a spurious
        // unhandled rejection after the browser has already exited.
        pending.resolve({closed: true, id});
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId) {
    // Do not make this method `async`: an async function creates a second
    // assimilating Promise whose rejection can become unowned if Edge closes
    // the browser socket before Browser.close (or another late command)
    // responds. Own the one returned operation at its creation boundary.
    const operation = this.ready.then(() => {
      const id = ++this.nextId;
      const payload = {id, method, params};
      if (sessionId) payload.sessionId = sessionId;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(Error(`CDP ${method} response deadline exceeded`));
        }, 10_000);
        this.pending.set(id, {method, reject, resolve, timer});
      });
      response.catch(() => {});
      this.pending.get(id).promise = response;
      this.socket.send(JSON.stringify(payload));
      return response;
    });
    operation.catch(() => {});
    return operation;
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
    return () => this.listeners.set(method, (this.listeners.get(method) || [])
      .filter(candidate => candidate !== listener));
  }

  async close() {
    for (const pending of this.pending.values()) pending.promise?.catch(() => {});
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

class RawPage {
  constructor(raw, targetId, sessionId) {
    this.raw = raw;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.closed = false;
  }

  async evaluate(pageFunction, argument) {
    const expression = typeof pageFunction === 'string' ? pageFunction :
      `(${pageFunction.toString()})(${argument === undefined ? 'undefined' : JSON.stringify(argument)})`;
    const response = await this.raw.send('Runtime.evaluate', {
      awaitPromise: true,
      expression,
      returnByValue: true,
      userGesture: true
    }, this.sessionId);
    if (response?.exceptionDetails) {
      throw Error(response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text || 'page evaluation failed');
    }
    return response?.result?.value;
  }

  async goto(url) {
    const navigation = await this.raw.send('Page.navigate', {url}, this.sessionId);
    ensure(!navigation?.errorText, `navigation failed: ${navigation?.errorText}`);
    await waitFor(() => this.evaluate('document.readyState === "complete"'),
      'raw CDP page navigation', 15_000, 50);
    return true;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.raw.send('Target.detachFromTarget', {sessionId: this.sessionId}).catch(() => {});
    await this.raw.send('Target.closeTarget', {targetId: this.targetId}).catch(() => {});
  }
}

class RawContext {
  constructor(raw) {
    this.raw = raw;
  }

  async newPage() {
    const {targetId} = await this.raw.send('Target.createTarget', {url: 'about:blank'});
    ensure(targetId, 'Edge did not create a raw-CDP control page');
    const {sessionId} = await this.raw.send('Target.attachToTarget', {
      flatten: true,
      targetId
    });
    ensure(sessionId, 'Edge did not attach the raw-CDP control page');
    await this.raw.send('Runtime.enable', {}, sessionId);
    await this.raw.send('Page.enable', {}, sessionId);
    return new RawPage(this.raw, targetId, sessionId);
  }
}

let emergencyChild;

const launchEdge = async ({executable, extension, profile}) => {
  fs.mkdirSync(profile, {recursive: true});
  const args = [
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
    '--disable-features=OptimizationHints,MediaRouter',
    'about:blank'
  ];
  const child = spawn(executable, args, {
    stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true
  });
  emergencyChild = child;
  let spawnError;
  child.once('error', error => spawnError = error);
  let raw;
  try {
    const port = await waitFor(() => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw Error(`Edge exited before DevTools was ready (${child.exitCode})`);
      const file = path.join(profile, 'DevToolsActivePort');
      if (!fs.existsSync(file)) return false;
      return Number(fs.readFileSync(file, 'utf8').split(/\r?\n/, 1)[0]) || false;
    }, 'isolated Edge DevTools port');
    const endpoint = `http://127.0.0.1:${port}`;
    const endpointVersion = await bounded(readJson(`${endpoint}/json/version`), 5000,
      'Edge version endpoint');
    raw = new RawCdp(endpointVersion.webSocketDebuggerUrl);
    await bounded(raw.ready, 5000, 'Edge browser WebSocket');
    const browserVersion = await raw.send('Browser.getVersion');
    const context = new RawContext(raw);
    return {browserVersion, child, context, endpoint, raw};
  }
  catch (error) {
    await raw?.close().catch(() => {});
    if (child.exitCode === null) killTree(child);
    await waitExit(child, 5000);
    emergencyChild = undefined;
    throw error;
  }
};

const breakpointLines = extension => {
  const lineFor = (relative, needle) => {
    const lines = fs.readFileSync(path.join(extension, relative), 'utf8').split(/\r?\n/);
    const matches = lines.map((line, index) => line.includes(needle) ? index : -1)
      .filter(index => index !== -1);
    ensure(matches.length === 1, `${relative} must contain exactly one breakpoint anchor: ${needle}`);
    return matches[0];
  };
  return Object.freeze({
    afterNativeInvocation: {
      lineNumber: lineFor('worker/core/native-discard-state.mjs', 'operation?.then?.('),
      relative: 'worker/core/native-discard-state.mjs'
    },
    beforeNativeInvocation: {
      lineNumber: lineFor('worker/core/native-discard-state.mjs',
        'const operation = tabs.discard(id, result => finish(result));'),
      relative: 'worker/core/native-discard-state.mjs'
    },
    replacementSettled: {
      lineNumber: lineFor('worker/core/discard.mjs',
        'const owned = await ownership.finish(finalTab || {...live, discarded: false}, attemptId,'),
      relative: 'worker/core/discard.mjs'
    }
  });
};

class WorkerDebugger {
  constructor(raw, extensionId, extension) {
    this.raw = raw;
    this.extensionId = extensionId;
    this.lines = breakpointLines(extension);
    this.breakpointStages = new Map();
    this.sessions = new Map();
    this.pauses = [];
    this.waiters = [];
    this.executedNativeCalls = 0;
    this.beforeNativeHits = 0;
    this.unexpectedPauses = [];
    this.configurationErrors = [];
    this.configurationPromises = new Set();
    this.breakpointResolutions = new Map();
    this.pendingBreakpointLocations = new Map();
    this.pendingWorkerAttachments = new Map();
    this.debuggerEvidence = [];
    this.workerRegistrations = new Map();
    this.workerVersions = new Map();
    this.workerVersionsById = new Map();
    this.heldStages = new Set();
    raw.on('ServiceWorker.workerRegistrationUpdated', params => {
      for (const registration of params.registrations || []) {
        if (registration.isDeleted) {
          this.workerRegistrations.delete(registration.registrationId);
          for (const [targetId, version] of this.workerVersions) {
            if (version.registrationId === registration.registrationId) {
              this.workerVersions.delete(targetId);
            }
          }
        }
        else {
          this.workerRegistrations.set(registration.registrationId, registration.scopeURL);
          for (const version of this.workerVersionsById.values()) {
            if (version.registrationId === registration.registrationId) {
              this.indexWorkerVersion(version);
            }
          }
        }
      }
    });
    raw.on('ServiceWorker.workerVersionUpdated', (params, sessionId) => {
      for (const version of params.versions || []) {
        if (!version.versionId || !this.matchesWorkerURL(version.scriptURL)) continue;
        const record = {
          controlSessionId: sessionId,
          registrationId: version.registrationId,
          runningStatus: version.runningStatus,
          scriptURL: version.scriptURL,
          status: version.status,
          targetId: version.targetId,
          versionId: version.versionId
        };
        this.workerVersionsById.set(record.versionId, record);
        this.indexWorkerVersion(record);
      }
    });
    raw.on('Debugger.paused', (params, sessionId) => this.onPaused(params, sessionId));
    raw.on('Debugger.breakpointResolved', (params, sessionId) => {
      const stage = this.breakpointStages.get(params.breakpointId);
      if (!sessionId) return;
      if (!stage) {
        const pending = this.pendingBreakpointLocations.get(params.breakpointId) || [];
        pending.push({location: params.location, sessionId});
        this.pendingBreakpointLocations.set(params.breakpointId, pending);
        return;
      }
      try {
        this.recordResolution(sessionId, stage, params.location);
      }
      catch (error) {
        this.configurationErrors.push(error);
      }
    });
    raw.on('Target.attachedToTarget', params => {
      if (this.isWorker(params.targetInfo)) {
        this.trackConfiguration(this.configure(params.sessionId, params.targetInfo,
          true));
      }
      else if (params.targetInfo?.type === 'service_worker' && !params.targetInfo.url) {
        this.pendingWorkerAttachments.set(params.targetInfo.targetId, {
          sessionId: params.sessionId,
          targetInfo: params.targetInfo
        });
      }
      else {
        void raw.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId).catch(() => {});
      }
    });
    raw.on('Target.targetInfoChanged', params => {
      const info = params.targetInfo;
      if (!this.isWorker(info)) return;
      const pending = this.pendingWorkerAttachments.get(info.targetId);
      if (!pending) return;
      this.pendingWorkerAttachments.delete(info.targetId);
      this.trackConfiguration(this.configure(pending.sessionId, info, true));
    });
    raw.on('Target.detachedFromTarget', params => this.forgetSession(params.sessionId));
  }

  isWorker(info) {
    return info?.type === 'service_worker' && (
      this.matchesWorkerURL(info.url) || this.workerVersions.has(info.targetId)
    );
  }

  matchesWorkerURL(value) {
    try {
      const url = new URL(value);
      return ['chrome-extension:', 'edge-extension:'].includes(url.protocol) &&
        url.hostname === this.extensionId && url.pathname === '/worker/core.mjs';
    }
    catch (error) {
      return false;
    }
  }

  indexWorkerVersion(version) {
    if (this.workerRegistrations.get(version.registrationId) !==
        `chrome-extension://${this.extensionId}/` || !version.targetId) return false;
    this.workerVersions.set(version.targetId, version);
    const pending = this.pendingWorkerAttachments.get(version.targetId);
    if (pending) {
      this.pendingWorkerAttachments.delete(version.targetId);
      this.trackConfiguration(this.configure(pending.sessionId, {
        ...pending.targetInfo,
        url: version.scriptURL
      }, true));
    }
    return true;
  }

  activeWorkerVersions() {
    return [...this.workerVersionsById.values()].filter(version =>
      this.workerRegistrations.get(version.registrationId) ===
        `chrome-extension://${this.extensionId}/` &&
      this.matchesWorkerURL(version.scriptURL) &&
      version.runningStatus === 'running' && version.status === 'activated');
  }

  definition(stage) {
    return ({
      'after-replacement-settlement': this.lines.replacementSettled,
      'before-native-invocation': this.lines.beforeNativeInvocation,
      'during-native-wait': this.lines.afterNativeInvocation
    })[stage];
  }

  async installApiTelemetry(sessionId) {
    const expression = `(() => {
      const method = ${JSON.stringify(WORKER_API_TELEMETRY_METHOD)};
      const prior = globalThis.__edgeDirectNativeApiTelemetry;
      if (prior?.installed === true) return prior.status;
      const emit = api => {
        try {
          globalThis.chrome?.runtime?.sendMessage?.({method, api}, () => {
            void globalThis.chrome?.runtime?.lastError;
          });
        }
        catch (error) {}
      };
      const wrap = (owner, key, api) => {
        if (!owner || typeof owner[key] !== 'function') return false;
        const original = owner[key].bind(owner);
        const hooked = (...args) => {
          emit(api);
          return original(...args);
        };
        owner[key] = hooked;
        return owner[key] === hooked;
      };
      const status = {
        executeScript: wrap(globalThis.chrome?.scripting, 'executeScript', 'executeScript'),
        reload: wrap(globalThis.chrome?.tabs, 'reload', 'reload')
      };
      globalThis.__edgeDirectNativeApiTelemetry = {
        installed: status.executeScript === true && status.reload === true,
        status
      };
      return status;
    })()`;
    const result = await this.raw.send('Runtime.evaluate', {
      awaitPromise: true,
      expression,
      returnByValue: true
    }, sessionId);
    const status = result?.result?.value;
    ensure(!result?.exceptionDetails && status?.executeScript === true && status?.reload === true,
      'Edge could not install count-only worker API telemetry');
    return status;
  }

  forgetSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    this.pendingWorkerAttachments.delete(session.targetId);
    for (const stage of TERMINATION_BOUNDARIES) {
      this.breakpointResolutions.delete(`${sessionId}:${stage}`);
    }
    for (const breakpointId of session.breakpoints.values()) {
      this.breakpointStages.delete(breakpointId);
      this.pendingBreakpointLocations.delete(breakpointId);
    }
    return true;
  }

  recordResolution(sessionId, stage, location) {
    const expected = this.definition(stage);
    ensure(expected && Number.isInteger(location?.lineNumber),
      `Edge returned an invalid ${stage} breakpoint location`);
    ensure(location.lineNumber === expected.lineNumber,
      `Edge bound the ${stage} breakpoint to the wrong source line`);
    const key = `${sessionId}:${stage}`;
    const locations = this.breakpointResolutions.get(key) || new Set();
    locations.add(`${location.scriptId || 'unknown'}:${location.lineNumber}:${location.columnNumber || 0}`);
    this.breakpointResolutions.set(key, locations);
  }

  evidence() {
    return [...this.sessions.values()].map(session => ({
      ready: session.ready === true,
      resolvedStages: TERMINATION_BOUNDARIES.filter(stage =>
        this.breakpointResolutions.get(`${session.sessionId}:${stage}`)?.size > 0),
      stageCount: session.breakpoints.size
    }));
  }

  trackConfiguration(operation) {
    const tracked = Promise.resolve(operation).catch(error => {
      this.configurationErrors.push(error);
      throw error;
    }).finally(() => this.configurationPromises.delete(tracked));
    // The event callback cannot be awaited by CDP. Own the rejection here and
    // expose it through configurationErrors/awaitReady instead.
    tracked.catch(() => {});
    this.configurationPromises.add(tracked);
    return tracked;
  }

  async awaitReady(timeout = 10_000, {excludeTargetId} = {}) {
    return waitFor(() => {
      if (this.configurationErrors.length) {
        throw this.configurationErrors[0];
      }
      return [...this.sessions.values()].find(session => session.targetId !== excludeTargetId &&
        session.ready === true &&
        session.breakpoints.size === TERMINATION_BOUNDARIES.length &&
        TERMINATION_BOUNDARIES.every(stage =>
          this.breakpointResolutions.get(`${session.sessionId}:${stage}`)?.size > 0)) || false;
    }, 'extension worker debugger readiness', timeout, 25);
  }

  async ensureReadyWorker(timeout = 10_000, {excludeTargetId} = {}) {
    const ready = [...this.sessions.values()].find(session => session.targetId !== excludeTargetId &&
      session.ready === true && TERMINATION_BOUNDARIES.every(stage =>
        this.breakpointResolutions.get(`${session.sessionId}:${stage}`)?.size > 0));
    if (ready) return ready;
    const {targetInfos = []} = await this.raw.send('Target.getTargets');
    const candidates = targetInfos.filter(info => this.isWorker(info) && info.targetId !== excludeTargetId);
    for (const info of candidates) {
      let session = [...this.sessions.values()].find(entry => entry.targetId === info.targetId);
      if (!session) {
        try {
          const attached = await this.raw.send('Target.attachToTarget', {
            flatten: true,
            targetId: info.targetId
          });
          await this.configure(attached.sessionId, info, false);
        }
        catch (error) {
          if (!/already attached/i.test(error.message)) throw error;
          session = await waitFor(() => [...this.sessions.values()].find(entry =>
            entry.targetId === info.targetId), 'restarted extension worker debugger attachment', timeout, 25);
          await session.configuration;
        }
      }
      else {
        await session.configuration;
      }
    }
    try {
      return await this.awaitReady(timeout, {excludeTargetId});
    }
    catch (error) {
      error.debuggerEvidence = this.evidence();
      throw error;
    }
  }

  async start() {
    await this.raw.send('Target.setDiscoverTargets', {discover: true});
    await this.raw.send('Target.setAutoAttach', {
      autoAttach: true,
      filter: [
        {exclude: false, type: 'service_worker'},
        {exclude: true}
      ],
      flatten: true,
      waitForDebuggerOnStart: true
    });
    const {targetInfos = []} = await this.raw.send('Target.getTargets');
    const existing = targetInfos.filter(info => this.isWorker(info));
    for (const info of existing) {
      if ([...this.sessions.values()].some(entry => entry.targetId === info.targetId)) continue;
      try {
        const {sessionId} = await this.raw.send('Target.attachToTarget', {
          flatten: true,
          targetId: info.targetId
        });
        await this.configure(sessionId, info, false);
      }
      catch (error) {
        if (!/already attached/i.test(error.message)) throw error;
        const attached = await waitFor(() => [...this.sessions.values()]
          .find(entry => entry.targetId === info.targetId), 'auto-attached existing extension worker');
        await attached.configuration;
      }
    }
    await this.awaitReady();
    return this;
  }

  async enableWorkerControl(controlSessionId) {
    await this.raw.send('ServiceWorker.enable', {}, controlSessionId);
    await waitFor(() => this.workerVersions.size > 0 || this.activeWorkerVersions().length > 0,
      'extension service-worker version identity', 10_000, 25);
  }

  async restartWorker(controlSessionId, timeout = 10_000, {excludeTargetId} = {}) {
    const scopeURL = `chrome-extension://${this.extensionId}/`;
    await this.raw.send('ServiceWorker.enable', {}, controlSessionId);
    try {
      await this.raw.send('ServiceWorker.startWorker', {scopeURL}, controlSessionId);
      return await waitFor(async () => {
        try {
          return await this.ensureReadyWorker(250, {excludeTargetId});
        }
        catch (error) {
          if (this.configurationErrors.length) throw error;
          return false;
        }
      }, 'replacement extension worker debugger readiness', timeout, 25);
    }
    catch (error) {
      error.debuggerEvidence = this.evidence();
      const {targetInfos = []} = await this.raw.send('Target.getTargets').catch(() => ({targetInfos: []}));
      error.workerTargetCount = targetInfos.filter(info => this.isWorker(info) &&
        info.targetId !== excludeTargetId).length;
      error.targetEvidence = {
        blankServiceWorkers: targetInfos.filter(info => info.type === 'service_worker' && !info.url).length,
        extensionHostWorkers: targetInfos.filter(info => info.type === 'service_worker' && (() => {
          try { return new URL(info.url).hostname === this.extensionId; }
          catch (nested) { return false; }
        })()).length,
        serviceWorkers: targetInfos.filter(info => info.type === 'service_worker').length,
        workerVersions: [...this.workerVersions.keys()].filter(id => id !== excludeTargetId).length
      };
      throw error;
    }
  }

  async configure(sessionId, info, waiting) {
    if (!sessionId) return;
    const existing = this.sessions.get(sessionId);
    if (existing) return existing.configuration;
    const workerURL = this.matchesWorkerURL(info.url) ? info.url :
      this.workerVersions.get(info.targetId)?.scriptURL;
    const session = {
      breakpoints: new Map(),
      ready: false,
      sessionId,
      targetId: info.targetId,
      workerURL: this.matchesWorkerURL(workerURL) ? workerURL : undefined
    };
    this.sessions.set(sessionId, session);
    session.configuration = (async () => {
      await this.raw.send('Runtime.enable', {}, sessionId);
      await this.raw.send('Debugger.enable', {}, sessionId);
      const definitions = [
        ['before-native-invocation', this.lines.beforeNativeInvocation],
        ['during-native-wait', this.lines.afterNativeInvocation],
        ['after-replacement-settlement', this.lines.replacementSettled]
      ];
      for (const [stage, definition] of definitions) {
        const url = `chrome-extension://${this.extensionId}/${definition.relative}`;
        const result = await this.raw.send('Debugger.setBreakpointByUrl', {
          columnNumber: 0,
          lineNumber: definition.lineNumber,
          url
        }, sessionId);
        ensure(result?.breakpointId, `Edge did not accept the ${stage} worker breakpoint`);
        this.breakpointStages.set(result.breakpointId, stage);
        session.breakpoints.set(stage, result.breakpointId);
        for (const location of result.locations || []) this.recordResolution(sessionId, stage, location);
        for (const pending of this.pendingBreakpointLocations.get(result.breakpointId) || []) {
          if (pending.sessionId === sessionId) this.recordResolution(sessionId, stage, pending.location);
        }
        this.pendingBreakpointLocations.delete(result.breakpointId);
      }
      // This is a safe no-op for an already-running worker and mandatory when
      // manual attachment wins the race against wait-on-start auto-attach.
      await this.raw.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
      await Promise.all(definitions.map(([stage]) => waitFor(() =>
        this.breakpointResolutions.get(`${sessionId}:${stage}`)?.size > 0,
      `${stage} breakpoint to bind in the extension worker`, 10_000, 25)));
      // A wait-on-start service worker has a CDP execution context before its
      // extension API bindings are fully populated. Instrument only after the
      // worker has resumed far enough to parse every anchored module; no test
      // command can run until this configuration promise marks it ready.
      await this.installApiTelemetry(sessionId);
      session.ready = true;
      return session;
    })();
    return session.configuration;
  }

  onPaused(params, sessionId) {
    const hitBreakpoints = params.hitBreakpoints || [];
    const stages = hitBreakpoints.map(id => this.breakpointStages.get(id)).filter(Boolean);
    const stage = stages[0];
    const session = this.sessions.get(sessionId);
    if (!stage || !session) {
      this.unexpectedPauses.push({reason: params.reason || 'unknown'});
      void this.raw.send('Debugger.resume', {}, sessionId).catch(() => {});
      return;
    }
    if (stage === 'before-native-invocation') this.beforeNativeHits += 1;
    const pause = Object.freeze({
      exactWorker: hitBreakpoints.includes(session.breakpoints.get(stage)) &&
        this.breakpointResolutions.get(`${sessionId}:${stage}`)?.size > 0,
      stage,
      sessionId,
      targetId: session.targetId
    });
    if (!this.heldStages.has(stage)) {
      if (stage === 'before-native-invocation') this.executedNativeCalls += 1;
      void this.raw.send('Debugger.resume', {}, sessionId).catch(() => {});
      return;
    }
    const waiter = this.waiters.find(candidate => candidate.stage === stage);
    if (waiter) {
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(pause);
    }
    else {
      this.pauses.push(pause);
    }
  }

  waitForPause(stage, timeout = 15_000) {
    const existing = this.pauses.find(pause => pause.stage === stage);
    if (existing) {
      this.pauses.splice(this.pauses.indexOf(existing), 1);
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const waiter = {resolve, stage};
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(Error(`worker did not pause at ${stage}`));
      }, timeout);
      waiter.resolve = value => {
        clearTimeout(timer);
        resolve(value);
      };
    });
  }

  waitForPauseOptional(stage, timeout = 750) {
    return this.waitForPause(stage, timeout).catch(error => {
      if (/did not pause/.test(error.message)) return undefined;
      throw error;
    });
  }

  async resume(pause) {
    if (pause.stage === 'before-native-invocation') this.executedNativeCalls += 1;
    await this.raw.send('Debugger.resume', {}, pause.sessionId);
  }

  async terminate(pause, controlSessionId) {
    let version = this.workerVersions.get(pause.targetId);
    if (!version) {
      const session = this.sessions.get(pause.sessionId);
      ensure(pause.exactWorker === true ||
        (session?.targetId === pause.targetId && this.matchesWorkerURL(session.workerURL)),
        `paused ${pause.stage} session was not the exact extension service worker`);
      const targetInfo = await this.raw.send('Target.getTargetInfo', {
        targetId: pause.targetId
      }).then(result => result?.targetInfo, error => {
        if (/No target with given id/i.test(error?.message || '')) return undefined;
        throw error;
      });
      if (targetInfo) {
        ensure(targetInfo.type === 'service_worker' && targetInfo.targetId === pause.targetId &&
          this.matchesWorkerURL(targetInfo.url),
        `paused ${pause.stage} target was not the exact extension service worker`);
      }
      const candidates = this.activeWorkerVersions();
      ensure(candidates.length === 1,
        `paused ${pause.stage} target had ${candidates.length} eligible service-worker versions`);
      version = candidates[0];
    }
    await this.raw.send('ServiceWorker.stopWorker', {versionId: version.versionId}, controlSessionId);
    await waitFor(async () => {
      const {targetInfos = []} = await this.raw.send('Target.getTargets');
      return targetInfos.every(info => info.targetId !== pause.targetId);
    }, `service-worker exit at ${pause.stage}`);
    await this.raw.send('Target.detachFromTarget', {sessionId: pause.sessionId}).catch(() => {});
    // Edge can remove a service-worker target without publishing a flattened
    // detachedFromTarget callback. Target absence is authoritative; retire its
    // debugger session locally so stale locations cannot satisfy restart-ready.
    for (const session of [...this.sessions.values()]) {
      if (session.targetId === pause.targetId) this.forgetSession(session.sessionId);
    }
    this.workerVersions.delete(pause.targetId);
    this.workerVersionsById.delete(version.versionId);
  }

  hold(stages = []) {
    this.heldStages = new Set(stages);
  }

  checkpoint() {
    const ready = [...this.sessions.values()].filter(session => session.ready === true);
    return Object.freeze({
      beforeNativeHits: this.beforeNativeHits,
      configurationErrors: this.configurationErrors.length,
      executedNativeCalls: this.executedNativeCalls,
      readySessions: ready.length,
      resolvedBreakpointStages: new Set([...this.breakpointResolutions.keys()]
        .map(key => key.slice(key.indexOf(':') + 1))).size,
      unexpectedPauses: this.unexpectedPauses.length
    });
  }
}

const workerTarget = async raw => {
  const {targetInfos = []} = await raw.send('Target.getTargets');
  return targetInfos.find(info => info.type === 'service_worker' &&
    /\/worker\/core\.mjs$/.test(info.url || ''));
};

const discoverExtension = async raw => {
  const target = await waitFor(() => workerTarget(raw), 'extension service worker');
  const extensionId = new URL(target.url).host;
  ensure(/^[a-p]{32}$/.test(extensionId), 'Edge exposed an invalid unpacked extension identity');
  return {extensionId, target};
};

const openDriver = async (context, extensionId) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/data/options/index.html`);
  await page.evaluate(() => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({method: 'storage'}, response => {
      const error = chrome.runtime.lastError;
      error ? reject(Error(error.message)) : resolve(response);
    });
  }));
  return page;
};

const normalizeDriverTopology = async driver => {
  const result = await driver.evaluate(async () => {
    const current = await chrome.tabs.getCurrent();
    if (!Number.isInteger(current?.id)) {
      return {ok: false};
    }
    const tabs = await chrome.tabs.query({});
    const extras = tabs.filter(tab => tab.id !== current.id).map(tab => tab.id);
    if (extras.length) {
      await chrome.tabs.remove(extras);
    }
    const remaining = await chrome.tabs.query({});
    const windows = await chrome.windows.getAll({windowTypes: ['normal']});
    return {
      currentActive: remaining[0]?.active === true,
      currentMatched: remaining[0]?.id === current.id,
      normalWindowCount: windows.length,
      ok: remaining.length === 1 && windows.length === 1
    };
  });
  ensure(result?.ok === true && result.currentActive === true && result.currentMatched === true &&
    result.normalWindowCount === 1,
  'the isolated release driver topology retained an extra startup tab or window');
};

const installMonitor = page => page.evaluate(({prefix, telemetryMethod}) => {
  if (globalThis.__edgeDirectNativeRaces) return true;
  const compactTab = tab => tab && ({
    active: tab.active === true,
    discarded: tab.discarded === true,
    frozen: tab.frozen === true,
    status: tab.status
  });
  const compactProgress = snapshot => ({
    command: snapshot?.command,
    completed: Number(snapshot?.completed || 0),
    errorCode: snapshot?.errorCode,
    jobId: snapshot?.jobId,
    state: snapshot?.state,
    summary: snapshot?.summary,
    total: Number(snapshot?.total || 0)
  });
  const state = globalThis.__edgeDirectNativeRaces = {
    activations: [],
    cancellation: {accepted: false, fired: false, phase: null, targetId: null},
    events: [],
    progress: [],
    replacements: [],
    workerApi: {executeScript: 0, reload: 0}
  };
  const cancel = jobId => new Promise(resolve => chrome.runtime.sendMessage({
    jobId,
    method: 'popup-progress-cancel'
  }, response => {
    void chrome.runtime.lastError;
    state.cancellation.accepted = response?.ok === true && response?.value?.accepted === true;
    resolve(response);
  }));
  const fire = jobId => {
    if (!state.cancellation.fired && jobId) {
      state.cancellation.fired = true;
      void cancel(jobId);
    }
  };
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.method === telemetryMethod &&
        ['executeScript', 'reload'].includes(message.api)) {
      state.workerApi[message.api] += 1;
      sendResponse({observed: true});
      return false;
    }
    if (message?.method !== 'popup-progress-update') return undefined;
    const snapshot = compactProgress(message.snapshot);
    state.progress.push(snapshot);
    if (state.cancellation.phase === 'pre-native' && snapshot.state === 'running' &&
        snapshot.total === 0 && state.cancellation.fired === false) {
      state.cancellation.fired = true;
      cancel(snapshot.jobId).then(value => sendResponse(value));
      // Holding the progress publisher until the public cancel response arrives
      // makes this a deterministic pre-native cancellation without a test hook.
      return true;
    }
    sendResponse({observed: true});
    return false;
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'session' || state.cancellation.phase !== 'native-pending') return;
    const targetId = state.cancellation.targetId;
    const marker = changes[prefix + targetId]?.newValue?.marker;
    if (marker?.state === 'direct-native-pending') {
      const running = [...state.progress].reverse().find(entry => entry.state === 'running');
      fire(running?.jobId);
    }
  });
  chrome.tabs.onActivated.addListener(info => state.activations.push({
    tabId: info.tabId,
    windowId: info.windowId
  }));
  chrome.tabs.onReplaced.addListener((addedId, removedId) => {
    state.replacements.push({addedId, removedId});
    if (state.cancellation.targetId === removedId) state.cancellation.targetId = addedId;
  });
  chrome.tabs.onUpdated.addListener((id, changeInfo, tab) => {
    state.events.push({
      change: {
        discarded: changeInfo.discarded,
        frozen: changeInfo.frozen,
        status: changeInfo.status
      },
      id,
      tab: compactTab(tab)
    });
    if (state.cancellation.phase === 'late-settlement' &&
        id === state.cancellation.targetId && tab?.discarded === true &&
        tab.status === 'unloaded') {
      const running = [...state.progress].reverse().find(entry => entry.state === 'running');
      fire(running?.jobId);
    }
  });
  return true;
}, {prefix: OWNERSHIP_PREFIX, telemetryMethod: WORKER_API_TELEMETRY_METHOD});

const setCancellation = (page, phase, targetId) => page.evaluate(({phase, targetId}) => {
  const state = globalThis.__edgeDirectNativeRaces;
  state.cancellation = {accepted: false, fired: false, phase, targetId};
  return true;
}, {phase, targetId});

const clearCancellation = page => setCancellation(page, null, null);

const monitorSnapshot = page => page.evaluate(() => {
  const state = globalThis.__edgeDirectNativeRaces;
  return JSON.parse(JSON.stringify(state));
});

const workerApiDelta = (before, after) => ({
  executeScript: Number(after?.workerApi?.executeScript || 0) -
    Number(before?.workerApi?.executeScript || 0),
  reload: Number(after?.workerApi?.reload || 0) - Number(before?.workerApi?.reload || 0)
});

const targetActivationCount = (before, after, initialIds) => {
  const lineage = new Set((initialIds || []).filter(Number.isInteger));
  for (const event of after.replacements.slice(before.replacements.length)) {
    if (lineage.has(event.removedId)) lineage.add(event.addedId);
  }
  return after.activations.slice(before.activations.length)
    .filter(event => lineage.has(event.tabId)).length;
};

const message = (page, request, timeout = 30_000) => bounded(page.evaluate(request =>
  new Promise(resolve => chrome.runtime.sendMessage(request, response => {
    const error = chrome.runtime.lastError;
    resolve(error ? {apiError: error.message || String(error)} : response);
  })), request), timeout, `extension message ${request.method || request.cmd}`);

const popupCommand = (page, command, selected, shiftKey = false) => message(page, {
  cmd: command,
  method: 'popup',
  shiftKey,
  tabId: selected.id,
  windowId: selected.windowId
});

const wakeWorker = page => message(page, {method: 'takeover-snapshot'}, 10_000);
const pokeWorker = page => page.evaluate(() => {
  try {
    chrome.runtime.sendMessage({method: 'takeover-snapshot'}, () => void chrome.runtime.lastError);
    return true;
  }
  catch (error) {
    return false;
  }
});

const markerSnapshot = page => page.evaluate(async prefix => {
  const values = await chrome.storage.session.get(null);
  return Object.fromEntries(Object.entries(values)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => [key.slice(prefix.length), value?.marker]));
}, OWNERSHIP_PREFIX);

// Expose only aggregate state counts for the unattributed native fence. The
// report must never acquire the missing predecessor id, a possible successor
// id, or any browsing/topology fields merely to prove that the fence survived.
const ownershipFenceCounts = page => page.evaluate(async prefix => {
  const values = await chrome.storage.session.get(null);
  const markers = Object.entries(values)
    .filter(([key]) => key.startsWith(prefix))
    .map(([, value]) => value?.marker)
    .filter(marker => marker && typeof marker === 'object');
  return {
    directNativeOrphans: markers.filter(marker => marker.state === 'direct-native-orphan').length,
    directNativePending: markers.filter(marker => marker.state === 'direct-native-pending').length,
    owned: markers.filter(marker => marker.state === 'owned').length,
    total: markers.length
  };
}, OWNERSHIP_PREFIX);

const tabByLabel = (page, label) => page.evaluate(async label => {
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find(candidate => {
    try { return new URL(candidate.url).searchParams.get('case') === label; }
    catch (error) { return false; }
  });
  return tab && ({
    active: tab.active === true,
    discarded: tab.discarded === true,
    discardedCapability: !Object.hasOwn(tab, 'discarded') ? 'absent' :
      tab.discarded === true ? 'true' : tab.discarded === false ? 'false' :
        tab.discarded === null ? 'null' : typeof tab.discarded,
    frozen: tab.frozen === true,
    frozenCapability: !Object.hasOwn(tab, 'frozen') ? 'absent' :
      tab.frozen === true ? 'true' : tab.frozen === false ? 'false' :
        tab.frozen === null ? 'null' : typeof tab.frozen,
    id: tab.id,
    index: tab.index,
    status: tab.status,
    windowId: tab.windowId
  });
}, label);

const activateLabel = async (page, label) => {
  const tab = await tabByLabel(page, label);
  ensure(tab, `cannot activate missing setup tab ${label}`);
  await page.evaluate(id => chrome.tabs.update(id, {active: true}), tab.id);
  return tabByLabel(page, label);
};

const summarizeTab = tab => tab && ({
  active: tab.active === true,
  discarded: tab.discarded === true,
  discardedCapability: tab.discardedCapability,
  frozen: tab.frozen === true,
  frozenCapability: tab.frozenCapability,
  status: tab.status
});

const summarizePopupResponse = response => ({
  apiError: response?.apiError ? 'present' : null,
  completed: Number(response?.value?.completed || 0),
  ok: response?.ok === true,
  outcomeCodes: Object.values(response?.value?.outcomes || {})
    .map(outcome => outcome?.code).filter(Boolean).sort(),
  state: response?.value?.state,
  summary: response?.value?.summary,
  total: Number(response?.value?.total || 0)
});

const stableReleased = async ({
  beforeMonitor,
  beforeRequests,
  driver,
  fixture,
  initialIds,
  label,
  response,
  timeout = 20_000
}) => {
  let lastId;
  let lastDisposition;
  let reads = 0;
  const settled = await waitFor(async () => {
    const tab = await tabByLabel(driver, label);
    const loaded = tab?.discardedCapability === 'false' &&
      ['false', 'absent'].includes(tab.frozenCapability) && tab.status === 'complete';
    const retainedFrozen = tab?.discardedCapability === 'false' &&
      tab.frozenCapability === 'true' && tab.status === 'complete';
    const disposition = retainedFrozen ? 'retained-frozen' : loaded ? 'loaded' : undefined;
    if (disposition) {
      reads = tab.id === lastId && disposition === lastDisposition ? reads + 1 : 1;
      lastId = tab.id;
      lastDisposition = disposition;
      return reads >= 2 ? {disposition, tab} : false;
    }
    reads = 0;
    lastId = tab?.id;
    lastDisposition = undefined;
    return false;
  }, `${label} to settle released twice`, timeout, 100);

  ensure(fixture.count(label) - beforeRequests === 1,
    `${label} did not receive exactly one explicit release request`);
  const ownershipAbsent = await waitFor(async () => {
    const current = await tabByLabel(driver, label);
    if (!current) return false;
    const monitor = await monitorSnapshot(driver);
    const lineage = new Set((initialIds || []).filter(Number.isInteger));
    for (const event of monitor.replacements.slice(beforeMonitor.replacements.length)) {
      if (lineage.has(event.removedId)) lineage.add(event.addedId);
    }
    lineage.add(current.id);
    const markers = await markerSnapshot(driver);
    return [...lineage].every(id => markers[id] === undefined);
  }, `${label} old release ownership to clear`, timeout, 100);
  ensure(ownershipAbsent === true, `${label} retained old release ownership`);
  await sleep(500);
  ensure(fixture.count(label) - beforeRequests === 1,
    `${label} received a repeated release request during dwell`);

  const afterMonitor = await monitorSnapshot(driver);
  const targetActivations = targetActivationCount(beforeMonitor, afterMonitor, initialIds);
  ensure(targetActivations === 0, `${label} was activated during release`);
  const lineage = new Set((initialIds || []).filter(Number.isInteger));
  for (const event of afterMonitor.replacements.slice(beforeMonitor.replacements.length)) {
    if (lineage.has(event.removedId)) lineage.add(event.addedId);
  }
  const outcomes = Object.values(response?.value?.outcomes || {})
    .filter(outcome => lineage.has(outcome?.tabId));
  ensure(outcomes.length === 1, `${label} release did not expose one exact lineage outcome`);
  const outcome = outcomes[0];
  if (settled.disposition === 'retained-frozen') {
    ensure(outcome.status === 'failed' && outcome.code === RETAINED_FROZEN_CODE,
      `${label} retained frozen state without ${RETAINED_FROZEN_CODE}`);
  }
  else {
    ensure(outcome.status === 'success' && outcome.code === 'TAB_RELEASED',
      `${label} loaded release did not report TAB_RELEASED success`);
  }
  return {
    disposition: settled.disposition,
    fullyUnfrozen: settled.disposition === 'loaded',
    oldOwnershipAbsent: true,
    outcomeCode: outcome.code,
    reloads: 1,
    retainedFrozen: settled.disposition === 'retained-frozen' ? 1 : 0,
    tab: settled.tab,
    targetActivations
  };
};

const expectedReleaseProgress = releases => {
  const success = releases.filter(release => release.disposition === 'loaded').length;
  const failed = releases.filter(release => release.disposition === 'retained-frozen').length;
  return {
    completed: releases.length,
    state: failed > 0 ? (success > 0 ? 'partial' : 'failed') : 'complete',
    summary: {failed, skipped: 0, success},
    total: releases.length
  };
};

const requireReleaseProgress = (progress, releases, label) => {
  const expected = expectedReleaseProgress(releases);
  ensure(progress?.state === expected.state && progress.total === expected.total &&
    progress.completed === expected.completed &&
    progress.summary?.success === expected.summary.success &&
    progress.summary?.failed === expected.summary.failed &&
    progress.summary?.skipped === expected.summary.skipped,
  `${label} did not report its exact loaded/retained-frozen release result`);
  return {
    completed: Number(progress.completed),
    state: progress.state,
    summary: {
      failed: Number(progress.summary.failed),
      skipped: Number(progress.summary.skipped),
      success: Number(progress.summary.success)
    },
    total: Number(progress.total)
  };
};

const stableDiscarded = async (page, label, timeout = 20_000) => {
  let lastId;
  let reads = 0;
  return waitFor(async () => {
    const tab = await tabByLabel(page, label);
    if (tab && tab.active === false && tab.discarded === true && tab.status === 'unloaded') {
      reads = tab.id === lastId ? reads + 1 : 1;
      lastId = tab.id;
      return reads >= 2 ? tab : false;
    }
    reads = 0;
    lastId = tab?.id;
    return false;
  }, `${label} to settle discarded twice`, timeout, 100);
};

const discardsActionClick = (fixtureUrl, action = 'freeze') => `(() => {
  const needle = ${JSON.stringify(fixtureUrl)};
  const expectedAction = ${JSON.stringify(action)};
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
    [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent).join(' ') : '')
    .join(' ').replace(/\\s+/g, ' ').trim();
  const isAction = element => typeof element.click === 'function' &&
    (element.innerText || element.textContent || element.getAttribute?.('aria-label') || '')
      .replace(/[\\[\\]]/g, '').trim().toLowerCase() === expectedAction;
  const elements = deepElements(document);
  const containers = elements.filter(element => {
    if (!deepText(element).includes(needle)) return false;
    return deepElements(element).filter(isAction).length === 1;
  }).sort((left, right) => deepElements(left).length - deepElements(right).length);
  for (const container of containers) {
    const control = deepElements(container).find(isAction);
    if (control) {
      control.click();
      return true;
    }
  }
  return false;
})()`;

const freezeTab = async (context, driver, fixture, label) => {
  const url = fixture.url(label);
  const control = await context.newPage();
  try {
    await control.goto('edge://discards/');
    await waitFor(() => control.evaluate(discardsActionClick(url, 'freeze')),
      `Edge Freeze control for ${label}`, 15_000, 250);
    return waitFor(async () => {
      const tab = await tabByLabel(driver, label);
      return tab?.active === false && tab?.discarded === false && tab?.frozen === true ? tab : false;
    }, `${label} to become frozen`);
  }
  finally {
    await control.close().catch(() => {});
  }
};

const discardFromIsolatedController = async (driver, label) => {
  const before = await tabByLabel(driver, label);
  ensure(before?.active === false, 'isolated controller cannot discard an active target');
  const accepted = await driver.evaluate(id => new Promise(resolve => {
    chrome.tabs.discard(id, tab => {
      const error = chrome.runtime.lastError;
      resolve(error ? {ok: false} : {ok: Boolean(tab)});
    });
  }), before.id);
  ensure(accepted?.ok === true, 'isolated controller native discard was rejected');
  return stableDiscarded(driver, label);
};

const createTopology = async (driver, fixture, name) => {
  const labels = {
    left: `${name}-left`,
    other: `${name}-other`,
    otherKeeper: `${name}-other-keeper`,
    right: `${name}-right`,
    selected: `${name}-selected`
  };
  const created = await driver.evaluate(async ({labels, urls}) => {
    const primary = await chrome.windows.create({focused: true, url: urls.selected});
    const selected = primary.tabs[0];
    const left = await chrome.tabs.create({
      active: false, index: 0, url: urls.left, windowId: primary.id
    });
    const right = await chrome.tabs.create({
      active: false, url: urls.right, windowId: primary.id
    });
    await chrome.tabs.update(selected.id, {active: true});
    const secondary = await chrome.windows.create({focused: false, url: urls.otherKeeper});
    const other = await chrome.tabs.create({
      active: false, url: urls.other, windowId: secondary.id
    });
    return {
      labels,
      primaryWindowId: primary.id,
      secondaryWindowId: secondary.id,
      selected: {id: selected.id, windowId: primary.id},
      targetIds: {left: left.id, other: other.id, right: right.id}
    };
  }, {
    labels,
    urls: Object.fromEntries(Object.entries(labels).map(([key, label]) => [key, fixture.url(label)]))
  });
  await waitFor(() => Object.values(labels).every(label => fixture.count(label) === 1),
    `${name} fixture topology to load`);
  return created;
};

const closeTopology = (driver, topology) => driver.evaluate(async ids => {
  for (const id of ids) {
    try { await chrome.windows.remove(id); }
    catch (error) {}
  }
}, [topology.primaryWindowId, topology.secondaryWindowId]);

const suspendExternal = async (driver, label) => {
  const before = await tabByLabel(driver, label);
  ensure(before && before.active === false, `${label} is not an inactive external-discard target`);
  await driver.evaluate(id => chrome.tabs.discard(id), before.id);
  const after = await stableDiscarded(driver, label);
  return {after, replaced: after.id !== before.id};
};

const expectedScopeRoles = command => ({
  'release-lefts': ['left'],
  'release-other-windows': ['other'],
  'release-rights': ['right'],
  'release-tabs': ['left', 'right', 'other'],
  'release-window': ['left', 'right']
})[command];

const runReleaseScope = async ({command, context, driver, fixture}) => {
  const topology = await createTopology(driver, fixture, `scope-${command}`);
  const roles = ['left', 'right', 'other'];
  const expectedRoles = expectedScopeRoles(command);
  ensure(expectedRoles, `unknown release scope ${command}`);
  try {
    const frozen = await freezeTab(context, driver, fixture, topology.labels.left);
    await activateLabel(driver, topology.labels.selected);
    const right = await suspendExternal(driver, topology.labels.right);
    const other = await suspendExternal(driver, topology.labels.other);
    ensure(frozen.frozen === true && right.after.discarded === true && other.after.discarded === true,
      `${command} did not establish mixed frozen/discarded scope inputs`);

    const selected = await tabByLabel(driver, topology.labels.selected);
    ensure(selected?.active === true && selected.windowId === topology.primaryWindowId,
      `${command} selected root changed during setup`);
    const beforeCounts = Object.fromEntries(roles.map(role => [
      role, fixture.count(topology.labels[role])
    ]));
    const beforeMonitor = await monitorSnapshot(driver);
    const scopeTargetIds = Object.fromEntries((await Promise.all(roles.map(async role => [
      role, (await tabByLabel(driver, topology.labels[role]))?.id
    ]))));
    const response = await popupCommand(driver, command, selected);
    ensure(response?.ok === true, `${command} popup release failed: ${response?.apiError || 'no response'}`);
    const progress = response.value;

    const final = {};
    const releases = {};
    for (const role of roles) {
      const label = topology.labels[role];
      if (expectedRoles.includes(role)) {
        releases[role] = await stableReleased({
          beforeMonitor,
          beforeRequests: beforeCounts[role],
          driver,
          fixture,
          initialIds: [scopeTargetIds[role]],
          label,
          response
        });
        final[role] = releases[role].tab;
      }
      else {
        final[role] = await tabByLabel(driver, label);
        ensure(final[role]?.discarded === true || final[role]?.frozen === true,
          `${command} changed out-of-scope ${role}`);
        ensure(fixture.count(label) === beforeCounts[role],
          `${command} requested out-of-scope ${role}`);
      }
    }
    const releaseResults = expectedRoles.map(role => releases[role]);
    const releaseProgress = requireReleaseProgress(progress, releaseResults, command);
    const afterMonitor = await monitorSnapshot(driver);
    const activations = targetActivationCount(beforeMonitor, afterMonitor,
      Object.values(scopeTargetIds));
    ensure(activations === 0, `${command} activated a release target`);
    const states = Object.fromEntries(roles.map(role => [role, summarizeTab(final[role])]));
    const retainedFrozen = releaseResults.reduce((count, release) =>
      count + release.retainedFrozen, 0);
    return {
      capabilityLimitation: retainedFrozen > 0 ? RETAINED_FROZEN_LIMITATION : null,
      command,
      dispositions: Object.fromEntries(expectedRoles.map(role => [role, releases[role].disposition])),
      expectedRoles,
      fullyUnfrozen: retainedFrozen === 0,
      inputStates: {
        left: 'edge-frozen',
        other: other.replaced ? 'discarded-replacement' : 'discarded-stable-id',
        right: right.replaced ? 'discarded-replacement' : 'discarded-stable-id'
      },
      oldOwnershipAbsent: Object.fromEntries(expectedRoles.map(role => [
        role, releases[role].oldOwnershipAbsent
      ])),
      outcomeCodes: Object.fromEntries(expectedRoles.map(role => [role, releases[role].outcomeCode])),
      reloads: Object.fromEntries(roles.map(role => [role,
        fixture.count(topology.labels[role]) - beforeCounts[role]
      ])),
      releaseProgress,
      retainedFrozen,
      states,
      targetActivations: 0
    };
  }
  finally {
    await closeTopology(driver, topology).catch(() => {});
  }
};

const markerByLabel = async (driver, label) => {
  const tab = await tabByLabel(driver, label);
  if (!tab) return undefined;
  const markers = await markerSnapshot(driver);
  return markers[tab.id];
};

const expectNoNativeCall = async (debuggerGate, task, label) => {
  const checkpoint = debuggerGate.checkpoint();
  const previousHolds = [...debuggerGate.heldStages];
  debuggerGate.hold([...new Set([...previousHolds, 'before-native-invocation'])]);
  try {
    const possiblePause = debuggerGate.waitForPauseOptional('before-native-invocation', 1000)
      .then(async pause => {
        if (pause) await debuggerGate.resume(pause).catch(() => {});
        return pause;
      });
    const [result, pause] = await Promise.all([Promise.resolve().then(task), possiblePause]);
    if (pause) throw Error(`${label} reached a duplicate native discard call`);
    const after = debuggerGate.checkpoint();
    ensure(after.beforeNativeHits === checkpoint.beforeNativeHits &&
      after.executedNativeCalls === checkpoint.executedNativeCalls,
    `${label} changed the native invocation checkpoint`);
    return result;
  }
  finally {
    debuggerGate.hold(previousHolds);
  }
};

const runTerminationBoundary = async ({boundary, context, debuggerGate, driver, fixture}) => {
  ensure(TERMINATION_BOUNDARIES.includes(boundary), `unknown termination boundary ${boundary}`);
  const topology = await createTopology(driver, fixture, `restart-${boundary}`);
  const label = topology.labels.right;
  let cleanupOrphan = false;
  try {
    debuggerGate.hold(TERMINATION_BOUNDARIES);
    const frozen = await freezeTab(context, driver, fixture, label);
    await activateLabel(driver, topology.labels.selected);
    const selected = await tabByLabel(driver, topology.labels.selected);
    ensure(frozen?.frozen === true && selected?.active === true,
      `${boundary} did not establish its frozen direct-native target`);
    const beforeRequests = fixture.count(label);
    const monitorBefore = await monitorSnapshot(driver);
    const nativeBefore = debuggerGate.checkpoint();
    // Frozen renderers cannot prove form/media safety. Use the public Shift
    // override deliberately so this gate reaches the direct-native boundary;
    // release commands below remain unforced and retain their normal policy.
    const command = popupCommand(driver, 'discard-rights', selected, true);
    // Keep a rejection/late lastError owned even though the worker is about to
    // die underneath the original response channel.
    command.catch(() => {});
    const beforePause = await debuggerGate.waitForPause('before-native-invocation');
    const pending = await markerByLabel(driver, label);
    ensure(pending?.state === 'direct-native-pending',
      `${boundary} reached native code before durable pending intent was visible`);

    let physical;
    let terminatedTargetId;
    if (boundary === 'before-native-invocation') {
      terminatedTargetId = beforePause.targetId;
      await debuggerGate.terminate(beforePause, driver.sessionId);
    }
    else {
      await debuggerGate.resume(beforePause);
      const afterCall = await debuggerGate.waitForPause('during-native-wait');
      if (boundary === 'during-native-wait') {
        terminatedTargetId = afterCall.targetId;
        await debuggerGate.terminate(afterCall, driver.sessionId);
      }
      else {
        await debuggerGate.resume(afterCall);
        const settled = await debuggerGate.waitForPause('after-replacement-settlement');
        physical = await stableDiscarded(driver, label);
        const monitorAtSettlement = await monitorSnapshot(driver);
        const lineage = monitorAtSettlement.replacements.slice(monitorBefore.replacements.length);
        ensure(lineage.some(event => event.removedId === frozen.id && event.addedId === physical.id),
          'after-replacement-settlement did not cross the observed Edge replacement lineage');
        ensure((await markerByLabel(driver, label))?.state === 'direct-native-pending',
          'replacement settlement lost the durable direct-native marker before worker stop');
        terminatedTargetId = settled.targetId;
        await debuggerGate.terminate(settled, driver.sessionId);
      }
    }

    debuggerGate.hold([]);

    await bounded(command, 5000, `${boundary} interrupted popup response`).catch(() => undefined);
    // A public extension message is the real browser wake path. A single event
    // can race the exact stop, so issue bounded read-only snapshot pokes while
    // auto-attach configures the replacement. No alarm/discard mutation is
    // retried; readiness still requires three bound source locations.
    let poking = true;
    const pokeLoop = (async () => {
      while (poking) {
        await pokeWorker(driver).catch(() => false);
        await sleep(100);
      }
    })();
    try {
      await debuggerGate.ensureReadyWorker(10_000, {excludeTargetId: terminatedTargetId});
    }
    catch (error) {
      error.wakeCategory = 'no-worker-response';
      throw error;
    }
    finally {
      poking = false;
      await pokeLoop;
    }
    const lastWakeResponse = await wakeWorker(driver).catch(error => ({apiError: error.message}));
    ensure(lastWakeResponse?.ok === true,
      'restarted extension worker message response was not successful');

    if (boundary === 'during-native-wait') {
      // tabs.discard() crossed the native boundary, but the killed worker was
      // unavailable for Edge's replacement event. A physical successor may be
      // observed by this independent driver, but production has no causal edge
      // that authorizes attaching the predecessor nonce to it.
      cleanupOrphan = true;
      physical = await stableDiscarded(driver, label);
      await waitFor(async () => {
        const counts = await ownershipFenceCounts(driver);
        const successorMarker = await markerByLabel(driver, label);
        return counts.directNativeOrphans === 1 && counts.directNativePending === 0 &&
          counts.total === 1 && successorMarker === undefined ? counts : false;
      }, 'during-native restart count-only unattributed orphan fence');
      const repeatBeforeMonitor = await monitorSnapshot(driver);
      const repeatBeforeRequests = fixture.count(label);
      const repeated = await expectNoNativeCall(debuggerGate,
        async () => popupCommand(driver, 'discard-rights',
          await tabByLabel(driver, topology.labels.selected)),
        'during-native orphan repeat discard');
      await sleep(100);
      const repeatAfterMonitor = await monitorSnapshot(driver);
      const repeatApi = workerApiDelta(repeatBeforeMonitor, repeatAfterMonitor);
      const repeatOutcomes = Object.values(repeated?.value?.outcomes || {});
      ensure(repeated?.ok === true && repeated.value?.completed === 1 && repeated.value?.total === 1 &&
        repeated.value?.summary?.success === 0 &&
        Number(repeated.value?.summary?.failed || 0) +
          Number(repeated.value?.summary?.skipped || 0) === 1 &&
        repeatOutcomes.length === 1 && ['failed', 'skipped'].includes(repeatOutcomes[0]?.status),
      'during-native orphan repeat discard did not fail closed through the popup path');
      ensure(fixture.count(label) === repeatBeforeRequests && repeatApi.executeScript === 0 &&
        repeatApi.reload === 0 &&
        targetActivationCount(repeatBeforeMonitor, repeatAfterMonitor, [frozen.id, physical.id]) === 0,
      'during-native orphan repeat discard mutated its fenced successor');
      ensure((await markerByLabel(driver, label)) === undefined,
        'during-native orphan repeat discard transferred ownership to the successor');

      const releaseBeforeMonitor = await monitorSnapshot(driver);
      const releaseBeforeRequests = fixture.count(label);
      const release = await expectNoNativeCall(debuggerGate,
        async () => popupCommand(driver, 'release-rights',
          await tabByLabel(driver, topology.labels.selected)),
        'during-native orphan explicit release');
      await sleep(100);
      const releaseAfterMonitor = await monitorSnapshot(driver);
      const releaseApi = workerApiDelta(releaseBeforeMonitor, releaseAfterMonitor);
      const releaseOutcomes = Object.values(release?.value?.outcomes || {});
      ensure(release?.ok === true && release.value?.state === 'failed' &&
        release.value?.completed === 1 && release.value?.total === 1 &&
        release.value?.summary?.failed === 1 && release.value?.summary?.success === 0 &&
        releaseOutcomes.length === 1 && releaseOutcomes[0]?.status === 'failed' &&
        releaseOutcomes[0]?.code === ORPHAN_RELEASE_OUTCOME_CODE,
      'during-native orphan release did not fail closed through the popup path');
      ensure(fixture.count(label) === releaseBeforeRequests && releaseApi.executeScript === 0 &&
        releaseApi.reload === 0 &&
        targetActivationCount(releaseBeforeMonitor, releaseAfterMonitor, [frozen.id, physical.id]) === 0,
      'during-native orphan release mutated its fenced successor');
      ensure((await markerByLabel(driver, label)) === undefined,
        'during-native orphan release transferred ownership to the successor');

      const finalFenceCounts = await ownershipFenceCounts(driver);
      ensure(finalFenceCounts.directNativeOrphans === 1 &&
        finalFenceCounts.directNativePending === 0 && finalFenceCounts.total === 1,
      'during-native orphan fence was not retained after blocked popup commands');
      const nativeAfter = debuggerGate.checkpoint();
      ensure(nativeAfter.executedNativeCalls - nativeBefore.executedNativeCalls === 1,
        'during-native worker loss did not retain exactly its original native call');
      ensure(nativeAfter.unexpectedPauses === 0,
        'during-native orphan branch produced an unclassified debugger pause');
      const monitorAfter = await monitorSnapshot(driver);
      ensure(targetActivationCount(monitorBefore, monitorAfter, [frozen.id, physical.id]) === 0,
        'during-native orphan branch activated its target');
      return {
        boundary,
        failClosedBeforeAuthority: false,
        final: summarizeTab(await tabByLabel(driver, label)),
        finalReleasePromised: false,
        fullyUnfrozen: false,
        nativeCallEntries: nativeAfter.beforeNativeHits - nativeBefore.beforeNativeHits,
        nativeCallsExecuted: nativeAfter.executedNativeCalls - nativeBefore.executedNativeCalls,
        orphanCleanup: 'explicit-reset-after-target-removal',
        orphanFence: true,
        orphanFenceCounts: finalFenceCounts,
        releaseBlocked: true,
        releaseCapabilityLimitation: null,
        releaseDisposition: 'blocked-native-orphan',
        releaseOutcomeCode: releaseOutcomes[0].code,
        releaseProgress: {
          completed: Number(release.value.completed),
          state: release.value.state,
          summary: {
            failed: Number(release.value.summary.failed),
            skipped: Number(release.value.summary.skipped || 0),
            success: Number(release.value.summary.success)
          },
          total: Number(release.value.total)
        },
        releaseReloads: fixture.count(label) - beforeRequests,
        repeatDiscardBlocked: true,
        repeatDiscardOutcomeCode: repeatOutcomes[0].code,
        replacementObserved: monitorAfter.replacements
          .slice(monitorBefore.replacements.length)
          .some(event => event.removedId === frozen.id && event.addedId === physical.id),
        restartOwnership: 'unattributed-orphan',
        retainedFrozen: 0,
        successorOwnershipAbsent: true,
        targetActivations: 0,
        zeroMutation: {
          release: {
            nativeCalls: 0,
            reloads: releaseApi.reload,
            rendererScripts: releaseApi.executeScript,
            requests: fixture.count(label) - releaseBeforeRequests,
            targetActivations: 0
          },
          repeatDiscard: {
            nativeCalls: 0,
            reloads: repeatApi.reload,
            rendererScripts: repeatApi.executeScript,
            requests: releaseBeforeRequests - repeatBeforeRequests,
            targetActivations: 0
          }
        }
      };
    }

    let failedClosedBeforeAuthority = false;
    if (boundary === 'before-native-invocation') {
      const current = await tabByLabel(driver, label);
      ensure(current?.frozen === true && current?.discarded === false,
        'pre-invocation termination changed the physical frozen target');
      ensure((await markerByLabel(driver, label))?.state === 'direct-native-pending',
        'pre-invocation restart did not preserve its fail-closed pending fence');

      const blockedRelease = await expectNoNativeCall(debuggerGate,
        async () => popupCommand(driver, 'release-rights',
          await tabByLabel(driver, topology.labels.selected)),
        'pre-invocation fail-closed release');
      ensure(blockedRelease?.ok === true && blockedRelease.value?.state === 'failed' &&
        blockedRelease.value?.summary?.failed === 1,
      'pre-invocation ambiguous intent did not fail release closed');
      ensure(fixture.count(label) === beforeRequests,
        'pre-invocation fail-closed release requested the frozen document');
      failedClosedBeforeAuthority = true;

      // The persisted fence is intentionally indefinite: the killed worker did
      // not invoke the native call, so only a new authoritative browser event
      // can resolve it. Edge's internal page exposes only Load for a frozen row,
      // so use the isolated extension control page to invoke the browser API
      // outside production worker code. The armed worker breakpoint proves no
      // production duplicate; production must consume the resulting physical
      // replacement lifecycle,
      // never issue a second production native call, then allow one release.
      physical = await expectNoNativeCall(debuggerGate,
        () => discardFromIsolatedController(driver, label),
        'pre-invocation isolated-controller physical authority');
      const reconciled = await waitFor(async () => {
        const marker = await markerByLabel(driver, label);
        return marker?.state === 'owned' && marker.source === 'physical-only' ? marker : false;
      }, 'pre-invocation external physical authority reconciliation');
      ensure(reconciled.source === 'physical-only',
        'pre-invocation external authority was not reconciled conservatively');
    }
    else {
      physical ||= await stableDiscarded(driver, label);
      const reconciled = await waitFor(async () => {
        const marker = await markerByLabel(driver, label);
        return marker?.state === 'owned' && marker.source === 'physical-only' ? marker : false;
      }, `${boundary} startup physical-only reconciliation`);
      ensure(reconciled.source === 'physical-only', `${boundary} guessed self ownership after worker loss`);
    }

    const repeated = await expectNoNativeCall(debuggerGate,
      async () => popupCommand(driver, 'discard-rights',
        await tabByLabel(driver, topology.labels.selected)),
      `${boundary} repeat discard`);
    ensure(repeated?.ok === true, `${boundary} repeat command did not settle through the genuine popup path`);

    const releaseSelected = await tabByLabel(driver, topology.labels.selected);
    const release = await expectNoNativeCall(debuggerGate,
      () => popupCommand(driver, 'release-rights', releaseSelected), `${boundary} explicit release`);
    const releaseResponse = summarizePopupResponse(release);
    ensure(release?.ok === true, `${boundary} release did not return a popup result`);
    let released;
    let releaseProgress;
    try {
      released = await stableReleased({
        beforeMonitor: monitorBefore,
        beforeRequests,
        driver,
        fixture,
        initialIds: [frozen.id],
        label,
        response: release
      });
      releaseProgress = requireReleaseProgress(release.value, [released], boundary);
    }
    catch (cause) {
      const error = Error(`${boundary} did not report a truthful bounded release: ` +
        `${JSON.stringify(releaseResponse)}; ${cause.message}`, {cause});
      error.releaseFailureState = summarizeTab(await tabByLabel(driver, label));
      throw error;
    }
    const monitorAfter = await monitorSnapshot(driver);
    const activations = targetActivationCount(monitorBefore, monitorAfter, [frozen.id]);
    ensure(activations === 0, `${boundary} activated a target during takeover/restart/release`);
    const nativeAfter = debuggerGate.checkpoint();
    const expectedNative = boundary === 'before-native-invocation' ? 0 : 1;
    ensure(nativeAfter.executedNativeCalls - nativeBefore.executedNativeCalls === expectedNative,
      `${boundary} did not execute exactly ${expectedNative} native discard call(s)`);
    ensure(nativeAfter.unexpectedPauses === 0, `${boundary} produced an unclassified debugger pause`);
    return {
      boundary,
      externalAuthority: boundary === 'before-native-invocation' ?
        'isolated-controller-native-discard' : null,
      failClosedBeforeAuthority: failedClosedBeforeAuthority,
      final: summarizeTab(released.tab),
      fullyUnfrozen: released.fullyUnfrozen,
      nativeCallEntries: nativeAfter.beforeNativeHits - nativeBefore.beforeNativeHits,
      nativeCallsExecuted: nativeAfter.executedNativeCalls - nativeBefore.executedNativeCalls,
      oldOwnershipAbsent: released.oldOwnershipAbsent,
      releaseCapabilityLimitation: released.retainedFrozen > 0 ? RETAINED_FROZEN_LIMITATION : null,
      releaseDisposition: released.disposition,
      releaseOutcomeCode: released.outcomeCode,
      releaseProgress,
      releaseReloads: fixture.count(label) - beforeRequests,
      retainedFrozen: released.retainedFrozen,
      replacementObserved: (await monitorSnapshot(driver)).replacements
        .slice(monitorBefore.replacements.length)
        .some(event => event.removedId === frozen.id),
      restartOwnership: 'physical-only',
      targetActivations: 0
    };
  }
  finally {
    debuggerGate.hold([]);
    await clearCancellation(driver).catch(() => {});
    await closeTopology(driver, topology).catch(() => {});
    if (cleanupOrphan) {
      await waitFor(async () => !(await tabByLabel(driver, label)),
        'during-native orphan target topology removal', 10_000, 50);
      const reset = await message(driver, {method: 'reset'});
      ensure(reset?.ok === true, 'explicit isolated-profile orphan cleanup reset failed');
      await waitFor(async () => {
        const counts = await ownershipFenceCounts(driver);
        return counts.directNativeOrphans === 0 && counts.total === 0 ? counts : false;
      }, 'explicit isolated-profile orphan cleanup');
      await driver.evaluate(prefs => chrome.storage.local.set(prefs), ISOLATED_PREFERENCES);
      await waitFor(() => driver.evaluate(() => new Promise(resolve =>
        chrome.alarms.get('number.check', alarm => resolve(!alarm)))),
      'automatic discard alarm removal after orphan cleanup', 10_000, 50);
    }
  }
};

const latestRunningJobId = async driver => waitFor(async () => {
  const monitor = await monitorSnapshot(driver);
  return [...monitor.progress].reverse().find(entry => entry.state === 'running')?.jobId || false;
}, 'running popup job identity', 10_000);

const cancelPopupJob = (driver, jobId) => message(driver, {
  jobId,
  method: 'popup-progress-cancel'
}, 20_000);

const runDirectCancellation = async ({phase, context, debuggerGate, driver, fixture}) => {
  ensure(['pre-native', 'native-pending', 'late-settlement'].includes(phase),
    `unsupported direct cancellation phase ${phase}`);
  const topology = await createTopology(driver, fixture, `cancel-${phase}`);
  const label = topology.labels.right;
  try {
    const frozen = await freezeTab(context, driver, fixture, label);
    await activateLabel(driver, topology.labels.selected);
    const selected = await tabByLabel(driver, topology.labels.selected);
    const beforeRequests = fixture.count(label);
    const beforeNative = debuggerGate.checkpoint();
    const beforeMonitor = await monitorSnapshot(driver);
    let cancellation;
    if (phase === 'pre-native') {
      await setCancellation(driver, 'pre-native', frozen.id);
    }
    else if (phase === 'native-pending') {
      debuggerGate.hold(['during-native-wait']);
    }
    else {
      // The trusted extension page observes the real unloaded successor and
      // sends the public cancel command during waitForDirectNativeBoundary's
      // stable dwell. This proves late physical settlement without using the
      // debugger to mutate or call production code.
      await setCancellation(driver, 'late-settlement', frozen.id);
    }

    const command = popupCommand(driver, 'discard-rights', selected, true);
    if (phase === 'native-pending') {
      const pause = await debuggerGate.waitForPause('during-native-wait');
      // Edge may publish the replacement successor before the worker consumes
      // onReplaced, so a current-tab lookup can temporarily miss the marker
      // still keyed to the predecessor. Require the exact ID-free durable
      // state instead: one pending intent and no unattributed orphan.
      const durablePending = await waitFor(async () => {
        const counts = await ownershipFenceCounts(driver);
        return counts.directNativePending === 1 && counts.directNativeOrphans === 0 &&
          counts.total === 1 ? counts : false;
      }, 'native-pending durable intent', 2000, 10).catch(() => false);
      ensure(durablePending?.directNativePending === 1,
        'native-pending cancellation did not observe its durable intent');
      const cancel = cancelPopupJob(driver, await latestRunningJobId(driver));
      debuggerGate.hold([]);
      await debuggerGate.resume(pause);
      cancellation = await cancel;
    }
    const response = await command;
    if (phase === 'pre-native') {
      const monitor = await waitFor(async () => {
        const snapshot = await monitorSnapshot(driver);
        return snapshot.cancellation.fired ? snapshot : false;
      }, 'pre-native popup cancellation');
      ensure(monitor.cancellation.accepted === true,
        'pre-native popup cancellation was not accepted');
    }
    else if (phase === 'native-pending') {
      ensure(cancellation?.ok === true && cancellation.value?.accepted === true,
        `${phase} popup cancellation was not accepted`);
    }
    else {
      const monitor = await waitFor(async () => {
        const snapshot = await monitorSnapshot(driver);
        return snapshot.cancellation.fired && snapshot.cancellation.accepted ? snapshot : false;
      }, 'late-settlement popup cancellation');
      const physical = await stableDiscarded(driver, label);
      ensure(monitor.replacements.slice(beforeMonitor.replacements.length)
        .some(event => event.removedId === frozen.id && event.addedId === physical.id),
      'late-settlement cancellation did not cross an Edge replacement');
    }
    ensure(response?.ok === true && response.value?.state === 'cancelled',
      `${phase} command did not report a cancelled terminal snapshot`);
    await clearCancellation(driver);

    const afterNative = debuggerGate.checkpoint();
    const expectedNativeCalls = phase === 'pre-native' ? 0 : 1;
    ensure(afterNative.executedNativeCalls - beforeNative.executedNativeCalls === expectedNativeCalls,
      `${phase} cancellation crossed ${expectedNativeCalls} expected native call(s)`);
    if (phase === 'pre-native') {
      const stillFrozen = await tabByLabel(driver, label);
      ensure(stillFrozen?.frozen === true && stillFrozen?.discarded === false,
        'pre-native cancellation mutated its frozen target');
    }
    else {
      await stableDiscarded(driver, label);
    }

    const release = await expectNoNativeCall(debuggerGate,
      async () => popupCommand(driver, 'release-rights',
        await tabByLabel(driver, topology.labels.selected)),
      `${phase} cancellation release`);
    ensure(release?.ok === true, `${phase} cancellation release did not return a popup result`);
    const released = await stableReleased({
      beforeMonitor,
      beforeRequests,
      driver,
      fixture,
      initialIds: [frozen.id],
      label,
      response: release
    });
    const releaseProgress = requireReleaseProgress(
      release.value, [released], `${phase} cancellation`);
    const afterMonitor = await monitorSnapshot(driver);
    ensure(afterMonitor.activations.slice(beforeMonitor.activations.length).length === 0,
      `${phase} cancellation activated a tab`);
    return {
      cancellationAccepted: true,
      final: summarizeTab(released.tab),
      fullyUnfrozen: released.fullyUnfrozen,
      nativeCallsExecuted: expectedNativeCalls,
      oldOwnershipAbsent: released.oldOwnershipAbsent,
      phase,
      releaseCapabilityLimitation: released.retainedFrozen > 0 ? RETAINED_FROZEN_LIMITATION : null,
      releaseDisposition: released.disposition,
      releaseOutcomeCode: released.outcomeCode,
      releaseProgress,
      releaseReloads: 1,
      retainedFrozen: released.retainedFrozen,
      replacementObserved: phase === 'late-settlement',
      targetActivations: 0
    };
  }
  finally {
    debuggerGate.hold([]);
    await clearCancellation(driver).catch(() => {});
    await closeTopology(driver, topology).catch(() => {});
  }
};

const createQueuedTopology = async (driver, fixture) => {
  const selectedLabel = 'cancel-queued-selected';
  const targetLabels = Array.from({length: 5}, (_, index) => `cancel-queued-target-${index + 1}`);
  const created = await driver.evaluate(async ({selectedUrl, targetUrls}) => {
    const primary = await chrome.windows.create({focused: true, url: selectedUrl});
    const selected = primary.tabs[0];
    const targets = [];
    for (const url of targetUrls) {
      targets.push(await chrome.tabs.create({active: false, url, windowId: primary.id}));
    }
    await chrome.tabs.update(selected.id, {active: true});
    return {
      primaryWindowId: primary.id,
      selected: {id: selected.id, windowId: primary.id},
      targetIds: targets.map(tab => tab.id)
    };
  }, {
    selectedUrl: fixture.url(selectedLabel),
    targetUrls: targetLabels.map(label => fixture.url(label))
  });
  await waitFor(() => [selectedLabel, ...targetLabels].every(label => fixture.count(label) === 1),
    'queued cancellation topology to load');
  return {...created, selectedLabel, targetLabels};
};

const runQueuedCancellation = async ({context, debuggerGate, driver, fixture}) => {
  const topology = await createQueuedTopology(driver, fixture);
  const queuedLabel = topology.targetLabels.at(-1);
  try {
    for (const label of topology.targetLabels) {
      await activateLabel(driver, topology.selectedLabel);
      await freezeTab(context, driver, fixture, label);
    }
    await activateLabel(driver, topology.selectedLabel);
    const selected = await tabByLabel(driver, topology.selectedLabel);
    const beforeRequests = fixture.count(queuedLabel);
    const beforeNative = debuggerGate.checkpoint();
    const beforeMonitor = await monitorSnapshot(driver);
    debuggerGate.hold(['before-native-invocation']);
    const command = popupCommand(driver, 'discard-rights', selected, true);
    const firstPause = await debuggerGate.waitForPause('before-native-invocation');
    const queuedMarker = await waitFor(async () => {
      const marker = await markerByLabel(driver, queuedLabel);
      return marker?.state === 'takeover-queued' ? marker : false;
    }, 'fifth takeover to remain durably queued', 10_000);
    ensure(queuedMarker.source === 'requested', 'queued takeover marker lost explicit-request authority');
    const cancel = cancelPopupJob(driver, await latestRunningJobId(driver));
    debuggerGate.hold([]);
    await debuggerGate.resume(firstPause);
    const cancellation = await cancel;
    ensure(cancellation?.ok === true && cancellation.value?.accepted === true,
      'queued popup cancellation was not accepted');
    const response = await command;
    ensure(response?.ok === true && response.value?.state === 'cancelled',
      'queued command did not settle cancelled');
    const queued = await tabByLabel(driver, queuedLabel);
    ensure(queued?.frozen === true && queued?.discarded === false,
      'queued cancellation reached native discard for the queued target');
    ensure((await markerByLabel(driver, queuedLabel)) === undefined,
      'queued cancellation left ownership intent behind');

    // Remove the four scheduler heads so the genuine bulk release scope contains
    // only the proven never-started queued target.
    for (const label of topology.targetLabels.slice(0, -1)) {
      const tab = await tabByLabel(driver, label);
      if (tab) await driver.evaluate(id => chrome.tabs.remove(id), tab.id);
    }
    const release = await expectNoNativeCall(debuggerGate,
      async () => popupCommand(driver, 'release-rights',
        await tabByLabel(driver, topology.selectedLabel)),
      'queued cancellation release');
    ensure(release?.ok === true, 'queued cancellation release did not return a popup result');
    const released = await stableReleased({
      beforeMonitor,
      beforeRequests,
      driver,
      fixture,
      initialIds: [queued.id],
      label: queuedLabel,
      response: release
    });
    const releaseProgress = requireReleaseProgress(release.value, [released], 'queued cancellation');
    const afterMonitor = await monitorSnapshot(driver);
    ensure(afterMonitor.activations.slice(beforeMonitor.activations.length).length === 0,
      'queued cancellation activated a target');
    const afterNative = debuggerGate.checkpoint();
    ensure(afterNative.executedNativeCalls - beforeNative.executedNativeCalls <= 4,
      'queued cancellation allowed the fifth native discard invocation');
    return {
      cancellationAccepted: true,
      final: summarizeTab(released.tab),
      fullyUnfrozen: released.fullyUnfrozen,
      nativeCallsExecutedForSchedulerHeads:
        afterNative.executedNativeCalls - beforeNative.executedNativeCalls,
      oldOwnershipAbsent: released.oldOwnershipAbsent,
      phase: 'queued',
      queuedTargetNativeCallExecuted: false,
      releaseCapabilityLimitation: released.retainedFrozen > 0 ? RETAINED_FROZEN_LIMITATION : null,
      releaseDisposition: released.disposition,
      releaseOutcomeCode: released.outcomeCode,
      releaseProgress,
      releaseReloads: 1,
      retainedFrozen: released.retainedFrozen,
      targetActivations: 0
    };
  }
  finally {
    debuggerGate.hold([]);
    await driver.evaluate(async id => {
      try { await chrome.windows.remove(id); }
      catch (error) {}
    }, topology.primaryWindowId).catch(() => {});
  }
};

const run = async () => {
  const executable = path.resolve(option('executable', '') || '');
  const extension = path.resolve(option('extension', DEFAULT_EXTENSION));
  const profileRoot = path.resolve(option('profile-root', DEFAULT_PROFILE_ROOT));
  const resultsRoot = path.resolve(option('results', DEFAULT_RESULTS_ROOT));
  ensure(process.argv.includes('--allow-edge'), 'refusing to launch real Edge without --allow-edge');
  ensure(path.basename(executable).toLowerCase() === 'msedge.exe' && fs.existsSync(executable),
    '--executable must name an existing msedge.exe');
  ensure(fs.existsSync(path.join(extension, 'manifest.json')),
    '--extension must name an unpacked extension tree');
  fs.mkdirSync(profileRoot, {recursive: true});
  fs.mkdirSync(resultsRoot, {recursive: true});
  const profile = path.join(profileRoot, `edge-direct-native-races-${Date.now()}-${process.pid}`);
  const reportPath = path.join(resultsRoot, RESULT_FILE);
  const treeSha256 = extensionTreeSha256(extension);
  const report = {
    browser: {family: 'edge', version: null},
    cancellations: [],
    cleanup: {
      browser: null,
      crashArtifacts: null,
      crashFree: false,
      fixtureStopped: false,
      profileRemoved: false
    },
    extension: {
      treeSha256,
      version: JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8')).version
    },
    finishedAt: null,
    outcome: 'running',
    releaseScopes: [],
    startedAt: new Date().toISOString(),
    workerTermination: []
  };
  let fixture;
  let launched;
  let debuggerGate;
  let failure;
  let emergency = true;
  const emergencyCleanup = () => {
    if (emergency) killTree(launched?.child || emergencyChild);
  };
  process.on('exit', emergencyCleanup);
  try {
    ensure(report.extension.version === EXPECTED_EXTENSION_VERSION,
      `expected extension version ${EXPECTED_EXTENSION_VERSION}, got ${report.extension.version}`);
    fixture = await fixtureServer();
    launched = await launchEdge({executable, extension, profile});
    report.browser.version = launched.browserVersion?.product || null;
    const {extensionId} = await discoverExtension(launched.raw);
    debuggerGate = await new WorkerDebugger(launched.raw, extensionId, extension).start();
    const driver = await openDriver(launched.context, extensionId);
    await debuggerGate.enableWorkerControl(driver.sessionId);
    await normalizeDriverTopology(driver);
    await installMonitor(driver);
    await driver.evaluate(prefs => chrome.storage.local.set(prefs), ISOLATED_PREFERENCES);
    await waitFor(() => driver.evaluate(() => new Promise(resolve =>
      chrome.alarms.get('number.check', alarm => resolve(!alarm)))),
    'automatic discard alarm removal', 10_000, 50);

    for (const command of RELEASE_COMMANDS) {
      report.releaseScopes.push(await runReleaseScope({
        command,
        context: launched.context,
        driver,
        fixture
      }));
    }
    for (const boundary of TERMINATION_BOUNDARIES) {
      report.workerTermination.push(await runTerminationBoundary({
        boundary,
        context: launched.context,
        debuggerGate,
        driver,
        fixture
      }));
    }
    report.cancellations.push(await runQueuedCancellation({
      context: launched.context,
      debuggerGate,
      driver,
      fixture
    }));
    for (const phase of CANCELLATION_PHASES.filter(value => value !== 'queued')) {
      report.cancellations.push(await runDirectCancellation({
        phase,
        context: launched.context,
        debuggerGate,
        driver,
        fixture
      }));
    }

    const scopeDispositions = report.releaseScopes.flatMap(scope =>
      scope.expectedRoles.map(role => scope.dispositions[role]));
    const releaseDispositions = [
      ...scopeDispositions,
      ...report.workerTermination.map(phase => phase.releaseDisposition),
      ...report.cancellations.map(phase => phase.releaseDisposition)
    ];
    ensure(releaseDispositions.length === 15 && releaseDispositions.every(disposition =>
      ['blocked-native-orphan', 'loaded', 'retained-frozen'].includes(disposition)),
    'release capability evidence did not classify all 15 exact target outcomes');
    const retainedFrozen = releaseDispositions.filter(disposition =>
      disposition === 'retained-frozen').length;
    const loaded = releaseDispositions.filter(disposition => disposition === 'loaded').length;
    const blockedNativeOrphan = releaseDispositions.filter(disposition =>
      disposition === 'blocked-native-orphan').length;
    report.releaseCapability = {
      blockedNativeOrphan,
      capabilityLimitation: retainedFrozen > 0 ? RETAINED_FROZEN_LIMITATION : null,
      fullyUnfrozen: retainedFrozen === 0 && blockedNativeOrphan === 0,
      loaded,
      retainedFrozen,
      total: releaseDispositions.length
    };

    ensure(report.releaseScopes.length === 5 &&
      report.releaseScopes.every(scope => scope.targetActivations === 0 &&
        scope.expectedRoles.every(role => scope.reloads[role] === 1) &&
        scope.expectedRoles.every(role => scope.oldOwnershipAbsent[role] === true &&
          scope.outcomeCodes[role] === (scope.dispositions[role] === 'retained-frozen' ?
            RETAINED_FROZEN_CODE : 'TAB_RELEASED')) &&
        scope.retainedFrozen === scope.expectedRoles.filter(role =>
          scope.dispositions[role] === 'retained-frozen').length &&
        scope.releaseProgress?.completed === scope.expectedRoles.length &&
        scope.releaseProgress?.total === scope.expectedRoles.length &&
        scope.releaseProgress?.summary?.failed === scope.retainedFrozen &&
        scope.releaseProgress?.summary?.success === scope.expectedRoles.length - scope.retainedFrozen &&
        scope.releaseProgress?.summary?.skipped === 0 &&
        scope.releaseProgress?.state === (scope.retainedFrozen > 0 ?
          (scope.retainedFrozen < scope.expectedRoles.length ? 'partial' : 'failed') : 'complete') &&
        scope.fullyUnfrozen === (scope.retainedFrozen === 0) &&
        scope.capabilityLimitation === (scope.retainedFrozen > 0 ?
          RETAINED_FROZEN_LIMITATION : null)),
    'five-scope release matrix did not retain exact request/activation/capability evidence');
    const orphanTermination = report.workerTermination.find(phase =>
      phase.boundary === 'during-native-wait');
    const attributableTerminations = report.workerTermination.filter(phase =>
      phase.boundary !== 'during-native-wait');
    ensure(report.workerTermination.length === 3 && attributableTerminations.length === 2 &&
      attributableTerminations.every(phase => phase.targetActivations === 0 &&
        phase.releaseReloads === 1 && phase.oldOwnershipAbsent === true &&
        phase.retainedFrozen === (phase.releaseDisposition === 'retained-frozen' ? 1 : 0) &&
        phase.releaseOutcomeCode === (phase.retainedFrozen > 0 ?
          RETAINED_FROZEN_CODE : 'TAB_RELEASED') &&
        phase.releaseProgress?.completed === 1 && phase.releaseProgress?.total === 1 &&
        phase.releaseProgress?.summary?.failed === phase.retainedFrozen &&
        phase.releaseProgress?.summary?.success === 1 - phase.retainedFrozen &&
        phase.releaseProgress?.summary?.skipped === 0 &&
        phase.releaseProgress?.state === (phase.retainedFrozen > 0 ? 'failed' : 'complete') &&
        phase.fullyUnfrozen === (phase.retainedFrozen === 0) &&
        phase.releaseCapabilityLimitation === (phase.retainedFrozen > 0 ?
          RETAINED_FROZEN_LIMITATION : null)) &&
      orphanTermination?.restartOwnership === 'unattributed-orphan' &&
      orphanTermination.orphanFence === true && orphanTermination.releaseBlocked === true &&
      orphanTermination.finalReleasePromised === false &&
      orphanTermination.releaseDisposition === 'blocked-native-orphan' &&
      orphanTermination.releaseOutcomeCode === ORPHAN_RELEASE_OUTCOME_CODE &&
      orphanTermination.releaseReloads === 0 && orphanTermination.retainedFrozen === 0 &&
      orphanTermination.successorOwnershipAbsent === true &&
      orphanTermination.replacementObserved === true && orphanTermination.targetActivations === 0 &&
      orphanTermination.releaseProgress?.state === 'failed' &&
      orphanTermination.releaseProgress?.summary?.failed === 1 &&
      orphanTermination.releaseProgress?.summary?.success === 0 &&
      orphanTermination.zeroMutation?.release?.nativeCalls === 0 &&
      orphanTermination.zeroMutation?.release?.reloads === 0 &&
      orphanTermination.zeroMutation?.release?.rendererScripts === 0 &&
      orphanTermination.zeroMutation?.release?.requests === 0 &&
      orphanTermination.zeroMutation?.release?.targetActivations === 0 &&
      orphanTermination.zeroMutation?.repeatDiscard?.nativeCalls === 0 &&
      orphanTermination.zeroMutation?.repeatDiscard?.reloads === 0 &&
      orphanTermination.zeroMutation?.repeatDiscard?.rendererScripts === 0 &&
      orphanTermination.zeroMutation?.repeatDiscard?.requests === 0 &&
      orphanTermination.zeroMutation?.repeatDiscard?.targetActivations === 0 &&
      orphanTermination.orphanFenceCounts?.directNativeOrphans === 1 &&
      orphanTermination.orphanFenceCounts?.directNativePending === 0 &&
      orphanTermination.orphanFenceCounts?.total === 1,
    'three-boundary MV3 termination matrix is incomplete');
    ensure(report.cancellations.length === 4 &&
      report.cancellations.every(phase => phase.cancellationAccepted === true &&
        phase.releaseReloads === 1 && phase.targetActivations === 0 &&
        phase.oldOwnershipAbsent === true &&
        phase.retainedFrozen === (phase.releaseDisposition === 'retained-frozen' ? 1 : 0) &&
        phase.releaseOutcomeCode === (phase.retainedFrozen > 0 ?
          RETAINED_FROZEN_CODE : 'TAB_RELEASED') &&
        phase.releaseProgress?.completed === 1 && phase.releaseProgress?.total === 1 &&
        phase.releaseProgress?.summary?.failed === phase.retainedFrozen &&
        phase.releaseProgress?.summary?.success === 1 - phase.retainedFrozen &&
        phase.releaseProgress?.summary?.skipped === 0 &&
        phase.releaseProgress?.state === (phase.retainedFrozen > 0 ? 'failed' : 'complete') &&
        phase.fullyUnfrozen === (phase.retainedFrozen === 0) &&
        phase.releaseCapabilityLimitation === (phase.retainedFrozen > 0 ?
          RETAINED_FROZEN_LIMITATION : null)),
    'four-phase cancellation matrix is incomplete');
    ensure(report.releaseCapability.loaded + report.releaseCapability.retainedFrozen +
      report.releaseCapability.blockedNativeOrphan ===
      report.releaseCapability.total && report.releaseCapability.total === 15 &&
      report.releaseCapability.blockedNativeOrphan === 1 &&
      report.releaseCapability.fullyUnfrozen ===
        (report.releaseCapability.retainedFrozen === 0 &&
          report.releaseCapability.blockedNativeOrphan === 0) &&
      report.releaseCapability.capabilityLimitation ===
        (report.releaseCapability.retainedFrozen > 0 ? RETAINED_FROZEN_LIMITATION : null),
    'overall release capability counts or retained-frozen limitation are inconsistent');
    ensure(debuggerGate.checkpoint().unexpectedPauses === 0,
      'the debugger observed an unclassified worker pause');
    ensure(debuggerGate.checkpoint().configurationErrors === 0,
      'a restarted worker could not be instrumented before resume');
  }
  catch (error) {
    failure = error;
    report.error = safeMessage(error);
    const debuggerEvidence = error.debuggerEvidence || debuggerGate?.evidence?.();
    if (Array.isArray(debuggerEvidence)) report.debuggerEvidence = sanitize(debuggerEvidence);
    if (error.wakeCategory) report.workerWakeCategory = error.wakeCategory;
    if (Number.isInteger(error.workerTargetCount)) {
      report.debuggerWorkerTargetCount = error.workerTargetCount;
    }
    if (error.targetEvidence) report.debuggerTargetEvidence = sanitize(error.targetEvidence);
    if (error.releaseFailureState) {
      report.releaseFailureState = sanitize(error.releaseFailureState);
    }
  }
  finally {
    debuggerGate?.hold([]);
    if (launched?.child) {
      try {
        report.cleanup.browser = await terminateBrowser(launched.child, launched.raw);
      }
      catch (error) {
        failure ||= error;
        report.error ||= safeMessage(error);
      }
      await launched.raw.close().catch(() => {});
      emergencyChild = undefined;
    }
    if (fixture) {
      report.fixtureRequestTotals = fixture.counts();
      try {
        // Close the isolated browser before the HTTP server so its keepalive
        // sockets cannot make an otherwise clean failure report claim that the
        // fixture did not stop.
        await fixture.stop();
        report.cleanup.fixtureStopped = true;
      }
      catch (error) {
        failure ||= error;
        report.error ||= safeMessage(error);
      }
    }
    if (fs.existsSync(profile)) {
      try {
        report.cleanup.crashArtifacts = findCrashCount(profile);
        report.cleanup.crashFree = report.cleanup.crashArtifacts === 0;
        ensure(report.cleanup.crashFree, 'Edge produced a crash artifact');
        ensure(safeProfile(profileRoot, profile), 'refusing profile cleanup outside the isolated root');
        fs.rmSync(profile, {force: true, maxRetries: 4, recursive: true, retryDelay: 250});
        report.cleanup.profileRemoved = !fs.existsSync(profile);
        ensure(report.cleanup.profileRemoved, 'isolated Edge profile was not removed');
      }
      catch (error) {
        failure ||= error;
        report.error ||= safeMessage(error);
      }
    }
    emergency = false;
    process.removeListener('exit', emergencyCleanup);
    report.finishedAt = new Date().toISOString();
    report.outcome = failure ? 'failed' : 'passed';
    fs.writeFileSync(reportPath, `${JSON.stringify(sanitize(report), null, 2)}\n`);
  }
  if (failure) {
    failure.reportPath = reportPath;
    throw failure;
  }
  return reportPath;
};

if (require.main === module) {
  run().then(reportPath => {
    process.stdout.write(`Edge direct-native release/restart gate passed: ${safeMessage(reportPath)}\n`);
  }, error => {
    process.stderr.write(`Edge direct-native release/restart gate failed: ${safeMessage(error)}\n`);
    if (error.reportPath) process.stderr.write(`Sanitized result: ${safeMessage(error.reportPath)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CANCELLATION_PHASES,
  RELEASE_COMMANDS,
  TERMINATION_BOUNDARIES,
  WorkerDebugger,
  breakpointLines,
  extensionTreeSha256,
  expectedScopeRoles,
  safeMessage,
  safeProfile,
  sanitize,
  summarizeTab
};
