const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const {
  argument,
  closeIsolated,
  hashDirectory,
  launchIsolated,
  sendMessage,
  waitFor
} = require('./isolated-chromium.cjs');

const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sensitivePaths = new Set([__dirname]);
const registerSensitivePath = value => {
  if (typeof value === 'string' && value) {
    sensitivePaths.add(path.resolve(value));
  }
  return value;
};
const sanitizeReportText = value => [...sensitivePaths]
  .sort((left, right) => right.length - left.length)
  .reduce((text, sensitive) => text.replace(
    new RegExp(`${escapeRegExp(sensitive)}(?:[\\\\/][^\\s"'<>|]*)?`, 'gi'), '<local-path>'
  ), String(value?.message || value || ''))
  .replace(/\b(?:https?|wss?|ftp|file|blob|data|about|chrome|edge|moz-extension|chrome-extension|edge-extension):[^\s"'<>)}\]]+/gi,
    '<url>')
  .replace(/\\\\[^\\/\s]+[\\/][^\r\n"'<>|]*/g, '<local-path>')
  .replace(/\b[A-Za-z]:[\\/][^\r\n"'<>|]*/g, '<local-path>')
  .replace(/\/(?:Users|home|tmp|private|var\/folders)\/[^\s"'<>]+/gi, '<local-path>')
  .replace(/\b(?:127\.0\.0\.1|localhost):\d+\b/gi, '<origin>')
  .replace(/\b[a-p]{32}\b/gi, '<extension-id>')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
    '<opaque-id>')
  .replace(/\b(?:secret|private|sensitive)[-_ ]?canary(?:[-_:][A-Za-z0-9%._~+/=]+)*/gi,
    '<secret-canary>')
  .replace(/("(?:id|tabId|windowId|keeperId|targetId|processId|pid)"\s*:\s*)-?\d+/gi,
    '$1"<redacted-id>"')
  .replace(/\b((?:tab|window|process)(?:\s+(?:with\s+)?)?(?:id)?\s*[:=#]?\s*)-?\d+\b/gi,
    '$1<redacted-id>')
  .replace(/\b(PID\s*[:=#]?\s*)-?\d+\b/gi, '$1<redacted-id>')
  .replace(/[?#][^\s"'<>]*/g, '<url-component>');

const idKey = key => /^(?:id|pid|.*ids?)$/i.test(String(key));
const idDomain = key => /process|pid/i.test(key) ? 'process' :
  /window/i.test(key) ? 'window' : /extension/i.test(key) ? 'extension' : 'tab';
const sanitizeReport = value => {
  const maps = new Map();
  const redactId = (entry, domain) => {
    const key = `${domain}:${String(entry)}`;
    if (!maps.has(key)) {
      maps.set(key, `<${domain}-id-${maps.size + 1}>`);
    }
    return maps.get(key);
  };
  const visit = (entry, key = '', parentKey = '') => {
    if (entry instanceof Error) {
      return {
        message: sanitizeReportText(entry.message),
        name: sanitizeReportText(entry.name)
      };
    }
    if (idKey(key) && (typeof entry === 'number' || typeof entry === 'string')) {
      return redactId(entry, idDomain(key));
    }
    if (typeof entry === 'string') {
      return sanitizeReportText(entry);
    }
    if (Array.isArray(entry)) {
      return entry.map(item => idKey(key) && ['number', 'string'].includes(typeof item) ?
        redactId(item, idDomain(key)) : visit(item, '', key));
    }
    if (!entry || typeof entry !== 'object') {
      return entry;
    }
    const sanitized = {};
    for (const [rawKey, item] of Object.entries(entry)) {
      let safeKey = /^-?\d+$/.test(rawKey) ? redactId(rawKey, 'tab') : sanitizeReportText(rawKey);
      while (Object.hasOwn(sanitized, safeKey)) safeKey += '-duplicate';
      sanitized[safeKey] = visit(item, rawKey, parentKey || key);
    }
    return sanitized;
  };
  return visit(value);
};

const startFixture = () => new Promise((resolve, reject) => {
  const requests = new Map();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const label = url.searchParams.get('label') || 'unknown';
    requests.set(label, (requests.get(label) || 0) + 1);
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8'
    });
    response.end(`<!doctype html><meta charset="utf-8"><title>${label}</title><body>${label}</body>`);
  });
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const {port} = server.address();
    resolve({
      count: label => requests.get(label) || 0,
      stop: () => new Promise((resolveStop, rejectStop) => server.close(error =>
        error ? rejectStop(error) : resolveStop())),
      url: label => `http://127.0.0.1:${port}/?label=${encodeURIComponent(label)}`
    });
  });
});

const allowIncognito = async (context, extensionId) => {
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions/', {waitUntil: 'domcontentloaded'});
    await page.evaluate(id => chrome.developerPrivate.updateExtensionConfiguration({
      extensionId: id,
      incognitoAccess: true
    }), extensionId);
    await waitFor(() => page.evaluate(id => new Promise(resolve => {
      chrome.management.get(id, info => resolve(chrome.runtime.lastError ? false :
        info?.enabled === true));
    }), extensionId), 'extension incognito access');
  }
  finally {
    await page.close().catch(() => {});
  }
};

const reopenExtensionDriver = async isolated => {
  await waitFor(async () => {
    let candidate = isolated.driver;
    try {
      if (!candidate || candidate.isClosed()) {
        candidate = await isolated.context.newPage();
      }
      await candidate.goto(
        `chrome-extension://${isolated.extensionId}/data/options/index.html`,
        {waitUntil: 'domcontentloaded'}
      );
      const ready = await candidate.evaluate(id =>
        globalThis.chrome?.runtime?.id === id && Boolean(chrome.tabs),
      isolated.extensionId);
      if (ready) {
        isolated.driver = candidate;
        return true;
      }
    }
    catch (error) {
      // Chrome can reject Target.createTarget briefly while applying the
      // incognito configuration and reloading the extension. Retry against a
      // fresh page instead of turning that bounded transition into a failure.
    }
    if (candidate && candidate !== isolated.driver) {
      await candidate.close().catch(() => {});
    }
    return false;
  }, 'the extension controller page after its incognito reload');
  return isolated.driver;
};

const createWindowFixture = (driver, definition) => driver.evaluate(options => new Promise((resolve, reject) => {
  chrome.windows.create({
    focused: options.focused,
    incognito: options.incognito,
    type: options.type,
    url: options.keeperUrl
  }, created => {
    const createError = chrome.runtime.lastError;
    if (createError || !created?.id || !created.tabs?.[0]) {
      reject(Error(createError?.message || `could not create ${options.type} window`));
      return;
    }
    if (!options.targetUrl) {
      resolve({keeperId: created.tabs[0].id, windowId: created.id});
      return;
    }
    chrome.tabs.create({
      active: false,
      url: options.targetUrl,
      windowId: created.id
    }, target => {
      const tabError = chrome.runtime.lastError;
      if (tabError || !target || target.windowId !== created.id) {
        reject(Error(tabError?.message || `could not add target to ${options.type} window`));
      }
      else {
        resolve({
          keeperId: created.tabs[0].id,
          targetId: target.id,
          windowId: created.id
        });
      }
    });
  });
}), definition);

const updateWindow = (driver, windowId, changes) => driver.evaluate(({changes, windowId}) =>
  new Promise((resolve, reject) => chrome.windows.update(windowId, changes, window => {
    const error = chrome.runtime.lastError;
    error ? reject(Error(error.message)) : resolve({focused: window.focused, state: window.state});
  })), {changes, windowId});

const windowState = (driver, windowId) => driver.evaluate(id => new Promise((resolve, reject) => {
  chrome.windows.get(id, window => {
    const error = chrome.runtime.lastError;
    error ? reject(Error(error.message)) : resolve({
      focused: window.focused,
      incognito: window.incognito,
      state: window.state,
      type: window.type
    });
  });
}), windowId);

const tabStates = (driver, fixtures) => driver.evaluate(entries => Promise.all(entries.map(entry =>
  new Promise(resolve => chrome.tabs.get(entry.id, tab => resolve({
    label: entry.label,
    missing: Boolean(chrome.runtime.lastError),
    state: chrome.runtime.lastError ? undefined : {
      active: tab.active,
      discarded: tab.discarded,
      incognito: tab.incognito,
      status: tab.status,
      windowId: tab.windowId
    }
  }))))), fixtures);

const sendPopupCommand = async (driver, command, fixture, onUnexpectedProgress = () => {}) => {
  const delivery = await sendMessage(driver, {
    cmd: command,
    method: 'popup',
    shiftKey: false,
    tabId: fixture.keeperId,
    windowId: fixture.windowId
  });
  const progress = delivery.response?.value;
  if (progress && !['complete', 'partial'].includes(progress.state)) {
    // Preserve the worker's structured terminal snapshot before the assertion
    // replaces it with a generic harness error. The final recursive sanitizer
    // redacts every tab/window/job identity when the report is written.
    onUnexpectedProgress({command, progress});
  }
  assert.equal(delivery.error, undefined, `${command}: runtime message channel failed`);
  assert.equal(delivery.response?.ok, true, delivery.response?.error || `${command}: response failed`);
  assert.ok(['complete', 'partial'].includes(progress?.state),
    `${command}: unexpected terminal state ${progress?.state}`);
  return progress;
};

const sendRejectedPopupCommand = async (driver, fixture, expectedType) => {
  const delivery = await sendMessage(driver, {
    cmd: 'discard-window',
    method: 'popup',
    shiftKey: false,
    tabId: fixture.keeperId,
    windowId: fixture.windowId
  });
  assert.equal(delivery.error, undefined, `${expectedType}: runtime message channel failed`);
  assert.equal(delivery.response?.ok, false,
    `${expectedType}: non-normal window command must fail before progress starts`);
  assert.equal(delivery.response?.error, 'No active tab is available',
    `${expectedType}: rejection must come from the authoritative normal-window gate`);
  assert.equal(delivery.response?.value, undefined,
    `${expectedType}: rejected command must not create a progress value`);
  return 'NO_ACTIVE_NORMAL_TAB';
};

const countDiscarded = states => states.filter(entry => entry.state?.discarded === true).length;
const compactStates = states => states.map(entry => ({
  active: entry.state?.active,
  discarded: entry.state?.discarded,
  label: entry.label,
  status: entry.state?.status,
  windowId: entry.state?.windowId
}));

const main = async () => {
  const executable = registerSensitivePath(path.resolve(argument('executable') || ''));
  const extension = registerSensitivePath(path.resolve(argument('extension', path.join(__dirname, '..', 'v3'))));
  const profileRoot = registerSensitivePath(path.resolve(argument('profile-root', path.join(__dirname, '.profiles'))));
  const results = registerSensitivePath(path.resolve(argument('results', path.join(__dirname, 'results'))));
  const retainProfile = process.argv.includes('--retain-profile');
  const headless = process.argv.includes('--headless');
  if (!fs.existsSync(executable)) throw Error('Pass --executable with a Chrome/Chromium executable');
  if (!fs.existsSync(path.join(extension, 'manifest.json'))) throw Error('The extension path has no manifest.json');
  fs.mkdirSync(profileRoot, {recursive: true});
  fs.mkdirSync(results, {recursive: true});
  const runId = `window-scope-${Date.now()}-${process.pid}`;
  const profile = registerSensitivePath(path.join(profileRoot, runId));
  const reportPath = registerSensitivePath(path.join(results, `${runId}.json`));
  const report = {
    browser: undefined,
    capabilities: {},
    cleanup: undefined,
    extension: {
      treeSha256: hashDirectory(extension),
      version: JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8')).version
    },
    outcome: 'failed',
    reportFormat: 'sanitized-v1',
    scopeTable: []
  };
  let isolated;
  let fixture;
  let failure;
  try {
    fixture = await startFixture();
    isolated = await launchIsolated({
      executablePath: executable,
      extensionPath: extension,
      headless,
      profile,
      profilePrefix: 'window-scope-',
      profileRoot
    });
    report.browser = {version: isolated.context.browser().version()};
    await allowIncognito(isolated.context, isolated.extensionId);
    await reopenExtensionDriver(isolated);
    await isolated.driver.evaluate(async () => {
      await chrome.storage.local.set({
        audio: false,
        favicon: false,
        form: false,
        'max.single.discard': 50,
        mode: 'time-based',
        number: 0,
        paused: false,
        period: 86400,
        pinned: false,
        prepends: '',
        'split-view': false,
        whitelist: [],
        'whitelist-url': []
      });
      await chrome.storage.session.clear();
    });

    const definitions = Object.fromEntries(['primary', 'background', 'minimized', 'incognito', 'popup']
      .map(label => [label, {
        focused: label === 'primary',
        incognito: label === 'incognito',
        keeperUrl: fixture.url(`${label}-keeper`),
        targetUrl: label === 'popup' ? undefined : fixture.url(`${label}-target`),
        type: label === 'popup' ? 'popup' : 'normal'
      }]));
    const fixtures = {};
    for (const label of ['primary', 'background', 'minimized', 'incognito', 'popup']) {
      fixtures[label] = await createWindowFixture(isolated.driver, definitions[label]);
    }
    await updateWindow(isolated.driver, fixtures.minimized.windowId, {state: 'minimized'});
    await updateWindow(isolated.driver, fixtures.primary.windowId, {focused: true});

    for (const [label, value] of Object.entries(fixtures)) {
      await waitFor(async () => {
        const states = await tabStates(isolated.driver, [
          {id: value.keeperId, label: `${label}-keeper`},
          ...(Number.isInteger(value.targetId) ?
            [{id: value.targetId, label: `${label}-target`}] : [])
        ]);
        return states.every(entry => entry.state?.status === 'complete') ? states : false;
      }, `${label} fixture tabs to finish loading`);
    }
    assert.deepEqual(await windowState(isolated.driver, fixtures.background.windowId), {
      focused: false,
      incognito: false,
      state: 'normal',
      type: 'normal'
    });
    assert.equal((await windowState(isolated.driver, fixtures.minimized.windowId)).state, 'minimized');
    assert.equal((await windowState(isolated.driver, fixtures.incognito.windowId)).incognito, true);
    assert.equal((await windowState(isolated.driver, fixtures.popup.windowId)).type, 'popup');

    const allEntries = Object.entries(fixtures).flatMap(([label, value]) => [
      {id: value.keeperId, label: `${label}-keeper`},
      ...(Number.isInteger(value.targetId) ?
        [{id: value.targetId, label: `${label}-target`}] : [])
    ]);
    const beforeSelectedWindow = await tabStates(isolated.driver, allEntries);
    assert.equal(countDiscarded(beforeSelectedWindow), 0,
      'all scope fixtures must be loaded immediately before the first command');
    const rememberFailedProgress = entry => {
      report.failedProgress = entry;
    };
    const selectedProgress = await sendPopupCommand(
      isolated.driver,
      'discard-window',
      fixtures.primary,
      rememberFailedProgress
    );
    const selectedWindow = await tabStates(isolated.driver, allEntries);
    const selectedGroups = Object.groupBy(selectedWindow, entry => entry.label.split('-')[0]);
    report.scopeTable.push({
      after: compactStates(selectedWindow),
      before: compactStates(beforeSelectedWindow),
      command: 'discard-window',
      contextsTouched: ['selected-normal'],
      contextsUntouched: ['background-normal', 'minimized-normal', 'incognito-normal', 'popup'],
      progress: selectedProgress
    });
    assert.equal(countDiscarded(selectedGroups.primary), 1,
      'discard-window must discard exactly one background tab in the selected normal window');
    for (const label of ['background', 'minimized', 'incognito', 'popup']) {
      assert.equal(countDiscarded(selectedGroups[label]), 0,
        `discard-window must not touch ${label} window tabs`);
    }
    report.scopeTable.at(-1).ok = true;

    await sendPopupCommand(
      isolated.driver,
      'discard-other-windows',
      fixtures.primary,
      rememberFailedProgress
    );
    const otherWindows = await tabStates(isolated.driver, allEntries);
    const otherGroups = Object.groupBy(otherWindows, entry => entry.label.split('-')[0]);
    assert.equal(countDiscarded(otherGroups.background), 1,
      'discard-other-windows must handle the background normal window and retain one keeper');
    assert.equal(countDiscarded(otherGroups.minimized), 1,
      'discard-other-windows must handle the minimized normal window and retain one keeper');
    assert.equal(countDiscarded(otherGroups.incognito), 0,
      'regular command must never cross into the incognito context');
    assert.equal(countDiscarded(otherGroups.popup), 0,
      'normal-window command must never touch popup-window tabs');
    report.scopeTable.push({
      command: 'discard-other-windows',
      contextsTouched: ['background-normal', 'minimized-normal'],
      contextsUntouched: ['selected-normal', 'incognito-normal', 'popup'],
      ok: true
    });

    const popupBefore = await tabStates(isolated.driver, [
      {id: fixtures.popup.keeperId, label: 'popup-keeper'}
    ]);
    const popupReason = await sendRejectedPopupCommand(isolated.driver, fixtures.popup, 'popup');
    assert.deepEqual(await tabStates(isolated.driver, [
      {id: fixtures.popup.keeperId, label: 'popup-keeper'}
    ]), popupBefore, 'rejected popup-window command must have zero tab mutation');
    report.capabilities.popup = {available: true, commandRejected: true, reason: popupReason};

    try {
      const app = await createWindowFixture(isolated.driver, {
        focused: false,
        incognito: false,
        keeperUrl: fixture.url('app-keeper'),
        type: 'app'
      });
      const appReason = await sendRejectedPopupCommand(isolated.driver, app, 'app');
      report.capabilities.app = {available: true, commandRejected: true, reason: appReason};
    }
    catch (error) {
      report.capabilities.app = {
        available: false,
        reason: String(error.message || error).slice(0, 240)
      };
    }

    const workspace = await isolated.driver.evaluate(async () => {
      const tabs = await chrome.tabs.query({windowType: 'normal'});
      const fields = [...new Set(tabs.flatMap(tab => Object.keys(tab)
        .filter(key => /workspace/i.test(key))))];
      return {
        exposedFields: fields,
        exposedWindowType: Boolean(chrome.windows.WindowType?.WORKSPACE)
      };
    });
    report.capabilities.workspace = workspace.exposedFields.length || workspace.exposedWindowType ? {
      available: true,
      ...workspace,
      policy: 'workspace-like normal windows are isolated by browser window ID'
    } : {
      available: false,
      ...workspace,
      reason: 'Chromium exposes no workspace window type or tab workspace identity; workspace-like windows follow normal-window ID scope'
    };

    report.outcome = 'passed';
  }
  catch (error) {
    failure = error;
    report.error = {message: error.message};
  }
  finally {
    if (fixture) {
      try {
        await fixture.stop();
        report.fixtureStopped = true;
      }
      catch (error) {
        failure ||= error;
        report.fixtureStopped = false;
      }
    }
    if (isolated) {
      try {
        report.cleanup = await closeIsolated({
          browser: isolated.browser,
          browserProcess: isolated.browserProcess,
          context: isolated.context,
          profile,
          profilePrefix: 'window-scope-',
          profileRoot,
          retainProfile
        });
      }
      catch (error) {
        failure ||= error;
        report.cleanup = {error: error.message, profileRemoved: false};
      }
    }
    else if (!retainProfile && fs.existsSync(profile)) {
      fs.rmSync(profile, {force: true, recursive: true});
    }
    if (report.cleanup?.crashes > 0 || report.cleanup?.profileRemoved === false || report.fixtureStopped === false) {
      report.outcome = 'failed';
      failure ||= Error('isolated window-scope browser cleanup failed');
    }
    fs.writeFileSync(reportPath, `${JSON.stringify(sanitizeReport(report), null, 2)}\n`);
  }
  if (failure) {
    failure.message += `\nFull report: ${reportPath}`;
    throw failure;
  }
  process.stdout.write(`${JSON.stringify({outcome: report.outcome, reportPath})}\n`);
};

module.exports = {
  allowIncognito,
  countDiscarded,
  createWindowFixture,
  reopenExtensionDriver,
  registerSensitivePath,
  sanitizeReport,
  sanitizeReportText,
  sendRejectedPopupCommand,
  startFixture
};

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
