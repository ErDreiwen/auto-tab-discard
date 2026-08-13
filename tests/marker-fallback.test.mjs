import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {
  prepareDiscardTargets,
  runDirectDiscardCommand,
  runScopedCommand,
  scopeQuery
} from '../v3/worker/core/command-scope.mjs';
import {markerFallback} from '../v3/worker/core/marker-fallback.mjs';

test('bulk queries include every inactive tab instead of only web URLs', () => {
  for (const command of [
    'discard-window',
    'discard-rights',
    'discard-lefts',
    'discard-other-windows',
    'discard-tabs',
    'release-window',
    'release-rights',
    'release-lefts',
    'release-other-windows',
    'release-tabs'
  ]) {
    const options = scopeQuery(command);
    assert.equal(options.active, false, command);
    assert.equal('url' in options, false, command);
  }
});

test('classifies renderer-capable, physical-only, and unsupported schemes explicitly', () => {
  for (const url of ['https://example.com/', 'http://example.com/']) {
    assert.deepEqual(markerFallback({url}), {kind: 'scriptable'});
  }
  for (const url of [
    'edge://settings/',
    'chrome://extensions/',
    'chrome-extension://abcdefghijklmnop/options.html',
    'moz-extension://abcdefghijklmnop/options.html',
    'about:config',
    'file:///C:/notes.html'
  ]) {
    const result = markerFallback({url});
    assert.equal(result.kind, 'physical-only', url);
    assert.match(result.reason, /renderer marker unavailable/, url);
  }
  for (const url of ['devtools://devtools/bundled/', 'mailto:test@example.com', 'custom://page/']) {
    const result = markerFallback({url});
    assert.equal(result.kind, 'unsupported', url);
    assert.match(result.reason, /(?:unsupported|unknown) tab scheme/, url);
  }
});

test('normal bulk commands protect non-scriptable tabs and classify unsupported schemes', async () => {
  const web = {id: 1, index: 1, active: false, discarded: false, url: 'https://example.com/'};
  const internal = {id: 2, index: 2, active: false, discarded: false, url: 'edge://settings/'};
  const unsupported = {
    id: 3,
    index: 3,
    active: false,
    discarded: false,
    url: 'devtools://devtools/bundled/'
  };
  const calls = [];

  const result = await runScopedCommand({
    check: async tabs => calls.push(`check:${tabs.map(tab => tab.id).join(',')}`),
    command: 'discard-window',
    discard: async tab => {
      calls.push(`discard:${tab.id}`);
      return true;
    },
    query: async () => [web, internal, unsupported],
    selected: {id: 99, index: 9},
    shiftKey: false,
    takeover: async () => true
  });

  assert.deepEqual(calls, ['check:1']);
  assert.deepEqual(result.candidates.map(tab => tab.id), [1]);
  assert.deepEqual(result.physicalOnly, []);
  assert.deepEqual(result.protected.map(entry => entry.tab.id), [2]);
  assert.match(result.protected[0].reason, /use Shift to force/);
  assert.deepEqual(result.unsupported.map(entry => entry.tab.id), [3]);
});

test('known physical-only schemes outrank Chromium optional frozen-field drift', async () => {
  const file = {
    id: 4,
    index: 1,
    active: false,
    discarded: false,
    frozen: null,
    status: 'complete',
    url: 'file:///C:/notes.html'
  };
  const normal = await runScopedCommand({
    check: async () => assert.fail('a physical-only tab never enters the renderer scan'),
    command: 'discard-window',
    discard: async () => assert.fail('normal mode protects the physical-only tab'),
    query: async () => [file],
    selected: {id: 99, index: 9},
    shiftKey: false,
    takeover: async () => assert.fail('optional frozen drift must not route through takeover')
  });
  assert.deepEqual(normal.unknownSuspension, []);
  assert.deepEqual(normal.protected.map(entry => entry.tab.id), [file.id]);

  const calls = [];
  const forced = await runScopedCommand({
    check: async () => assert.fail('Shift bypasses the renderer scan'),
    command: 'discard-window',
    discard: async tab => calls.push(tab.id) && true,
    query: async () => [file],
    selected: {id: 99, index: 9},
    shiftKey: true,
    takeover: async () => assert.fail('physical-only tabs use native discard directly')
  });
  assert.deepEqual(calls, [file.id]);
  assert.deepEqual(forced.succeeded.map(entry => entry.tab.id), [file.id]);
});

test('Shift physically discards restricted tabs and reports API rejection without aborting peers', async () => {
  const tabs = [
    {id: 1, index: 1, active: false, discarded: false, url: 'https://example.com/'},
    {id: 2, index: 2, active: false, discarded: false, url: 'edge://settings/'},
    {id: 3, index: 3, active: false, discarded: false, url: 'chrome-extension://abc/page.html'},
    {id: 4, index: 4, active: false, discarded: false, url: 'file:///C:/notes.html'},
    {id: 5, index: 5, active: false, discarded: false, url: 'devtools://devtools/bundled/'},
    {id: 6, index: 6, active: false, discarded: false, url: 'about:config'}
  ];
  const calls = [];

  const result = await runScopedCommand({
    check: async () => assert.fail('Shift bypasses the metadata check'),
    command: 'discard-tabs',
    discard: async tab => {
      calls.push(tab.id);
      if (tab.id === 4) {
        return false;
      }
      if (tab.id === 6) {
        throw Error('browser rejected this page');
      }
      return true;
    },
    query: async () => tabs,
    selected: {id: 99, index: 9},
    shiftKey: true,
    takeover: async () => true
  });

  assert.deepEqual(calls.sort((a, b) => a - b), [1, 2, 3, 4, 6]);
  assert.deepEqual(result.candidates.map(tab => tab.id), [1]);
  assert.deepEqual(result.physicalOnly.map(entry => entry.tab.id), [2, 3]);
  assert.deepEqual(result.protected, []);
  assert.deepEqual(result.unsupported.map(entry => entry.tab.id), [5, 4, 6]);
  assert.match(result.unsupported[1].reason, /native discard was rejected/);
  assert.match(result.unsupported[2].reason, /native discard failed: browser rejected this page/);
});

test('direct commands use the physical fallback and still require a keeper for active targets', async () => {
  const target = {
    id: 1,
    index: 1,
    active: true,
    discarded: false,
    highlighted: true,
    url: 'edge://settings/'
  };
  const keeper = {
    id: 2,
    index: 2,
    active: false,
    discarded: false,
    frozen: false,
    highlighted: false,
    status: 'complete',
    url: 'https://example.com/'
  };
  const calls = [];

  const result = await runDirectDiscardCommand({
    activate: async tab => calls.push(`activate:${tab.id}`),
    allTabs: [target, keeper],
    command: 'discard-tab',
    discard: async tab => {
      calls.push(`discard:${tab.id}:${tab.active}`);
      return true;
    },
    inProgress: () => false,
    notifyNoKeeper: () => assert.fail('a safe keeper exists'),
    selected: target,
    takeover: async () => true,
    targets: [target]
  });

  assert.deepEqual(calls, ['activate:2', 'discard:1:false']);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.physicalOnly.map(entry => entry.tab.id), [1]);
});

test('already discarded restricted pages are physical-only without an unsafe wake cycle', async () => {
  const tab = {id: 7, active: false, discarded: true, url: 'chrome://extensions/'};
  const result = await prepareDiscardTargets('discard-tabs', [tab], async current => ({
    marker: {state: 'owned', source: 'claimed'},
    state: 'discarded',
    tab: current
  }));

  assert.deepEqual(result.takeovers, []);
  assert.deepEqual(result.physicalOnly.map(entry => entry.tab.id), [7]);
  assert.match(result.physicalOnly[0].reason, /already physically discarded/);
});

test('discard-tab and discard-tree context entries are available on restricted pages', async () => {
  const source = await readFile(new URL('../v3/worker/menu.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("id: 'discard-tab'");
  const end = source.indexOf("id: 'discard-other-windows'");
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.doesNotMatch(source.slice(start, end), /documentUrlPatterns/);
});
