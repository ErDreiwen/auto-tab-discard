import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_WINDOW_TYPES,
  attachWindowScope,
  createWindowScope,
  tabInAllowedWindowScope
} from '../v3/worker/core/window-scope.mjs';
import {filterScopeTabs, scopeQuery} from '../v3/worker/core/command-scope.mjs';

test('declares normal windows as the sole command scope', () => {
  assert.deepEqual(ALLOWED_WINDOW_TYPES, ['normal']);
  const selected = {id: 1, windowId: 7, incognito: false};
  const scope = createWindowScope(selected, {
    id: 7,
    type: 'normal',
    incognito: false,
    state: 'minimized'
  });
  assert.deepEqual(attachWindowScope(selected, scope), {
    ...selected,
    windowType: 'normal'
  });
});

test('rejects popup, app, panel, devtools, unknown, and mismatched windows', () => {
  const selected = {id: 1, windowId: 7, incognito: false};
  for (const type of ['popup', 'app', 'panel', 'devtools', 'unknown']) {
    assert.throws(() => createWindowScope(selected, {id: 7, type, incognito: false}),
      new RegExp(type));
  }
  assert.throws(() => createWindowScope(selected, {id: 8, type: 'normal', incognito: false}),
    /identities disagree/);
  assert.throws(() => createWindowScope(selected, {id: 7, type: 'normal', incognito: true}),
    /privacy contexts disagree/);
});

test('normal, minimized, hidden, and workspace-like windows remain isolated by ID', () => {
  const selected = {id: 90, index: 2, windowId: 7, incognito: false, windowType: 'normal'};
  const tabs = [
    {id: 1, index: 0, windowId: 7, incognito: false},
    {id: 2, index: 1, windowId: 8, incognito: false},
    {id: 3, index: 3, windowId: 7, incognito: false},
    {id: 4, index: 4, windowId: 7, incognito: true},
    {id: 5, index: 5, windowId: 9, incognito: false, windowType: 'app'}
  ];
  assert.deepEqual(filterScopeTabs('discard-window', tabs, selected).map(tab => tab.id), [1, 3]);
  assert.deepEqual(filterScopeTabs('discard-other-windows', tabs, selected).map(tab => tab.id), [2]);
  assert.deepEqual(filterScopeTabs('discard-tabs', tabs, selected).map(tab => tab.id), [1, 2, 3]);
});

test('incognito and regular privacy contexts never cross', () => {
  const regular = {id: 1, windowId: 7, incognito: false};
  const incognito = {id: 2, windowId: 8, incognito: true};
  assert.equal(tabInAllowedWindowScope(incognito, regular), false);
  assert.equal(tabInAllowedWindowScope(regular, incognito), false);
  assert.deepEqual(scopeQuery('discard-tabs', regular), {active: false, windowType: 'normal'});
});

test('authoritative takeover scopes require explicit normal-window privacy fields', () => {
  const selected = {id: 1, incognito: false, windowId: 7, windowType: 'normal'};
  assert.equal(tabInAllowedWindowScope({
    id: 2, incognito: false, windowId: 7, windowType: 'normal'
  }, selected, {requireExplicit: true}), true);
  assert.equal(tabInAllowedWindowScope({
    id: 3, windowId: 7, windowType: 'normal'
  }, selected, {requireExplicit: true}), false);
  assert.equal(tabInAllowedWindowScope({
    id: 4, incognito: false, windowId: 7
  }, selected, {requireExplicit: true}), false);
  assert.equal(tabInAllowedWindowScope({
    id: 5, incognito: false, windowId: 7, windowType: 'popup'
  }, selected, {requireExplicit: true}), false);
});
