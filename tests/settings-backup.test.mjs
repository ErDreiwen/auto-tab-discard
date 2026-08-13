import test from 'node:test';
import assert from 'node:assert/strict';

import {validateRuleList} from '../v3/worker/core/rules.mjs';
import {
  commitSettingsImport,
  MAX_BACKUP_BYTES,
  parseSettingsBackup,
  RAW_BACKUP_LABEL,
  serializeRawSettingsBackup,
  SettingsBackupError,
  SettingsImportTransactionError,
  validateSettingsRecord
} from '../v3/data/options/core/settings-backup.mjs';
import {
  serializeSupportBundle,
  SUPPORT_BUNDLE_LABEL
} from '../v3/data/options/core/support-bundle.mjs';

const rules = (values, {format}) => validateRuleList(values, {format});

const settings = (extra = {}) => ({
  audio: true,
  click: 'click.popup',
  faqs: true,
  favicon: false,
  'lifecycle-feedback': false,
  mode: 'time-based',
  period: 600,
  prepends: 'zzz',
  whitelist: [],
  ...extra
});

const backupText = value => JSON.stringify({
  exportedAt: '2026-08-12T12:00:00.000Z',
  format: 'auto-tab-discard-settings',
  label: RAW_BACKUP_LABEL,
  settings: value,
  version: 1
});

test('raw export is versioned, explicitly labeled, normalized, and strips internal state', () => {
  const text = serializeRawSettingsBackup(settings({
    '__blankHelperRegistry': {tab: 4},
    '__discardOwnership': {4: {title: 'private'}},
    'last-update': 123,
    prepends: '  e\u0301\u202e   marker  ',
    'tmp_disable': 12,
    whitelist: ['example.test']
  }), {
    now: () => new Date('2026-08-12T12:00:00.000Z'),
    validateRules: rules
  });
  const document = JSON.parse(text);

  assert.equal(document.version, 1);
  assert.equal(document.label, RAW_BACKUP_LABEL);
  assert.equal(document.settings.prepends, 'é marker'.normalize('NFC'));
  assert.deepEqual(document.settings.whitelist, ['example.test']);
  assert.equal('__discardOwnership' in document.settings, false);
  assert.equal('__blankHelperRegistry' in document.settings, false);
  assert.equal('last-update' in document.settings, false);
  assert.equal('tmp_disable' in document.settings, false);
});

test('current legacy backup shape migrates historical fields and drops local/internal state', () => {
  const legacy = JSON.stringify({
    'chrome.storage.local': {
      '__discardOwnership': {'1': {source: 'self'}},
      audio: true,
      'lifecycle-feedback': true,
      'release-next-tab': true,
      'trash.enabled': true,
      whitelist: ['example.test']
    },
    localStorage: {
      click: 'discard-tab',
      'explore-count': '12'
    }
  });
  const result = parseSettingsBackup(legacy, {validateRules: rules});

  assert.equal(result.migratedFrom, 'legacy-v0');
  assert.equal(result.document.settings.click, 'click.discard-tab');
  assert.equal(result.document.settings['./plugins/next/core.js'], true);
  assert.equal(result.document.settings['./plugins/trash/core.js'], true);
  assert.equal(result.document.settings['lifecycle-feedback'], true);
  assert.equal('__discardOwnership' in result.document.settings, false);
  assert.equal('release-next-tab' in result.document.settings, false);
  assert.equal('trash.enabled' in result.document.settings, false);
});

test('legacy v3 click.discard value migrates to the current discard-tab action', () => {
  const result = parseSettingsBackup(JSON.stringify({
    'chrome.storage.local': {click: 'click.discard', 'use-cache': true},
    localStorage: {}
  }), {validateRules: rules});
  assert.equal(result.document.settings.click, 'click.discard-tab');
  assert.equal(result.document.settings['use-cache'], true);
});

test('versioned export normalizes a historical click value before serialization', () => {
  const document = JSON.parse(serializeRawSettingsBackup(settings({
    click: 'click.discard'
  }), {validateRules: rules}));
  assert.equal(document.settings.click, 'click.discard-tab');
});

test('backup size is capped before parsing', () => {
  assert.throws(
    () => parseSettingsBackup(' '.repeat(MAX_BACKUP_BYTES + 1)),
    error => error instanceof SettingsBackupError && error.code === 'size-limit'
  );
});

test('schema rejects unknown, hostile, mistyped, out-of-range, and unknown plug-in keys', async t => {
  const cases = [
    ['unknown setting', settings({surprise: true}), 'unknown-key'],
    ['unknown plug-in', settings({'./plugins/hostile/core.js': true}), 'unknown-plugin'],
    ['mistyped setting', settings({audio: 'true'}), 'invalid-type'],
    ['out-of-range setting', settings({period: -1}), 'range']
  ];
  for (const [name, value, code] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => parseSettingsBackup(backupText(value), {validateRules: rules}),
        error => error instanceof SettingsBackupError && error.code === code
      );
    });
  }

  await t.test('prototype pollution key', () => {
    const hostile = backupText(settings()).replace(
      '"settings":{',
      '"settings":{"constructor":{"prototype":{"polluted":true}},'
    );
    assert.throws(
      () => parseSettingsBackup(hostile, {validateRules: rules}),
      error => error instanceof SettingsBackupError && error.code === 'prototype-pollution'
    );
    assert.equal({}.polluted, undefined);
  });
});

test('unsafe rule rejection includes the preference and reason before mutation', () => {
  assert.throws(
    () => validateSettingsRecord(settings({
      whitelist: ['re:(a+)+']
    }), {validateRules: rules}),
    error => error instanceof SettingsBackupError &&
      error.code === 'invalid-rule' &&
      error.path === '$.settings.whitelist[0]' &&
      /nested quantifiers/i.test(error.message)
  );
});

const transaction = ({failure}) => {
  const original = {
    local: {click: 'discard-tab', 'explore-count': '4', secret: 'exact-local-snapshot'},
    storage: {audio: false, nested: {preserved: true}}
  };
  const state = structuredClone(original);
  let clearCalls = 0;
  let localCalls = 0;
  let writeCalls = 0;
  const adapter = {
    async clearStorage() {
      clearCalls += 1;
      if (failure === 'clear' && clearCalls === 1) {
        state.storage = {partiallyCleared: true};
        throw new Error('clear failed');
      }
      state.storage = {};
    },
    async readLocalStorage() {
      return structuredClone(state.local);
    },
    async readStorage() {
      return structuredClone(state.storage);
    },
    async replaceLocalStorage(value) {
      localCalls += 1;
      state.local = {};
      if (failure === 'local' && localCalls === 1) {
        throw new Error('local replacement failed');
      }
      state.local = structuredClone(value);
    },
    async writeStorage(value) {
      writeCalls += 1;
      if (failure === 'write' && writeCalls === 1) {
        state.storage = {partiallyWritten: true};
        throw new Error('write failed');
      }
      state.storage = structuredClone(value);
    }
  };
  return {adapter, original, state};
};

test('every mutation failure rolls storage and localStorage back byte-for-byte', async t => {
  for (const failure of ['clear', 'write', 'local']) {
    await t.test(failure, async () => {
      const fixture = transaction({failure});
      await assert.rejects(
        commitSettingsImport({audio: true}, fixture.adapter),
        SettingsImportTransactionError
      );
      assert.deepEqual(fixture.state, fixture.original);
    });
  }
});

test('successful import replaces both stores and leaves no historical localStorage', async () => {
  const fixture = transaction({});
  await commitSettingsImport(settings({audio: true}), fixture.adapter, {validateRules: rules});
  assert.deepEqual(fixture.state.local, {});
  assert.deepEqual(fixture.state.storage, settings({audio: true}));
});

test('parse and validation failures happen before transaction methods can run', async () => {
  let calls = 0;
  const adapter = new Proxy({}, {
    get() {
      return async () => {
        calls += 1;
      };
    }
  });

  assert.throws(
    () => parseSettingsBackup('{broken', {validateRules: rules}),
    error => error instanceof SettingsBackupError && error.code === 'invalid-json'
  );
  assert.throws(
    () => parseSettingsBackup(backupText(settings({audio: 'yes'})), {validateRules: rules}),
    error => error instanceof SettingsBackupError && error.code === 'invalid-type'
  );
  await assert.rejects(
    commitSettingsImport(settings({audio: 'yes'}), adapter, {validateRules: rules}),
    error => error instanceof SettingsBackupError && error.code === 'invalid-type'
  );
  await assert.rejects(
    commitSettingsImport(settings({whitelist: ['re:(a+)+']}), adapter, {validateRules: rules}),
    error => error instanceof SettingsBackupError && error.code === 'invalid-rule'
  );
  assert.equal(calls, 0);
});

test('sanitized support bundle excludes URL, title, rule, marker, local, ownership, and unknown secrets', () => {
  const canary = 'SECRET-CANARY-7c2a188e';
  const text = serializeSupportBundle({
    '__discardOwnership': {'1': {title: canary, url: `https://${canary}.invalid/`}},
    audio: true,
    click: 'click.discard-tab',
    'force.hostnames': [canary],
    'lifecycle-feedback': false,
    mystery: {title: canary},
    prepends: canary,
    'trash.keys': {[`https://${canary}.invalid/`]: [1, 2]},
    'trash.whitelist-url': [canary],
    whitelist: [canary],
    'whitelist-url': [`re:${canary}`]
  }, {
    manifest: {manifest_version: 3, name: canary, version: '0.6.9.2'},
    now: () => new Date('2026-08-12T12:00:00.000Z'),
    userAgent: `Mozilla/5.0 ${canary} Edg/151.0`
  });
  const bundle = JSON.parse(text);

  assert.equal(bundle.label, SUPPORT_BUNDLE_LABEL);
  assert.equal(bundle.environment.browserFamily, 'Edge');
  assert.equal(bundle.diagnostics.preferences.audio, true);
  assert.equal(bundle.diagnostics.preferences['lifecycle-feedback'], false);
  assert.equal(bundle.extension.version, '0.6.9.2');
  assert.equal(text.includes(canary), false);
  assert.equal(/https?:\/\//i.test(text), false);
  assert.equal(/whitelist|ownership|title|prepends/i.test(text), false);
});
