const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {chromium} = require('./playwright-runtime.cjs');

let emergencyBrowserProcess;

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (task, description, timeout = 15000, interval = 50) => {
  const deadline = Date.now() + timeout;
  let value;
  let error;
  while (Date.now() < deadline) {
    try {
      value = await task();
      error = undefined;
      if (value) {
        return value;
      }
    }
    catch (cause) {
      error = cause;
    }
    await sleep(interval);
  }
  throw Error(`timed out waiting for ${description}; last value: ${JSON.stringify(value)}${
    error ? `; last error: ${error.message}` : ''}`);
};

const taskkillPath = process.platform === 'win32' ?
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe') : undefined;
const killProcessTreeSync = child => {
  if (!child || child.exitCode !== null || !Number.isInteger(child.pid)) {
    return {needed: false};
  }
  if (process.platform === 'win32' && fs.existsSync(taskkillPath)) {
    const outcome = spawnSync(taskkillPath, ['/PID', String(child.pid), '/T', '/F'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true
    });
    return {
      needed: true,
      status: outcome.status,
      stderr: outcome.stderr?.trim(),
      stdout: outcome.stdout?.trim()
    };
  }
  return {needed: true, signal: child.kill('SIGKILL')};
};
const waitForProcessExit = (child, timeout = 5000) => {
  if (!child || child.exitCode !== null) {
    return Promise.resolve(true);
  }
  return Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    sleep(timeout).then(() => false)
  ]);
};
const terminateBrowserProcess = async child => {
  const graceful = await waitForProcessExit(child, 5000);
  const forced = graceful ? {needed: false} : killProcessTreeSync(child);
  const exited = graceful || await waitForProcessExit(child, 5000);
  if (emergencyBrowserProcess === child) {
    emergencyBrowserProcess = undefined;
  }
  return {exited, forced, graceful};
};
const settleWithin = async (operation, timeout = 5000) => {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(operation).then(value => ({status: 'fulfilled', value}), error => ({
        error: error?.message || String(error),
        status: 'rejected'
      })),
      new Promise(resolve => timer = setTimeout(() => resolve({status: 'timeout'}), timeout))
    ]);
  }
  finally {
    clearTimeout(timer);
  }
};

const emergencyCleanup = () => {
  if (emergencyBrowserProcess?.exitCode === null) {
    killProcessTreeSync(emergencyBrowserProcess);
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

const PRIMARY_BACKGROUND = [
  'p-left-far',
  'p-left-near',
  'p-right-near',
  'p-right-mid',
  'p-right-far'
];
const OTHER_BACKGROUND = ['a-bg-1', 'a-bg-2', 'b-bg-1', 'b-bg-2'];
const ALL_BACKGROUND = [...PRIMARY_BACKGROUND, ...OTHER_BACKGROUND];
const SETUP_EXTERNAL = new Set(['p-left-near', 'p-right-mid', 'a-bg-2', 'b-bg-2']);
const DISCARD_SPECS = {
  'discard-window': PRIMARY_BACKGROUND,
  'discard-rights': ['p-right-near', 'p-right-mid', 'p-right-far'],
  'discard-lefts': ['p-left-far', 'p-left-near'],
  'discard-other-windows': OTHER_BACKGROUND,
  'discard-tabs': ALL_BACKGROUND
};
const RELEASE_SPECS = {
  'release-window': PRIMARY_BACKGROUND,
  'release-rights': ['p-right-near', 'p-right-mid', 'p-right-far'],
  'release-lefts': ['p-left-far', 'p-left-near'],
  'release-other-windows': OTHER_BACKGROUND,
  'release-tabs': ALL_BACKGROUND
};
const RELEASE_AVAILABILITY_AFTER = {
  'release-window': {
    'release-window': false,
    'release-lefts': false,
    'release-rights': false,
    'release-other-windows': true,
    'release-tabs': true
  },
  'release-rights': {
    'release-window': true,
    'release-lefts': true,
    'release-rights': false,
    'release-other-windows': true,
    'release-tabs': true
  },
  'release-lefts': {
    'release-window': true,
    'release-lefts': false,
    'release-rights': true,
    'release-other-windows': true,
    'release-tabs': true
  },
  'release-other-windows': {
    'release-window': true,
    'release-lefts': true,
    'release-rights': true,
    'release-other-windows': false,
    'release-tabs': true
  },
  'release-tabs': {
    'release-window': false,
    'release-lefts': false,
    'release-rights': false,
    'release-other-windows': false,
    'release-tabs': false
  }
};
const POPUP_COMMANDS = [
  'discard-tab',
  'discard-tree',
  ...Object.keys(DISCARD_SPECS),
  ...Object.keys(RELEASE_SPECS)
];

const startFixtureServer = async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname !== '/tab') {
      response.writeHead(404, {'Content-Type': 'text/plain'});
      response.end('not found');
      return;
    }

    const id = url.searchParams.get('id') || 'unknown';
    const mb = Number(url.searchParams.get('mb') || 0);
    const ordinal = requests.filter(entry => entry.id === id).length + 1;
    const holdReload = Number(url.searchParams.get('holdReload') || 0);
    const entry = {
      aborted: false,
      at: Date.now(),
      closedAt: undefined,
      finishedAt: undefined,
      heldUntil: undefined,
      id,
      ordinal,
      path: request.url,
      writableFinished: false
    };
    requests.push(entry);
    let finishTimer;
    request.on('aborted', () => entry.aborted = true);
    response.on('finish', () => {
      entry.finishedAt = Date.now();
      entry.writableFinished = response.writableFinished;
    });
    response.on('close', () => {
      if (finishTimer) {
        clearTimeout(finishTimer);
        finishTimer = undefined;
      }
      entry.closedAt = Date.now();
      entry.writableFinished = response.writableFinished;
    });
    response.writeHead(200, {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Content-Type': 'text/html; charset=utf-8',
      'Pragma': 'no-cache'
    });
    response.write(`<!doctype html>
<meta charset="utf-8">
<title>ATD E2E ${id}</title>
<body data-id="${id}">ATD E2E ${id}</body>
<script>
  const key = 'atd-e2e-loads-${id}';
  const loads = Number(localStorage.getItem(key) || 0) + 1;
  localStorage.setItem(key, String(loads));
  document.title = 'ATD E2E ${id} loads=' + loads;
  const memory = new Uint8Array(${mb} * 1024 * 1024);
  for (let i = 0; i < memory.length; i += 4096) memory[i] = (i / 4096) % 251;
  globalThis.__atdE2EMemory = memory;
  globalThis.__atdE2ELoads = loads;
</script>`);
    const finish = () => {
      if (!response.destroyed && !response.writableEnded) {
        response.end('\n<!-- complete -->');
      }
    };
    if (ordinal > 1 && holdReload > 0) {
      entry.heldUntil = Date.now() + holdReload;
      finishTimer = setTimeout(() => {
        finishTimer = undefined;
        finish();
      }, holdReload);
      finishTimer.unref?.();
    }
    else {
      finish();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const {port} = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    count(id) {
      return requests.filter(entry => entry.id === id).length;
    },
    entries(id) {
      return requests.filter(entry => entry.id === id);
    },
    requests,
    stop: () => new Promise(resolve => {
      server.closeAllConnections?.();
      server.close(resolve);
    })
  };
};

const launchOverCDP = async ({executablePath, extensionPath, profile}) => {
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-component-update',
    '--disable-background-mode',
    '--disable-features=OptimizationHints,MediaRouter',
    '--window-position=20,20',
    'about:blank'
  ];
  const browserProcess = spawn(executablePath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: false
  });
  emergencyBrowserProcess = browserProcess;
  let stderr = '';
  let spawnError;
  browserProcess.once('error', error => spawnError = error);
  browserProcess.stderr.on('data', chunk => {
    stderr = (stderr + chunk.toString()).slice(-256 * 1024);
  });
  const portFile = path.join(profile, 'DevToolsActivePort');
  try {
    const port = await waitFor(() => {
      if (spawnError) {
        throw spawnError;
      }
      if (browserProcess.exitCode !== null) {
        throw Error(`browser exited before CDP was ready (${browserProcess.exitCode}): ${stderr}`);
      }
      if (!fs.existsSync(portFile)) {
        return false;
      }
      const [value] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
      return Number(value) || false;
    }, 'browser DevTools port', 15000);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (!context) {
      throw Error('CDP browser did not expose its default context');
    }
    return {browser, browserProcess, context, stderr: () => stderr};
  }
  catch (error) {
    await terminateBrowserProcess(browserProcess);
    throw error;
  }
};

const findCrashDumps = root => {
  const found = [];
  const visit = directory => {
    if (!fs.existsSync(directory)) {
      return;
    }
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target);
      }
      else if (entry.name.toLowerCase().endsWith('.dmp')) {
        const stat = fs.statSync(target);
        found.push({path: target, size: stat.size, updatedAt: stat.mtimeMs});
      }
    }
  };
  visit(root);
  return found;
};

const hashDirectory = root => {
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target);
      }
      else if (entry.isFile()) {
        files.push(target);
      }
    }
  };
  visit(root);
  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) {
    hash.update(path.relative(root, file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
};

const sampleMemory = async cdp => {
  let processInfo;
  try {
    ({processInfo = []} = await cdp.send('SystemInfo.getProcessInfo'));
  }
  catch (error) {
    return {available: false, error: `CDP process query failed: ${error.message}`};
  }
  const pids = processInfo.map(info => Number(info.id)).filter(Number.isInteger);
  if (process.platform !== 'win32') {
    return {available: false, error: 'OS memory sampling is implemented for Windows only', processInfo};
  }
  if (pids.length === 0) {
    return {available: false, error: 'CDP returned no browser process IDs', processInfo};
  }
  // A renderer can exit between the CDP snapshot and the OS query. Filtering a
  // full process snapshot avoids Get-Process -Id treating that normal race as
  // a failed sample.
  const command = `$ids=@(${pids.join(',')}); Get-Process | Where-Object { $ids -contains $_.Id } | ` +
    'Select-Object Id,ProcessName,WorkingSet64,PrivateMemorySize64,CPU | ConvertTo-Json -Compress';
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!fs.existsSync(powershell)) {
    return {available: false, error: `PowerShell not found: ${powershell}`, processInfo};
  }
  const outcome = spawnSync(powershell, ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true
  });
  if (outcome.error || outcome.status !== 0) {
    return {
      available: false,
      error: outcome.error?.message || outcome.stderr?.trim() || `PowerShell exited ${outcome.status}`,
      processInfo
    };
  }
  let processes = [];
  try {
    const parsed = outcome.stdout.trim() ? JSON.parse(outcome.stdout) : [];
    processes = Array.isArray(parsed) ? parsed : [parsed];
  }
  catch (error) {
    return {available: false, error: `Cannot parse PowerShell memory sample: ${error.message}`, processInfo};
  }
  if (processes.length === 0) {
    return {available: false, error: 'No CDP browser processes remained in the OS snapshot', processInfo};
  }
  return {
    available: true,
    privateBytes: processes.reduce((sum, process) => sum + Number(process.PrivateMemorySize64 || 0), 0),
    processInfo,
    processes,
    workingSetBytes: processes.reduce((sum, process) => sum + Number(process.WorkingSet64 || 0), 0)
  };
};

const browserSnapshot = (driver, ids) => driver.evaluate(async tabIds => {
  const tabs = [];
  for (const id of tabIds) {
    try {
      tabs.push(await chrome.tabs.get(id));
    }
    catch (error) {
      tabs.push({id, missing: true, error: error.message});
    }
  }
  const stored = await chrome.storage.session.get('__discardOwnership');
  return {ownership: stored.__discardOwnership || {}, tabs};
}, ids);

const main = async () => {
  const executableArg = arg('executable');
  if (!executableArg) {
    throw Error('Pass --executable <isolated Chrome-for-Testing executable>; this harness never defaults to Edge');
  }
  const executablePath = path.resolve(executableArg);
  if (path.basename(executablePath).toLowerCase() === 'msedge.exe' &&
      process.argv.includes('--allow-edge') === false) {
    throw Error('Refusing to launch Edge without the explicit --allow-edge safety flag');
  }
  const extensionPath = path.resolve(arg('extension', path.join(__dirname, '..', 'v3')));
  const profileRoot = path.resolve(arg('profile-root', path.join(__dirname, '.profiles')));
  const resultsRoot = path.resolve(arg('results', path.join(__dirname, 'results')));
  const runId = `matrix-${Date.now()}-${process.pid}`;
  const profile = path.join(profileRoot, runId);
  const resultPath = path.join(resultsRoot, `${runId}.json`);
  for (const [label, target] of [['browser executable', executablePath], ['extension', extensionPath]]) {
    if (!fs.existsSync(target)) {
      throw Error(`${label} does not exist: ${target}`);
    }
  }
  fs.mkdirSync(profile, {recursive: true});
  fs.mkdirSync(resultsRoot, {recursive: true});

  const fixture = await startFixtureServer();
  let launched;
  try {
    launched = await launchOverCDP({executablePath, extensionPath, profile});
  }
  catch (error) {
    await fixture.stop().catch(() => {});
    throw error;
  }
  const {browser, browserProcess, context} = launched;
  let cdp;
  try {
    cdp = await browser.newBrowserCDPSession();
  }
  catch (error) {
    await settleWithin(browser.close(), 5000);
    await terminateBrowserProcess(browserProcess);
    await fixture.stop().catch(() => {});
    throw error;
  }
  const timeline = [];
  const scenarios = [];
  const memory = [];
  let report;
  let driver;
  let extensionId;
  let manifest;
  let driverWindowId;
  let driverTabId;
  let scenarioSequence = 0;
  let runError;
  const telemetryToken = `${runId}-${crypto.randomUUID()}`;

  const writeReport = (ok, error) => {
    report = {
      browser: {executablePath, version: browser.version()},
      crashes: findCrashDumps(profile),
      error: error ? {message: error.message, stack: error.stack} : undefined,
      extension: extensionId ? {
        id: extensionId,
        path: extensionPath,
        treeSha256: hashDirectory(extensionPath),
        version: manifest?.version
      } : undefined,
      fixtureRequests: fixture.requests,
      memory,
      ok,
      profile,
      runId,
      scenarios,
      stderr: launched.stderr(),
      timeline
    };
    fs.writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  };

  try {
    const worker = await waitFor(async () => context.serviceWorkers()
      .find(candidate => candidate.url().endsWith('/worker/core.mjs')), 'extension service worker', 15000);
    extensionId = new URL(worker.url()).host;
    manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    driver = await context.newPage();
    await driver.goto(`chrome-extension://${extensionId}/data/options/index.html`);
    await context.exposeBinding('__atdEmit', (source, event) => {
      timeline.push({...event, receivedAt: Date.now()});
    });
    await driver.evaluate(async token => {
      globalThis.__atdE2ETelemetryToken = token;
      await chrome.storage.local.set({
        './plugins/blank/core.js': false,
        log: false,
        number: 0,
        period: 86400,
        prepends: '💤'
      });
      const current = await chrome.tabs.getCurrent();
      await chrome.tabs.update(current.id, {autoDiscardable: false, pinned: true});
      if (!globalThis.__atdTelemetryInstalled) {
        globalThis.__atdTelemetryInstalled = true;
        const compactTab = tab => tab && ({
          active: tab.active,
          discarded: tab.discarded,
          groupId: tab.groupId,
          id: tab.id,
          index: tab.index,
          status: tab.status,
          url: tab.url,
          windowId: tab.windowId
        });
        globalThis.__atdTelemetrySequence = 0;
        globalThis.__atdTelemetryPending = new Set();
        const emit = event => {
          const delivery = globalThis.__atdEmit({
            at: Date.now(),
            performanceAt: performance.now(),
            telemetrySequence: ++globalThis.__atdTelemetrySequence,
            ...event
          }).catch(() => {});
          globalThis.__atdTelemetryPending.add(delivery);
          delivery.finally(() => globalThis.__atdTelemetryPending.delete(delivery));
          return delivery;
        };
        globalThis.__atdFlushTelemetry = async () => {
          // Drain deliveries already created, then yield once so queued Chrome
          // events can enter their listeners and drain those deliveries too.
          for (let pass = 0; pass < 20; pass += 1) {
            const pending = [...globalThis.__atdTelemetryPending];
            if (pending.length) {
              await Promise.allSettled(pending);
            }
            await new Promise(resolve => setTimeout(resolve, 0));
            if (globalThis.__atdTelemetryPending.size === 0) {
              return globalThis.__atdTelemetrySequence;
            }
          }
          throw Error('telemetry delivery queue did not drain');
        };
        chrome.tabs.onUpdated.addListener((id, changeInfo, tab) => emit({
          changeInfo,
          event: 'tabs.onUpdated',
          id,
          tab: compactTab(tab)
        }));
        chrome.tabs.onActivated.addListener(activeInfo => emit({event: 'tabs.onActivated', activeInfo}));
        chrome.tabs.onRemoved.addListener((id, removeInfo) => emit({event: 'tabs.onRemoved', id, removeInfo}));
        chrome.tabs.onReplaced.addListener((addedId, removedId) => emit({
          addedId,
          event: 'tabs.onReplaced',
          removedId
        }));
        chrome.storage.onChanged.addListener((changes, areaName) => {
          if (changes.__discardOwnership) {
            emit({
              areaName,
              event: 'storage.ownership',
              value: changes.__discardOwnership
            });
          }
        });
        chrome.runtime.onMessage.addListener(request => {
          const api = request?.__atdE2EApiTelemetry;
          if (api?.token === globalThis.__atdE2ETelemetryToken) {
            emit(api);
          }
        });
      }
      return current;
    }, telemetryToken);
    const driverTab = await driver.evaluate(() => chrome.tabs.getCurrent());
    driverWindowId = driverTab.windowId;
    driverTabId = driverTab.id;

    const ensureDriver = async () => {
      if (!driver || driver.isClosed()) {
        driver = await context.newPage();
        await driver.goto(`chrome-extension://${extensionId}/data/options/index.html`);
      }
      return driver;
    };
    const currentWorker = () => waitFor(async () => context.serviceWorkers()
      .find(candidate => candidate.url().endsWith('/worker/core.mjs')), 'live extension service worker', 10000);
    const installWorkerApiTelemetry = async () => {
      const workerNow = await currentWorker();
      const installed = await workerNow.evaluate(token => {
        if (globalThis.__atdE2EApiTelemetry?.token === token) {
          return globalThis.__atdE2EApiTelemetry.status;
        }

        const instance = crypto.randomUUID();
        let apiSequence = 0;
        let operationSequence = 0;
        const originalExecuteScript = chrome.scripting.executeScript.bind(chrome.scripting);
        const originalDiscard = chrome.tabs.discard.bind(chrome.tabs);
        const record = event => {
          const value = {
            apiSequence: ++apiSequence,
            apiAt: Date.now(),
            token,
            workerInstance: instance,
            ...event
          };
          try {
            chrome.runtime.sendMessage({__atdE2EApiTelemetry: value}, () => chrome.runtime.lastError);
          }
          catch (error) {}
          return value;
        };

        const hookedExecuteScript = details => {
          const stopScript = details?.injectImmediately === true &&
            details.target?.allFrames !== true && typeof details.func === 'function';
          if (!stopScript) {
            return originalExecuteScript(details);
          }
          const operationId = `${instance}:stop:${++operationSequence}`;
          record({
            event: 'api.scripting.stop-call',
            id: details.target?.tabId,
            operationId
          });
          let operation;
          try {
            operation = originalExecuteScript(details);
          }
          catch (error) {
            record({
              error: error?.message || String(error),
              event: 'api.scripting.stop-complete',
              id: details.target?.tabId,
              operationId,
              outcome: 'rejected'
            });
            throw error;
          }
          return Promise.resolve(operation).then(result => {
            record({
              event: 'api.scripting.stop-complete',
              id: details.target?.tabId,
              operationId,
              outcome: 'fulfilled'
            });
            return result;
          }, error => {
            record({
              error: error?.message || String(error),
              event: 'api.scripting.stop-complete',
              id: details.target?.tabId,
              operationId,
              outcome: 'rejected'
            });
            throw error;
          });
        };

        const hookedDiscard = (...args) => {
          const id = args[0];
          const operationId = `${instance}:discard:${++operationSequence}`;
          record({event: 'api.tabs.discard-call', id, operationId});
          const callbackIndex = args.findLastIndex(value => typeof value === 'function');
          if (callbackIndex >= 0) {
            const callback = args[callbackIndex];
            args[callbackIndex] = function(...callbackArgs) {
              // Preserve runtime.lastError for production code by invoking its
              // callback before making another extension API call.
              const result = callback.apply(this, callbackArgs);
              record({event: 'api.tabs.discard-complete', id, operationId});
              return result;
            };
          }
          let operation;
          try {
            operation = originalDiscard(...args);
          }
          catch (error) {
            record({
              error: error?.message || String(error),
              event: 'api.tabs.discard-complete',
              id,
              operationId,
              outcome: 'rejected'
            });
            throw error;
          }
          if (callbackIndex < 0 && operation?.then) {
            return operation.then(result => {
              record({event: 'api.tabs.discard-complete', id, operationId, outcome: 'fulfilled'});
              return result;
            }, error => {
              record({
                error: error?.message || String(error),
                event: 'api.tabs.discard-complete',
                id,
                operationId,
                outcome: 'rejected'
              });
              throw error;
            });
          }
          return operation;
        };

        chrome.scripting.executeScript = hookedExecuteScript;
        chrome.tabs.discard = hookedDiscard;
        const status = {
          discard: chrome.tabs.discard === hookedDiscard,
          executeScript: chrome.scripting.executeScript === hookedExecuteScript,
          instance
        };
        globalThis.__atdE2EApiTelemetry = {status, token};
        return status;
      }, telemetryToken);
      assert.equal(installed.executeScript, true, 'service-worker executeScript telemetry hook must install');
      assert.equal(installed.discard, true, 'service-worker tabs.discard telemetry hook must install');
      return installed;
    };
    const flushTelemetry = async () => {
      await ensureDriver();
      return driver.evaluate(async () => {
        if (typeof globalThis.__atdFlushTelemetry !== 'function') {
          throw Error('persistent telemetry page is not initialized');
        }
        // Two drains put both queued Chrome event tasks and their exposed-
        // binding deliveries behind this synchronization point.
        await globalThis.__atdFlushTelemetry();
        await new Promise(resolve => setTimeout(resolve, 0));
        return globalThis.__atdFlushTelemetry();
      });
    };
    const telemetryCheckpoint = async () => ({
      at: Date.now(),
      sequence: await flushTelemetry()
    });
    const telemetrySince = async checkpoint => {
      await flushTelemetry();
      return timeline.filter(event => event.telemetrySequence > checkpoint.sequence &&
        (!event.at || event.at >= checkpoint.at));
    };
    const readSnapshot = ids => browserSnapshot(driver, ids);
    const assertNoCrashes = label => {
      const dumps = findCrashDumps(profile);
      assert.deepEqual(dumps, [], `${label} must not create a browser crash dump`);
    };
    const recordMemory = async label => {
      const sample = {at: Date.now(), label, ...await sampleMemory(cdp)};
      memory.push(sample);
      assert.equal(sample.available, true, `${label}: ${sample.error || 'memory sample unavailable'}`);
      return sample;
    };

    const reset = async () => {
      driver = await ensureDriver();
      const state = await driver.evaluate(async ({keepTabId, keepWindowId}) => {
        const windows = await chrome.windows.getAll({populate: true});
        for (const window of windows) {
          if (window.id !== keepWindowId) {
            await chrome.windows.remove(window.id).catch(() => {});
          }
        }
        const tabs = await chrome.tabs.query({windowId: keepWindowId});
        const removable = tabs.filter(tab => tab.id !== keepTabId).map(tab => tab.id);
        if (removable.length) {
          await chrome.tabs.remove(removable);
        }
        await chrome.tabs.update(keepTabId, {active: true, autoDiscardable: false, pinned: true});
        await chrome.windows.update(keepWindowId, {focused: true});
        return {removable};
      }, {keepTabId: driverTabId, keepWindowId: driverWindowId});
      await waitFor(async () => {
        const snapshot = await readSnapshot([]);
        return Object.keys(snapshot.ownership).length === 0;
      }, `ownership cleanup after removing ${state.removable.length} tabs`, 15000);
    };

    const fixtureUrl = (prefix, key, {holdReload = 0, mb = 4} = {}) => {
      const label = `${prefix}-${key}`;
      return {
        key,
        label,
        url: `${fixture.baseUrl}/tab?id=${encodeURIComponent(label)}&mb=${mb}` +
          (holdReload ? `&holdReload=${holdReload}` : '')
      };
    };

    const createWindow = async (entries, activeKey) => {
      const created = await driver.evaluate(async ({items, selectedKey}) => {
        const window = await chrome.windows.create({focused: false, url: items[0].url});
        const tabs = {[items[0].key]: window.tabs[0]};
        for (const item of items.slice(1)) {
          tabs[item.key] = await chrome.tabs.create({
            active: false,
            url: item.url,
            windowId: window.id
          });
        }
        await chrome.tabs.update(tabs[selectedKey].id, {active: true});
        return {tabs, windowId: window.id};
      }, {items: entries, selectedKey: activeKey});
      const ids = Object.values(created.tabs).map(tab => tab.id);
      await waitFor(async () => {
        const snapshot = await readSnapshot(ids);
        return snapshot.tabs.every(tab => tab.status === 'complete' && tab.discarded === false);
      }, `${entries.map(entry => entry.key).join(', ')} to load`, 20000);
      return created;
    };

    const mergeWindow = (layout, window, entries) => {
      layout.windowIds.push(window.windowId);
      for (const entry of entries) {
        layout.tabs[entry.key] = {
          ...window.tabs[entry.key],
          key: entry.key,
          label: entry.label,
          url: entry.url
        };
      }
    };

    const focusSelected = async layout => {
      await driver.evaluate(async ({id, windowId}) => {
        await chrome.tabs.update(id, {active: true});
        await chrome.windows.update(windowId, {focused: true});
      }, {id: layout.selectedId, windowId: layout.primaryWindowId});
      const workerNow = await currentWorker();
      const current = await workerNow.evaluate(async () => {
        const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
        const window = await chrome.windows.getLastFocused();
        return {tab, windowId: window.id};
      });
      assert.equal(current.windowId, layout.primaryWindowId, 'fixture primary window must be last focused');
      assert.equal(current.tab?.id, layout.selectedId, 'worker currentWindow must resolve to the selected fixture tab');
    };

    const buildDirect = async prefix => {
      await reset();
      const entries = [
        fixtureUrl(prefix, 'd-keeper-near'),
        fixtureUrl(prefix, 'd-selected', {mb: 16}),
        fixtureUrl(prefix, 'd-decoy'),
        fixtureUrl(prefix, 'd-keeper-far')
      ];
      const primary = await createWindow(entries, 'd-selected');
      const layout = {prefix, tabs: {}, windowIds: []};
      mergeWindow(layout, primary, entries);
      layout.primaryWindowId = primary.windowId;
      layout.selectedId = layout.tabs['d-selected'].id;
      await focusSelected(layout);
      return layout;
    };

    const buildGroup = async (prefix, {slowExternal = false} = {}) => {
      await reset();
      const entries = [
        fixtureUrl(prefix, 'g-keeper'),
        fixtureUrl(prefix, 'g-selected', {mb: 16}),
        fixtureUrl(prefix, 'g-loaded', {mb: 16}),
        fixtureUrl(prefix, 'g-external', {holdReload: slowExternal ? 10000 : 0, mb: 24}),
        fixtureUrl(prefix, 'g-out-loaded'),
        fixtureUrl(prefix, 'g-out-external')
      ];
      const primary = await createWindow(entries, 'g-selected');
      const layout = {prefix, tabs: {}, windowIds: []};
      mergeWindow(layout, primary, entries);
      layout.primaryWindowId = primary.windowId;
      layout.selectedId = layout.tabs['g-selected'].id;
      const groups = await driver.evaluate(async ({inside, outside, windowId}) => ({
        inside: await chrome.tabs.group({tabIds: inside, createProperties: {windowId}}),
        outside: await chrome.tabs.group({tabIds: outside, createProperties: {windowId}})
      }), {
        inside: ['g-selected', 'g-loaded', 'g-external'].map(key => layout.tabs[key].id),
        outside: ['g-out-loaded', 'g-out-external'].map(key => layout.tabs[key].id),
        windowId: layout.primaryWindowId
      });
      layout.groupIds = groups;
      const highlightState = await driver.evaluate(async ({outsideId, selectedId, windowId}) => {
        const tabs = await chrome.tabs.query({windowId});
        const outside = tabs.find(tab => tab.id === outsideId);
        const selected = tabs.find(tab => tab.id === selectedId);
        // Chromium activates the first listed index while keeping the full
        // list highlighted. Put the selected group tab first so the outsider
        // remains a genuine highlighted decoy without changing the command root.
        await chrome.tabs.highlight({windowId, tabs: [selected.index, outside.index]});
        return chrome.tabs.query({windowId});
      }, {
        outsideId: layout.tabs['g-out-loaded'].id,
        selectedId: layout.selectedId,
        windowId: layout.primaryWindowId
      });
      assert.equal(highlightState.find(tab => tab.id === layout.selectedId)?.highlighted, true,
        'selected group tab must be highlighted');
      assert.equal(highlightState.find(tab => tab.id === layout.tabs['g-out-loaded'].id)?.highlighted, true,
        'out-of-group decoy must be highlighted');
      await focusSelected(layout);
      await externalDiscard(layout, ['g-external', 'g-out-external']);
      return layout;
    };

    const buildScoped = async (prefix, {holdKeys = new Set()} = {}) => {
      await reset();
      const make = key => fixtureUrl(prefix, key, {
        holdReload: holdKeys.has(key) ? 10000 : 0,
        mb: holdKeys.has(key) ? 24 : 4
      });
      const primaryEntries = [
        make('p-left-far'),
        make('p-left-near'),
        make('p-selected'),
        make('p-right-near'),
        make('p-right-mid'),
        make('p-right-far')
      ];
      const aEntries = [make('a-active'), make('a-bg-1'), make('a-bg-2')];
      const bEntries = [make('b-active'), make('b-bg-1'), make('b-bg-2')];
      const primary = await createWindow(primaryEntries, 'p-selected');
      const a = await createWindow(aEntries, 'a-active');
      const b = await createWindow(bEntries, 'b-active');
      const layout = {prefix, tabs: {}, windowIds: []};
      mergeWindow(layout, primary, primaryEntries);
      mergeWindow(layout, a, aEntries);
      mergeWindow(layout, b, bEntries);
      layout.primaryWindowId = primary.windowId;
      layout.selectedId = layout.tabs['p-selected'].id;
      await focusSelected(layout);
      return layout;
    };

    function tabIds(layout, keys = Object.keys(layout.tabs)) {
      return keys.map(key => layout.tabs[key].id);
    }
    const counts = (layout, keys = Object.keys(layout.tabs)) => Object.fromEntries(
      keys.map(key => [key, fixture.count(layout.tabs[key].label)])
    );
    const compactSnapshot = async layout => {
      const keys = Object.keys(layout.tabs);
      const snapshot = await readSnapshot(tabIds(layout, keys));
      return {
        ownership: snapshot.ownership,
        tabs: Object.fromEntries(keys.map((key, index) => [key, snapshot.tabs[index]]))
      };
    };
    const assertOwnershipKeys = (snapshot, layout, expectedKeys, label) => {
      const expectedIds = [...new Set(expectedKeys.map(key => String(layout.tabs[key].id)))].sort();
      const actualIds = Object.keys(snapshot.ownership).sort();
      assert.deepEqual(actualIds, expectedIds, `${label}: ownership keys must match the exact fixture scope`);
      for (const id of expectedIds) {
        assert.equal(snapshot.ownership[id]?.state, 'owned', `${label}: marker ${id} must be settled owned state`);
      }
    };

    async function externalDiscard(layout, keys) {
      await focusSelected(layout);
      await driver.evaluate(ids => Promise.all(ids.map(id => new Promise(resolve => {
        chrome.tabs.discard(id, tab => {
          const error = chrome.runtime.lastError;
          resolve({error: error?.message, id, tab});
        });
      }))), tabIds(layout, keys));
      await waitFor(async () => {
        const snapshot = await compactSnapshot(layout);
        return keys.every(key => snapshot.tabs[key].discarded === true &&
          snapshot.tabs[key].status === 'unloaded' &&
          snapshot.ownership[layout.tabs[key].id]?.source === 'claimed');
      }, `external discards to become claimed: ${keys.join(', ')}`, 15000);
    }

    const openPopup = async layout => {
      await focusSelected(layout);
      const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const url = `chrome-extension://${extensionId}/data/popup/index.html#e2e-${nonce}`;
      const created = await driver.evaluate(({windowId, url}) => chrome.tabs.create({
        active: false,
        url,
        windowId
      }), {url, windowId: layout.primaryWindowId});
      const page = await waitFor(() => context.pages().find(candidate => candidate.url() === url),
        `popup test page ${nonce}`, 10000);
      await page.waitForSelector('[data-cmd="discard-tab"]');
      await page.waitForFunction(() =>
        document.querySelector('[data-cmd="discard-tab"]')?.textContent.trim().length > 0);
      return {created, page};
    };

    const removePopup = async popup => {
      if (!popup.page.isClosed()) {
        await driver.evaluate(id => chrome.tabs.remove(id).catch(() => {}), popup.created.id);
      }
    };

    const auditPopup = async layout => {
      const popup = await openPopup(layout);
      try {
        for (const command of POPUP_COMMANDS) {
          assert.equal(await popup.page.locator(`[data-cmd="${command}"]`).count(), 1,
            `popup must expose exactly one ${command} control`);
        }
      }
      finally {
        await removePopup(popup);
      }
    };

    const inspectReleaseAvailability = async layout => {
      const popup = await openPopup(layout);
      try {
        await sleep(300);
        return Object.fromEntries(await Promise.all(Object.keys(RELEASE_SPECS).map(async command => [
          command,
          await popup.page.locator(`[data-cmd="${command}"]`).evaluate(element =>
            element.classList.contains('disabled') === false)
        ])));
      }
      finally {
        await removePopup(popup);
      }
    };

    const clickPopup = async (layout, command, shiftKey = false) => {
      const popup = await openPopup(layout);
      await focusSelected(layout);
      await installWorkerApiTelemetry();
      const responseToken = `${command}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const hooked = await popup.page.evaluate(token => {
        globalThis.__atdE2EResponseToken = token;
        if (globalThis.__atdE2ESendHooked) {
          return true;
        }
        const original = chrome.runtime.sendMessage.bind(chrome.runtime);
        try {
          const hookedSend = (...args) => {
            const request = args.find(value => value && typeof value === 'object' && value.method);
            if (request?.method === 'popup') {
              globalThis.__atdEmit({
                at: Date.now(),
                event: 'popup-request',
                request: {
                  cmd: request.cmd,
                  method: request.method,
                  shiftKey: request.shiftKey === true
                },
                token: globalThis.__atdE2EResponseToken
              }).catch(() => {});
              const callbackIndex = args.findLastIndex(value => typeof value === 'function');
              const callback = callbackIndex >= 0 ? args[callbackIndex] : undefined;
              const wrapped = response => {
                const error = chrome.runtime.lastError?.message;
                globalThis.__atdE2EPopupResult = {
                  done: true,
                  error,
                  response
                };
                globalThis.__atdEmit({
                  at: Date.now(),
                  error,
                  event: 'popup-response',
                  response,
                  token: globalThis.__atdE2EResponseToken
                }).then(() => callback?.(response), () => callback?.(response));
              };
              if (callbackIndex >= 0) {
                args[callbackIndex] = wrapped;
              }
              else {
                args.push(wrapped);
              }
            }
            return original(...args);
          };
          chrome.runtime.sendMessage = hookedSend;
          globalThis.__atdE2ESendHooked = true;
          return chrome.runtime.sendMessage === hookedSend;
        }
        catch (error) {
          return false;
        }
      }, responseToken);
      assert.equal(hooked, true, `${command}: popup response hook must install`);
      const marker = {at: Date.now(), command, event: 'command-start', shiftKey};
      timeline.push(marker);
      let polling = true;
      const poll = (async () => {
        while (polling) {
          try {
            const snapshot = await compactSnapshot(layout);
            timeline.push({
              at: Date.now(),
              command,
              event: 'poll',
              shiftKey,
              tabs: Object.fromEntries(Object.entries(snapshot.tabs).map(([key, tab]) => [key, {
                active: tab.active,
                discarded: tab.discarded,
                id: tab.id,
                status: tab.status
              }]))
            });
          }
          catch (error) {
            timeline.push({at: Date.now(), command, error: error.message, event: 'poll-error', shiftKey});
          }
          await sleep(25);
        }
      })();
      try {
        await popup.page.locator(`[data-cmd="${command}"]`).click({
          modifiers: shiftKey ? ['Shift'] : []
        });
        const outcome = await waitFor(() => timeline.find(event =>
          event.event === 'popup-response' && event.token === responseToken),
        `${command} popup response`, 30000);
        const popupRequest = await waitFor(() => timeline.find(event =>
          event.event === 'popup-request' && event.token === responseToken),
        `${command} popup request`, 5000);
        assert.deepEqual(popupRequest.request, {
          cmd: command,
          method: 'popup',
          shiftKey
        }, `${command}: the real popup click must forward its modifier state`);
        assert.equal(outcome.error, undefined, `${command} popup runtime error`);
        assert.equal(outcome.response?.ok, true, `${command} failed: ${outcome.response?.error}`);
      }
      finally {
        polling = false;
        await poll;
        await removePopup(popup);
        timeline.push({at: Date.now(), command, event: 'command-response', shiftKey});
      }
    };

    const sendPopupCommand = async (layout, command, shiftKey = false) => {
      await focusSelected(layout);
      await installWorkerApiTelemetry();
      const outcome = await driver.evaluate(({cmd, shifted}) => new Promise(resolve => {
        chrome.runtime.sendMessage({method: 'popup', cmd, shiftKey: shifted}, response => resolve({
          error: chrome.runtime.lastError?.message,
          response
        }));
      }), {cmd: command, shifted: shiftKey});
      assert.equal(outcome.error, undefined, `${command} runtime message must succeed`);
      assert.equal(outcome.response?.ok, true, `${command} failed: ${outcome.response?.error}`);
    };

    const assertTakeoverApiOrder = async (checkpoint, id, label) => {
      const events = await telemetrySince(checkpoint);
      const api = events.filter(event => event.token === telemetryToken && event.id === id &&
        Number.isInteger(event.apiSequence)).sort((a, b) => a.apiSequence - b.apiSequence);
      const discardCalls = api.filter(event => event.event === 'api.tabs.discard-call');
      assert.equal(discardCalls.length, 1, `${label}: native tabs.discard must be invoked exactly once`);
      const discardCall = discardCalls[0];
      const stopCalls = api.filter(event => event.event === 'api.scripting.stop-call');
      const stopCompletions = api.filter(event => event.event === 'api.scripting.stop-complete');
      assert.ok(stopCalls.length > 0, `${label}: at least one injected stop script must run`);
      assert.equal(discardCall.workerInstance, stopCalls[0].workerInstance,
        `${label}: stop and native discard boundaries must come from one live worker`);

      for (const call of stopCalls) {
        const completion = stopCompletions.find(event => event.operationId === call.operationId);
        assert.ok(completion, `${label}: stop operation ${call.operationId} must settle`);
        assert.equal(completion.workerInstance, discardCall.workerInstance,
          `${label}: stop completion must belong to the worker that performs native discard`);
        assert.ok(call.apiSequence < completion.apiSequence && completion.apiSequence < discardCall.apiSequence,
          `${label}: stop ${call.operationId} must complete before native tabs.discard`);
      }
      assert.ok(stopCompletions.some(event => event.outcome === 'fulfilled' &&
        event.apiSequence < discardCall.apiSequence),
      `${label}: a stop script must fulfill before native tabs.discard`);
      assert.equal(api.some(event => event.event.startsWith('api.scripting.stop-') &&
        event.apiSequence > discardCall.apiSequence), false,
      `${label}: no stop injection may remain or start after native tabs.discard`);
      return {
        discardSequence: discardCall.apiSequence,
        stopSequences: stopCompletions.map(event => event.apiSequence)
      };
    };

    const assertStable = async (layout, duration = 1500) => {
      const before = await compactSnapshot(layout);
      const requestBefore = counts(layout);
      const telemetryStart = await telemetryCheckpoint();
      const sleeperIds = new Set(Object.entries(before.tabs)
        .filter(([, tab]) => tab.discarded === true)
        .map(([, tab]) => tab.id));
      await sleep(duration);
      const after = await compactSnapshot(layout);
      const requestAfter = counts(layout);
      for (const key of Object.keys(layout.tabs)) {
        assert.deepEqual({
          discarded: after.tabs[key].discarded,
          source: after.ownership[layout.tabs[key].id]?.source,
          status: after.tabs[key].status
        }, {
          discarded: before.tabs[key].discarded,
          source: before.ownership[layout.tabs[key].id]?.source,
          status: before.tabs[key].status
        }, `${key} must remain stable during the quiescence dwell`);
      }
      assert.deepEqual(requestAfter, requestBefore, 'quiescence dwell must not issue delayed document requests');
      const wakeEvents = (await telemetrySince(telemetryStart)).filter(event =>
        event.event === 'tabs.onUpdated' && sleeperIds.has(event.id) &&
        (event.tab?.discarded === false || event.tab?.status === 'loading'));
      assert.deepEqual(wakeEvents, [], 'quiescence dwell must not contain a transient sleeper wake/loading cycle');
    };

    const nextPrefix = name => `${String(++scenarioSequence).padStart(2, '0')}-${name}`;

    // Selected-tab row through the real popup DOM.
    {
      const name = 'discard-tab';
      const layout = await buildDirect(nextPrefix(name));
      await auditPopup(layout);
      const baseline = counts(layout);
      await recordMemory(`${name}:loaded`);
      await clickPopup(layout, name, false);
      await waitFor(async () => {
        const snapshot = await compactSnapshot(layout);
        return snapshot.tabs['d-selected'].discarded === true &&
          snapshot.tabs['d-selected'].status === 'unloaded' &&
          snapshot.ownership[layout.tabs['d-selected'].id]?.source === 'self';
      }, `${name} final state`, 20000);
      const after = await compactSnapshot(layout);
      assertOwnershipKeys(after, layout, ['d-selected'], name);
      assert.match(after.tabs['d-selected'].title, /^💤\s/,
        'a tab physically discarded by the extension must receive the configured sleep title prefix');
      assert.equal(after.tabs['d-keeper-near'].active, true, 'nearest eligible keeper must become active');
      for (const key of ['d-keeper-near', 'd-decoy', 'd-keeper-far']) {
        assert.equal(after.tabs[key].discarded, false, `${key} must remain loaded`);
        assert.equal(after.ownership[layout.tabs[key].id], undefined, `${key} must remain unowned`);
      }
      assert.deepEqual(counts(layout), baseline, 'discard-tab must not reload a document');
      await assertStable(layout);
      await recordMemory(`${name}:discarded`);
      assertNoCrashes(name);
      scenarios.push({name, ok: true, targets: ['d-selected']});
    }

    {
      const name = 'discard-tree-ungrouped';
      const layout = await buildDirect(nextPrefix(name));
      const baseline = counts(layout);
      await clickPopup(layout, 'discard-tree', false);
      await waitFor(async () => {
        const snapshot = await compactSnapshot(layout);
        return snapshot.tabs['d-selected'].discarded === true &&
          snapshot.tabs['d-selected'].status === 'unloaded' &&
          snapshot.ownership[layout.tabs['d-selected'].id]?.source === 'self';
      }, `${name} final state`, 20000);
      const after = await compactSnapshot(layout);
      assertOwnershipKeys(after, layout, ['d-selected'], name);
      for (const key of ['d-keeper-near', 'd-decoy', 'd-keeper-far']) {
        assert.equal(after.tabs[key].discarded, false, `${name} must not include neighboring ungrouped ${key}`);
      }
      assert.deepEqual(counts(layout), baseline, `${name} must not reload a document`);
      await assertStable(layout);
      assertNoCrashes(name);
      scenarios.push({name, ok: true, targets: ['d-selected']});
    }

    // Native Chromium/Edge group row: normal adoption never wakes an existing
    // discard, while Shift physically takes it over only after quiescing reload.
    {
      const name = 'discard-tree-normal';
      const layout = await buildGroup(nextPrefix(name));
      const baseline = counts(layout);
      const start = await telemetryCheckpoint();
      await clickPopup(layout, 'discard-tree', false);
      await waitFor(async () => {
        const snapshot = await compactSnapshot(layout);
        return ['g-selected', 'g-loaded', 'g-external'].every(key =>
          snapshot.tabs[key].discarded === true && snapshot.tabs[key].status === 'unloaded') &&
          snapshot.ownership[layout.tabs['g-selected'].id]?.source === 'self' &&
          snapshot.ownership[layout.tabs['g-loaded'].id]?.source === 'self' &&
          snapshot.ownership[layout.tabs['g-external'].id]?.source === 'adopted';
      }, `${name} final state`, 20000);
      const after = await compactSnapshot(layout);
      assertOwnershipKeys(after, layout,
        ['g-selected', 'g-loaded', 'g-external', 'g-out-external'], name);
      for (const key of ['g-selected', 'g-loaded']) {
        assert.equal(after.tabs[key].groupId, layout.groupIds.inside, `${key} must retain the selected group ID`);
        assert.match(after.tabs[key].title, /^💤\s/, `${key} must show the extension sleep title prefix`);
      }
      assert.equal(after.tabs['g-external'].groupId, layout.groupIds.inside,
        'adopted group member must retain the selected group ID');
      assert.equal(after.tabs['g-external'].title.startsWith('💤 '), false,
        'in-place adoption must not wake the page merely to rewrite its title');
      for (const key of ['g-out-loaded', 'g-out-external']) {
        assert.equal(after.tabs[key].groupId, layout.groupIds.outside, `${key} must retain the outsider group ID`);
      }
      assert.notEqual(layout.groupIds.inside, layout.groupIds.outside, 'fixture groups must be distinct');
      assert.equal(after.tabs['g-keeper'].active, true, 'out-of-group keeper must become active');
      assert.equal(after.tabs['g-out-loaded'].discarded, false, 'other group loaded member must be untouched');
      assert.equal(after.tabs['g-out-external'].discarded, true, 'other group sleeper must stay asleep');
      assert.equal(after.ownership[layout.tabs['g-out-external'].id]?.source, 'claimed');
      assert.deepEqual(counts(layout), baseline, 'normal group adoption must issue no document requests');
      const externalId = layout.tabs['g-external'].id;
      assert.equal((await telemetrySince(start)).some(event => event.event === 'tabs.onUpdated' &&
        event.id === externalId && event.tab?.discarded === false), false,
      'normal group adoption must never wake the existing discard');
      await assertStable(layout);
      assertNoCrashes(name);
      scenarios.push({name, ok: true, sources: {external: 'adopted', loaded: 'self'}});
    }

    {
      const name = 'discard-tree-shift-takeover';
      const layout = await buildGroup(nextPrefix(name), {slowExternal: true});
      const baseline = counts(layout);
      const memoryBefore = await recordMemory(`${name}:before`);
      const start = await telemetryCheckpoint();
      const startedAt = Date.now();
      await clickPopup(layout, 'discard-tree', true);
      await waitFor(async () => {
        const snapshot = await compactSnapshot(layout);
        return ['g-selected', 'g-loaded', 'g-external'].every(key =>
          snapshot.tabs[key].discarded === true && snapshot.tabs[key].status === 'unloaded' &&
          snapshot.ownership[layout.tabs[key].id]?.source === 'self');
      }, `${name} final state`, 20000);
      const durationMs = Date.now() - startedAt;
      const requestAfter = counts(layout);
      assert.equal(requestAfter['g-external'], baseline['g-external'] + 1,
        'Shift group takeover must wake the external member exactly once');
      for (const key of Object.keys(layout.tabs).filter(key => key !== 'g-external')) {
        assert.equal(requestAfter[key], baseline[key], `${key} must not be reloaded by Shift group takeover`);
      }
      const secondRequest = fixture.entries(layout.tabs['g-external'].label)[1];
      assert.ok(secondRequest, 'slow takeover reload must reach the fixture server');
      await waitFor(() => secondRequest.closedAt, 'stopped takeover response to close', 5000);
      assert.equal(secondRequest.aborted, true, 'window.stop must abort the deliberately held response');
      assert.equal(secondRequest.writableFinished, false, 'held response must stop before natural completion');
      assert.ok(durationMs < 5000, `takeover must stop the 10-second response promptly, got ${durationMs}ms`);
      const id = layout.tabs['g-external'].id;
      const groupAfter = await compactSnapshot(layout);
      assertOwnershipKeys(groupAfter, layout,
        ['g-selected', 'g-loaded', 'g-external', 'g-out-external'], name);
      for (const key of ['g-selected', 'g-loaded', 'g-external']) {
        assert.equal(groupAfter.tabs[key].groupId, layout.groupIds.inside, `${key} must retain its group after Shift`);
      }
      assert.match(groupAfter.tabs['g-external'].title, /^💤\s/,
        'physical takeover must add the same visible sleep title prefix as an ordinary extension discard');
      for (const key of ['g-out-loaded', 'g-out-external']) {
        assert.equal(groupAfter.tabs[key].groupId, layout.groupIds.outside, `${key} outsider group must remain intact`);
      }
      const apiOrder = await assertTakeoverApiOrder(start, id, name);
      const events = (await telemetrySince(start))
        .filter(event => event.event === 'tabs.onUpdated' && event.id === id);
      const loading = events.findIndex(event => event.tab?.discarded === false && event.tab?.status === 'loading');
      const complete = events.findIndex((event, index) => index > loading &&
        event.tab?.discarded === false && event.tab?.status === 'complete');
      const unloaded = events.findIndex((event, index) => index > complete &&
        event.tab?.discarded === true && event.tab?.status === 'unloaded');
      assert.ok(loading >= 0, 'telemetry must observe the takeover reload in loading state');
      assert.ok(complete > loading, 'the reload must quiesce before native discard');
      assert.ok(unloaded > complete, 'native discard must happen only after reload quiescence');
      assert.equal(fixture.entries(layout.tabs['g-external'].label).length, 2,
        'Shift group takeover must never enter a reload loop');
      const memoryImmediate = await recordMemory(`${name}:immediate`);
      await assertStable(layout, 3000);
      const memoryAfter = await recordMemory(`${name}:after`);
      const memoryCeiling = Math.max(memoryBefore.privateBytes, memoryImmediate.privateBytes) + 64 * 1024 * 1024;
      assert.ok(memoryAfter.privateBytes <= memoryCeiling,
        `${name} private memory must not keep climbing after quiescence`);
      assertNoCrashes(name);
      scenarios.push({
        apiOrder,
        durationMs,
        name,
        ok: true,
        sequence: ['loading', 'complete', 'unloaded']
      });
    }

    // All five scoped discard rows. Each real popup click must discard loaded
    // targets, adopt already-discarded targets in place, preserve outsiders,
    // and then let Shift upgrade only the adopted targets physically.
    for (const [command, targets] of Object.entries(DISCARD_SPECS)) {
      const name = `${command}-normal-and-shift`;
      const inScope = new Set(targets);
      const layout = await buildScoped(nextPrefix(name), {holdKeys: SETUP_EXTERNAL});
      const protectedKey = command === 'discard-tabs' ? 'p-right-far' : undefined;
      if (protectedKey) {
        await driver.evaluate(id => chrome.tabs.update(id, {autoDiscardable: false}),
          layout.tabs[protectedKey].id);
      }
      await externalDiscard(layout, [...SETUP_EXTERNAL]);
      const baseline = counts(layout);
      const normalStart = await telemetryCheckpoint();
      await clickPopup(layout, command, false);
      const normalTargets = targets.filter(key => key !== protectedKey);
      await waitFor(async () => {
        const snapshot = await compactSnapshot(layout);
        return normalTargets.every(key => snapshot.tabs[key].discarded === true &&
          snapshot.tabs[key].status === 'unloaded' &&
          snapshot.ownership[layout.tabs[key].id]?.source ===
            (SETUP_EXTERNAL.has(key) ? 'adopted' : 'self'));
      }, `${command} normal final state`, 25000);
      let after = await compactSnapshot(layout);
      assertOwnershipKeys(after, layout, [...normalTargets, ...SETUP_EXTERNAL], `${command} normal`);
      for (const key of ALL_BACKGROUND.filter(key => !inScope.has(key))) {
        if (SETUP_EXTERNAL.has(key)) {
          assert.equal(after.tabs[key].discarded, true, `${command} must keep ${key} asleep`);
          assert.equal(after.ownership[layout.tabs[key].id]?.source, 'claimed',
            `${command} must not adopt out-of-scope ${key}`);
        }
        else {
          assert.equal(after.tabs[key].discarded, false, `${command} must keep ${key} loaded`);
          assert.equal(after.ownership[layout.tabs[key].id], undefined,
            `${command} must not own out-of-scope ${key}`);
        }
      }
      for (const key of ['p-selected', 'a-active', 'b-active']) {
        assert.equal(after.tabs[key].discarded, false, `${command} must exclude active tab ${key}`);
      }
      if (protectedKey) {
        assert.equal(after.tabs[protectedKey].discarded, false,
          `${command} normal path must respect autoDiscardable:false`);
        assert.equal(after.ownership[layout.tabs[protectedKey].id], undefined,
          `${command} normal path must not own the protected tab`);
      }
      assert.deepEqual(counts(layout), baseline, `${command} normal path must issue zero document requests`);
      for (const key of targets.filter(key => SETUP_EXTERNAL.has(key))) {
        const id = layout.tabs[key].id;
        assert.equal((await telemetrySince(normalStart)).some(event => event.event === 'tabs.onUpdated' &&
          event.id === id && event.tab?.discarded === false), false,
        `${command} normal path must not wake ${key}`);
      }

      const normalRepeatBaseline = counts(layout);
      const normalRepeatStart = await telemetryCheckpoint();
      await sendPopupCommand(layout, command, false);
      assert.deepEqual(counts(layout), normalRepeatBaseline, `${command} repeat normal command must be a no-op`);
      for (const key of targets.filter(key => SETUP_EXTERNAL.has(key))) {
        const id = layout.tabs[key].id;
        assert.equal((await telemetrySince(normalRepeatStart)).some(event => event.event === 'tabs.onUpdated' &&
          event.id === id && (event.tab?.discarded === false || event.tab?.status === 'loading')), false,
        `${command} repeat normal command must not wake adopted ${key}`);
      }

      const shiftBaseline = counts(layout);
      const shiftStart = await telemetryCheckpoint();
      await clickPopup(layout, command, true);
      await waitFor(async () => {
        const snapshot = await compactSnapshot(layout);
        return targets.every(key => snapshot.tabs[key].discarded === true &&
          snapshot.tabs[key].status === 'unloaded' &&
          snapshot.ownership[layout.tabs[key].id]?.source === 'self');
      }, `${command} Shift final state`, 30000);
      after = await compactSnapshot(layout);
      assertOwnershipKeys(after, layout, [...targets, ...SETUP_EXTERNAL], `${command} Shift`);
      const shiftAfter = counts(layout);
      for (const key of targets) {
        const expectedDelta = SETUP_EXTERNAL.has(key) ? 1 : 0;
        assert.equal(shiftAfter[key], shiftBaseline[key] + expectedDelta,
          `${command} Shift request delta for ${key}`);
        assert.equal(after.ownership[layout.tabs[key].id]?.source, 'self');
      }
      for (const key of ALL_BACKGROUND.filter(key => !inScope.has(key))) {
        assert.equal(shiftAfter[key], shiftBaseline[key], `${command} Shift must not reload ${key}`);
        if (SETUP_EXTERNAL.has(key)) {
          assert.equal(after.ownership[layout.tabs[key].id]?.source, 'claimed',
            `${command} Shift must not take over out-of-scope ${key}`);
        }
      }
      for (const key of targets.filter(key => SETUP_EXTERNAL.has(key))) {
        const id = layout.tabs[key].id;
        await assertTakeoverApiOrder(shiftStart, id, `${command} ${key}`);
        const events = (await telemetrySince(shiftStart))
          .filter(event => event.event === 'tabs.onUpdated' && event.id === id);
        const loading = events.findIndex(event => event.tab?.discarded === false && event.tab?.status === 'loading');
        const complete = events.findIndex((event, index) => index > loading &&
          event.tab?.discarded === false && event.tab?.status === 'complete');
        const unloaded = events.findIndex((event, index) => index > complete &&
          event.tab?.discarded === true && event.tab?.status === 'unloaded');
        assert.ok(loading >= 0 && complete > loading && unloaded > complete,
          `${command} must quiesce ${key} in loading -> complete -> unloaded order`);
        const secondRequest = fixture.entries(layout.tabs[key].label)[1];
        await waitFor(() => secondRequest?.closedAt, `${command} stopped response for ${key}`, 5000);
        assert.equal(secondRequest.aborted, true);
        assert.equal(secondRequest.writableFinished, false);
        assert.equal(fixture.entries(layout.tabs[key].label).length, 2,
          `${command} must wake ${key} exactly once`);
      }

      const repeatBaseline = counts(layout);
      await sendPopupCommand(layout, command, true);
      assert.deepEqual(counts(layout), repeatBaseline, `${command} repeat Shift must be a no-op`);
      await assertStable(layout);
      assertNoCrashes(name);
      scenarios.push({
        name,
        normalTargets,
        ok: true,
        protectedShiftOverride: protectedKey,
        shiftTakeovers: targets.filter(key => SETUP_EXTERNAL.has(key))
      });
    }

    // All five X controls. Every in-scope sleeper loads exactly once, every
    // out-of-scope sleeper stays unloaded, and a repeat release is a no-op.
    // release-tabs additionally uses the real Shift-click path on a deliberate
    // self/adopted/claimed ownership mix, covering the popup's bypass-cache
    // modifier without replacing any of the ordinary per-scope release cases.
    for (const [command, targets] of Object.entries(RELEASE_SPECS)) {
      const name = command;
      const inScope = new Set(targets);
      const layout = await buildScoped(nextPrefix(name));
      const shiftKey = command === 'release-tabs';
      let sourcesBefore;
      if (shiftKey) {
        const setupBaseline = counts(layout);

        // Create self markers on the left without touching the other scopes.
        await clickPopup(layout, 'discard-lefts', false);
        await waitFor(async () => {
          const snapshot = await compactSnapshot(layout);
          return ['p-left-far', 'p-left-near'].every(key =>
            snapshot.tabs[key].discarded === true && snapshot.tabs[key].status === 'unloaded' &&
            snapshot.ownership[layout.tabs[key].id]?.source === 'self');
        }, `${command}: self-owned release fixtures`, 20000);

        // Adopt one external sleeper while physically discarding the other
        // right-side tabs, then leave every other-window sleeper merely claimed.
        await externalDiscard(layout, ['p-right-mid']);
        await clickPopup(layout, 'discard-rights', false);
        await waitFor(async () => {
          const snapshot = await compactSnapshot(layout);
          return snapshot.ownership[layout.tabs['p-right-mid'].id]?.source === 'adopted' &&
            ['p-right-near', 'p-right-far'].every(key =>
              snapshot.tabs[key].discarded === true && snapshot.tabs[key].status === 'unloaded' &&
              snapshot.ownership[layout.tabs[key].id]?.source === 'self');
        }, `${command}: adopted and self-owned release fixtures`, 20000);
        await externalDiscard(layout, OTHER_BACKGROUND);

        const prepared = await compactSnapshot(layout);
        assertOwnershipKeys(prepared, layout, ALL_BACKGROUND, `${command} mixed-source setup`);
        sourcesBefore = Object.fromEntries(ALL_BACKGROUND.map(key => [key,
          prepared.ownership[layout.tabs[key].id]?.source]));
        assert.deepEqual(sourcesBefore, {
          'p-left-far': 'self',
          'p-left-near': 'self',
          'p-right-near': 'self',
          'p-right-mid': 'adopted',
          'p-right-far': 'self',
          'a-bg-1': 'claimed',
          'a-bg-2': 'claimed',
          'b-bg-1': 'claimed',
          'b-bg-2': 'claimed'
        }, `${command}: release fixture must contain every ownership source`);
        assert.deepEqual(counts(layout), setupBaseline,
          `${command}: mixed-source preparation must not reload any document`);
      }
      else {
        await externalDiscard(layout, ALL_BACKGROUND);
      }
      const availableBefore = await inspectReleaseAvailability(layout);
      assert.deepEqual(availableBefore, Object.fromEntries(Object.keys(RELEASE_SPECS)
        .map(key => [key, true])), `${command}: all release controls must begin enabled`);
      const baseline = counts(layout);
      await clickPopup(layout, command, shiftKey);
      await waitFor(async () => {
        const snapshot = await compactSnapshot(layout);
        return targets.every(key => snapshot.tabs[key].discarded === false &&
          snapshot.tabs[key].status === 'complete' &&
          snapshot.ownership[layout.tabs[key].id] === undefined);
      }, `${command} targets to finish reloading`, 25000);
      const after = await compactSnapshot(layout);
      assertOwnershipKeys(after, layout, ALL_BACKGROUND.filter(key => !inScope.has(key)), command);
      const requestAfter = counts(layout);
      for (const key of targets) {
        assert.equal(requestAfter[key], baseline[key] + 1, `${command} must reload ${key} exactly once`);
        assert.equal(after.tabs[key].discarded, false);
        assert.equal(after.tabs[key].status, 'complete');
        assert.equal(after.ownership[layout.tabs[key].id], undefined);
      }
      for (const key of ALL_BACKGROUND.filter(key => !inScope.has(key))) {
        assert.equal(requestAfter[key], baseline[key], `${command} must not reload out-of-scope ${key}`);
        assert.equal(after.tabs[key].discarded, true, `${command} must keep out-of-scope ${key} asleep`);
        assert.equal(after.tabs[key].status, 'unloaded');
        assert.equal(after.ownership[layout.tabs[key].id]?.source, 'claimed');
      }
      for (const key of ['p-selected', 'a-active', 'b-active']) {
        assert.equal(after.tabs[key].discarded, false, `${command} must leave active ${key} loaded`);
        assert.equal(requestAfter[key], baseline[key]);
      }

      const availableAfter = await inspectReleaseAvailability(layout);
      assert.deepEqual(availableAfter, RELEASE_AVAILABILITY_AFTER[command],
        `${command}: popup release availability must match the live scopes`);
      const repeatBaseline = counts(layout);
      await sendPopupCommand(layout, command, shiftKey);
      await sleep(500);
      assert.deepEqual(counts(layout), repeatBaseline, `${command} repeat must issue no document requests`);
      await assertStable(layout);
      assertNoCrashes(name);
      scenarios.push({
        availabilityAfter: availableAfter,
        bypassCache: shiftKey,
        name,
        ok: true,
        released: targets,
        sourcesBefore
      });
    }

    await reset();
    await recordMemory('final-clean-profile');
    assertNoCrashes('complete matrix');
    writeReport(true);
  }
  catch (error) {
    runError = error;
    writeReport(false, error);
  }
  finally {
    const detach = await settleWithin(cdp.detach(), 3000);
    const close = await settleWithin(browser.close(), 5000);
    const processCleanup = await terminateBrowserProcess(browserProcess);
    const fixtureCleanup = await settleWithin(fixture.stop(), 5000);
    await sleep(750);
    const crashes = findCrashDumps(profile);
    const cleanup = {browser: close, cdp: detach, fixture: fixtureCleanup, process: processCleanup};
    if (!report) {
      writeReport(false, runError || Error('matrix stopped before producing a report'));
    }
    report.cleanup = cleanup;
    report.crashes = crashes;
    report.stderr = launched.stderr();
    if (crashes.length && !runError) {
      runError = Error(`browser produced ${crashes.length} crash dump(s)`);
      report.error = {message: runError.message, stack: runError.stack};
      report.ok = false;
    }
    if ((!processCleanup.exited || fixtureCleanup.status !== 'fulfilled') && !runError) {
      runError = Error('isolated browser or fixture server did not clean up completely');
      report.error = {message: runError.message, stack: runError.stack};
      report.ok = false;
    }
    if (!runError && report.ok === true) {
      try {
        fs.rmSync(profile, {force: true, maxRetries: 3, recursive: true, retryDelay: 250});
        if (fs.existsSync(profile)) {
          throw Error('profile directory still exists after removal');
        }
        cleanup.profile = {path: profile, removed: true, retained: false};
      }
      catch (error) {
        cleanup.profile = {
          error: error?.message || String(error),
          path: profile,
          removed: false,
          retained: fs.existsSync(profile)
        };
        runError = Error(`isolated browser profile cleanup failed: ${cleanup.profile.error}`);
        report.error = {message: runError.message, stack: runError.stack};
        report.ok = false;
      }
    }
    else {
      cleanup.profile = {path: profile, removed: false, retained: true};
    }
    fs.writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (runError) {
    runError.message = `${runError.message}\nFull failure report: ${resultPath}`;
    throw runError;
  }
  process.stdout.write(`${JSON.stringify({
    browser: report.browser,
    cleanup: report.cleanup,
    crashes: report.crashes,
    extension: report.extension,
    matrix: scenarios.map(scenario => ({name: scenario.name, ok: scenario.ok})),
    resultPath
  }, null, 2)}\n`);
};

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
