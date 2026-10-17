import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  createConflictScanner,
  SIGNALS
} from '../v3/worker/core/conflict-scan.mjs';

const callbackApi = value => callback => callback(structuredClone(value));

test('reports only aggregate duplicate and external-discarder conflict signals', async () => {
  const runtime = {id: 'self'};
  const scanner = createConflictScanner({
    management: {getAll: callbackApi([
      {enabled: true, id: 'self', name: 'Auto Tab Discard (Hardened)', type: 'extension'},
      {enabled: true, id: 'copy', name: 'Auto Tab Discard (Hardened)', type: 'extension'},
      {enabled: true, id: 'sleeper', name: 'Great Tab Suspender', type: 'extension'},
      {enabled: true, id: 'manager', name: 'Session Buddy Tab Manager', type: 'extension'},
      {enabled: false, id: 'off', name: 'Auto Tab Discard (Hardened)', type: 'extension'}
    ])},
    manifest: {homepage_url: 'https://example.invalid/project', name: 'Auto Tab Discard (Hardened)'},
    ownership: {snapshot: async () => ({
      1: {source: 'self', state: 'owned'},
      2: {source: 'claimed', state: 'owned'}
    })},
    runtime,
    tabs: {query: (query, callback) => callback([
      {discarded: true, id: 1, incognito: false, url: 'https://example.invalid/'},
      {discarded: true, id: 2, incognito: false, url: 'https://example.invalid/'},
      {discarded: true, id: 3, incognito: false, url: 'https://example.invalid/'},
      {
        discarded: false,
        id: 4,
        incognito: false,
        url: 'chrome-extension://sleeper/placeholder.html'
      }
    ])}
  });
  const result = await scanner.scan();
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.counts, {
    discardedTabs: 3,
    duplicateCopies: 1,
    enabledExtensions: 3,
    externalDiscarders: 2,
    externalPlaceholders: 1,
    externalSleepers: 1,
    selfOwnedSleepers: 1,
    tabManagers: 1,
    unknownSleepers: 1
  });
  assert.deepEqual(result.signals, [
    SIGNALS.DUPLICATE_SELF_ENABLED,
    SIGNALS.EXTERNAL_DISCARDER_ENABLED,
    SIGNALS.EXTERNAL_PLACEHOLDER_PRESENT,
    SIGNALS.EXTERNAL_SLEEPERS_PRESENT,
    SIGNALS.TAB_MANAGER_ENABLED
  ]);
  const serialized = JSON.stringify(result);
  for (const secret of ['copy', 'sleeper', 'manager', 'example.invalid', 'chrome-extension']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('mixed spanning-mode tabs are aggregated only for the authorized privacy context', async () => {
  const scanner = createConflictScanner({
    management: {getAll: async () => [
      {enabled: true, id: 'self', name: 'Auto Tab Discard (Hardened)', type: 'extension'},
      {enabled: true, id: 'sleeper', name: 'Great Tab Suspender', type: 'extension'}
    ]},
    manifest: {name: 'Auto Tab Discard (Hardened)'},
    ownership: {snapshot: async () => ({
      1: {source: 'self', state: 'owned'},
      4: {source: 'claimed', state: 'owned'}
    })},
    runtime: {id: 'self'},
    tabs: {query: async () => [
      {discarded: true, id: 1, incognito: false},
      {discarded: true, id: 2, incognito: false},
      {
        discarded: false,
        id: 3,
        incognito: false,
        url: 'chrome-extension://sleeper/placeholder.html'
      },
      {discarded: true, id: 4, incognito: true},
      {discarded: true, id: 5, incognito: true},
      {
        discarded: false,
        id: 6,
        incognito: true,
        url: 'chrome-extension://sleeper/placeholder.html'
      },
      // Missing privacy is excluded from both sides instead of guessed.
      {discarded: true, id: 7}
    ]}
  });

  const regular = await scanner.scan({privateContext: false});
  assert.deepEqual(regular.counts, {
    discardedTabs: 2,
    duplicateCopies: 0,
    enabledExtensions: 1,
    externalDiscarders: 1,
    externalPlaceholders: 1,
    externalSleepers: 0,
    selfOwnedSleepers: 1,
    tabManagers: 0,
    unknownSleepers: 1
  });
  assert.equal(regular.signals.includes(SIGNALS.EXTERNAL_SLEEPERS_PRESENT), false);

  const privateResult = await scanner.scan({privateContext: true});
  assert.deepEqual(privateResult.counts, {
    discardedTabs: 2,
    duplicateCopies: 0,
    enabledExtensions: 1,
    externalDiscarders: 1,
    externalPlaceholders: 1,
    externalSleepers: 1,
    selfOwnedSleepers: 0,
    tabManagers: 0,
    unknownSleepers: 1
  });
  assert.equal(privateResult.signals.includes(SIGNALS.EXTERNAL_SLEEPERS_PRESENT), true);
});

test('supports Promise APIs and does not attribute a conflict without evidence', async () => {
  const scanner = createConflictScanner({
    management: {getAll: async () => [
      {enabled: true, id: 'self', name: 'Auto Tab Discard (Hardened)', type: 'extension'},
      {enabled: true, id: 'notes', name: 'Notes', type: 'extension'}
    ]},
    manifest: {name: 'Auto Tab Discard (Hardened)'},
    ownership: {snapshot: async () => ({})},
    runtime: {id: 'self'},
    tabs: {query: async () => [{
      discarded: false, id: 1, incognito: false, url: 'https://example.invalid/'
    }]}
  });
  assert.deepEqual(await scanner.scan(), {
    confidence: 'none',
    counts: {
      discardedTabs: 0,
      duplicateCopies: 0,
      enabledExtensions: 1,
      externalDiscarders: 0,
      externalPlaceholders: 0,
      externalSleepers: 0,
      selfOwnedSleepers: 0,
      tabManagers: 0,
      unknownSleepers: 0
    },
    signals: []
  });
});

test('does not classify an unrelated extension page as a conflict placeholder', async () => {
  const scanner = createConflictScanner({
    management: {getAll: async () => [
      {enabled: true, id: 'self', name: 'Auto Tab Discard (Hardened)', type: 'extension'},
      {enabled: true, id: 'notes', name: 'Notes and Calendar', type: 'extension'}
    ]},
    manifest: {name: 'Auto Tab Discard (Hardened)'},
    ownership: {snapshot: async () => ({})},
    runtime: {id: 'self'},
    tabs: {query: async () => [{
      discarded: false,
      id: 1,
      incognito: false,
      url: 'chrome-extension://notes/app.html'
    }]}
  });
  const result = await scanner.scan();
  assert.equal(result.confidence, 'none');
  assert.equal(result.counts.externalPlaceholders, 0);
  assert.deepEqual(result.signals, []);
});

test('does not call an ordinary page from a relevant extension a sleeper placeholder', async () => {
  const scanner = createConflictScanner({
    management: {getAll: async () => [
      {enabled: true, id: 'self', name: 'Auto Tab Discard (Hardened)', type: 'extension'},
      {enabled: true, id: 'sleeper', name: 'Great Tab Suspender', type: 'extension'}
    ]},
    manifest: {name: 'Auto Tab Discard (Hardened)'},
    ownership: {snapshot: async () => ({})},
    runtime: {id: 'self'},
    tabs: {query: async () => [{
      discarded: false,
      id: 1,
      incognito: false,
      url: 'chrome-extension://sleeper/options.html'
    }]}
  });
  const result = await scanner.scan();
  assert.equal(result.counts.externalDiscarders, 1);
  assert.equal(result.counts.externalPlaceholders, 0);
  assert.equal(result.signals.includes(SIGNALS.EXTERNAL_PLACEHOLDER_PRESENT), false);
});

test('fails closed on missing APIs and bounded callback timeout', async () => {
  await assert.rejects(
    createConflictScanner({}).scan(),
    error => error.code === 'CONFLICT_SCAN_UNAVAILABLE'
  );
  const scanner = createConflictScanner({
    management: {getAll() {}},
    ownership: {snapshot: async () => ({})},
    runtime: {id: 'self'},
    tabs: {query: async () => []},
    timeout: 5
  });
  await assert.rejects(scanner.scan(), error => error.code === 'CONFLICT_SCAN_TIMEOUT');

  const hungOwnership = createConflictScanner({
    management: {getAll: async () => []},
    ownership: {snapshot: () => new Promise(() => {})},
    runtime: {id: 'self'},
    tabs: {query: async () => []},
    timeout: 5
  });
  await assert.rejects(hungOwnership.scan(), error => error.code === 'CONFLICT_SCAN_TIMEOUT');

  const malformed = createConflictScanner({
    management: {getAll: async () => ({})},
    ownership: {snapshot: async () => ({})},
    runtime: {id: 'self'},
    tabs: {query: async () => []}
  });
  await assert.rejects(malformed.scan(), error => error.code === 'CONFLICT_SCAN_MALFORMED');
});

test('conflict access is optional, user-triggered, read-only, and exact-page authorized', async () => {
  const [manifest, policy, options, menu, scanner] = await Promise.all([
    readFile(new URL('../v3/manifest.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../docs/release-policy.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../v3/data/options/index.js', import.meta.url), 'utf8'),
    readFile(new URL('../v3/worker/menu.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../v3/worker/core/conflict-scan.mjs', import.meta.url), 'utf8')
  ]);
  assert.equal(manifest.permissions.includes('management'), false);
  assert.equal(manifest.optional_permissions.includes('management'), true);
  assert.equal(policy.allowedOptionalPermissions.includes('management'), true);
  assert.match(options, /conflictScanRun\.addEventListener\('click',[\s\S]*permissions, 'request', CONFLICT_SCAN_PERMISSION/);
  assert.match(menu, /sender\?\.id !== chrome\.runtime\.id \|\| sender\?\.url !== optionsUrl/);
  assert.match(menu, /permissions[\s\S]*'contains'[\s\S]*'management'/);
  assert.match(scanner, /callApi\(management, 'getAll'/);
  assert.doesNotMatch(scanner, /\.(?:setEnabled|uninstall|installReplacementWebApp|launchApp)\s*\(/);
});
