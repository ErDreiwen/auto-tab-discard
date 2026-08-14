import test from 'node:test';
import assert from 'node:assert/strict';
import {access, readFile} from 'node:fs/promises';

import {
  canonicalPluginPreferenceKey,
  expandPluginPolicyKeys,
  PLUGIN_IDS,
  PLUGIN_KEYS,
  PLUGIN_POLICY_ALIASES,
  PLUGIN_POLICY_KEYS,
  PLUGIN_PREFERENCES
} from '../v3/worker/core/plugin-catalog.mjs';
import {LEGACY_DUMMY_PLUGIN_KEY} from '../v3/worker/core/preference-migrations.mjs';
import {validateSettingsRecord} from '../v3/data/options/core/settings-backup.mjs';

test('every advertised V3 plugin has a loader implementation and one catalog preference', async () => {
  const [html, loader, schemaText] = await Promise.all([
    readFile(new URL('../v3/data/options/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../v3/worker/plugins/loader.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../v3/schema.json', import.meta.url), 'utf8')
  ]);
  const schema = JSON.parse(schemaText);
  const advertised = [...html.matchAll(/id="(\.\/plugins\/[^"/]+\/core\.js)"/g)]
    .map(match => match[1]).sort();
  const catalog = [...PLUGIN_KEYS].sort();
  const schemaPlugins = Object.keys(schema.properties)
    .filter(key => key.startsWith('./plugins/')).sort();

  assert.deepEqual(advertised, catalog);
  assert.deepEqual(Object.keys(PLUGIN_PREFERENCES).sort(), catalog);
  assert.deepEqual(schemaPlugins, catalog,
    'adding a catalog plug-in without an explicit managed-policy schema entry must fail CI');
  assert.equal(Object.hasOwn(schema, 'additionalProperties'), false,
    'Chrome 102 cannot parse this top-level managed-schema keyword');
  assert.throws(() => validateSettingsRecord({surprise: true}), /unknown setting/,
    'the settings transaction validator must still reject unknown local keys');
  assert.throws(() => validateSettingsRecord({'./plugins/hostile/core.js': true}),
    /unknown plugin key/,
    'the settings transaction validator must still reject uncatalogued plug-ins');
  assert.deepEqual(new Set(PLUGIN_POLICY_KEYS), new Set([
    ...PLUGIN_KEYS,
    ...Object.keys(PLUGIN_POLICY_ALIASES)
  ]));
  assert.equal(catalog.includes(LEGACY_DUMMY_PLUGIN_KEY), false);
  assert.equal(canonicalPluginPreferenceKey(LEGACY_DUMMY_PLUGIN_KEY), undefined);
  assert.equal(canonicalPluginPreferenceKey('__proto__'), undefined);
  assert.equal(html.includes(LEGACY_DUMMY_PLUGIN_KEY), false);
  assert.equal(LEGACY_DUMMY_PLUGIN_KEY in schema.properties, false);
  assert.match(loader, /onChanged\.addListener\(\(ps, areaName = 'local'\)/);
  assert.match(loader, /Object\.keys\(ps\)\.map\(canonicalPluginPreferenceKey\)/,
    'legacy managed policy changes must refresh the canonical plug-in');
  assert.match(loader, /storage\(\{\[key\]: PLUGIN_PREFERENCES\[key\]\}\)/,
    'live local and managed changes must be resolved through the effective preference overlay');

  for (const key of PLUGIN_POLICY_KEYS) {
    assert.equal(schema.properties[key]?.type, 'boolean', `${key} must be a boolean policy`);
  }
  for (const [alias, canonical] of Object.entries(PLUGIN_POLICY_ALIASES)) {
    assert.equal(canonicalPluginPreferenceKey(alias), canonical);
    assert.deepEqual(expandPluginPolicyKeys([canonical]).sort(), [alias, canonical].sort());
  }

  for (const [name, id] of Object.entries(PLUGIN_IDS)) {
    assert.match(loader, new RegExp(`\\[PLUGIN_IDS\\.${name}\\]`), `${id} must be registered in loader`);
    const imported = loader.match(new RegExp(`import ${name} from '([^']+)'`));
    assert.ok(imported, `${id} must have a static implementation import`);
    await access(new URL(imported[1], new URL('../v3/worker/plugins/loader.mjs', import.meta.url)));
  }
});
