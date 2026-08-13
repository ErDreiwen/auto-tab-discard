import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../v3/data/options/index.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../v3/data/options/index.html', import.meta.url), 'utf8');

test('options page loads as a module and presents distinct raw and sanitized exports', () => {
  assert.match(html, /<script type="module" src="index\.js"><\/script>/);
  assert.match(html, /id="export"[^>]+options_export_raw/);
  assert.match(html, /id="export-support"[^>]+options_export_support/);
  assert.match(source, /auto-tab-discard-RAW-settings\.json/);
  assert.match(source, /auto-tab-discard-SANITIZED-support\.json/);
});

test('import validates completely before listener removal, clearing, or reload', () => {
  const parse = source.indexOf('parseSettingsBackup(text, {validateRules})');
  const apply = source.indexOf('applyImportedSettings(backup.settings)', parse);
  const reload = source.indexOf('chrome.runtime.reload()', apply);
  const snapshot = source.indexOf('const storageSnapshot = await importAdapter.readStorage()');
  const guard = source.indexOf('settingsMutating = true', snapshot);
  const commit = source.indexOf('commitSettingsImport(settings, {', guard);

  assert.ok(parse > 0);
  assert.ok(apply > parse);
  assert.ok(snapshot > 0);
  assert.ok(guard > snapshot);
  assert.ok(commit > guard);
  assert.ok(reload > apply);
  assert.match(source, /file\.size > MAX_BACKUP_BYTES/);
  assert.doesNotMatch(source, /removeListener\(onChanged\)/);
  assert.doesNotMatch(source, /100e6|100MB/);
});

test('lifecycle feedback is explicit opt-in and feedback stays on the fork', () => {
  assert.match(html, /id="lifecycle-feedback"/);
  assert.match(source, /'lifecycle-feedback': false/);
  assert.match(source, /FORK_REPOSITORY}\/issues/);
  assert.doesNotMatch(source, /chrome\.google\.com\/webstore|addons\.mozilla\.org|microsoftedge\.microsoft\.com/);
  assert.doesNotMatch(source, /homepage_url \+ '\?rd=/);
});
