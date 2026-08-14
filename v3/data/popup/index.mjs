import {match, query as queryTabs} from '../../worker/core/utils.mjs';
import {releaseAvailability, releaseCommands} from '../../worker/core/command-scope.mjs';
import {boundedRuntimeMessage, withDeadline} from '../common/runtime-call.mjs';
import {
  failureCauseFrom,
  failureCausePolicy,
  matchesFailureCausePolicy
} from '../../worker/core/failure-causes.mjs';
import {
  announcementKey,
  diagnosticReasonMessages,
  diagnosticRowText,
  responseErrorText,
  statusHeadlineText,
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
let activeDiagnostic;
let diagnosticExportText = '';
let diagnosticRequestSequence = 0;
const progressCommands = new Set([
  'discard-tab', 'discard-tree', 'discard-tabs', 'discard-window',
  'discard-other-windows', 'discard-lefts', 'discard-rights',
  'release-tabs', 'release-window', 'release-other-windows',
  'release-lefts', 'release-rights'
]);
const activity = document.getElementById('activity');
const activityProgress = document.getElementById('activity-progress');
const activityStatus = document.getElementById('activity-status');
const activityAnnouncement = document.getElementById('activity-announcement');
const activitySummary = document.getElementById('activity-summary');
const activityCancel = document.getElementById('activity-cancel');
const activityRetry = document.getElementById('activity-retry');
const diagnosticsToggle = document.getElementById('activity-diagnostics-toggle');
const diagnosticsPanel = document.getElementById('activity-diagnostics-panel');
const diagnosticsIncident = document.getElementById('activity-diagnostics-incident');
const diagnosticsReasons = document.getElementById('activity-diagnostics-reasons');
const diagnosticsLog = document.getElementById('activity-diagnostics-log');
const diagnosticsCopy = document.getElementById('activity-diagnostics-copy');
const diagnosticsDownload = document.getElementById('activity-diagnostics-download');
const diagnosticsClear = document.getElementById('activity-diagnostics-clear');
const diagnosticsFeedback = document.getElementById('activity-diagnostics-feedback');
const getMessage = (key, substitutions) => chrome.i18n.getMessage(key, substitutions);
const busyState = snapshot => snapshot && ['running', 'cancelling'].includes(snapshot.state);
const retryableState = snapshot => snapshot &&
  ['cancelled', 'failed', 'interrupted', 'partial'].includes(snapshot.state);
const diagnosticState = snapshot => snapshot &&
  ['cancelled', 'complete', 'failed', 'interrupted', 'partial'].includes(snapshot.state);
const focusControl = control => {
  if (control && control.hidden !== true && control.disabled !== true &&
      typeof control.focus === 'function') {
    control.focus({preventScroll: true});
    return true;
  }
  return false;
};

const MAX_DIAGNOSTIC_TEXT = 256 * 1024;
const diagnosticKinds = Object.freeze({
  POPUP_BUSY: ['failed', 'command', 'BUSY'],
  POPUP_CANCELLED: ['skipped', 'command', 'CANCELLED'],
  POPUP_COMMAND_FAILED: ['failed', 'command', 'COMMAND_FAILED'],
  POPUP_INTERRUPTED: ['failed', 'command', 'INTERRUPTED'],
  POPUP_NO_ACTIVE_TAB: ['failed', 'command', 'NO_ACTIVE_TAB'],
  POPUP_TARGET_CHANGED: ['failed', 'command', 'TARGET_CHANGED'],
  TAB_ALREADY_OWNED: ['skipped', 'ownership', 'ALREADY_OWNED'],
  TAB_ALREADY_OWNED_VISUAL_UNAVAILABLE: ['skipped', 'visual-marker', 'VISUAL_UNAVAILABLE'],
  TAB_CANCELLED: ['skipped', 'command', 'CANCELLED'],
  TAB_DISCARDED: ['success', 'tab-operation', 'DISCARDED'],
  TAB_DISCARDED_VISUAL_UNAVAILABLE: ['success', 'visual-marker', 'VISUAL_UNAVAILABLE'],
  TAB_FAILED: ['failed', 'tab-operation', 'OPERATION_FAILED'],
  TAB_MISSING: ['skipped', 'eligibility', 'TARGET_MISSING'],
  TAB_NO_SAFE_KEEPER: ['skipped', 'keeper', 'NO_SAFE_KEEPER'],
  TAB_OWNERSHIP_UNKNOWN: ['failed', 'verification', 'OWNERSHIP_UNKNOWN'],
  TAB_PROTECTED: ['skipped', 'eligibility', 'PROTECTION_RULE'],
  TAB_RELEASED: ['success', 'release', 'RELEASED'],
  TAB_RELEASE_REMAINS_FROZEN: ['failed', 'release', 'POSTCONDITION_NOT_MET'],
  TAB_SKIPPED: ['skipped', 'eligibility', 'NOT_ELIGIBLE'],
  TAB_SUSPENSION_UNKNOWN: ['failed', 'verification', 'SUSPENSION_UNKNOWN'],
  TAB_UNSUPPORTED: ['failed', 'eligibility', 'UNSUPPORTED_PAGE']
});
const genericDiagnosticCodes = new Set(['POPUP_COMMAND_FAILED', 'TAB_FAILED']);
const safeIncidentId = value => typeof value === 'string' &&
  /^ATD-[A-Z0-9]+(?:-[A-Z0-9]+){1,4}$/.test(value) && value.length <= 80 ? value : '';
const safeCount = value => Number.isInteger(value) && value > 0 && value <= 1_000_000 ? value : 0;

const normalizeDiagnosticGroup = value => {
  const code = typeof value?.code === 'string' && diagnosticReasonMessages[value.code] &&
    diagnosticKinds[value.code] ? value.code : '';
  const count = safeCount(value?.count);
  if (!code || !count) {
    return undefined;
  }
  const [status, defaultStage, defaultReasonCode] = diagnosticKinds[code];
  const suppliedStatus = value?.status === 'succeeded' ? 'success' : value?.status;
  if (suppliedStatus !== status) {
    return undefined;
  }
  let stage = defaultStage;
  let reasonCode = defaultReasonCode;
  if (genericDiagnosticCodes.has(code)) {
    const hasProjectedPolicy = Object.hasOwn(value, 'stage') || Object.hasOwn(value, 'reasonCode');
    if (hasProjectedPolicy) {
      if (!matchesFailureCausePolicy(value.stage, value.reasonCode)) {
        return undefined;
      }
      stage = value.stage;
      reasonCode = value.reasonCode;
    }
    else {
      [stage, reasonCode] = failureCausePolicy(failureCauseFrom(value));
    }
  }
  else if ((value.stage && value.stage !== stage) ||
      (value.reasonCode && value.reasonCode !== reasonCode)) {
    return undefined;
  }
  return {
    code,
    count,
    reasonCode,
    stage,
    status
  };
};

const diagnosticGroupsFromSnapshot = snapshot => {
  const grouped = new Map();
  for (const outcome of Object.values(snapshot?.outcomes || {})) {
    const group = normalizeDiagnosticGroup({...outcome, count: 1});
    if (!group) {
      continue;
    }
    const key = `${group.status}:${group.code}:${group.stage}:${group.reasonCode}`;
    grouped.set(key, {...group, count: (grouped.get(key)?.count || 0) + 1});
  }
  if (grouped.size === 0 && diagnosticReasonMessages[snapshot?.errorCode]) {
    const status = snapshot?.state === 'cancelled' ? 'skipped' : 'failed';
    const group = normalizeDiagnosticGroup({
      code: snapshot.errorCode,
      count: 1,
      failureCause: failureCauseFrom(snapshot, undefined, 'errorCause'),
      status
    });
    if (group) {
      grouped.set(`${status}:${group.code}:${group.stage}:${group.reasonCode}`, group);
    }
  }
  return [...grouped.values()];
};

const sortedDiagnosticGroups = groups => groups.map(normalizeDiagnosticGroup).filter(Boolean)
  .sort((a, b) => {
    const severity = {failed: 0, skipped: 1, success: 2};
    return (severity[a.status] ?? 3) - (severity[b.status] ?? 3) ||
      b.count - a.count || a.code.localeCompare(b.code);
  });

const normalizeDiagnosticIncident = (value, fallback = {}) => {
  value = value?.incident && typeof value.incident === 'object' ? value.incident : value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  // Worker incidents expose `id`; `incidentId` belongs only to the popup
  // progress snapshot supplied as an explicit fallback. Do not accept schema
  // aliases here, because that would widen the privacy boundary over time.
  const incidentId = safeIncidentId(value.id) ||
    (!Object.hasOwn(value, 'id') ? safeIncidentId(fallback.incidentId) : '');
  if (!incidentId) {
    return undefined;
  }
  const candidates = Array.isArray(value.groups) ? value.groups : fallback.groups || [];
  const groups = sortedDiagnosticGroups(candidates);
  const state = diagnosticState(value) ? value.state : undefined;
  const summary = ['failed', 'skipped', 'success'].every(key =>
    Number.isInteger(value?.summary?.[key]) && value.summary[key] >= 0
  ) ? {
      failed: value.summary.failed,
      skipped: value.summary.skipped,
      success: value.summary.success
    } : undefined;
  return {
    groups,
    incidentId,
    ...(state && {state}),
    ...(summary && {summary})
  };
};

const panelContainsFocus = () => [...diagnosticsPanel.querySelectorAll('button, input, select')]
  .includes(document.activeElement) || document.activeElement === diagnosticsLog;

const collapseDiagnostics = ({moveFocus = false} = {}) => {
  if (moveFocus && panelContainsFocus()) {
    focusControl(diagnosticsToggle) || focusControl(activityStatus);
  }
  diagnosticsPanel.hidden = true;
  diagnosticsToggle.setAttribute('aria-expanded', 'false');
  diagnosticsToggle.textContent = getMessage('popup_diagnostics_show');
};

const resetDiagnostics = ({moveFocus = false} = {}) => {
  if (moveFocus && panelContainsFocus()) {
    focusControl(activityStatus);
  }
  collapseDiagnostics();
  activeDiagnostic = undefined;
  diagnosticExportText = '';
  diagnosticsToggle.hidden = true;
  diagnosticsToggle.disabled = true;
  diagnosticsToggle.setAttribute('aria-disabled', 'true');
  diagnosticsIncident.textContent = '';
  diagnosticsReasons.textContent = '';
  diagnosticsLog.textContent = '';
  diagnosticsFeedback.textContent = '';
};

const renderDiagnosticReasons = groups => {
  const rows = groups.map(group => diagnosticRowText(group, getMessage));
  diagnosticsReasons.textContent = '';
  if (typeof document.createElement !== 'function') {
    diagnosticsReasons.textContent = rows.join('\n');
    return;
  }
  for (const row of rows) {
    const item = document.createElement('li');
    item.textContent = row;
    diagnosticsReasons.appendChild(item);
  }
};

const renderDiagnosticIncident = incident => {
  activeDiagnostic = incident;
  diagnosticsIncident.textContent = incident.incidentId;
  renderDiagnosticReasons(incident.groups);
  diagnosticsToggle.hidden = false;
  diagnosticsToggle.disabled = false;
  diagnosticsToggle.setAttribute('aria-disabled', 'false');
};

const responseValue = response => response?.ok === true && Object.hasOwn(response, 'value') ?
  response.value : response;
const withDiagnosticContext = request => ({
  ...request,
  ...(Number.isInteger(tab?.id) && {tabId: tab.id}),
  ...(Number.isInteger(tab?.windowId) && {windowId: tab.windowId})
});

const requestDiagnostic = async (incidentId, fallbackGroups = []) => {
  const sequence = ++diagnosticRequestSequence;
  const request = withDiagnosticContext({method: 'diagnostics-latest'});
  if (safeIncidentId(incidentId)) {
    request.incidentId = incidentId;
  }
  const response = await runtimeMessage(request);
  if (sequence !== diagnosticRequestSequence || response?.ok === false) {
    return undefined;
  }
  const incident = normalizeDiagnosticIncident(responseValue(response), {
    groups: fallbackGroups,
    incidentId
  });
  if (incident && (!incidentId || incident.incidentId === incidentId)) {
    renderDiagnosticIncident(incident);
    return incident;
  }
  if (safeIncidentId(incidentId) && fallbackGroups.length) {
    const fallback = normalizeDiagnosticIncident({groups: fallbackGroups}, {incidentId});
    if (fallback) {
      renderDiagnosticIncident(fallback);
      return fallback;
    }
  }
  return undefined;
};

const renderPersistedDiagnostic = incident => {
  if (!incident || activeSnapshot || !diagnosticState(incident)) {
    return;
  }
  const snapshot = {
    completed: (incident.summary?.success || 0) + (incident.summary?.skipped || 0) +
      (incident.summary?.failed || 0),
    jobId: incident.incidentId,
    state: incident.state,
    summary: incident.summary || {failed: 0, skipped: 0, success: 0},
    total: (incident.summary?.success || 0) + (incident.summary?.skipped || 0) +
      (incident.summary?.failed || 0)
  };
  activity.hidden = false;
  activity.setAttribute('aria-busy', 'false');
  activityProgress.hidden = true;
  activitySummary.textContent = summaryText(snapshot, getMessage);
  activityCancel.hidden = true;
  activityCancel.disabled = true;
  activityCancel.setAttribute('aria-disabled', 'true');
  activityRetry.hidden = true;
  activityRetry.disabled = true;
  activityRetry.setAttribute('aria-disabled', 'true');
  activityStatus.textContent = statusHeadlineText(snapshot, getMessage);
  activityAnnouncement.textContent = statusText(snapshot, getMessage);
  renderedAnnouncement = `persisted:${incident.incidentId}:${incident.state}`;
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
      checked: snapshot.checked === true,
      cmd: snapshot.command,
      shiftKey: snapshot.shiftKey === true
    };
  }
  if (snapshot.jobId !== 'pending') {
    pendingCommand = false;
  }
  const busy = busyState(snapshot);
  activity.hidden = false;
  activity.setAttribute('aria-busy', String(busy));
  activityProgress.hidden = false;
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
    activityStatus.textContent = statusHeadlineText(snapshot, getMessage);
    activityAnnouncement.textContent = statusText(snapshot, getMessage);
  }

  if (busy) {
    diagnosticRequestSequence += 1;
    resetDiagnostics({moveFocus: true});
  }
  else if (diagnosticState(snapshot) && safeIncidentId(snapshot.incidentId)) {
    const groups = diagnosticGroupsFromSnapshot(snapshot);
    const changed = activeDiagnostic?.incidentId !== snapshot.incidentId;
    if (changed) {
      resetDiagnostics({moveFocus: true});
      const fallback = normalizeDiagnosticIncident({
        groups,
        id: snapshot.incidentId,
        state: snapshot.state,
        summary: snapshot.summary
      });
      if (fallback) {
        renderDiagnosticIncident(fallback);
      }
    }
    void requestDiagnostic(snapshot.incidentId, groups);
  }
  else {
    diagnosticRequestSequence += 1;
    resetDiagnostics({moveFocus: true});
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
  diagnosticRequestSequence += 1;
  resetDiagnostics({moveFocus: true});
  setConflictingControlsDisabled(false);
  activity.hidden = false;
  activity.setAttribute('aria-busy', 'false');
  activityProgress.hidden = false;
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
    activityAnnouncement.textContent = text;
  }
  focusControl(activityRetry) || focusControl(activityStatus);
};

const runtimeMessage = (request, options) => boundedRuntimeMessage(chrome.runtime, request, options);

const updateTab = (id, properties) => new Promise((resolve, reject) => {
  let settled = false;
  const accept = value => {
    if (!value || typeof value !== 'object' || !Number.isInteger(value.id)) {
      reject(Error('tabs.update returned malformed tab data'));
    }
    else {
      resolve(value);
    }
  };
  const callback = (value, compatibilityError) => {
    if (settled) {
      return;
    }
    settled = true;
    const error = chrome.runtime.lastError || compatibilityError;
    if (error) {
      reject(Error(error.message || String(error)));
    }
    else {
      accept(value);
    }
  };
  try {
    const operation = chrome.tabs.update(id, properties, callback);
    if (operation?.then) {
      operation.then(value => {
        if (!settled) {
          settled = true;
          accept(value);
        }
      }, error => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    }
  }
  catch (error) {
    settled = true;
    reject(error);
  }
});

const failClosedInitialization = error => {
  console.error('popup initialization failed', error);
  tab = undefined;
  lastCommand = undefined;
  lastTrigger = undefined;
  showLocalizedError({code: 'POPUP_COMMAND_FAILED', ok: false});
  activityRetry.hidden = true;
  activityRetry.disabled = true;
  activityRetry.setAttribute('aria-disabled', 'true');
  setConflictingControlsDisabled(true);
  document.documentElement.dataset.popupReady = 'failed';
  document.documentElement.dataset.selectedTabId = '';
  document.documentElement.dataset.selectedWindowId = '';
};

// works on all highlighted tabs in the current window
const allowed = document.getElementById('allowed');
allowed.addEventListener('change', async () => {
  try {
    const tabs = await queryTabs({
      currentWindow: true,
      highlighted: true
    });
    for (const tab of tabs) {
      await updateTab(tab.id, {
        autoDiscardable: allowed.checked === false
      });
    }
    chrome.runtime.sendMessage({
      method: 'run-check-on-action',
      ids: tabs.map(t => t.id)
    });
  }
  catch (error) {
    failClosedInitialization(error);
  }
});

const whitelist = {
  always: document.querySelector('[data-cmd=whitelist-domain]'),
  session: document.querySelector('[data-cmd=whitelist-session]')
};

const queryTakeoverSnapshot = selected => new Promise(resolve => {
  try {
    chrome.runtime.sendMessage({
      method: 'takeover-snapshot',
      tabId: selected?.id,
      windowId: selected?.windowId
    }, response => {
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
  if (!activeTabs.length || !Number.isInteger(activeTabs[0]?.id) ||
      !Number.isInteger(activeTabs[0]?.windowId)) {
    throw Error('No valid active tab is available');
  }
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

  /* Disable release controls using the exact same scope as worker execution. */
  const toggle = (cmd, disabled) => {
    const control = document.querySelector(`[data-cmd=${cmd}]`);
    control.classList.toggle('disabled', disabled);
    control.disabled = disabled;
    control.setAttribute('aria-disabled', String(disabled));
  };
  const available = await releaseAvailability(queryTabs, tab, () => queryTakeoverSnapshot(tab));
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
  else {
    const incident = await requestDiagnostic();
    renderPersistedDiagnostic(incident);
  }
};
init().catch(failClosedInitialization);

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
      // The default extension mode spans regular and private windows, where
      // the popup context itself is not marked incognito. The selected tab is
      // authoritative there; retain the context bit for split-mode browsers.
      incognito: tab?.incognito === true || chrome.extension?.inIncognitoContext === true,
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
  }, {timeoutMs: 15_000});
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

const setDiagnosticControlsDisabled = disabled => {
  for (const control of [diagnosticsCopy, diagnosticsDownload, diagnosticsClear]) {
    control.disabled = disabled;
    control.setAttribute('aria-disabled', String(disabled));
  }
};

const diagnosticExport = async () => {
  const incidentId = safeIncidentId(activeDiagnostic?.incidentId);
  if (!incidentId) {
    throw Error('sanitized diagnostic unavailable');
  }
  const response = await runtimeMessage(withDiagnosticContext({
    incidentId,
    method: 'diagnostics-export'
  }));
  if (response?.ok === false) {
    throw Error('sanitized diagnostic export failed');
  }
  const exported = responseValue(response);
  const incident = normalizeDiagnosticIncident(exported?.incident);
  const text = typeof exported?.text === 'string' && exported.text.length > 0 &&
    new TextEncoder().encode(exported.text).byteLength <= MAX_DIAGNOSTIC_TEXT ? exported.text : '';
  if (!incident || incident.incidentId !== incidentId || !text) {
    throw Error('sanitized diagnostic export was invalid');
  }
  activeDiagnostic = incident;
  diagnosticExportText = text;
  renderDiagnosticIncident(incident);
  diagnosticsLog.textContent = text;
  return text;
};

const copyText = async text => {
  if (globalThis.navigator?.clipboard?.writeText) {
    try {
      await withDeadline(() => globalThis.navigator.clipboard.writeText(text), {
        timeoutMessage: 'Clipboard write timed out',
        timeoutMs: 2000
      });
      return;
    }
    catch (error) {}
  }
  if (typeof document.createElement !== 'function' || typeof document.execCommand !== 'function') {
    throw Error('clipboard unavailable');
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('aria-hidden', 'true');
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) {
    throw Error('clipboard rejected copy');
  }
};

const downloadText = text => {
  const objectURL = URL.createObjectURL(new Blob([text], {type: 'text/plain;charset=utf-8'}));
  const anchor = document.createElement('a');
  anchor.download = 'latest.log';
  anchor.href = objectURL;
  anchor.type = 'text/plain';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(objectURL));
};

diagnosticsToggle.addEventListener('click', async () => {
  const opening = diagnosticsToggle.getAttribute('aria-expanded') !== 'true';
  if (!opening) {
    collapseDiagnostics();
    return;
  }
  diagnosticsPanel.hidden = false;
  diagnosticsToggle.setAttribute('aria-expanded', 'true');
  diagnosticsToggle.textContent = getMessage('popup_diagnostics_hide');
  diagnosticsFeedback.textContent = '';
  if (!diagnosticExportText) {
    setDiagnosticControlsDisabled(true);
    try {
      await diagnosticExport();
    }
    catch (error) {
      diagnosticsLog.textContent = getMessage('popup_diagnostics_unavailable');
    }
    finally {
      setDiagnosticControlsDisabled(false);
    }
  }
});

diagnosticsCopy.addEventListener('click', async () => {
  setDiagnosticControlsDisabled(true);
  diagnosticsFeedback.textContent = '';
  try {
    const text = diagnosticExportText || await diagnosticExport();
    await copyText(text);
    diagnosticsFeedback.textContent = getMessage('popup_diagnostics_copied');
  }
  catch (error) {
    diagnosticsFeedback.textContent = getMessage('popup_diagnostics_copy_failed');
  }
  finally {
    setDiagnosticControlsDisabled(false);
  }
});

diagnosticsDownload.addEventListener('click', async () => {
  setDiagnosticControlsDisabled(true);
  diagnosticsFeedback.textContent = '';
  try {
    const text = diagnosticExportText || await diagnosticExport();
    downloadText(text);
    diagnosticsFeedback.textContent = getMessage('popup_diagnostics_downloaded');
  }
  catch (error) {
    diagnosticsFeedback.textContent = getMessage('popup_diagnostics_download_failed');
  }
  finally {
    setDiagnosticControlsDisabled(false);
  }
});

diagnosticsClear.addEventListener('click', async () => {
  setDiagnosticControlsDisabled(true);
  diagnosticsFeedback.textContent = '';
  const response = await runtimeMessage(withDiagnosticContext({method: 'diagnostics-clear'}));
  if (response?.ok === false || response === undefined) {
    diagnosticsFeedback.textContent = getMessage('popup_diagnostics_clear_failed');
    setDiagnosticControlsDisabled(false);
    return;
  }
  activityAnnouncement.textContent = getMessage('popup_diagnostics_cleared');
  diagnosticRequestSequence += 1;
  resetDiagnostics({moveFocus: true});
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
