import {
  commitSettingsImport,
  MAX_BACKUP_BYTES,
  parseSettingsBackup,
  serializeRawSettingsBackup,
  validateSettingsRecord
} from './core/settings-backup.mjs';
import {serializeSupportBundle} from './core/support-bundle.mjs';
import {restoreModeControl} from './core/mode-control.mjs';
import {boundedBrowserCall, boundedRuntimeMessage} from '../common/runtime-call.mjs';
import {createDiagnosticClient} from '../common/diagnostic-client.mjs';
import {FORK_REPOSITORY} from '../../worker/core/lifecycle.mjs';
import {normalizeTitleMarker} from '../../worker/core/marker-title.mjs';
import {
  expandPluginPolicyKeys,
  PLUGIN_KEYS,
  PLUGIN_PREFERENCES
} from '../../worker/core/plugin-catalog.mjs';
import {
  LOCAL_PREFERENCE_MIGRATION_KEYS,
  normalizeToolbarClick,
  overlayPreferenceLayers,
  planLocalPreferenceMigration
} from '../../worker/core/preference-migrations.mjs';
import {validateRuleList} from '../../worker/core/rules.mjs';
import {
  recoverSettingsImport,
  SETTINGS_IMPORT_FENCE_KEY,
  SETTINGS_IMPORT_TRANSACTION_KEY,
  withSettingsImportLock
} from '../../worker/core/settings-import-transaction.mjs';
import {readManagedStorageArea} from '../../worker/core/storage-read.mjs';

'use strict';

const isFirefox = /Firefox/.test(navigator.userAgent);

// localization
[...document.querySelectorAll('[data-i18n]')].forEach(e => {
  const localized = chrome.i18n.getMessage(e.dataset.i18n);
  // New controls retain their explicit English text until a locale receives
  // the corresponding string instead of becoming invisible in that window.
  if (localized) {
    e[e.dataset.i18nValue || 'textContent'] = localized;
  }
});

// memory
if (!window.performance || !window.performance.memory) {
  document.getElementById('memory').style = `
    pointer-events: none;
    opacity: 0.4;
  `;
}
// battery
if (!navigator.getBattery) {
  document.getElementById('battery').style = `
    pointer-events: none;
    opacity: 0.4;
  `;
}

const info = document.getElementById('info');
const diagnosticsInfo = document.getElementById('diagnostics-info');
const frameAccessEnable = document.getElementById('enable-frame-access');
const frameAccessDisable = document.getElementById('disable-frame-access');
const frameAccessInfo = document.getElementById('frame-access-info');
const conflictScanRun = document.getElementById('run-conflict-scan');
const conflictScanRemove = document.getElementById('remove-conflict-scan-access');
const conflictScanInfo = document.getElementById('conflict-scan-info');
let settingsMutating = false;
const diagnosticClient = createDiagnosticClient({runtime: chrome.runtime});
const OPTIONS_API_TIMEOUT = 30_000;

const message = (key, fallback) => chrome.i18n.getMessage(key) || fallback;
const reportError = (key, fallback, error) => {
  info.textContent = `${message(key, fallback)}: ${error?.message || String(error)}`;
};
const reportDiagnosticsError = (key, fallback, error) => {
  diagnosticsInfo.textContent = `${message(key, fallback)}: ${error?.message || String(error)}`;
};

const settleTraceError = (trace, error) => error?.code === 'BROWSER_CALL_TIMEOUT' ||
  error?.code === 'OPTIONS_API_TIMEOUT' ?
  trace.timedOut() : trace.failed();
const call = (target, method, ...args) => boundedBrowserCall(target, method, args, {
  runtime: chrome.runtime,
  timeoutMs: OPTIONS_API_TIMEOUT
});

const FRAME_ACCESS_PERMISSION = Object.freeze({permissions: Object.freeze(['webNavigation'])});
const CONFLICT_SCAN_PERMISSION = Object.freeze({permissions: Object.freeze(['management'])});
const renderFrameAccess = ({available = true, granted = false} = {}) => {
  frameAccessEnable.disabled = !available || granted;
  frameAccessDisable.disabled = !available || !granted;
  frameAccessInfo.textContent = available ? (granted ? message(
    'options_frame_access_enabled',
    'Full framed-page protection is enabled.'
  ) : message(
    'options_frame_access_limited',
    'Optional frame access is off. Bounded same-origin frames are checked; unknown branches stay protected.'
  )) : message(
    'options_frame_access_unavailable',
    'This browser cannot manage optional frame access. Unknown frame branches stay protected.'
  );
};
const refreshFrameAccess = async () => {
  if (typeof chrome.permissions?.contains !== 'function') {
    renderFrameAccess({available: false});
    return;
  }
  try {
    renderFrameAccess({
      granted: await call(chrome.permissions, 'contains', FRAME_ACCESS_PERMISSION)
    });
  }
  catch (e) {
    renderFrameAccess({available: false});
  }
};
const renderConflictAccess = ({available = true, granted = false} = {}) => {
  conflictScanRun.disabled = !available;
  conflictScanRemove.disabled = !available || !granted;
  if (!available) {
    conflictScanInfo.textContent = message(
      'options_conflict_scan_unavailable',
      'This browser cannot run the optional conflict scan.'
    );
  }
  else if (!granted) {
    conflictScanInfo.textContent = message(
      'options_conflict_scan_ready',
      'Scan access is off. It is requested only when you click the scan button.'
    );
  }
};
const refreshConflictAccess = async () => {
  if (typeof chrome.permissions?.contains !== 'function') {
    renderConflictAccess({available: false});
    return;
  }
  try {
    renderConflictAccess({
      granted: await call(chrome.permissions, 'contains', CONFLICT_SCAN_PERMISSION)
    });
  }
  catch (e) {
    renderConflictAccess({available: false});
  }
};
const conflictSummary = result => {
  const counts = result?.counts || {};
  const values = [
    result?.confidence || 'none',
    counts.duplicateCopies || 0,
    counts.externalDiscarders || 0,
    counts.tabManagers || 0,
    counts.externalSleepers || 0,
    counts.externalPlaceholders || 0
  ].map(String);
  return chrome.i18n.getMessage('options_conflict_scan_result', values) ||
    `Conflict likelihood: ${values[0]}. Duplicate copies: ${values[1]}; other discarders: ${values[2]}; tab managers: ${values[3]}; externally discarded tabs: ${values[4]}; external placeholder tabs: ${values[5]}.`;
};

frameAccessEnable.addEventListener('click', () => {
  const trace = diagnosticClient.start({action: 'ENABLE_FRAME_ACCESS'});
  trace.click();
  trace.request();
  // The browser requires request() to begin synchronously inside the click
  // handler. Do not add an asynchronous step before this call.
  frameAccessEnable.disabled = true;
  call(chrome.permissions, 'request', FRAME_ACCESS_PERMISSION).then(
    granted => {
      granted === true ? trace.succeeded() : trace.denied();
      return refreshFrameAccess();
    },
    error => {
      settleTraceError(trace, error);
      renderFrameAccess({available: false});
    }
  );
});
frameAccessDisable.addEventListener('click', () => {
  const trace = diagnosticClient.start({action: 'DISABLE_FRAME_ACCESS'});
  trace.click();
  trace.request();
  frameAccessDisable.disabled = true;
  call(chrome.permissions, 'remove', FRAME_ACCESS_PERMISSION).then(
    removed => {
      removed === true ? trace.succeeded() : trace.denied();
      return refreshFrameAccess();
    },
    error => {
      settleTraceError(trace, error);
      renderFrameAccess({available: false});
    }
  );
});
chrome.permissions?.onAdded?.addListener(() => void refreshFrameAccess());
chrome.permissions?.onRemoved?.addListener(() => void refreshFrameAccess());

conflictScanRun.addEventListener('click', () => {
  const trace = diagnosticClient.start({action: 'RUN_CONFLICT_SCAN'});
  trace.click();
  trace.request();
  // Permission requests must begin synchronously in this user gesture.
  conflictScanRun.disabled = true;
  conflictScanInfo.textContent = message('options_conflict_scan_running', 'Scanning...');
  call(chrome.permissions, 'request', CONFLICT_SCAN_PERMISSION).then(async granted => {
    if (granted !== true) {
      trace.denied();
      conflictScanInfo.textContent = message(
        'options_conflict_scan_denied',
        'Conflict scan access was not granted.'
      );
      return;
    }
    const result = await diagnosticsRequest(
      'conflict-scan',
      {correlation: trace.correlation},
      {timeoutMs: 25_000}
    );
    trace.succeeded({counts: {
      conflicts: Array.isArray(result?.signals) ? result.signals.length : 0,
      discardedTabs: Number(result?.counts?.discardedTabs) || 0,
      duplicateCopies: Number(result?.counts?.duplicateCopies) || 0,
      enabledExtensions: Number(result?.counts?.enabledExtensions) || 0,
      externalDiscarders: Number(result?.counts?.externalDiscarders) || 0,
      externalPlaceholders: Number(result?.counts?.externalPlaceholders) || 0,
      externalSleepers: Number(result?.counts?.externalSleepers) || 0,
      selfOwnedSleepers: Number(result?.counts?.selfOwnedSleepers) || 0,
      tabManagers: Number(result?.counts?.tabManagers) || 0,
      unknownSleepers: Number(result?.counts?.unknownSleepers) || 0
    }});
    conflictScanInfo.textContent = conflictSummary(result);
  }).catch(error => {
    settleTraceError(trace, error);
    conflictScanInfo.textContent = `${message(
      'options_conflict_scan_failed',
      'Conflict scan failed'
    )}: ${error?.message || String(error)}`;
  }).finally(() => void refreshConflictAccess());
});
conflictScanRemove.addEventListener('click', () => {
  const trace = diagnosticClient.start({action: 'REMOVE_CONFLICT_SCAN_ACCESS'});
  trace.click();
  trace.request();
  conflictScanRemove.disabled = true;
  call(chrome.permissions, 'remove', CONFLICT_SCAN_PERMISSION).then(
    removed => {
      if (removed === true) {
        trace.succeeded();
        conflictScanInfo.textContent = message(
          'options_conflict_scan_removed',
          'Conflict scan access removed.'
        );
      }
      else {
        trace.denied();
        renderConflictAccess({granted: false});
      }
    },
    error => {
      settleTraceError(trace, error);
      renderConflictAccess({available: false});
    }
  ).finally(() => void refreshConflictAccess());
});
chrome.permissions?.onAdded?.addListener(() => void refreshConflictAccess());
chrome.permissions?.onRemoved?.addListener(() => void refreshConflictAccess());

const diagnosticsRequest = async (method, details = {}, options) => {
  const response = await boundedRuntimeMessage(chrome.runtime, {method, ...details}, options);
  if (response?.ok !== true) {
    const error = Error(response?.error || 'Diagnostic request failed');
    if (/timed out/i.test(response?.error || '')) error.code = 'OPTIONS_API_TIMEOUT';
    throw error;
  }
  return response.value;
};

const localStorageSnapshot = () => Object.fromEntries(
  Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])
);
const replaceLocalStorage = values => {
  localStorage.clear();
  for (const [key, value] of Object.entries(values)) {
    localStorage.setItem(key, value);
  }
};

const importAdapter = {
  lockManager: navigator.locks,
  requireLock: true,
  readLocalStorage: async () => localStorageSnapshot(),
  readStorage: () => call(chrome.storage.local, 'get', null),
  readTransaction: () => call(chrome.storage.local, 'get', [
    SETTINGS_IMPORT_FENCE_KEY,
    SETTINGS_IMPORT_TRANSACTION_KEY
  ]),
  removeStorage: keys => call(chrome.storage.local, 'remove', keys),
  replaceLocalStorage: async values => replaceLocalStorage(values),
  writeStorage: values => call(chrome.storage.local, 'set', values)
};

const applyImportedSettings = async settings => {
  settingsMutating = true;
  try {
    await commitSettingsImport(settings, importAdapter, {validateRules});
  }
  finally {
    settingsMutating = false;
  }
};

const withImportLock = task => withSettingsImportLock(importAdapter.lockManager, task);

let importRecovery;
const recoverInterruptedImport = ({lockHeld = false} = {}) => {
  if (!importRecovery) {
    const operation = recoverSettingsImport(importAdapter, {lockHeld}).finally(() => {
      if (importRecovery === operation) {
        importRecovery = undefined;
      }
    });
    importRecovery = operation;
  }
  return importRecovery;
};

let localPreferenceMigration;
const migrateLocalPreferences = () => {
  if (!localPreferenceMigration) {
    localPreferenceMigration = call(
      chrome.storage.local,
      'get',
      LOCAL_PREFERENCE_MIGRATION_KEYS
    ).then(async stored => {
      const plan = planLocalPreferenceMigration(stored);
      if (Object.keys(plan.set).length) {
        await call(chrome.storage.local, 'set', plan.set);
      }
      if (plan.remove.length) {
        await call(chrome.storage.local, 'remove', plan.remove);
      }
      return plan;
    }).catch(error => {
      localPreferenceMigration = undefined;
      throw error;
    });
  }
  return localPreferenceMigration;
};

const storage = async prefs => {
  const keys = Object.keys(prefs);
  const managedKeys = expandPluginPolicyKeys(keys);
  // Managed policy initialization is independent of the local import
  // transaction and can be slow on a cold browser profile. Never hold the
  // origin import lock while waiting for that browser-owned callback.
  const managed = await readManagedStorageArea(chrome.storage.managed, managedKeys);
  const local = await withImportLock(async () => {
    await recoverInterruptedImport({lockHeld: true});
    await migrateLocalPreferences();
    return call(chrome.storage.local, 'get', prefs);
  });
  const effective = overlayPreferenceLayers(prefs, local, Object.fromEntries(
    managedKeys.filter(key => Object.prototype.hasOwnProperty.call(managed || {}, key))
      .map(key => [key, managed[key]])
  ));
  return Object.fromEntries(keys.map(key => [key, effective[key]]));
};
const restore = () => storage({
  'period': 10 * 60, // in seconds
  'number': 6, // number of tabs before triggering discard
  'max.single.discard': 50, // max number of tabs to discard
  'trash.period': 24, // in hours
  'trash.unloaded': false,
  'trash.whitelist-url': [],
  'audio': true, // audio = true => do not discard if audio is playing
  'paused': false, // paused = true => do not discard if there is a paused media player
  'pinned': false, // pinned = true => do not discard if tab is pinned
  'split-view': true, // split-view = true => do not discard split tabs if either tab of the split is focused
  'form': true, // form = true => do not discard if form data is changed
  'battery': false, // battery = true => only discard if power is disconnected
  'online': false, // online = true => do not discard if there is no INTERNET connection
  'notification.permission': false, // true => do not discard
  'page.context': false,
  'tab.context': true,
  'link.context': true,
  'log': false,
  'whitelist': [],
  'whitelist-url': [],
  'mode': 'time-based',
  'click': 'click.popup',
  'faqs': true,
  'lifecycle-feedback': false,
  'favicon': false,
  'prepends': '💤',
  'discard-protected-on-close': false,
  'go-hidden': false,
  'memory-enabled': false,
  'memory-value': 60,
  'favicon-delay': isFirefox ? 500 : 100,
  'simultaneous-jobs': 10,
  'idle': false,
  'idle-timeout': 5 * 60,
  'startup-unpinned': false,
  'startup-pinned': false,
  'startup-release-pinned': false,
  'force.hostnames': [],
  /* plugins */
  ...PLUGIN_PREFERENCES
}).then(prefs => {
  if (navigator.getBattery === undefined) {
    document.getElementById('battery_enabled').closest('tr').disabled = true;
  }
  document.getElementById('idle').checked = prefs.idle;
  document.getElementById('idle-timeout').value = parseInt(prefs['idle-timeout'] / 60);
  document.getElementById('faqs').checked = prefs.faqs;
  document.getElementById('lifecycle-feedback').checked = prefs['lifecycle-feedback'];
  document.getElementById('favicon').checked = prefs.favicon;
  document.getElementById('prepends').value = prefs.prepends;
  document.getElementById('discard-protected-on-close').checked = prefs['discard-protected-on-close'];
  document.getElementById('go-hidden').checked = prefs['go-hidden'];
  if (prefs.period === 0) {
    document.getElementById('period').value = 0;
  }
  else {
    document.getElementById('period').value = Math.max(1, parseInt(prefs.period / 60));
  }
  document.getElementById('trash.period').value = prefs['trash.period'];
  document.getElementById('trash.whitelist-url').value = prefs['trash.whitelist-url'].join(', ');
  document.getElementById('trash.unloaded').checked = prefs['trash.unloaded'];
  document.getElementById('number').value = prefs.number;
  document.getElementById('max.single.discard').value = prefs['max.single.discard'];
  document.getElementById('simultaneous-jobs').value = prefs['simultaneous-jobs'];
  document.getElementById('favicon-delay').value = prefs['favicon-delay'];
  document.getElementById('audio').checked = prefs.audio;
  document.getElementById('paused').checked = prefs.paused;
  document.getElementById('pinned').checked = prefs.pinned;
  document.getElementById('split-view').checked = prefs['split-view'];
  document.getElementById('form').checked = prefs.form;
  document.getElementById('battery_enabled').checked = prefs.battery;
  document.getElementById('online').checked = prefs.online;
  document.getElementById('notification.permission').checked = prefs['notification.permission'];
  document.getElementById('page.context').checked = prefs['page.context'];
  document.getElementById('tab.context').checked = prefs['tab.context'];
  document.getElementById('link.context').checked = prefs['link.context'];
  document.getElementById('log').checked = prefs.log;
  document.getElementById('whitelist').value = prefs.whitelist.join(', ');
  document.getElementById('whitelist-url').value = prefs['whitelist-url'].join(', ');
  document.getElementById('force.hostnames').value = prefs['force.hostnames'].join(', ');
  document.getElementById('memory-enabled').checked = prefs['memory-enabled'];
  document.getElementById('memory-value').value = prefs['memory-value'];
  document.getElementById('startup-unpinned').checked = prefs['startup-unpinned'];
  document.getElementById('startup-pinned').checked = prefs['startup-pinned'];
  document.getElementById('startup-release-pinned').checked = prefs['startup-release-pinned'];
  restoreModeControl(document.getElementById('url-based'), prefs.mode);
  const click = normalizeToolbarClick(prefs.click);
  (document.getElementById(click) || document.getElementById('click.popup')).checked = true;
  for (const key of PLUGIN_KEYS) {
    document.getElementById(key).checked = prefs[key] === true;
  }
});

const ruleFormat = key => key === 'trash.whitelist-url' ? 'trash' :
  (key === 'force.hostnames' ? 'plain' : 'standard');
const validateRules = (values, {key} = {}) => validateRuleList(values, {
  format: ruleFormat(key)
});
const parseRules = id => document.getElementById(id).value
  .split(/[,\n]/)
  .map(value => value.trim())
  .map(value => value.startsWith('http') || value.startsWith('ftp') ? (new URL(value)).hostname : value)
  .filter((value, index, list) => value && list.indexOf(value) === index);

const collectSettings = () => {
  let period = Math.max(Number(document.getElementById('period').value) * 60, 0);
  if (period !== 0) {
    period = Math.max(period, 60);
  }
  const settings = {
    'idle': document.getElementById('idle').checked,
    'idle-timeout': Math.max(1, Number(document.getElementById('idle-timeout').value)) * 60,
    period,
    'number': Math.max(Number(document.getElementById('number').value), 0),
    'max.single.discard': Math.max(Number(document.getElementById('max.single.discard').value), 1),
    'trash.period': Math.max(Number(document.getElementById('trash.period').value), 1),
    'trash.unloaded': document.getElementById('trash.unloaded').checked,
    'mode': document.getElementById('url-based').checked ? 'url-based' : 'time-based',
    'click': normalizeToolbarClick(document.querySelector('[name=left-click]:checked')?.id),
    'audio': document.getElementById('audio').checked,
    'paused': document.getElementById('paused').checked,
    'pinned': document.getElementById('pinned').checked,
    'split-view': document.getElementById('split-view').checked,
    'form': document.getElementById('form').checked,
    'battery': document.getElementById('battery_enabled').checked,
    'online': document.getElementById('online').checked,
    'notification.permission': document.getElementById('notification.permission').checked,
    'page.context': document.getElementById('page.context').checked,
    'tab.context': document.getElementById('tab.context').checked,
    'link.context': document.getElementById('link.context').checked,
    'log': document.getElementById('log').checked,
    'faqs': document.getElementById('faqs').checked,
    'lifecycle-feedback': document.getElementById('lifecycle-feedback').checked,
    'favicon': document.getElementById('favicon').checked,
    'prepends': normalizeTitleMarker(document.getElementById('prepends').value),
    'discard-protected-on-close': document.getElementById('discard-protected-on-close').checked,
    'go-hidden': document.getElementById('go-hidden').checked,
    'simultaneous-jobs': Math.max(1, Number(document.getElementById('simultaneous-jobs').value)),
    'favicon-delay': Math.max(100, Number(document.getElementById('favicon-delay').value)),
    'whitelist': parseRules('whitelist'),
    'whitelist-url': parseRules('whitelist-url'),
    'force.hostnames': parseRules('force.hostnames'),
    'memory-enabled': document.getElementById('memory-enabled').checked,
    'memory-value': Math.max(10, Number(document.getElementById('memory-value').value)),
    'startup-unpinned': document.getElementById('startup-unpinned').checked,
    'startup-pinned': document.getElementById('startup-pinned').checked,
    'startup-release-pinned': document.getElementById('startup-release-pinned').checked,
    /* plugins*/
    ...Object.fromEntries(PLUGIN_KEYS.map(key => [key, document.getElementById(key).checked])),
    'trash.whitelist-url': parseRules('trash.whitelist-url'),
  };
  return validateSettingsRecord(settings, {validateRules});
};

document.getElementById('save').addEventListener('click', async () => {
  const trace = diagnosticClient.start({action: 'SAVE_SETTINGS'});
  trace.click();
  trace.request();
  try {
    const settings = collectSettings();
    await withImportLock(async () => {
      await recoverInterruptedImport({lockHeld: true});
      await call(chrome.storage.local, 'set', settings);
    });
    document.getElementById('prepends').value = settings.prepends;
    info.textContent = chrome.i18n.getMessage('options_save_msg');
    await restore();
    trace.succeeded();
    window.setTimeout(() => info.textContent = '', 750);
  }
  catch (error) {
    trace.failed();
    reportError('options_save_failed', 'Save failed', error);
  }
});

document.getElementById('support').addEventListener('click', () => {
  const trace = diagnosticClient.start({action: 'OPEN_SUPPORT'});
  trace.click();
  trace.request();
  void call(chrome.tabs, 'create', {url: `${FORK_REPOSITORY}/issues`}).then(
    () => trace.succeeded(),
    () => trace.failed()
  );
});

document.addEventListener('DOMContentLoaded', () => {
  restore();
  void refreshFrameAccess();
  void refreshConflictAccess();
});

// restart if needed
const onChanged = (prefs, areaName) => {
  if (settingsMutating) {
    return;
  }
  if (areaName === 'managed') {
    void restore();
  }
  const tab = prefs['tab.context'];
  const page = prefs['page.context'];
  const link = prefs['link.context'];
  if (tab || page || link) { // Firefox
    if ((tab && (tab.newValue !== tab.oldValue)) ||
      (page && (page.newValue !== page.oldValue)) ||
      (link && (link.newValue !== link.oldValue))) {
      chrome.runtime.sendMessage({
        method: 'build-context'
      });
    }
  }
};
chrome.storage.onChanged.addListener(onChanged);
// reset
const reset = async correlation => {
  const response = await boundedRuntimeMessage(chrome.runtime, {
    correlation,
    method: 'reset'
  }, {timeoutMs: 30_000});
  if (response?.ok !== true) {
    throw Error(response?.error || 'Reset failed');
  }
  return response.value;
};

document.getElementById('reset').addEventListener('click', e => {
  const trace = diagnosticClient.start({action: 'RESET_SETTINGS', attempt: e.detail > 1 ? 1 : 0});
  trace.click();
  if (e.detail === 1) {
    trace.denied();
    info.textContent = 'Double-click to reset!';
    window.setTimeout(() => info.textContent = '', 750);
  }
  else {
    trace.request();
    reset(trace.correlation).then(() => {
      trace.succeeded();
      localStorage.clear();
      chrome.runtime.reload();
      window.close();
    }).catch(error => {
      trace.failed();
      info.textContent = error.message;
    });
  }
});
// rate
document.querySelector('#rate input').onclick = () => {
  const trace = diagnosticClient.start({action: 'OPEN_SUPPORT'});
  trace.click();
  trace.request();
  call(chrome.tabs, 'create', {url: `${FORK_REPOSITORY}/issues`}).then(
    () => trace.succeeded(),
    () => trace.failed()
  );
};

const downloadText = (text, download, type) => {
  const objectURL = URL.createObjectURL(new Blob([text], {type}));
  Object.assign(document.createElement('a'), {
    download,
    href: objectURL,
    type
  }).dispatchEvent(new MouseEvent('click'));
  setTimeout(() => URL.revokeObjectURL(objectURL));
};
const downloadJSON = (text, download) => downloadText(text, download, 'application/json');

document.getElementById('download-diagnostics').addEventListener('click', async () => {
  const trace = diagnosticClient.start({action: 'DOWNLOAD_ALL_HISTORY'});
  trace.click();
  trace.request();
  diagnosticsInfo.textContent = '';
  try {
    const result = await diagnosticsRequest('diagnostics-export', {
      selector: {scope: 'all'}
    }, {timeoutMs: 30_000});
    if (typeof result?.text !== 'string' || result.text.length === 0) {
      diagnosticsInfo.textContent = message(
        'options_diagnostics_empty',
        'No diagnostic history is available yet.'
      );
      trace.denied();
      return;
    }
    downloadText(
      result.text,
      'auto-tab-discard-session-history.log',
      'text/plain;charset=utf-8'
    );
    trace.succeeded();
  }
  catch (error) {
    trace.failed();
    reportDiagnosticsError('options_export_failed', 'Export failed', error);
  }
});

document.getElementById('clear-diagnostics').addEventListener('click', async () => {
  const trace = diagnosticClient.start({action: 'CLEAR_DIAGNOSTICS'});
  trace.click();
  trace.request();
  diagnosticsInfo.textContent = '';
  try {
    const result = await diagnosticsRequest('diagnostics-clear');
    if (result?.cleared !== true) {
      throw Error('Diagnostic history was not cleared');
    }
    diagnosticsInfo.textContent = message(
      'options_diagnostics_cleared',
      'Diagnostic history cleared.'
    );
    trace.succeeded();
  }
  catch (error) {
    trace.failed();
    reportDiagnosticsError('options_save_failed', 'Clear failed', error);
  }
});

// Raw settings export. The filename and document label deliberately call out
// that site rules can be present; use the separate support bundle for sharing.
document.getElementById('export').addEventListener('click', async () => {
  const trace = diagnosticClient.start({action: 'EXPORT_SETTINGS'});
  trace.click();
  trace.request();
  try {
    const prefs = await withImportLock(async () => {
      await recoverInterruptedImport({lockHeld: true});
      return call(chrome.storage.local, 'get', null);
    });
    downloadJSON(
      serializeRawSettingsBackup(prefs, {validateRules}),
      'auto-tab-discard-RAW-settings.json'
    );
    trace.succeeded();
  }
  catch (error) {
    trace.failed();
    reportError('options_export_failed', 'Export failed', error);
  }
});

document.getElementById('export-support').addEventListener('click', async () => {
  const trace = diagnosticClient.start({action: 'EXPORT_SUPPORT_BUNDLE'});
  trace.click();
  trace.request();
  try {
    const [prefs, journal] = await Promise.all([
      withImportLock(async () => {
        await recoverInterruptedImport({lockHeld: true});
        return call(chrome.storage.local, 'get', null);
      }),
      diagnosticsRequest('diagnostics-snapshot').catch(() => undefined)
    ]);
    downloadJSON(serializeSupportBundle(prefs, {
      journal,
      manifest: chrome.runtime.getManifest(),
      userAgent: navigator.userAgent
    }), 'auto-tab-discard-SANITIZED-support.json');
    trace.succeeded();
  }
  catch (error) {
    trace.failed();
    reportError('options_export_failed', 'Export failed', error);
  }
});

// import
document.getElementById('import').addEventListener('click', () => {
  const trace = diagnosticClient.start({action: 'IMPORT_SETTINGS'});
  trace.click();
  const fileInput = document.createElement('input');
  fileInput.style.display = 'none';
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.dataset.diagnosticSynthetic = 'true';

  document.body.appendChild(fileInput);
  fileInput.initialValue = fileInput.value;
  fileInput.addEventListener('cancel', () => {
    trace.cancelled();
    fileInput.remove();
  }, {once: true});
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file || fileInput.value === fileInput.initialValue) {
      trace.cancelled();
      fileInput.remove();
      return;
    }

    try {
      trace.request();
      // Size is rejected before the browser allocates the file's text string.
      if (file.size > MAX_BACKUP_BYTES) {
        throw new Error(`backup exceeds the ${MAX_BACKUP_BYTES}-byte limit`);
      }
      const text = await file.text();
      const {document: backup} = parseSettingsBackup(text, {validateRules});
      // Parsing, schema/type/range checks, rule checks, and marker
      // normalization all complete before the first mutation.
      await applyImportedSettings(backup.settings);
      info.textContent = message('options_import_success', 'Settings imported. Reloading...');
      trace.succeeded();
      chrome.runtime.reload();
      window.close();
    }
    catch (error) {
      trace.failed();
      reportError('options_import_failed', 'Import failed', error);
    }
    finally {
      fileInput.remove();
    }
  };
  fileInput.click();
});

// Every remaining visible Options interaction receives a fixed category event.
// The target ID, value, rule text, filename, and page data are deliberately not
// included. High-impact controls above use their more specific action names.
const specificallyTracedControls = new Set([
  'clear-diagnostics', 'disable-frame-access', 'download-diagnostics',
  'enable-frame-access', 'export', 'export-support', 'import',
  'remove-conflict-scan-access', 'reset', 'run-conflict-scan', 'save', 'support'
]);
document.addEventListener('click', event => {
  const control = event.target.closest('a,button,input,select,textarea');
  if (!control || control.dataset.diagnosticSynthetic === 'true' ||
      specificallyTracedControls.has(control.id) || control.closest('#rate')) return;
  if (control.tagName === 'A') {
    const trace = diagnosticClient.start({action: 'OPEN_SUPPORT'});
    trace.click();
    return;
  }
  const action = control.id?.startsWith('./plugins/') || control.closest('#plugins') ?
    'PLUGIN_CONTROL' : control.tagName === 'TEXTAREA' ? 'SITE_RULE_CONTROL' : 'SETTING_CONTROL';
  const trace = diagnosticClient.start({action});
  trace.click();
}, {capture: true});
// links
for (const a of [...document.querySelectorAll('[data-href]')]) {
  if (a.hasAttribute('href') === false) {
    a.href = chrome.runtime.getManifest().homepage_url + '#' + a.dataset.href;
  }
}
