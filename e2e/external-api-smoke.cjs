#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {chromium} = require('./playwright-runtime.cjs');

const SCRIPT_DIR = __dirname;
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_EXTENSION = path.join(WORKSPACE_ROOT, 'v3');
const DEFAULT_PROFILE_ROOT = path.join(SCRIPT_DIR, '.profiles');
const DEFAULT_RESULTS_ROOT = path.join(SCRIPT_DIR, 'results');
const RESULT_FILE = 'external-api-smoke.json';
const REQUEST_LIMIT = 25;

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const flag = name => process.argv.includes(`--${name}`);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const ensure = (condition, message) => {
  if (!condition) throw Error(message);
};
const waitFor = async (task, label, timeout = 20_000, interval = 50) => {
  const deadline = Date.now() + timeout;
  let last;
  let lastError;
  while (Date.now() < deadline) {
    try {
      last = await task();
      lastError = undefined;
      if (last) return last;
    }
    catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}${
    lastError ? `; error=${lastError.message}` : ''}`);
};
const bounded = async (operation, timeout = 5000) => {
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

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sensitivePaths = new Set([WORKSPACE_ROOT]);
const registerSensitivePath = value => {
  if (typeof value === 'string' && value) sensitivePaths.add(path.resolve(value));
  return value;
};
const safeMessage = value => [...sensitivePaths]
  .sort((left, right) => right.length - left.length)
  .reduce((message, sensitive) => message.replace(
    new RegExp(escapeRegExp(sensitive), 'gi'),
    sensitive === WORKSPACE_ROOT ? '<workspace>' : '<local-path>'
  ), String(value?.message || value || 'unknown failure'))
  .replace(/[A-Z]:[\\/]Users[\\/][^\\/\s]+/gi, '<user-path>')
  .replace(/\/(?:Users|home)\/[^/\s]+/gi, '<user-path>')
  .replace(/[A-Z]:[\\/][^"'\r\n]*?[\\/]external-api-smoke-[^\\/\s"']+/gi, '<isolated-run>')
  .replace(/\/(?:[^\s"']+\/)*external-api-smoke-[^/\s"']+/gi, '<isolated-run>')
  .replace(/(?:chrome|edge)-extension:\/\/[a-p]{32}/gi, 'extension://<redacted>')
  .replace(/\b[a-p]{32}\b/gi, '<extension-id>')
  .replace(/https?:\/\/127\.0\.0\.1:\d+\/external-api-smoke\/[^\s"')]+/gi, '<fixture-url>')
  .replace(/\b(?:https?|ws):\/\/(?:127\.0\.0\.1|localhost):\d+(?:\/[^\s"')\]]*)?/gi,
    '<loopback-url>')
  .replace(/\b(?:127\.0\.0\.1|localhost):\d+\b/gi, '<loopback-endpoint>')
  .replace(/("(?:id|tabId|windowId|browserContextId)"\s*:\s*)-?\d+/gi, '$1"<redacted>"')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
    '<token>');

const sanitize = value => {
  if (typeof value === 'string') return safeMessage(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
      /^(?:id|tabId|windowId|browserContextId)$/i.test(key) && Number.isInteger(entry) ?
        '<redacted>' : sanitize(entry)
    ]));
  }
  return value;
};

const hashTree = root => {
  const files = [];
  const visit = directory => fs.readdirSync(directory, {withFileTypes: true}).forEach(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(target);
    else if (entry.isFile()) files.push(target);
    else throw Error(`extension tree contains an unsupported entry: ${entry.name}`);
  });
  visit(root);
  const hash = crypto.createHash('sha256');
  files.sort((left, right) => Buffer.compare(Buffer.from(
    path.relative(root, left).replaceAll('\\', '/')
  ), Buffer.from(path.relative(root, right).replaceAll('\\', '/')))).forEach(file => {
    hash.update(path.relative(root, file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  });
  return hash.digest('hex');
};

const safeRunRoot = (profileRoot, runRoot) => {
  const root = path.resolve(profileRoot);
  const candidate = path.resolve(runRoot);
  return candidate.startsWith(root + path.sep) &&
    /^external-api-smoke-\d+-\d+-[0-9a-f]{8}$/.test(path.basename(candidate));
};

const createController = runRoot => {
  const directory = path.join(runRoot, 'controller');
  fs.mkdirSync(directory, {recursive: true});
  const {publicKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
  const der = publicKey.export({format: 'der', type: 'spki'});
  const key = der.toString('base64');
  const id = [...crypto.createHash('sha256').update(der).digest().subarray(0, 16)]
    .flatMap(byte => [byte >> 4, byte & 0x0f])
    .map(nibble => String.fromCharCode('a'.charCodeAt(0) + nibble))
    .join('');
  fs.writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify({
    background: {service_worker: 'worker.js'},
    incognito: 'spanning',
    key,
    manifest_version: 3,
    name: 'ATD isolated external API controller',
    permissions: ['management', 'tabs', 'windows'],
    version: '1.0.0'
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(directory, 'worker.js'),
    '// Isolated E2E controller. Keep discovery alive only in this temporary profile.\n' +
    'setInterval(() => {}, 1000);\n',
    'utf8');
  fs.writeFileSync(path.join(directory, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>ATD isolated external controller</title>\n', 'utf8');
  return {directory, id};
};

const fixtureServer = async token => {
  const requests = new Map();
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const prefix = `/external-api-smoke/${token}/`;
    if (!url.pathname.startsWith(prefix)) {
      response.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
      response.end('not found');
      return;
    }
    const label = url.pathname.slice(prefix.length);
    if (!['eligible', 'protected', 'active', 'incognito'].includes(label)) {
      response.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
      response.end('not found');
      return;
    }
    requests.set(label, (requests.get(label) || 0) + 1);
    response.writeHead(200, {
      'cache-control': 'no-store, no-cache, must-revalidate',
      'content-type': 'text/html; charset=utf-8',
      expires: '0',
      pragma: 'no-cache'
    });
    response.end(`<!doctype html><meta charset="utf-8"><title>external ${label}</title>
      <body>${label}</body><script>
        sessionStorage.externalApiLoads = String(Number(sessionStorage.externalApiLoads || 0) + 1);
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
  const {port} = server.address();
  return {
    counts: () => Object.fromEntries(['active', 'eligible', 'incognito', 'protected']
      .map(label => [label, requests.get(label) || 0])),
    stop: () => new Promise((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      server.close(error => error ? reject(error) : resolve());
    }),
    urls: Object.fromEntries(['active', 'eligible', 'incognito', 'protected'].map(label => [
      label,
      `http://127.0.0.1:${port}/external-api-smoke/${token}/${label}`
    ]))
  };
};

const taskkill = process.platform === 'win32' ?
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe') : undefined;
const childExitState = child => child && (child.exitCode !== null || child.signalCode !== null) ? {
  code: child.exitCode,
  signal: child.signalCode
} : null;
const waitExit = (child, timeout = 5000) => childExitState(child) ? Promise.resolve(true) :
  Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    sleep(timeout).then(() => false)
  ]);
const killTree = child => {
  if (!child || childExitState(child) || !Number.isInteger(child.pid)) return {issued: false};
  if (process.platform === 'win32' && fs.existsSync(taskkill)) {
    const result = spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true
    });
    return {issued: result.status === 0, status: result.status};
  }
  return {issued: child.kill('SIGKILL')};
};
const assertExactChildExit = (exit, forced, platform = process.platform) => {
  ensure(exit, 'the exact Chrome child did not exit');
  if (!forced) {
    ensure(exit.code === 0 && exit.signal === null,
      `the exact Chrome child did not exit gracefully (${exit.code ?? exit.signal})`);
  }
  else if (platform === 'win32') {
    ensure(!(exit.code === 0 && exit.signal === null),
      'the forced Chrome child unexpectedly reported a graceful exit');
  }
  else {
    ensure(exit.signal !== null || exit.code !== 0,
      'the forced Chrome child unexpectedly reported a graceful exit');
  }
};
const terminateBrowser = async child => {
  const graceful = await waitExit(child, 5000);
  const forcedResult = graceful ? {issued: false} : killTree(child);
  if (!graceful) ensure(forcedResult.issued, 'the exact Chrome process-tree kill was not issued');
  const exited = graceful || await waitExit(child, 5000);
  ensure(exited, 'the exact Chrome child did not exit after cleanup');
  const exit = childExitState(child);
  assertExactChildExit(exit, !graceful);
  return {
    exit,
    exitAsserted: true,
    exited: true,
    forced: !graceful,
    forceRequestStatus: forcedResult.status ?? null,
    graceful
  };
};

let emergencyChild;
let emergencyHandlersInstalled = false;
let emergencyRoot;
let emergencyProfileRoot;
const emergencyCleanup = () => {
  try {
    killTree(emergencyChild);
  }
  catch (error) {}
  try {
    if (emergencyRoot && safeRunRoot(emergencyProfileRoot, emergencyRoot)) {
      fs.rmSync(emergencyRoot, {force: true, maxRetries: 4, recursive: true, retryDelay: 250});
    }
  }
  catch (error) {}
};
const installEmergencyHandlers = () => {
  if (emergencyHandlersInstalled) return;
  emergencyHandlersInstalled = true;
  process.once('exit', emergencyCleanup);
  process.once('SIGINT', () => {
    emergencyCleanup();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    emergencyCleanup();
    process.exit(143);
  });
};

const launchChrome = async ({controller, executable, extension, headed, profile}) => {
  const extensions = [extension, controller].join(',');
  const child = spawn(executable, [
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extensions}`,
    `--load-extension=${extensions}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-component-update',
    '--disable-background-mode',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-features=OptimizationHints,MediaRouter',
    '--window-size=1100,800',
    ...(headed ? [] : ['--headless=new']),
    'about:blank'
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: !headed
  });
  emergencyChild = child;
  let spawnError;
  let stderr = '';
  child.once('error', error => spawnError = error);
  child.stderr.on('data', chunk => stderr = (stderr + String(chunk)).slice(-64 * 1024));
  try {
    const port = await waitFor(() => {
      if (spawnError) throw spawnError;
      if (childExitState(child)) throw Error(`Chrome exited before CDP (${child.exitCode ?? child.signalCode})`);
      const file = path.join(profile, 'DevToolsActivePort');
      if (!fs.existsSync(file)) return false;
      return Number(fs.readFileSync(file, 'utf8').trim().split(/\r?\n/, 1)[0]) || false;
    }, 'the isolated Chrome DevTools endpoint');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    ensure(context, 'Chrome did not expose its isolated default context');
    return {browser, child, context};
  }
  catch (error) {
    error.message = `${error.message}; startup diagnostic=${safeMessage(stderr).slice(0, 500)}`;
    await terminateBrowser(child).catch(cleanupError => {
      error.message += `; startup cleanup failed=${safeMessage(cleanupError)}`;
    });
    throw error;
  }
};

const discoverTargetId = (controllerPage, expectedVersion) => controllerPage.evaluate(
  async version => {
    const extensions = await chrome.management.getAll();
    const candidates = extensions.filter(info => info.id !== chrome.runtime.id &&
      info.enabled === true && info.installType === 'development' &&
      info.type === 'extension' && info.version === version);
    return {
      candidates: candidates.map(info => info.id),
      controllerId: chrome.runtime.id
    };
  },
  expectedVersion
);

const openExtensionDriver = async (context, extensionId, relative, label) => {
  let page = await context.newPage();
  let lastNavigationError;
  try {
    await waitFor(async () => {
      try {
        if (page.isClosed()) page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/${relative.replace(/^\/+/, '')}`, {
          waitUntil: 'domcontentloaded'
        });
        return page.evaluate(id => globalThis.chrome?.runtime?.id === id, extensionId);
      }
      catch (error) {
        lastNavigationError = error;
        return false;
      }
    }, label);
    return page;
  }
  catch (error) {
    await page.close().catch(() => {});
    if (lastNavigationError) {
      error.message += `; navigation=${safeMessage(lastNavigationError)}`;
    }
    throw error;
  }
};

const openTargetDriver = async (context, targetId, manifest) => {
  const relative = manifest.options_ui?.page || manifest.action?.default_popup;
  ensure(typeof relative === 'string' && relative,
    'The target artifact has no internal driver page');
  const page = await openExtensionDriver(
    context,
    targetId,
    relative,
    'the target artifact driver page'
  );
  ensure(await page.evaluate(() => Boolean(
    globalThis.chrome?.runtime?.id && chrome.tabs && chrome.storage
  )),
    'The target artifact driver page did not expose extension APIs');
  return page;
};

const allowTargetInIncognito = async (context, targetId) => {
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions/');
    await page.evaluate(id => chrome.developerPrivate.updateExtensionConfiguration({
      extensionId: id,
      incognitoAccess: true
    }), targetId);
    return true;
  }
  finally {
    await page.close().catch(() => {});
  }
};

const configureTarget = worker => worker.evaluate(async () => {
  await chrome.storage.local.set({
    audio: false,
    'external.trusted-ids': [],
    favicon: false,
    form: false,
    number: 1000000,
    paused: false,
    period: 86400,
    pinned: false,
    prepends: 'zzz '
  });
  await chrome.storage.session.clear();
  return true;
});

const createRegularFixtures = (controllerPage, urls) => controllerPage.evaluate(async fixtureUrls => {
  const create = options => new Promise((resolve, reject) => chrome.tabs.create(options, tab => {
    const error = chrome.runtime.lastError;
    error ? reject(Error(error.message)) : resolve(tab);
  }));
  const update = (id, options) => new Promise((resolve, reject) => chrome.tabs.update(id, options, tab => {
    const error = chrome.runtime.lastError;
    error ? reject(Error(error.message)) : resolve(tab);
  }));
  const eligible = await create({active: false, url: fixtureUrls.eligible});
  const protectedTab = await create({active: false, url: fixtureUrls.protected});
  await update(protectedTab.id, {autoDiscardable: false});
  const active = await create({active: true, url: fixtureUrls.active});
  return {active: active.id, eligible: eligible.id, protected: protectedTab.id};
}, urls);

const snapshot = (worker, urls) => worker.evaluate(async fixtureUrls => {
  const tabs = await chrome.tabs.query({});
  const session = await chrome.storage.session.get(null);
  const output = {};
  for (const [label, url] of Object.entries(fixtureUrls)) {
    const tab = tabs.find(candidate => candidate.url === url || candidate.pendingUrl === url);
    if (!tab) {
      output[label] = {found: false};
      continue;
    }
    const marker = session[`__discardOwnership:tab:${tab.id}`]?.marker;
    output[label] = {
      active: tab.active === true,
      autoDiscardable: tab.autoDiscardable !== false,
      discarded: tab.discarded === true,
      found: true,
      frozen: tab.frozen === true,
      incognito: tab.incognito === true,
      owner: marker?.source || null,
      ownerState: marker?.state || null,
      status: tab.status || null,
      titleMarked: typeof tab.title === 'string' && tab.title.startsWith('zzz ')
    };
  }
  return output;
}, urls);

const installMonitor = (worker, urls) => worker.evaluate(async fixtureUrls => {
  const existing = globalThis.__externalApiSmoke;
  if (existing?.installed) {
    existing.events.length = 0;
    return true;
  }
  const state = globalThis.__externalApiSmoke = {
    events: [],
    idToLabel: {},
    installed: true
  };
  const identify = tab => {
    const url = tab?.url || tab?.pendingUrl;
    return Object.entries(fixtureUrls).find(([, value]) => value === url)?.[0];
  };
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs || []) {
    const label = identify(tab);
    if (label) state.idToLabel[tab.id] = label;
  }
  chrome.tabs.onUpdated.addListener((id, changeInfo, tab) => {
    const label = state.idToLabel[id] || identify(tab);
    if (!label) return;
    state.idToLabel[id] = label;
    state.events.push({
      change: Object.fromEntries(['discarded', 'frozen', 'status']
        .filter(key => Object.prototype.hasOwnProperty.call(changeInfo, key))
        .map(key => [key, changeInfo[key]])),
      event: 'updated',
      label
    });
  });
  chrome.tabs.onActivated.addListener(info => {
    const label = state.idToLabel[info.tabId];
    if (label) state.events.push({event: 'activated', label});
  });
  chrome.tabs.onRemoved.addListener(id => {
    const label = state.idToLabel[id];
    if (label) state.events.push({event: 'removed', label});
    delete state.idToLabel[id];
  });
  chrome.tabs.onReplaced.addListener((addedId, removedId) => {
    const label = state.idToLabel[removedId];
    if (!label) return;
    delete state.idToLabel[removedId];
    state.idToLabel[addedId] = label;
    state.events.push({event: 'replaced', label});
  });
  return true;
}, urls);

const monitorCheckpoint = worker => worker.evaluate(() => globalThis.__externalApiSmoke?.events.length || 0);
const monitorSince = (worker, checkpoint) => worker.evaluate(index =>
  (globalThis.__externalApiSmoke?.events || []).slice(index), checkpoint);

const sendExternal = (controllerPage, targetId, request) => controllerPage.evaluate(
  ({id, payload}) => new Promise(resolve => chrome.runtime.sendMessage(id, payload, response => {
    const error = chrome.runtime.lastError;
    resolve({lastError: error?.message || null, response});
  })),
  {id: targetId, payload: request}
);

const exactResponseSummary = (response, labels) => ({
  errorCode: response?.error?.code || null,
  ok: response?.ok === true,
  outcomes: Array.isArray(response?.outcomes) ? response.outcomes.map((outcome, index) => ({
    code: outcome.code,
    label: labels[index],
    status: outcome.status
  })) : [],
  summary: response?.summary || null
});

const findCrashCount = root => {
  let count = 0;
  const visit = directory => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.(?:dmp|crash)$/i.test(entry.name)) count += 1;
    }
  };
  visit(root);
  return count;
};

const run = async () => {
  installEmergencyHandlers();
  const resultsRoot = registerSensitivePath(path.resolve(option('results', DEFAULT_RESULTS_ROOT)));
  fs.mkdirSync(resultsRoot, {recursive: true});
  const reportPath = path.join(resultsRoot, RESULT_FILE);
  const report = {
    browser: {family: 'chrome', version: null},
    cleanup: {
      browser: null,
      crashArtifacts: null,
      crashFree: null,
      fixtureStopped: false,
      incognitoDisposed: false,
      profileRemoved: false
    },
    extension: {treeSha256: null, version: null},
    failures: [],
    fixture: {requestCounts: null},
    outcome: 'failed',
    scenarios: [],
    schemaVersion: 1,
    test: 'external-api-smoke'
  };
  const writeReport = () => fs.writeFileSync(reportPath,
    `${JSON.stringify(sanitize(report), null, 2)}\n`, 'utf8');
  const recordFailure = (stage, error) => report.failures.push({
    message: safeMessage(error),
    name: String(error?.name || 'Error'),
    stage
  });

  let browserCdp;
  let browserContextId;
  let controllerPage;
  let fixture;
  let launched;
  let primaryError;
  let profileRoot;
  let runRoot;
  let targetDriver;
  const cleanupErrors = [];

  try {
    const executable = registerSensitivePath(path.resolve(option('executable', '')));
    const extension = registerSensitivePath(path.resolve(option('extension', DEFAULT_EXTENSION)));
    profileRoot = registerSensitivePath(path.resolve(option('profile-root', DEFAULT_PROFILE_ROOT)));
    ensure(option('executable'), 'Pass --executable with a Chrome-for-Testing executable');
    ensure(fs.existsSync(executable), 'The Chrome-for-Testing executable does not exist');
    ensure(!/msedge/i.test(path.basename(executable)), 'This harness refuses Microsoft Edge');
    ensure(/^(?:chrome|chromium|chromium-browser)(?:\.exe)?$/i.test(path.basename(executable)),
      'Use a Chrome-for-Testing or Chromium executable');
    ensure(fs.existsSync(path.join(extension, 'manifest.json')), 'The unpacked target extension does not exist');
    const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
    ensure(manifest.manifest_version === 3 && manifest.background?.service_worker,
      'The target extension is not a Manifest V3 worker artifact');
    report.extension = {treeSha256: hashTree(extension), version: manifest.version};

    fs.mkdirSync(profileRoot, {recursive: true});
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    runRoot = registerSensitivePath(path.join(
      profileRoot,
      `external-api-smoke-${Date.now()}-${process.pid}-${suffix}`
    ));
    ensure(safeRunRoot(profileRoot, runRoot), 'The generated isolated run escaped its profile root');
    const profile = path.join(runRoot, 'profile');
    fs.mkdirSync(profile, {recursive: true});
    const controller = createController(runRoot);
    emergencyRoot = runRoot;
    emergencyProfileRoot = profileRoot;

    fixture = await fixtureServer(crypto.randomUUID());
    launched = await launchChrome({
      controller: controller.directory,
      executable,
      extension,
      headed: flag('headed'),
      profile
    });
    report.browser.version = launched.browser.version();
    controllerPage = await openExtensionDriver(
      launched.context,
      controller.id,
      'index.html',
      'the generated controller extension page'
    );
    ensure(await controllerPage.evaluate(() => Boolean(
      globalThis.chrome?.management && chrome.tabs
    )),
      'The generated controller did not expose its declared browser APIs');
    const discovery = await waitFor(async () => {
      const value = await discoverTargetId(controllerPage, manifest.version);
      return value.candidates.length === 1 ? value : false;
    }, 'exactly one unpacked target artifact');
    ensure(discovery.controllerId === controller.id,
      'The generated controller key did not produce its computed identity');
    ensure(discovery.candidates.length === 1 && /^[a-p]{32}$/.test(discovery.candidates[0]),
      'The isolated controller did not discover exactly one target artifact');
    const controllerId = controller.id;
    const [targetId] = discovery.candidates;
    ensure(controllerId !== targetId, 'The two isolated extension identities were not distinct');

    await allowTargetInIncognito(launched.context, targetId);
    const targetAfterIncognito = await waitFor(() => controllerPage.evaluate(
      id => new Promise((resolve, reject) => {
        chrome.management.get(id, info => {
          const error = chrome.runtime.lastError;
          error ? reject(Error(error.message)) : resolve({
            enabled: info.enabled,
            installType: info.installType,
            version: info.version
          });
        });
      }), targetId).then(info => info.enabled === true && info.installType === 'development' &&
        info.version === manifest.version ? info : false),
    'the target artifact to re-enable after its incognito permission changed');
    targetDriver = await openTargetDriver(launched.context, targetId, manifest);
    await configureTarget(targetDriver);
    const regularIds = await createRegularFixtures(controllerPage, fixture.urls);
    browserCdp = await launched.browser.newBrowserCDPSession();
    ({browserContextId} = await browserCdp.send('Target.createBrowserContext', {disposeOnDetach: false}));
    ensure(typeof browserContextId === 'string' && browserContextId,
      'Chrome did not create the isolated incognito browser context');
    await browserCdp.send('Target.createTarget', {
      browserContextId,
      url: 'about:blank'
    });
    await browserCdp.send('Target.createTarget', {
      background: true,
      browserContextId,
      url: fixture.urls.incognito
    });
    await waitFor(() => Object.values(fixture.counts()).every(count => count === 1),
      'one initial request for every fixture');

    const incognitoId = await waitFor(async () => targetDriver.evaluate(async url => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find(candidate => candidate.incognito === true &&
        (candidate.url === url || candidate.pendingUrl === url));
      return tab?.active === false ? tab.id : false;
    }, fixture.urls.incognito), 'an inactive target-visible incognito fixture tab');
    const ids = {...regularIds, incognito: incognitoId};
    await waitFor(async () => {
      const states = await snapshot(targetDriver, fixture.urls);
      return Object.values(states).every(state => state.found && state.status === 'complete') &&
        states.active.active === true && states.eligible.active === false &&
        states.protected.autoDiscardable === false && states.incognito.incognito === true &&
        states.incognito.active === false;
    }, 'stable fixture tab states');
    await installMonitor(targetDriver, fixture.urls);
    await sleep(500);
    await installMonitor(targetDriver, fixture.urls);

    const assertZeroMutation = async (name, request, expectedCode) => {
      const before = await snapshot(targetDriver, fixture.urls);
      const requestsBefore = fixture.counts();
      const checkpoint = await monitorCheckpoint(targetDriver);
      const delivery = await sendExternal(controllerPage, targetId, request);
      ensure(!delivery.lastError, `${name} external delivery failed: ${delivery.lastError}`);
      assert.deepEqual(delivery.response, {error: {code: expectedCode}, ok: false}, name);
      await sleep(250);
      const after = await snapshot(targetDriver, fixture.urls);
      const events = await monitorSince(targetDriver, checkpoint);
      assert.deepEqual(after, before, `${name} changed tab state`);
      assert.deepEqual(fixture.counts(), requestsBefore, `${name} caused a document request`);
      assert.deepEqual(events, [], `${name} emitted a fixture tab lifecycle event`);
      report.scenarios.push({
        name,
        outcome: 'passed',
        response: exactResponseSummary(delivery.response, []),
        zeroMutation: true
      });
    };

    const excess = Array.from({length: REQUEST_LIMIT + 1}, (_, index) => 1_000_000 + index);
    await assertZeroMutation('default-denied-hostile-query', {
      forced: true,
      method: 'discard',
      query: {active: false, url: '<all_urls>'},
      tabIds: [ids.eligible]
    }, 'UNAUTHORIZED');
    await assertZeroMutation('default-denied-malformed', {method: 'discard', tabIds: ['invalid']},
      'UNAUTHORIZED');
    await assertZeroMutation('default-denied-excess-batch', {method: 'discard', tabIds: excess},
      'UNAUTHORIZED');
    await assertZeroMutation('default-denied-active-tab', {method: 'discard', tabIds: [ids.active]},
      'UNAUTHORIZED');
    await assertZeroMutation('default-denied-incognito-tab', {
      method: 'discard', tabIds: [ids.incognito]
    }, 'UNAUTHORIZED');

    await targetDriver.evaluate(async id => chrome.storage.local.set({'external.trusted-ids': [id]}), controllerId);
    ensure(await targetDriver.evaluate(async id =>
      (await chrome.storage.local.get('external.trusted-ids'))['external.trusted-ids']?.[0] === id,
    controllerId), 'The controller allowlist did not persist');
    await assertZeroMutation('allowlisted-hostile-query-rejected', {
      forced: true,
      method: 'discard',
      query: {active: false, url: '<all_urls>'},
      tabIds: [ids.eligible]
    }, 'INVALID_SCHEMA');
    await assertZeroMutation('allowlisted-malformed-rejected', {method: 'discard', tabIds: ['invalid']},
      'INVALID_TAB_IDS');
    await assertZeroMutation('allowlisted-excess-batch-rejected', {method: 'discard', tabIds: excess},
      'INVALID_TAB_IDS');

    const labels = ['eligible', 'protected', 'active', 'incognito'];
    const requestedIds = labels.map(label => ids[label]);
    const requestsBefore = fixture.counts();
    const delivery = await sendExternal(controllerPage, targetId, {
      method: 'discard',
      tabIds: requestedIds
    });
    ensure(!delivery.lastError, `authorized external delivery failed: ${delivery.lastError}`);
    assert.deepEqual(delivery.response, {
      ok: true,
      outcomes: [
        {code: 'DISCARDED', status: 'succeeded', tabId: ids.eligible},
        {code: 'NOT_ELIGIBLE', status: 'skipped', tabId: ids.protected},
        {code: 'NOT_ELIGIBLE', status: 'skipped', tabId: ids.active},
        {code: 'NOT_ELIGIBLE', status: 'skipped', tabId: ids.incognito}
      ],
      summary: {failed: 0, skipped: 3, succeeded: 1, total: 4}
    });
    assert.deepEqual(Object.keys(delivery.response).sort(), ['ok', 'outcomes', 'summary']);
    for (const outcome of delivery.response.outcomes) {
      assert.deepEqual(Object.keys(outcome).sort(), ['code', 'status', 'tabId']);
    }
    ensure(!/https?:|external (?:eligible|protected|active|incognito)|[a-p]{32}/i.test(
      JSON.stringify(delivery.response)
    ), 'The external response reflected sensitive tab or extension data');
    const finalState = await waitFor(async () => {
      const states = await snapshot(targetDriver, fixture.urls);
      return states.eligible.discarded === true && states.eligible.active === false ? states : false;
    }, 'the one authorized eligible discard');
    assert.deepEqual(fixture.counts(), requestsBefore,
      'The authorized safe batch caused a document reload');
    assert.equal(finalState.eligible.owner, 'self');
    assert.equal(finalState.eligible.ownerState, 'owned');
    assert.equal(finalState.eligible.status, 'unloaded');
    assert.equal(finalState.eligible.titleMarked, true);
    assert.equal(finalState.protected.discarded, false);
    assert.equal(finalState.protected.autoDiscardable, false);
    assert.equal(finalState.active.discarded, false);
    assert.equal(finalState.active.active, true);
    assert.equal(finalState.incognito.discarded, false);
    assert.equal(finalState.incognito.incognito, true);
    report.scenarios.push({
      exactOutcomes: true,
      name: 'allowlisted-safe-bounded-discard',
      outcome: 'passed',
      ownedByTarget: true,
      response: exactResponseSummary(delivery.response, labels),
      sanitized: true,
      skippedActive: true,
      skippedIncognito: true,
      skippedProtected: true,
      succeededEligible: true,
      titleMarker: true,
      unloaded: true,
      zeroDocumentReloads: true
    });

    report.fixture.requestCounts = fixture.counts();
  }
  catch (error) {
    primaryError = error;
    recordFailure('external API smoke', error);
  }
  finally {
    if (browserCdp && browserContextId) {
      try {
        await browserCdp.send('Target.disposeBrowserContext', {browserContextId});
        report.cleanup.incognitoDisposed = true;
      }
      catch (error) {
        cleanupErrors.push(error);
        recordFailure('incognito context cleanup', error);
      }
    }
    if (fixture) {
      report.fixture.requestCounts = fixture.counts();
      try {
        await fixture.stop();
        report.cleanup.fixtureStopped = true;
      }
      catch (error) {
        cleanupErrors.push(error);
        recordFailure('fixture cleanup', error);
      }
    }
    if (launched) {
      try {
        report.cleanup.browserClose = await bounded(launched.browser.close(), 5000);
        report.cleanup.browser = await terminateBrowser(launched.child);
      }
      catch (error) {
        cleanupErrors.push(error);
        recordFailure('exact browser cleanup', error);
      }
    }
    if (runRoot) {
      try {
        const crashes = findCrashCount(runRoot);
        report.cleanup.crashArtifacts = crashes;
        report.cleanup.crashFree = crashes === 0;
        ensure(crashes === 0, 'Chrome produced a crash artifact during the external API smoke');
      }
      catch (error) {
        cleanupErrors.push(error);
        recordFailure('crash artifact assertion', error);
      }
      try {
        ensure(safeRunRoot(profileRoot, runRoot),
          'Refusing to delete outside the isolated external API profile root');
        fs.rmSync(runRoot, {force: true, maxRetries: 4, recursive: true, retryDelay: 250});
        ensure(!fs.existsSync(runRoot), 'The isolated external API run root was not removed');
        report.cleanup.profileRemoved = true;
      }
      catch (error) {
        cleanupErrors.push(error);
        recordFailure('isolated profile removal', error);
      }
    }
    emergencyChild = undefined;
    emergencyRoot = undefined;
    emergencyProfileRoot = undefined;
    const allErrors = [...(primaryError ? [primaryError] : []), ...cleanupErrors];
    if (cleanupErrors.length) {
      primaryError = new AggregateError(allErrors,
        `${primaryError?.message || 'external API smoke cleanup failed'}; cleanup: ${
          cleanupErrors.map(safeMessage).join('; ')}`);
    }
    report.outcome = primaryError ? 'failed' : 'passed';
    if (primaryError) report.error = safeMessage(primaryError);
    try {
      writeReport();
    }
    catch (error) {
      primaryError = primaryError ? new AggregateError([primaryError, error],
        `${primaryError.message}; sanitized report write failed`) : error;
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
    console.log(`External API smoke passed: default deny, strict allowlist/schema, one safe discard, exact cleanup; sanitized result: ${safeMessage(reportPath)}`);
  }, error => {
    console.error(`External API smoke failed: ${safeMessage(error)}`);
    if (error.reportPath) console.error(`Sanitized result: ${safeMessage(error.reportPath)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertExactChildExit,
  exactResponseSummary,
  safeMessage,
  safeRunRoot,
  sanitize
};
