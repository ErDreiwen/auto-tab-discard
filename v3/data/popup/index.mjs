import {match} from '../../worker/core/utils.mjs';
import {releaseAvailability, releaseCommands} from '../../worker/core/command-scope.mjs';
import {
  announcementKey,
  responseErrorText,
  statusText,
  summaryText
} from './messages.mjs';

// localization
document.documentElement.dir = chrome.i18n.getMessage('@@bidi_dir') || 'ltr';
document.documentElement.lang = chrome.i18n.getMessage('@@ui_locale') || 'en';
[...document.querySelectorAll('[data-i18n]')].forEach(e => {
  const message = chrome.i18n.getMessage(e.dataset.i18n);
  e[e.dataset.i18nValue || 'textContent'] = message;
  if (e.dataset.i18nValue === 'title' && e.matches('button')) {
    e.setAttribute('aria-label', message);
  }
});
[...document.querySelectorAll('[data-i18n-title]')].forEach(e => {
  e.title = chrome.i18n.getMessage(e.dataset.i18nTitle);
});

let tab;
let pendingCommand = false;
let renderedAnnouncement = '';
let activeSnapshot;
let lastCommand;
let lastTrigger;
const progressCommands = new Set([
  'discard-tab', 'discard-tree', 'discard-tabs', 'discard-window',
  'discard-other-windows', 'discard-lefts', 'discard-rights',
  'release-tabs', 'release-window', 'release-other-windows',
  'release-lefts', 'release-rights'
]);
const activity = document.getElementById('activity');
const activityProgress = document.getElementById('activity-progress');
const activityStatus = document.getElementById('activity-status');
const activitySummary = document.getElementById('activity-summary');
const activityCancel = document.getElementById('activity-cancel');
const activityRetry = document.getElementById('activity-retry');
const getMessage = (key, substitutions) => chrome.i18n.getMessage(key, substitutions);
const busyState = snapshot => snapshot && ['running', 'cancelling'].includes(snapshot.state);
const retryableState = snapshot => snapshot &&
  ['cancelled', 'failed', 'interrupted', 'partial'].includes(snapshot.state);
const focusControl = control => {
  if (control && control.hidden !== true && control.disabled !== true &&
      typeof control.focus === 'function') {
    control.focus({preventScroll: true});
    return true;
  }
  return false;
};

const setConflictingControlsDisabled = disabled => {
  for (const control of document.querySelectorAll('[data-cmd], #allowed, #tmp_disable')) {
    if (disabled) {
      if (control.dataset.activityPreviousDisabled === undefined) {
        control.dataset.activityPreviousDisabled = String(control.disabled === true);
      }
      control.disabled = true;
      control.setAttribute('aria-disabled', 'true');
    }
    else if (control.dataset.activityPreviousDisabled !== undefined) {
      const previous = control.dataset.activityPreviousDisabled === 'true';
      control.disabled = previous;
      control.setAttribute('aria-disabled', String(previous));
      delete control.dataset.activityPreviousDisabled;
    }
  }
};

const setRegionDisabled = (region, disabled = true) => {
  if (!region) {
    return;
  }
  region.dataset.disabled = String(disabled);
  for (const control of region.querySelectorAll('button, input, select')) {
    control.disabled = disabled;
    control.setAttribute('aria-disabled', String(disabled));
  }
};

const renderSnapshot = snapshot => {
  if (!snapshot || (Number.isInteger(snapshot.windowId) &&
      Number.isInteger(tab?.windowId) && snapshot.windowId !== tab.windowId)) {
    return;
  }
  const previousState = activeSnapshot?.state;
  const previousJobId = activeSnapshot?.jobId;
  activeSnapshot = snapshot;
  if (!lastCommand && snapshot.command) {
    lastCommand = {
      checked: false,
      cmd: snapshot.command,
      shiftKey: false
    };
  }
  if (snapshot.jobId !== 'pending') {
    pendingCommand = false;
  }
  const busy = busyState(snapshot);
  activity.hidden = false;
  activity.setAttribute('aria-busy', String(busy));
  activityProgress.max = Math.max(1, Number(snapshot.total) || 0);
  activityProgress.value = Math.min(activityProgress.max, Number(snapshot.completed) || 0);
  activitySummary.textContent = summaryText(snapshot, getMessage);
  activityCancel.hidden = !busy;
  activityCancel.disabled = snapshot.state !== 'running' || !snapshot.jobId || snapshot.jobId === 'pending';
  activityCancel.setAttribute('aria-disabled', String(activityCancel.disabled));
  activityRetry.hidden = !retryableState(snapshot) || !lastCommand;
  activityRetry.disabled = busy || !lastCommand;
  activityRetry.setAttribute('aria-disabled', String(activityRetry.disabled));
  setConflictingControlsDisabled(busy);

  const key = announcementKey(snapshot);
  if (key !== renderedAnnouncement) {
    renderedAnnouncement = key;
    activityStatus.textContent = statusText(snapshot, getMessage);
  }

  // Do not steal focus for each progress tick. Move it only when the command
  // crosses a meaningful state boundary or the browser left focus on a control
  // that we just disabled.
  if (previousState !== snapshot.state || document.activeElement?.disabled === true ||
      (previousJobId === 'pending' && snapshot.jobId !== 'pending')) {
    if (snapshot.state === 'running') {
      focusControl(activityCancel) || focusControl(activityStatus);
    }
    else if (snapshot.state === 'cancelling') {
      focusControl(activityStatus);
    }
    else if (retryableState(snapshot)) {
      focusControl(activityRetry) || focusControl(activityStatus);
    }
    else if (snapshot.state === 'complete') {
      focusControl(lastTrigger) || focusControl(activityStatus);
    }
  }
};

const showLocalizedError = response => {
  pendingCommand = false;
  activeSnapshot = undefined;
  setConflictingControlsDisabled(false);
  activity.hidden = false;
  activity.setAttribute('aria-busy', 'false');
  activityProgress.value = 0;
  activitySummary.textContent = '';
  activityCancel.hidden = true;
  activityCancel.disabled = true;
  activityCancel.setAttribute('aria-disabled', 'true');
  activityRetry.hidden = !lastCommand;
  activityRetry.disabled = !lastCommand;
  activityRetry.setAttribute('aria-disabled', String(activityRetry.disabled));
  const text = responseErrorText(response, getMessage);
  const key = `error:${response?.code || response?.errorCode || 'POPUP_COMMAND_FAILED'}:${text}`;
  if (key !== renderedAnnouncement) {
    renderedAnnouncement = key;
    activityStatus.textContent = text;
  }
  focusControl(activityRetry) || focusControl(activityStatus);
};

const runtimeMessage = request => new Promise(resolve => {
  try {
    chrome.runtime.sendMessage(request, response => {
      const error = chrome.runtime.lastError;
      resolve(error ? {code: 'POPUP_COMMAND_FAILED', ok: false} : response);
    });
  }
  catch (error) {
    resolve({code: 'POPUP_COMMAND_FAILED', ok: false});
  }
});

// works on all highlighted tabs in the current window
const allowed = document.getElementById('allowed');
allowed.addEventListener('change', () => chrome.tabs.query({
  currentWindow: true,
  highlighted: true
}, async tabs => {
  for (const tab of tabs) {
    await new Promise(resolve => chrome.tabs.update(tab.id, {
      autoDiscardable: allowed.checked === false
    }, resolve));
  }
  chrome.runtime.sendMessage({
    method: 'run-check-on-action',
    ids: tabs.map(t => t.id)
  });
}));

const whitelist = {
  always: document.querySelector('[data-cmd=whitelist-domain]'),
  session: document.querySelector('[data-cmd=whitelist-session]')
};

const queryTabs = options => new Promise(resolve => chrome.tabs.query(options, resolve));
const queryTakeoverSnapshot = () => new Promise(resolve => {
  try {
    chrome.runtime.sendMessage({method: 'takeover-snapshot'}, response => {
      const error = chrome.runtime.lastError;
      resolve(error || response?.ok !== true || !Array.isArray(response.value) ? [] : response.value);
    });
  }
  catch (e) {
    resolve([]);
  }
});

const init = async () => {
  chrome.alarms.get('tmp.disable', a => {
    chrome.runtime.sendMessage({
      'method': 'storage',
      'managed': {
        'tmp_disable': 0
      }
    }, prefs => {
      document.getElementById('tmp_disable').value = a ? prefs['tmp_disable'] : 0;
    });
  });

  const activeTabs = await queryTabs({
    active: true,
    currentWindow: true
  });
  if (activeTabs.length) {
    tab = activeTabs[0];

    try {
      const {protocol = '', hostname} = new URL(tab.url);

      if (protocol.startsWith('http') || protocol.startsWith('ftp')) {
        chrome.runtime.sendMessage({
          'method': 'storage',
          'managed': {
            'whitelist': []
          },
          'session': {
            'whitelist.session': []
          }
        }, prefs => {
          whitelist.session.checked = match(prefs['whitelist.session'], hostname, tab.url) ? true : false;
          whitelist.always.checked = match(prefs['whitelist'], hostname, tab.url) ? true : false;
        });
        if (tab.autoDiscardable === false) {
          allowed.checked = true;
        }
        chrome.scripting.executeScript({
          target: {
            tabId: tab.id
          },
          func: () => document.title
        }).catch(e => {
          console.warn('Cannot access to this tab', e);
          setRegionDisabled(allowed.parentElement);
        });
      }
      else {
        throw Error('no HTTP');
      }
    }
    catch (e) {
      // on navigation
      setRegionDisabled(whitelist.session.closest('.mlt'));
      setRegionDisabled(allowed.parentElement);
    }
  }

  /* Disable release controls using the exact same scope as worker execution. */
  const toggle = (cmd, disabled) => {
    const control = document.querySelector(`[data-cmd=${cmd}]`);
    control.classList.toggle('disabled', disabled);
    control.disabled = disabled;
    control.setAttribute('aria-disabled', String(disabled));
  };
  const available = await releaseAvailability(queryTabs, tab, queryTakeoverSnapshot);
  releaseCommands.forEach(command => toggle(command, available[command] === false));
  // This also gives automated popup hosts an authoritative readiness boundary:
  // the selected tab/window has been captured before any surrogate is moved
  // out of the command scope. It has no effect on a browser-action popup.
  document.documentElement.dataset.popupReady = 'true';
  document.documentElement.dataset.selectedTabId = Number.isInteger(tab?.id) ? String(tab.id) : '';
  document.documentElement.dataset.selectedWindowId = Number.isInteger(tab?.windowId) ? String(tab.windowId) : '';
  const activityResponse = await runtimeMessage({
    method: 'popup-progress-snapshot',
    tabId: tab?.id,
    windowId: tab?.windowId
  });
  if (activityResponse?.ok === true && activityResponse.value) {
    renderSnapshot(activityResponse.value);
  }
};
init().catch(e => console.error('popup initialization failed', e));

const executeCommand = (request, trigger, {preserveTrigger = false} = {}) => {
  const cmd = request?.cmd;
  if (!cmd || pendingCommand || busyState(activeSnapshot)) {
    return false;
  }
  lastCommand = {
    checked: request.checked === true,
    cmd,
    shiftKey: request.shiftKey === true
  };
  if (!preserveTrigger) {
    lastTrigger = trigger;
  }
  renderedAnnouncement = '';
  activityRetry.hidden = true;
  activityRetry.disabled = true;
  activityRetry.setAttribute('aria-disabled', 'true');

  if (cmd === 'open-options') {
    chrome.runtime.openOptionsPage();
    window.close();
  }
  else if (cmd.startsWith('move-') || cmd === 'close') {
    activity.hidden = true;
    chrome.runtime.sendMessage({
      method: cmd,
      cmd
    }, response => {
      if (!response?.ok) {
        showLocalizedError(response);
      }
      else {
        init();
      }
    });
  }
  else {
    if (progressCommands.has(cmd)) {
      pendingCommand = true;
      setConflictingControlsDisabled(true);
      renderSnapshot({
        command: cmd,
        completed: 0,
        jobId: 'pending',
        state: 'running',
        summary: {failed: 0, skipped: 0, success: 0},
        total: 0,
        windowId: tab?.windowId
      });
    }
    else {
      activity.hidden = true;
    }
    chrome.runtime.sendMessage({
      method: 'popup',
      cmd,
      tabId: tab?.id,
      windowId: tab?.windowId,
      shiftKey: request.shiftKey === true,
      checked: request.checked === true
    }, response => {
      const error = chrome.runtime.lastError;
      if (error || response?.ok === false) {
        showLocalizedError({code: response?.code || 'POPUP_COMMAND_FAILED'});
      }
      else if (progressCommands.has(cmd)) {
        renderSnapshot(response.value);
      }
      else {
        init();
      }
    });
  }
  return true;
};

document.addEventListener('click', e => {
  const target = e.target.closest('[data-cmd]');
  if (!target || target.disabled === true) {
    return;
  }
  executeCommand({
    checked: target.checked,
    cmd: target.dataset.cmd,
    shiftKey: e.shiftKey
  }, target);
});

activityCancel.addEventListener('click', async () => {
  if (!activeSnapshot?.jobId || activeSnapshot.jobId === 'pending' ||
      !['running', 'cancelling'].includes(activeSnapshot.state)) {
    return;
  }
  activityCancel.disabled = true;
  activityCancel.setAttribute('aria-disabled', 'true');
  focusControl(activityStatus);
  const response = await runtimeMessage({
    jobId: activeSnapshot.jobId,
    method: 'popup-progress-cancel'
  });
  if (response?.ok === true && response.value?.snapshot) {
    renderSnapshot(response.value.snapshot);
  }
  else if (response?.ok === false) {
    showLocalizedError(response);
  }
});

activityRetry.addEventListener('click', () => {
  if (!lastCommand || activityRetry.disabled === true) {
    return;
  }
  executeCommand(lastCommand, lastTrigger, {preserveTrigger: true});
});

chrome.runtime.onMessage.addListener(request => {
  if (request?.method === 'popup-progress-update') {
    renderSnapshot(request.snapshot);
  }
});

document.getElementById('tmp_disable').addEventListener('change', e => {
  chrome.storage.local.set({
    'tmp_disable': Number(e.target.value)
  });
});
