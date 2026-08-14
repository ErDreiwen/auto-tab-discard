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
  sleep,
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

const SUBFRAME_TRANSITION = 'subframe-reverted-edit';

const subframeDocument = label => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>ATD framed form protection ${label}</title>
</head>
<body>
  <form><input id="frame-text" name="frame-text" value="saved frame text"></form>
  <script>window.__frameFixtureReady = true;</script>
</body>
</html>`;

const fixtureDocument = label => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>ATD form protection ${label}</title>
</head>
<body>
  <form id="fixture-form" method="post" action="/submitted?case=${encodeURIComponent(label)}" target="submit-sink">
    <input id="text" name="text" value="saved text">
    <textarea id="paste" name="paste">saved paste</textarea>
    <input id="cut" name="cut" value="saved cut">
    <select id="select" name="select"><option value="one" selected>one</option><option value="two">two</option></select>
    <input id="checkbox" name="checkbox" type="checkbox">
    <input id="radio-one" name="radio" type="radio" value="one" checked>
    <input id="radio-two" name="radio" type="radio" value="two">
    <input id="speech" name="speech" value="saved speech">
    <input id="drop" name="drop" value="saved drop">
    <input id="date" name="date" type="date" value="2026-08-12">
    <input id="color" name="color" type="color" value="#000000">
    <div id="editable" contenteditable="true">saved rich text</div>
    <div id="dynamic-host"></div>
    <div id="shadow-host"></div>
    <button id="prevent-submit" type="submit">Prevented submit</button>
    <button id="submit" type="submit">Genuine submit</button>
    <button id="reset" type="reset">Reset</button>
  </form>
  <iframe name="submit-sink" hidden></iframe>
  ${label === SUBFRAME_TRANSITION ?
    `<iframe id="frame-editor" src="/frame?case=${encodeURIComponent(label)}"></iframe>` : ''}
  <script>
    const shadow = document.querySelector('#shadow-host').attachShadow({mode: 'open'});
    shadow.innerHTML = '<input id="shadow-input" value="saved shadow">';
    document.querySelector('#fixture-form').addEventListener('submit', event => {
      if (event.submitter?.id === 'prevent-submit') event.preventDefault();
    });
    window.__fixtureReady = true;
  </script>
</body>
</html>`;

const startFixture = () => new Promise((resolve, reject) => {
  const frameRequests = new Map();
  const requests = new Map();
  const submissions = new Map();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/fixture') {
      const label = url.searchParams.get('case') || 'unknown';
      requests.set(label, (requests.get(label) || 0) + 1);
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8'
      });
      response.end(fixtureDocument(label));
      return;
    }
    if (url.pathname === '/frame') {
      const label = url.searchParams.get('case') || 'unknown';
      frameRequests.set(label, (frameRequests.get(label) || 0) + 1);
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8'
      });
      response.end(subframeDocument(label));
      return;
    }
    if (url.pathname === '/submitted') {
      const label = url.searchParams.get('case') || 'unknown';
      submissions.set(label, (submissions.get(label) || 0) + 1);
      request.resume();
      request.on('end', () => {
        response.writeHead(204, {'cache-control': 'no-store'});
        response.end();
      });
      return;
    }
    response.writeHead(204, {'cache-control': 'no-store'});
    response.end();
  });
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const {port} = server.address();
    resolve({
      count: label => requests.get(label) || 0,
      frameCount: label => frameRequests.get(label) || 0,
      stop: () => new Promise((resolveStop, rejectStop) => server.close(error =>
        error ? rejectStop(error) : resolveStop())),
      submissionCount: label => submissions.get(label) || 0,
      url: label => `http://127.0.0.1:${port}/fixture?case=${encodeURIComponent(label)}`
    });
  });
});

const editActions = {
  'beforeinput-text': async page => {
    await page.locator('#text').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' changed');
  },
  paste: page => page.locator('#paste').evaluate(element => {
    element.focus();
    element.dispatchEvent(new ClipboardEvent('paste', {bubbles: true, composed: true}));
    element.value = 'pasted value';
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      composed: true,
      data: 'pasted value',
      inputType: 'insertFromPaste'
    }));
  }),
  cut: page => page.locator('#cut').evaluate(element => {
    element.focus();
    element.dispatchEvent(new ClipboardEvent('cut', {bubbles: true, composed: true}));
    element.value = '';
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      composed: true,
      data: null,
      inputType: 'deleteByCut'
    }));
  }),
  select: page => page.locator('#select').selectOption('two'),
  checkbox: page => page.locator('#checkbox').check(),
  radio: page => page.locator('#radio-two').check(),
  speech: page => page.locator('#speech').evaluate(element => {
    element.focus();
    element.value = 'dictated value';
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      composed: true,
      data: 'dictated value',
      inputType: 'insertFromDictation'
    }));
  }),
  'drag-drop': page => page.locator('#drop').evaluate(element => {
    element.focus();
    element.dispatchEvent(new DragEvent('drop', {bubbles: true, composed: true}));
    element.value = 'dropped value';
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      composed: true,
      data: 'dropped value',
      inputType: 'insertFromDrop'
    }));
  }),
  date: page => page.locator('#date').fill('2026-08-13'),
  color: page => page.locator('#color').evaluate(element => {
    element.focus();
    element.value = '#ff0000';
    element.dispatchEvent(new Event('input', {bubbles: true, composed: true}));
    element.dispatchEvent(new Event('change', {bubbles: true, composed: true}));
  }),
  'contenteditable': async page => {
    await page.locator('#editable').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' changed');
  },
  'dynamic-control': async page => {
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'dynamic-input';
      input.defaultValue = 'saved dynamic';
      input.value = 'saved dynamic';
      document.querySelector('#dynamic-host').append(input);
    });
    await page.locator('#dynamic-input').fill('changed dynamic');
  },
  'shadow-dom': page => page.locator('#shadow-host input').fill('changed shadow')
};

const createTarget = async (driver, context, url) => {
  const tab = await driver.evaluate(targetUrl => new Promise((resolve, reject) => {
    chrome.tabs.create({active: false, url: targetUrl}, created => {
      const error = chrome.runtime.lastError;
      error ? reject(Error(error.message)) : resolve({id: created.id});
    });
  }), url);
  const page = await waitFor(() => context.pages().find(candidate => candidate.url() === url),
    `fixture page ${url}`);
  await page.waitForFunction(() => globalThis.__fixtureReady === true);
  return {id: tab.id, page};
};

const removeTarget = (driver, id) => driver.evaluate(tabId => new Promise(resolve => {
  chrome.tabs.remove(tabId, () => {
    void chrome.runtime.lastError;
    resolve();
  });
}), id);

const tabState = (driver, id) => driver.evaluate(tabId => new Promise(resolve => {
  chrome.tabs.get(tabId, tab => resolve(chrome.runtime.lastError ? undefined : {
    active: tab.active,
    discarded: tab.discarded,
    status: tab.status
  }));
}), id);

const runCheck = async (driver, id) => {
  const delivery = await sendMessage(driver, {ids: [id], method: 'run-check-on-action'});
  assert.equal(delivery.error, undefined, 'targeted form check must retain its message channel');
  assert.equal(delivery.response?.ok, true, delivery.response?.error || 'targeted form check failed');
  return delivery.response.value;
};

const assertProtected = async (driver, id, result, label) => {
  const entry = result?.protected?.find(candidate => candidate.tab?.id === id);
  assert.ok(entry, `${label}: targeted check did not classify the dirty tab as protected`);
  assert.match(entry.reason, /unsaved form input/i, `${label}: protection reason is not precise`);
  const state = await tabState(driver, id);
  assert.deepEqual(state, {active: false, discarded: false, status: 'complete'},
    `${label}: dirty tab must remain loaded and inactive`);
};

const assertDiscarded = async (driver, id, result, label) => {
  assert.ok(result?.succeeded?.some(candidate => candidate.tab?.id === id),
    `${label}: cleared form did not receive a successful terminal result`);
  await waitFor(async () => {
    const state = await tabState(driver, id);
    return state?.discarded === true && state.status === 'unloaded' ? state : false;
  }, `${label} to become discarded`);
};

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
  const runId = `form-protection-${Date.now()}-${process.pid}`;
  const profile = registerSensitivePath(path.join(profileRoot, runId));
  const reportPath = registerSensitivePath(path.join(results, `${runId}.json`));
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
  const report = {
    browser: undefined,
    cleanup: undefined,
    extension: {
      treeSha256: hashDirectory(extension),
      version: manifest.version
    },
    outcome: 'failed',
    reportFormat: 'sanitized-v1',
    scenarios: []
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
      profilePrefix: 'form-protection-',
      profileRoot
    });
    report.browser = {version: isolated.context.browser().version()};
    assert.deepEqual(manifest.optional_permissions, ['webNavigation'],
      'the tested artifact must declare frame enumeration as one optional permission');
    assert.equal(manifest.permissions?.includes('webNavigation'), false,
      'the tested artifact must not require frame enumeration at install time');
    const framePermissionGranted = await isolated.driver.evaluate(() => new Promise((resolve, reject) => {
      chrome.permissions.contains({permissions: ['webNavigation']}, granted => {
        const error = chrome.runtime.lastError;
        error ? reject(Error(error.message || String(error))) : resolve(granted === true);
      });
    }));
    assert.equal(framePermissionGranted, false,
      'the exact-artifact fallback proof requires optional frame access to remain absent');
    report.extension.framePermission = {
      declaredOptional: true,
      initiallyGranted: framePermissionGranted,
      required: false
    };
    await isolated.driver.evaluate(async () => {
      await chrome.storage.local.set({
        audio: false,
        favicon: false,
        form: true,
        'max.single.discard': 50,
        mode: 'time-based',
        number: 0,
        paused: false,
        period: 0,
        pinned: false,
        prepends: '',
        'split-view': false,
        whitelist: [],
        'whitelist-url': []
      });
      await chrome.storage.session.clear();
    });

    for (const [label, edit] of Object.entries(editActions)) {
      const url = fixture.url(label);
      const target = await createTarget(isolated.driver, isolated.context, url);
      try {
        await edit(target.page);
        await assertProtected(isolated.driver, target.id, await runCheck(isolated.driver, target.id), label);
        assert.equal(fixture.count(label), 1, `${label}: protection check must not reload the document`);
        report.scenarios.push({edit: label, final: 'protected', ok: true, requests: 1});
      }
      finally {
        await removeTarget(isolated.driver, target.id);
      }
    }

    {
      const label = 'prevented-submit';
      const target = await createTarget(isolated.driver, isolated.context, fixture.url(label));
      try {
        await target.page.locator('#text').fill('unsaved prevented value');
        await target.page.locator('#prevent-submit').click();
        await sleep(100);
        assert.equal(fixture.submissionCount(label), 0, 'prevented submit must not reach the server');
        await assertProtected(isolated.driver, target.id, await runCheck(isolated.driver, target.id), label);
        report.scenarios.push({edit: label, final: 'protected', ok: true, submissions: 0});
      }
      finally {
        await removeTarget(isolated.driver, target.id);
      }
    }

    for (const transition of [
      {
        clear: page => page.locator('#text').fill('saved text'),
        label: 'reverted-edit'
      },
      {
        clear: async page => {
          await page.locator('#reset').click();
          await sleep(50);
        },
        label: 'native-reset'
      },
      {
        clear: async (page, label) => {
          await page.locator('#submit').click();
          await waitFor(() => fixture.submissionCount(label) === 1,
            `${label} genuine form submission`);
          await sleep(50);
        },
        label: 'genuine-submit'
      }
    ]) {
      const target = await createTarget(
        isolated.driver,
        isolated.context,
        fixture.url(transition.label)
      );
      try {
        await target.page.locator('#text').fill('unsaved transition value');
        await assertProtected(
          isolated.driver,
          target.id,
          await runCheck(isolated.driver, target.id),
          `${transition.label} before clear`
        );
        await transition.clear(target.page, transition.label);
        await assertDiscarded(
          isolated.driver,
          target.id,
          await runCheck(isolated.driver, target.id),
          transition.label
        );
        assert.equal(fixture.count(transition.label), 1,
          `${transition.label}: clear and discard must not reload the document`);
        report.scenarios.push({
          final: 'discarded-after-clear',
          ok: true,
          requests: 1,
          transition: transition.label
        });
      }
      finally {
        await removeTarget(isolated.driver, target.id);
      }
    }

    {
      const label = SUBFRAME_TRANSITION;
      const target = await createTarget(isolated.driver, isolated.context, fixture.url(label));
      try {
        const frame = await waitFor(() => target.page.frames().find(candidate => {
          try {
            return new URL(candidate.url()).pathname === '/frame';
          }
          catch {
            return false;
          }
        }), `${label} same-origin child frame`);
        await frame.waitForFunction(() => globalThis.__frameFixtureReady === true);
        const input = frame.locator('#frame-text');
        await input.fill('unsaved frame text');
        await assertProtected(
          isolated.driver,
          target.id,
          await runCheck(isolated.driver, target.id),
          `${label} before revert`
        );
        await input.fill('saved frame text');
        await assertDiscarded(
          isolated.driver,
          target.id,
          await runCheck(isolated.driver, target.id),
          label
        );
        assert.equal(fixture.count(label), 1,
          `${label}: top document must not reload during fallback checks`);
        assert.equal(fixture.frameCount(label), 1,
          `${label}: child document must not reload during fallback checks`);
        report.scenarios.push({
          final: 'discarded-after-subframe-revert',
          frameRequests: 1,
          ok: true,
          requests: 1,
          transition: label
        });
      }
      finally {
        await removeTarget(isolated.driver, target.id);
      }
    }
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
          profilePrefix: 'form-protection-',
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
      failure ||= Error('isolated form-protection browser cleanup failed');
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
  editActions,
  fixtureDocument,
  registerSensitivePath,
  sanitizeReport,
  sanitizeReportText,
  startFixture,
  subframeDocument
};

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
