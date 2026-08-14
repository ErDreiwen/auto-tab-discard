#!/usr/bin/env node
'use strict';

const {createHash, randomBytes} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
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
const PROFILE_PREFIX = 'atd-cm-';
const RESULT_PREFIX = 'chromium-minimum-smoke-';
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, '..');
const LEGACY_WINDOWS_MAX_PATH = 260;
const MANAGED_STORAGE_EXTENSION_ID = 'a'.repeat(32);
const MANAGED_STORAGE_LEVELDB_MANIFEST = 'MANIFEST-000001';
const ROUND_TRIP_ATTEMPT_TIMEOUT = 2500;
const ROUND_TRIP_READY_TIMEOUT = 30000;
const MANAGED_SENTINEL = 'minimum-managed-round-trip';
const SESSION_SENTINEL = 'minimum-session-round-trip';

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const ensure = (condition, message) => {
  if (!condition) {
    throw Error(message);
  }
};
const settleWithin = (promise, timeout) => new Promise(resolve => {
  const timer = setTimeout(() => resolve({status: 'timed-out'}), timeout);
  Promise.resolve(promise).then(
    () => {
      clearTimeout(timer);
      resolve({status: 'fulfilled'});
    },
    reason => {
      clearTimeout(timer);
      resolve({reason, status: 'rejected'});
    }
  );
});

const isExpectedBrowserCloseTransportError = error => {
  const message = String(error?.message || error || '');
  const endpoint = '(?:target|browser|connection|socket|websocket|session)';
  const closed = '(?:closed|closing|disconnected|not open|destroyed|terminated|hang up|econnreset|epipe)';
  return new RegExp(`${endpoint}.{0,96}${closed}|${closed}.{0,96}${endpoint}`, 'i').test(message);
};

const dispatchBrowserClose = async (cdp, {timeout = 45000} = {}) => {
  if (!cdp || typeof cdp.send !== 'function') {
    return {dispatched: false, status: 'not-started'};
  }
  let request;
  try {
    request = cdp.send('Browser.close');
  }
  catch {
    return {dispatched: false, status: 'rejected'};
  }
  const settled = await settleWithin(request, timeout);
  if (settled.status === 'fulfilled') {
    return {dispatched: true, status: 'fulfilled'};
  }
  if (settled.status === 'rejected' && isExpectedBrowserCloseTransportError(settled.reason)) {
    return {dispatched: true, status: 'transport-closed'};
  }
  return {dispatched: true, status: settled.status};
};

const browserCloseWasNominallyDispatched = close => close?.dispatched === true &&
  ['fulfilled', 'transport-closed'].includes(close.status);
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

const sanitizeText = value => String(value ?? '')
  .replaceAll(WORKSPACE_ROOT, '<workspace>')
  .replace(/[A-Z]:[\\/]Users[\\/][^\\/\s]+/gi, '<user-path>')
  .replace(/chrome-extension:\/\/[a-p]{32}/gi, 'chrome-extension://<redacted>')
  .replace(/(?:atd-cm-|chromium-minimum-smoke-(?:\d+-\d+-)?)[a-f\d]+/gi, '<isolated-profile>');

const safeProfile = (profileRoot, profile) => {
  const root = path.resolve(profileRoot);
  const candidate = path.resolve(profile);
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative) &&
    path.basename(candidate).startsWith(PROFILE_PREFIX);
};

const legacyManagedStoragePath = profile => path.join(
  path.resolve(profile),
  'Default',
  'Managed Extension Settings',
  MANAGED_STORAGE_EXTENSION_ID,
  MANAGED_STORAGE_LEVELDB_MANIFEST
);

const validateLegacyProfilePath = profile => {
  ensure(legacyManagedStoragePath(profile).length < LEGACY_WINDOWS_MAX_PATH,
    'The isolated Chromium profile exceeds the Chromium 102 managed-storage MAX_PATH budget');
  return true;
};

const loadPlaywright = () => {
  let playwrightRoot;
  if (process.env.PLAYWRIGHT_PATH) {
    playwrightRoot = path.resolve(process.env.PLAYWRIGHT_PATH);
  }
  else if (process.env.CODEX_NODE_MODULES) {
    playwrightRoot = path.join(path.resolve(process.env.CODEX_NODE_MODULES), 'playwright');
  }
  else {
    playwrightRoot = path.dirname(require.resolve('playwright/package.json'));
  }
  const packageJson = path.join(playwrightRoot, 'package.json');
  ensure(fs.existsSync(packageJson), 'The selected Playwright package has no package metadata');
  const metadata = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
  ensure(metadata.name === 'playwright' && /^\d+\.\d+\.\d+$/.test(metadata.version),
    'The selected Playwright package metadata is invalid');
  return {runtime: require(playwrightRoot), version: metadata.version};
};

// This is the same normalized tree algorithm used by archive-inventory.mjs.
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

const crashArtifacts = root => {
  if (!fs.existsSync(root)) {
    return [];
  }
  const found = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      }
      else if (/\.(?:dmp|mdmp)$/i.test(entry.name)) {
        found.push({bytes: fs.statSync(absolute).size, type: path.extname(entry.name).toLowerCase()});
      }
    }
  };
  visit(root);
  return found;
};

const processCleanup = async (controller, close) => {
  if (!controller?.processTree) {
    return {exited: false, graceful: false, identityVerified: false, owner: 'windows-kernel-job'};
  }
  return {
    ...await cleanupExactProcessTree(controller.processTree, {
      nominalCloseSucceeded: browserCloseWasNominallyDispatched(close)
    }),
    owner: 'windows-kernel-job'
  };
};

const validateRuntimeIdentity = ({expectedId, expectedVersion, probe}) => {
  ensure(probe?.id === expectedId, 'extension page runtime ID did not match the service-worker origin');
  ensure(probe?.version === expectedVersion, 'extension page runtime version did not match the packaged manifest');
  ensure(probe?.origin === `chrome-extension://${expectedId}`,
    'extension page did not retain the service-worker extension origin');
  ensure(probe?.webLocks === true,
    'extension options realm does not expose the required Web Locks API');
  return true;
};

const runtimeRoundTripOutcome = probe => {
  if (probe?.message?.timedOut !== false) return 'timed-out';
  if (probe?.message?.error !== false) return 'runtime-error';
  if (probe?.message?.managed !== MANAGED_SENTINEL || probe?.message?.session !== SESSION_SENTINEL) {
    return 'invalid-response';
  }
  return 'passed';
};

const validateRuntimeRoundTrip = probe => {
  const outcome = runtimeRoundTripOutcome(probe);
  ensure(outcome !== 'runtime-error', 'storage runtime message reported an extension error');
  ensure(outcome !== 'timed-out', 'storage runtime message timed out');
  ensure(outcome === 'passed', 'storage runtime message did not return both worker response sentinels');
  return true;
};

const validateRuntimeProbe = ({expectedId, expectedVersion, probe}) => {
  validateRuntimeIdentity({expectedId, expectedVersion, probe});
  validateRuntimeRoundTrip(probe);
  return true;
};

const waitForRuntimeRoundTrip = async ({
  attempt,
  delay = sleep,
  interval = 250,
  now = Date.now,
  onProgress = () => {},
  timeout = ROUND_TRIP_READY_TIMEOUT
}) => {
  const startedAt = now();
  let attempts = 0;
  let lastOutcome = 'not-attempted';
  while (attempts === 0 || now() - startedAt < timeout) {
    attempts += 1;
    try {
      const probe = await attempt(attempts);
      lastOutcome = runtimeRoundTripOutcome(probe);
      onProgress({attempts, lastOutcome});
      if (lastOutcome === 'passed') {
        return {attempts, lastOutcome, probe};
      }
    }
    catch {
      lastOutcome = 'evaluation-failed';
      onProgress({attempts, lastOutcome});
    }
    if (now() - startedAt < timeout) {
      await delay(interval);
    }
  }
  const error = Error(`storage runtime listener was not ready after ${attempts} bounded attempts (${lastOutcome})`);
  error.readiness = {attempts, lastOutcome};
  throw error;
};

const run = async () => {
  const executable = path.resolve(option('executable', ''));
  const expectedVersion = option('expected-version', '');
  const expectedPlaywrightVersion = option('expected-playwright-version', '');
  const extension = path.resolve(option('extension', DEFAULT_EXTENSION));
  const profileRoot = path.resolve(option('profile-root', DEFAULT_PROFILE_ROOT));
  const resultsRoot = path.resolve(option('results-root', DEFAULT_RESULTS_ROOT));
  ensure(option('executable', ''), 'Pass --executable with the pinned Chromium executable');
  ensure(expectedVersion, 'Pass --expected-version with the exact pinned Chromium version');
  ensure(expectedPlaywrightVersion,
    'Pass --expected-playwright-version with the exact pinned Playwright driver version');
  ensure(process.platform === 'win32', 'The Chromium minimum cleanup proof requires Windows process identity APIs');
  ensure(fs.existsSync(executable), 'The Chromium executable does not exist');
  ensure(fs.existsSync(path.join(extension, 'manifest.json')), 'The extracted Chromium extension does not exist');

  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
  const backgroundKeys = Object.keys(manifest.background || {}).sort();
  ensure(JSON.stringify(backgroundKeys) === JSON.stringify(['service_worker', 'type']),
    'The Chromium artifact manifest must contain only the module service worker background');
  ensure(manifest.background.service_worker === 'worker/core.mjs' && manifest.background.type === 'module',
    'The Chromium artifact manifest does not select worker/core.mjs as a module service worker');

  fs.mkdirSync(profileRoot, {recursive: true});
  fs.mkdirSync(resultsRoot, {recursive: true});
  // Chromium 102's Windows managed-storage backend still observes legacy
  // MAX_PATH. Keep the otherwise opaque per-run component short, then reject
  // any caller-supplied root that cannot fit the exact managed-extension path.
  const runId = randomBytes(8).toString('hex');
  const profile = path.join(profileRoot, `${PROFILE_PREFIX}${runId}`);
  const resultPath = path.join(resultsRoot, `${RESULT_PREFIX}${runId}.json`);
  ensure(safeProfile(profileRoot, profile), 'The generated Chromium profile escaped its isolated profile root');
  validateLegacyProfilePath(profile);

  const report = {
    assertions: [],
    browser: {family: 'chromium'},
    cleanup: {
      process: {exited: false, identityVerified: false},
      profile: {isolated: true, removed: false}
    },
    crashes: [],
    driver: {name: 'playwright'},
    extension: {
      treeSha256: extensionTreeSha256(extension),
      version: manifest.version
    },
    outcome: 'failed',
    schemaVersion: 1
  };
  const pass = (name, details = {}) => report.assertions.push({details, name, passed: true});
  let context;
  let cdpBrowser;
  let cdp;
  let controller;
  let primaryError;

  try {
    const playwright = loadPlaywright();
    report.driver.version = playwright.version;
    ensure(playwright.version === expectedPlaywrightVersion,
      `expected Playwright ${expectedPlaywrightVersion}, received ${playwright.version}`);
    pass('Playwright reports the exact pinned minimum driver', {version: playwright.version});
    const {chromium} = playwright.runtime;
    fs.mkdirSync(profile, {recursive: false});
    const args = [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--disable-background-mode',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-features=OptimizationHints,MediaRouter',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-default-browser-check',
      '--no-first-run',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--window-position=40,40',
      '--window-size=1200,800',
      'about:blank'
    ];
    const launched = launchProcessInExactJob({
      args,
      executable,
      profile,
      profileSwitch: 'user-data-dir'
    });
    launched.child.stderr.resume();
    controller = {
      child: launched.child,
      executable,
      processTree: await bindExactProcessTree(launched),
      profile
    };
    const port = await waitFor(() => {
      const portFile = path.join(profile, 'DevToolsActivePort');
      if (!fs.existsSync(portFile)) return false;
      return Number(fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0]) || false;
    }, 'Job-owned Chromium DevTools port', 30000);
    cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {timeout: 10000});
    ensure(cdpBrowser.contexts().length === 1,
      'Job-owned Chromium did not expose exactly one default context');
    context = cdpBrowser.contexts()[0];
    report.browser.version = cdpBrowser.version();
    ensure(report.browser.version === expectedVersion,
      `expected Chromium ${expectedVersion}, received ${report.browser.version || 'none'}`);
    pass('browser reports the exact pinned Chromium minimum', {version: report.browser.version});

    cdp = await cdpBrowser.newBrowserCDPSession();
    const {processInfo = []} = await cdp.send('SystemInfo.getProcessInfo');
    const browserPids = [...new Set(processInfo.filter(item => item?.type === 'browser')
      .map(item => Number(item.id)).filter(pid => Number.isInteger(pid) && pid > 0))];
    ensure(browserPids.length === 1, 'Chromium browser process identity was missing or ambiguous');
    ensure(browserPids[0] === controller.processTree.rootPid,
      'CDP browser PID did not match the kernel Job-owned browser handle');
    const observedWorkerTargets = new Set();
    const observeWorkerTarget = candidate => {
      if (candidate?.url().endsWith('/worker/core.mjs')) {
        observedWorkerTargets.add(candidate);
      }
    };
    context.on('serviceworker', observeWorkerTarget);
    context.serviceWorkers().forEach(observeWorkerTarget);
    const worker = await waitFor(() => context.serviceWorkers()
      .find(candidate => candidate.url().endsWith('/worker/core.mjs')),
    'packaged Chromium module service-worker target', 20000);
    observeWorkerTarget(worker);
    const workerUrl = new URL(worker.url());
    const extensionId = workerUrl.host;
    ensure(workerUrl.protocol === 'chrome-extension:' && /^[a-p]{32}$/.test(extensionId),
      'service-worker target did not expose a valid extension origin');
    pass('packaged module service-worker target is present');

    const page = await context.newPage();
    const optionsPath = String(manifest.options_ui?.page || '').replace(/^\/+/, '');
    ensure(optionsPath, 'The packaged Chromium manifest has no options page');
    await page.goto(`chrome-extension://${extensionId}/${optionsPath}`, {waitUntil: 'domcontentloaded'});
    const identityProbe = await page.evaluate(() => ({
      id: chrome.runtime.id,
      origin: location.origin,
      version: chrome.runtime.getManifest().version,
      webLocks: typeof navigator.locks?.request === 'function'
    }));
    validateRuntimeIdentity({
      expectedId: extensionId,
      expectedVersion: manifest.version,
      probe: identityProbe
    });
    pass('extension options page exposes matching runtime identity and version');

    report.runtimeDiagnostics = {};
    report.runtimeDiagnostics.directStorage = await page.evaluate(attemptTimeout => {
      const read = area => new Promise(resolve => {
        const timer = setTimeout(() => resolve({callback: false, timedOut: true}), attemptTimeout);
        chrome.storage[area].get({__chromiumMinimumProbe: `${area}-default`}, values => {
          clearTimeout(timer);
          resolve({
            callback: true,
            defaultReturned: values?.__chromiumMinimumProbe === `${area}-default`,
            error: Boolean(chrome.runtime.lastError),
            timedOut: false
          });
        });
      });
      return Promise.all(['managed', 'session'].map(read)).then(([managed, session]) => ({
        managed,
        session
      }));
    }, ROUND_TRIP_ATTEMPT_TIMEOUT);
    report.runtimeDiagnostics.messages = await page.evaluate(attemptTimeout => {
      const send = message => new Promise(resolve => {
        const timer = setTimeout(() => resolve({callback: false, timedOut: true}), attemptTimeout);
        chrome.runtime.sendMessage(message, response => {
          clearTimeout(timer);
          resolve({
            callback: true,
            error: Boolean(chrome.runtime.lastError),
            ok: response?.ok === true,
            timedOut: false
          });
        });
      });
      return Promise.all([
        send({method: '__chromium-minimum-unknown'}),
        send({method: 'build-context'})
      ]).then(([unknown, buildContext]) => ({buildContext, unknown}));
    }, ROUND_TRIP_ATTEMPT_TIMEOUT);

    report.runtimeReadiness = {
      attempts: 0,
      lastOutcome: 'not-attempted',
      serviceWorkerTargetChurn: 0,
      serviceWorkerTargetsObserved: observedWorkerTargets.size
    };
    const readiness = await waitForRuntimeRoundTrip({
      attempt: async () => {
        for (const candidate of context.serviceWorkers()
          .filter(item => item.url().endsWith('/worker/core.mjs'))) {
          observeWorkerTarget(candidate);
          ensure(new URL(candidate.url()).host === extensionId,
            'service-worker target changed to an unexpected extension origin');
        }
        return page.evaluate(({attemptTimeout, managedSentinel, sessionSentinel}) => new Promise(resolve => {
          const timer = setTimeout(() => resolve({
            message: {error: false, timedOut: true}
          }), attemptTimeout);
          chrome.runtime.sendMessage({
            managed: {__chromiumMinimumManaged: managedSentinel},
            method: 'storage',
            session: {__chromiumMinimumSession: sessionSentinel}
          }, response => {
            clearTimeout(timer);
            resolve({
              message: {
                error: Boolean(chrome.runtime.lastError),
                managed: response?.__chromiumMinimumManaged,
                session: response?.__chromiumMinimumSession,
                timedOut: false
              }
            });
          });
        }), {
          attemptTimeout: ROUND_TRIP_ATTEMPT_TIMEOUT,
          managedSentinel: MANAGED_SENTINEL,
          sessionSentinel: SESSION_SENTINEL
        });
      },
      onProgress: state => Object.assign(report.runtimeReadiness, state, {
        serviceWorkerTargetChurn: Math.max(0, observedWorkerTargets.size - 1),
        serviceWorkerTargetsObserved: observedWorkerTargets.size
      })
    });
    validateRuntimeRoundTrip(readiness.probe);
    pass('storage runtime message completes a module-worker Web Lock round trip', {
      attempts: readiness.attempts,
      serviceWorkerWebLockAcquired: true,
      serviceWorkerTargetChurn: Math.max(0, observedWorkerTargets.size - 1),
      serviceWorkerTargetsObserved: observedWorkerTargets.size
    });
    report.outcome = 'passed';
  }
  catch (error) {
    primaryError = error;
    report.error = {reasonCode: 'chromium-minimum-compatibility-failed'};
  }
  finally {
    const close = await dispatchBrowserClose(cdp);
    if (cdp) {
      await settleWithin(Promise.resolve().then(() => cdp.detach()), 3000);
    }
    if (controller?.processTree) {
      try {
        controller.processTree = refreshExactProcessTree(controller.processTree);
      }
      catch (error) {
        primaryError ||= error;
      }
    }
    try {
      report.cleanup.process = await processCleanup(controller, close);
    }
    catch (error) {
      forceCleanupExactProcessTreeSync(controller?.processTree);
      report.cleanup.process = {
        exited: false,
        graceful: false,
        identityVerified: false,
        owner: 'windows-kernel-job'
      };
      primaryError ||= error;
    }
    report.crashes = crashArtifacts(profile);
    if (report.crashes.length !== 0 || report.cleanup.process.exited !== true ||
        report.cleanup.process.graceful !== true || report.cleanup.process.forced?.needed !== false ||
        report.cleanup.process.identityVerified !== true ||
        report.cleanup.process.jobEmptyVerified !== true || report.cleanup.process.ownerExited !== true) {
      report.outcome = 'failed';
      report.error ||= {reasonCode: 'chromium-minimum-cleanup-failed'};
      primaryError ||= Error('Chromium minimum crash/process cleanup proof failed');
    }
    try {
      ensure(safeProfile(profileRoot, profile), 'Refusing unsafe Chromium profile cleanup');
      ensure(!fs.existsSync(profile) || report.cleanup.process.exited === true &&
        report.cleanup.process.identityVerified === true && report.cleanup.process.jobEmptyVerified === true &&
        report.cleanup.process.ownerExited === true,
      'The isolated Chromium profile was retained because process exit was not verified');
      fs.rmSync(profile, {force: true, maxRetries: 5, recursive: true, retryDelay: 250});
      ensure(!fs.existsSync(profile), 'The isolated Chromium profile was not removed');
      report.cleanup.profile.removed = true;
    }
    catch (error) {
      report.outcome = 'failed';
      report.error ||= {reasonCode: 'chromium-minimum-cleanup-failed'};
      primaryError ||= error;
    }
    fs.writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  if (primaryError || report.outcome !== 'passed') {
    throw primaryError || Error('Chromium minimum compatibility smoke failed');
  }
  process.stdout.write(`${JSON.stringify({
    browser: report.browser,
    cleanup: report.cleanup,
    driver: report.driver,
    extension: report.extension,
    outcome: report.outcome,
    resultFile: path.basename(resultPath)
  }, null, 2)}\n`);
};

if (require.main === module) {
  run().catch(error => {
    process.stderr.write(`Chromium minimum smoke failed: ${sanitizeText(error?.message || error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  browserCloseWasNominallyDispatched,
  dispatchBrowserClose,
  extensionTreeSha256,
  isExpectedBrowserCloseTransportError,
  legacyManagedStoragePath,
  runtimeRoundTripOutcome,
  safeProfile,
  sanitizeText,
  validateLegacyProfilePath,
  validateRuntimeProbe,
  waitForRuntimeRoundTrip
};
