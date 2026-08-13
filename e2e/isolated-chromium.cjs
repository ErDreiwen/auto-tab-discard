const crypto = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {chromium} = require('./playwright-runtime.cjs');

const taskkillPath = process.platform === 'win32' ?
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe') : undefined;
let emergencyBrowserProcess;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const waitFor = async (task, label, timeout = 20_000, interval = 50) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await task();
      if (value) return value;
    }
    catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  const error = Error(`Timed out waiting for ${label}`);
  if (lastError) error.cause = lastError;
  throw error;
};

const killProcessTree = child => {
  if (!child || child.exitCode !== null || !Number.isInteger(child.pid)) return {needed: false};
  if (process.platform === 'win32' && fs.existsSync(taskkillPath)) {
    const outcome = spawnSync(taskkillPath, ['/PID', String(child.pid), '/T', '/F'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true
    });
    return {needed: true, status: outcome.status};
  }
  return {needed: true, signal: child.kill('SIGKILL')};
};

const waitForProcessExit = (child, timeout = 5_000) => {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    sleep(timeout).then(() => false)
  ]);
};

const terminateBrowserProcess = async child => {
  const graceful = await waitForProcessExit(child, 2_000);
  const forced = graceful ? {needed: false} : killProcessTree(child);
  const exited = graceful || await waitForProcessExit(child, 5_000);
  if (emergencyBrowserProcess === child) emergencyBrowserProcess = undefined;
  return {exited, forced, graceful};
};

const emergencyCleanup = () => {
  if (emergencyBrowserProcess?.exitCode === null) killProcessTree(emergencyBrowserProcess);
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

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};

const walkFiles = root => {
  const files = [];
  const walk = (directory, relative = '') => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})
      .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute, childRelative);
      else if (entry.isFile()) files.push({absolute, relative: childRelative});
    }
  };
  walk(root);
  return files;
};

const hashDirectory = root => {
  const hash = crypto.createHash('sha256');
  const files = walkFiles(root).sort((a, b) =>
    Buffer.compare(Buffer.from(a.relative), Buffer.from(b.relative)));
  for (const file of files) {
    const bytes = fs.readFileSync(file.absolute);
    hash.update(Buffer.from(file.relative, 'utf8'));
    hash.update(Buffer.from([0]));
    hash.update(bytes);
    hash.update(Buffer.from([0]));
  }
  return hash.digest('hex');
};

const crashCount = root => {
  if (!fs.existsSync(root)) return 0;
  let count = 0;
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (/\.(?:dmp|mdmp)$/i.test(entry.name)) count += 1;
    }
  };
  walk(root);
  return count;
};

const assertSafeProfile = (profileRoot, profile, prefix) => {
  const root = path.resolve(profileRoot);
  const target = path.resolve(profile);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) ||
      !path.basename(target).startsWith(prefix)) {
    throw Error(`Refusing unsafe isolated-profile operation: ${target}`);
  }
};

const launchIsolated = async ({
  executablePath,
  extensionPath,
  profile,
  profileRoot,
  profilePrefix,
  headless = false
}) => {
  assertSafeProfile(profileRoot, profile, profilePrefix);
  fs.mkdirSync(profile, {recursive: true});
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--disable-background-mode',
    '--disable-component-update',
    '--disable-gpu',
    '--disable-sync',
    '--disable-features=OptimizationHints,MediaRouter',
    '--no-default-browser-check',
    '--no-first-run',
    '--window-position=40,40',
    '--window-size=1200,800',
    ...(headless ? ['--headless=new'] : []),
    'about:blank'
  ];
  const browserProcess = spawn(executablePath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: false
  });
  emergencyBrowserProcess = browserProcess;
  let browser;
  let stderr = '';
  let spawnError;
  browserProcess.once('error', error => spawnError = error);
  browserProcess.stderr.on('data', chunk => stderr = (stderr + chunk).slice(-128 * 1024));
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    const port = await waitFor(() => {
      if (spawnError) throw spawnError;
      if (browserProcess.exitCode !== null) {
        throw Error(`browser exited before CDP was ready (${browserProcess.exitCode}): ${stderr}`);
      }
      if (!fs.existsSync(portFile)) return false;
      return Number(fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0]) || false;
    }, 'browser DevTools port');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (!context) throw Error('CDP browser did not expose its default context');
    const worker = await waitFor(async () => context.serviceWorkers()
      .find(candidate => candidate.url().endsWith('/worker/core.mjs')),
    'extension service worker');
    const extensionId = new URL(worker.url()).host;
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    let driver = await context.newPage();
    await waitFor(async () => {
      try {
        if (driver.isClosed()) driver = await context.newPage();
        await driver.goto(`chrome-extension://${extensionId}/data/options/index.html`, {
          waitUntil: 'domcontentloaded'
        });
        return driver.evaluate(id => chrome.runtime.id === id && Boolean(chrome.tabs), extensionId);
      }
      catch (error) {
        return false;
      }
    }, 'extension controller page');
    for (const page of context.pages()) {
      if (page !== driver) await page.close().catch(() => {});
    }
    return {browser, browserProcess, context, driver, extensionId, manifest, worker};
  }
  catch (error) {
    await browser?.close().catch(() => {});
    await terminateBrowserProcess(browserProcess);
    if (stderr.trim()) {
      error.message += `\nBrowser stderr: ${stderr.trim()}`;
    }
    throw error;
  }
};

const closeIsolated = async ({
  browser,
  browserProcess,
  context,
  profile,
  profileRoot,
  profilePrefix,
  retainProfile = false
}) => {
  assertSafeProfile(profileRoot, profile, profilePrefix);
  let closeError;
  try {
    if (browser) await browser.close();
    else await context?.close();
  }
  catch (error) {
    closeError = error;
  }
  const processCleanup = await terminateBrowserProcess(browserProcess);
  if (!processCleanup.exited) closeError ||= Error('isolated browser process did not exit');
  await sleep(250);
  const crashes = crashCount(profile);
  if (!retainProfile) {
    fs.rmSync(profile, {force: true, maxRetries: 5, recursive: true, retryDelay: 250});
    if (fs.existsSync(profile)) throw Error('isolated browser profile was not removed');
  }
  if (closeError) throw closeError;
  return {crashes, process: processCleanup, profileRemoved: !retainProfile};
};

const sendMessage = (driver, request) => driver.evaluate(message => new Promise(resolve => {
  chrome.runtime.sendMessage(message, response => resolve({
    error: chrome.runtime.lastError?.message,
    response
  }));
}), request);

module.exports = {
  argument,
  assertSafeProfile,
  closeIsolated,
  crashCount,
  hashDirectory,
  launchIsolated,
  sendMessage,
  sleep,
  waitFor
};
