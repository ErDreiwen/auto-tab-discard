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
  direction = 'ltr',
  pseudo = false,
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
    incognito: false,
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
    closed: false,
    failNextPopup: false,
    held: undefined,
    holdNextPopup: false,
    messages: [],
    openedOptions: false,
    popupRequests: [],
    runtimeListeners: []
  };
  const snapshot = (request, nextState = 'complete') => ({
    command: request.cmd,
    completed: 1,
    errorCode: nextState === 'cancelled' ? 'POPUP_CANCELLED' : undefined,
    jobId: `job-${request.cmd}`,
    state: nextState,
    summary: nextState === 'complete' ? {failed: 0, skipped: 0, success: 1} :
      {failed: 0, skipped: 1, success: 0},
    total: 1,
    windowId: request.windowId
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
            respond(callback, {ok: true, value: snapshot(request)});
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
    held?.callback({ok: true, value: snapshot(held.request, nextState)});
  };
  return {chrome, selected, state};
};

const installPopup = async (catalog, options, nonce) => {
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
  for (let attempt = 0; attempt < 20 && document.documentElement.dataset.popupReady !== 'true'; attempt += 1) {
    await tick();
  }
  assert.equal(document.documentElement.dataset.popupReady, 'true', 'popup initialization did not settle');
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
    assert.equal(status.getAttribute('role'), 'status');
    assert.equal(status.getAttribute('aria-live'), 'polite');
    assert.match(status.textContent, /Finished with some tabs not completed/);
    assert.match(status.textContent, /1 tab\(s\) stayed loaded because no safe keeper tab was available/);
    assert.match(status.textContent, /1 tab\(s\) were converted to extension-owned native discards/);
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

    assert.match(status.textContent, /remained frozen after the release reload/);
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
