import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {
  accessibleDescription,
  accessibleName,
  auditPopupAccessibility,
  declarationsFor,
  parseCss,
  parsePopupHtml,
  pressKey,
  pressTab,
  tabOrder
} from './helpers/mini-popup-dom.mjs';

const root = new URL('../', import.meta.url);
const tick = () => new Promise(resolve => setImmediate(resolve));
const luminance = hex => {
  hex = hex.replace('#', '');
  if (hex.length === 3) {
    hex = [...hex].map(value => value.repeat(2)).join('');
  }
  const channels = hex.match(/../g).map(value => Number.parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
};
const contrast = (a, b) => {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
};

const chromeMessage = (catalog, key, substitutions = []) => {
  const entry = catalog[key];
  if (!entry) {
    return '';
  }
  const values = Array.isArray(substitutions) ? substitutions : [substitutions];
  let message = entry.message;
  for (const [name, placeholder] of Object.entries(entry.placeholders || {})) {
    const index = Number(String(placeholder.content).replace('$', '')) - 1;
    message = message.replace(new RegExp(`\\$${name}\\$`, 'gi'), values[index] ?? '');
  }
  return message;
};

const createBrowser = (catalog, {
  contextIncognito,
  direction = 'ltr',
  incognito = false,
  pseudo = false,
  queryFailure = false,
  queryMalformed = false,
  suspended = true,
  url = 'https://selected.example/'
} = {}) => {
  const selected = {
    active: true,
    autoDiscardable: true,
    discarded: false,
    frozen: false,
    highlighted: true,
    id: 1,
    incognito,
    index: 3,
    status: 'complete',
    url,
    windowId: 10,
    windowType: 'normal'
  };
  const peers = suspended ? [
    {...selected, active: false, discarded: true, highlighted: false, id: 2, index: 1},
    {...selected, active: false, discarded: true, highlighted: false, id: 3, index: 5},
    {...selected, active: false, discarded: true, highlighted: false, id: 4, index: 1, windowId: 20}
  ] : [];
  const tabs = [selected, ...peers];
  const state = {
    cancelRequests: [],
    clearRequests: [],
    closed: false,
    diagnostic: undefined,
    diagnosticText: '',
    failNextPopup: false,
    held: undefined,
    holdNextPopup: false,
    messages: [],
    openedOptions: false,
    popupRequests: [],
    runtimeListeners: []
  };
  const snapshot = (request, nextState = 'complete') => {
    const completed = !['running', 'cancelling'].includes(nextState);
    const success = nextState === 'complete';
    const incidentId = `ATD-${String(request.cmd || 'COMMAND').replace(/[^a-z0-9]/gi, '')
      .toUpperCase()}-1`;
    return {
      checked: request.checked === true,
      command: request.cmd,
      completed: completed ? 1 : 0,
      errorCode: nextState === 'cancelled' ? 'POPUP_CANCELLED' : undefined,
      incidentId,
      jobId: `job-${request.cmd}`,
      outcomes: completed ? {
        1: {
          code: success ? 'TAB_DISCARDED' : 'TAB_CANCELLED',
          status: success ? 'success' : 'skipped',
          tabId: 1
        }
      } : {},
      privateContext: request.incognito === true,
      shiftKey: request.shiftKey === true,
      state: nextState,
      summary: success ? {failed: 0, skipped: 0, success: 1} :
        {failed: 0, skipped: completed ? 1 : 0, success: 0},
      total: 1,
      windowId: request.windowId
    };
  };
  const incident = value => ({
    command: value.command,
    durationMs: 25,
    endedAt: 1_725_000_000_025,
    forced: value.shiftKey === true,
    groups: Object.values(value.outcomes || {}).map(outcome => ({
      code: outcome.code,
      count: 1,
      reasonCode: outcome.code === 'TAB_DISCARDED' ? 'DISCARDED' : 'CANCELLED',
      stage: outcome.code === 'TAB_DISCARDED' ? 'tab-operation' : 'command',
      status: outcome.status
    })),
    id: value.incidentId,
    runtime: {browserFamily: 'Chromium', extensionVersion: '0.6.9.2'},
    startedAt: 1_725_000_000_000,
    state: value.state,
    summary: value.summary,
    total: value.total
  });
  const respond = (callback, value) => callback?.(value);

  const chrome = {
    alarms: {
      get(name, callback) {
        callback(undefined);
      }
    },
    i18n: {
      getMessage(key, substitutions) {
        if (key === '@@bidi_dir') {
          return direction;
        }
        if (key === '@@ui_locale') {
          return direction === 'rtl' ? 'ar' : 'en';
        }
        const value = chromeMessage(catalog, key, substitutions);
        return pseudo && value ? `⟦${value.repeat(8)}⟧` : value;
      }
    },
    extension: {
      inIncognitoContext: contextIncognito ?? incognito
    },
    runtime: {
      lastError: undefined,
      onMessage: {
        addListener(listener) {
          state.runtimeListeners.push(listener);
        }
      },
      openOptionsPage() {
        state.openedOptions = true;
      },
      sendMessage(request, callback) {
        state.messages.push(request);
        if (request.method === 'storage') {
          respond(callback, {
            'tmp_disable': 0,
            'whitelist': [],
            'whitelist.session': []
          });
        }
        else if (request.method === 'takeover-snapshot') {
          respond(callback, {ok: true, value: []});
        }
        else if (request.method === 'popup-progress-snapshot') {
          respond(callback, {ok: true, value: undefined});
        }
        else if (request.method === 'diagnostics-latest') {
          const value = state.diagnostic && (!request.incidentId ||
            request.incidentId === state.diagnostic.id) ? state.diagnostic : null;
          respond(callback, {ok: true, value});
        }
        else if (request.method === 'diagnostics-export') {
          const value = state.diagnostic && request.incidentId === state.diagnostic.id ? {
            incident: state.diagnostic,
            text: state.diagnosticText
          } : null;
          respond(callback, {ok: true, value});
        }
        else if (request.method === 'diagnostics-clear') {
          state.clearRequests.push(request);
          state.diagnostic = undefined;
          state.diagnosticText = '';
          respond(callback, {ok: true, value: {cleared: true}});
        }
        else if (request.method === 'popup-progress-cancel') {
          state.cancelRequests.push(request);
          const command = state.held?.request || {cmd: 'discard-tabs', windowId: selected.windowId};
          respond(callback, {
            ok: true,
            value: {snapshot: snapshot(command, 'cancelling')}
          });
        }
        else if (request.method === 'popup') {
          state.popupRequests.push(request);
          if (state.holdNextPopup) {
            state.holdNextPopup = false;
            state.held = {callback, request};
            state.publish({
              ...snapshot(request),
              completed: 0,
              state: 'running',
              summary: {failed: 0, skipped: 0, success: 0}
            });
          }
          else if (state.failNextPopup) {
            state.failNextPopup = false;
            respond(callback, {code: 'POPUP_COMMAND_FAILED', ok: false});
          }
          else {
            const value = snapshot(request);
            state.diagnostic = incident(value);
            state.diagnosticText = `[2026-08-14T00:00:00.000Z] [PopupCommand/INFO]: incident=${value.incidentId}\n` +
              '[2026-08-14T00:00:00.025Z] [PopupCommand/INFO]: 1 succeeded, 0 skipped, 0 failed\n';
            respond(callback, {ok: true, value});
          }
        }
        else if (request.method?.startsWith('move-') || request.method === 'close') {
          respond(callback, {ok: true});
        }
      }
    },
    scripting: {
      executeScript() {
        return Promise.resolve([{result: 'Selected'}]);
      }
    },
    storage: {
      local: {
        set() {}
      },
      managed: {
        get(defaults, callback) {
          callback(defaults);
        }
      },
      onChanged: {
        addListener() {}
      },
      session: {
        get(defaults, callback) {
          callback(defaults);
        }
      }
    },
    tabs: {
      query(options, callback) {
        if (queryFailure) {
          callback(undefined, {
            code: 'QUERY_DENIED_BY_COMPATIBILITY',
            message: 'injected popup query failure'
          });
          return;
        }
        if (queryMalformed) {
          callback({not: 'an array'});
          return;
        }
        let result = tabs;
        if (typeof options.active === 'boolean') {
          result = result.filter(tab => tab.active === options.active);
        }
        if (options.currentWindow === true) {
          result = result.filter(tab => tab.windowId === selected.windowId);
        }
        if (options.currentWindow === false) {
          result = result.filter(tab => tab.windowId !== selected.windowId);
        }
        if (Number.isInteger(options.windowId)) {
          result = result.filter(tab => tab.windowId === options.windowId);
        }
        if (typeof options.highlighted === 'boolean') {
          result = result.filter(tab => tab.highlighted === options.highlighted);
        }
        callback(result.map(tab => ({...tab})));
      },
      update(id, changes, callback) {
        const tab = tabs.find(tab => tab.id === id);
        Object.assign(tab || {}, changes);
        callback?.(tab && {...tab});
      }
    }
  };

  state.publish = update => {
    for (const listener of state.runtimeListeners) {
      listener({method: 'popup-progress-update', snapshot: update});
    }
  };
  state.resolveHeld = (nextState = 'cancelled') => {
    const held = state.held;
    state.held = undefined;
    const value = held && snapshot(held.request, nextState);
    if (value) {
      state.diagnostic = incident(value);
      state.diagnosticText = `[2026-08-14T00:00:00.000Z] [PopupCommand/WARN]: incident=${value.incidentId}\n`;
    }
    held?.callback({ok: true, value});
  };
  return {chrome, selected, state};
};

const installPopup = async (catalog, options, nonce, expectedReady = 'true') => {
  const html = await readFile(new URL('v3/data/popup/index.html', root), 'utf8');
  const document = parsePopupHtml(html);
  const browser = createBrowser(catalog, options);
  const saved = new Map(['chrome', 'document', 'window'].map(name => [
    name,
    Object.prototype.hasOwnProperty.call(globalThis, name) ? globalThis[name] : Symbol.for('missing')
  ]));
  const window = {
    close() {
      browser.state.closed = true;
    }
  };
  globalThis.chrome = browser.chrome;
  globalThis.document = document;
  globalThis.window = window;
  await import(new URL(`v3/data/popup/index.mjs?keyboard-gate=${nonce}`, root));
  for (let attempt = 0; attempt < 20 &&
      !['true', 'failed'].includes(document.documentElement.dataset.popupReady); attempt += 1) {
    await tick();
  }
  assert.equal(document.documentElement.dataset.popupReady, expectedReady,
    'popup initialization did not settle to the expected state');
  return {
    ...browser,
    cleanup() {
      for (const [name, value] of saved) {
        if (value === Symbol.for('missing')) {
          delete globalThis[name];
        }
        else {
          globalThis[name] = value;
        }
      }
    },
    document,
    window
  };
};

test('rendered popup has no serious semantic violations and every command works by keyboard', async () => {
  const catalog = JSON.parse(await readFile(new URL('v3/_locales/en/messages.json', root), 'utf8'));
  const app = await installPopup(catalog, {}, 'operable');
  const discardCommands = [
    'discard-tab',
    'discard-tree',
    'discard-window',
    'discard-rights',
    'discard-lefts',
    'discard-other-windows',
    'discard-tabs'
  ];
  const releaseCommands = [
    'release-window',
    'release-rights',
    'release-lefts',
    'release-other-windows',
    'release-tabs'
  ];
  try {
    assert.deepEqual(auditPopupAccessibility(app.document), []);
    assert.equal(app.document.documentElement.dir, 'ltr');

    const keyboardOrder = [];
    app.document.activeElement = null;
    for (let index = 0; index < tabOrder(app.document).length; index += 1) {
      keyboardOrder.push(pressTab(app.document)?.dataset.cmd || pressTab.id);
    }
    for (const command of discardCommands) {
      assert.ok(keyboardOrder.includes(command), `${command} is absent from sequential keyboard navigation`);
      const control = app.document.querySelector(`[data-cmd=${command}]`);
      assert.ok(accessibleName(control));
      assert.ok(accessibleDescription(control).length > 0, `${command} does not expose its Shift behavior`);
      const before = app.state.popupRequests.length;
      pressKey(control, before % 2 ? ' ' : 'Enter', {shiftKey: command === 'discard-tabs'});
      await tick();
      assert.equal(app.state.popupRequests.length, before + 1);
      assert.equal(app.state.popupRequests.at(-1).cmd, command);
      assert.equal(app.state.popupRequests.at(-1).shiftKey, command === 'discard-tabs');
      assert.equal(app.document.activeElement, control, `${command} did not receive focus back after completion`);
    }

    const releaseNames = new Set();
    for (const command of releaseCommands) {
      const control = app.document.querySelector(`[data-cmd=${command}]`);
      const name = accessibleName(control);
      assert.ok(name.includes('Release discarding'), `${command} has no release action in its name`);
      assert.ok(name.includes('Discard'), `${command} has no scope in its name`);
      releaseNames.add(name);
      const before = app.state.popupRequests.length;
      pressKey(control, before % 2 ? 'Enter' : ' ');
      await tick();
      assert.equal(app.state.popupRequests.at(-1).cmd, command);
    }
    assert.equal(releaseNames.size, releaseCommands.length, 'release controls are not distinguishable by name');
  }
  finally {
    app.cleanup();
  }
});

test('incognito commands are marked private while their sanitized terminal diagnostics remain available', async () => {
  const catalog = JSON.parse(await readFile(new URL('v3/_locales/en/messages.json', root), 'utf8'));
  const app = await installPopup(catalog, {incognito: true}, 'incognito-diagnostic');
  try {
    pressKey(app.document.querySelector('[data-cmd=discard-tab]'), 'Enter');
    await tick();

    assert.equal(app.state.popupRequests.at(-1).incognito, true,
      'the worker cannot keep private diagnostics memory-only without this bit');
    assert.equal(app.document.getElementById('activity-diagnostics-toggle').hidden, false,
      'the current private popup should still expose its sanitized in-memory incident');
    const diagnosticRequests = app.state.messages.filter(request =>
      request.method === 'diagnostics-latest' || request.method === 'diagnostics-export' ||
      request.method === 'diagnostics-clear');
    assert.ok(diagnosticRequests.length > 0);
    assert.ok(diagnosticRequests.every(request => request.tabId === app.selected.id &&
      request.windowId === app.selected.windowId),
      'every private diagnostic read must carry the selected tab/window for worker authorization');
  }
  finally {
    app.cleanup();
  }
});

test('spanning-mode popup trusts the selected private tab instead of the shared popup context', async () => {
  const catalog = JSON.parse(await readFile(new URL('v3/_locales/en/messages.json', root), 'utf8'));
  const app = await installPopup(catalog, {
    contextIncognito: false,
    incognito: true
  }, 'spanning-incognito-diagnostic');
  try {
    pressKey(app.document.querySelector('[data-cmd=discard-tab]'), 'Enter');
    await tick();

    assert.equal(app.state.popupRequests.at(-1).incognito, true,
      'a spanning-mode private tab must never enter durable diagnostic storage');
  }
  finally {
    app.cleanup();
  }
});

test('busy, cancel, failed, and retry states manage focus and announcements deterministically', async () => {
  const catalog = JSON.parse(await readFile(new URL('v3/_locales/en/messages.json', root), 'utf8'));
  const app = await installPopup(catalog, {}, 'activity');
  try {
    const trigger = app.document.querySelector('[data-cmd=discard-tabs]');
    const cancel = app.document.getElementById('activity-cancel');
    const retry = app.document.getElementById('activity-retry');
    const activity = app.document.getElementById('activity');
    const status = app.document.getElementById('activity-status');

    app.state.holdNextPopup = true;
    pressKey(trigger, 'Enter');
    assert.equal(activity.getAttribute('aria-busy'), 'true');
    assert.equal(app.document.activeElement, cancel);
    assert.equal(cancel.hidden, false);
    assert.equal(cancel.disabled, false);
    assert.deepEqual(tabOrder(app.document), [cancel], 'busy popup exposes a conflicting keyboard action');
    for (const control of app.document.querySelectorAll('[data-cmd]')) {
      assert.equal(control.disabled, true);
      assert.equal(control.getAttribute('aria-disabled'), 'true');
    }
    assert.deepEqual(auditPopupAccessibility(app.document), []);

    const mutations = status.textMutations;
    const duplicate = {
      command: 'discard-tabs',
      completed: 0,
      jobId: 'job-discard-tabs',
      state: 'running',
      summary: {failed: 0, skipped: 0, success: 0},
      total: 1,
      windowId: app.selected.windowId
    };
    app.state.publish(structuredClone(duplicate));
    app.state.publish(structuredClone(duplicate));
    assert.equal(status.textMutations, mutations, 'duplicate live-region snapshots were announced again');

    pressKey(cancel, ' ');
    await tick();
    assert.equal(app.state.cancelRequests.length, 1);
    assert.equal(cancel.disabled, true);
    assert.equal(app.document.activeElement, status);
    app.state.resolveHeld('cancelled');
    assert.equal(activity.getAttribute('aria-busy'), 'false');
    assert.equal(retry.hidden, false);
    assert.equal(retry.disabled, false);
    assert.equal(app.document.activeElement, retry);

    const beforeRetry = app.state.popupRequests.length;
    pressKey(retry, 'Enter');
    await tick();
    assert.equal(app.state.popupRequests.length, beforeRetry + 1);
    assert.equal(app.state.popupRequests.at(-1).cmd, 'discard-tabs');
    assert.equal(retry.hidden, true);
    assert.equal(app.document.activeElement, trigger);

    const release = app.document.querySelector('[data-cmd=release-tabs]');
    app.state.failNextPopup = true;
    pressKey(release, ' ');
    await tick();
    assert.equal(retry.hidden, false);
    assert.equal(app.document.activeElement, retry);
    const failedTextMutations = status.textMutations;
    // Re-rendering the same failure without starting a new attempt is deduped.
    app.state.publish(undefined);
    assert.equal(status.textMutations, failedTextMutations);
    pressKey(retry, ' ');
    await tick();
    assert.equal(app.state.popupRequests.at(-1).cmd, 'release-tabs');
    assert.equal(app.document.activeElement, release);
  }
  finally {
    app.cleanup();
  }
});

test('partial no-safe-keeper result is visibly localized, announced, and retryable', async () => {
  const catalog = JSON.parse(await readFile(new URL('v3/_locales/en/messages.json', root), 'utf8'));
  const app = await installPopup(catalog, {}, 'no-safe-keeper');
  try {
    const activity = app.document.getElementById('activity');
    const retry = app.document.getElementById('activity-retry');
    const status = app.document.getElementById('activity-status');
    const announcement = app.document.getElementById('activity-announcement');
    const summary = app.document.getElementById('activity-summary');
    const before = app.state.popupRequests.length;
    app.state.publish({
      command: 'discard-tree',
      completed: 4,
      jobId: 'job-no-safe-keeper',
      outcomes: {
        1: {code: 'TAB_NO_SAFE_KEEPER', status: 'skipped', tabId: 1},
        2: {code: 'TAB_DISCARDED', status: 'success', tabId: 2},
        3: {code: 'TAB_DISCARDED', status: 'success', tabId: 3},
        4: {code: 'TAB_DISCARDED_VISUAL_UNAVAILABLE', status: 'success', tabId: 4}
      },
      state: 'partial',
      summary: {failed: 0, skipped: 1, success: 3},
      total: 4,
      windowId: app.selected.windowId
    });

    assert.equal(activity.hidden, false);
    assert.equal(activity.getAttribute('aria-busy'), 'false');
    assert.equal(announcement.getAttribute('role'), 'status');
    assert.equal(announcement.getAttribute('aria-live'), 'polite');
    assert.match(status.textContent, /Finished with some tabs not completed/);
    assert.doesNotMatch(status.textContent, /succeeded|skipped|failed/i,
      'the visible headline repeats the separate summary');
    assert.match(announcement.textContent,
      /1 tab\(s\) stayed loaded because no safe keeper tab was available/);
    assert.match(announcement.textContent,
      /1 tab\(s\) were converted to extension-owned native discards/);
    assert.equal(summary.textContent, '3 succeeded, 1 skipped, 0 failed.');
    assert.equal(retry.hidden, false);
    assert.equal(retry.disabled, false);
    assert.equal(app.document.activeElement, retry);
    assert.equal(app.state.popupRequests.length, before,
      'rendering a blocked root must not dispatch or wake it');
    assert.deepEqual(auditPopupAccessibility(app.document), []);
  }
  finally {
    app.cleanup();
  }
});

test('retained-frozen release failure is visibly precise and retryable', async () => {
  const catalog = JSON.parse(await readFile(new URL('v3/_locales/en/messages.json', root), 'utf8'));
  const app = await installPopup(catalog, {}, 'release-remains-frozen');
  try {
    const retry = app.document.getElementById('activity-retry');
    const status = app.document.getElementById('activity-status');
    const announcement = app.document.getElementById('activity-announcement');
    app.state.publish({
      command: 'release-tabs',
      completed: 1,
      jobId: 'job-release-remains-frozen',
      outcomes: {
        1: {code: 'TAB_RELEASE_REMAINS_FROZEN', status: 'failed', tabId: 1}
      },
      state: 'failed',
      summary: {failed: 1, skipped: 0, success: 0},
      total: 1,
      windowId: app.selected.windowId
    });

    assert.match(announcement.textContent, /remained frozen after the release reload/);
    assert.equal(status.textContent, 'The action could not be completed.');
    assert.equal(retry.hidden, false);
    assert.equal(retry.disabled, false);
    assert.equal(app.document.activeElement, retry);
    const before = app.state.popupRequests.length;
    pressKey(retry, 'Enter');
    await tick();
    assert.equal(app.state.popupRequests.length, before + 1);
    assert.equal(app.state.popupRequests.at(-1).cmd, 'release-tabs');
    assert.deepEqual(auditPopupAccessibility(app.document), []);
  }
  finally {
    app.cleanup();
  }
});

test('terminal diagnostics disclose grouped causes, copy and download a sanitized Minecraft-style log, and preserve forced retry', async () => {
  const catalog = JSON.parse(await readFile(new URL('v3/_locales/en/messages.json', root), 'utf8'));
  const app = await installPopup(catalog, {}, 'diagnostic-log');
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;
  const createElement = app.document.createElement;
  let copied = '';
  let download;
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {clipboard: {writeText: async text => copied = text}}
    });
    const incidentId = 'ATD-DIAGNOSTIC-1';
    app.state.diagnostic = {
      command: 'discard-tabs',
      durationMs: 412,
      endedAt: 1_725_000_000_412,
      forced: true,
      groups: [{
        code: 'TAB_FAILED',
        count: 47,
        reasonCode: 'NATIVE_TIMEOUT',
        stage: 'native-discard',
        status: 'failed'
      }, {
        code: 'TAB_PROTECTED',
        count: 19,
        reasonCode: 'PROTECTION_RULE',
        stage: 'eligibility',
        status: 'skipped'
      }, {
        code: 'TAB_FAILED',
        count: 999,
        reasonCode: 'SECRET_PRIVATE_REASON',
        stage: 'https-secret.invalid',
        status: 'failed'
      }],
      id: incidentId,
      runtime: {browserFamily: 'Edge', extensionVersion: '0.6.9.2'},
      startedAt: 1_725_000_000_000,
      state: 'failed',
      summary: {failed: 47, skipped: 19, success: 0},
      total: 66
    };
    app.state.diagnosticText = [
      '[2026-08-14T00:00:00.000Z] [PopupCommand/INFO]: command=discard-tabs',
      '[2026-08-14T00:00:00.412Z] [PopupCommand/ERROR]: native-discard / NATIVE_TIMEOUT count=47',
      '[2026-08-14T00:00:00.412Z] [PopupCommand/WARN]: eligibility / PROTECTION_RULE count=19'
    ].join('\n');
    app.state.publish({
      checked: true,
      command: 'discard-tabs',
      completed: 66,
      incidentId,
      jobId: 'private-operational-job-id',
      outcomes: {},
      shiftKey: true,
      state: 'failed',
      summary: {failed: 47, skipped: 19, success: 0},
      total: 66,
      windowId: app.selected.windowId
    });
    await tick();

    const toggle = app.document.getElementById('activity-diagnostics-toggle');
    const panel = app.document.getElementById('activity-diagnostics-panel');
    const reasons = app.document.getElementById('activity-diagnostics-reasons');
    const log = app.document.getElementById('activity-diagnostics-log');
    const copy = app.document.getElementById('activity-diagnostics-copy');
    const downloadButton = app.document.getElementById('activity-diagnostics-download');
    const clear = app.document.getElementById('activity-diagnostics-clear');
    const feedback = app.document.getElementById('activity-diagnostics-feedback');
    assert.equal(toggle.hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(panel.hidden, true);
    assert.equal(tabOrder(app.document).includes(copy), false,
      'collapsed diagnostics leaked controls into keyboard order');

    pressKey(toggle, 'Enter');
    await tick();
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(panel.hidden, false);
    assert.match(reasons.textContent,
      /47 failed: native-discard \/ NATIVE_TIMEOUT \(TAB_FAILED\)/);
    assert.match(reasons.textContent,
      /19 skipped: eligibility \/ PROTECTION_RULE \(TAB_PROTECTED\)/);
    assert.doesNotMatch(reasons.textContent, /SECRET_PRIVATE_REASON|secret\.invalid/,
      'popup rendered a non-allowlisted stage or reason code');
    assert.equal(log.textContent, app.state.diagnosticText);
    assert.doesNotMatch(`${reasons.textContent}\n${log.textContent}`, /selected\.example|windowId|tabId/);

    pressKey(copy, ' ');
    await tick();
    assert.equal(copied, app.state.diagnosticText);
    assert.equal(feedback.textContent, 'Diagnostic log copied.');
    assert.equal(app.document.activeElement, copy, 'copy feedback stole focus');

    URL.createObjectURL = () => 'blob:sanitized-diagnostic';
    URL.revokeObjectURL = () => {};
    app.document.createElement = name => {
      assert.equal(name, 'a');
      return {
        click() {
          download = {download: this.download, href: this.href, type: this.type};
        }
      };
    };
    pressKey(downloadButton, 'Enter');
    await tick();
    assert.deepEqual(download, {
      download: 'latest.log',
      href: 'blob:sanitized-diagnostic',
      type: 'text/plain'
    });
    assert.equal(feedback.textContent, 'Diagnostic log download started.');
    app.document.createElement = createElement;

    const retry = app.document.getElementById('activity-retry');
    pressKey(retry, 'Enter');
    await tick();
    assert.equal(app.state.popupRequests.at(-1).checked, true);
    assert.equal(app.state.popupRequests.at(-1).shiftKey, true);
    assert.equal(app.state.popupRequests.at(-1).incognito, false);

    // Restore the diagnostic after Retry replaced it, then verify explicit
    // clearing removes the disclosure without moving focus into hidden content.
    app.state.diagnostic.id = incidentId;
    app.state.publish({
      checked: true,
      command: 'discard-tabs',
      completed: 66,
      incidentId,
      jobId: 'another-private-job-id',
      outcomes: {},
      shiftKey: true,
      state: 'failed',
      summary: {failed: 47, skipped: 19, success: 0},
      total: 66,
      windowId: app.selected.windowId
    });
    await tick();
    pressKey(toggle, 'Enter');
    await tick();
    pressKey(clear, 'Enter');
    await tick();
    assert.equal(app.state.clearRequests.length, 1);
    assert.equal(toggle.hidden, true);
    assert.equal(app.document.activeElement, app.document.getElementById('activity-status'));
    assert.equal(app.document.getElementById('activity-announcement').textContent,
      'Diagnostics cleared.');
    assert.deepEqual(auditPopupAccessibility(app.document), []);
  }
  finally {
    app.document.createElement = createElement;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    }
    else {
      delete globalThis.navigator;
    }
    app.cleanup();
  }
});

test('disabled scopes are natively inert and pseudo-localized RTL content retains logical layout', async () => {
  const [catalog, css] = await Promise.all([
    readFile(new URL('v3/_locales/en/messages.json', root), 'utf8').then(JSON.parse),
    readFile(new URL('v3/data/popup/index.css', root), 'utf8')
  ]);
  const app = await installPopup(catalog, {
    direction: 'rtl',
    pseudo: true,
    suspended: false,
    url: 'edge://settings/'
  }, 'rtl-disabled');
  try {
    assert.equal(app.document.documentElement.dir, 'rtl');
    assert.ok(app.document.querySelector('[data-cmd=discard-window]').textContent.length > 100);
    assert.deepEqual(auditPopupAccessibility(app.document), []);
    for (const command of [
      'release-window', 'release-rights', 'release-lefts', 'release-other-windows', 'release-tabs'
    ]) {
      const control = app.document.querySelector(`[data-cmd=${command}]`);
      assert.equal(control.disabled, true);
      assert.equal(control.getAttribute('aria-disabled'), 'true');
      assert.equal(control.classList.contains('disabled'), true);
      assert.equal(tabOrder(app.document).includes(control), false);
      const before = app.state.popupRequests.length;
      pressKey(control, 'Enter');
      assert.equal(app.state.popupRequests.length, before);
    }
    for (const control of [
      app.document.querySelector('[data-cmd=whitelist-session]'),
      app.document.querySelector('[data-cmd=whitelist-domain]'),
      app.document.getElementById('allowed')
    ]) {
      assert.equal(control.disabled, true, 'unsupported-site control is still keyboard enabled');
      assert.equal(control.getAttribute('aria-disabled'), 'true');
    }

    const rules = parseCss(css);
    assert.equal(declarationsFor(rules, 'body')['overflow-wrap'], 'anywhere');
    assert.equal(declarationsFor(rules, 'li.group')['grid-template-columns'], 'minmax(0, 1fr) min-content');
    assert.equal(declarationsFor(rules, '.mlt')['grid-template-columns'],
      'minmax(0, 1fr) minmax(7.5rem, 45%)');
    assert.equal(declarationsFor(rules, '.mlt > span')['grid-row'], '1 / span 2');
    assert.equal(declarationsFor(rules, '.mlt > label')['display'], 'grid');
    assert.equal(declarationsFor(rules, '.mlt > label')['grid-template-columns'],
      'auto minmax(0, 1fr)');
    assert.equal(declarationsFor(rules, '.mlt > label > span')['word-break'], 'normal');
    assert.notEqual(declarationsFor(rules, '.mlt > label')['display'], 'contents');
    assert.equal(declarationsFor(rules, 'button.row')['white-space'], 'normal');
    assert.equal(declarationsFor(rules, '[data-cmd=move-next] svg')['margin-inline-start'], '5px');
    assert.equal(declarationsFor(rules, '[data-cmd=move-previous] svg')['margin-inline-end'], '5px');
    assert.equal(declarationsFor(rules, 'button:focus-visible')['outline'], '3px solid var(--focus)');
    assert.equal(declarationsFor(rules, 'button:focus-visible')['outline-offset'], '2px');
    const themes = rules.filter(rule => rule.selector === ':root').map(rule => rule.declarations);
    assert.equal(themes.length, 2);
    for (const theme of themes) {
      assert.ok(contrast(theme['--focus'], theme['--bg']) >= 3, 'focus ring fails 3:1 against page background');
      assert.ok(contrast(theme['--focus'], theme['--button']) >= 3, 'focus ring fails 3:1 against button background');
    }
  }
  finally {
    app.cleanup();
  }
});

test('popup tab-query errors and malformed results render a localized fail-closed state', async () => {
  const catalog = JSON.parse(await readFile(new URL('v3/_locales/en/messages.json', root), 'utf8'));
  const logged = [];
  const originalError = console.error;
  console.error = (...values) => logged.push(values);
  try {
    for (const [nonce, options] of [
      ['query-error', {queryFailure: true}],
      ['query-malformed', {queryMalformed: true}]
    ]) {
      const app = await installPopup(catalog, options, nonce, 'failed');
      try {
        assert.equal(app.document.getElementById('activity').hidden, false);
        assert.equal(app.document.getElementById('activity').getAttribute('aria-busy'), 'false');
        assert.equal(app.document.getElementById('activity-status').textContent,
          chromeMessage(catalog, 'popup_error_command_failed'));
        assert.equal(app.document.getElementById('activity-announcement').textContent,
          chromeMessage(catalog, 'popup_error_command_failed'));
        assert.equal(app.document.documentElement.dataset.selectedTabId, '');
        assert.equal(app.document.documentElement.dataset.selectedWindowId, '');
        for (const control of app.document.querySelectorAll('[data-cmd], #allowed, #tmp_disable')) {
          assert.equal(control.disabled, true, `${control.dataset.cmd || control.id} did not fail closed`);
          assert.equal(control.getAttribute('aria-disabled'), 'true');
        }
        assert.deepEqual(auditPopupAccessibility(app.document), []);
      }
      finally {
        app.cleanup();
      }
    }
    assert.equal(logged.length, 2, 'each initialization failure should produce one developer-console record');
  }
  finally {
    console.error = originalError;
  }
});
