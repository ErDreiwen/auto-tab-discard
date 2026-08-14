import {
  commitSettingsImport,
  MAX_BACKUP_BYTES,
  parseSettingsBackup,
  serializeRawSettingsBackup,
  validateSettingsRecord
} from './core/settings-backup.mjs';
import {serializeSupportBundle} from './core/support-bundle.mjs';
import {restoreModeControl} from './core/mode-control.mjs';
import {boundedRuntimeMessage} from '../common/runtime-call.mjs';
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
let settingsMutating = false;

const message = (key, fallback) => chrome.i18n.getMessage(key) || fallback;
const reportError = (key, fallback, error) => {
  info.textContent = `${message(key, fallback)}: ${error?.message || String(error)}`;
};
const reportDiagnosticsError = (key, fallback, error) => {
  diagnosticsInfo.textContent = `${message(key, fallback)}: ${error?.message || String(error)}`;
};

const call = (target, method, ...args) => new Promise((resolve, reject) => {
  let settled = false;
  const done = (error, value) => {
    if (settled) {
      return;
    }
    settled = true;
    error ? reject(error) : resolve(value);
  };
  try {
    const operation = target[method](...args, value => {
      const error = chrome.runtime.lastError;
      done(error ? Error(error.message || String(error)) : null, value);
    });
    if (operation?.then) {
      operation.then(value => done(null, value), error => done(error));
    }
  }
  catch (error) {
    done(error);
  }
});

const diagnosticsRequest = async method => {
  const response = await boundedRuntimeMessage(chrome.runtime, {method});
  if (response?.ok !== true) {
    throw Error(response?.error || 'Diagnostic request failed');
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

const storage = prefs => withImportLock(async () => {
  await recoverInterruptedImport({lockHeld: true});
  await migrateLocalPreferences();
  const keys = Object.keys(prefs);
  const managedKeys = expandPluginPolicyKeys(keys);
  const [local, managed] = await Promise.all([
    call(chrome.storage.local, 'get', prefs),
    call(chrome.storage.managed, 'get', managedKeys).catch(() => ({}))
  ]);
  const effective = overlayPreferenceLayers(prefs, local, Object.fromEntries(
    managedKeys.filter(key => Object.prototype.hasOwnProperty.call(managed || {}, key))
      .map(key => [key, managed[key]])
  ));
  return Object.fromEntries(keys.map(key => [key, effective[key]]));
});
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
  try {
    const settings = collectSettings();
    await withImportLock(async () => {
      await recoverInterruptedImport({lockHeld: true});
      await call(chrome.storage.local, 'set', settings);
    });
    document.getElementById('prepends').value = settings.prepends;
    info.textContent = chrome.i18n.getMessage('options_save_msg');
    await restore();
    window.setTimeout(() => info.textContent = '', 750);
  }
  catch (error) {
    reportError('options_save_failed', 'Save failed', error);
  }
});

document.getElementById('support').addEventListener('click', () => chrome.tabs.create({
  url: `${FORK_REPOSITORY}/issues`
}));

document.addEventListener('DOMContentLoaded', restore);

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
const reset = () => new Promise((resolve, reject) => chrome.runtime.sendMessage({
  method: 'reset'
}, response => {
  const error = chrome.runtime.lastError;
  if (error || response?.ok !== true) {
    reject(Error(error?.message || response?.error || 'Reset failed'));
  }
  else {
    resolve(response.value);
  }
}));

document.getElementById('reset').addEventListener('click', e => {
  if (e.detail === 1) {
    info.textContent = 'Double-click to reset!';
    window.setTimeout(() => info.textContent = '', 750);
  }
  else {
    reset().then(() => {
      localStorage.clear();
      chrome.runtime.reload();
      window.close();
    }).catch(error => {
      info.textContent = error.message;
    });
  }
});
// rate
document.querySelector('#rate input').onclick = () => {
  chrome.tabs.create({
    url: `${FORK_REPOSITORY}/issues`
  });
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
  diagnosticsInfo.textContent = '';
  try {
    const result = await diagnosticsRequest('diagnostics-export');
    if (!result?.incident || typeof result.text !== 'string' || result.text.length === 0) {
      diagnosticsInfo.textContent = message(
        'options_diagnostics_empty',
        'No diagnostic history is available yet.'
      );
      return;
    }
    downloadText(
      result.text,
      'auto-tab-discard-latest.log',
      'text/plain;charset=utf-8'
    );
  }
  catch (error) {
    reportDiagnosticsError('options_export_failed', 'Export failed', error);
  }
});

document.getElementById('clear-diagnostics').addEventListener('click', async () => {
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
  }
  catch (error) {
    reportDiagnosticsError('options_save_failed', 'Clear failed', error);
  }
});

// Raw settings export. The filename and document label deliberately call out
// that site rules can be present; use the separate support bundle for sharing.
document.getElementById('export').addEventListener('click', async () => {
  try {
    const prefs = await withImportLock(async () => {
      await recoverInterruptedImport({lockHeld: true});
      return call(chrome.storage.local, 'get', null);
    });
    downloadJSON(
      serializeRawSettingsBackup(prefs, {validateRules}),
      'auto-tab-discard-RAW-settings.json'
    );
  }
  catch (error) {
    reportError('options_export_failed', 'Export failed', error);
  }
});

document.getElementById('export-support').addEventListener('click', async () => {
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
  }
  catch (error) {
    reportError('options_export_failed', 'Export failed', error);
  }
});

// import
document.getElementById('import').addEventListener('click', () => {
  const fileInput = document.createElement('input');
  fileInput.style.display = 'none';
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';

  document.body.appendChild(fileInput);
  fileInput.initialValue = fileInput.value;
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file || fileInput.value === fileInput.initialValue) {
      fileInput.remove();
      return;
    }

    try {
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
      chrome.runtime.reload();
      window.close();
    }
    catch (error) {
      reportError('options_import_failed', 'Import failed', error);
    }
    finally {
      fileInput.remove();
    }
  };
  fileInput.click();
});
// links
for (const a of [...document.querySelectorAll('[data-href]')]) {
  if (a.hasAttribute('href') === false) {
    a.href = chrome.runtime.getManifest().homepage_url + '#' + a.dataset.href;
  }
}
