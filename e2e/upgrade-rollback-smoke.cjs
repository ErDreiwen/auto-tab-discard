const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {chromium} = require('./playwright-runtime.cjs');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const waitFor = async (task, label, timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  let last;
  let error;
  while (Date.now() < deadline) {
    try {
      last = await task();
      error = undefined;
      if (last) return last;
    }
    catch (cause) {
      error = cause;
    }
    await sleep(50);
  }
  throw Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}${
    error ? `; error=${error.message}` : ''}`);
};
const bounded = async (operation, timeout = 5000) => {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(operation).then(value => ({status: 'fulfilled', value}), error => ({
        error: error?.message || String(error), status: 'rejected'
      })),
      new Promise(resolve => timer = setTimeout(() => resolve({status: 'timeout'}), timeout))
    ]);
  }
  finally {
    clearTimeout(timer);
  }
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
const terminate = async child => {
  const graceful = await waitExit(child);
  const forced = graceful ? false : killTree(child);
  const exited = graceful || await waitExit(child);
  if (!exited) throw Error('isolated browser process did not exit');
  return {exited, forced, graceful};
};

let emergencyChild;
const emergency = () => killTree(emergencyChild);
process.once('exit', emergency);
process.once('SIGINT', () => { emergency(); process.exit(130); });
process.once('SIGTERM', () => { emergency(); process.exit(143); });

const copyTree = (source, destination) => {
  fs.rmSync(destination, {force: true, recursive: true});
  fs.cpSync(source, destination, {recursive: true});
};
const overlayTree = (source, destination) => {
  const sourceFiles = new Set();
  const visit = (directory, relative = '') => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const target = path.join(directory, entry.name);
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(target, name);
      else if (entry.isFile()) sourceFiles.add(name);
    }
  };
  visit(source);
  // Keep the unpacked root continuously present. Removing it even briefly
  // makes Chromium uninstall the extension instead of reloading an update.
  fs.cpSync(source, destination, {force: true, recursive: true});
  const prune = (directory, relative = '') => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const target = path.join(directory, entry.name);
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        prune(target, name);
        if (fs.readdirSync(target).length === 0) fs.rmdirSync(target);
      }
      else if (entry.isFile() && !sourceFiles.has(name)) {
        fs.rmSync(target, {force: true});
      }
    }
  };
  prune(destination);
};
const createController = root => {
  const directory = path.join(root, 'controller');
  fs.mkdirSync(directory, {recursive: true});
  const {publicKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
  const der = publicKey.export({format: 'der', type: 'spki'});
  fs.writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify({
    background: {service_worker: 'worker.js'},
    key: der.toString('base64'),
    manifest_version: 3,
    name: 'ATD isolated upgrade controller',
    permissions: ['management', 'tabs'],
    version: '1.0.0'
  })}\n`);
  fs.writeFileSync(path.join(directory, 'worker.js'),
    '// Isolated E2E controller. Keep discovery alive only in this temporary profile.\n' +
    'setInterval(() => {}, 1000);\n');
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><title>ATD controller</title>\n');
  return {directory};
};
const hashTree = root => {
  const files = [];
  const visit = directory => fs.readdirSync(directory, {withFileTypes: true}).forEach(entry => {
    const target = path.join(directory, entry.name);
    entry.isDirectory() ? visit(target) : entry.isFile() && files.push(target);
  });
  visit(root);
  const hash = crypto.createHash('sha256');
  files.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))).forEach(file => {
    hash.update(path.relative(root, file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  });
  return hash.digest('hex');
};
const safeMessage = error => String(error?.message || error || 'unknown error')
  .replace(/[A-Za-z]:[\\/]Users[\\/][^\\/]+/gi, '<user-profile>')
  .replace(/(?:chrome|edge)-extension:\/\/[a-p]{32}/gi, '<extension-origin>')
  .replace(/(?:https?:\/\/)?127\.0\.0\.1:\d+/gi, '<loopback>');

const fixtureServer = async () => {
  const requests = new Map();
  const tracked = new Set(['claimed', 'pending', 'self']);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const label = url.searchParams.get('case');
    if (!tracked.has(label)) {
      response.writeHead(204, {'cache-control': 'no-store'});
      response.end();
      return;
    }
    requests.set(label, (requests.get(label) || 0) + 1);
    response.writeHead(200, {'cache-control': 'no-store', 'content-type': 'text/html'});
    response.end(`<!doctype html><title>${label}</title><p>${label}</p>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    counts: () => Object.fromEntries([...requests].sort()),
    stop: () => new Promise(resolve => server.close(resolve)),
    url: label => `http://127.0.0.1:${port}/fixture?case=${encodeURIComponent(label)}`
  };
};

const launch = async ({controller, edge, executable, extension, profile}) => {
  // A graceful Chromium shutdown leaves this ephemeral file behind. Remove
  // only the exact isolated-profile port file so a restart cannot connect to
  // the previous process's dead debugging endpoint.
  fs.rmSync(path.join(profile, 'DevToolsActivePort'), {force: true});
  const extensions = [extension, controller].join(',');
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extensions}`,
    `--load-extension=${extensions}`,
    '--restore-last-session',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-component-update',
    '--disable-background-mode',
    '--disable-features=OptimizationHints,MediaRouter',
    'about:blank'
  ];
  if (edge) args.splice(-1, 0, '--disable-background-networking');
  const child = spawn(executable, args, {
    stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true
  });
  emergencyChild = child;
  let spawnError;
  child.once('error', error => spawnError = error);
  try {
    const port = await waitFor(() => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw Error(`browser exited before CDP (${child.exitCode})`);
      const file = path.join(profile, 'DevToolsActivePort');
      if (!fs.existsSync(file)) return false;
      return Number(fs.readFileSync(file, 'utf8').trim().split(/\r?\n/, 1)[0]) || false;
    }, 'DevToolsActivePort');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (!context) throw Error('default browser context is unavailable');
    return {browser, child, context};
  }
  catch (error) {
    await terminate(child);
    throw error;
  }
};

const extensionVersion = page => page.evaluate(() => chrome.runtime.getManifest().version);
const openDriver = async (context, extensionId) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/data/options/index.html`);
  return page;
};
const discoverTargetId = async (context, version) => {
  const controller = await waitFor(() => context.serviceWorkers()
    .find(worker => worker.url().endsWith('/worker.js')), 'isolated controller worker');
  const controllerId = new URL(controller.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${controllerId}/index.html`);
  const id = await page.evaluate(async expected => {
    const items = await new Promise((resolve, reject) => chrome.management.getAll(values => {
      const error = chrome.runtime.lastError;
      error ? reject(Error(error.message)) : resolve(values);
    }));
    const target = items.find(item => item.enabled === true && item.installType === 'development' &&
      item.name !== 'ATD isolated upgrade controller' && item.version === expected);
    return target?.id;
  }, version);
  await page.close();
  if (!/^[a-p]{32}$/.test(id || '')) throw Error(`controller did not find target version ${version}`);
  return id;
};
const reloadFromManager = async (context, extensionId, edge) => {
  const manager = await context.newPage();
  await manager.goto(`${edge ? 'edge' : 'chrome'}://extensions/`);
  try {
    if (edge) {
      const loadError = await manager.evaluate(id => chrome.developerPrivate.reload(id, {
        failQuietly: true,
        populateErrorForUnpacked: true
      }), extensionId);
      if (loadError) {
        throw Error(`browser rejected candidate extension: ${loadError.error || 'unknown load error'}`);
      }
    }
    else {
      await waitFor(() => manager.evaluate(id => {
        const root = document.querySelector('extensions-manager')?.shadowRoot;
        const toolbar = root?.querySelector('extensions-toolbar')?.shadowRoot;
        const developerMode = toolbar?.querySelector('#devMode');
        if (developerMode && developerMode.checked === false) {
          developerMode.click();
          return false;
        }
        const list = root?.querySelector('extensions-item-list')?.shadowRoot;
        const item = [...(list?.querySelectorAll('extensions-item') || [])]
          .find(candidate => candidate.id === id || candidate.getAttribute('id') === id);
        const reload = item?.shadowRoot?.querySelector('#dev-reload-button');
        if (!reload) return false;
        reload.click();
        return true;
      }, extensionId), 'Chrome developer-mode extension reload');
    }
  }
  finally {
    await manager.close().catch(() => {});
  }
};
const reloadExtension = async (driver, context, extensionId, version, edge) => {
  await reloadFromManager(context, extensionId, edge);
  await driver.close().catch(() => {});
  return waitFor(async () => {
    const candidate = await context.newPage();
    try {
      await candidate.goto(`chrome-extension://${extensionId}/data/options/index.html`);
      if (await extensionVersion(candidate) === version) return candidate;
    }
    catch (error) {
      // Chromium briefly rejects extension pages while runtime.reload settles.
    }
    await candidate.close().catch(() => {});
    return false;
  }, `extension ${version} to reload`);
};
const wakeWorker = page => page.evaluate(() => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({method: 'storage'}, response => {
    const error = chrome.runtime.lastError;
    error ? reject(Error(error.message)) : resolve(response);
  });
}));
const workerTarget = async (cdp, extensionId, excludedTargetId) => {
  const {targetInfos} = await cdp.send('Target.getTargets');
  return targetInfos.find(info => info.type === 'service_worker' &&
    info.url === `chrome-extension://${extensionId}/worker/core.mjs` &&
    info.targetId !== excludedTargetId);
};
const findWorkerTarget = (cdp, extensionId, excludedTargetId) => waitFor(
  () => workerTarget(cdp, extensionId, excludedTargetId),
  'extension service worker target'
);
const sessionSnapshot = page => page.evaluate(async () => {
  const all = await chrome.storage.session.get(null);
  const prefix = '__discardOwnership:tab:';
  return Object.fromEntries(Object.entries(all)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => [key.slice(prefix.length), value?.marker]));
});
const liveFixtureTabs = driver => driver.evaluate(async () => (await chrome.tabs.query({}))
  .filter(tab => /^http:\/\/127\.0\.0\.1:\d+\/fixture\?case=(?:self|claimed|pending)(?:&|$)/
    .test(tab.url || ''))
  .map(tab => ({
    active: tab.active,
    discarded: tab.discarded,
    id: tab.id,
    label: new URL(tab.url).searchParams.get('case'),
    status: tab.status
  })));

const main = async () => {
  const executable = path.resolve(arg('executable') || '');
  const source = path.resolve(arg('extension', path.join(__dirname, '..', 'v3')));
  const baselineSource = path.resolve(arg('baseline') || '');
  const profileRoot = path.resolve(arg('profile-root', path.join(__dirname, '.profiles')));
  const resultsRoot = path.resolve(arg('results', path.join(__dirname, 'results')));
  const edge = path.basename(executable).toLowerCase() === 'msedge.exe';
  if (!fs.existsSync(executable) || !fs.existsSync(path.join(source, 'manifest.json')) ||
      !fs.existsSync(path.join(baselineSource, 'manifest.json'))) {
    throw Error('valid --executable, --extension, and --baseline paths are required');
  }
  if (edge && !process.argv.includes('--allow-edge')) {
    throw Error('refusing Edge without --allow-edge');
  }

  const currentVersion = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'))).version;
  const baselineVersion = JSON.parse(fs.readFileSync(path.join(baselineSource, 'manifest.json'))).version;
  assert.notEqual(currentVersion, baselineVersion);
  const run = `upgrade-${Date.now()}-${process.pid}`;
  const root = path.join(profileRoot, run);
  const profile = path.join(root, 'profile');
  const baseline = path.join(root, 'baseline');
  const live = path.join(root, 'extension');
  const reportPath = path.join(resultsRoot, `${run}.json`);
  fs.mkdirSync(profile, {recursive: true});
  fs.mkdirSync(resultsRoot, {recursive: true});
  copyTree(baselineSource, baseline);
  copyTree(baseline, live);
  const controller = createController(root);
  const baselineTreeSha256 = hashTree(baselineSource);
  const currentTreeSha256 = hashTree(source);
  const fixture = await fixtureServer();
  const phases = [];
  let launched;
  let report;
  let failure;

  const record = (name, details = {}) => phases.push({name, requests: fixture.counts(), ...details});
  try {
    launched = await launch({controller: controller.directory, edge, executable, extension: live, profile});
    let {browser, child, context} = launched;
    const extensionId = await discoverTargetId(context, baselineVersion);
    let driver = await openDriver(context, extensionId);
    assert.equal(await extensionVersion(driver), baselineVersion);

    const labels = ['self', 'claimed', 'pending'];
    const urls = Object.fromEntries([
      ...labels.map(label => [label, fixture.url(label)]),
      ['keeper', fixture.url('keeper')]
    ]);
    const created = await driver.evaluate(async values => {
      const anchor = await chrome.tabs.getCurrent();
      const ids = [];
      for (const label of ['self', 'claimed', 'pending']) {
        ids.push((await chrome.tabs.create({
          active: false,
          url: values[label],
          windowId: anchor.windowId
        })).id);
      }
      const keeper = await chrome.tabs.create({
        active: true,
        url: values.keeper,
        windowId: anchor.windowId
      });
      return {ids, keeperId: keeper.id};
    }, urls);
    const {ids, keeperId} = created;
    await waitFor(() => Object.values(fixture.counts()).length === 3 &&
      Object.values(fixture.counts()).every(count => count === 1), 'initial fixture loads');
    await driver.evaluate(async tabIds => {
      for (const id of tabIds) await chrome.tabs.discard(id);
    }, ids);
    await waitFor(async () => (await liveFixtureTabs(driver)).every(tab => tab.discarded === true),
      'baseline physical sleepers');

    await driver.evaluate(async tabIds => {
      await chrome.storage.local.set({
        'lifecycle-feedback': false,
        period: 777,
        prepends: '💤',
        'upgrade-canary': 'preserved'
      });
      await chrome.storage.session.clear();
      const now = Date.now();
      await chrome.storage.session.set({
        __discardOwnership: {
          [tabIds[0]]: {attemptId: 'legacy-self', source: 'self', state: 'owned', updatedAt: now},
          [tabIds[1]]: {attemptId: null, source: 'claimed', state: 'owned', updatedAt: now},
          [tabIds[2]]: {attemptId: 'legacy-pending', state: 'pending', updatedAt: now}
        }
      });
    }, ids);
    record('baseline-seeded', {version: baselineVersion});

    overlayTree(source, live);
    driver = await reloadExtension(driver, context, extensionId, currentVersion, edge);
    await wakeWorker(driver);
    await waitFor(async () => Object.keys(await sessionSnapshot(driver)).length === 3,
      'post-update ownership reconciliation');
    const migrated = await sessionSnapshot(driver);
    assert.equal(Object.values(migrated).every(marker => marker.state === 'owned'), true);
    // Chromium clears storage.session when an unpacked extension is reloaded.
    // The current worker must therefore reconstruct only conservative claimed
    // ownership from the still-discarded live tabs; it must never guess self.
    assert.equal(Object.values(migrated).filter(marker => marker.source === 'self').length, 0);
    assert.equal(Object.values(migrated).filter(marker => marker.source === 'claimed').length, 3);
    const preferences = await driver.evaluate(() => chrome.storage.local.get([
      'period', 'prepends', 'upgrade-canary', 'lifecycle-feedback'
    ]));
    assert.deepEqual(preferences, {
      'lifecycle-feedback': false,
      period: 777,
      prepends: '💤',
      'upgrade-canary': 'preserved'
    });
    await sleep(1000);
    assert.deepEqual(fixture.counts(), {claimed: 1, pending: 1, self: 1});
    record('updated-and-reconciled', {claims: 3, self: 0, version: currentVersion});

    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Target.setDiscoverTargets', {discover: true});
    await wakeWorker(driver);
    const target = await findWorkerTarget(cdp, extensionId);
    const closed = await cdp.send('Target.closeTarget', {targetId: target.targetId});
    assert.equal(closed.success, true);
    await waitFor(async () => !(await workerTarget(cdp, extensionId)), 'worker termination');
    const wake = await openDriver(context, extensionId);
    const wakeResponse = await wakeWorker(wake);
    assert.ok(wakeResponse && typeof wakeResponse === 'object');
    await sleep(1000);
    assert.deepEqual(fixture.counts(), {claimed: 1, pending: 1, self: 1});
    record('worker-restarted', {version: await extensionVersion(wake)});

    await wake.evaluate(id => chrome.tabs.update(id, {active: true}), keeperId);
    await waitFor(async () => (await liveFixtureTabs(wake)).every(tab => tab.active === false),
      'inactive sleepers before browser restart');
    await bounded(cdp.send('Browser.close'), 5000);
    const firstExit = await terminate(child);
    emergencyChild = undefined;
    launched = await launch({controller: controller.directory, edge, executable, extension: live, profile});
    ({browser, child, context} = launched);
    const browserVersion = browser.version();
    const restartDriver = await openDriver(context, extensionId);
    assert.equal(await extensionVersion(restartDriver), currentVersion);
    await wakeWorker(restartDriver);
    const restored = await waitFor(async () => {
      const tabs = await liveFixtureTabs(restartDriver);
      const counts = fixture.counts();
      const ownership = await sessionSnapshot(restartDriver);
      if (tabs.length !== 3 || tabs.some(tab => tab.active === true) ||
          labels.some(label => !Number.isInteger(counts[label]) || counts[label] < 1 || counts[label] > 2)) {
        return false;
      }
      const settled = tabs.every(tab => {
        const marker = ownership[tab.id];
        return counts[tab.label] === 1 ?
          tab.discarded === true && marker?.source === 'claimed' :
          tab.discarded === false && tab.status === 'complete' && marker === undefined;
      });
      return settled ? {counts, ownership, tabs} : false;
    }, 'bounded browser session restore');
    const stableRestartCounts = structuredClone(restored.counts);
    await sleep(3000);
    assert.deepEqual(fixture.counts(), stableRestartCounts);
    const restartStates = Object.fromEntries(restored.tabs.map(tab => [tab.label, {
      discarded: tab.discarded,
      status: tab.status
    }]));
    record('browser-restarted', {
      browserRestoreRequests: Object.values(restored.counts)
        .reduce((total, count) => total + count - 1, 0),
      firstExit,
      freshClaims: Object.keys(restored.ownership).length,
      version: await extensionVersion(restartDriver)
    });

    overlayTree(baseline, live);
    const rollbackDriver = await reloadExtension(
      restartDriver, context, extensionId, baselineVersion, edge
    );
    await sleep(3000);
    assert.deepEqual(fixture.counts(), stableRestartCounts);
    const rolledBackPreferences = await rollbackDriver.evaluate(() => chrome.storage.local.get([
      'period', 'prepends', 'upgrade-canary', 'lifecycle-feedback'
    ]));
    assert.deepEqual(rolledBackPreferences, preferences);
    const rollbackStates = Object.fromEntries((await liveFixtureTabs(rollbackDriver)).map(tab => [
      tab.label,
      {discarded: tab.discarded, status: tab.status}
    ]));
    assert.deepEqual(rollbackStates, restartStates);
    record('rolled-back', {version: await extensionVersion(rollbackDriver)});

    const finalCdp = await browser.newBrowserCDPSession();
    await bounded(finalCdp.send('Browser.close'), 5000);
    const finalExit = await terminate(child);
    emergencyChild = undefined;
    await fixture.stop();
    fs.rmSync(root, {force: true, maxRetries: 4, recursive: true, retryDelay: 250});
    assert.equal(fs.existsSync(root), false);
    report = {
      baselineVersion,
      baselineTreeSha256,
      browserFamily: edge ? 'edge' : 'chrome',
      browserVersion,
      currentTreeSha256,
      currentVersion,
      finalExit,
      outcome: 'passed',
      phases,
      profileRemoved: true,
      requestTotals: fixture.counts()
    };
  }
  catch (error) {
    failure = error;
    if (launched?.browser) await bounded(launched.browser.close(), 3000);
    if (launched?.child) await terminate(launched.child).catch(() => {});
    emergencyChild = undefined;
    await fixture.stop().catch(() => {});
    try { fs.rmSync(root, {force: true, maxRetries: 4, recursive: true, retryDelay: 250}); }
    catch (cleanupError) { error.message += `; cleanup failed: ${cleanupError.message}`; }
    report = {
      baselineVersion,
      baselineTreeSha256,
      browserFamily: edge ? 'edge' : 'chrome',
      currentTreeSha256,
      currentVersion,
      error: safeMessage(error),
      outcome: 'failed',
      phases,
      profileRemoved: !fs.existsSync(root),
      requestTotals: fixture.counts()
    };
  }
  finally {
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (failure) throw failure;
  process.stdout.write(`${JSON.stringify({outcome: report.outcome, report: path.basename(reportPath)})}\n`);
};

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
