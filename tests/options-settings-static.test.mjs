import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {restoreModeControl} from '../v3/data/options/core/mode-control.mjs';

const source = await readFile(new URL('../v3/data/options/index.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../v3/data/options/index.html', import.meta.url), 'utf8');
const prefsSource = await readFile(new URL('../v3/worker/core/prefs.mjs', import.meta.url), 'utf8');
const transactionSource = await readFile(
  new URL('../v3/worker/core/settings-import-transaction.mjs', import.meta.url),
  'utf8'
);
const frameMetadataSource = await readFile(
  new URL('../v3/worker/core/frame-metadata.mjs', import.meta.url),
  'utf8'
);
const popupSource = await readFile(new URL('../v3/data/popup/index.mjs', import.meta.url), 'utf8');
const runtimeCallSource = await readFile(
  new URL('../v3/data/common/runtime-call.mjs', import.meta.url),
  'utf8'
);

test('options page loads as a module and presents distinct raw and sanitized exports', () => {
  assert.match(html, /<script type="module" src="index\.js"><\/script>/);
  assert.match(html, /id="export"[^>]+options_export_raw/);
  assert.match(html, /id="export-support"[^>]+options_export_support/);
  assert.match(source, /auto-tab-discard-RAW-settings\.json/);
  assert.match(source, /auto-tab-discard-SANITIZED-support\.json/);
});

test('options overlays managed preferences last and never hydrates the removed dummy control', () => {
  assert.match(source, /chrome\.storage\.local, 'get', prefs/);
  assert.match(source, /managedKeys = expandPluginPolicyKeys\(keys\)/);
  assert.match(source, /readManagedStorageArea\(chrome\.storage\.managed, managedKeys\)/);
  assert.match(source, /overlayPreferenceLayers\(prefs, local/);
  assert.doesNotMatch(source, /getElementById\('\.\/plugins\/dummy\/core\.js'\)/);
  assert.doesNotMatch(html, /id="\.\/plugins\/dummy\/core\.js"/);
  assert.match(source, /normalizeToolbarClick\(prefs\.click\)/);
  assert.match(source, /querySelector\('\[name=left-click\]:checked'\)\?\.id/);
  assert.match(source, /restoreModeControl\(document\.getElementById\('url-based'\), prefs\.mode\)/);
  assert.doesNotMatch(source, /getElementById\('time-based'\)/);
});

test('options mode restore uses the one real checkbox for both stored modes', () => {
  assert.match(html, /id="url-based"/);
  assert.doesNotMatch(html, /id="time-based"/);

  const control = {checked: false};
  assert.equal(restoreModeControl(control, 'url-based'), true);
  assert.equal(control.checked, true, 'url-based mode checks the URL-based control');

  assert.equal(restoreModeControl(control, 'time-based'), true);
  assert.equal(control.checked, false, 'time-based mode clears the same control');
  assert.equal(restoreModeControl(null, 'time-based'), false,
    'missing optional control stays null-safe');
});

test('options page exposes local sanitized diagnostic download and clear controls', () => {
  assert.match(html, /id="diagnostics"[^>]+aria-labelledby="diagnostics-title"/);
  assert.match(html, /id="download-diagnostics"[^>]+options_diagnostics_download/);
  assert.match(html, /id="clear-diagnostics"[^>]+options_diagnostics_clear/);
  assert.match(html, /id="diagnostics-info"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /Deep sanitized history stays on this device/);
  assert.match(html, /10,000 records, 64 browser sessions, 30 days, and 4 MiB/);
  assert.match(html, /oldest data is pruned automatically/);
  assert.match(html, /clear the history manually/);
  assert.match(html,
    /excludes URLs, titles, hostnames, site rules, tab and window IDs, extension IDs, raw errors, and private-window activity/);

  assert.match(source,
    /diagnosticsRequest\('diagnostics-export',\s*\{\s*selector: \{scope: 'all'\}/);
  assert.match(source, /diagnosticsRequest\('diagnostics-clear'\)/);
  assert.match(source, /diagnosticsRequest\('diagnostics-snapshot'\)/);
  assert.match(source, /auto-tab-discard-session-history\.log/);
  assert.doesNotMatch(source, /auto-tab-discard-latest\.log/);
  assert.match(source, /text\/plain;charset=utf-8/);
  assert.match(source, /result\?\.cleared !== true/);
  assert.match(source, /options_diagnostics_empty/);
  assert.doesNotMatch(source, /diagnostics-(?:export|snapshot)'\)[\s\S]{0,200}chrome\.storage\.local/,
    'diagnostic reads must use the worker boundary rather than raw local storage');
});

test('missing locale entries retain explicit English diagnostic fallback text', () => {
  assert.match(source, /const localized = chrome\.i18n\.getMessage\(e\.dataset\.i18n\)/);
  assert.match(source, /if \(localized\) \{[\s\S]*e\[e\.dataset\.i18nValue \|\| 'textContent'\] = localized/);
  assert.match(html, />Diagnostics<\/h2>/);
  assert.match(html, /value="Download session-history\.log"/);
  assert.match(html, /value="Clear diagnostic history"/);
});

test('optional conflict scan is accessible, user-triggered, and renders aggregates only', () => {
  assert.match(html, /id="conflict-scan-title"[^>]+options_conflict_scan_title/);
  assert.match(html,
    /id="conflict-scan-description"[^>]+options_conflict_scan_description/);
  assert.match(html,
    /id="run-conflict-scan"[^>]+options_conflict_scan_run[^>]+aria-describedby="conflict-scan-description conflict-scan-info"/);
  assert.match(html,
    /id="remove-conflict-scan-access"[^>]+options_conflict_scan_remove[^>]+aria-describedby="conflict-scan-description conflict-scan-info"/);
  assert.match(html,
    /id="conflict-scan-info"[^>]+role="status"[^>]+aria-live="polite"[^>]+aria-atomic="true"/);
  assert.match(html, /scan is read-only and never stores extension names or IDs/);

  const handlerStart = source.indexOf("conflictScanRun.addEventListener('click'");
  const handlerEnd = source.indexOf(
    "conflictScanRemove.addEventListener('click'",
    handlerStart
  );
  const runHandler = source.slice(handlerStart, handlerEnd);
  const requestStart = runHandler.indexOf(
    "call(chrome.permissions, 'request', CONFLICT_SCAN_PERMISSION)"
  );
  assert.ok(handlerStart > 0 && handlerEnd > handlerStart && requestStart > 0);
  assert.match(runHandler, /addEventListener\('click', \(\) => \{/);
  assert.doesNotMatch(runHandler.slice(0, requestStart), /\bawait\b|queueMicrotask|setTimeout/,
    'management permissions.request must begin synchronously inside the click gesture');
  assert.equal((source.match(
    /call\(chrome\.permissions, 'request', CONFLICT_SCAN_PERMISSION\)/g
  ) || []).length, 1);
  assert.match(runHandler,
    /diagnosticsRequest\(\s*'conflict-scan',\s*\{correlation: trace\.correlation\},\s*\{timeoutMs: 25_000\}\s*\)[\s\S]*conflictScanInfo\.textContent = conflictSummary\(result\)/);

  const summaryStart = source.indexOf('const conflictSummary = result => {');
  const summaryEnd = source.indexOf("frameAccessEnable.addEventListener('click'", summaryStart);
  const summary = source.slice(summaryStart, summaryEnd);
  assert.ok(summaryStart > 0 && summaryEnd > summaryStart);
  for (const field of [
    'confidence',
    'duplicateCopies',
    'externalDiscarders',
    'tabManagers',
    'externalSleepers',
    'externalPlaceholders'
  ]) {
    assert.match(summary, new RegExp(field));
  }
  assert.match(summary, /getMessage\('options_conflict_scan_result', values\)/);
  assert.doesNotMatch(summary,
    /JSON\.stringify|result\?\.(?:extensions|matches|details|names|ids|signals)/,
    'Options must render only aggregate conflict counts, never raw extension records');
});

test('optional bounded frame access is disclosed, accessible, and requested only by an Options click', () => {
  assert.match(html, /id="frame-protection"[^>]+aria-labelledby="frame-protection-title"/);
  assert.match(html, /id="frame-access-description"[^>]+options_frame_access_description/);
  assert.match(html,
    /id="enable-frame-access"[^>]+options_frame_access_enable[^>]+aria-describedby="frame-access-description frame-access-info"/);
  assert.match(html,
    /id="disable-frame-access"[^>]+options_frame_access_disable[^>]+aria-describedby="frame-access-description frame-access-info"/);
  assert.match(html,
    /id="frame-access-info"[^>]+role="status"[^>]+aria-live="polite"[^>]+aria-atomic="true"/);
  assert.match(html, /Read your browsing history/);
  assert.match(html, /does not store or log frame URLs/);
  assert.match(html, /bounded same-origin frames are still checked/);

  const handlerStart = source.indexOf("frameAccessEnable.addEventListener('click'");
  const handlerEnd = source.indexOf("frameAccessDisable.addEventListener('click'", handlerStart);
  const enableHandler = source.slice(handlerStart, handlerEnd);
  assert.ok(handlerStart > 0 && handlerEnd > handlerStart);
  assert.match(enableHandler,
    /call\(chrome\.permissions, 'request', FRAME_ACCESS_PERMISSION\)/);
  assert.doesNotMatch(enableHandler, /\bawait\b/,
    'permissions.request must start synchronously inside the user gesture');
  assert.match(source,
    /call\(chrome\.permissions, 'request', FRAME_ACCESS_PERMISSION\)\.then\(\s*granted =>/);
  assert.match(source,
    /call\(chrome\.permissions, 'remove', FRAME_ACCESS_PERMISSION\)\.then\(\s*removed =>/);
  assert.match(source,
    /granted: await call\(chrome\.permissions, 'contains', FRAME_ACCESS_PERMISSION\)/);
  assert.match(source, /boundedBrowserCall\(target, method, args/);
  assert.match(runtimeCallSource, /operation\?\.then/,
    'the bounded browser adapter must retain Promise support');
  assert.match(runtimeCallSource, /target\[method\]\(\.\.\.args, \(value, compatibilityError\) =>/,
    'the bounded browser adapter must retain callback support');
  assert.match(runtimeCallSource, /BROWSER_CALL_TIMEOUT/,
    'optional browser calls must have a deterministic timeout');
  assert.match(source, /options_frame_access_limited/);
  assert.match(source, /options_frame_access_unavailable/);
  assert.doesNotMatch(enableHandler, /storage\.(?:local|sync|session)|localStorage/,
    'the permission grant is browser-owned and must not be mirrored in settings');

  const requestPattern = /call\(chrome\.permissions, 'request', FRAME_ACCESS_PERMISSION\)/g;
  assert.equal((source.match(requestPattern) || []).length, 1);
  assert.equal((popupSource.match(requestPattern) || []).length, 0);
  assert.equal((frameMetadataSource.match(requestPattern) || []).length, 0,
    'automatic worker scans must never prompt for optional permission');
});

test('import validates completely before its durable transaction or reload', () => {
  const parse = source.indexOf('parseSettingsBackup(text, {validateRules})');
  const apply = source.indexOf('applyImportedSettings(backup.settings)', parse);
  const reload = source.indexOf('chrome.runtime.reload()', apply);
  const guard = source.indexOf('settingsMutating = true');
  const commit = source.indexOf('commitSettingsImport(settings, importAdapter', guard);

  assert.ok(parse > 0);
  assert.ok(apply > parse);
  assert.ok(guard > 0);
  assert.ok(commit > guard);
  assert.ok(reload > apply);
  assert.match(source, /file\.size > MAX_BACKUP_BYTES/);
  assert.match(source,
    /readTransaction: \(\) => call\(chrome\.storage\.local, 'get', \[[\s\S]*SETTINGS_IMPORT_FENCE_KEY,[\s\S]*SETTINGS_IMPORT_TRANSACTION_KEY[\s\S]*\]\)/);
  assert.match(source, /lockManager: navigator\.locks/);
  assert.match(source, /requireLock: true/);
  assert.match(source, /removeStorage: keys => call\(chrome\.storage\.local, 'remove', keys\)/);
  const managedRead = source.indexOf(
    'const managed = await readManagedStorageArea(chrome.storage.managed, managedKeys)'
  );
  const localLock = source.indexOf('const local = await withImportLock(async () => {', managedRead);
  assert.ok(managedRead > 0 && localLock > managedRead,
    'cold managed policy reads must finish before Options acquires the import lock');
  assert.match(source.slice(localLock),
    /await recoverInterruptedImport\(\{lockHeld: true\}\)[\s\S]*chrome\.storage\.local, 'get', prefs/);
  assert.doesNotMatch(source, /clearStorage|chrome\.storage\.local, 'clear'/);
  assert.doesNotMatch(source, /removeListener\(onChanged\)/);
  assert.doesNotMatch(source, /100e6|100MB/);
});

test('worker preferences recover the reserved bounded transaction before local values', () => {
  const recovery = prefsSource.indexOf(
    'await recoverSettingsImportStorage(chrome.storage.local, {lockHeld: true})');
  const migration = prefsSource.indexOf('await migrateLocalPreferences()', recovery);
  const localRead = prefsSource.indexOf('readStorageArea(chrome.storage.local, requested)', migration);
  const managedRead = prefsSource.indexOf(
    'const managed = await readManagedStorageArea(chrome.storage.managed, managedKeys'
  );
  const localLock = prefsSource.indexOf(
    'const local = await withSettingsImportLock(globalThis.navigator?.locks', managedRead
  );
  assert.ok(managedRead > 0 && localLock > managedRead,
    'cold managed policy reads must not hold the settings-import lock');
  assert.ok(recovery > 0);
  assert.ok(recovery > localLock);
  assert.ok(migration > recovery);
  assert.ok(localRead > migration);
  assert.match(prefsSource.slice(localLock),
    /withSettingsImportLock\(globalThis\.navigator\?\.locks, async \(\) => \{[\s\S]*recoverSettingsImportStorage[\s\S]*readStorageArea\(chrome\.storage\.local, requested\)/);
  assert.match(source, /const local = await withImportLock\(async \(\) =>/);
  assert.match(source,
    /await withImportLock\(async \(\) => \{\s*await recoverInterruptedImport\(\{lockHeld: true\}\);\s*await call\(chrome\.storage\.local, 'set', settings\)/);
  assert.match(transactionSource,
    /SETTINGS_IMPORT_TRANSACTION_KEY = '__settingsImportTransaction'/);
  assert.match(transactionSource, /SETTINGS_IMPORT_FENCE_KEY = '__settingsImportFence'/);
  assert.match(transactionSource, /SETTINGS_IMPORT_LOCK_NAME = 'auto-tab-discard:settings-import'/);
  assert.match(transactionSource, /MAX_SETTINGS_IMPORT_TRANSACTION_BYTES = 4 \* 1024 \* 1024/);
  assert.match(transactionSource, /SETTINGS_IMPORT_PHASES\.LOCAL_ROLLBACK_PENDING/);
  assert.match(transactionSource, /respectActiveGrace: true/);
});

test('lifecycle feedback is explicit opt-in and feedback stays on the fork', () => {
  assert.match(html, /id="lifecycle-feedback"/);
  assert.match(source, /'lifecycle-feedback': false/);
  assert.match(source, /FORK_REPOSITORY}\/issues/);
  assert.doesNotMatch(source, /chrome\.google\.com\/webstore|addons\.mozilla\.org|microsoftedge\.microsoft\.com/);
  assert.doesNotMatch(source, /homepage_url \+ '\?rd=/);
});
