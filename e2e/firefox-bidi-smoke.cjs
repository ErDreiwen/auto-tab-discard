#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {createHash, randomUUID} = require('node:crypto');
const {
  bindExactProcessTree,
  cleanupExactProcessTree,
  forceCleanupExactProcessTreeSync,
  launchProcessInExactJob,
  refreshExactProcessTree
} = require('./windows-process-tree.cjs');

const SCRIPT_DIR = __dirname;
const DEFAULT_EXTENSION = path.join(SCRIPT_DIR, '..', 'v3');
const DEFAULT_PROFILE_ROOT = path.join(SCRIPT_DIR, '.profiles');
const DEFAULT_RESULTS_ROOT = path.join(SCRIPT_DIR, 'results');
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, '..');
const BIDI_COMMAND_TIMEOUT = 20000;
const BIDI_CLEANUP_TIMEOUT = 5000;
const DWELL_MS = 3000;
const EXTERNAL_CRASH_MAX_BYTES = 256 * 1024 * 1024;
const EXTERNAL_CRASH_MAX_DEPTH = 64;
const EXTERNAL_CRASH_MAX_ENTRIES = 4096;
const KNOWN_FOLDER_TIMEOUT = 30000;
const powershellPath = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
);

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const flag = name => process.argv.includes(`--${name}`);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const ensure = (condition, message) => {
  if (!condition) {
    throw Error(message);
  }
};

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

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sanitizeText = value => String(value ?? '')
  .replace(new RegExp(escapeRegExp(WORKSPACE_ROOT), 'gi'), '<workspace>')
  .replace(/[A-Z]:[\\/]Users[\\/][^\\/\s]+/gi, '<user-path>')
  .replace(/\/(?:Users|home)\/[^/\s]+/gi, '<user-path>')
  .replace(/moz-extension:\/\/[0-9a-f-]+/gi, 'moz-extension://<redacted>')
  .replace(/https?:\/\/127\.0\.0\.1:\d+\/firefox-bidi-smoke\/[^\s"')]+/gi, '<fixture-url>')
  .replace(/\b(?:https?|ws):\/\/(?:127\.0\.0\.1|localhost):\d+(?:\/[^\s"')\]]*)?/gi, '<loopback-url>')
  .replace(/\b(?:127\.0\.0\.1|localhost):\d+\b/gi, '<loopback-endpoint>')
  .replace(/Firefox BiDi (ordinary|scoped) [0-9a-f-]{36}/gi, 'Firefox BiDi $1 <token>')
  .replace(/firefox-bidi-smoke-\d+-\d+-[0-9a-f-]+/gi, '<isolated-profile>');

const sanitize = value => {
  if (typeof value === 'string') {
    return sanitizeText(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]));
  }
  return value;
};

class BidiConnection {
  constructor(url, onEvent = () => {}) {
    this.closed = false;
    this.id = 0;
    this.onEvent = onEvent;
    this.pending = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, {once: true});
      this.socket.addEventListener('error', () => reject(Error('WebDriver BiDi WebSocket failed to open')), {
        once: true
      });
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
    if (message.type === 'event' || (message.method && message.id === undefined)) {
      this.onEvent(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.type === 'error' || message.error) {
      const detail = message.message || message.error?.message || message.error || 'protocol command failed';
      const error = Error(`${pending.method}: ${detail}`);
      error.bidi = message;
      pending.reject(error);
    }
    else {
      pending.resolve(message.result ?? {});
    }
  }

  onClose() {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Error(`WebDriver BiDi closed while waiting for ${pending.method}`));
    }
    this.pending.clear();
  }

  async send(method, params = {}, timeout = BIDI_COMMAND_TIMEOUT) {
    await withTimeout(this.ready, timeout, `${method}: WebDriver BiDi socket did not open`);
    ensure(!this.closed && this.socket.readyState === WebSocket.OPEN, 'WebDriver BiDi is not open');
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(Error(`${method}: WebDriver BiDi command timed out after ${timeout} ms`));
        }
      }, timeout);
      this.pending.set(id, {method, reject, resolve, timer});
      try {
        this.socket.send(JSON.stringify({id, method, params}));
      }
      catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(Error(`WebDriver BiDi could not send ${method}`));
      }
    });
  }

  close() {
    if (!this.closed) {
      this.socket.close();
    }
  }
}

const remoteValue = value => {
  if (!value || value.type === 'undefined' || value.type === 'null') {
    return value?.type === 'null' ? null : undefined;
  }
  if ('value' in value && !['array', 'object'].includes(value.type)) {
    return value.value;
  }
  return value;
};

const flattenContexts = contexts => {
  const output = [];
  const visit = context => {
    output.push(context);
    for (const child of context.children || []) {
      visit(child);
    }
  };
  for (const context of contexts || []) {
    visit(context);
  }
  return output;
};

const evaluate = async (bidi, context, expression, timeout = 15000) => {
  const result = await bidi.send('script.evaluate', {
    awaitPromise: true,
    expression,
    resultOwnership: 'none',
    target: {context},
    userActivation: true
  }, timeout);
  if (result.type === 'exception') {
    const message = result.exceptionDetails?.text || result.exceptionDetails?.exception?.value ||
      'extension script evaluation failed';
    throw Error(message);
  }
  ensure(result.type === 'success', 'WebDriver BiDi returned an unknown script result');
  return remoteValue(result.result);
};

const evaluateJSON = async (bidi, context, expression, timeout) => {
  const value = await evaluate(bidi, context, expression, timeout);
  ensure(typeof value === 'string', 'extension evaluation did not return JSON');
  return JSON.parse(value);
};

const requestJson = (url, method = 'GET') => new Promise((resolve, reject) => {
  const request = http.request(url, {headers: {Accept: 'application/json'}, method}, response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => {
      body = (body + chunk).slice(-1024 * 1024);
    });
    response.once('end', () => {
      if (response.statusCode !== 200) {
        reject(Error(`Firefox debugger JSON endpoint returned HTTP ${response.statusCode}`));
        return;
      }
      try {
        resolve(JSON.parse(body));
      }
      catch (error) {
        reject(Error(`Firefox debugger JSON endpoint returned invalid JSON: ${error.message}`));
      }
    });
  });
  request.once('error', reject);
  request.setTimeout(3000, () => request.destroy(Error('Firefox debugger JSON endpoint timed out')));
  request.end();
});

const putJson = url => requestJson(url, 'PUT');

const cdpEvaluateJson = async (cdp, expression) => {
  const evaluation = await cdp.send('Runtime.evaluate', {
    awaitPromise: true,
    expression,
    returnByValue: true
  });
  if (evaluation.exceptionDetails) {
    throw Error(evaluation.exceptionDetails.text || 'Firefox background evaluation failed');
  }
  const value = evaluation.result?.value;
  ensure(typeof value === 'string', 'Firefox background evaluation did not return JSON');
  return JSON.parse(value);
};

const callbackExpression = body => `new Promise(resolve => {${body}})`;
const runtimeErrorExpression = `chrome.runtime.lastError?.message || null`;

const queryTabsExpression = callbackExpression(`
  chrome.tabs.query({}, tabs => resolve(JSON.stringify({
    error: ${runtimeErrorExpression},
    tabs: (tabs || []).map(tab => ({
      active: tab.active,
      discarded: tab.discarded,
      highlighted: tab.highlighted,
      id: tab.id,
      index: tab.index,
      status: tab.status,
      title: tab.title,
      url: tab.url,
      windowId: tab.windowId
    }))
  })));
`);

const queryTabs = async (bidi, context) => {
  const response = await evaluateJSON(bidi, context, queryTabsExpression);
  ensure(!response.error, `tabs.query failed: ${response.error}`);
  return response.tabs;
};

const tabByUrl = async (bidi, context, url) => {
  const tabs = await queryTabs(bidi, context);
  return tabs.find(tab => tab.url === url);
};

// Firefox's documented Tab.status enum is only "loading" or "complete".
// `discarded: true` is its authoritative unloaded-content signal; Chromium
// additionally reports the non-standard "unloaded" status used elsewhere.
const isAuthoritativeDiscard = tab => Boolean(tab && tab.discarded === true && tab.active !== true &&
  (tab.status === 'complete' || tab.status === 'unloaded'));

const createTab = async (bidi, context, url) => {
  const response = await evaluateJSON(bidi, context, callbackExpression(`
    chrome.tabs.create({active: true, url: ${JSON.stringify(url)}}, tab => resolve(JSON.stringify({
      error: ${runtimeErrorExpression},
      tab: tab && {id: tab.id, windowId: tab.windowId}
    })));
  `));
  ensure(!response.error && Number.isInteger(response.tab?.id), `tabs.create failed: ${response.error || 'no tab'}`);
  return response.tab;
};

const activateTab = async (bidi, context, id) => {
  const response = await evaluateJSON(bidi, context, callbackExpression(`
    chrome.tabs.update(${Number(id)}, {active: true}, tab => resolve(JSON.stringify({
      error: ${runtimeErrorExpression},
      id: tab?.id
    })));
  `));
  ensure(!response.error && response.id === id, `tabs.update failed: ${response.error || 'wrong tab'}`);
};

const removeTabs = async (bidi, context, ids) => {
  const response = await evaluateJSON(bidi, context, callbackExpression(`
    chrome.tabs.remove(${JSON.stringify(ids)}, () => resolve(JSON.stringify({
      error: ${runtimeErrorExpression}
    })));
  `));
  ensure(!response.error, `tabs.remove failed: ${response.error}`);
};

const installTabMonitor = async (bidi, context) => {
  const installed = await evaluate(bidi, context, `(() => {
    if (globalThis.__firefoxBidiSmokeMonitor) {
      return true;
    }
    const monitor = globalThis.__firefoxBidiSmokeMonitor = {events: []};
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      const change = {};
      for (const key of ['active', 'discarded', 'status']) {
        if (Object.prototype.hasOwnProperty.call(changeInfo, key)) {
          change[key] = changeInfo[key];
        }
      }
      monitor.events.push({
        active: tab?.active,
        at: Date.now(),
        change,
        discarded: tab?.discarded,
        event: 'updated',
        status: tab?.status,
        tabId
      });
    });
    chrome.tabs.onActivated.addListener(info => monitor.events.push({
      at: Date.now(),
      event: 'activated',
      tabId: info.tabId
    }));
    return true;
  })()`);
  ensure(installed === true, 'The extension tab-state monitor did not install');
};

const monitorClock = (bidi, context) => evaluate(bidi, context, 'Date.now()');

const readTabMonitor = (bidi, context) => evaluateJSON(bidi, context,
  'JSON.stringify(globalThis.__firefoxBidiSmokeMonitor || {events: []})');

const summarizePostSettlement = (monitor, tabId, settledAt) => {
  const events = monitor.events.filter(event => event.tabId === tabId && event.at >= settledAt);
  const unstable = events.filter(event => event.event === 'activated' ||
    event.change?.discarded === false || event.change?.status === 'loading' ||
    event.active === true || event.discarded === false || event.status === 'loading');
  return {
    activationEvents: events.filter(event => event.event === 'activated').length,
    events: events.map(event => ({
      active: event.active,
      atMs: event.at - settledAt,
      change: event.change,
      discarded: event.discarded,
      event: event.event,
      status: event.status
    })),
    unstableEvents: unstable.length
  };
};

const runPopupCommand = async (bidi, context, command) => {
  const response = await evaluateJSON(bidi, context, callbackExpression(`
    chrome.runtime.sendMessage({
      method: 'popup',
      cmd: ${JSON.stringify(command)},
      shiftKey: false
    }, response => resolve(JSON.stringify({
      error: ${runtimeErrorExpression},
      response
    })));
  `), 45000);
  ensure(!response.error, `${command} runtime message failed: ${response.error}`);
  return response.response;
};

const startFixture = async () => {
  const token = randomUUID();
  const prefix = `/firefox-bidi-smoke/${token}`;
  const pages = new Map([
    [`${prefix}/ordinary`, {name: 'ordinary', requests: []}],
    [`${prefix}/scoped`, {name: 'scoped', requests: []}]
  ]);
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const current = new URL(request.url, 'http://127.0.0.1');
    const page = pages.get(current.pathname);
    if (!page) {
      response.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
      response.end('not found');
      return;
    }
    page.requests.push({at: Date.now(), method: request.method});
    response.writeHead(200, {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Content-Type': 'text/html; charset=utf-8',
      'Expires': '0',
      'Pragma': 'no-cache'
    });
    response.end(`<!doctype html>
      <meta charset="utf-8">
      <title>Firefox BiDi ${page.name} ${token}</title>
      <h1>${page.name}</h1>
      <script>
        sessionStorage.fixtureLoads = String(Number(sessionStorage.fixtureLoads || 0) + 1);
        globalThis.fixtureHeartbeat = setInterval(() => globalThis.fixtureLastBeat = Date.now(), 250);
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
  const urls = Object.fromEntries([...pages].map(([pathname, page]) => [
    page.name,
    `http://127.0.0.1:${address.port}${pathname}`
  ]));
  return {
    count(name) {
      return [...pages.values()].find(page => page.name === name).requests.length;
    },
    events() {
      return Object.fromEntries([...pages.values()].map(page => [page.name, [...page.requests]]));
    },
    origin: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise(resolve => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close(resolve);
    }),
    urls
  };
};

const profilePrefs = `
user_pref("app.normandy.enabled", false);
user_pref("app.update.auto", false);
user_pref("app.update.enabled", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.discovery.enabled", false);
user_pref("browser.newtabpage.enabled", false);
user_pref("browser.safebrowsing.downloads.enabled", false);
user_pref("browser.safebrowsing.malware.enabled", false);
user_pref("browser.safebrowsing.phishing.enabled", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage", "about:blank");
user_pref("browser.startup.page", 0);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("extensions.getAddons.cache.enabled", false);
user_pref("extensions.update.enabled", false);
user_pref("network.captive-portal-service.enabled", false);
user_pref("network.connectivity-service.enabled", false);
user_pref("signon.rememberSignons", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("toolkit.telemetry.unified", false);
`;

const firefoxCrashIsolation = profile => ({
  events: path.join(profile, 'crash-events'),
  minidumps: path.join(profile, 'minidumps')
});

const prepareFirefoxCrashIsolation = profile => {
  const isolation = firefoxCrashIsolation(profile);
  for (const directory of Object.values(isolation)) {
    fs.mkdirSync(directory, {recursive: true});
  }
  return isolation;
};

const firefoxCrashEnvironment = (profile, baseEnvironment = process.env) => {
  const environment = {...baseEnvironment};
  for (const name of Object.keys(environment)) {
    if (/^(?:MOZ_CRASHREPORTER(?:_|$)|MOZ_(?:LOCAL_)?APP_DATA$|CRASHES_EVENTS_DIR$)/i.test(name)) {
      delete environment[name];
    }
  }
  const isolation = firefoxCrashIsolation(profile);
  return {
    ...environment,
    CRASHES_EVENTS_DIR: isolation.events,
    MOZ_CRASHREPORTER: '1',
    MOZ_CRASHREPORTER_NO_REPORT: '1'
  };
};

const resolveWindowsApplicationData = () => {
  ensure(process.platform === 'win32' && fs.existsSync(powershellPath),
    'Firefox crash-state proof requires the Windows known-folder API');
  const outcome = spawnSync(powershellPath, [
    '-NoProfile', '-NonInteractive', '-Command',
    "[Console]::Out.Write([Environment]::GetFolderPath('ApplicationData'))"
  ], {
    encoding: 'utf8',
    timeout: KNOWN_FOLDER_TIMEOUT,
    windowsHide: true
  });
  const applicationData = String(outcome.stdout || '').trim();
  ensure(!outcome.error && outcome.status === 0 && applicationData && path.isAbsolute(applicationData),
    'Firefox crash-state proof could not resolve the Windows ApplicationData known folder');
  return path.resolve(applicationData);
};

const externalFirefoxCrashRoots = (environment, platform = process.platform, {
  resolveApplicationData = resolveWindowsApplicationData
} = {}) => {
  if (platform !== 'win32') return [];
  const inheritedValues = Object.entries(environment || {})
    .filter(([name]) => name.toUpperCase() === 'APPDATA')
    .map(([, value]) => value);
  ensure(inheritedValues.length > 0 && inheritedValues.every(value =>
    typeof value === 'string' && value.length > 0 && path.isAbsolute(value)),
  'Firefox crash-state proof requires an absolute APPDATA directory');
  const applicationData = resolveApplicationData();
  ensure(typeof applicationData === 'string' && applicationData.length > 0 && path.isAbsolute(applicationData),
    'Firefox crash-state proof could not resolve the Windows ApplicationData known folder');
  const canonical = path.resolve(applicationData);
  ensure(inheritedValues.every(value => path.resolve(value).toLowerCase() === canonical.toLowerCase()),
    'Firefox crash-state proof found an APPDATA/known-folder mismatch');
  const firefoxAppData = path.join(canonical, 'Mozilla', 'Firefox');
  return [
    {category: 'crashReports', root: path.join(firefoxAppData, 'Crash Reports')},
    {category: 'pendingPings', root: path.join(firefoxAppData, 'Pending Pings')}
  ];
};

const snapshotExternalFirefoxCrashStateUnsafe = (environment, platform, options) => {
  const bounds = {
    maxBytes: Math.min(EXTERNAL_CRASH_MAX_BYTES, options.maxBytes ?? EXTERNAL_CRASH_MAX_BYTES),
    maxDepth: Math.min(EXTERNAL_CRASH_MAX_DEPTH, options.maxDepth ?? EXTERNAL_CRASH_MAX_DEPTH),
    maxEntries: Math.min(EXTERNAL_CRASH_MAX_ENTRIES, options.maxEntries ?? EXTERNAL_CRASH_MAX_ENTRIES)
  };
  ensure(Object.values(bounds).every(value => Number.isSafeInteger(value) && value > 0),
    'Firefox external crash-state snapshot received an invalid safety bound');
  const files = new Map();
  let bytes = 0;
  let entriesSeen = 0;
  const stableMetadata = (left, right) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']
    .every(name => left[name] === right[name]);
  for (const {category, root} of externalFirefoxCrashRoots(environment, platform, options)) {
    options.beforeRoot?.(root);
    let rootMetadata;
    try {
      rootMetadata = fs.lstatSync(root, {bigint: true});
    }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    ensure(!rootMetadata.isSymbolicLink() && rootMetadata.isDirectory(),
      'Firefox external crash-state snapshot found an unsupported root');
    const visit = (directory, relative = '', depth = 0, directoryBefore =
      fs.lstatSync(directory, {bigint: true})) => {
      ensure(depth <= bounds.maxDepth,
        'Firefox external crash-state snapshot exceeded its fixed depth bound');
      ensure(!directoryBefore.isSymbolicLink() && directoryBefore.isDirectory(),
        'Firefox external crash-state snapshot found an unsupported directory');
      const directoryHandle = fs.opendirSync(directory);
      let directoryFailure;
      try {
        let entry;
        while ((entry = directoryHandle.readSync()) !== null) {
          entriesSeen += 1;
          ensure(entriesSeen <= bounds.maxEntries,
            'Firefox external crash-state snapshot exceeded its fixed entry bound');
          const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
          const absolute = path.join(directory, entry.name);
          const metadata = fs.lstatSync(absolute, {bigint: true});
          if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
            throw Error('Firefox external crash-state snapshot found a symbolic link');
          }
          if (entry.isDirectory() && metadata.isDirectory()) {
            ensure(depth < bounds.maxDepth,
              'Firefox external crash-state snapshot exceeded its fixed depth bound');
            visit(absolute, entryRelative, depth + 1, metadata);
          }
          else if (entry.isFile() && metadata.isFile()) {
            ensure(metadata.size >= 0n && metadata.size <= BigInt(bounds.maxBytes) &&
              BigInt(bytes) <= BigInt(bounds.maxBytes) - metadata.size,
            'Firefox external crash-state snapshot exceeded its fixed byte bound');
            options.beforeOpen?.(absolute);
            const descriptor = fs.openSync(absolute,
              fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            let descriptorFailure;
            try {
              const descriptorBefore = fs.fstatSync(descriptor, {bigint: true});
              ensure(descriptorBefore.isFile() && stableMetadata(metadata, descriptorBefore),
                'Firefox external crash-state snapshot observed a replaced file');
              const fileBytes = Number(descriptorBefore.size);
              const hash = createHash('sha256');
              const chunk = Buffer.allocUnsafe(Math.min(65536, Math.max(1, fileBytes)));
              let position = 0;
              let readCount = 0;
              while (position < fileBytes) {
                const read = fs.readSync(descriptor, chunk, 0,
                  Math.min(chunk.length, fileBytes - position), position);
                ensure(read > 0, 'Firefox external crash-state snapshot observed a shrinking file');
                hash.update(chunk.subarray(0, read));
                position += read;
                readCount += 1;
                options.afterReadChunk?.({absolute, descriptor, position, readCount});
              }
              const extra = fs.readSync(descriptor, chunk, 0, 1, position);
              const descriptorAfter = fs.fstatSync(descriptor, {bigint: true});
              const pathAfter = fs.lstatSync(absolute, {bigint: true});
              ensure(extra === 0 && position === fileBytes && descriptorAfter.isFile() &&
                pathAfter.isFile() && !pathAfter.isSymbolicLink() &&
                stableMetadata(descriptorBefore, descriptorAfter) && stableMetadata(metadata, pathAfter),
              'Firefox external crash-state snapshot observed an unstable file');
              bytes += fileBytes;
              files.set(`${category}\0${entryRelative}`, {
                bytes: fileBytes,
                category,
                identity: `${descriptorBefore.dev}:${descriptorBefore.ino}`,
                modified: `${descriptorBefore.mtimeNs}:${descriptorBefore.ctimeNs}`,
                sha256: hash.digest('hex')
              });
            }
            catch (error) {
              descriptorFailure = error;
              throw error;
            }
            finally {
              try {
                fs.closeSync(descriptor);
              }
              catch (error) {
                if (!descriptorFailure) throw error;
              }
            }
          }
          else {
            throw Error('Firefox external crash-state snapshot found an unsupported entry');
          }
        }
      }
      catch (error) {
        directoryFailure = error;
        throw error;
      }
      finally {
        try {
          directoryHandle.closeSync();
        }
        catch (error) {
          if (!directoryFailure && error?.code !== 'ERR_DIR_CLOSED') throw error;
        }
      }
      const directoryAfter = fs.lstatSync(directory, {bigint: true});
      ensure(directoryAfter.isDirectory() && !directoryAfter.isSymbolicLink() &&
        stableMetadata(directoryBefore, directoryAfter),
      'Firefox external crash-state snapshot observed an unstable directory');
    };
    visit(root, '', 0, rootMetadata);
  }
  return {bytes, entries: entriesSeen, files};
};

const snapshotExternalFirefoxCrashState = (
  environment = process.env,
  platform = process.platform,
  options = {}
) => {
  try {
    return snapshotExternalFirefoxCrashStateUnsafe(environment, platform, options);
  }
  catch (error) {
    if (/^Firefox (?:crash-state proof|external crash-state snapshot)/.test(error?.message || '')) throw error;
    throw Error('Firefox external crash-state snapshot I/O failed');
  }
};

const diffExternalFirefoxCrashState = (before, after) => {
  const summary = {
    categories: {
      crashReports: {changed: 0, created: 0, removed: 0},
      pendingPings: {changed: 0, created: 0, removed: 0}
    },
    allowedCrashHelperLog: {changed: 0, created: 0},
    allowedCrashReporterSettings: {changed: 0, created: 0},
    allowedInstallTime: {changed: 0, created: 0},
    changed: 0,
    created: 0,
    removed: 0
  };
  const keys = new Set([...before.files.keys(), ...after.files.keys()]);
  for (const key of keys) {
    const left = before.files.get(key);
    const right = after.files.get(key);
    const category = left?.category || right?.category;
    let kind;
    if (!left) kind = 'created';
    else if (!right) kind = 'removed';
    else if (left.bytes !== right.bytes || left.identity !== right.identity ||
      left.modified !== right.modified || left.sha256 !== right.sha256) kind = 'changed';
    if (kind) {
      const relative = key.slice(key.indexOf('\0') + 1);
      if (category === 'crashReports' && !relative.includes('/') && /^InstallTime/i.test(relative) &&
          (kind === 'created' || kind === 'changed')) {
        summary.allowedInstallTime[kind] += 1;
        continue;
      }
      if (category === 'crashReports' && !relative.includes('/') &&
          /^crashreporter_settings\.json$/i.test(relative) &&
          (kind === 'created' || kind === 'changed')) {
        summary.allowedCrashReporterSettings[kind] += 1;
        continue;
      }
      // Firefox ESR 140's crash helper opens this ordinary diagnostic log with
      // File::create on startup (toolkit/crashreporter/crash_helper_server/src/logging/env.rs).
      if (category === 'crashReports' && !relative.includes('/') &&
          /^crash_helper_server\.log$/i.test(relative) &&
          (kind === 'created' || kind === 'changed')) {
        summary.allowedCrashHelperLog[kind] += 1;
        continue;
      }
      summary[kind] += 1;
      summary.categories[category][kind] += 1;
    }
  }
  return summary;
};

const waitForChildExit = (child, timeout) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
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
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeout);
    child.once('exit', onExit);
  });
};

const killDetachedProcessGroup = child => {
  if (!child || !Number.isInteger(child.pid) || child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  ensure(process.platform !== 'win32', 'PID-only Firefox cleanup is forbidden on Windows');
  try {
    process.kill(-child.pid, 'SIGKILL');
    return true;
  }
  catch (error) {
    try {
      return child.kill('SIGKILL');
    }
    catch (ignored) {
      return false;
    }
  }
};

const launchFirefox = async ({allowSystemAccess, executable, headed, onBind, onSpawn, profile, protocolLog}) => {
  const args = [
    '--no-remote',
    '--new-instance',
    ...(process.platform === 'win32' ? ['--wait-for-browser'] : []),
    '--profile', profile,
    ...(allowSystemAccess ? ['--remote-allow-system-access'] : []),
    '--remote-debugging-port', '0',
    ...(headed ? [] : ['--headless']),
    'about:blank'
  ];
  const environment = {
    ...firefoxCrashEnvironment(profile),
    MOZ_HEADLESS: headed ? '0' : '1',
    MOZ_NO_REMOTE: '1'
  };
  const launched = process.platform === 'win32' ? launchProcessInExactJob({
    args,
    environment,
    executable,
    profile,
    profileSwitch: 'profile'
  }) : undefined;
  const child = launched?.child || spawn(executable, args, {
    detached: true,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  onSpawn?.(child);
  let buffer = '';
  let startupError;
  const listen = chunk => {
    buffer = (buffer + String(chunk)).slice(-65536);
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim() && !line.startsWith('ATD_JOB_CONTROL ')) {
        protocolLog.push(sanitizeText(line.trim()));
      }
    }
  };
  child.stdout.on('data', listen);
  child.stderr.on('data', listen);
  child.once('error', error => {
    startupError = error;
  });
  let processTree;
  try {
    if (process.platform === 'win32') {
      if (startupError) throw startupError;
      processTree = await bindExactProcessTree(launched);
      onBind?.(processTree);
    }
    const url = await waitFor(() => {
      if (startupError) {
        throw startupError;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw Error(`Firefox exited before WebDriver BiDi started (${child.exitCode ?? child.signalCode})`);
      }
      const match = buffer.match(/WebDriver BiDi listening on (ws:\/\/\S+)/);
      return match?.[1];
    }, 'Firefox did not publish its WebDriver BiDi endpoint', 20000, 50);
    const endpoint = new URL(url);
    return {
      child,
      debuggerOrigin: `http://${endpoint.hostname}:${endpoint.port}`,
      processTree,
      url: `${url.replace(/\/$/, '')}/session`
    };
  }
  catch (error) {
    let exited = false;
    if (process.platform === 'win32' && processTree) {
      const cleanup = await cleanupExactProcessTree(processTree, {
        nominalCloseSucceeded: false
      }).catch(() => ({exited: false, identityVerified: false}));
      exited = cleanup.exited === true && cleanup.identityVerified === true &&
        cleanup.jobEmptyVerified === true && cleanup.ownerExited === true;
    }
    else if (process.platform !== 'win32') {
      const killIssued = killDetachedProcessGroup(child);
      exited = await waitForChildExit(child, BIDI_CLEANUP_TIMEOUT);
      if (!exited) {
        error.message += `; Firefox process group did not exit after startup failure (kill issued: ${killIssued})`;
      }
    }
    if (process.platform === 'win32' && !exited) {
      error.message += processTree ?
        '; exact Firefox process-tree cleanup failed after startup failure' :
        '; Firefox startup failed before an exact process-tree identity could be bound; no PID-only kill was attempted';
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }
    throw error;
  }
};

const readExtensionUuid = (profile, extensionId) => {
  const prefsPath = path.join(profile, 'prefs.js');
  if (!fs.existsSync(prefsPath)) {
    return undefined;
  }
  const source = fs.readFileSync(prefsPath, 'utf8');
  const match = source.match(/user_pref\("extensions\.webextensions\.uuids",\s*("(?:\\.|[^"\\])*")\s*\);/);
  if (!match) {
    return undefined;
  }
  const mappings = JSON.parse(JSON.parse(match[1]));
  return mappings[extensionId];
};

const verifyMinimumRuntime = async ({browser, extensionId, pass, uuid}) => {
  const backgroundUrl = `moz-extension://${uuid}/firefox/background.html`;
  const controllerUrl = `moz-extension://${uuid}/data/popup/index.html`;
  const target = await putJson(`${browser.debuggerOrigin}/json/new?${encodeURI(controllerUrl)}`);
  ensure(target?.type === 'page' && typeof target.webSocketDebuggerUrl === 'string',
    'Firefox 140 did not open the installed extension controller as a CDP page target');
  const cdp = new BidiConnection(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Runtime.enable');
    const state = await waitFor(async () => {
      const value = await cdpEvaluateJson(cdp, `new Promise(async resolve => {
        const backgroundResult = await new Promise(done => {
          if (typeof chrome.runtime.getBackgroundPage !== 'function') {
            done({error: 'runtime.getBackgroundPage is unavailable'});
            return;
          }
          chrome.runtime.getBackgroundPage(background => done({
            background,
            error: chrome.runtime.lastError?.message || null
          }));
        });
        const background = backgroundResult.background;
        const runtimeMessage = await new Promise(done => chrome.runtime.sendMessage({
          method: 'storage',
          managed: {'__firefoxMinimumManaged': 'managed-default'},
          session: {'__firefoxMinimumSession': 'session-default'}
        }, response => done({
          error: chrome.runtime.lastError?.message || null,
          response
        })));
        const badge = await new Promise(done => chrome.action.getBadgeBackgroundColor({}, color => done({
          color,
          error: chrome.runtime.lastError?.message || null
        })));
        resolve(JSON.stringify({
          background: background ? {
            href: background.location.href,
            readyState: background.document.readyState,
            runtimeId: background.chrome.runtime.id,
            scripts: [...background.document.scripts].map(script => new URL(script.src).pathname)
          } : null,
          backgroundError: backgroundResult.error,
          badge,
          controllerHref: location.href,
          readyState: document.readyState,
          runtimeId: chrome.runtime.id,
          runtimeMessage
        }));
      })`);
      const response = value.runtimeMessage?.response;
      return value.readyState === 'complete' && value.runtimeId === extensionId &&
        value.controllerHref === controllerUrl && value.backgroundError === null &&
        value.background?.href === backgroundUrl && value.background?.readyState === 'complete' &&
        value.background?.runtimeId === extensionId &&
        JSON.stringify(value.background?.scripts) ===
          '["/firefox/compatibility.mjs","/worker/core.mjs"]' &&
        value.runtimeMessage?.error === null &&
        response?.__firefoxMinimumManaged === 'managed-default' &&
        response?.__firefoxMinimumSession === 'session-default' &&
        value.badge?.error === null && JSON.stringify(value.badge.color) === '[102,102,102,255]' ? value : undefined;
    }, 'Firefox 140 extension controller loaded, but the background/core runtime did not finish startup', 20000, 100);
    pass('Firefox 140 background page and core runtime started without privileged BiDi scope', {
      badgeColor: state.badge.color,
      backgroundPage: '/firefox/background.html',
      compatibilityFirst: true,
      runtimeMessageHandled: true
    });
  }
  finally {
    cdp.close();
  }
};

const safeProfile = (profileRoot, profile) => {
  const root = path.resolve(profileRoot);
  const candidate = path.resolve(profile);
  return candidate.startsWith(root + path.sep) &&
    path.basename(candidate).startsWith('firefox-bidi-smoke-');
};

// Keep this byte-for-byte tree identity algorithm aligned with
// scripts/archive-inventory.mjs: binary path ordering followed by the UTF-8
// relative path, NUL, file bytes, and NUL for every regular file. The report
// records only the resulting digest, never a local extension path.
const extensionTreeSha256 = root => {
  const entries = [];
  const visit = (directory, relative = '') => {
    const dirents = fs.readdirSync(directory, {withFileTypes: true})
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const dirent of dirents) {
      const entryPath = relative ? `${relative}/${dirent.name}` : dirent.name;
      const absolute = path.join(directory, dirent.name);
      if (dirent.isSymbolicLink()) {
        throw Error(`extension tree contains a symbolic link: ${entryPath}`);
      }
      if (dirent.isDirectory()) {
        visit(absolute, entryPath);
      }
      else if (dirent.isFile()) {
        entries.push({data: fs.readFileSync(absolute), path: entryPath});
      }
      else {
        throw Error(`extension tree contains an unsupported entry: ${entryPath}`);
      }
    }
  };
  visit(path.resolve(root));
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

const firefoxCrashLocations = profile => {
  const isolation = firefoxCrashIsolation(profile);
  return [
    {name: 'profile-minidumps', root: isolation.minidumps, type: 'dump-files'},
    {name: 'crash-events', root: isolation.events, type: 'any-file'}
  ];
};

const crashArtifacts = profile => {
  let count = 0;
  for (const location of firefoxCrashLocations(profile)) {
    if (!fs.existsSync(location.root)) {
      continue;
    }
    const visit = directory => {
      for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(full);
          continue;
        }
        const relative = path.relative(location.root, full).replaceAll(path.sep, '/');
        const dump = /\.(?:dmp|extra)$/i.test(entry.name);
        const pendingOrSubmitted = /^(?:pending|submitted)\//i.test(relative);
        const memoryReport = /(?:^|\/)memory-report\.json\.gz$/i.test(relative);
        if (location.type === 'any-file' || dump ||
            (location.type === 'report-files' && (pendingOrSubmitted || memoryReport))) {
          count += 1;
        }
      }
    };
    visit(location.root);
  }
  return count;
};

const run = async () => {
  const executableArg = option('executable', '');
  ensure(executableArg, 'Pass --executable with the Firefox executable');
  const executable = path.resolve(executableArg);
  const extension = path.resolve(option('extension', DEFAULT_EXTENSION));
  const minimumStartupOnly = flag('minimum-startup-only');
  const archiveArg = option('archive', '');
  const archive = archiveArg ? path.resolve(archiveArg) : '';
  const expectedVersion = option('expected-version', '');
  const profileRoot = path.resolve(option('profile-root', DEFAULT_PROFILE_ROOT));
  const resultsRoot = path.resolve(option('results-root', DEFAULT_RESULTS_ROOT));
  ensure(/^firefox(?:\.exe)?$/i.test(path.basename(executable)), 'This harness only accepts Firefox');
  ensure(fs.existsSync(executable), 'The Firefox executable does not exist');
  ensure(fs.existsSync(path.join(extension, 'manifest.json')), 'The local v3 extension does not exist');
  if (minimumStartupOnly) {
    ensure(process.platform === 'win32',
      'The Firefox minimum gate requires Windows PID-tree tracking and --wait-for-browser');
    ensure(archive && fs.existsSync(archive), 'The Firefox minimum gate requires --archive with the exact XPI');
    ensure(path.extname(archive).toLowerCase() === '.xpi', 'The Firefox minimum gate accepts only an XPI archive');
    ensure(/^\d+\.\d+$/.test(expectedVersion),
      'The Firefox minimum gate requires an exact two-part --expected-version');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
  const extensionId = manifest.browser_specific_settings?.gecko?.id;
  ensure(typeof extensionId === 'string' && extensionId.length > 0,
    'The extension manifest does not declare a Firefox Gecko ID');

  fs.mkdirSync(profileRoot, {recursive: true});
  fs.mkdirSync(resultsRoot, {recursive: true});
  const runId = `${Date.now()}-${process.pid}-${randomUUID()}`;
  const profile = path.join(profileRoot, `firefox-bidi-smoke-${runId}`);
  ensure(safeProfile(profileRoot, profile), 'The generated Firefox profile escaped the profile root');
  fs.mkdirSync(profile, {recursive: false});
  prepareFirefoxCrashIsolation(profile);
  fs.writeFileSync(path.join(profile, 'user.js'), minimumStartupOnly ?
    `${profilePrefs}user_pref("remote.active-protocols", 3);\n` : profilePrefs, 'utf8');

  const reportPath = path.join(resultsRoot, `firefox-bidi-smoke-${runId}.json`);
  const report = {
    assertions: [],
    browser: {},
    extension: {
      ...(minimumStartupOnly ? {
        archiveSha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
      } : {}),
      installDataType: minimumStartupOnly ? 'archivePath' : 'path',
      temporary: true,
      treeSha256: extensionTreeSha256(extension),
      version: manifest.version
    },
    finishedAt: undefined,
    fixture: {},
    outcome: 'failed',
    profile: {isolated: true, removed: false},
    protocol: {events: [], startup: []},
    schemaVersion: 1,
    startedAt: new Date().toISOString()
  };
  const pass = (name, details = {}) => report.assertions.push({details, name, passed: true});
  const fail = (name, error) => report.assertions.push({
    error: sanitizeText(error?.message || error),
    name,
    passed: false
  });

  let bidi;
  let browser;
  let externalCrashBefore;
  let extensionHandle;
  let fixture;
  let primaryError;
  let processExitVerified = false;
  let emergency = true;
  let protocolPhase = 'startup';

  const removeProfile = () => {
    ensure(safeProfile(profileRoot, profile), 'Refusing to delete a profile outside the isolated profile root');
    fs.rmSync(profile, {force: true, maxRetries: 6, recursive: true, retryDelay: 250});
    ensure(!fs.existsSync(profile), 'The isolated Firefox profile was not removed');
    report.profile.removed = true;
  };
  const emergencyCleanup = () => {
    if (!emergency) {
      return;
    }
    if (process.platform === 'win32') {
      forceCleanupExactProcessTreeSync(browser?.processTree);
    }
    else {
      killDetachedProcessGroup(browser?.child);
    }
  };
  process.once('exit', emergencyCleanup);
  process.once('SIGINT', () => {
    emergencyCleanup();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    emergencyCleanup();
    process.exit(143);
  });

  try {
    externalCrashBefore = snapshotExternalFirefoxCrashState();
    fixture = minimumStartupOnly ? undefined : await startFixture();
    browser = await launchFirefox({
      allowSystemAccess: !minimumStartupOnly,
      executable,
      headed: flag('headed'),
      onSpawn: child => {
        browser = {child};
      },
      onBind: processTree => {
        browser.processTree = processTree;
      },
      profile,
      protocolLog: report.protocol.startup
    });
    bidi = new BidiConnection(browser.url, event => {
      const url = event.params?.request?.url || event.params?.url;
      if (fixture && typeof url === 'string' && url.startsWith(fixture.origin)) {
        const fixtureName = Object.entries(fixture.urls).find(([, fixtureUrl]) => fixtureUrl === url)?.[0];
        report.protocol.events.push({
          fixture: fixtureName || (new URL(url).pathname === '/favicon.ico' ? 'favicon' : 'other-origin'),
          method: event.method,
          phase: protocolPhase,
          timestamp: event.params?.timestamp,
          type: fixtureName ? 'document' : 'subresource'
        });
      }
    });

    const session = await bidi.send('session.new', {
      capabilities: {alwaysMatch: {browserName: 'firefox'}}
    }, 15000);
    report.browser = {
      name: session.capabilities?.browserName,
      platform: session.capabilities?.platformName,
      version: session.capabilities?.browserVersion
    };
    ensure(report.browser.name === 'firefox', 'WebDriver BiDi did not create a Firefox session');
    if (minimumStartupOnly) {
      ensure(report.browser.version === expectedVersion,
        `Firefox minimum gate expected ${expectedVersion}; received ${report.browser.version || 'none'}`);
    }
    pass('real Firefox WebDriver BiDi session', report.browser);

    await bidi.send('session.subscribe', {
      events: [
        'browsingContext.navigationStarted',
        'network.beforeRequestSent'
      ]
    });
    const installed = await bidi.send('webExtension.install', {
      extensionData: minimumStartupOnly ? {path: archive, type: 'archivePath'} :
        {path: extension, type: 'path'},
      'moz:permanent': false
    });
    extensionHandle = installed.extension;
    ensure(typeof extensionHandle === 'string' && extensionHandle.length > 0,
      'Firefox did not return a temporary extension handle');
    report.extension.installed = true;
    report.extension.idMatchedManifest = extensionHandle === extensionId;
    ensure(report.extension.idMatchedManifest,
      'Firefox returned a temporary extension handle that did not match the manifest ID');
    pass(minimumStartupOnly ? 'temporary Firefox XPI install via webExtension.install' :
      'temporary local v3 install via webExtension.install', {
      idMatchedManifest: report.extension.idMatchedManifest,
      installDataType: report.extension.installDataType
    });

    const uuid = await waitFor(() => readExtensionUuid(profile, extensionId),
      'Firefox did not persist the temporary extension origin mapping', 15000, 100);
    if (minimumStartupOnly) {
      await verifyMinimumRuntime({browser, extensionId, pass, uuid});
    }
    else {
    const popupUrl = `moz-extension://${uuid}/data/popup/index.html`;
    // Firefox intentionally rejects a normal browsingContext.navigate call to
    // moz-extension://. Firefox 148+ exposes browser-chrome contexts through
    // the vendor-scoped getTree command when the explicitly isolated process
    // was launched with --remote-allow-system-access. Use that one privileged
    // operation only to open the installed extension's own popup URL.
    const chromeTree = await bidi.send('browsingContext.getTree', {'moz:scope': 'chrome'});
    const chromeContext = flattenContexts(chromeTree.contexts).find(context =>
      context.url === 'chrome://browser/content/browser.xhtml') || chromeTree.contexts?.[0];
    ensure(chromeContext?.context, 'Firefox did not expose an isolated browser-chrome context');
    const opened = await evaluate(bidi, chromeContext.context, `(() => {
      const tab = gBrowser.addTab(${JSON.stringify(popupUrl)}, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
      });
      gBrowser.selectedTab = tab;
      return Boolean(tab);
    })()`);
    ensure(opened === true, 'Firefox browser chrome did not open the extension controller');
    const controllerContext = await waitFor(async () => {
      const tree = await bidi.send('browsingContext.getTree');
      return flattenContexts(tree.contexts).find(context => context.url === popupUrl)?.context;
    }, 'The extension controller did not appear in the Firefox content tree', 15000);
    report.protocol.systemAccess = 'isolated-controller-open-only';
    pass('isolated Firefox chrome scope opened the installed extension controller');
    await waitFor(async () => evaluate(bidi, controllerContext,
      `document.readyState === 'complete' && Boolean(globalThis.chrome?.runtime?.id) &&
       Boolean(globalThis.chrome?.tabs)`),
    'The extension popup controller did not become ready', 15000);
    const controllerTab = await evaluateJSON(bidi, controllerContext, callbackExpression(`
      chrome.tabs.getCurrent(tab => resolve(JSON.stringify({
        error: ${runtimeErrorExpression},
        id: tab?.id
      })));
    `));
    ensure(!controllerTab.error && Number.isInteger(controllerTab.id),
      'The extension controller has no Firefox tab identity');
    pass('extension runtime is scriptable in its real popup origin');
    await installTabMonitor(bidi, controllerContext);

    protocolPhase = 'ordinary-load';
    const ordinaryCreated = await createTab(bidi, controllerContext, fixture.urls.ordinary);
    const ordinaryLoaded = await waitFor(async () => {
      const tab = await tabByUrl(bidi, controllerContext, fixture.urls.ordinary);
      return tab?.status === 'complete' && tab.discarded === false ? tab : false;
    }, 'The ordinary fixture tab did not finish loading', 20000);
    ensure(fixture.count('ordinary') === 1, 'The ordinary fixture did not make exactly one initial request');
    const ordinaryTitle = ordinaryLoaded.title;
    protocolPhase = 'ordinary-command';
    const ordinaryCommand = await runPopupCommand(bidi, controllerContext, 'discard-tab');
    ensure(ordinaryCommand?.ok === true,
      `discard-tab failed: ${ordinaryCommand?.error || 'no successful response'}`);
    const ordinaryDiscarded = await waitFor(async () => {
      const tab = await tabByUrl(bidi, controllerContext, fixture.urls.ordinary);
      return isAuthoritativeDiscard(tab) ? tab : false;
    }, 'Firefox did not expose the ordinary command as discarded/unloaded', 30000);
    ensure(ordinaryDiscarded.id === ordinaryCreated.id, 'The ordinary fixture changed tab identity');
    ensure(fixture.count('ordinary') === 1, 'The ordinary discard re-requested its document');
    const ordinarySettledAt = await monitorClock(bidi, controllerContext);
    pass('ordinary discard-tab settles to authoritative discarded/unloaded content state', {
      contentState: 'unloaded',
      discarded: ordinaryDiscarded.discarded,
      tabsApiStatus: ordinaryDiscarded.status
    });
    if (typeof ordinaryDiscarded.title === 'string' && ordinaryDiscarded.title.length) {
      ensure(ordinaryDiscarded.title.startsWith('💤 '),
        'Firefox exposed the discarded title without the configured sleep marker');
      report.extension.titleMarkerExposure = 'exposed';
      pass('Firefox-exposed title carries the sleep marker', {
        changed: ordinaryDiscarded.title !== ordinaryTitle,
        prefix: '💤'
      });
    }
    else {
      report.extension.titleMarkerExposure = 'not-exposed';
    }

    protocolPhase = 'scoped-load';
    const scopedCreated = await createTab(bidi, controllerContext, fixture.urls.scoped);
    await waitFor(async () => {
      const tab = await tabByUrl(bidi, controllerContext, fixture.urls.scoped);
      return tab?.status === 'complete' && tab.discarded === false ? tab : false;
    }, 'The scoped fixture tab did not finish loading', 20000);
    ensure(fixture.count('scoped') === 1, 'The scoped fixture did not make exactly one initial request');
    await activateTab(bidi, controllerContext, controllerTab.id);
    protocolPhase = 'scoped-command';
    const scopedCommand = await runPopupCommand(bidi, controllerContext, 'discard-window');
    ensure(scopedCommand?.ok === true,
      `discard-window failed: ${scopedCommand?.error || 'no successful response'}`);
    const scopedDiscarded = await waitFor(async () => {
      const tab = await tabByUrl(bidi, controllerContext, fixture.urls.scoped);
      return isAuthoritativeDiscard(tab) ? tab : false;
    }, 'The scoped popup message did not discard its inactive Firefox tab', 30000);
    ensure(scopedDiscarded.id === scopedCreated.id, 'The scoped fixture changed tab identity');
    ensure(fixture.count('scoped') === 1, 'The scoped discard re-requested its document');
    const scopedSettledAt = await monitorClock(bidi, controllerContext);
    pass('scoped discard-window runtime message reaches the real popup/worker path', {
      contentState: 'unloaded',
      discarded: scopedDiscarded.discarded,
      tabsApiStatus: scopedDiscarded.status
    });
    if (typeof scopedDiscarded.title === 'string' && scopedDiscarded.title.length) {
      ensure(scopedDiscarded.title.startsWith('💤 '),
        'Firefox exposed the scoped discarded title without the sleep marker');
    }

    const dwellBaseline = {
      ordinary: fixture.count('ordinary'),
      scoped: fixture.count('scoped')
    };
    protocolPhase = 'dwell';
    await sleep(DWELL_MS);
    const afterDwell = {
      ordinary: await tabByUrl(bidi, controllerContext, fixture.urls.ordinary),
      scoped: await tabByUrl(bidi, controllerContext, fixture.urls.scoped)
    };
    ensure(isAuthoritativeDiscard(afterDwell.ordinary),
      'The ordinary tab woke during the no-loop dwell');
    ensure(isAuthoritativeDiscard(afterDwell.scoped),
      'The scoped tab woke during the no-loop dwell');
    ensure(fixture.count('ordinary') === dwellBaseline.ordinary && fixture.count('scoped') === dwellBaseline.scoped,
      'A delayed document request loop occurred during the dwell');
    const tabMonitor = await readTabMonitor(bidi, controllerContext);
    const monitored = {
      ordinary: summarizePostSettlement(tabMonitor, ordinaryCreated.id, ordinarySettledAt),
      scoped: summarizePostSettlement(tabMonitor, scopedCreated.id, scopedSettledAt)
    };
    ensure(monitored.ordinary.unstableEvents === 0 && monitored.scoped.unstableEvents === 0,
      'A discarded fixture activated, entered loading, or became undiscarded after settlement');
    const fixtureNetworkEvents = report.protocol.events.filter(event =>
      event.method === 'network.beforeRequestSent' && event.type === 'document');
    ensure(fixtureNetworkEvents.filter(event => event.fixture === 'ordinary').length === 1,
      'BiDi observed more than one ordinary document request');
    ensure(fixtureNetworkEvents.filter(event => event.fixture === 'scoped').length === 1,
      'BiDi observed more than one scoped document request');
    const fixtureNavigationEvents = report.protocol.events.filter(event =>
      event.method === 'browsingContext.navigationStarted' && event.type === 'document');
    ensure(fixtureNavigationEvents.filter(event => event.fixture === 'ordinary').length === 1,
      'BiDi observed an extra ordinary navigation, including an aborted reload');
    ensure(fixtureNavigationEvents.filter(event => event.fixture === 'scoped').length === 1,
      'BiDi observed an extra scoped navigation, including an aborted reload');
    pass('no document reload/request loop during stable dwell', {
      dwellMs: DWELL_MS,
      navigations: {
        ordinary: 1,
        scoped: 1
      },
      requests: dwellBaseline
    });
    pass('no post-settlement loading, activation, or undiscard transition', {
      ordinary: monitored.ordinary.unstableEvents,
      scoped: monitored.scoped.unstableEvents
    });

    const requestEvents = fixture.events();
    const firstRequest = Math.min(requestEvents.ordinary[0].at, requestEvents.scoped[0].at);
    report.fixture = {
      commands: {
        ordinary: {
          ok: ordinaryCommand.ok === true,
          value: ordinaryCommand.value === true
        },
        scoped: {
          ok: scopedCommand.ok === true,
          value: scopedCommand.value === true
        }
      },
      monitor: monitored,
      requests: {
        ordinary: requestEvents.ordinary.map(event => ({atMs: event.at - firstRequest, method: event.method})),
        scoped: requestEvents.scoped.map(event => ({atMs: event.at - firstRequest, method: event.method}))
      },
      states: {
        ordinary: {
          contentState: 'unloaded',
          discarded: afterDwell.ordinary.discarded,
          tabsApiStatus: afterDwell.ordinary.status,
          titleMarked: afterDwell.ordinary.title?.startsWith('💤 ') === true
        },
        scoped: {
          contentState: 'unloaded',
          discarded: afterDwell.scoped.discarded,
          tabsApiStatus: afterDwell.scoped.status,
          titleMarked: afterDwell.scoped.title?.startsWith('💤 ') === true
        }
      }
    };
    protocolPhase = 'cleanup';
    await removeTabs(bidi, controllerContext, [ordinaryCreated.id, scopedCreated.id]);
    await sleep(100);
    ensure(fixture.count('ordinary') === 1 && fixture.count('scoped') === 1,
      'Closing the discarded fixture tabs unexpectedly re-requested a document');
    }
    report.outcome = 'passed';
  }
  catch (error) {
    primaryError = error;
    fail('Firefox BiDi smoke', error);
  }
  finally {
    protocolPhase = 'cleanup';
    if (extensionHandle && bidi && !bidi.closed) {
      await bidi.send('webExtension.uninstall', {extension: extensionHandle}, BIDI_CLEANUP_TIMEOUT).catch(error => {
        primaryError ||= error;
      });
    }
    let browserCloseRequested = false;
    if (browser?.processTree) {
      try {
        browser.processTree = refreshExactProcessTree(browser.processTree);
      }
      catch (error) {
        primaryError ||= error;
        fail('refresh exact Firefox process-tree binding', error);
      }
    }
    if (bidi && !bidi.closed) {
      browserCloseRequested = true;
      await bidi.send('browser.close', {}, BIDI_CLEANUP_TIMEOUT).catch(() => {});
    }
    try {
      if (process.platform === 'win32') {
        ensure(browser?.processTree, 'Firefox exact process-tree binding was unavailable during cleanup');
        const cleanup = await cleanupExactProcessTree(browser.processTree, {
          nominalCloseSucceeded: browserCloseRequested
        });
        report.profile.processTreeCleanup = cleanup;
        ensure(cleanup.exited === true && cleanup.identityVerified === true && cleanup.jobEmptyVerified === true &&
          cleanup.ownerExited === true,
          'The previously bound exact Firefox process tree did not exit');
        processExitVerified = true;
        report.profile.processExit = cleanup.forced.needed ? 'forced-exact-tree' : 'graceful-exact-tree';
      }
      else {
        let exited = await waitForChildExit(browser?.child, 10000);
        let exitMethod = 'graceful-process-group';
        if (!exited) {
          exitMethod = 'forced-process-group';
          const killIssued = killDetachedProcessGroup(browser?.child);
          exited = await waitForChildExit(browser?.child, BIDI_CLEANUP_TIMEOUT);
          ensure(exited, `The Firefox process group did not exit after forced cleanup (kill issued: ${killIssued})`);
        }
        ensure(exited, 'The Firefox process group did not exit');
        processExitVerified = true;
        report.profile.processExit = exitMethod;
      }
    }
    catch (error) {
      if (process.platform === 'win32') {
        forceCleanupExactProcessTreeSync(browser?.processTree);
      }
      else {
        killDetachedProcessGroup(browser?.child);
        await waitForChildExit(browser?.child, BIDI_CLEANUP_TIMEOUT);
      }
      primaryError ||= error;
      fail('exact Firefox process-tree exit', error);
    }
    bidi?.close();
    await fixture?.stop().catch(() => {});
    try {
      ensure(!browser?.child || processExitVerified,
        'Firefox crash/profile cleanup was skipped because kernel Job exit was not verified');
      ensure(externalCrashBefore, 'Firefox external crash state was not captured before launch');
      const artifacts = crashArtifacts(profile);
      report.profile.crashArtifacts = artifacts;
      report.profile.crashLocationsChecked = firefoxCrashLocations(profile).map(location => location.name);
      const externalCrashAfter = snapshotExternalFirefoxCrashState();
      const externalCrashChanges = diffExternalFirefoxCrashState(externalCrashBefore, externalCrashAfter);
      report.profile.externalCrashState = externalCrashChanges;
      ensure(externalCrashChanges.changed === 0 && externalCrashChanges.created === 0 &&
        externalCrashChanges.removed === 0,
      'Firefox changed external crash-report or pending-ping state during the smoke run');
      ensure(artifacts === 0, 'Firefox produced a crash artifact during the smoke run');
      await waitFor(() => {
        try {
          removeProfile();
          return true;
        }
        catch (error) {
          return false;
        }
      }, 'The isolated Firefox profile remained locked after browser exit', 10000, 250);
      pass('exact launched Firefox tree exited and isolated profile was deleted');
    }
    catch (error) {
      primaryError ||= error;
      fail('isolated Firefox cleanup', error);
    }
    emergency = false;
    process.removeListener('exit', emergencyCleanup);
    report.finishedAt = new Date().toISOString();
    if (primaryError) {
      report.outcome = 'failed';
      report.error = sanitizeText(primaryError.message || primaryError);
    }
    fs.writeFileSync(reportPath, JSON.stringify(sanitize(report), null, 2) + '\n', 'utf8');
  }

  if (primaryError) {
    primaryError.reportPath = reportPath;
    throw primaryError;
  }
  return reportPath;
};

if (require.main === module) {
  run().then(reportPath => {
    console.log(`Firefox BiDi smoke passed; sanitized report: ${reportPath}`);
  }, error => {
    console.error(`Firefox BiDi smoke failed: ${sanitizeText(error)}`);
    if (error.reportPath) {
      console.error(`Sanitized report: ${error.reportPath}`);
    }
    process.exitCode = 1;
  });
}

module.exports = {
  crashArtifacts,
  diffExternalFirefoxCrashState,
  externalFirefoxCrashRoots,
  extensionTreeSha256,
  firefoxCrashEnvironment,
  firefoxCrashIsolation,
  firefoxCrashLocations,
  flattenContexts,
  safeProfile,
  sanitize,
  sanitizeText,
  snapshotExternalFirefoxCrashState
};
