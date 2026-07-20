#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {randomUUID} = require('node:crypto');

const SCRIPT_DIR = __dirname;
const DEFAULT_EXTENSION = path.join(SCRIPT_DIR, '..', 'v3');
const DEFAULT_PROFILE_ROOT = path.join(SCRIPT_DIR, '.profiles');
const DWELL_MS = 3000;

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

const safeMessage = error => String(error?.message || error || 'unknown failure')
  .replace(/[A-Z]:[\\/]Users[\\/][^\\/]+/gi, '<user-path>')
  .replace(/(?:chrome|edge)-extension:\/\/[a-p]{32}/gi, 'extension://<redacted>')
  .replace(/https?:\/\/[^\s)]+/gi, '<fixture-url>');

class CdpConnection {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
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

  close() {
    if (!this.closed) {
      this.socket.close();
    }
  }
}

const evaluate = async (cdp, sessionId, expression, timeout = 15000) => {
  const response = await withTimeout(cdp.send('Runtime.evaluate', {
    awaitPromise: true,
    expression,
    returnByValue: true,
    userGesture: true
  }, sessionId), timeout, 'CDP evaluation timed out');
  if (response.exceptionDetails) {
    throw Error('CDP evaluation failed');
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
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const current = new URL(request.url, 'http://127.0.0.1');
    if (current.pathname !== pathname) {
      response.writeHead(404, {'Content-Type': 'text/plain'});
      response.end('not found');
      return;
    }
    requests.push({at: Date.now()});
    response.writeHead(200, {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Content-Type': 'text/html; charset=utf-8',
      'Expires': '0',
      'Pragma': 'no-cache'
    });
    response.end(`<!doctype html>
      <meta charset="utf-8">
      <title>Edge frozen smoke ${token}</title>
      <h1>Frozen tab fixture</h1>
      <script>
        globalThis.fixtureMemory = new Uint8Array(8 * 1024 * 1024);
        setInterval(() => globalThis.fixtureHeartbeat = Date.now(), 250);
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
  return {
    count: () => requests.length,
    stop: () => new Promise(resolve => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close(resolve);
    }),
    url: `http://127.0.0.1:${address.port}${pathname}`
  };
};

const waitForChildExit = (child, timeout) => {
  if (!child || child.exitCode !== null) {
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

const killProcessTree = child => {
  if (!child || !Number.isInteger(child.pid) || child.exitCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
  }
  else {
    try {
      child.kill('SIGKILL');
    }
    catch (error) {}
  }
};

const terminateBrowser = async (child, cdp) => {
  if (cdp && !cdp.closed) {
    await withTimeout(cdp.send('Browser.close'), 3000, 'Browser.close timed out').catch(() => {});
  }
  if (!await waitForChildExit(child, 5000)) {
    killProcessTree(child);
    await waitForChildExit(child, 5000);
  }
  cdp?.close();
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
      await terminateBrowser(child, cdp);
    }
    catch (cleanupFailure) {
      killProcessTree(child);
      await waitForChildExit(child, 5000);
      cdp?.close();
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
  const stored = await chrome.storage.session.get('__discardOwnership');
  const ownership = stored.__discardOwnership || {};
  const marker = ownership[tab.id];
  const ownershipKeys = Object.keys(ownership);
  return {
    active: tab.active === true,
    discarded: tab.discarded === true,
    found: true,
    frozen: tab.frozen === true,
    id: tab.id,
    markerState: marker && marker.state,
    ownershipOnlyCurrent: ownershipKeys.length === 1 && ownershipKeys[0] === String(tab.id),
    source: marker && marker.source,
    status: tab.status,
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
  return true;
})()`;

const monitorCheckpointExpression = `(() => ({
  activations: globalThis.__edgeFrozenSmoke.activations.length,
  events: globalThis.__edgeFrozenSmoke.events.length,
  replacements: globalThis.__edgeFrozenSmoke.replacements.length
}))()`;

const monitorSummaryExpression = (
  startId,
  eventCheckpoint,
  activationCheckpoint,
  driverId
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
    const signal = event.change.status === 'loading' || event.change.discarded === false ||
      event.change.frozen === false;
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
  return {
    awakeEpisodes,
    driverReactivations,
    eventCount: events.length,
    loadingSignals,
    targetActivations: targetActivationIndexes.length
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

const run = async () => {
  ensure(process.argv.includes('--allow-edge'), 'Pass --allow-edge to authorize the isolated Edge smoke run');
  const executable = path.resolve(option('executable', ''));
  const extension = path.resolve(option('extension', DEFAULT_EXTENSION));
  const profileRoot = path.resolve(option('profile-root', DEFAULT_PROFILE_ROOT));
  ensure(option('executable'), 'Pass --executable with the Microsoft Edge executable');
  ensure(path.basename(executable).toLowerCase() === 'msedge.exe', 'This harness only accepts Microsoft Edge');
  ensure(fs.existsSync(executable), 'The Edge executable does not exist');
  ensure(fs.existsSync(path.join(extension, 'manifest.json')), 'The unpacked extension does not exist');
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
  const workerPath = `/${String(manifest.background?.service_worker || '').replace(/^\/+/, '')}`;
  ensure(workerPath !== '/', 'The extension manifest has no service worker');

  fs.mkdirSync(profileRoot, {recursive: true});
  const profile = path.join(profileRoot, `edge-frozen-smoke-${Date.now()}-${process.pid}`);
  fs.mkdirSync(profile, {recursive: true});
  let fixture;
  let browser;
  let cleanupError;

  const emergencyCleanup = () => {
    killProcessTree(browser?.child);
    try {
      fs.rmSync(profile, {force: true, recursive: true});
    }
    catch (error) {}
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

    const {targetId: fixtureTargetId} = await cdp.send('Target.createTarget', {url: fixture.url});
    const {targetId: discardsTargetId} = await cdp.send('Target.createTarget', {url: 'edge://discards/'});
    ensure(fixtureTargetId && discardsTargetId && extensionTarget.targetId,
      'Edge did not create the smoke-test tabs');

    const discardsSession = await attachPage(cdp, discardsTargetId);
    // Attach directly to the already-running MV3 worker. Creating or navigating
    // an extension page through raw Edge CDP is racy and can silently retain a
    // normal New Tab origin; the worker is the authoritative extension context
    // and exposes the same runtime, storage, and tabs APIs without touching the
    // fixture renderer.
    const extensionSession = await attachPage(cdp, extensionTarget.targetId);
    await waitFor(() => evaluate(cdp, discardsSession, 'document.readyState === "complete"'),
      'edge://discards did not become ready', 15000);
    let extensionProbe;
    try {
      await waitFor(async () => {
        extensionProbe = await evaluate(cdp, extensionSession, `(() => ({
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

    await evaluate(cdp, extensionSession, `(async () => {
      await chrome.storage.local.set({
        favicon: false,
        number: 1000000,
        period: 86400,
        prepends: '💤'
      });
      return true;
    })()`);
    await evaluate(cdp, extensionSession, monitorInstallExpression);

    // Ask the extension itself to create the command driver. Unlike a raw
    // Target.createTarget navigation, this guarantees that Edge commits the
    // page in this extension's origin. Attaching this dedicated driver cannot
    // make the fixture unfreezable because its target remains untouched.
    const driverUrl = await evaluate(cdp, extensionSession, `(async () => {
      const url = chrome.runtime.getURL('data/options/index.html');
      await chrome.tabs.create({active: true, url});
      return url;
    })()`);
    const driverTarget = await waitFor(async () => {
      const {targetInfos = []} = await cdp.send('Target.getTargets');
      return targetInfos.find(info => info.type === 'page' && info.url === driverUrl) || false;
    }, 'The extension command driver did not appear', 15000);
    const driverSession = await attachPage(cdp, driverTarget.targetId);
    await waitFor(async () => evaluate(cdp, driverSession, `document.readyState === 'complete' &&
      Boolean(globalThis.chrome?.runtime?.id) && Boolean(globalThis.chrome?.tabs)`),
    'The extension command driver did not become ready', 15000);
    const driverId = await evaluate(cdp, driverSession, `new Promise(resolve => {
      chrome.tabs.getCurrent(tab => resolve(tab?.id));
    })`);
    ensure(Number.isInteger(driverId), 'The extension command driver has no tab identity');

    const initial = await waitFor(async () => {
      const snapshot = await evaluate(cdp, extensionSession, extensionSnapshotExpression(fixture.url));
      return snapshot?.found && snapshot.active === false && snapshot.discarded === false &&
        snapshot.frozen === false && snapshot.status === 'complete' ? snapshot : false;
    }, 'The fixture tab did not finish loading in the background', 20000);
    ensure(fixture.count() === 1, 'The fixture made an unexpected number of initial document requests');

    await waitFor(() => evaluate(cdp, discardsSession, freezeClickExpression(fixture.url)),
      'The Freeze control for the fixture was not found on edge://discards', 15000, 250);
    const frozen = await waitFor(async () => {
      const snapshot = await evaluate(cdp, extensionSession, extensionSnapshotExpression(fixture.url));
      return snapshot?.found && snapshot.discarded === false && snapshot.frozen === true ? snapshot : false;
    }, 'Edge did not expose the fixture as frozen', 15000);
    ensure(frozen.id === initial.id, 'The fixture identity changed before the discard command');

    const baselineRequests = fixture.count();
    const commandCheckpoint = await evaluate(cdp, extensionSession, monitorCheckpointExpression);
    const command = await evaluate(cdp, driverSession, `new Promise(resolve => {
      chrome.runtime.sendMessage({
        method: 'popup',
        cmd: 'discard-window',
        shiftKey: false
      }, response => {
        const runtimeError = chrome.runtime.lastError;
        const failed = Boolean(runtimeError) || response?.ok !== true;
        resolve({
          ok: failed === false,
          reason: runtimeError?.message || response?.error || 'unknown command failure'
        });
      });
    })`, 45000);
    ensure(command?.ok === true, `The normal popup discard command failed: ${command?.reason || 'no response'}`);

    const final = await waitFor(async () => {
      const snapshot = await evaluate(cdp, extensionSession, extensionSnapshotExpression(fixture.url));
      return snapshot?.found && snapshot.discarded === true && snapshot.status === 'unloaded' &&
        snapshot.source === 'self' && snapshot.markerState === 'owned' &&
        snapshot.ownershipOnlyCurrent === true && snapshot.titleMarked === true ?
        snapshot : false;
    }, 'The frozen tab did not settle as a marked self-owned discard', 30000);
    ensure(fixture.count() === baselineRequests,
      'The frozen takeover unexpectedly reloaded its still-memory-resident document');

    const commandSummary = await evaluate(cdp, extensionSession,
      monitorSummaryExpression(
        initial.id,
        commandCheckpoint.events,
        commandCheckpoint.activations,
        driverId
      ));
    ensure(commandSummary.awakeEpisodes === 1, 'The frozen takeover did not have exactly one awake episode');
    ensure(commandSummary.loadingSignals === 0,
      'The activation-only frozen takeover unexpectedly entered a loading transition');
    ensure(commandSummary.targetActivations === 1,
      'The frozen takeover did not activate the target lineage exactly once');
    ensure(commandSummary.driverReactivations === 1,
      'The frozen takeover did not reactivate the command driver exactly once');

    const dwellCheckpoint = await evaluate(cdp, extensionSession, monitorCheckpointExpression);
    const dwellRequests = fixture.count();
    await sleep(DWELL_MS);
    const afterDwell = await evaluate(cdp, extensionSession, extensionSnapshotExpression(fixture.url));
    ensure(afterDwell?.found && afterDwell.discarded === true && afterDwell.status === 'unloaded' &&
      afterDwell.source === 'self' && afterDwell.markerState === 'owned' &&
      afterDwell.ownershipOnlyCurrent === true && afterDwell.titleMarked === true,
    'The tab did not remain a marked self-owned discard during the dwell');
    ensure(afterDwell.id === final.id, 'The tab changed identity after the discard settled');
    ensure(fixture.count() === dwellRequests, 'A delayed fixture reload occurred during the dwell');
    const dwellSummary = await evaluate(cdp, extensionSession,
      monitorSummaryExpression(
        initial.id,
        dwellCheckpoint.events,
        dwellCheckpoint.activations,
        driverId
      ));
    ensure(dwellSummary.awakeEpisodes === 0 && dwellSummary.loadingSignals === 0,
      'A delayed wake or loading spinner occurred during the dwell');
    ensure(dwellSummary.targetActivations === 0 && dwellSummary.driverReactivations === 0,
      'A delayed target or driver activation occurred during the dwell');
  }
  finally {
    await fixture?.stop().catch(() => {});
    await terminateBrowser(browser?.child, browser?.cdp).catch(() => {});
    try {
      ensure(findCrashCount(profile) === 0, 'Edge produced a crash dump during the smoke run');
    }
    catch (error) {
      cleanupError = error;
    }
    try {
      fs.rmSync(profile, {force: true, maxRetries: 4, recursive: true, retryDelay: 250});
      ensure(!fs.existsSync(profile), 'The isolated Edge profile was not removed');
    }
    catch (error) {
      cleanupError ||= Error('The isolated Edge profile could not be removed');
    }
    browser = undefined;
    process.removeListener('exit', emergencyCleanup);
  }
  if (cleanupError) {
    throw cleanupError;
  }
};

run().then(() => {
  console.log('Edge frozen smoke passed: one activation wake, zero reloads, marked self-discard, stable dwell, zero crashes, profile removed.');
}, error => {
  console.error(`Edge frozen smoke failed: ${safeMessage(error)}`);
  process.exitCode = 1;
});
